import { randomBytes } from "node:crypto";
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
  truncateUtf8,
} from "./parse.js";

const manifestTails = new Map();
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 30_000;

const SETTINGS_NAME = "settings.json";
const DEFAULT_SETTINGS = {
  enabled: true,
  extractPrimary: "glm-5.3-flash",
  extractFallbacks: ["deepseek-flash"],
};

function defaultSettings() {
  return { ...DEFAULT_SETTINGS, extractFallbacks: [...DEFAULT_SETTINGS.extractFallbacks] };
}

export function normalizeSettings(parsed = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    parsed = {};
  }
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
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultSettings();
    }
    return normalizeSettings(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") return defaultSettings();
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

function normalizeHostPath(host, repoPath) {
  const hostname = String(host || "")
    .trim()
    .replace(/^www\./i, "")
    .toLowerCase();
  const repo = String(repoPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!hostname || !repo || repo.includes("..")) return null;
  const parts = repo.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${hostname}/${parts.join("/")}`;
}

export function normalizeOrigin(url) {
  let value = String(url || "").trim();
  if (!value) return null;
  value = value.replace(/\\/g, "/");
  const scp = value.match(/^git@([^:]+):(.+)$/i);
  if (scp) return normalizeHostPath(scp[1], scp[2]);
  const ssh = value.match(/^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/i);
  if (ssh) return normalizeHostPath(ssh[1], ssh[2]);
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return normalizeHostPath(parsed.hostname, parsed.pathname);
    } catch {
      return null;
    }
  }
  value = value.replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!value || value.includes("..")) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length === 2) return parts.join("/");
  return `${parts[0]}/${parts.slice(1).join("/")}`;
}

export function workspaceId(cwd, origin) {
  const key = origin || cwd || "unknown";
  const base = origin ? String(origin).split("/").filter(Boolean).pop() : nodePath.basename(cwd || "workspace");
  return `${slugify(base, 32)}-${shortHash(key)}`;
}

export function legacyWorkspaceId(cwd, origin) {
  const parts = String(origin || "").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  return workspaceId(cwd, `${parts[parts.length - 2]}/${parts[parts.length - 1]}`);
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

export async function resolveWorkspaceDir(root, cwd, origin) {
  const id = workspaceId(cwd, origin);
  const dir = nodePath.join(root, "workspaces", id);
  try {
    await fs.stat(dir);
    return dir;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const legacyId = legacyWorkspaceId(cwd, origin);
  if (!legacyId || legacyId === id) return dir;
  const oldDir = nodePath.join(root, "workspaces", legacyId);
  try {
    await fs.stat(oldDir);
  } catch {
    return dir;
  }
  try {
    await fs.rename(oldDir, dir);
  } catch {
    return dir;
  }
  return dir;
}

function enqueueKey(key, fn) {
  const prev = manifestTails.get(key) || Promise.resolve();
  const job = prev.then(fn, fn);
  manifestTails.set(key, job.then(() => {}, () => {}));
  return job;
}

async function atomicWrite(path, content) {
  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, path);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withStoreLock(root, fn) {
  const lockPath = nodePath.join(root, ".lock");
  await fs.mkdir(root, { recursive: true });
  const started = Date.now();
  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: "wx" });
      try {
        return await fn();
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.unlink(lockPath);
      } catch {
        // retry
      }
      await sleep(15);
    }
  }
  throw new Error("memory store is busy");
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
  const globalDir = nodePath.join(root, "global");
  let workspaceDir = nodePath.join(root, "workspaces", workspaceId(cwd, origin));
  await ensureScope(globalDir);
  if (cwd && !isEphemeralCwd(cwd)) {
    workspaceDir = await resolveWorkspaceDir(root, cwd, origin);
    await ensureScope(workspaceDir);
  }
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

async function realpathOrNull(target) {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function isResolvedInside(root, candidate) {
  const rootReal = await realpathOrNull(root) || nodePath.resolve(root);
  const resolved = await realpathOrNull(candidate);
  if (!resolved) return false;
  return resolved === rootReal || isPathInside(rootReal, resolved);
}

async function listMd(dir, prefix, scopeDir = null) {
  if (scopeDir) {
    const scopeReal = await realpathOrNull(scopeDir);
    const dirReal = await realpathOrNull(dir);
    if (!scopeReal || !dirReal) return [];
    if (dirReal !== scopeReal && !isPathInside(scopeReal, dirReal)) return [];
  }
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
    if (scopeDir && !(await isResolvedInside(scopeDir, full))) continue;
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

export async function pruneArchive(archiveDir, keep = MAX_ARCHIVE_FILES, scopeDir = null) {
  const files = await listMd(archiveDir, "archive", scopeDir || nodePath.dirname(archiveDir));
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
    const topics = await listMd(nodePath.join(scope.dir, "topics"), "topics", scope.dir);
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
    const inbox = await listMd(nodePath.join(scope.dir, "observations", "_inbox"), "observations/_inbox", scope.dir);
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
    const archived = await listMd(nodePath.join(scope.dir, "archive"), "archive", scope.dir);
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
    let parentReal;
    try {
      parentReal = await fs.realpath(nodePath.dirname(abs));
    } catch {
      parentReal = nodePath.resolve(nodePath.dirname(abs));
    }
    resolved = nodePath.join(parentReal, nodePath.basename(abs));
  }
  if (!isPathInside(rootReal, resolved) && resolved !== rootReal) {
    throw new Error("path escapes memory store");
  }
  return resolved;
}

export async function assertManagedPath(root, requested, cwd, origin) {
  const path = await assertInsideStore(root, requested);
  const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
  const allowed = [await fs.realpath(globalDir)];
  if (cwd && !isEphemeralCwd(cwd)) {
    try {
      allowed.push(await fs.realpath(workspaceDir));
    } catch {
      // workspace may not exist yet
    }
  }
  const ok = allowed.some((dir) => path === dir || isPathInside(dir, path));
  if (!ok) throw new Error("path escapes current memory scopes");
  return path;
}

export async function readEntry(root, requested, bounds = null) {
  const path = bounds
    ? await assertManagedPath(root, requested, bounds.cwd, bounds.origin)
    : await assertInsideStore(root, requested);
  let lst;
  try {
    lst = await fs.lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error("not found");
    throw error;
  }
  if (lst.isSymbolicLink()) throw new Error("path escapes memory store");
  if (!lst.isFile()) throw new Error("not a file");
  if (lst.size > MAX_TOPIC_BYTES) throw new Error("file too large");
  const content = await fs.readFile(path, "utf8");
  return { path, content, size: lst.size, mtimeMs: lst.mtimeMs };
}

export async function deleteEntry(root, requested, bounds = null) {
  const path = bounds
    ? await assertManagedPath(root, requested, bounds.cwd, bounds.origin)
    : await assertInsideStore(root, requested);
  const rootReal = await fs.realpath(root);
  const rel = toPosix(nodePath.relative(rootReal, path));
  const kind = classifyRelative(rel.replace(/^global\//, "").replace(/^workspaces\/[^/]+\//, ""));
  if (kind !== "topic" && kind !== "inbox" && kind !== "archive") throw new Error("protected memory path");
  try {
    await fs.unlink(path);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error("not found");
    throw error;
  }
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

function boundedNoteField(value, label = "memory observation") {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error("memory text must be a string");
  if (Buffer.byteLength(value, "utf8") > MAX_NOTE_BYTES) throw new Error(`${label} is too large`);
  return value;
}

export async function remember(root, cwd, origin, note) {
  const text = memoryStatement(note);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_NOTE_BYTES) throw new Error("memory observation is too large");
  const body = boundedNoteField(note && note.body);
  const topicHint = boundedNoteField(note && note.topicHint, "memory topic");
  const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
  const scope = resolveRememberScope(note, cwd);
  const scopeDir = scope === "global" ? globalDir : workspaceDir;
  const createdAt = note.createdAt || new Date().toISOString();
  const stamp = observationStamp(createdAt);
  const fileName = `${stamp}-${shortHash(text)}.md`;
  const inboxDir = nodePath.join(scopeDir, "observations", "_inbox");
  await assertInsideStore(root, inboxDir);
  if (!(await isResolvedInside(scopeDir, inboxDir))) {
    throw new Error("path escapes memory store");
  }
  const path = nodePath.join(inboxDir, fileName);
  await assertInsideStore(root, path);
  await atomicWrite(path, observationMarkdown({
    statement: text,
    body,
    topicHint,
    type: note.type,
    createdAt,
  }));
  await regenerateManifest(scopeDir);
  return { path, scope, relative: posixJoin("observations/_inbox", fileName) };
}

async function regenerateManifestUnlocked(scopeDir) {
  const kind = toPosix(scopeDir).includes("/global") || scopeDir.endsWith(`${nodePath.sep}global`) ? "global" : "workspace";
  const heading = kind === "global" ? "Global memory index" : "Workspace memory index";
  const topics = await listMd(nodePath.join(scopeDir, "topics"), "topics", scopeDir);
  const inbox = await listMd(nodePath.join(scopeDir, "observations", "_inbox"), "observations/_inbox", scopeDir);
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
  const content = truncateUtf8(`${lines.join("\n")}\n`, MAX_MANIFEST_BYTES);
  await atomicWrite(nodePath.join(scopeDir, "MEMORY.md"), content);
  return content;
}

export async function regenerateManifest(scopeDir) {
  const key = nodePath.resolve(scopeDir);
  return enqueueKey(key, () => regenerateManifestUnlocked(scopeDir));
}

export async function regenerateManifests(root, cwd, origin) {
  const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
  const global = await regenerateManifest(globalDir);
  let workspace = "";
  if (cwd && !isEphemeralCwd(cwd)) workspace = await regenerateManifest(workspaceDir);
  return { global, workspace, globalDir, workspaceDir };
}

export async function inboxCount(scopeDir) {
  const files = await listMd(nodePath.join(scopeDir, "observations", "_inbox"), "observations/_inbox", scopeDir);
  return files.length;
}

export async function listWorkspaceScopeDirs(root) {
  const wsRoot = nodePath.join(root, "workspaces");
  let names = [];
  try {
    names = await fs.readdir(wsRoot);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of names) {
    if (!name || name.startsWith(".")) continue;
    const dir = nodePath.join(wsRoot, name);
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (!(await isResolvedInside(root, dir))) continue;
    out.push(dir);
  }
  return out;
}

export { listMd, observationMarkdown, atomicWrite };
