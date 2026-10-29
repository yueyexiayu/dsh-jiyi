import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createRelevanceJudge, RELEVANCE_VERSION } from '../lib/relevance.js';
import { createLatencyTrace, createModels, EMBEDDING_MODEL, EMBEDDING_VERSION, EMBEDDING_DIMENSIONS } from '../lib/models.js';
import { retrieve, renderMemoryContext } from '../lib/retrieve.js';
import { callTextModel } from '../lib/llm.js';

// All embeddings, LLM streams and subprocesses in this file are fixtures.
// No ONNX runtime, credentials, network or production database is used.
const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
const memory = id => ({ id, version: 1, scope: 'global', projectId: null, status: 'active', content: 'private-memory-body', embedding: vector(), embeddingModel: EMBEDDING_MODEL, embeddingVersion: EMBEDDING_VERSION });
const adapter = { embed: async texts => ({ vectors: texts.map(vector), model: EMBEDDING_MODEL, version: EMBEDDING_VERSION }) };
const judge = { judge: async ({ candidates }) => ({ ids: candidates.map(({ id, version }) => ({ id, version })) }) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const refs = [{ id: 'a', version: 1, scope: 'global', projectId: null }];
function safeEvents(events) {
  assert.ok(events.length);
  for (const event of events) {
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0);
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    assert.ok(['running', 'success', 'error', 'cancelled', 'timeout'].includes(event.status));
    assert.deepEqual(Object.keys(event).filter(key => !['component', 'stage', 'status', 'elapsedMs', 'durationMs', 'counters', 'metadata', 'errorCode', 'cancelled', 'timedOut'].includes(key)), []);
  }
  assert.doesNotMatch(JSON.stringify(events), /private-memory-body|private-query|secret-error-body|secret-token/);
}
const finalCounters = events => events.at(-1).counters;

test('latency trace is monotonic, detached, observer-safe and terminal after finish', () => {
  const seen = [];
  const trace = createLatencyTrace('test', snapshot => { seen.push(snapshot); snapshot.stage = 'observer-mutation'; throw new Error('observer'); });
  trace.begin('one'); trace.begin('two'); trace.finish();
  const before = trace.snapshot();
  trace.begin('late'); trace.finish(Object.assign(new Error('secret-error-body'), { code: 'FAILURE' }));
  assert.deepEqual(trace.snapshot().events, before.events);
  assert.deepEqual(before.events.map(e => [e.stage, e.status]), [['one', 'running'], ['one', 'success'], ['two', 'running'], ['two', 'success']]);
  assert.equal(before.usage, 'unknown');
  assert.ok(before.events.every((e, i, all) => !i || e.elapsedMs >= all[i - 1].elapsedMs));
  safeEvents(before.events); assert.equal(seen.length, 4);
});

test('retrieval diagnostics preserve results and include bounded coarse refs and judge actual-call outcome', async () => {
  const options = { query: 'private-query', records: [memory('a')] };
  const plain = await retrieve(options, adapter, judge);
  const events = [];
  const observed = await retrieve({ ...options, onDiagnostic: event => { events.push(event); throw new Error('observer'); } }, adapter, judge);
  for (const key of ['hits', 'context', 'usedTokens', 'embeddingUpdates']) assert.deepEqual(observed[key], plain[key]);
  assert.deepEqual(observed.diagnostics.candidateRefs, refs);
  assert.deepEqual(observed.diagnostics.judge, { called: true, succeeded: true });
  assert.deepEqual(events.filter(e => e.status === 'success').map(e => e.stage), ['scopeFilter', 'planning', 'embedding', 'candidates', 'llm', 'package']);
  safeEvents(events);
  const many = await retrieve({ query: 'private-query', records: Array.from({ length: 30 }, (_, i) => memory(String(i))), maxCandidates: 20 }, adapter, judge);
  assert.equal(many.diagnostics.candidateRefs.length, 20);
  assert.ok(many.diagnostics.candidateRefs.every(ref => Object.keys(ref).length === 4));
  const empty = await retrieve({ query: 'private-query', records: [] }, { embed: () => assert.fail('empty must not embed') }, judge);
  assert.deepEqual(empty.diagnostics.judge, { called: false, succeeded: false });
  assert.deepEqual(empty.diagnostics.candidateRefs, []);
});

