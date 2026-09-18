import {
  EXTRACT_MODEL,
  EXTRACT_TIMEOUT_MS,
  EXTRACT_URL,
  EXTRACT_KEY_REF,
} from "./parse.js";
import { parseExtractOutcome } from "./capture.js";

export const EXTRACT_SYSTEM = `You extract durable memory for a coding agent.
Return ONLY JSON with this shape:
{"outcome":"noop"} or
{"outcome":"observations","observations":[{"type":"user|feedback|project|reference","topicHint":"short-slug","statement":"...","scope":"workspace|global","body":null}]}

Keep only conventions, decisions with rationale, and durable project facts that will matter in a later session.
Tool summaries are truncated: use tool names, commands, exit status, and paths; do not copy logs into memory.
Skip task state, greetings, one-off bugfixes, secrets, credentials, and anything already obvious from the repo.
User preferences that apply everywhere use scope "global"; repo-specific facts use "workspace".
Repo commands and conventions are type "project", not "feedback". Do not paraphrase a rule into extra fallbacks.
If nothing durable, outcome must be "noop".
At most 8 observations. Statements under 200 characters.`;

export async function completeChat({
  route,
  apiKey,
  system,
  user,
  maxTokens = 1024,
  timeoutMs = EXTRACT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("missing extract api key");
  const url = route?.url || EXTRACT_URL;
  const model = route?.id || EXTRACT_MODEL;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`extract HTTP ${response.status}`);
  }
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("extract empty content");
  }
  return text;
}

export async function completeGlm(options) {
  return completeChat({
    ...options,
    route: { id: EXTRACT_MODEL, url: EXTRACT_URL, keyRef: EXTRACT_KEY_REF },
  });
}

export async function firstSuccessfulComplete({
  routes,
  keys,
  parse,
  system,
  user,
  maxTokens,
  timeoutMs,
  fetchImpl,
}) {
  if (!Array.isArray(routes) || routes.length === 0) return null;
  for (const route of routes) {
    const apiKey = keys && keys[route.keyRef];
    if (!apiKey) continue;
    try {
      const text = await completeChat({
        route,
        apiKey,
        system,
        user,
        maxTokens,
        timeoutMs,
        fetchImpl,
      });
      return parse ? parse(text) : text;
    } catch {
      // try next model
    }
  }
  return null;
}

export async function extractWithPool(options) {
  const parsed = await firstSuccessfulComplete({
    ...options,
    system: EXTRACT_SYSTEM,
    user: options.transcript,
    parse: parseExtractOutcome,
    maxTokens: options.maxTokens ?? 1024,
    timeoutMs: options.timeoutMs ?? EXTRACT_TIMEOUT_MS,
  });
  return parsed || [];
}

export async function extractWithGlm(options) {
  const text = await completeGlm({
    ...options,
    system: EXTRACT_SYSTEM,
    user: options.transcript,
    maxTokens: 1024,
    timeoutMs: options.timeoutMs ?? EXTRACT_TIMEOUT_MS,
  });
  return parseExtractOutcome(text);
}
