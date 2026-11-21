import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { retrieve, decayFactor } from '../lib/retrieve.js';
import { redactSensitiveText } from '../lib/redact.js';
import { stripCodeFence } from '../lib/extract.js';
import { failureSignature } from '../lib/lessons.js';
import { findSemanticConflicts, buildConflictIndex } from '../lib/review.js';
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from '../lib/models.js';

// Regressions for the P2 defects found in the 0.1.37 audit.
const BT = String.fromCharCode(96).repeat(3);
const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const memory = (id, content, extra = {}) => ({ id, content, version: 1, status: 'active', scope: 'global', embedding: vector(), embeddingModel: EMBEDDING_MODEL, embeddingVersion: EMBEDDING_VERSION, ...extra });
const adapter = { embed: async texts => ({ vectors: texts.map(() => vector()), model: EMBEDDING_MODEL, version: EMBEDDING_VERSION }) };
const approve = { judge: async ({ candidates }) => ({ ids: candidates.map(({ id, version }) => ({ id, version })), provider: 'fixture', model: 'approve', version: 'fixture-v1', elapsedMs: 0 }) };

test('the factKey cap counts each dropped candidate exactly once', async () => {
  const records = [
    memory('a', '同一事实 版本一', { factKey: 'same' }),
    memory('b', '同一事实 版本二', { factKey: 'same' }),
    memory('c', '同一事实 版本三', { factKey: 'same' }),
    memory('d', '另一件事 版本一'),
    memory('e', '第三件事 版本一'),
  ];
  const result = await retrieve({ query: '同一事实 版本', records, semanticThreshold: 0.5, maxMemories: 6, maxCandidates: 12 }, adapter, approve);
  assert.equal(result.hits.length, 4, 'two of the three same-key records plus the two others');
  assert.equal(result.diagnostics.diversity.factKeyCapped, 1, 'exactly one record was dropped by the cap');
});

test('redaction leaves ordinary Chinese prose intact while still removing credentials', () => {
  const prose = '讨论 secret: 这是一个普通中文句子';
  assert.equal(redactSensitiveText(prose), prose, 'a CJK value is prose, not a credential');
  assert.match(redactSensitiveText('secret=abcdef123456'), /^secret=\[REDACTED\]$/u);
  assert.match(redactSensitiveText('数据库连接串 postgres://user:pass@localhost/db'), /postgres:\/\/\[REDACTED\]@/u);
});

test('closing a store twice is a no-op', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jiyi-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, 'm.sqlite'));
  store.close();
  store.close();
  store.close();
});

test('JSON fences are tolerated regardless of case and surrounding prose', () => {
  const bodies = [
    '{"a":1}',
    BT + 'json\n{"a":1}\n' + BT,
    BT + 'JSON\n{"a":1}\n' + BT,
    BT + 'json\n{"a":1}\n' + BT + '\n以上是结果',
    '好的，结果如下：\n{"a":1}',
  ];
  for (const body of bodies) assert.doesNotThrow(() => JSON.parse(stripCodeFence(body)), JSON.stringify(body));
  assert.equal(stripCodeFence('not json at all'), 'not json at all', 'a body without JSON is returned unchanged so the caller still reports a parse error');
});

test('failure signatures keep distinguishing numbers but normalise volatile identifiers', () => {
  const sig = detail => failureSignature('bash', { code: 'E1' }, detail);
  assert.notEqual(sig('test case 1 failed'), sig('test case 2 failed'), 'different cases are different failures');
  assert.equal(sig('id 550e8400-e29b-41d4-a716-446655440000 failed'), sig('id 550e8400-e29b-41d4-a716-446655440111 failed'), 'uuids normalise');
  assert.equal(sig('at 2026-11-21T12:00:00.000Z boom'), sig('at 2026-11-22T09:30:00.000Z boom'), 'timestamps normalise');
  assert.equal(sig('at file.js:12:7 boom'), sig('at file.js:98:3 boom'), 'source locations normalise');
});

test('the factKey index returns the same matches as a linear scan', () => {
  const existing = [];
  for (let i = 0; i < 200; i++) existing.push({ id: 'm' + i, version: 1, content: '内容 ' + i, scope: 'global', projectId: null, kind: 'project_fact', factKey: 'k' + i, status: 'active', sources: [] });
  const index = buildConflictIndex(existing);
  const candidate = { content: '内容 42 变更', scope: 'global', projectId: null, kind: 'project_fact', factKey: 'k42' };
  const linear = findSemanticConflicts(candidate, existing);
  const indexed = findSemanticConflicts(candidate, existing, index);
  assert.deepEqual(indexed.map(c => c.memory.id), linear.map(c => c.memory.id));
  assert.equal(indexed.length, 1);
  assert.deepEqual(findSemanticConflicts({ content: 'x', scope: 'global', projectId: null, kind: 'project_fact', factKey: 'missing' }, existing, index), []);
});

test('a future confirmation time cannot raise a decay factor above one', () => {
  assert.equal(decayFactor({ confirmedAgeHours: -720 }), 1);
  assert.equal(decayFactor({ confirmedAgeHours: 0 }), 1);
  assert.ok(decayFactor({ confirmedAgeHours: 720 }) < 1);
});