test('embedding errors and judge errors retain their actual failed phase without leaking text', async () => {
  for (const stage of ['embedding', 'llm']) {
    const failure = Object.assign(new Error('secret-error-body secret-token'), { code: 'FIXTURE_FAILURE' });
    const events = [];
    await assert.rejects(retrieve({ query: 'private-query', records: [memory('a')], onDiagnostic: e => events.push(e) }, stage === 'embedding' ? { embed: async () => { throw failure; } } : adapter, stage === 'llm' ? { judge: async () => { throw failure; } } : judge), error => {
      assert.equal(error, failure);
      assert.equal(error.diagnostics.retrieve.events.at(-1).stage, stage);
      assert.equal(error.diagnostics.retrieve.events.at(-1).errorCode, 'FIXTURE_FAILURE');
      assert.deepEqual(error.diagnostics.candidateRefs, stage === 'llm' ? refs : []);
      assert.deepEqual(error.diagnostics.judge, { called: stage === 'llm', succeeded: false });
      safeEvents(error.diagnostics.retrieve.events); return true;
    });
    safeEvents(events);
  }
  await assert.rejects(retrieve({ query: '', records: [] }, adapter, judge), error => {
    assert.equal(error.code, 'INVALID_QUERY');
    assert.equal(error.diagnostics.retrieve.events.at(-1).stage, 'scopeFilter'); return true;
  });
});

test('retrieval timeout retains candidates and cannot convert a late judge decision into a result', async () => {
  let resolveJudge, judgeSignal;
  const events = [];
  const pending = retrieve({ query: 'private-query', records: [memory('a')], timeoutMs: 15, onDiagnostic: e => events.push(e) }, adapter, { judge: (_input, { signal }) => { judgeSignal = signal; return new Promise(resolve => { resolveJudge = resolve; }); } });
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'RETRIEVAL_TIMEOUT');
    assert.deepEqual(error.diagnostics.candidateRefs, refs);
    assert.deepEqual(error.diagnostics.judge, { called: true, succeeded: false });
    const last = error.diagnostics.retrieve.events.at(-1);
    assert.equal(last.stage, 'llm'); assert.equal(last.status, 'timeout'); assert.equal(last.timedOut, true);
    return true;
  });
  assert.equal(judgeSignal.aborted, true);
  const count = events.length;
  resolveJudge({ ids: [{ id: 'a', version: 1 }] }); await tick();
  assert.equal(events.length, count);
  assert.equal(events.some(e => e.stage === 'package'), false);
});

test('cancelling retrieval A leaves B intact; late embedding A cannot judge, pack or update records', async () => {
  const a = new AbortController(); let releaseA, aCalls = 0;
  const records = [memory('a')], before = structuredClone(records), events = [];
  const blocked = { embed: () => new Promise(resolve => { releaseA = () => resolve({ vectors: [vector()], model: EMBEDDING_MODEL, version: EMBEDDING_VERSION }); }) };
  const first = retrieve({ query: 'private-query', records, signal: a.signal, onDiagnostic: e => events.push(e) }, blocked, { judge: () => { aCalls++; return { ids: [] }; } });
  const rejected = assert.rejects(first, error => {
    assert.equal(error.code, 'ABORTED'); assert.equal(error.diagnostics.retrieve.events.at(-1).status, 'cancelled'); return true;
  });
  await tick();
  const second = retrieve({ query: 'private-query', records }, adapter, judge);
  a.abort(); await rejected;
  assert.equal((await second).hits.length, 1);
  const count = events.length; releaseA(); await tick();
  assert.equal(events.length, count); assert.equal(aCalls, 0); assert.deepEqual(records, before);
  assert.equal(events.some(e => e.stage === 'package'), false);
});

class Assembler {
  text = '';
  push(chunk) { if (chunk.type === 'text-delta') this.text += chunk.text; }
  blocks() { return [{ type: 'text', text: this.text }]; }
}
const helpers = { BlockAssembler: Assembler, createUserMessage: x => x };
const config = { provider: 'fixture', model: 'fixture', timeoutMs: 1000 };
const text = { type: 'text-delta', index: 0, text: 'private-memory-body' };
const stop = { type: 'finish', reason: { kind: 'stop' } };
const sdk = (stream, prepare) => ({ llm: { prepareCall: prepare ?? (async (config, _signal, configure) => ({ config: configure(config, { reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } }), stream })) } });
const llm = (ctx, extra = {}, settings = config) => callTextModel(ctx, helpers, settings, { input: { query: 'private-query' }, system: 'fixed', ...extra });

