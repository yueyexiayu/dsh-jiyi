import test from 'node:test';
import assert from 'node:assert/strict';
import { callTextModel } from '../lib/llm.js';
import { callExtraction } from '../lib/extract.js';

const installed = process.versions.electron ? await import('file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js') : null;
class TestAssembler {
  data = new Map();
  get finish() { return this.reason ?? { kind: 'stop' }; } // Match SDK's dangerous default.
  push(c) {
    if (c.type === 'finish') { this.reason = c.reason; return; }
    if (c.type === 'block-end') { if (!this.data.get(c.index)?.closed) this.data.set(c.index, { ...c.block, closed: true }); return; }
    if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      const b = this.data.get(c.index); if (b?.closed) return;
      this.data.set(c.index, { type: c.type === 'text-delta' ? 'text' : 'reasoning', text: (b?.text ?? '') + c.text });
    }
  }
  blocks() { return [...this.data.values()].map(({ closed, ...b }) => b); }
}
const helpers = installed ?? { BlockAssembler: TestAssembler, createUserMessage: x => ({ ...x, role: 'user', id: 'fresh-private-message' }) };
const stop = { type: 'finish', reason: { kind: 'stop' } };
const text = x => ({ type: 'text-delta', index: 0, text: x });
const config = { provider: 'test-provider', model: 'test-model', timeoutMs: 1000 };
function fixture(chunks, { prepare, stream, reasoning = { efforts: [{ id: 'minimal' }, { id: 'high' }] } } = {}) {
  const state = { calls: 0, returns: 0 };
  const ctx = { llm: { prepareCall: async (c, signal, configure) => {
    state.calls++; state.prepareSignal = signal;
    state.prepared = configure({ ...c, temperature: .25 }, { reasoning });
    if (prepare) return prepare(c, signal, configure);
    return { config: { ...state.prepared }, stream: options => {
      state.options = options;
      return stream ? stream(options) : (async function* () { for (const c of chunks) { state.yields = (state.yields ?? 0) + 1; yield c; } })();
    } };
  } } };
  const call = (options = {}, c = config) => callTextModel(ctx, helpers, c, { input: { query: 'a task', sessionId: 'must-not-be-context' }, system: 'fixed text-only system', ...options });
  return { state, ctx, call };
}
const code = expected => error => error.code === expected;

test('one-shot prepared request preserves controls, lowest declared effort, tools:[] and isolated messages', async () => {
  const f = fixture([text('{"ids":[]}'), stop]);
  assert.equal(await f.call(), '{"ids":[]}');
  assert.equal(f.state.calls, 1); assert.equal(f.state.prepared.maxTokens, 1024);
  assert.equal(f.state.prepared.reasoningEffort, 'minimal'); assert.equal(f.state.options.temperature, .25);
  assert.equal(f.state.options.signal, f.state.prepareSignal);
  assert.deepEqual(f.state.options.tools, []); assert.equal(f.state.options.messages.length, 1);
  for (const key of ['purpose', 'sessionId', 'context', 'replayState']) assert.equal(Object.hasOwn(f.state.options, key), false);
  const noReasoning = fixture([text('ok'), stop], { reasoning: undefined });
  // Metadata with no reasoning must not acquire a made-up low effort.
  noReasoning.ctx.llm.prepareCall = async (c, signal, configure) => {
    const resolved = configure({ ...c, temperature: .2 }, {});
    assert.equal(Object.hasOwn(resolved, 'reasoningEffort'), false);
    return { config: resolved, stream: async function* () { yield text('ok'); yield stop; } };
  };
  assert.equal(await noReasoning.call(), 'ok');
});

test('evaluation capture excludes credential-shaped config, replay envelopes and reasoning; default trace remains body-free', async () => {
  const raw=' {"ids":[]}\n',evidence=[],ordinary=[];
  const f=fixture([], {prepare:async()=>({config:{provider:'test-provider',model:'test-model',apiKey:'fixture-private-key',replayState:{private:'fixture-replay'}},stream:async function*(){
    yield {type:'reasoning-delta',index:1,text:'fixture-hidden-reasoning'};
    yield text(raw);yield {...stop,replayState:{private:'fixture-envelope'}};
  }})});
  assert.equal(await f.call({onEvaluationDiagnostic:e=>evidence.push(e),onDiagnostic:e=>ordinary.push(e)}),raw);
  assert.equal(evidence[1].rawText,raw);
  for(const forbidden of ['fixture-private-key','fixture-replay','fixture-envelope','fixture-hidden-reasoning'])assert.equal(JSON.stringify(evidence).includes(forbidden),false);
  assert.equal(JSON.stringify(ordinary).includes('rawText'),false);
  assert.equal(JSON.stringify(ordinary).includes('a task'),false);
});

test('requires a real stop finish, rejects empty/reasoning-only/partial output and preserves provider failure code', async () => {
  await assert.rejects(fixture([text('{"ids":[]')]).call(), code('LLM_FINISH'));
  await assert.rejects(fixture([text('{"ids":[]}'), { type: 'finish', reason: { kind: 'max-tokens' } }]).call(), code('LLM_FINISH'));
  await assert.rejects(fixture([stop]).call(), code('LLM_EMPTY'));
  await assert.rejects(fixture([{ type: 'reasoning-delta', index: 1, text: 'thinking only' }, stop]).call(), code('LLM_EMPTY'));
  await assert.rejects(fixture([{ type: 'finish', reason: { kind: 'error', failure: { code: 'TEST_SERVICE_FAILURE', message: 'unavailable' } } }]).call(), code('TEST_SERVICE_FAILURE'));
});

