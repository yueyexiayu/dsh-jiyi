import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, retryDelayMs } from '../lib/retry.js';
import { findSemanticConflicts, parseReview, parseLessonReview } from '../lib/review.js';

// Regressions for the P1 defects found in the 0.1.37 audit.

const withCode = code => Object.assign(new Error('boom'), { code });

test('4xx and authentication failures are configuration errors, not retryable outages', () => {
  for (const code of ['http400', 'auth401', 'http403', 'http404', 'quota402', 'HTTP_401']) {
    const failure = classifyFailure(withCode(code));
    assert.equal(failure.category, 'configuration', code);
    assert.equal(failure.retryable, false, code);
    assert.equal(retryDelayMs(failure, 1), 0, code);
  }
});

test('429 stays a back-off signal and 5xx is recognised from the error code too', () => {
  const busy = classifyFailure(withCode('429'));
  assert.equal(busy.category, 'provider_busy');
  assert.equal(busy.retryable, true);

  for (const code of ['http500', 'http503', 'HTTP_502']) {
    const failure = classifyFailure(withCode(code));
    assert.equal(failure.category, 'provider_server', code);
    assert.equal(failure.retryable, true, code);
  }
});

test('preference conflicts are caught by factKey, not by lexical similarity', () => {
  // A lexical rule cannot separate a value swap from two unrelated preferences, because both
  // look the same at token level in Chinese. The safe contract is: same factKey -> conflict,
  // different factKey -> no automatic conflict (the user corrects it instead). See D9.
  const sameKey = [{ id: 'm1', version: 1, content: '依赖统一用 npm 安装', scope: 'global', projectId: null, kind: 'preference', factKey: 'pkg-manager', status: 'active', sources: [] }];
  const conflicts = findSemanticConflicts({ content: '依赖统一用 yarn 安装', scope: 'global', projectId: null, kind: 'preference', factKey: 'pkg-manager' }, sameKey);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reasonCode, 'fact_key_conflict');

  const restated = findSemanticConflicts({ content: '依赖统一用 yarn 安装', scope: 'global', projectId: null, kind: 'preference', factKey: 'other' }, sameKey);
  assert.deepEqual(restated, [], 'a different factKey is not auto-flagged; false positives would isolate healthy memories');

  const unrelated = [{ id: 'm2', version: 1, content: '报告用中文输出', scope: 'global', projectId: null, kind: 'preference', factKey: 'k2', status: 'active', sources: [] }];
  assert.deepEqual(findSemanticConflicts({ content: '部署端口用 8080', scope: 'global', projectId: null, kind: 'preference', factKey: 'k3' }, unrelated), []);
});

test('a skipped protected memory is reported instead of pretending success', () => {
  const quote = '我的偏好是中文。';
  const source = { sessionId: 's', eventSeq: 1, eventTime: '2026-10-24T01:00:00.000Z', quote };
  const protectedTarget = { id: 'm1', version: 1, content: '手工创建的事实', scope: 'global', projectId: null, kind: 'project_fact', factKey: 'k1', status: 'active', userControlled: true, sources: [{ ...source, origin: 'manual' }] };
  const payload = { sessionId: 's', projectId: null, sources: [source], existing: [protectedTarget] };
  const parsed = parseReview(JSON.stringify({ operations: [{ type: 'forget', memoryId: 'm1', sourceSeqs: [1], quotes: [quote] }] }), payload, [protectedTarget]);
  assert.equal(parsed.forget.length, 0, 'the protected memory is not deleted');
  assert.deepEqual(parsed.skippedProtected, [{ memoryId: 'm1', operation: 'forget' }], 'the skip must be visible');
});

test('a lesson that omits scope is accepted with the documented project default', () => {
  const quote = '验证失败因为没跑测试';
  const source = { eventSeq: 1, eventTime: '2026-10-24T01:00:00.000Z', sessionId: 's', quote };
  const payload = { sessionId: 's', projectId: 'project-1', sources: [source] };
  const lesson = { content: '验证前必须先跑测试', factKey: 'verify-first', confidence: 0.8, sourceSeqs: [1], quotes: [quote] };
  const memories = parseLessonReview(JSON.stringify({ lessons: [lesson] }), payload, []);
  assert.equal(memories.length, 1, 'omitting scope must not fail the batch');
  assert.equal(memories[0].scope, 'project');
  assert.equal(memories[0].type, 'lesson');
});
