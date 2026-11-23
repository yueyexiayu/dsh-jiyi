const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gu;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/giu;
const AUTHORIZATION = /\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|digest)?\s*[^\s,;}]+/giu;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{8,}|oc_sk_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/gu;
const SENSITIVE_KEY = String.raw`(?:[A-Za-z0-9_.-]*(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret|password|passwd|secret|credentials?)[A-Za-z0-9_.-]*)`;
const KEY_VALUE = new RegExp(`((?:["']?)${SENSITIVE_KEY}(?:["']?)\\s*[:=：]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}]+)`, 'giu');
const CLI_SECRET = /(\B--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/giu;
// A JWT is three base64url segments; no other common token shape contains dots, so this
// pattern is safe and cannot swallow surrounding prose.
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const COOKIE_HEADER = /\b((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/giu;
// Keyless digests: MD5 (32) and SHA-256 (64) shapes, but only on a line that also names a
// credential. jiyi's own contentSha256 / quoteSha256 are bare 64-char hex (I3/I4 depend on them
// being readable), and a bare digest is not a credential by itself. SHA-1 (40) is never
// redacted: it is overwhelmingly a git object id in evidence and lessons.
const BARE_DIGEST = /(?<![0-9A-Za-z_-])(?:[0-9a-f]{32}|[0-9a-f]{64})(?![0-9A-Za-z_-])/gu;
const CREDENTIAL_WORD = /(?:api[-_ ]?key|access[-_ ]?key|secret|token|password|passwd|凭据|密钥|口令)/iu;
// Keyless opaque tokens: long, mixed-case, at least one digit, no dots. UUIDs are protected
// in the replacer below because memory/version ids must survive redaction. Like digests, a
// keyless token is only treated as a credential on a line that names one: `Xenova/
// paraphrase-multilingual-MiniLM-L12-v2` and other long configuration identifiers match the
// bare shape, and redacting those broke real embedding configuration messages.
const BARE_TOKEN = /(?<![0-9A-Za-z_-])(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}(?![0-9A-Za-z_-])/gu;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const replacement = value => value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : '[REDACTED]';

/** Redact credential-shaped values before evidence reaches a model or durable lesson. */
export function redactSensitiveText(value) {
  return String(value ?? '')
    .replaceAll('\u0000', '')
    .replace(PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(AUTHORIZATION, '$1[REDACTED]')
    .replace(BEARER, '$1[REDACTED]')
    .replace(KNOWN_TOKEN, '[REDACTED_TOKEN]')
    // A CJK value is prose, not a credential: "讨论 secret: 这是一个普通中文句子" used to be
  // rewritten to "讨论 secret: [REDACTED]", which corrupted ordinary memory bodies. Real keys
  // and tokens are ASCII, so keeping CJK values intact costs nothing security-wise.
  .replace(KEY_VALUE, (match, prefix, secret) => (/[\u3400-\u9fff\uf900-\ufaff]/u.test(secret) ? match : `${prefix}${replacement(secret)}`))
    .replace(CLI_SECRET, '$1[REDACTED]')
    .replace(JWT, '[REDACTED_JWT]')
    // Same CJK rule as KEY_VALUE: a Chinese value after `cookie:` is prose, not a credential.
    .replace(COOKIE_HEADER, (match, prefix, value) => (/[\u3400-\u9fff\uf900-\ufaff]/u.test(value) ? match : `${prefix}[REDACTED]`))
    // Keyless shapes need context: see the BARE_DIGEST / BARE_TOKEN comments above.
    .replace(/^.*$/gmu, line => (CREDENTIAL_WORD.test(line)
      ? line.replace(BARE_DIGEST, '[REDACTED_DIGEST]').replace(BARE_TOKEN, match => (UUID_SHAPE.test(match) ? match : '[REDACTED_TOKEN]'))
      : line));
}
