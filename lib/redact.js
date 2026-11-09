const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gu;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/giu;
const AUTHORIZATION = /\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|digest)?\s*[^\s,;}]+/giu;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/gu;
const SENSITIVE_KEY = String.raw`(?:[A-Za-z0-9_.-]*(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret|password|passwd|secret|credentials?)[A-Za-z0-9_.-]*)`;
const KEY_VALUE = new RegExp(`((?:["']?)${SENSITIVE_KEY}(?:["']?)\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}]+)`, 'giu');
const CLI_SECRET = /(\B--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/giu;

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
    .replace(KEY_VALUE, (_match, prefix, secret) => `${prefix}${replacement(secret)}`)
    .replace(CLI_SECRET, '$1[REDACTED]');
}
