import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, RECALL_LEDGER_MAX_ROWS } from '../lib/store.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jiyi-bounds-test-'));
  let time = '2026-01-01T00:00:00.000Z';
  let store = openStore(join(dir, 'memory.sqlite'), { clock: () => time });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, setTime(value) { time = value; } };
}

test('the recall ledger keeps only the newest RECALL_LEDGER_MAX_ROWS rows', t => {
  const f = fixture(t), s = f.store;
  const total = RECALL_LEDGER_MAX_ROWS + 120;
  for (let i = 0; i < total; i++) {
    f.setTime(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
    s.recordRecall({ sessionId: 'session-bounds', requestId: `req-${i}`, status: 'empty', details: { index: i } });
  }
  assert.equal(s.getRecallStats().total, RECALL_LEDGER_MAX_ROWS);
  assert.equal(s.listRecalls({ limit: 1 })[0].requestId, `req-${total - 1}`, 'the newest recall always survives');
  const oldest = s.listRecalls({ limit: RECALL_LEDGER_MAX_ROWS })[RECALL_LEDGER_MAX_ROWS - 1];
  assert.equal(oldest.requestId, 'req-120', 'only the oldest rows are dropped');
});

test('pruning also removes dependent feedback rows, which reference the ledger without cascade', t => {
  const f = fixture(t), s = f.store;
  const source = { sessionId: 'session-feedback', eventId: '7', eventSeq: 7, eventTime: '2026-01-01T00:00:00.000Z', quote: '我长期偏好中文回复。', evidence: '我长期偏好中文回复。' };
  const memory = s.putMemory({ content: '我长期偏好中文回复。', scope: 'global', sources: [source] });
  f.setTime('2026-01-01T00:00:05.000Z');
  const recall = s.recordRecall({ sessionId: 'session-feedback', requestId: 'req-feedback', status: 'injected', memories: [memory] });
  s.recordRecallFeedback({ recallId: recall.id, requestId: recall.requestId, memoryId: memory.id, memoryVersion: memory.version, kind: 'explicit_useful' });
  f.setTime('2026-01-01T00:00:10.000Z');
  const pruned = s.pruneHistory({ ledgerMaxRows: 0, queueMaxRows: 10 });
  assert.equal(pruned.ledger, 1);
  assert.equal(s.getRecallStats().total, 0);
  assert.deepEqual(s.listRecallFeedback({ recallId: recall.id }), []);
});

test('done queue history is trimmed while failed jobs stay retryable', t => {
  const f = fixture(t), s = f.store;
  const project = s.resolveProject({ path: '/tmp/jiyi-bounds-project' });
  for (let i = 0; i < 5; i++) {
    f.setTime(new Date(Date.UTC(2026, 0, 1, 0, 1, i)).toISOString());
    s.enqueueEvent({ sessionId: 'session-queue', eventId: `turn-end:${i}`, eventSeq: i, eventTime: '2026-01-01T00:01:00.000Z', projectId: project.id, payload: { kind: 'extraction', sessionId: 'session-queue', projectId: project.id, projectNames: [project.name], sources: [] } });
  }
  const jobs = s.claimJobs({ limit: 5 });
  assert.equal(jobs.length, 5);
  for (const job of jobs.slice(0, 4)) s.completeJob(job.id, job.token, { memories: [] });
  s.failJob(jobs[4].id, jobs[4].token, new Error('fixture failure'), { terminal: true });
  const pruned = s.pruneHistory({ ledgerMaxRows: 10, queueMaxRows: 2 });
  assert.equal(pruned.queue, 2);
  const counts = s.getStatus().queue;
  assert.equal(counts.done, 2);
  assert.equal(counts.failed, 1);
});