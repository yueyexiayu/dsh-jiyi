import { redactSensitiveText } from './redact.js';

export const LESSONS_EXTRACTOR_VERSION = 'jiyi-lessons-v1';

const CORRECTION = /(?:你(?:理解|听|看|做|改|写)错|这(?:个)?(?:不对|错了)|不是(?:这个|这样|让你)|我说的是|我的意思|没有(?:按|照)(?:我|要求)|\b(?:wrong|incorrect|not what I (?:asked|meant)|you misunderstood|start over)\b)/iu;
const HIGH_SIGNAL_COMMAND = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify)\b|\b(?:pytest|vitest|jest|tsc|ctest|tox|eslint|ruff)\b|\b(?:cargo|go|swift|dotnet|make|gradle|mvn)\s+(?:test|check|build|verify)\b|\bxcodebuild\b[^\n;]*\btest\b|(?:^|(?:&&|\|\||[;|])\s*)(?:\S*\/)?(?:test|check|lint|typecheck|build|verify|review|audit)(?:\s|$))/iu;
const HIGH_SIGNAL_TOOL = /^(?:bash|pwsh|powershell|shell|exec(?:ute)?|run_command)$/iu;
const textBlocks = value => {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textBlocks);
  if (typeof value !== 'object') return [];
  return [
    ...(typeof value.text === 'string' ? [value.text] : []),
    ...(Array.isArray(value.content) ? value.content.flatMap(textBlocks) : []),
  ];
};
const sourceTime = value => new Date(value ?? Date.now()).toISOString();

export function redactLessonText(value, maxChars = 4000) {
  const cleaned = redactSensitiveText(value).trim();
  return cleaned.slice(0, Math.max(1, Math.min(12000, maxChars)));
}

function commandText(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return value; }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.command === 'string') return parsed.command;
  return typeof value === 'string' ? value : '';
}

export function correctionEvidence(event, sessionId, maxChars = 4000) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return null;
  const quote = redactLessonText(textBlocks(event.data.content).join('\n'), maxChars);
  if (quote.length < 2 || !CORRECTION.test(quote)) return null;
  return { sessionId, eventId: String(event.seq), eventSeq: event.seq, eventTime: sourceTime(event.time), quote, evidence: 'user-correction' };
}

export function lessonToolCall(event) {
  if (event?.type !== 'tool/call' || typeof event.data?.callId !== 'string' || typeof event.data?.name !== 'string') return null;
  const name = event.data.name.slice(0, 160);
  const command = commandText(event.data.arguments).slice(0, 12000);
  return {
    callId: event.data.callId,
    name,
    highSignal: HIGH_SIGNAL_TOOL.test(name) && HIGH_SIGNAL_COMMAND.test(command),
    seq: event.seq,
  };
}

export function failureEvidence(event, call, sessionId, maxChars = 4000) {
  if (event?.type !== 'tool/result' || event.data?.message?.isError !== true) return null;
  const body = redactLessonText(textBlocks(event.data.message.content).join('\n'), maxChars);
  const detail = redactLessonText([event.data.error?.code, event.data.error?.reason, body].filter(Boolean).join('\n'), maxChars);
  if (detail.length < 2) return null;
  const toolName = call?.name ?? 'unknown';
  const highSignal = call?.highSignal === true || /(?:TASK_REVIEW|TEST|BUILD|LINT|TYPECHECK|VERIFY)/iu.test(String(event.data.error?.code ?? ''));
  return {
    source: { sessionId, eventId: String(event.seq), eventSeq: event.seq, eventTime: sourceTime(event.time), quote: detail, evidence: `tool-error:${toolName}` },
    signature: failureSignature(toolName, event.data.error, detail),
    toolName,
    highSignal,
  };
}

export function failureSignature(toolName, error, detail) {
  const code = String(error?.code ?? error?.name ?? '').replace(/[0-9a-f]{8,}/giu, '<id>');
  const first = String(detail ?? '')
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/giu, '<id>')
    .replace(/(?:\/Users\/[^\s:]+|\/tmp\/[^\s:]+)/gu, '<path>')
    .replace(/\b\d+\b/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 320);
  return `${String(toolName ?? 'unknown').toLowerCase()}|${code.toLowerCase()}|${first.toLowerCase()}`;
}
