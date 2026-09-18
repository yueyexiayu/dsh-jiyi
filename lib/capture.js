import {
  MAX_EXTRACT_OBSERVATIONS,
  MAX_TOOL_EVENTS,
  MAX_TOOL_OUTPUT_EDGE,
  MAX_TRANSCRIPT_CHARS,
} from "./parse.js";

const SKIP_SOURCES = new Set(["plugin", "agent-instructions"]);

export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n")
    .trim();
}

export function isSkippableSource(source) {
  if (!source || typeof source !== "object") return false;
  return SKIP_SOURCES.has(source.kind);
}

export function looksSecret(text) {
  return /sk-[A-Za-z0-9_-]{8,}|api[_-]?key\s*=|BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]/i.test(text);
}

export function isGreeting(text) {
  return /^(hi|hey|hello|howdy|你好|哈喽|继续|continue|ok|好的|嗯)[\s!！。]*$/i.test(String(text || "").trim());
}

const DURABLE_MARK = /不要(?:再)?(?:用|跑|改)?|别用|应该用|应当|默认|约定|以后都|always\b|never\b|prefer\b|instead of|用\s+\S+\s*，?\s*不要|测试用|位于|放在|入口是|命令是|端口|用中文|用英文|写成中文/i;

const TASK_START = /^(请)?(帮我|帮忙)?(修|改|加|做|写|实现|看看|看一下|检查|解释|分析|重构|删除|跑一下|运行|加上|实测|测试|验证|排查)/u;

export function isQuestion(text) {
  const t = String(text || "").trim();
  return /[?？]\s*$/.test(t) || /^(为什么|什么是|怎么|如何|哪|能否|可以吗)/u.test(t);
}

export function isTaskRequest(text) {
  const t = String(text || "").trim();
  return TASK_START.test(t) && !DURABLE_MARK.test(t);
}

export function shouldSkipTurn(userText) {
  const text = String(userText || "").trim();
  if (text.length < 4) return true;
  if (looksSecret(text)) return true;
  if (isGreeting(text)) return true;
  return false;
}

export function shouldSkipLlmExtract(userText) {
  const text = String(userText || "").trim();
  if (isQuestion(text) || isTaskRequest(text)) return true;
  return false;
}

export async function collectTurnNotes(events, turn, extractLlm) {
  const user = userTextsForTurn(events, turn).join("\n");
  if (shouldSkipTurn(user)) return [];
  if (shouldSkipLlmExtract(user)) {
    return extractObservations(user, assistantTextsForTurn(events, turn).join("\n"));
  }
  if (typeof extractLlm !== "function") return [];
  const remote = await extractLlm(condenseTurnTranscript(events, turn));
  return Array.isArray(remote) ? remote : [];
}

function eventTurn(event) {
  const data = event?.data;
  if (data && typeof data.turn === "number") return data.turn;
  if (data?.message && typeof data.message.turn === "number") return data.message.turn;
  return null;
}

function eventMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  if (data.message && typeof data.message === "object" && data.message.content) return data.message;
  return data;
}

export function eventsForTurn(events, turn) {
  if (!Array.isArray(events)) return [];
  if (turn == null) return events;
  let start = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.type === "turn/start" && eventTurn(events[i]) === turn) start = i;
  }
  if (start >= 0) {
    let end = events.length;
    for (let i = start + 1; i < events.length; i += 1) {
      if (events[i]?.type === "turn/start" && eventTurn(events[i]) !== turn) {
        end = i;
        break;
      }
      if (events[i]?.type === "turn/end" && eventTurn(events[i]) === turn) {
        end = i + 1;
        break;
      }
    }
    return events.slice(start, end);
  }
  return events.filter((event) => {
    const marked = eventTurn(event);
    if (marked === turn) return true;
    if (marked == null && event?.type === "user/message") return true;
    return false;
  });
}

function textsForTurn(events, turn, type) {
  const texts = [];
  for (const event of eventsForTurn(events, turn)) {
    if (event?.type !== type) continue;
    const message = eventMessage(event);
    if (type === "user/message" && isSkippableSource(message?.source || event.data?.source)) continue;
    const text = contentText(message?.content);
    if (text) texts.push(text);
  }
  return texts;
}

