import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { correctionEvidence } from '../lib/lessons.js';
import { mergeSettings, DEFAULT_SETTINGS } from '../lib/index.js';

// Regressions for the defects found in the 0.1.37 audit. Each test fails against that
// release and passes only with the corresponding fix.

const src = (seq, quote, extra = {}) => ({ sessionId: 's-1', eventId: String(seq), eventSeq: seq, eventTime: `2026-10-24T01:0${seq}:00.000Z`, quote, evidence: 'user-explicit', ...extra });
const fact = (content, extra = {}) => ({ content, scope: 'global', factKey: `key-${content}`, sources: [src(1, content)], ...extra });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jiyi-audit-0138-'));
  const path = join(dir, 'memory.sqlite');
  const clock = { now: '2026-10-24T01:00:00.000Z' };
  const store = openStore(path, { clock: () => clock.now });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { store, clock, path };
}

const userMessage = text => ({ type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });

test('a question that merely contains a correction word is not a user correction', () => {
  const cases = [
    ['返回里显示 wrong password，这个报错怎么处理？', false],
    ['wrong password 怎么处理', false],
    ['我把 incorrect 这个词写进日志了', false],
    ['不对齐的问题怎么解决', false],
    ['你理解错了，我用的是 pnpm 不是 npm', true],
    ['我说的是中文输出，不是英文', true],
    ['不对，应该用 npm', true],
    ['wrong, use pnpm instead', true],
    ["That's not what I asked.", true],
    ['start over', true],
  ];
  for (const [text, expected] of cases) {
    assert.equal(correctionEvidence(userMessage(text), 's') !== null, expected, text);
  }
});

test('an ordinary update does not clear pending isolation or dismiss the conflict group', t => {
  const { store } = fixture(t);
  const target = store.putMemory(fact('日志过滤用 grep'));
  store.stageMemoryCandidate({ memory: fact('日志过滤用 awk', { sources: [src(2, '日志过滤用 awk')], factKey: `key-日志过滤用 grep` }), conflictMemoryIds: [target.id], expectedMemberVersions: {} });
  const pendingBefore = store.getMemory(target.id, { includeInactive: false });
  assert.equal(pendingBefore.reviewState, 'pending');
  assert.equal(store.hasOpenConflict(target.id), true);

  // An ordinary rewrite is refused outright: allowing it would either clear the isolation or
  // leave the open group pointing at a version that no longer exists.
  assert.throws(
    () => store.putMemory({ ...pendingBefore, expectedVersion: pendingBefore.version, content: '日志过滤用 ripgrep', sources: [src(3, '日志过滤用 ripgrep')] }),
    err => err.code === 'CONFLICT_REVIEW_OPEN');

  const after = store.getMemory(target.id, { includeInactive: false });
  assert.equal(after.content, '日志过滤用 grep', 'the refused write must not change the memory');
  assert.equal(after.reviewState, 'pending', 'review_state must stay pending while a group is open');
  assert.equal(store.hasOpenConflict(target.id), true, 'the conflict group must survive an ordinary rewrite');
  assert.equal(store.listMemories({ recallOnly: true, limit: 100 }).some(m => m.id === target.id), false, 'an undecided memory must not become recallable');

  // A clear user correction is allowed to settle it.
  store.putMemory({ ...pendingBefore, expectedVersion: pendingBefore.version, content: '日志过滤用 rg ' + 'x'.repeat(4), sources: [src(4, '日志过滤用 rg', { evidence: 'user-correction' })] });
  assert.equal(store.getMemory(target.id, { includeInactive: false }).reviewState, 'clear');
  assert.equal(store.hasOpenConflict(target.id), false);
});

test('changing a factKey to one already in use never silently supersedes the other memory', t => {
  const { store } = fixture(t);
  const a = store.putMemory(fact('部署端口是 8080'));
  const b = store.putMemory(fact('部署入口是 /api', { factKey: 'key-b' }));

  assert.throws(
    () => store.putMemory({ ...b, expectedVersion: b.version, factKey: a.factKey, content: '部署端口是 9090', sources: [src(4, '部署端口是 9090')] }),
    /Conflicting active fact/, 'an update that collides on factKey must fail instead of retiring memory A');

  const stillA = store.getMemory(a.id, { includeInactive: false });
  assert.equal(stillA.status, 'active', 'memory A must remain active');
  assert.equal(store.getMemory(b.id, { includeInactive: false }).factKey, 'key-b', 'memory B must be unchanged');
});

