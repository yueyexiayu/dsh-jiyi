import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
  MAX_ARCHIVE_FILES,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_NOTE_BYTES,
  MAX_TOPIC_BYTES,
  isPathInside,
  posixJoin,
  shortHash,
  slugify,
  toPosix,
} from "./parse.js";

const SETTINGS_NAME = "settings.json";
const DEFAULT_SETTINGS = {
  enabled: true,
  extractPrimary: "glm-5.3-flash",
  extractFallbacks: ["deepseek-flash"],
};

export function normalizeSettings(parsed = {}) {
  const extractPrimary = parsed.extractPrimary === "deepseek-flash" ? "deepseek-flash" : "glm-5.3-flash";
  const seen = new Set([extractPrimary]);
  const extractFallbacks = [];
  const rawFallbacks = Array.isArray(parsed.extractFallbacks)
    ? parsed.extractFallbacks
    : DEFAULT_SETTINGS.extractFallbacks;
  for (const id of rawFallbacks) {
    if (id !== "glm-5.3-flash" && id !== "deepseek-flash") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    extractFallbacks.push(id);
  }
  return {
    enabled: parsed.enabled !== false,
    extractPrimary,
    extractFallbacks,
  };
}

export async function loadSettings(root) {
  try {
    const raw = await fs.readFile(nodePath.join(root, SETTINGS_NAME), "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") return { ...DEFAULT_SETTINGS, extractFallbacks: [...DEFAULT_SETTINGS.extractFallbacks] };
    throw error;
  }
}