export function userTextsForTurn(events, turn) {
  return textsForTurn(events, turn, "user/message");
}

export function assistantTextsForTurn(events, turn) {
  return textsForTurn(events, turn, "assistant/message");
}

const TOPIC_HINTS = [
  [/test|测试|pytest|jest|vitest|cargo test|just test/i, "testing"],
  [/style|lint|格式|eslint|prettier/i, "code-style"],
  [/git|pr\b|commit|分支/i, "git"],
  [/prefer|偏好|回复|中文|英文/i, "preferences"],
];

export function topicHintFor(text) {
  for (const [pattern, topic] of TOPIC_HINTS) {
    if (pattern.test(text)) return topic;
  }
  return "notes";
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？\n])|(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
}

function uniqueStatements(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.statement;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function observation(text, type) {
  const statement = String(text || "").trim().replace(/\s+/g, " ").slice(0, 1024);
  if (statement.length < 4 || looksSecret(statement)) return null;
  return {
    type: type || (/prefer|偏好|回复/i.test(statement) ? "user" : "project"),
    topicHint: topicHintFor(statement),
    statement,
  };
}

function explicitRemember(text) {
  const found = [];
  const patterns = [
    /(?:请)?记住[:：]\s*(.+)/u,
    /remember(?:\s+that|\s+to)?[:：]?\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const item = observation(match[1], /prefer|偏好|回复/i.test(text) ? "user" : "project");
      if (item) found.push(item);
    }
  }
  return found;
}

function durableSentences(text) {
  const found = [];
  for (const sentence of splitSentences(text)) {
    if (/(?:请)?记住[:：]|remember(?:\s+that|\s+to)?[:：]?\s+/i.test(sentence)) continue;
    if (!DURABLE_MARK.test(sentence)) continue;
    if (isQuestion(sentence) && !/不要|别用|always|never|prefer/i.test(sentence)) continue;
    const item = observation(sentence);
    if (item) found.push(item);
  }
  return found;
}

export function extractObservations(userText, assistantText = "") {
  const text = String(userText || "").trim();
  if (!text || looksSecret(text)) return [];
  const found = explicitRemember(text);
  if (isGreeting(text) || isQuestion(text) || isTaskRequest(text)) {
    return uniqueStatements(found);
  }
  found.push(...durableSentences(text));
  if (found.length === 0 && DURABLE_MARK.test(text) && text.length <= 400) {
    const item = observation(text);
    if (item) found.push(item);
  }
  if (found.length === 0 && assistantText) {
    found.push(...durableSentences(String(assistantText)));
  }
  return uniqueStatements(found);
}

export function observationsFromTurn(events, turn) {
  const user = userTextsForTurn(events, turn).join("\n");
  const assistant = assistantTextsForTurn(events, turn).join("\n");
  if (shouldSkipTurn(user)) return [];
  return extractObservations(user, assistant);
}

function parseToolArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { raw: raw.slice(0, 200) };
  }
}

function commandFromArgs(name, args) {
  if (typeof args.command === "string" && args.command.trim()) return args.command.trim();
  if (typeof args.cmd === "string" && args.cmd.trim()) return args.cmd.trim();
  const path = args.path || args.file_path || args.filePath;
  if (typeof path === "string" && path) return `${name} ${path}`;
  if (typeof args.raw === "string") return args.raw;
  return name;
}

function pathsFromArgs(args) {
  const out = [];
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof args[key] === "string" && args[key]) out.push(args[key]);
  }
  if (Array.isArray(args.paths)) {
    for (const item of args.paths) {
      if (typeof item === "string" && item) out.push(item);
    }
  }
  return out.slice(0, 6);
}

function toolResultText(data) {
  const content = data?.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const parts = [];
  for (const block of blocks) {
    if (block?.type === "tool-result" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item?.type === "text" && item.text) parts.push(String(item.text));
        else if (typeof item?.text === "string") parts.push(item.text);
      }
    } else if (block?.type === "text" && block.text) {
      parts.push(String(block.text));
    }
  }
  return parts.join("\n").trim();
}

