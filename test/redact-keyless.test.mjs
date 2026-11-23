import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveText } from '../lib/redact.js';

const redacted = text => redactSensitiveText(text);

test('a JWT anywhere in evidence is redacted without touching the surrounding prose', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ7dQw4w9WgXcQ7dQw4w9WgXcQ7';
  const out = redacted(`Authorization failed for token ${jwt} on retry 3`);
  assert.ok(!out.includes(jwt), 'the JWT must not survive redaction');
  assert.match(out, /\[REDACTED_JWT\]/u);
  assert.match(out, /on retry 3$/u);
});

test('cookie headers are redacted as a whole value, including set-cookie', () => {
  assert.equal(redacted('Cookie: dsh-desktop-session=abc123; theme=dark'), 'Cookie: [REDACTED]');
  assert.equal(redacted('set-cookie: a=1; b=2'), 'set-cookie: [REDACTED]');
  // A CJK value after `cookie:` is prose, not a credential (same rule as KEY_VALUE).
  assert.equal(redacted('cookie: 这个字段说明会话如何保存'), 'cookie: 这个字段说明会话如何保存');
});

test('keyless digests are redacted only on a line that also names a credential', () => {
  const md5 = 'a'.repeat(16) + '0123456789abcdef';
  const sha256 = '0123456789abcdef'.repeat(4);
  const gitSha = 'b3f1c0de5a7f4e2d9c8b1a0f3e5d7c9b2a4f6e8d';
  assert.equal(redacted(`api key ${md5}`), 'api key [REDACTED_DIGEST]');
  assert.equal(redacted(`token ${sha256}`), 'token [REDACTED_DIGEST]');
  // jiyi's own hash fields are bare 64-char hex; I3/I4 need them readable, so a digest on a
  // line with no credential word is preserved.
  assert.equal(redacted(`contentSha256 ${sha256}`), `contentSha256 ${sha256}`);
  assert.equal(redacted(`commit ${gitSha}`), `commit ${gitSha}`);
});

test('keyless opaque tokens are redacted only on a credential line, and never when they are UUIDs', () => {
  const token = 'Zk3Qm9Rt7Vx2Lp5Hn8Bc1Wd4Fg6Jk0Sa';
  const uuid = 'beefc562-5772-413c-a86c-20ef6d81a477';
  assert.equal(redacted(`token ${token}`), 'token [REDACTED_TOKEN]');
  assert.equal(redacted(`memory ${uuid}`), `memory ${uuid}`);
  assert.equal(redacted('internationalization documentation'), 'internationalization documentation');
  assert.equal(redacted('https://127.0.0.1:49740/api/jiyi?op=memories'), 'https://127.0.0.1:49740/api/jiyi?op=memories');
  // Real regression: redacting every long mixed-case identifier turned the embedding model id
  // into `[REDACTED_TOKEN]` and made the plugin report a broken embedding configuration.
  const modelId = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  assert.equal(redacted(`Local embedding model is not installed: ${modelId}`), `Local embedding model is not installed: ${modelId}`);
});

test('existing redaction behaviour is unchanged for keys, CLI flags and Chinese prose', () => {
  const key = redacted('api_key: sk-abcdef123456');
  assert.ok(!key.includes('abcdef123456'), 'the key value must not survive');
  assert.match(key, /^api_key: \[REDACTED/u);
  assert.equal(redacted('--token abcdef123456'), '--token [REDACTED]');
  assert.equal(redacted('讨论 secret: 这是一个普通中文句子'), '讨论 secret: 这是一个普通中文句子');
});