test('tool calls and tool changes fail immediately even if finish/assembler would hide them', async () => {
  const attempts = [
    { type: 'tool-call-delta', index: 0, id: 'x', name: 'write', argumentsDelta: '{}' },
    { type: 'block-start', index: 0, blockType: 'tool-addition' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'x', name: 'write', arguments: '{}' } },
  ];
  for (const attempt of attempts) {
    const f = fixture([attempt, text('ok'), stop]);
    await assert.rejects(f.call(), code('LLM_TOOL_CALL'));
    assert.equal(f.state.options.signal.aborted, true);
  }
});

test('bounds UTF8 input, text delta, end-only complete text and raw reasoning stream; aborts on overflow', async () => {
  const tooMuchInput = fixture([text('ok'), stop]);
  await assert.rejects(tooMuchInput.call({ input: { x: '中'.repeat(45000) } }), code('LLM_INPUT_TOO_LARGE'));
  assert.equal(tooMuchInput.state.calls, 0);
  for (const chunks of [[text('中文')], [{ type: 'block-end', index: 0, block: { type: 'text', text: '中文' } }]]) {
    const f = fixture([...chunks, stop]);
    await assert.rejects(f.call({ maxTextBytes: 4 }), code('LLM_OUTPUT_TOO_LARGE'));
    assert.equal(f.state.options.signal.aborted, true);
  }
  const raw = fixture([{ type: 'reasoning-delta', index: 1, text: 'x'.repeat(1000) }, stop]);
  await assert.rejects(raw.call({ maxStreamBytes: 100 }), code('LLM_STREAM_TOO_LARGE'));
  assert.equal(raw.state.options.signal.aborted, true);
});

test('does not double count delta/full-block or count closed deltas; handles split UTF16 surrogate pair exactly', async () => {
  const s = '{"ids":[]}';
  const f = fixture([text(s), { type: 'block-end', index: 0, block: { type: 'text', text: s } }, text('ignored after close'), stop]);
  assert.equal(await f.call({ maxTextBytes: Buffer.byteLength(s) }), s);
  assert.equal(await fixture([text('\ud83d'), text('\ude00'), stop]).call({ maxTextBytes: 4 }), '😀');
  const reasoning = fixture([{ type: 'reasoning-delta', index: 1, text: 'not part of body' }, text('ok'), stop]);
  assert.equal(await reasoning.call({ maxTextBytes: 2 }), 'ok');
  const duplicateEnd = fixture([
    { type: 'block-end', index: 0, block: { type: 'text', text: '12345678' } },
    { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
    { type: 'text-delta', index: 1, text: 'x' }, stop,
  ]);
  await assert.rejects(duplicateEnd.call({ maxTextBytes: 8 }), code('LLM_OUTPUT_TOO_LARGE'));
  assert.equal(duplicateEnd.state.options.signal.aborted, true);
  assert.equal(duplicateEnd.state.yields, 3, 'Abort as soon as the next text block exceeds budget, before consuming stop');
});

test('timeout/abort covers stuck preparation and stream; cannot return late success or leave deadline timers', async () => {
  const preparing = fixture([], { prepare: () => new Promise(() => {}) });
  await assert.rejects(preparing.call({}, { ...config, timeoutMs: 10 }), code('LLM_TIMEOUT'));
  assert.equal(preparing.state.prepareSignal.aborted, true);
  let returned = false;
  const streaming = fixture([], { stream: () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return() { returned = true; return Promise.resolve({ done: true }); } }) });
  await assert.rejects(streaming.call({}, { ...config, timeoutMs: 10 }), code('LLM_TIMEOUT'));
  assert.equal(returned, true); assert.equal(streaming.state.options.signal.aborted, true);
  const controller = new AbortController(); controller.abort();
  const cancelled = fixture([text('must not run'), stop]);
  await assert.rejects(cancelled.call({ signal: controller.signal }), code('ABORTED'));
  assert.equal(cancelled.state.calls, 0);
  let resolvePreparation;
  const late = fixture([], { prepare: () => new Promise(resolve => { resolvePreparation = resolve; }) });
  await assert.rejects(late.call({}, { ...config, timeoutMs: 10 }), code('LLM_TIMEOUT'));
  let lateStreamCalls = 0;
  resolvePreparation({ config: {}, stream() { lateStreamCalls++; throw new Error('must not stream after timeout'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateStreamCalls, 0);
});

test('extraction delegates shared limits/signature and retains EXTRACTION error namespace', async () => {
  const f = fixture([text('{"memories":[]}'), stop]);
  assert.equal(await callExtraction(f.ctx, helpers, { extraction: config }, { sessionId: 'not-sdk-context', sources: [] }), '{"memories":[]}');
  assert.equal(f.state.prepared.maxTokens, 4000);
  assert.equal(f.state.options.sessionId, undefined); assert.equal(f.state.options.purpose, undefined);
  await assert.rejects(callExtraction(fixture([text(' '), stop]).ctx, helpers, { extraction: config }, {}), code('EXTRACTION_EMPTY'));
  await assert.rejects(callExtraction(fixture([text('{}')]).ctx, helpers, { extraction: config }, {}), code('EXTRACTION_FINISH'));
  await assert.rejects(callExtraction(fixture([]).ctx, helpers, { extraction: config }, { x: 'x'.repeat(131072) }), code('EXTRACTION_INPUT_TOO_LARGE'));
  await assert.rejects(callExtraction(fixture([]).ctx, helpers, { extraction: {} }, {}), code('NOT_CONFIGURED'));
});
