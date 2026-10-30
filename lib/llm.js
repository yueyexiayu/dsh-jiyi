import { createHash } from 'node:crypto';
import { createLatencyTrace } from './models.js';

// Provider-neutral, one-shot text subcalls. No main-session history, tools,
// purpose, sessionId or provider replay state is reused here.
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const bytes = text => Buffer.byteLength(text, 'utf8');
const controlKeys = ['provider', 'model', 'maxTokens', 'reasoningEffort', 'temperature', 'topP', 'seed'];
function preparedControls(config, selectedReasoningEffort) {
  const values = {}, observed = {};
  for (const key of controlKeys) {
    let value;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (descriptor?.enumerable && 'value' in descriptor) value = descriptor.value;
    } catch { /* Unknown control, not permission to inspect the whole config. */ }
    const valid = ['provider', 'model', 'reasoningEffort'].includes(key)
      ? typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value)
      : typeof value === 'number' && Number.isFinite(value);
    observed[key] = valid;
    values[key] = valid ? value : null;
  }
  const sha256 = createHash('sha256').update(JSON.stringify({ values, observed })).digest('hex');
  return { values, observed, sha256, selectedReasoningEffort: typeof selectedReasoningEffort === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(selectedReasoningEffort) ? selectedReasoningEffort : null };
}