test('manual correction of a pending memory leaves no orphan pending state', t => {
  const { store } = fixture(t);
  const target = store.putMemory(fact('包管理器用 npm'));
  store.stageMemoryCandidate({ memory: fact('包管理器用 yarn', { sources: [src(2, '包管理器用 yarn')], factKey: 'key-包管理器用 npm' }), conflictMemoryIds: [target.id], expectedMemberVersions: {} });
  assert.equal(store.getMemory(target.id, { includeInactive: false }).reviewState, 'pending');

  const { reviewState: _ignored, ...editable } = store.getMemory(target.id, { includeInactive: false });
  store.replaceMemory(target.id, { ...editable, content: '包管理器用 pnpm', sources: [src(5, '包管理器用 pnpm')] }, { expectedVersion: editable.version, resolveConflicts: true });

  const after = store.getMemory(target.id, { includeInactive: false });
  assert.equal(store.hasOpenConflict(target.id), false, 'an explicit correction settles the group');
  assert.equal(after.reviewState, 'clear', 'a settled memory must not stay pending');
});

test('a settled conflict group cannot be reopened by a late worker release', t => {
  const { store } = fixture(t);
  const target = store.putMemory(fact('报告用中文'));
  const staged = store.stageMemoryCandidate({ memory: fact('报告用英文', { sources: [src(2, '报告用英文')], factKey: 'key-报告用中文' }), conflictMemoryIds: [target.id], expectedMemberVersions: {}, route: { provider: 'p', model: 'm' } });
  store.resolveConflict({ groupId: staged.group.id, decision: 'unresolved' });
  store.resolveConflict({ groupId: staged.group.id, candidateId: staged.candidateId, decision: 'same_claim_newer' });

  const settled = store.getConflictGroup(staged.group.id);
  assert.equal(settled.state, 'resolved');
  assert.throws(() => store.releaseConflictGroup(staged.group.id, new Error('late failure')), err => err.code === 'CONFLICT_STALE');
  assert.equal(store.getConflictGroup(staged.group.id).state, 'resolved', 'a settled group must stay settled');
});

test('an exhausted conflict group stays isolated and says so instead of looping silently', t => {
  const { store, clock } = fixture(t);
  const target = store.putMemory(fact('端口绑定在 8080'));
  const staged = store.stageMemoryCandidate({ memory: fact('端口绑定在 9090', { sources: [src(2, '端口绑定在 9090')], factKey: 'key-端口绑定在 8080' }), conflictMemoryIds: [target.id], expectedMemberVersions: {}, route: { provider: 'p', model: 'm' } });

  for (let attempt = 0; attempt < 4; attempt++) {
    const claimed = store.claimConflictGroups({ limit: 1, leaseMs: 1000 });
    if (!claimed.length) break;
    clock.now = new Date(Date.parse(clock.now) + 5000).toISOString();
  }

  const group = store.getConflictGroup(staged.group.id);
  assert.equal(group.state, 'open', 'isolation is expressed by staying open');
  assert.match(String(group.lastError), /已用尽/, 'the exhausted state must be visible');
  assert.equal(store.claimConflictGroups({ limit: 1, leaseMs: 1000 }).length, 0, 'an exhausted group is not claimed again');
  assert.equal(store.getMemory(target.id, { includeInactive: false }).reviewState, 'pending', 'the memory stays isolated from recall');
});

test('a settings patch merges into the current settings instead of resetting other sections', () => {
  const current = { ...structuredClone(DEFAULT_SETTINGS), adjudication: { ...DEFAULT_SETTINGS.adjudication, minConfidence: 0.95 } };
  const merged = mergeSettings(current, { retrieval: { timeoutMs: 5 } });
  assert.equal(merged.retrieval.timeoutMs, 5);
  assert.equal(merged.retrieval.maxMemories, current.retrieval.maxMemories, 'untouched keys in the same section must survive');
  assert.equal(merged.adjudication.minConfidence, 0.95, 'untouched sections must survive');
  assert.equal(merged.extraction.model, current.extraction.model);
});