export async function saveSettings(root, settings) {
  await fs.mkdir(root, { recursive: true });
  const prev = await loadSettings(root);
  const next = normalizeSettings({ ...prev, ...settings });
  await atomicWrite(nodePath.join(root, SETTINGS_NAME), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function readGitOrigin(cwd) {
  if (!cwd) return null;
  try {
    const gitPath = nodePath.join(cwd, ".git");
    let gitDir = gitPath;
    const st = await fs.lstat(gitPath);
    if (st.isFile()) {
      const body = await fs.readFile(gitPath, "utf8");
      const match = body.match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      gitDir = nodePath.resolve(cwd, match[1].trim());
    } else if (!st.isDirectory()) {
      return null;
    }
    let configPath = nodePath.join(gitDir, "config");
    try {
      const common = await fs.readFile(nodePath.join(gitDir, "commondir"), "utf8");
      configPath = nodePath.resolve(gitDir, common.trim(), "config");
    } catch {
      // not a worktree
    }
    const config = await fs.readFile(configPath, "utf8");
    const urlMatch = config.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/);
    if (!urlMatch) return null;
    return normalizeOrigin(urlMatch[1].trim());
  } catch {
    return null;
  }
}

export function normalizeOrigin(url) {
  let value = String(url || "").trim();
  value = value.replace(/\.git$/, "");
  value = value.replace(/^git@[^:]+:/, "");
  value = value.replace(/^https?:\/\/[^/]+\//, "");
  value = value.replace(/^ssh:\/\/[^/]+\//, "");
  value = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!value || value.includes("..")) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function workspaceId(cwd, origin) {
  const key = origin || cwd || "unknown";
  const base = origin ? origin.split("/").pop() : nodePath.basename(cwd || "workspace");
  return `${slugify(base, 32)}-${shortHash(key)}`;
}

export function isEphemeralCwd(cwd) {
  if (!cwd) return true;
  const resolved = nodePath.resolve(cwd);
  const prefixes = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  return prefixes.some((prefix) => {
    const root = nodePath.resolve(prefix);
    return resolved === root || resolved.startsWith(`${root}${nodePath.sep}`);
  });
}

export function resolveRememberScope(note, cwd) {
  if (note && note.scope === "global") return "global";
  if (note && note.scope === "workspace") {
    if (!cwd || isEphemeralCwd(cwd)) throw new Error("no workspace");
    return "workspace";
  }
  if (!cwd || isEphemeralCwd(cwd)) return "global";
  return "workspace";
}

export function observationStamp(iso) {
  const date = new Date(iso);
  if (date.getTime() !== date.getTime()) {
    return String(iso || "").replace(/[^\d]/g, "").slice(0, 14) || "0";
  }
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join("-") + "-" + [pad(date.getUTCHours()), pad(date.getUTCMinutes()), pad(date.getUTCSeconds())].join("-");
}

export function scopeDirs(root, cwd, origin) {
  return {
    globalDir: nodePath.join(root, "global"),
    workspaceDir: nodePath.join(root, "workspaces", workspaceId(cwd, origin)),
  };
}

async function atomicWrite(path, content) {
  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, path);
}

async function ensureScope(scopeDir) {
  await fs.mkdir(nodePath.join(scopeDir, "topics"), { recursive: true });
  await fs.mkdir(nodePath.join(scopeDir, "observations", "_inbox"), { recursive: true });
  await fs.mkdir(nodePath.join(scopeDir, "archive"), { recursive: true });
  const manifest = nodePath.join(scopeDir, "MEMORY.md");
  try {
    await fs.stat(manifest);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    await atomicWrite(manifest, emptyManifest(scopeDir.includes(`${nodePath.sep}global`) ? "global" : "workspace"));
  }
}

export async function ensureLayout(root, cwd, origin) {
  await fs.mkdir(root, { recursive: true });
  const { globalDir, workspaceDir } = scopeDirs(root, cwd, origin);
  await ensureScope(globalDir);
  if (cwd && !isEphemeralCwd(cwd)) await ensureScope(workspaceDir);
  return { globalDir, workspaceDir };
}

function emptyManifest(kind) {
  const heading = kind === "global" ? "Global memory index" : "Workspace memory index";
  return `# ${heading}\n\nGenerated by jiyi. Do not edit this file directly.\n\nNo topics yet.\n`;
}

export function classifyRelative(rel) {
  const posix = toPosix(rel);
  if (posix === "MEMORY.md") return "index";
  if (posix.startsWith("topics/") && posix.endsWith(".md") && posix.split("/").length === 2) return "topic";
  if (posix.startsWith("observations/_inbox/") && posix.endsWith(".md") && posix.split("/").length === 3) {
    return "inbox";
  }
  if (posix.startsWith("archive/")) return "archive";
  return "other";
}

async function listMd(dir, prefix) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const full = nodePath.join(dir, name);
    let st;
    try {
      st = await fs.lstat(full);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    out.push({
      name,
      relative: posixJoin(prefix, name),
      path: full,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export async function pruneArchive(archiveDir, keep = MAX_ARCHIVE_FILES) {
  const files = await listMd(archiveDir, "archive");
  for (const file of files.slice(keep)) {
    try {
      await fs.unlink(file.path);
    } catch {
      // ignore
    }
  }
}

async function describeTopic(file) {
  try {
    const text = await fs.readFile(file.path, "utf8");
    const lines = text.split(/\r?\n/);
    const title = (lines.find((line) => line.startsWith("# ")) || "").replace(/^#\s+/, "").trim() || file.name.replace(/\.md$/, "");
    const body = lines.find((line) => line.trim() && !line.startsWith("#") && !line.startsWith("Generated")) || "";
    return { ...file, title, description: body.trim().slice(0, 160) };
  } catch {
    return { ...file, title: file.name.replace(/\.md$/, ""), description: "" };
  }
}

export async function listEntries(root, cwd, origin) {
  const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
  const scopes = [{ id: "global", dir: globalDir, label: "全局" }];
  if (cwd && !isEphemeralCwd(cwd)) scopes.push({ id: "workspace", dir: workspaceDir, label: "工作区" });
  const entries = [];
  for (const scope of scopes) {
    const indexPath = nodePath.join(scope.dir, "MEMORY.md");
    let indexSt = null;
    try {
      indexSt = await fs.stat(indexPath);
    } catch {
      indexSt = null;
    }
    if (indexSt) {
      entries.push({
        scope: scope.id,
        group: "index",
        label: "MEMORY.md",
        relative: "MEMORY.md",
        path: indexPath,
        size: indexSt.size,
        mtimeMs: indexSt.mtimeMs,
        generated: true,
        deletable: false,
      });
    }
    const topics = await listMd(nodePath.join(scope.dir, "topics"), "topics");
    for (const file of topics) {
      const described = await describeTopic(file);
      entries.push({
        scope: scope.id,
        group: "topics",
        label: described.title,
        description: described.description,
        relative: file.relative,
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        generated: false,
        deletable: true,
      });
    }
    const inbox = await listMd(nodePath.join(scope.dir, "observations", "_inbox"), "observations/_inbox");
    for (const file of inbox) {
      entries.push({
        scope: scope.id,
        group: "inbox",
        label: file.name,
        relative: file.relative,
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        generated: false,
        deletable: true,
      });
    }
    const archived = await listMd(nodePath.join(scope.dir, "archive"), "archive");
    for (const file of archived) {
      entries.push({
        scope: scope.id,
        group: "archive",
        label: file.name,
        relative: file.relative,
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        generated: false,
        deletable: true,
      });
    }
  }
  return {
    workspaceId: cwd ? workspaceId(cwd, origin) : null,
    origin: origin || null,
    cwd: cwd || null,
    entries,
  };
}

export async function assertInsideStore(root, requested) {
  const abs = nodePath.resolve(requested);
  const rootReal = await fs.realpath(root);
  let resolved;
  try {
    resolved = await fs.realpath(abs);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    resolved = abs;
  }
  if (!isPathInside(rootReal, resolved) && resolved !== rootReal) {
    throw new Error("path escapes memory store");
  }
  return resolved;
}

export async function readEntry(root, requested) {
  const path = await assertInsideStore(root, requested);
  const st = await fs.stat(path);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_TOPIC_BYTES) throw new Error("file too large");
  const content = await fs.readFile(path, "utf8");
  return { path, content, size: st.size, mtimeMs: st.mtimeMs };
}

export async function deleteEntry(root, requested) {
  const path = await assertInsideStore(root, requested);
  const rootReal = await fs.realpath(root);
  const rel = toPosix(nodePath.relative(rootReal, path));
  const kind = classifyRelative(rel.replace(/^global\//, "").replace(/^workspaces\/[^/]+\//, ""));
  if (kind !== "topic" && kind !== "inbox" && kind !== "archive") throw new Error("protected memory path");
  await fs.unlink(path);
  const scopeDir = kind === "inbox"
    ? nodePath.dirname(nodePath.dirname(nodePath.dirname(path)))
    : nodePath.dirname(nodePath.dirname(path));
  await regenerateManifest(scopeDir);
  return { path };
}

function observationMarkdown({ statement, body, topicHint, type, createdAt }) {
  const lines = [
    "---",
    `type: ${type || "project"}`,
    topicHint ? `topic: ${topicHint}` : "topic: notes",
    `created: ${createdAt}`,
    "---",
    "",
    statement.trim(),
  ];
  if (body && body.trim() && body.trim() !== statement.trim()) {
    lines.push("", body.trim());
  }
  lines.push("");
  return lines.join("\n");
}

export function memoryStatement(note) {
  if (!note || typeof note !== "object" || Array.isArray(note)) {
    throw new Error("memory text must be a string");
  }
  const raw = note.statement ?? note.text;
  if (raw == null) throw new Error("empty memory");
  if (typeof raw !== "string") throw new Error("memory text must be a string");
  const text = raw.trim();
  if (!text) throw new Error("empty memory");
  return text;
}

export async function remember(root, cwd, origin, note) {
  const text = memoryStatement(note);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_NOTE_BYTES) throw new Error("memory observation is too large");
  const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
  const scope = resolveRememberScope(note, cwd);
  const scopeDir = scope === "global" ? globalDir : workspaceDir;
  const createdAt = note.createdAt || new Date().toISOString();
  const stamp = observationStamp(createdAt);
  const fileName = `${stamp}-${shortHash(text)}.md`;
  const path = nodePath.join(scopeDir, "observations", "_inbox", fileName);
  await atomicWrite(path, observationMarkdown({
    statement: text,
    body: note.body,
    topicHint: note.topicHint,
    type: note.type,
    createdAt,
  }));
  await regenerateManifest(scopeDir);
  return { path, scope, relative: posixJoin("observations/_inbox", fileName) };
}

export async function regenerateManifest(scopeDir) {
  const kind = toPosix(scopeDir).includes("/global") || scopeDir.endsWith(`${nodePath.sep}global`) ? "global" : "workspace";
  const heading = kind === "global" ? "Global memory index" : "Workspace memory index";
  const topics = await listMd(nodePath.join(scopeDir, "topics"), "topics");
  const inbox = await listMd(nodePath.join(scopeDir, "observations", "_inbox"), "observations/_inbox");
  const lines = [
    `# ${heading}`,
    "",
    "Generated by jiyi. Do not edit this file directly.",
    "",
  ];
  if (topics.length === 0 && inbox.length === 0) {
    lines.push("No topics yet.", "");
  } else {
    if (topics.length) {
      lines.push("Topics", "");
      for (const file of topics.slice(0, MAX_MANIFEST_ENTRIES)) {
        const described = await describeTopic(file);
        const desc = described.description ? ` — ${described.description}` : "";
        lines.push(`- ${described.title}${desc} (\`${file.relative}\`)`);
      }
      lines.push("");
    }
    if (inbox.length) {
      lines.push(`Inbox: ${inbox.length} unconsolidated observation(s).`, "");
    }
  }
  let content = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES) {
    content = `${content.slice(0, MAX_MANIFEST_BYTES - 32)}\n…\n`;
  }
  await atomicWrite(nodePath.join(scopeDir, "MEMORY.md"), content);
  return content;
}

export async function regenerateManifests(root, cwd, origin) {
  const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
  const global = await regenerateManifest(globalDir);
  let workspace = "";
  if (cwd && !isEphemeralCwd(cwd)) workspace = await regenerateManifest(workspaceDir);
  return { global, workspace, globalDir, workspaceDir };
}

export async function inboxCount(scopeDir) {
  const files = await listMd(nodePath.join(scopeDir, "observations", "_inbox"), "observations/_inbox");
  return files.length;
}

export { listMd, observationMarkdown, atomicWrite };
