import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import {
  DREAM_TIMEOUT_MS,
  MAX_DREAM_TOPICS,
  MAX_TOPIC_BYTES,
  slugify,
} from "./parse.js";
import { completeGlm, firstSuccessfulComplete } from "./extract.js";
import { listMd, pruneArchive, regenerateManifest } from "./storage.js";

export const DREAM_SYSTEM = `You consolidate durable coding-agent memory.
Return ONLY JSON:
{"topics":[{"slug":"testing","content":"# Testing\\n\\n..."}],"rename":[{"from":"notes","to":"testing"}],"delete":["obsolete"]}

Copy facts from observations and existing topics. Do not invent.
Never add fallbacks, alternatives, "if unavailable", "otherwise", extra commands, or policy the observations did not state.
If the observation is "use just test, not cargo test", do not say to fall back to cargo test.
Prefer the observation statement almost verbatim as a bullet.
Merge duplicates, update outdated facts, split mixed topics, rename slugs when the subject changed.
Do not keep secrets, task status, or one-off bug chatter.
Each content MUST start with a markdown H1. Keep each topic under 4000 characters.
"topics" is the full new text for created or updated files. Unmentioned topics stay unless listed in rename or delete.
"rename" moves an existing slug. "delete" removes a leftover after its facts were merged or split into another topic. Never delete the only copy of a fact.
If observations add nothing new, return {"topics":[],"rename":[],"delete":[]}.`;

export function parseObservation(text) {
  const raw = String(text || "");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = (fm ? fm[2] : raw).trim();
  const meta = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  const statement = body.split(/\n\n/)[0]?.trim() || body;
  return {
    type: meta.type || "project",
    topicHint: meta.topic || "notes",
    created: meta.created || "",
    statement,
    body,
  };
}

function topicHeading(slug) {
  if (slug === "notes") return "Notes";
  if (slug === "preferences") return "Preferences";
  if (slug === "testing") return "Testing";
  if (slug === "code-style") return "Code style";
  if (slug === "git") return "Git";
  return slug.replace(/-/g, " ");
}

export function mergeIntoTopic(existing, observation) {
  const stamp = (observation.created || "").slice(0, 10);
  const line = stamp ? `- ${stamp}: ${observation.statement}` : `- ${observation.statement}`;
  if (existing && existing.includes(observation.statement)) return existing;
  if (!existing || !existing.trim()) {
    const title = topicHeading(slugify(observation.topicHint || "notes"));
    return `# ${title}\n\n${line}\n`;
  }
  const trimmed = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${trimmed}\n${line}\n`;
}

function clip(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…\n`;
}

export function buildDreamUser({ inbox, topics }) {
  const parts = ["# Existing topics", ""];
  if (!topics.length) parts.push("(none)", "");
  for (const topic of topics) {
    parts.push(`## ${topic.name}`, clip(topic.text, 6000), "");
  }
  parts.push("# New observations", "");
  if (!inbox.length) parts.push("(none)", "");
  for (const item of inbox) {
    parts.push(`## ${item.name}`, clip(item.text, 2000), "");
  }
  return parts.join("\n");
}

function parseJsonObject(raw) {
  const trimmed = String(raw || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = fenced ? fenced[1].trim() : trimmed;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("malformed dream output");
  }
  return parsed;
}

export function parseDreamPlan(raw) {
  const parsed = parseJsonObject(raw);
  const list = Array.isArray(parsed.topics) ? parsed.topics : [];
  const topics = [];
  for (const item of list.slice(0, MAX_DREAM_TOPICS)) {
    if (!item || typeof item !== "object") continue;
    const slug = slugify(item.slug || "");
    const content = String(item.content || "").trim();
    if (!content.startsWith("#")) continue;
    if (Buffer.byteLength(content, "utf8") > MAX_TOPIC_BYTES) continue;
    topics.push({ slug, content: sanitizeTopicContent(content.endsWith("\n") ? content : `${content}\n`) });
  }
  const rename = [];
  for (const item of Array.isArray(parsed.rename) ? parsed.rename : []) {
    if (!item || typeof item !== "object") continue;
    const from = slugify(item.from || "");
    const to = slugify(item.to || "");
    if (!from || !to || from === to) continue;
    rename.push({ from, to });
  }
  const seenDelete = new Set();
  const deleteSlugs = [];
  for (const item of Array.isArray(parsed.delete) ? parsed.delete : []) {
    const slug = slugify(item);
    if (!slug || seenDelete.has(slug)) continue;
    seenDelete.add(slug);
    deleteSlugs.push(slug);
  }
  return { topics, rename, delete: deleteSlugs };
}

export function dreamPlanIsEmpty(plan) {
  return !plan.topics.length && !plan.rename.length && !plan.delete.length;
}