test('LLM diagnostics distinguish prepare/stream/assemble and exact SDK launch counters, unknown usage', async () => {
  const events = [];
  const ctx = sdk(async function* () { yield text; yield stop; });
  assert.equal(await llm(ctx, { onDiagnostic: e => events.push(e) }), 'private-memory-body');
  assert.deepEqual(events.filter(e => e.status === 'success').map(e => e.stage), ['input', 'prepare', 'stream', 'assemble']);
  const counters = finalCounters(events);
  for (const key of ['prepareStarted', 'prepareSucceeded', 'streamStarted', 'finishStop']) assert.equal(counters[key], 1);
  assert.equal(counters.reasoningEffort, 'minimal'); assert.equal(counters.usage, 'unknown');
  const prepared = events.find(e => e.stage === 'stream' && e.status === 'running').metadata.preparedControls;
  assert.deepEqual(prepared.values, { provider: 'fixture', model: 'fixture', maxTokens: 1024, reasoningEffort: 'minimal', temperature: null, topP: null, seed: null });
  assert.deepEqual(prepared.observed, { provider: true, model: true, maxTokens: true, reasoningEffort: true, temperature: false, topP: false, seed: false });
  assert.equal(prepared.selectedReasoningEffort, 'minimal'); assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
  assert.equal(counters.chunkCount, 2); assert.equal(counters.textBytes, Buffer.byteLength('private-memory-body'));
  safeEvents(events);
});

test('LLM prepare failure and stream timeout report real stages and never accept late preparation', async () => {
  const events = [];
  await assert.rejects(llm(sdk(null, async () => { throw Object.assign(new Error('secret-error-body'), { code: 'FIXTURE_AUTH_FAILURE' }); }), { onDiagnostic: e => events.push(e) }), error => {
    assert.equal(error.code, 'FIXTURE_AUTH_FAILURE');
    const last = error.diagnostics.llm.events.at(-1); assert.equal(last.stage, 'prepare'); assert.equal(last.status, 'error');
    assert.equal(last.counters.prepareStarted, 1); assert.equal(last.counters.prepareSucceeded, 0); assert.equal(last.counters.streamStarted, 0);
    return true;
  });
  safeEvents(events);
  let resolvePrepare, streamCalls = 0;
  const lateEvents = [];
  const late = llm(sdk(null, () => new Promise(resolve => { resolvePrepare = resolve; })), { onDiagnostic: e => lateEvents.push(e) }, { ...config, timeoutMs: 10 });
  await assert.rejects(late, { code: 'LLM_TIMEOUT' });
  const count = lateEvents.length;
  resolvePrepare({ config: {}, stream() { streamCalls++; throw new Error('late stream forbidden'); } }); await tick();
  assert.equal(streamCalls, 0); assert.equal(lateEvents.length, count);
  let returnRequested = 0;
  await assert.rejects(llm(sdk(() => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return() { returnRequested++; return new Promise(() => {}); } })), {}, { ...config, timeoutMs: 10 }), error => {
    assert.equal(error.code, 'LLM_TIMEOUT'); assert.equal(error.diagnostics.llm.events.at(-1).stage, 'stream'); return true;
  });
  assert.equal(returnRequested, 1); // Request is not evidence that SDK transport cleanup finished.
});

test('usage keeps only real finite SDK counts, unknown absent fields, and never raw provider data', async () => {
  const events = [];
  const ctx = sdk(async function* () {
    yield text;
    yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 4, totalTokens: 18, cacheReadTokens: 0, cacheWriteTokens: -1, reasoningTokens: Infinity, raw: 'secret-token' } };
    yield stop;
  });
  await llm(ctx, { onDiagnostic: e => events.push(e) });
  assert.deepEqual(finalCounters(events).usage, { inputTokens: 14, outputTokens: 4, totalTokens: 18, cacheReadTokens: 0, cacheWriteTokens: 'unknown', reasoningTokens: 'unknown' });
  safeEvents(events);
  const throwing = createLatencyTrace('fixture', async () => { throw new Error('observer only'); });
  throwing.begin('input'); throwing.finish(); await tick();
});

test('cancelling LLM A does not abort B, and a late A stream chunk cannot become text or diagnostics', async () => {
  const controller = new AbortController(), events = [];
  let calls = 0, resolveNext, returnRequested = 0;
  const signals = [];
  const ctx = sdk(null, async (config, signal) => {
    signals.push(signal); const first = calls++ === 0;
    return { config, stream: first ? () => ({
      [Symbol.asyncIterator]() { return this; },
      next: () => new Promise(resolve => { resolveNext = resolve; }),
      return() { returnRequested++; return Promise.resolve({ done: true }); },
    }) : async function* () { yield text; yield stop; } };
  });
  const a = llm(ctx, { signal: controller.signal, onDiagnostic: e => events.push(e) });
  const failed = assert.rejects(a, { code: 'ABORTED' });
  await tick();
  const b = llm(ctx);
  controller.abort(); await failed;
  assert.equal(await b, 'private-memory-body');
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false); assert.equal(returnRequested, 1);
  const count = events.length;
  resolveNext({ done: false, value: text }); await tick();
  assert.equal(events.length, count); assert.equal(events.at(-1).status, 'cancelled');
  assert.equal(events.some(e => e.stage === 'assemble'), false);
});

