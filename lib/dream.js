import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import {
  DREAM_TIMEOUT_MS,
  MAX_DREAM_TOPICS,
  MAX_TOPIC_BYTES,
  slugify,
} from "./parse.js";
import { completeGlm, firstSuccessfulComplete } from "./extract.js";
import { listMd, listWorkspaceScopeDirs, pruneArchive, regenerateManifest } from "./storage.js";

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

export function parseDreamPlan(raw, sources = []) {
  const parsed = parseJsonObject(raw);
  if (!Array.isArray(parsed.topics)) throw new Error("malformed dream output");
  if (parsed.rename != null && !Array.isArray(parsed.rename)) throw new Error("malformed dream output");
  if (parsed.delete != null && !Array.isArray(parsed.delete)) throw new Error("malformed dream output");
  const list = parsed.topics;
  const topics = [];
  for (const item of list.slice(0, MAX_DREAM_TOPICS)) {
    if (!item || typeof item !== "object") continue;
    const slug = slugify(item.slug || "");
    const content = String(item.content || "").trim();
    if (!content.startsWith("#")) continue;
    if (Buffer.byteLength(content, "utf8") > MAX_TOPIC_BYTES) continue;
    topics.push({
      slug,
      content: sanitizeTopicContent(content.endsWith("\n") ? content : `${content}\n`, sources),
    });
  }
  if (list.length > 0 && topics.length === 0) throw new Error("malformed dream output");
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

async function loadMarkdownDir(dir, prefix, scopeDir) {
  const files = await listMd(dir, prefix, scopeDir);
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

function lineCore(line) {
  return String(line || "").replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim();
}

function sourceAllowsLine(line, sourceText) {
  const core = lineCore(line);
  if (!core) return false;
  if (sourceText.includes(core)) return true;
  return sourceText.split(/\r?\n/).some((src) => {
    const srcCore = lineCore(src);
    return srcCore && (srcCore.includes(core) || core.includes(srcCore));
  });
}

function stripDeletedObservations(content, missingTexts, keepTexts) {
  const missingSrc = (missingTexts || []).join("\n");
  const keepSrc = (keepTexts || []).join("\n");
  if (!missingSrc.trim()) return content;
  const kept = String(content || "").split(/\r?\n/).filter((line) => {
    if (/^\s*#/.test(line) || !line.trim()) return true;
    if (sourceAllowsLine(line, missingSrc) && !sourceAllowsLine(line, keepSrc)) return false;
    return true;
  });
  const text = kept.join("\n").trim();
  if (!text) return "# Notes\n";
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function sanitizeTopicContent(content, sources = []) {
  const sourceText = Array.isArray(sources) ? sources.join("\n") : String(sources || "");
  const lines = String(content || "").split(/\r?\n/);
  const kept = lines.filter((line) => !INVENTED.test(line) || sourceAllowsLine(line, sourceText));
  const text = kept.join("\n").trim();
  if (!text) return "# Notes\n";
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function archiveInbox(inbox, archiveDir, scopeDir) {
  await fs.mkdir(archiveDir, { recursive: true });
  for (const file of inbox) {
    try {
      await fs.rename(file.path, nodePath.join(archiveDir, file.name));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  await pruneArchive(archiveDir, undefined, scopeDir);
}

async function dreamScopeRules(scopeDir, inbox) {
  const archiveDir = nodePath.join(scopeDir, "archive");
  const topicsDir = nodePath.join(scopeDir, "topics");
  let merged = 0;
  const topics = new Set();
  for (const file of inbox) {
    let text;
    try {
      text = await fs.readFile(file.path, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    const observation = parseObservation(text);
    const slug = slugify(observation.topicHint || "notes");
    const topicFile = nodePath.join(topicsDir, `${slug}.md`);
    let previous = "";
    try {
      previous = await fs.readFile(topicFile, "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    const next = mergeIntoTopic(previous, observation);
    if (Buffer.byteLength(next, "utf8") > MAX_TOPIC_BYTES) continue;
    await fs.mkdir(topicsDir, { recursive: true });
    await fs.writeFile(topicFile, next, "utf8");
    await fs.mkdir(archiveDir, { recursive: true });
    try {
      await fs.rename(file.path, nodePath.join(archiveDir, file.name));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    merged += 1;
    topics.add(slug);
  }
  await regenerateManifest(scopeDir);
  return { merged, topics: [...topics], remaining: inbox.length - merged, via: "rules" };
}

async function scopeStamp(scopeDir) {
  const topics = await listMd(nodePath.join(scopeDir, "topics"), "topics", scopeDir);
  const inbox = await listMd(nodePath.join(scopeDir, "observations", "_inbox"), "observations/_inbox", scopeDir);
  return [
    ...inbox.map((file) => `i:${file.name}:${file.mtimeMs}`),
    ...topics.map((file) => `t:${file.name}:${file.mtimeMs}`),
  ].sort().join("|");
}

function filterStalePlan(plan, ignoreSlugs) {
  const deleted = new Set(ignoreSlugs || []);
  return {
    topics: plan.topics.filter((topic) => !deleted.has(topic.slug)),
    rename: plan.rename.filter((item) => !deleted.has(item.from) && !deleted.has(item.to)),
    delete: plan.delete.filter((slug) => !deleted.has(slug)),
  };
}

export async function dreamScope(scopeDir, options = {}) {
  const inboxDir = nodePath.join(scopeDir, "observations", "_inbox");
  const archiveDir = nodePath.join(scopeDir, "archive");
  const topicsDir = nodePath.join(scopeDir, "topics");
  const inbox = await loadMarkdownDir(inboxDir, "observations/_inbox", scopeDir);
  if (inbox.length === 0) {
    await regenerateManifest(scopeDir);
    return { merged: 0, topics: [], remaining: 0, via: "noop" };
  }

  const topics = await loadMarkdownDir(topicsDir, "topics", scopeDir);
  const stamp = await scopeStamp(scopeDir);
  const snapshotTopicNames = new Set(topics.map((file) => file.name));
  const user = buildDreamUser({ inbox, topics });
  const sourceTexts = inbox.map((item) => item.text);
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
      parse: (raw) => parseDreamPlan(raw, sourceTexts),
    });
    if (!plan) {
      await regenerateManifest(scopeDir);
      return { merged: 0, topics: [], remaining: inbox.length, via: "failed" };
    }
    if (dreamPlanIsEmpty(plan)) {
      const still = await liveInbox(inbox);
      await archiveInbox(still, archiveDir, scopeDir);
      await regenerateManifest(scopeDir);
      return { merged: still.length, topics: [], remaining: 0, via: "noop" };
    }
  } else if (options.apiKey) {
    try {
      const raw = await completeGlm({ ...llmOptions, apiKey: options.apiKey });
      plan = parseDreamPlan(raw, sourceTexts);
    } catch {
      plan = null;
    }
    if (!plan) {
      return dreamScopeRules(scopeDir, await liveInbox(inbox));
    }
    if (dreamPlanIsEmpty(plan)) {
      const still = await liveInbox(inbox);
      await archiveInbox(still, archiveDir, scopeDir);
      await regenerateManifest(scopeDir);
      return { merged: still.length, topics: [], remaining: 0, via: "noop" };
    }
  } else {
    return dreamScopeRules(scopeDir, await liveInbox(inbox));
  }

  const currentTopics = await listMd(topicsDir, "topics", scopeDir);
  const currentNames = new Set(currentTopics.map((file) => file.name));
  const deletedSlugs = [...snapshotTopicNames]
    .filter((name) => !currentNames.has(name))
    .map((name) => name.replace(/\.md$/i, ""));
  const ignoreSlugs = new Set([...(options.ignoreSlugs || []), ...deletedSlugs]);
  const live = await liveInbox(inbox);
  const droppedTexts = [
    ...(options.dropTexts || []),
    ...inbox.filter((file) => !live.some((item) => item.path === file.path)).map((file) => file.text),
  ];
  const stampChanged = (await scopeStamp(scopeDir)) !== stamp;

  if (live.length === 0) {
    await regenerateManifest(scopeDir);
    return { merged: 0, topics: [], remaining: 0, via: "noop" };
  }

  if ((stampChanged || live.length < inbox.length) && !options.retried) {
    return dreamScope(scopeDir, {
      ...options,
      retried: true,
      ignoreSlugs: [...ignoreSlugs],
      dropTexts: droppedTexts,
    });
  }

  plan = filterStalePlan(plan, ignoreSlugs);
  plan = {
    ...plan,
    topics: plan.topics.map((topic) => ({
      ...topic,
      content: stripDeletedObservations(
        topic.content,
        droppedTexts,
        [...live.map((file) => file.text), ...topics.map((file) => file.text)],
      ),
    })),
  };
  if (dreamPlanIsEmpty(plan)) {
    await archiveInbox(live, archiveDir, scopeDir);
    await regenerateManifest(scopeDir);
    return { merged: live.length, topics: [], remaining: 0, via: "noop" };
  }

  const applied = await applyDreamPlan(topicsDir, plan);
  await archiveInbox(live, archiveDir, scopeDir);
  await regenerateManifest(scopeDir);
  return {
    merged: live.length,
    topics: applied.written.length ? applied.written : applied.renamed,
    remaining: 0,
    via: "llm",
    renamed: applied.renamed,
    deleted: applied.deleted,
  };
}

async function liveInbox(inbox) {
  const out = [];
  for (const file of inbox) {
    try {
      await fs.stat(file.path);
      out.push(file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  return out;
}

export function pickVia(a, b) {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "llm" || b === "llm") return "llm";
  if (a === "rules" || b === "rules") return "rules";
  if (a === "disabled" || b === "disabled") return "disabled";
  return "noop";
}

export function combineDreamResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { merged: 0, topics: [], remaining: 0, via: "noop" };
  }
  return results.reduce((acc, cur) => ({
    merged: acc.merged + (cur.merged || 0),
    topics: [...new Set([...(acc.topics || []), ...(cur.topics || [])])],
    remaining: acc.remaining + (cur.remaining || 0),
    via: pickVia(acc.via, cur.via),
    renamed: [...(acc.renamed || []), ...(cur.renamed || [])],
    deleted: [...(acc.deleted || []), ...(cur.deleted || [])],
  }));
}

export async function dreamAll(globalDir, workspaceDir, options = {}) {
  const global = await dreamScope(globalDir, options);
  const workspace = workspaceDir
    ? await dreamScope(workspaceDir, options)
    : { merged: 0, topics: [], remaining: 0, via: "noop" };
  return combineDreamResults([global, workspace]);
}

export async function dreamPendingScopes(root, options = {}) {
  const results = [];
  const globalDir = nodePath.join(root, "global");
  try {
    await fs.stat(globalDir);
    results.push(await dreamScope(globalDir, options));
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  for (const dir of await listWorkspaceScopeDirs(root)) {
    results.push(await dreamScope(dir, options));
  }
  return combineDreamResults(results);
}