function headTail(text, edge = MAX_TOOL_OUTPUT_EDGE) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= edge * 2) return value;
  return `${value.slice(0, edge)} … ${value.slice(-edge)}`;
}

function redact(text) {
  const value = String(text || "");
  if (!looksSecret(value)) return value;
  return "[redacted]";
}

export function summarizeToolsForTurn(events, turn, maxEvents = MAX_TOOL_EVENTS) {
  if (!Array.isArray(events)) return [];
  const calls = new Map();
  const order = [];
  for (const event of eventsForTurn(events, turn)) {
    if (event?.type === "tool/call") {
      const id = event.data.callId || event.data.id;
      if (!id || calls.has(id)) continue;
      const args = parseToolArgs(event.data.arguments);
      calls.set(id, {
        id,
        name: String(event.data.name || "tool"),
        command: commandFromArgs(event.data.name || "tool", args),
        paths: pathsFromArgs(args),
        isError: false,
        output: "",
      });
      order.push(id);
    } else if (event?.type === "tool/result") {
      const block = (event.data?.message?.content || []).find((item) => item && item.type === "tool-result");
      const id = block?.toolCallId || event.data?.callId;
      if (!id) continue;
      const current = calls.get(id) || {
        id,
        name: "tool",
        command: "tool",
        paths: [],
        isError: false,
        output: "",
      };
      current.isError = block?.isError === true || Boolean(event.data?.error);
      current.output = toolResultText(event.data);
      calls.set(id, current);
      if (!order.includes(id)) order.push(id);
    }
  }
  return order.slice(0, maxEvents).map((id) => calls.get(id)).filter(Boolean);
}

export function formatToolSummaries(tools) {
  if (!tools.length) return "";
  const lines = ["Tools:"];
  for (const tool of tools) {
    const status = tool.isError ? "error" : "ok";
    const command = redact(String(tool.command || tool.name).slice(0, 240));
    lines.push(`- ${tool.name} \`${command}\` ${status}`);
    if (tool.paths.length) lines.push(`  paths: ${tool.paths.slice(0, 4).join(", ")}`);
    const output = redact(headTail(tool.output));
    if (output && output !== "[redacted]") lines.push(`  ${output}`);
  }
  return `${lines.join("\n")}\n`;
}

export function condenseTurnTranscript(events, turn, maxChars = MAX_TRANSCRIPT_CHARS) {
  const user = userTextsForTurn(events, turn).join("\n\n").trim();
  const assistant = assistantTextsForTurn(events, turn).join("\n\n").trim();
  const tools = formatToolSummaries(summarizeToolsForTurn(events, turn));
  let text = `User:\n${user || "(empty)"}\n\nAssistant:\n${assistant || "(empty)"}\n`;
  if (tools) text += `\n${tools}`;
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…\n`;
  return text;
}

const TYPES = new Set(["user", "feedback", "project", "reference"]);
const SCOPES = new Set(["global", "workspace"]);

function stripFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseExtractOutcome(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    throw new Error("malformed extraction output");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("malformed extraction output");
  if (parsed.outcome === "noop") return [];
  if (parsed.outcome !== "observations" || !Array.isArray(parsed.observations)) {
    throw new Error("malformed extraction output");
  }
  const out = [];
  for (const item of parsed.observations.slice(0, MAX_EXTRACT_OBSERVATIONS)) {
    if (!item || typeof item !== "object") continue;
    const statement = String(item.statement || "").trim().replace(/\s+/g, " ").slice(0, 1024);
    if (statement.length < 4 || looksSecret(statement)) continue;
    let type = TYPES.has(item.type) ? item.type : "project";
    if (type === "feedback" && /test|git|style|command|just |pnpm|npm /i.test(statement)) type = "project";
    const topicHint = String(item.topicHint || item.topic_hint || topicHintFor(statement)).trim() || "notes";
    const scope = SCOPES.has(item.scope) ? item.scope : type === "user" ? "global" : "workspace";
    const body = item.body == null ? undefined : String(item.body).trim().slice(0, 2048) || undefined;
    out.push({ type, topicHint, statement, scope, body });
  }
  return out;
}
