import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelevanceJudge, RELEVANCE_SYSTEM, RELEVANCE_VERSION } from '../lib/relevance.js';

// These controlled SDK fixtures test diagnostics and the strict support-reference
// protocol only. They are not evidence that a real model makes correct semantic
// support decisions. Real judge / main-model evaluations run separately.
class TextAssembler {
  text = '';
  push(chunk) {
    if (chunk.type === 'text-delta') this.text += chunk.text;
  }
  blocks() { return [{ type: 'text', text: this.text }]; }
}
const config = { provider: 'fixture-provider', model: 'fixture-model', timeoutMs: 1000 };
const helpers = { BlockAssembler: TextAssembler, createUserMessage: value => ({ ...value, role: 'user' }) };
const input = {
  query: '合成示例：归档文件保留多久？',
  projectId: 'fixture-project',
  candidates: [{ id: 'archive-rule', version: 3, scope: 'project', projectId: 'fixture-project', content: '合成示例：归档文件保留三十天。' }],
};
function fixture({ answer = '{"ids":[{"id":"archive-rule","version":3,"quote":"归档文件保留三十天"}]}', prepareError, stream } = {}) {
  const requests = [];
  const ctx = { llm: { prepareCall: async (selection, _signal, configure) => {
    if (prepareError) throw prepareError;
    return { config: configure(selection, {}), stream: request => {
      requests.push(request);
      return stream ? stream(request) : (async function* () {
        yield { type: 'text-delta', index: 0, text: answer };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    } };
  } } };
  return { judge: createRelevanceJudge({ ctx, helpers, config }), requests };
}
function assertDiagnostics(events) {
  assert.ok(events.length > 0, 'Actual SDK fixture execution must emit diagnostics');
  const allowed = new Set(['component', 'stage', 'status', 'elapsedMs', 'durationMs', 'counters', 'errorCode', 'cancelled', 'timedOut', 'metadata']);
  const controlKeys = ['provider', 'model', 'maxTokens', 'reasoningEffort', 'temperature', 'topP', 'seed'].sort();
  for (const event of events) {
    assert.equal(event.component, 'llm');
    assert.ok(['input', 'prepare', 'stream', 'assemble'].includes(event.stage));
    assert.ok(['running', 'success', 'error', 'cancelled', 'timeout'].includes(event.status));
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0);
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    assert.ok(Object.keys(event).every(key => allowed.has(key)), 'Diagnostics must remain a metadata-only contract');
    if (event.metadata !== undefined) {
      assert.equal(event.stage, 'stream');
      assert.equal(event.status, 'running');
      assert.deepEqual(Object.keys(event.metadata), ['preparedControls']);
      const controls = event.metadata.preparedControls;
      assert.deepEqual(Object.keys(controls).sort(), ['observed', 'selectedReasoningEffort', 'sha256', 'values']);
      assert.deepEqual(Object.keys(controls.values).sort(), controlKeys);
      assert.deepEqual(Object.keys(controls.observed).sort(), controlKeys);
      for (const key of controlKeys) {
        assert.equal(typeof controls.observed[key], 'boolean');
        assert.ok(controls.values[key] === null || ['string', 'number', 'boolean'].includes(typeof controls.values[key]));
        if (!controls.observed[key]) assert.equal(controls.values[key], null);
      }
      assert.match(controls.sha256, /^[0-9a-f]{64}$/);
      assert.ok(controls.selectedReasoningEffort === null || typeof controls.selectedReasoningEffort === 'string');
    }
  }
  const encoded = JSON.stringify(events);
  for (const privateText of [input.query, input.candidates[0].content, 'fixture-private-provider-message']) assert.equal(encoded.includes(privateText), false);
}

test('grounding is exact metadata with first UTF16 range and independent UTF8 SHA256 expectations', async () => {
  // Fixed expectations generated independently with Python hashlib, not by the parser.
  const data = { query: 'Where is the recorded fragment?', candidates: [{ id: 'unicode', version: 7, scope: 'global', projectId: null, content: 'A😀Z-A😀Z' }] };
  const f = fixture({ answer: '{"ids":[{"id":"unicode","version":7,"quote":"😀Z"}]}' }), observed = [];
  const result = await f.judge.judge(data, { onDiagnostic: value => observed.push(value) });
  assert.deepEqual(result.ids, [{ id: 'unicode', version: 7 }]);
  assert.deepEqual(result.grounding, { items: [{
    id: 'unicode', version: 7,
    contentSha256: 'bae6706d1e74141716b274e50671fa55e7182f1e31f15f95419549f0167f7e0b',
    quoteSha256: 'ac1e3834fa959756b195de0adc687625bbb4b19ef634b71b06e846ceb3e81519',
    quoteStart: 1, quoteEnd: 4, quoteBytes: 5,
  }] });
  assert.equal(result.version, 'jiyi-relevance-v7');
  for (const value of [result, observed, f.judge.getStatus()]) {
    assert.equal(JSON.stringify(value).includes('😀Z'), false, 'New result/diagnostic fields must not retain raw quote');
    assert.equal(JSON.stringify(value).includes('"quote"'), false);
  }
  assert.equal(f.requests.length, 1, 'Only the injected fake SDK stream was called');
  await f.judge.dispose();
});

test('new support protocol rejects legacy ids-only and invalid or nonliteral quotes without echoing raw text', async () => {
  const base = { id: 'archive-rule', version: 3 };
  const items = [
    base, { ...base, quote: '' }, { ...base, quote: '  \n ' }, { ...base, quote: 1 },
    { ...base, quote: 'fixture-unrecorded-quote' },
    { ...base, quote: 'Archive files are kept for thirty days.' },
    { ...base, quote: '归档文件三十天' },
    { ...base, quote: '归档文件保留三十天', extra: true },
    { id: 'invented', version: 3, quote: '归档文件保留三十天' },
    { ...base, version: 2, quote: '归档文件保留三十天' },
    { ...base, version: '3', quote: '归档文件保留三十天' },
  ];
  for (const item of items) {
    const f = fixture({ answer: JSON.stringify({ ids: [item] }) });
    await assert.rejects(f.judge.judge(input), error => {
      assert.equal(error.code, 'RELEVANCE_SCHEMA');
      assert.equal(error.message.includes('fixture-unrecorded-quote'), false);
      assert.equal(f.judge.getStatus().error.includes('fixture-unrecorded-quote'), false);
      return true;
    });
    await f.judge.dispose();
  }
  const duplicate = fixture({ answer: JSON.stringify({ ids: [{ ...base, quote: '归档文件' }, { ...base, quote: '保留三十天' }] }) });
  await assert.rejects(duplicate.judge.judge({ ...input, candidates: [...input.candidates, { id: 'unselected', version: 1, scope: 'global', projectId: null, content: 'Independent distractor.' }] }), error => error.code === 'RELEVANCE_SCHEMA');
  await duplicate.judge.dispose();
});

test('quote must belong to the selected candidate, not merely another supplied candidate', async () => {
  const data = { ...input, candidates: [...input.candidates, { id: 'other', version: 1, scope: 'global', projectId: null, content: '合成示例：每周进行一次校验。' }] };
  const f = fixture({ answer: '{"ids":[{"id":"archive-rule","version":3,"quote":"每周进行一次校验"}]}' });
  await assert.rejects(f.judge.judge(data), error => error.code === 'RELEVANCE_SCHEMA');
  await f.judge.dispose();
});

test('approved HTTP and denial contrasts reach the SDK for fixed boundary and synonymous prohibition fixtures', async () => {
  // Responses below are controlled protocol fixtures, not semantic model results.
  const cases = [
    { query:'重复提交时接口的HTTP状态码是什么？',content:'业务错误码 BZ_422 表示重复提交，处理时保留原请求号。',quote:null },
    { query:'What HTTP status corresponds to AB_503?',content:'业务异常标识 AB_503 表示签名过期。',quote:null },
    { query:'重复提交时接口返回哪一个HTTP状态？',content:'重复提交时接口返回 HTTP 409，业务错误码为 BZ_422。',quote:'接口返回 HTTP 409' },
    { query:'AB_503 对应什么HTTP状态？',content:'业务错误码 AB_503 对应接口 HTTP 422。',quote:'AB_503 对应接口 HTTP 422' },
    { query:'BZ_422 表示什么？',content:'业务错误码 BZ_422 表示重复提交，处理时保留原请求号。',quote:'BZ_422 表示重复提交' },
    { query:'重复提交时原请求号怎么处理？',content:'业务错误码 BZ_422 表示重复提交，处理时保留原请求号。',quote:'处理时保留原请求号' },
    { query:'说明BZ_422的含义和对应的HTTP状态，只提供已知事实。',content:'业务错误码 BZ_422 表示重复提交，处理时保留原请求号。',quote:'BZ_422 表示重复提交' },
    { query:'Can I turn a registry identifier into a number?',content:'登记编号禁止转换为数值，必须保留前导零。',quote:'登记编号禁止转换为数值' },
    { query:'Which team role may edit the registry identifier?',content:'登记编号禁止转换为数值，必须保留前导零。',quote:null },
  ];
  for (const [i,c] of cases.entries()) {
    const candidate={id:'synthetic-boundary-'+i,version:2,scope:'project',projectId:'fixture-project',content:c.content};
    const ids=c.quote===null?[]:[{id:candidate.id,version:2,quote:c.quote}];
    const f=fixture({answer:JSON.stringify({ids})});
    try {
      const result=await f.judge.judge({query:c.query,projectId:candidate.projectId,candidates:[candidate]});
      assert.deepEqual(result.ids,c.quote===null?[]:[{id:candidate.id,version:2}]);
      assert.equal(f.requests.length,1);assert.equal(f.requests[0].system,RELEVANCE_SYSTEM);
      assert.ok(f.requests[0].system.includes('业务码中的数字片段或名称相似性不证明 HTTP 状态'));
      assert.ok(f.requests[0].system.includes('规则对照（以下是合成例，不是候选事实）'));
      assert.ok(f.requests[0].system.includes('业务码 BIZ_503 对应 HTTP 422'));
      assert.ok(f.requests[0].system.includes('否定问法对照（以下是合成例，不是候选事实）'));
      assert.ok(f.requests[0].system.includes('不外推到其他操作或权限'));
      assert.deepEqual(JSON.parse(f.requests[0].messages[0].content[0].text),{query:c.query,projectId:candidate.projectId,candidates:[candidate]});
      assert.equal(result.grounding.items.length,ids.length);
    } finally {await f.judge.dispose();}
  }
});

test('natural rephrasing and mixed questions have no lexical-overlap or full-coverage structural gate', async () => {
  const data = { ...input, query: 'How long are archives retained, and what alert is sent afterward?' };
  const f = fixture();
  const result = await f.judge.judge(data);
  assert.deepEqual(result.ids, [{ id: 'archive-rule', version: 3 }]);
  assert.equal(result.grounding.items.length, 1);
  assert.equal(JSON.parse(f.requests[0].messages[0].content[0].text).query, data.query);
  // This is an injected selection, not evidence of real semantic understanding.
  await f.judge.dispose();
});

test('literal containment deliberately does not prove a quote answers the query', async () => {
  const f = fixture({ answer: '{"ids":[{"id":"archive-rule","version":3,"quote":"归档文件"}]}' });
  const result = await f.judge.judge({ ...input, query: '归档完成时会发送什么告警？' });
  assert.deepEqual(result.ids, [{ id: 'archive-rule', version: 3 }]);
  // This quote is only a topic noun. The local parser cannot reject it as a
  // semantic error; independent real evaluation must judge unsupported selection.
  await f.judge.dispose();
});

test('quote verification and metadata use the immutable request snapshot across await', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture({ stream: () => (async function* () {
    entered(); await new Promise(resolve => { release = resolve; });
    yield { type: 'text-delta', index: 0, text: '{"ids":[{"id":"archive-rule","version":3,"quote":"归档文件保留三十天"}]}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() });
  const data = structuredClone(input), pending = f.judge.judge(data);
  await ready;
  data.candidates[0].content = 'Changed after request snapshot';
  data.candidates[0].version = 99;
  release();
  const result = await pending;
  assert.deepEqual(result.ids, [{ id: 'archive-rule', version: 3 }]);
  assert.equal(result.grounding.items[0].quoteStart, 5);
  assert.equal(result.grounding.items[0].quoteEnd, 14);
  assert.equal(result.grounding.items[0].quoteBytes, 27);
  await f.judge.dispose();
});

test('empty selection has empty metadata and malformed JSON does not retain provider text in error causes', async () => {
  const empty = fixture({ answer: '{"ids":[]}' });
  const result = await empty.judge.judge(input);
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.grounding, { items: [] });
  await empty.judge.dispose();
  const broken = fixture({ answer: '{"ids":["fixture-unrecorded-quote"' });
  await assert.rejects(broken.judge.judge(input), error => {
    assert.equal(error.code, 'RELEVANCE_JSON');
    assert.equal(Object.hasOwn(error, 'cause'), false, 'Parser failures must not preserve raw response snippets');
    return true;
  });
  await broken.judge.dispose();
});

test('judge forwards and returns diagnostics without changing strict ids/version or request contents', async () => {
  const f = fixture(), observed = [];
  const result = await f.judge.judge(input, { onDiagnostic: snapshot => observed.push(snapshot) });
  assert.deepEqual(result.ids, [{ id: 'archive-rule', version: 3 }]);
  assert.equal(result.version, RELEVANCE_VERSION);
  assert.equal(result.provider, config.provider);
  assert.equal(result.model, config.model);
  assertDiagnostics(observed);
  assert.deepEqual(result.latency.events, observed);
  for (const stage of ['input', 'prepare', 'stream', 'assemble']) assert.ok(observed.some(event => event.stage === stage && event.status === 'success'), `Missing successful ${stage} stage`);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.system, RELEVANCE_SYSTEM);
  assert.equal(request.maxTokens, 1024);
  assert.deepEqual(request.tools, []);
  assert.deepEqual(JSON.parse(request.messages[0].content[0].text), input);
  assert.equal(Object.hasOwn(request, 'onDiagnostic'), false, 'Local diagnostics must not enter the model request');
  await f.judge.dispose();
});

test('a throwing diagnostic consumer cannot turn valid selection into failure or suppress latency events', async () => {
  const f = fixture();
  let count = 0;
  const result = await f.judge.judge(input, { onDiagnostic: () => { count++; throw new Error('fixture consumer failed'); } });
  assert.ok(count > 0);
  assert.deepEqual(result.ids, [{ id: 'archive-rule', version: 3 }]);
  assertDiagnostics(result.latency.events);
  assert.equal(f.judge.getStatus().status, 'ready');
  await f.judge.dispose();
});

test('an asynchronously rejecting diagnostic consumer cannot create unhandled failures', async () => {
  const f = fixture();
  let count = 0;
  const result = await f.judge.judge(input, { onDiagnostic: async () => { count++; throw new Error('fixture async consumer failed'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(count > 0);
  assert.deepEqual(result.ids, [{ id: 'archive-rule', version: 3 }]);
  assertDiagnostics(result.latency.events);
  assert.equal(f.judge.getStatus().status, 'ready');
  await f.judge.dispose();
});

test('provider failure remains explicit while redacted diagnostic failure reaches the consumer', async () => {
  const failure = Object.assign(new Error('fixture-private-provider-message'), { code: 'FIXTURE_PROVIDER_FAILURE' });
  const f = fixture({ prepareError: failure }), observed = [];
  await assert.rejects(f.judge.judge(input, { onDiagnostic: snapshot => observed.push(snapshot) }), error => error.code === 'FIXTURE_PROVIDER_FAILURE');
  assertDiagnostics(observed);
  assert.ok(observed.some(event => event.stage === 'prepare' && event.status === 'error' && event.errorCode === 'FIXTURE_PROVIDER_FAILURE'));
  assert.equal(f.judge.getStatus().status, 'error');
  assert.equal(f.requests.length, 0);
  await f.judge.dispose();
});