// Reuse the two unchanged-v016 baseline proof cases here, rather than running
// the evidence driver or adding a second copy of its behavioral assertions.
test('singleton planner preserves the apple negative and exact singleton payload while skipping only the latter', async () => {
  const row = { ...memory('synthetic-singleton'), scope: 'project', projectId: 'synthetic-p', content: 'apple' };
  let embeds = 0, judges = 0, payload;
  const orthogonal = vector(); orthogonal[0] = 0; orthogonal[1] = 1;
  const fake = { embed: async texts => { embeds++; return { vectors: texts.map(() => orthogonal), model: EMBEDDING_MODEL, version: EMBEDDING_VERSION }; } };
  const selector = { judge: async input => { judges++; payload = structuredClone(input); return { ids: [{ id: row.id, version: 1 }] }; } };
  const apple = await retrieve({ query: 'apple', records: [row], projectId: 'synthetic-p' }, fake, selector);
  assert.equal(embeds, 1); assert.equal(judges, 0); assert.deepEqual(apple.hits, []);
  row.content = '本项目由 renderInvoice 处理票据。';
  embeds = 0;
  const exact = await retrieve({ query: '`renderInvoice`', records: [row], projectId: 'synthetic-p', projectLabels: { 'synthetic-p': '合成项目' } }, fake, selector);
  assert.equal(embeds, 0); assert.equal(judges, 1);
  assert.deepEqual(payload, { query: '`renderInvoice`', projectId: 'synthetic-p', candidates: [{ id: row.id, version: 1, scope: 'project', projectId: 'synthetic-p', projectName: '合成项目', content: row.content, updatedAt: undefined }] });
  assert.deepEqual(exact.hits.map(({ id, version }) => ({ id, version })), [{ id: row.id, version: 1 }]);
  assert.equal(exact.context, renderMemoryContext([row]));
  assert.equal(exact.hits[0].semanticScore, null); assert.equal(exact.hits[0].score, null);
  assert.deepEqual(exact.hits[0].exactIdentifiers, ['renderInvoice']);
  assert.deepEqual(exact.diagnostics.queryEmbedding, { status: 'skipped', reason: 'singleton-existing-lexical-eligibility', invocations: 0, validatedThisRequest: false });
  assert.deepEqual(exact.diagnostics.latency.embedding, []);
  assert.deepEqual(exact.diagnostics.embeddingExecutions, []);
  assert.equal(exact.diagnostics.embeddingExecutionStatus, 'not-requested');
});

test('singleton planner uses the full lexical predicate and only the scoped active latest record', async () => {
  const row = { ...memory('a'), content: 'invoice cents', scope: 'project', projectId: 'alpha', version: 3 };
  let embeds = 0, calls = 0;
  const fake = { embed: async texts => { embeds++; return adapter.embed(texts); } };
  const selected = { judge: async input => { calls++; assert.equal(input.candidates.length, 1); assert.equal(input.candidates[0].version, 3); return judge.judge(input); } };
  const result = await retrieve({ query: 'invoice cents', records: [
    { ...row, version: 1 }, row, { ...row, version: 4, status: 'deleted' },
    { ...row, id: 'foreign', projectId: 'beta' }, { ...memory('global'), content: row.content },
  ], scope: 'project', projectId: 'alpha' }, fake, selected);
  assert.equal(embeds, 0); assert.equal(calls, 1); assert.equal(result.hits[0].lexicalScore, 1);
  assert.equal(result.hits[0].semanticScore, null); assert.equal(result.diagnostics.scopeFiltered, 4);
  for (const records of [[{ ...row, embeddingVersion: 'old-space' }], [{ ...row, embedding: null }], [{ ...row, embedding: Array(EMBEDDING_DIMENSIONS).fill(0) }], [row, { ...row, id: 'b' }]]) {
    embeds = 0; await retrieve({ query: 'invoice cents', records, projectId: 'alpha' }, fake, judge);
    assert.equal(embeds, 1, 'stale/invalid vectors and multiple scoped records must keep embedding');
  }
  embeds = 0;
  const semantic = await retrieve({ query: 'sky blue', records: [row], projectId: 'alpha' }, fake, judge);
  assert.equal(embeds, 1); assert.equal(semantic.hits[0].lexicalScore, 0); assert.equal(semantic.hits[0].semanticScore, 1);
});