export async function callTextModel(ctx, helpers, config, {
  input, messages, system, signal, onDiagnostic, onEvaluationDiagnostic, source = 'plugin:jiyi:llm', errorPrefix = 'LLM',
  budgetSessionId, budgetTaskId, budgetJobId,
  maxTokens = 1024, maxInputBytes = 131072, maxTextBytes = 8192, maxStreamBytes = 131072,
} = {}) {
  const trace = createLatencyTrace('llm', onDiagnostic);
  const counters = { prepareStarted: 0, prepareSucceeded: 0, streamStarted: 0, finishStop: 0, toolCallsObserved: 0, forbiddenToolEvents: 0, usage: 'unknown', reasoningEffort: 'unknown' };
  trace.begin('input');
  try {
  const error = (suffix, message, cause) => fail(`${errorPrefix}_${suffix}`, message, cause);
  if (!config?.provider || !config?.model) throw fail('NOT_CONFIGURED', '文本模型未配置 provider/model');
  if (typeof ctx?.llm?.prepareCall !== 'function' || typeof helpers?.createUserMessage !== 'function' || typeof helpers?.BlockAssembler !== 'function') throw error('SDK', '文本模型 SDK 不可用');
  const timeoutMs = config.timeoutMs ?? 60000;
  for (const [name, value, cap] of [['timeoutMs', timeoutMs, 300000], ['maxInputBytes', maxInputBytes, 131072], ['maxTextBytes', maxTextBytes, 131072], ['maxStreamBytes', maxStreamBytes, 1048576], ['maxTokens', maxTokens, 4000]]) {
    if (!Number.isInteger(value) || value < 1 || value > cap) throw error('CONFIG', `${name} 必须在 1–${cap}`);
  }
  if (typeof system !== 'string' || !system.trim()) throw error('CONFIG', '文本子调用缺少固定 system');
  let suppliedMessages;
  if (messages !== undefined) {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 2 || messages.some(m => m?.role !== 'user' || typeof m.source?.kind !== 'string' || !Array.isArray(m.content) || !m.content.length || m.content.some(b => b?.type !== 'text' || typeof b.text !== 'string'))) throw error('INPUT', '受控重放仅接受一到两条有来源的 user-role 纯文本数据');
    suppliedMessages = structuredClone(messages);
  }
  let encodedInput;
  try { encodedInput = JSON.stringify(suppliedMessages ?? input); } catch (cause) { throw error('INPUT', '文本模型输入不能序列化为 JSON', cause); }
  if (typeof encodedInput !== 'string') throw error('INPUT', '文本模型输入不能为空');
  if (bytes(encodedInput) > maxInputBytes) throw error('INPUT_TOO_LARGE', '文本模型输入超过 128 KiB 有界预算');

  const controller = new AbortController();
  let iterator, abortListener, externalAbort, timer, selectedReasoningEffort;
  const stop = reason => { if (!controller.signal.aborted) controller.abort(reason); return controller.signal.reason; };
  const cancelled = () => stop(fail('ABORTED', '文本模型调用已取消'));
  const abortPromise = new Promise((_, reject) => {
    abortListener = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) cancelled();
    else if (signal) { externalAbort = cancelled; signal.addEventListener('abort', externalAbort, { once: true }); }
    timer = setTimeout(() => stop(error('TIMEOUT', '文本模型调用超时')), timeoutMs);
  });
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  const rejectOutput = (suffix, message) => { throw stop(error(suffix, message)); };
  const run = async () => {
    check();
    // The callback is synchronous; preserve every prepared control. Official
    // model.reasoning.efforts is ordered from lowest to highest supported effort.
    trace.begin('prepare');
    counters.prepareStarted = 1;
    const call = await ctx.llm.prepareCall({ provider: config.provider, model: config.model, maxTokens }, controller.signal, (controls, model) => {
      const effort = model.reasoning?.efforts?.[0]?.id;
      selectedReasoningEffort = effort;
      return { ...controls, ...(effort ? { reasoningEffort: effort } : {}) };
    });
    counters.prepareSucceeded = 1;
    check();
    const callMessages = suppliedMessages ?? [helpers.createUserMessage({ content: [{ type: 'text', text: encodedInput }], source: { kind: source } })];
    const assembler = new helpers.BlockAssembler();
    const blocks = new Map();
    let streamBytes = 0, textBytes = 0, sawFinish = false, finishReason;
    const update = (index, kind, text, closed) => {
      if (!Number.isSafeInteger(index) || index < 0 || typeof text !== 'string') rejectOutput('STREAM', '文本流 block/index 无效');
      const previous = blocks.get(index);
      const oldBytes = previous?.kind === 'text' ? previous.size : 0;
      const size = bytes(text);
      const nextBytes = textBytes - oldBytes + (kind === 'text' ? size : 0);
      if (nextBytes > maxTextBytes) rejectOutput('OUTPUT_TOO_LARGE', '文本模型正文超过有界字节预算');
      textBytes = nextBytes;
      blocks.set(index, { kind, text, size, closed });
    };
    const controls = preparedControls(call.config, selectedReasoningEffort);
    counters.reasoningEffort = controls.observed.reasoningEffort ? controls.values.reasoningEffort : 'unknown';
    trace.begin('stream', undefined, { preparedControls: controls });
    const streamStarted = performance.now();
    counters.streamStarted = 1;
    // Capture only explicit text-model input and allowlisted controls, never
    // credentials, provider replay envelopes, or hidden reasoning blocks.
    onEvaluationDiagnostic?.({ stage: 'model-request', source, system, messages: structuredClone(callMessages), tools: [], controls });
    const request = { ...call.config, system, messages: callMessages, tools: [], signal: controller.signal };
    if (budgetSessionId !== undefined) {
      if (typeof budgetSessionId !== 'string' || !budgetSessionId.trim()) throw error('SESSION', '任务用量归属需要真实会话 ID');
      if (budgetTaskId !== undefined) {
        if (typeof helpers.markTaskBudgetBackground !== 'function') throw error('BUDGET_ATTRIBUTION_UNAVAILABLE', 'Host 后台任务归属接口不可用');
        helpers.markTaskBudgetBackground(request, budgetSessionId, budgetTaskId, budgetJobId);
      } else if (typeof helpers.markTaskBudgetUnattributedBackground === 'function') helpers.markTaskBudgetUnattributedBackground(request, budgetSessionId);
      else if (typeof helpers.markTaskBudgetSession === 'function') helpers.markTaskBudgetSession(request, budgetSessionId);
      else if (typeof ctx.llm.getTaskBudgetGuard === 'function') throw error('BUDGET_ATTRIBUTION_UNAVAILABLE', 'Host 任务预算归属接口不可用');
    }
    const stream = call.stream(request);
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      check();
      if (next.done) break;
      const chunk = next.value;
      counters.chunkCount = (counters.chunkCount ?? 0) + 1;
      counters.firstChunkMs ??= performance.now() - streamStarted;
      if (chunk?.type === 'text-delta' || chunk?.type === 'block-end' && chunk.block?.type === 'text') counters.firstTextMs ??= performance.now() - streamStarted;
      let encoded;
      try { encoded = JSON.stringify(chunk); } catch (cause) { rejectOutput('STREAM', '文本模型流不是可计量 JSON'); }
      if (typeof encoded !== 'string') rejectOutput('STREAM', '文本模型流包含空事件');
      streamBytes += bytes(encoded);
      counters.streamBytes = streamBytes;
      if (streamBytes > maxStreamBytes) rejectOutput('STREAM_TOO_LARGE', '文本模型累计流量超过有界字节预算');
      if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && String(chunk.blockType).startsWith('tool-') || chunk.type === 'block-end' && String(chunk.block?.type).startsWith('tool-')) {
        counters.forbiddenToolEvents = 1;
        counters.toolCallsObserved = chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call' ? 1 : 0;
        rejectOutput('TOOL_CALL', '文本子调用禁止工具调用或工具变更');
      }
      if (chunk.type === 'finish') {
        if (sawFinish) rejectOutput('FINISH', '文本模型重复 finish');
        sawFinish = true;
        finishReason = chunk.reason;
        if (finishReason?.kind !== 'stop') throw stop(fail(finishReason?.failure?.code || `${errorPrefix}_FINISH`, `文本模型没有正常完成：${finishReason?.kind ?? 'missing'}${finishReason?.failure?.message ? `: ${finishReason.failure.message}` : ''}`));
        counters.finishStop = 1;
        // Never retain the provider replay envelope.
        assembler.push({ type: 'finish', reason: finishReason });
        continue;
      }
      if (chunk.type === 'usage') {
        // Harness pi-ai mapUsage exposes these exact cumulative counts. Missing
        // fields (notably separate reasoning tokens) remain unknown, never zero.
        try {
          const usage = {};
          for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
            const value = chunk.usage?.[key];
            usage[key] = Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';
          }
          counters.usage = usage;
        } catch { /* Optional measurement must not change stream handling. */ }
        assembler.push(chunk); continue;
      }
      if (sawFinish) rejectOutput('STREAM', '文本模型在 finish 后继续输出正文');
      if (chunk.type === 'block-start') {
        if (!['text', 'reasoning'].includes(chunk.blockType)) rejectOutput('BLOCK', '文本模型返回不支持的 block');
        if (!blocks.has(chunk.index)) update(chunk.index, chunk.blockType, '', false);
      } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning';
        const previous = blocks.get(chunk.index);
        if (!previous?.closed) {
          if (previous && previous.kind !== kind || typeof chunk.text !== 'string') rejectOutput('STREAM', '文本模型 delta 类型无效');
          update(chunk.index, kind, (previous?.text ?? '') + chunk.text, false);
        }
      } else if (chunk.type === 'block-end') {
        if (!['text', 'reasoning'].includes(chunk.block?.type)) rejectOutput('BLOCK', '文本模型返回不支持的 block');
        if (!blocks.get(chunk.index)?.closed) update(chunk.index, chunk.block.type, chunk.block.text, true);
      } else rejectOutput('STREAM', '文本模型返回未知流事件');
      assembler.push(chunk);
    }
    check();
    // BlockAssembler.finish defaults to stop even on silent EOF; a real finish
    // event is mandatory. Partial JSON/max-tokens/cancellation is never success.
    if (!sawFinish || finishReason?.kind !== 'stop') throw error('FINISH', '文本模型流缺少真实 stop finish');
    trace.begin('assemble', counters);
    const resultBlocks = assembler.blocks();
    if (resultBlocks.some(b => b.type !== 'text' && b.type !== 'reasoning')) rejectOutput('BLOCK', '文本子调用包含非文本结果');
    const text = resultBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
    if (bytes(text) > maxTextBytes) rejectOutput('OUTPUT_TOO_LARGE', '文本模型正文超过有界字节预算');
    onEvaluationDiagnostic?.({ stage: 'model-response', source, rawText: text, finish: 'stop', complete: true });
    if (!text.trim()) throw error('EMPTY', '文本模型返回空正文');
    return text;
  };
  try {
    const text = await Promise.race([run(), abortPromise]);
    counters.textBytes = bytes(text);
    trace.finish(null, counters);
    return text;
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason;
    // Preserve provider codes (e.g. authentication/service failure); never turn
    // them into an empty successful answer or no-hit.
    if (cause?.code) throw cause;
    throw error('CALL', `文本模型调用失败：${cause?.message ?? cause}`, cause);
  } finally {
    clearTimeout(timer);
    if (externalAbort) signal.removeEventListener('abort', externalAbort);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    if (controller.signal.aborted && iterator?.return) {
      // Abort has already been propagated to both SDK stages. Do not wait for an
      // uncooperative iterator to acknowledge return and defeat the deadline.
      try { Promise.resolve(iterator.return()).catch(() => {}); } catch { /* original explicit failure wins */ }
    }
  }
  } catch (cause) {
    trace.finish(cause, counters);
    try { cause.diagnostics = { ...cause.diagnostics, llm: trace.snapshot() }; } catch { /* Preserve even non-extensible provider errors. */ }
    throw cause;
  }
}
