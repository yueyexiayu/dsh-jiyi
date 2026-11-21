const PROVIDER_CODES = new Set(['SERVER', 'TRANSPORT', 'RATE_LIMIT', 'SERVICE_UNAVAILABLE']);
const TRANSIENT_CODES = new Set(['ABORTED', 'MODEL_DISPOSED', 'EMBEDDING_BUSY', 'RELEVANCE_COOLDOWN']);
const OUTPUT_CODES = new Set(['EXTRACTION_JSON', 'EXTRACTION_SCHEMA', 'EXTRACTION_EVIDENCE', 'REVIEW_JSON', 'REVIEW_SCHEMA', 'REVIEW_EVIDENCE', 'LESSON_JSON', 'LESSON_SCHEMA', 'RELEVANCE_JSON', 'RELEVANCE_SCHEMA', 'RELEVANCE_PROTOCOL']);
const CLIENT_CODES = new Set(['UNAUTHORIZED','UNAUTHENTICATED','FORBIDDEN','PERMISSION_DENIED','ACCESS_DENIED','BAD_REQUEST','INVALID_REQUEST','NOT_FOUND','MODEL_NOT_FOUND','NO_SUCH_MODEL','PAYMENT_REQUIRED','INSUFFICIENT_QUOTA','QUOTA_EXCEEDED']);

// A 4xx other than 429 means the request itself is wrong: a bad key, a misspelled model
// or an unpaid account. Retrying spends the whole attempt budget on a configuration
// mistake and reports it as a temporary outage, so the user never learns what to fix.
function clientStatus(code, message) {
  const fromCode = /(?:^|[^0-9])(4\d\d)(?:[^0-9]|$)/u.exec(code)?.[1] ?? null;
  const fromMessage = /(?:http|status)[ _-]?(4\d\d)\b/iu.exec(message)?.[1] ?? null;
  const status = fromCode ?? fromMessage;
  return status && status !== '429' ? status : null;
}

const CODE_ALIASES = {
  PROVIDER_TIMEOUT: 'provider_timeout',
  PROVIDER_SERVER: 'provider_server',
  PROVIDER_BUSY: 'provider_busy',
  PROVIDER_TRANSPORT: 'provider_transport',
};

const upper = value => String(value ?? '').toUpperCase();
const requestId = message => /\brequest[_ ]?id\s*[:=]\s*([A-Za-z0-9._:-]+)/iu.exec(message)?.[1] ?? null;

export function classifyFailure(error, { stage = null } = {}) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const message = String(error?.message ?? error ?? '');
  let category = 'unknown';
  if (code === 'RELEVANCE_COOLDOWN') category = 'cooldown';
  else if (code.includes('TIMEOUT') || /\b(?:timeout|timed out)\b|超时/iu.test(message)) category = 'provider_timeout';
  else if (/\b429\b|rate.?limit|too many requests/iu.test(`${code} ${message}`)) category = 'provider_busy';
  else if (/service is too busy|overloaded|temporarily unavailable|capacity/iu.test(message)) category = 'provider_busy';
  // The 5xx pattern used to be tested against the message only, so a provider that puts the
  // status in the error code ("HTTP503") was classified as an unknown failure.
  else if (PROVIDER_CODES.has(code) || /HTTP\s*[ _-]?\s*5\d\d|internal server error|bad gateway|service unavailable/iu.test(`${code} ${message}`)) category = 'provider_server';
  else if (clientStatus(code, message) || CLIENT_CODES.has(code)) category = 'configuration';
  else if (TRANSIENT_CODES.has(code) || code.includes('TRANSPORT')) category = code === 'ABORTED' || code === 'MODEL_DISPOSED' ? 'service_replaced' : 'provider_transport';
  else if (OUTPUT_CODES.has(code)) category = 'model_output';
  else if (code === 'NOT_CONFIGURED' || code.includes('INVALID_') || code.endsWith('_INPUT') || code.endsWith('_INPUT_TOO_LARGE') || code.endsWith('_CONFIG')) category = 'configuration';
  else if (code.includes('CONFLICT')) category = 'review_conflict';
  else if (code === 'DISABLED' || code.startsWith('TASK_')) category = 'paused';
  if (CODE_ALIASES[code]) category = CODE_ALIASES[code];
  const retryable = ['provider_timeout', 'provider_busy', 'provider_server', 'provider_transport', 'service_replaced', 'model_output', 'review_conflict', 'unknown'].includes(category);
  return {
    code: code || 'UNKNOWN',
    category,
    retryable,
    stage,
    message: message.slice(0, 2000),
    requestId: requestId(message),
    at: new Date().toISOString(),
  };
}

export function retryDelayMs(failure, attempt, { random = Math.random } = {}) {
  if (!failure?.retryable) return 0;
  const exponent = Math.max(0, Number.isInteger(attempt) ? attempt - 1 : 0);
  const base = ['model_output', 'review_conflict'].includes(failure.category) ? 5000 : ['provider_busy', 'provider_server', 'provider_timeout', 'provider_transport'].includes(failure.category) ? 30000 : 10000;
  const bounded = Math.min(15 * 60 * 1000, base * 2 ** exponent);
  const jitter = Math.floor(bounded * 0.2 * Math.max(0, Math.min(1, random())));
  return bounded + jitter;
}

export function providerCooldownMs(failure, streak) {
  if (!failure?.retryable || !['provider_timeout', 'provider_busy', 'provider_server', 'provider_transport'].includes(failure.category)) return 0;
  return Math.min(5 * 60 * 1000, 30000 * 2 ** Math.max(0, Number(streak) - 1));
}