test('singleton planning retains configuration, cancellation, full budget and selector errors', async () => {
  const row = { ...memory('a'), content: 'invoice cents' }, options = { query: 'invoice cents', records: [row] };
  let calls = 0;
  const selector = { judge: async input => { calls++; return judge.judge(input); } };
  await assert.rejects(retrieve(options, undefined, selector), { code: 'EMBEDDING_UNAVAILABLE' });
  await assert.rejects(retrieve(options, { embed: true }, selector), error => {
    assert.ok(error instanceof TypeError); assert.equal(error.diagnostics.queryEmbedding.invocations, 0); return true;
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(retrieve({ ...options, signal: controller.signal }, adapter, selector), { code: 'ABORTED' });
  assert.equal(calls, 0);
  let attempted = 0;
  await assert.rejects(retrieve(options, { getStatus: () => ({ status: 'not-configured' }), embed: async () => { attempted++; throw Object.assign(new Error('unconfigured'), { code: 'EMBEDDING_NOT_CONFIGURED' }); } }, selector), { code: 'EMBEDDING_NOT_CONFIGURED' });
  assert.equal(attempted, 1); assert.equal(calls, 0);
  const statusError = new Error('status failed');
  await assert.rejects(retrieve(options, { ...adapter, getStatus: () => { throw statusError; } }, selector), error => error === statusError);
  assert.equal(calls, 0);
  const zero = await retrieve({ ...options, maxChars: 0 }, adapter, selector);
  assert.deepEqual(zero.hits, []); assert.equal(calls, 0);
  const expected = renderMemoryContext([row]);
  const bounded = await retrieve({ ...options, budgetTokens: Buffer.byteLength(expected) - 1 }, adapter, selector);
  assert.equal(calls, 1); assert.deepEqual(bounded.hits, []); assert.equal(bounded.diagnostics.budgetSkipped, 1);
  const failure = Object.assign(new Error('selector failure'), { code: 'FIXTURE_SELECTOR_FAILURE' });
  await assert.rejects(retrieve(options, adapter, { judge: async () => { throw failure; } }), error => {
    assert.equal(error, failure); assert.equal(error.diagnostics.queryEmbedding.status, 'skipped');
    assert.deepEqual(error.diagnostics.embeddingExecutions, []); return true;
  });
  await assert.rejects(retrieve(options, adapter, { judge: async () => ({ ids: [{ id: 'invented', version: 1 }] }) }), { code: 'RELEVANCE_PROTOCOL' });
  let release, signal;
  const late = retrieve({ ...options, timeoutMs: 10 }, adapter, { judge: (_input, controls) => { signal = controls.signal; return new Promise(resolve => { release = resolve; }); } });
  await assert.rejects(late, { code: 'RETRIEVAL_TIMEOUT' }); assert.equal(signal.aborted, true);
  release({ ids: [{ id: 'a', version: 1 }] }); await tick();
});

test('singleton cancellation remains request-owned and ignores its late selector without starting embedding', async () => {
  const controller = new AbortController(), events = [], signals = [];
  let release, calls = 0, embeds = 0;
  const noWork = { embed: () => { embeds++; return new Promise(() => {}); } };
  const selector = { judge: (input, { signal }) => {
    signals.push(signal);
    return calls++ === 0 ? new Promise(resolve => { release = resolve; }) : judge.judge(input);
  } };
  const options = { query: 'invoice cents', records: [{ ...memory('a'), content: 'invoice cents' }] };
  const a = retrieve({ ...options, signal: controller.signal, onDiagnostic: e => events.push(e) }, noWork, selector);
  const failed = assert.rejects(a, error => {
    assert.equal(error.code, 'ABORTED'); assert.equal(error.diagnostics.queryEmbedding.status, 'skipped'); return true;
  });
  await tick();
  const b = retrieve(options, noWork, selector);
  controller.abort(); await failed;
  assert.equal((await b).hits.length, 1); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  assert.equal(embeds, 0); assert.equal(calls, 2);
  const count = events.length; release({ ids: [{ id: 'a', version: 1 }] }); await tick();
  assert.equal(events.length, count); assert.equal(events.some(e => e.stage === 'package'), false);
});

test('the real grounded parser joins singleton retrieval with one fake SDK stream and no raw quote diagnostics', async () => {
  const row = { ...memory('a'), content: 'invoice cents' }, events = [];
  let sdkCalls = 0, embeds = 0;
  const ctx = sdk(async function* () { sdkCalls++; yield { type: 'text-delta', index: 0, text: JSON.stringify({ ids: [{ id: 'a', version: 1, quote: row.content }] }) }; yield stop; });
  const relevance = createRelevanceJudge({ ctx, helpers, config });
  try {
    const result = await retrieve({ query: 'invoice cents', records: [row], onDiagnostic: e => events.push(e) }, { embed: () => { embeds++; return new Promise(() => {}); } }, relevance);
    assert.equal(sdkCalls, 1); assert.equal(embeds, 0); assert.equal(result.context, renderMemoryContext([row]));
    const sha = createHash('sha256').update(row.content, 'utf8').digest('hex');
    assert.deepEqual(result.diagnostics.relevance.grounding, { items: [{ id: 'a', version: 1, contentSha256: sha, quoteSha256: sha, quoteStart: 0, quoteEnd: row.content.length, quoteBytes: Buffer.byteLength(row.content) }] });
    assert.equal(JSON.stringify(result.diagnostics).includes(row.content), false); safeEvents(events);
  } finally { await relevance.dispose(); }
});

test('grounding is whitelisted after strict ids validation and never enters timing diagnostics', async () => {
  const row = memory('a'), events = [];
  const item = { id: 'a', version: 1, contentSha256: 'a'.repeat(64), quoteSha256: 'b'.repeat(64), quoteStart: 0, quoteEnd: 7, quoteBytes: 7 };
  const result = await retrieve({ query: 'private-query', records: [row], onDiagnostic: e => events.push(e) }, adapter, { judge: async () => ({ ids: [{ id: 'a', version: 1 }], grounding: { items: [{ ...item, quote: 'secret-token' }], raw: 'secret-token' } }) });
  assert.deepEqual(result.diagnostics.relevance.grounding, { items: [item] });
  assert.equal(JSON.stringify(result.diagnostics).includes('secret-token'), false);
  safeEvents(events);
  for (const grounding of [{ items: [{ ...item, version: 2 }] }, { items: [{ ...item, quoteEnd: 999999 }] }, { items: [] }]) {
    await assert.rejects(retrieve({ query: 'private-query', records: [row] }, adapter, { judge: async () => ({ ids: [{ id: 'a', version: 1 }], grounding }) }), { code: 'RELEVANCE_PROTOCOL' });
  }
});

test('a verdict declaring the real relevance version requires grounding even for an empty decision', async () => {
  const options = { query: 'invoice cents', records: [{ ...memory('a'), content: 'invoice cents' }] };
  for (const ids of [[{ id: 'a', version: 1 }], []]) {
    await assert.rejects(retrieve(options, adapter, { judge: async () => ({ ids, version: RELEVANCE_VERSION }) }), { code: 'RELEVANCE_PROTOCOL' });
  }
  const invalidRoot = []; invalidRoot.items = [];
  await assert.rejects(retrieve(options, adapter, { judge: async () => ({ ids: [], version: RELEVANCE_VERSION, grounding: invalidRoot }) }), { code: 'RELEVANCE_PROTOCOL' });
  const empty = await retrieve(options, adapter, { judge: async () => ({ ids: [], version: RELEVANCE_VERSION, grounding: { items: [] } }) });
  assert.deepEqual(empty.hits, []); assert.deepEqual(empty.diagnostics.relevance.grounding, { items: [] });
  const fixture = await retrieve(options, adapter, judge);
  assert.equal(fixture.hits.length, 1, 'unversioned pure fixtures retain the generic ids contract');
});

test('embedding execution retains only explicit same-result metadata without changing latency shape', async () => {
  const latency = { component: 'embedding', events: [], usage: 'unknown' };
  // This PID is explicitly supplied fake return data, not a spawned process or ESRCH claim.
  const execution = { pid: 654321, exitCode: 0, signal: null, isolation: 'child-process', latency, argv: 'secret-token' };
  const options = { query: 'private-query', records: [memory('a')] };
  const result = await retrieve(options, { embed: async texts => ({ ...await adapter.embed(texts), execution }) }, judge);
  assert.deepEqual(result.diagnostics.embeddingExecutions, [{ pid: 654321, exitCode: 0, signal: null }]);
  assert.equal(result.diagnostics.embeddingExecutionStatus, 'observed');
  assert.deepEqual(result.diagnostics.latency.embedding, [latency]);
  assert.equal(JSON.stringify(result.diagnostics).includes('secret-token'), false);
  const unknown = await retrieve(options, adapter, judge);
  assert.deepEqual(unknown.diagnostics.embeddingExecutions, []); assert.equal(unknown.diagnostics.embeddingExecutionStatus, 'unknown');
  for (const execution of [{ pid: 0, exitCode: 0, signal: null }, { pid: 654321, signal: null }]) {
    const invalid = await retrieve(options, { embed: async texts => ({ ...await adapter.embed(texts), execution }) }, judge);
    assert.deepEqual(invalid.diagnostics.embeddingExecutions, []); assert.equal(invalid.diagnostics.embeddingExecutionStatus, 'unknown');
  }
});

test('embedding execution survives later batch or judge failure without inventing unknown child ownership', async () => {
  let calls = 0;
  const records = Array.from({ length: 33 }, (_, i) => ({ ...memory(String(i)), embedding: null }));
  const failure = Object.assign(new Error('batch failed'), { code: 'FIXTURE_EMBEDDING_FAILURE' });
  await assert.rejects(retrieve({ query: 'private-query', records }, { embed: async texts => {
    if (++calls === 2) throw failure;
    return { ...await adapter.embed(texts), execution: { pid: 654321, exitCode: 0, signal: null } };
  } }, judge), error => {
    assert.equal(error, failure); assert.equal(calls, 2);
    assert.deepEqual(error.diagnostics.embeddingExecutions, [{ pid: 654321, exitCode: 0, signal: null }]);
    assert.equal(error.diagnostics.embeddingExecutionStatus, 'partial'); return true;
  });
  await assert.rejects(retrieve({ query: 'private-query', records: [memory('a')] }, { embed: async texts => ({ ...await adapter.embed(texts), execution: { pid: 654321, exitCode: 0, signal: null } }) }, { judge: async () => { throw Object.assign(new Error('judge failed'), { code: 'FIXTURE_JUDGE_FAILURE' }); } }), error => {
    assert.equal(error.diagnostics.embeddingExecutionStatus, 'observed');
    assert.deepEqual(error.diagnostics.embeddingExecutions, [{ pid: 654321, exitCode: 0, signal: null }]); return true;
  });
});

function mockChildren(t) {
  const children = [];
  class Child extends EventEmitter {
    constructor() { super(); this.pid = 100000 + children.length; this.kills = []; children.push(this); }
    send(message, callback) { this.input = message; callback?.(null); }
    kill(signal) { this.kills.push(signal); return true; }
    ready(timings = {}) { this.emit('message', { type: 'ready', timings }); }
    result(timings = {}) { this.emit('message', { type: 'result', vectors: this.input.texts.map(vector), timings }); }
    close(code = 0, signal = null) { this.emit('close', code, signal); }
  }
  const original = childProcess.fork;
  childProcess.fork = () => new Child(); syncBuiltinESMExports();
  t.after(() => { childProcess.fork = original; syncBuiltinESMExports(); });
  return children;
}

test('mock embedding reuses an idle child without inventing close evidence', async t => {
  const children = mockChildren(t), events = [], models = createModels();
  const first = models.embed(['private-query'], { onDiagnostic: e => events.push(e) });
  const child = children[0];
  child.ready({ assetVerifyMs: 2, runtimeImportMs: 3, pipelineLoadMs: 5, secret: 'secret-token' });
  child.result({ inferenceMs: 7, pipelineLoadMs: -1 });
  const result = await first;
  assert.equal(models.getStatus().activeRequests, 0);
  assert.equal(models.getStatus().activeProcesses[0].phase, 'idle');
  assert.equal(result.execution.pid, child.pid);
  assert.equal(result.execution.exitCode, null);
  assert.equal(result.execution.signal, null);
  assert.equal('cleanupClosed' in finalCounters(events), false);
  assert.equal(finalCounters(events).pipelineLoadMs, 5);
  const second = models.embed(['second']);
  assert.equal(children.length, 1); child.result({ inferenceMs: 2 });
  assert.equal((await second).execution.pid, child.pid);
  safeEvents(events);
  let closed = false; const disposing = models.dispose().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.deepEqual(child.kills, ['SIGTERM']);
  child.close(null, 'SIGTERM'); await disposing;
  assert.equal(models.getStatus().activeProcesses.length, 0);
});

test('mock process cancellation A kills only A, waits its close, and B remains independent', async t => {
  const children = mockChildren(t), events = [], controller = new AbortController();
  const models = createModels();
  const a = models.embed(['private-query'], { signal: controller.signal, onDiagnostic: e => events.push(e) });
  let settled = false;
  const rejected = assert.rejects(a, error => {
    settled = true; assert.equal(error.code, 'ABORTED');
    const last = error.diagnostics.embedding.events.at(-1);
    assert.equal(last.stage, 'cleanup'); assert.equal(last.counters.cleanupClosed, 1);
    return true;
  });
  const b = models.embed(['independent B']);
  await assert.rejects(models.embed(['overload']), error => {
    assert.equal(error.code, 'EMBEDDING_BUSY'); assert.equal(error.diagnostics.embedding.events.at(-1).stage, 'input'); return true;
  });
  children[0].ready(); children[1].ready(); controller.abort();
  await tick(); assert.equal(settled, false); assert.deepEqual(children[0].kills, ['SIGTERM']); assert.deepEqual(children[1].kills, []);
  assert.equal(events.some(e => e.counters?.cleanupClosed === 1), false);
  children[0].result(); // Late successful message is ignored after cancellation.
  children[0].close(null, 'SIGTERM'); await rejected;
  children[1].result(); assert.equal((await b).vectors.length, 1);
  assert.equal(models.getStatus().activeRequests, 0);
  assert.ok(events.some(e => e.stage === 'inference' && e.status === 'cancelled'));
  safeEvents(events); const disposing = models.dispose(); children[1].close(null, 'SIGTERM'); await disposing;
});

test('mock disposal cancels an active request and permits replacement after close', async t => {
  const children = mockChildren(t), models = createModels();
  const pending = models.embed(['one']);
  const rejected = assert.rejects(pending, error => error.code === 'MODEL_DISPOSED');
  const disposing = models.dispose();
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  await assert.rejects(models.embed(['later']), error => error.code === 'MODEL_DISPOSED');
  children[0].close(null, 'SIGTERM'); await Promise.all([rejected, disposing]);
  const replacement = createModels({ config: { timeoutMs: 200 } });
  const next = replacement.embed(['next']);
  assert.equal(children.length, 2);
  children[1].ready(); children[1].result(); await next;
  const closing = replacement.dispose(); children[1].close(null, 'SIGTERM'); await closing;
});

test('synchronous load observer cancellation and disposal settle only after child close', async t => {
  const children = mockChildren(t);
  for (const action of ['abort', 'dispose']) {
    const controller = new AbortController(), models = createModels();
    let disposing;
    const pending = models.embed(['one'], { signal: controller.signal, onDiagnostic: event => {
      if (event.stage === 'load' && event.status === 'running') {
        if (action === 'abort') controller.abort();
        else disposing = models.dispose();
      }
    } });
    const child = children.at(-1);
    const failed = assert.rejects(pending, { code: action === 'abort' ? 'ABORTED' : 'MODEL_DISPOSED' });
    assert.deepEqual(child.kills, ['SIGTERM']);
    assert.equal(child.input, undefined, 'cancelled work must not be sent');
    child.close(null, 'SIGTERM');
    await failed;
    if (disposing) await disposing;
    await models.dispose();
    assert.deepEqual(models.getStatus().activeProcesses, []);
  }
});

test('mock crashed child is discarded and a new child can recover', async t => {
  const children = mockChildren(t), models = createModels();
  const pending = models.embed(['first']);
  const rejected = assert.rejects(pending, error => error.code === 'EMBEDDING_PROCESS_CRASH');
  children[0].close(null, 'SIGKILL'); await rejected;
  const next = models.embed(['second']);
  assert.equal(children.length, 2); children[1].ready(); children[1].result(); await next;
  const closing = models.dispose(); children[1].close(null, 'SIGTERM'); await closing;
});

test('mock embedding timeout records load vs inference and never claims cleanup before close', async t => {
  const children = mockChildren(t);
  for (const stage of ['load', 'inference']) {
    const models = createModels({ config: { loadTimeoutMs: 10, timeoutMs: 10 } });
    const events = [];
    const pending = models.embed(['private-query'], { onDiagnostic: e => events.push(e) });
    const expected = stage === 'load' ? 'EMBEDDING_LOAD_TIMEOUT' : 'EMBEDDING_TIMEOUT';
    const failed = assert.rejects(pending, error => {
      assert.equal(error.code, expected); assert.equal(error.diagnostics.embedding.events.at(-1).counters.cleanupClosed, 1); return true;
    });
    const child = children.at(-1);
    if (stage !== 'load') child.ready();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(events.some(e => e.stage === stage && e.status === 'timeout'));
    assert.equal(events.some(e => e.counters?.cleanupClosed === 1), false);
    child.close(null, 'SIGTERM'); await failed; await models.dispose();
  }
});
