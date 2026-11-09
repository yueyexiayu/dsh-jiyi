const PROVIDER_CODES = new Set(['SERVER', 'TRANSPORT', 'RATE_LIMIT', 'SERVICE_UNAVAILABLE']);
const TRANSIENT_CODES = new Set(['ABORTED', 'MODEL_DISPOSED', 'EMBEDDING_BUSY', 'RELEVANCE_COOLDOWN']);
const OUTPUT_CODES = new Set(['EXTRACTION_JSON', 'EXTRACTION_SCHEMA', 'EXTRACTION_EVIDENCE', 'REVIEW_JSON', 'REVIEW_SCHEMA', 'REVIEW_EVIDENCE', 'LESSON_JSON', 'LESSON_SCHEMA', 'RELEVANCE_JSON', 'RELEVANCE_SCHEMA', 'RELEVANCE_PROTOCOL']);
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
  else if (PROVIDER_CODES.has(code) || /\bHTTP\s*5\d\d\b|internal server error|bad gateway|service unavailable/iu.test(message)) category = 'provider_server';
  else if (TRANSIENT_CODES.has(code) || code.includes('TRANSPORT')) category = code === 'ABORTED' || code === 'MODEL_DISPOSED' ? 'service_replaced' : 'provider_transport';
  else if (OUTPUT_CODES.has(code)) category = 'model_output';
  else if (code === 'NOT_CONFIGURED' || code.includes('INVALID_') || code.endsWith('_INPUT') || code.endsWith('_INPUT_TOO_LARGE') || code.endsWith('_CONFIG')) category = 'configuration';
  else if (code.includes('CONFLICT')) category = 'review_conflict';
  else if (code === 'DISABLED' || code === 'PRIVATE_BOT' || code.startsWith('TASK_')) category = 'paused';
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
