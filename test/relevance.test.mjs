import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelevanceJudge, validateRelevanceConfig, RELEVANCE_VERSION, RELEVANCE_SYSTEM } from '../lib/relevance.js';

const installed = process.versions.electron ? await import('file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js') : null;
class TestAssembler {
  data = new Map();
  get finish() { return this.reason ?? { kind: 'stop' }; }
  push(c) {
    if (c.type === 'finish') this.reason = c.reason;
    if (c.type === 'block-end') this.data.set(c.index, c.block);
    if (c.type === 'text-delta') this.data.set(c.index, { type: 'text', text: (this.data.get(c.index)?.text ?? '') + c.text });
  }
  blocks() { return [...this.data.values()]; }
}
const helpers = installed ?? { BlockAssembler: TestAssembler, createUserMessage: x => ({ ...x, role: 'user', id: 'private-probe' }) };
const config = { provider: 'provider', model: 'model', timeoutMs: 1000 };
const candidate = (id = 'm1', version = 2) => ({ id, version, scope: 'project', projectId: 'p1', projectName: '水杉A', content: '发票金额使用整数分，禁止浮点元。', updatedAt: '2026-10-24T00:00:00Z' });
const input = () => ({ query: '金额应该用什么格式保存？', projectId: 'p1', sessionId: 'never-sdk-context', candidates: [candidate()] });
const code = expected => error => error.code === expected;
function fixture(answer, { stream, configuration = config } = {}) {
  const state = { calls: 0, options: [] };
  const ctx = { llm: { prepareCall: async (c, signal, configure) => {
    state.calls++; state.signal = signal;
    return { config: configure(c, {}), stream: options => {
      state.options.push(options);
      return stream ? stream(options) : (async function* () {
        const response = typeof answer === 'function' ? answer(JSON.parse(options.messages[0].content[0].text)) : answer;
        yield { type: 'text-delta', index: 0, text: response };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    } };
  } } };
  return { state, judge: createRelevanceJudge({ ctx, helpers, config: configuration }) };
}

test('config is explicit, validates operational bounds and reports unconfigured instead of permissive fallback', async () => {
  assert.deepEqual(validateRelevanceConfig(), { provider: null, model: null, timeoutMs: 60000 });
  for (const bad of [null, [], { timeoutMs: 0 }, { timeoutMs: 300001 }, { provider: '' }, { model: 1 }, { extra: true }]) assert.throws(() => validateRelevanceConfig(bad), code('INVALID_ARGS'));
  const f = fixture('{"ids":[]}', { configuration: {} });
  assert.equal(f.judge.getStatus().status, 'not-configured');
  await assert.rejects(f.judge.judge(input()), code('NOT_CONFIGURED'));
  assert.equal(f.state.calls, 0); assert.equal(f.judge.getStatus().ready, false);
});

test('returns only exact id/version decisions, scope labels remain data, and SDK request has no session context', async () => {
  const f = fixture('{"ids":[{"id":"m1","version":2,"quote":"禁止浮点元"}]}');
  assert.equal(f.judge.getStatus().status, 'not-verified');
  const result = await f.judge.judge(input());
  assert.deepEqual(result.ids, [{ id: 'm1', version: 2 }]);
  assert.equal(result.version, RELEVANCE_VERSION); assert.equal(result.provider, 'provider'); assert.equal(result.model, 'model');
  assert.ok(result.elapsedMs >= 0);
  const options = f.state.options[0], payload = JSON.parse(options.messages[0].content[0].text);
  assert.equal(payload.projectId, 'p1'); assert.equal(payload.candidates[0].projectName, '水杉A'); assert.equal(payload.sessionId, undefined);
  for (const key of ['purpose', 'sessionId', 'context', 'replayState']) assert.equal(Object.hasOwn(options, key), false);
  assert.deepEqual(options.tools, []);
  const state = f.judge.getStatus(); assert.equal(state.status, 'ready'); assert.equal(state.ready, true); assert.equal(state.activeRequests, 0); assert.ok(state.lastSuccessAt); assert.equal(state.error, null);
});

test('v7 adds the approved denial contrast without losing the HTTP boundary, independence, partial support or quote guards', () => {
  assert.equal(RELEVANCE_VERSION, 'jiyi-relevance-v7');
  assert.ok(RELEVANCE_SYSTEM.includes('否定问法对照（以下是合成例，不是候选事实）'));
  assert.ok(RELEVANCE_SYSTEM.includes('明确禁止就是对同一操作“能否”的直接否定证据'));
  assert.ok(RELEVANCE_SYSTEM.includes('不外推到其他操作或权限'));
  assert.ok(RELEVANCE_SYSTEM.includes('规则对照（以下是合成例，不是候选事实）'));
  assert.ok(RELEVANCE_SYSTEM.includes('业务码 BIZ_503 对应 HTTP 422'));
  assert.ok(RELEVANCE_SYSTEM.includes('只有业务含义已知仍保留该已知部分，不宣称HTTP状态也已知'));
  assert.ok(RELEVANCE_SYSTEM.includes('业务码中的数字片段或名称相似性不证明 HTTP 状态'));
  assert.ok(RELEVANCE_SYSTEM.includes('原文明示 HTTP 状态或两者的映射关系'));
  assert.ok(RELEVANCE_SYSTEM.includes('若 query 问业务错误码的含义、幂等处理或请求号保留，仍按原文支持度选取'));
  assert.ok(RELEVANCE_SYSTEM.includes('其他部分未知不能导致全拒'));
  assert.ok(RELEVANCE_SYSTEM.includes('相互独立'));
  assert.ok(RELEVANCE_SYSTEM.includes('只有一个候选就默认保留'));
  assert.ok(RELEVANCE_SYSTEM.includes('{"ids":[{"id":"候选原始id","version":1,"quote":"逐字原文片段"}]}'));
  assert.ok(RELEVANCE_SYSTEM.includes('quote 不得改写、翻译或补全'));
  assert.ok(RELEVANCE_SYSTEM.includes('仅同主题、同项目或同函数名不选'));
  assert.ok(Buffer.byteLength(RELEVANCE_SYSTEM, 'utf8') < 4096);
});

test('no-hit requires actual valid model JSON; even zero candidates does not manufacture local success', async () => {
  const f = fixture('{"ids":[]}');
  assert.deepEqual((await f.judge.judge(input())).ids, []); assert.equal(f.state.calls, 1);
  assert.deepEqual((await f.judge.judge({ ...input(), candidates: [] })).ids, []); assert.equal(f.state.calls, 2);
  const bad = fixture('not json');
  await assert.rejects(bad.judge.judge(input()), code('RELEVANCE_JSON'));
  assert.equal(bad.judge.getStatus().status, 'error'); assert.equal(bad.judge.getStatus().ready, false); assert.match(bad.judge.getStatus().error, /RELEVANCE_JSON/);
});

test('evaluation-only sink records exact SDK text input and unparsed response without altering the request or ordinary diagnostics', async () => {
  const raw = ' {"ids":[{"id":"m1","version":2,"quote":"禁止浮点元"}]}\n';
  const f = fixture(raw), evidence = [], ordinary = [];
  try {
    const result = await f.judge.judge(input(), { onEvaluationDiagnostic: e => evidence.push(e), onDiagnostic: e => ordinary.push(e) });
    assert.deepEqual(evidence.map(e => e.stage), ['model-request', 'model-response']);
    const [request, response] = evidence, actual = f.state.options[0];
    assert.equal(request.system, RELEVANCE_SYSTEM);assert.equal(request.system, actual.system);
    assert.deepEqual(request.messages, actual.messages);assert.deepEqual(request.tools, actual.tools);
    assert.equal(request.controls.values.provider, config.provider);assert.equal(request.controls.values.model, config.model);
    assert.equal(JSON.parse(request.messages[0].content[0].text).sessionId, undefined);
    assert.equal(response.rawText, raw);assert.equal(response.complete, true);assert.equal(response.finish, 'stop');
    assert.deepEqual(result.ids, [{id:'m1',version:2}]);
    assert.equal(actual.onEvaluationDiagnostic, undefined);
    for (const value of [ordinary, result, f.judge.getStatus()]) {
      const encoded = JSON.stringify(value);
      assert.equal(encoded.includes('rawText'), false);assert.equal(encoded.includes('禁止浮点元'), false);
    }
    request.messages[0].content[0].text = 'observer mutation';
    assert.notEqual(actual.messages[0].content[0].text, 'observer mutation');
  } finally { await f.judge.dispose(); }
});

test('evaluation sink preserves malformed model text before JSON rejection; missing finish never becomes a complete response', async () => {
  for (const raw of ['not json', '']) {
    const f = fixture(raw), evidence = [];
    try {
      await assert.rejects(f.judge.judge(input(), {onEvaluationDiagnostic:e=>evidence.push(e)}), e => ['RELEVANCE_JSON','RELEVANCE_EMPTY'].includes(e.code));
      assert.equal(evidence.find(e=>e.stage==='model-response').rawText, raw);
      assert.equal(f.judge.getStatus().status, 'error');
    } finally { await f.judge.dispose(); }
  }
  const f = fixture('', {stream:()=> (async function*(){yield {type:'text-delta',index:0,text:'{"ids":[]}'};})()}), evidence = [];
  try {
    await assert.rejects(f.judge.judge(input(), {onEvaluationDiagnostic:e=>evidence.push(e)}), code('RELEVANCE_FINISH'));
    assert.deepEqual(evidence.map(e=>e.stage), ['model-request']);
  } finally { await f.judge.dispose(); }
});

test('strict output rejects fabricated/duplicate/stale ids, version coercion, extra fields, fenced/partial JSON', async () => {
  const answers = [
    '{"ids":[{"id":"fake","version":2,"quote":"禁止浮点元"}]}',
    '{"ids":[{"id":"m1","version":1,"quote":"禁止浮点元"}]}',
    '{"ids":[{"id":"m1","version":"2","quote":"禁止浮点元"}]}',
    '{"ids":["m1"]}',
    '{"ids":[{"id":"m1","version":2,"quote":"禁止浮点元","why":"same project"}]}',
    '{"ids":[],"confidence":1}',
    '{"ids":[{"id":"m1","version":2,"quote":"禁止浮点元"},{"id":"m1","version":2,"quote":"禁止浮点元"}]}',
    '[]', '{"ids":null}',
  ];
  for (const answer of answers) await assert.rejects(fixture(answer).judge.judge(input()), code('RELEVANCE_SCHEMA'));
  for (const answer of ['```json\n{"ids":[]}\n```', '{"ids":[', '']) await assert.rejects(fixture(answer).judge.judge(input()), e => ['RELEVANCE_JSON', 'RELEVANCE_EMPTY'].includes(e.code));
});

test('rejects invalid input and >20 candidates before any call; bounded input is UTF8 aware', async () => {
  const f = fixture('{"ids":[]}');
  for (const bad of [
    { query: '', candidates: [] },
    { ...input(), candidates: Array.from({ length: 21 }, (_, i) => candidate(`m${i}`)) },
    { ...input(), candidates: [candidate(), candidate('m1', 3)] },
    { ...input(), candidates: [{ ...candidate(), version: 0 }] },
    { ...input(), candidates: [{ ...candidate(), scope: 'global' }] },
    { ...input(), candidates: [{ ...candidate(), projectId: null }] },
    { ...input(), candidates: [{ ...candidate(), projectName: 123 }] },
  ]) await assert.rejects(f.judge.judge(bad), code('RELEVANCE_INPUT'));
  await assert.rejects(f.judge.judge({ ...input(), query: '中'.repeat(45000) }), code('RELEVANCE_INPUT_TOO_LARGE'));
  assert.equal(f.state.calls, 0); assert.equal(f.judge.getStatus().activeRequests, 0);
});

test('candidate identity snapshot stays exact across asynchronous call', async () => {
  let release, ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const f = fixture('', { stream: () => (async function* () {
    ready(); await new Promise(resolve => { release = resolve; });
    yield { type: 'text-delta', index: 0, text: '{"ids":[{"id":"m1","version":2,"quote":"禁止浮点元"}]}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() });
  const data = input(), pending = f.judge.judge(data);
  await entered; data.candidates[0].version = 99; data.candidates[0].id = 'mutated'; data.candidates[0].content = 'mutated content'; release();
  const result = await pending;
  assert.deepEqual(result.ids, [{ id: 'm1', version: 2 }]);
  assert.equal(result.grounding.items[0].quoteBytes, 15);
});

test('validate performs the fixed related/unrelated probe, returns UI-ready status, and rejects a wrong or empty selection', async () => {
  const f = fixture(payload => {
    assert.equal(payload.candidates.length, 2);
    return JSON.stringify({ ids: [{ id: payload.candidates[0].id, version: payload.candidates[0].version, quote: '本项目发票金额使用整数分，禁止使用浮点元。' }] });
  });
  const result = await f.judge.validate();
  assert.equal(f.state.calls, 1); assert.equal(result.ok, true); assert.equal(result.status, 'ready'); assert.equal(result.ready, true);
  assert.deepEqual(result.probe.ids, result.probe.expectedIds);
  for (const answer of ['{"ids":[]}', '{"ids":[{"id":"jiyi-relevance-probe-unrelated","version":1,"quote":"办公室的绿植每周浇水一次。"}]}']) {
    const bad = fixture(answer);
    await assert.rejects(bad.judge.validate(), code('RELEVANCE_VALIDATION'));
    assert.equal(bad.judge.getStatus().ready, false); assert.equal(bad.judge.getStatus().status, 'error');
  }
});

test('shared output/raw-stream guards and missing finish fail closed for relevance', async () => {
  const large = fixture('x'.repeat(8193));
  await assert.rejects(large.judge.judge(input()), code('RELEVANCE_OUTPUT_TOO_LARGE'));
  const raw = fixture('', { stream: () => (async function* () { yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(131073) }; })() });
  await assert.rejects(raw.judge.judge(input()), code('RELEVANCE_STREAM_TOO_LARGE'));
  const eof = fixture('', { stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: '{"ids":[]}' }; })() });
  await assert.rejects(eof.judge.judge(input()), code('RELEVANCE_FINISH'));
});

test('dispose cancels active calls and future calls cannot revive service; caller abort never becomes []', async () => {
  const infinite = () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: () => Promise.resolve({ done: true }) });
  const f = fixture('', { stream: infinite });
  const one = f.judge.judge(input()), two = f.judge.judge(input());
  const settled = Promise.allSettled([one, two]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.judge.getStatus().activeRequests, 2);
  await f.judge.dispose();
  for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'ABORTED'); }
  assert.equal(f.judge.getStatus().activeRequests, 0); assert.equal(f.judge.getStatus().status, 'disposed');
  await assert.rejects(f.judge.judge(input()), code('RELEVANCE_DISPOSED'));
  const controller = new AbortController(), g = fixture('', { stream: infinite });
  const rejected = assert.rejects(g.judge.judge(input(), { signal: controller.signal }), code('ABORTED'));
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
  assert.equal(g.judge.getStatus().ready, false); assert.equal(g.judge.getStatus().activeRequests, 0);
});