function topicPath(topicsDir, slug) {
  return nodePath.join(topicsDir, `${slugify(slug)}.md`);
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function applyDreamPlan(topicsDir, plan) {
  await fs.mkdir(topicsDir, { recursive: true });
  const written = new Set(plan.topics.map((topic) => topic.slug));
  for (const topic of plan.topics) {
    await fs.writeFile(topicPath(topicsDir, topic.slug), topic.content, "utf8");
  }
  const renamed = [];
  for (const item of plan.rename) {
    const fromPath = topicPath(topicsDir, item.from);
    const toPath = topicPath(topicsDir, item.to);
    if (written.has(item.from)) continue;
    if (!(await pathExists(fromPath))) continue;
    if (await pathExists(toPath)) {
      if (!written.has(item.to)) continue;
      await fs.unlink(fromPath);
      renamed.push(item.to);
      continue;
    }
    await fs.rename(fromPath, toPath);
    renamed.push(item.to);
  }
  const deleted = [];
  for (const slug of plan.delete) {
    if (written.has(slug)) continue;
    const filePath = topicPath(topicsDir, slug);
    if (!(await pathExists(filePath))) continue;
    await fs.unlink(filePath);
    deleted.push(slug);
  }
  return { written: [...written], renamed, deleted };
}

async function loadMarkdownDir(dir, prefix) {
  const files = await listMd(dir, prefix);
  const out = [];
  for (const file of files) {
    out.push({
      ...file,
      text: await fs.readFile(file.path, "utf8"),
    });
  }
  return out;
}

const INVENTED = /fall back|if unavailable|otherwise use|如果.{0,12}失败.{0,12}则|备选命令/i;

export function sanitizeTopicContent(content) {
  const lines = String(content || "").split(/\r?\n/);
  const kept = lines.filter((line) => !INVENTED.test(line));
  const text = kept.join("\n").trim();
  if (!text) return "# Notes\n";
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function archiveInbox(inbox, archiveDir) {
  await fs.mkdir(archiveDir, { recursive: true });
  for (const file of inbox) {
    await fs.rename(file.path, nodePath.join(archiveDir, file.name));
  }
  await pruneArchive(archiveDir);
}

async function dreamScopeRules(scopeDir, inbox) {
  const archiveDir = nodePath.join(scopeDir, "archive");
  const topicsDir = nodePath.join(scopeDir, "topics");
  let merged = 0;
  const topics = new Set();
  for (const file of inbox) {
    const text = await fs.readFile(file.path, "utf8");
    const observation = parseObservation(text);
    const slug = slugify(observation.topicHint || "notes");
    const topicPath = nodePath.join(topicsDir, `${slug}.md`);
    let previous = "";
    try {
      previous = await fs.readFile(topicPath, "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    const next = mergeIntoTopic(previous, observation);
    if (Buffer.byteLength(next, "utf8") > MAX_TOPIC_BYTES) continue;
    await fs.mkdir(topicsDir, { recursive: true });
    await fs.writeFile(topicPath, next, "utf8");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.rename(file.path, nodePath.join(archiveDir, file.name));
    merged += 1;
    topics.add(slug);
  }
  await regenerateManifest(scopeDir);
  return { merged, topics: [...topics], remaining: inbox.length - merged, via: "rules" };
}

export async function dreamScope(scopeDir, options = {}) {
  const inboxDir = nodePath.join(scopeDir, "observations", "_inbox");
  const archiveDir = nodePath.join(scopeDir, "archive");
  const topicsDir = nodePath.join(scopeDir, "topics");
  const inbox = await loadMarkdownDir(inboxDir, "observations/_inbox");
  if (inbox.length === 0) {
    await regenerateManifest(scopeDir);
    return { merged: 0, topics: [], remaining: 0, via: "noop" };
  }

  const topics = await loadMarkdownDir(topicsDir, "topics");
  const user = buildDreamUser({ inbox, topics });
  const llmOptions = {
    system: DREAM_SYSTEM,
    user,
    maxTokens: 4096,
    timeoutMs: options.timeoutMs ?? DREAM_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  };

  let plan = null;
  if (Array.isArray(options.routes)) {
    plan = await firstSuccessfulComplete({
      ...llmOptions,
      routes: options.routes,
      keys: options.keys || {},
      parse: parseDreamPlan,
    });
    if (!plan) {
      await regenerateManifest(scopeDir);
      return { merged: 0, topics: [], remaining: inbox.length, via: "failed" };
    }
    if (dreamPlanIsEmpty(plan)) {
      await archiveInbox(inbox, archiveDir);
      await regenerateManifest(scopeDir);
      return { merged: inbox.length, topics: [], remaining: 0, via: "noop" };
    }
  } else if (options.apiKey) {
    try {
      const raw = await completeGlm({ ...llmOptions, apiKey: options.apiKey });
      plan = parseDreamPlan(raw);
    } catch {
      plan = null;
    }
    if (!plan || dreamPlanIsEmpty(plan)) {
      return dreamScopeRules(scopeDir, inbox);
    }
  } else {
    return dreamScopeRules(scopeDir, inbox);
  }

  const applied = await applyDreamPlan(topicsDir, plan);
  await archiveInbox(inbox, archiveDir);
  await regenerateManifest(scopeDir);
  return {
    merged: inbox.length,
    topics: applied.written.length ? applied.written : applied.renamed,
    remaining: 0,
    via: "llm",
    renamed: applied.renamed,
    deleted: applied.deleted,
  };
}

export async function dreamAll(globalDir, workspaceDir, options = {}) {
  const global = await dreamScope(globalDir, options);
  const workspace = workspaceDir
    ? await dreamScope(workspaceDir, options)
    : { merged: 0, topics: [], remaining: 0, via: "noop" };
  return {
    merged: global.merged + workspace.merged,
    topics: [...new Set([...global.topics, ...workspace.topics])],
    remaining: global.remaining + workspace.remaining,
    via: global.via === "llm" || workspace.via === "llm" ? "llm" : workspace.via || global.via,
  };
}
