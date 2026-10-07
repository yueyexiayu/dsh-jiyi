import { randomBytes } from "node:crypto";
import { promises as fs, constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
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
    const path = await assertSafePath(root, nodePath.join(root, SETTINGS_NAME));
    const raw = await fs.readFile(path, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || ("enabled" in parsed && typeof parsed.enabled !== "boolean")) throw new Error("invalid settings");
    } catch {
      throw new Error("memory settings are corrupt; memory is disabled until settings are repaired");
    }
    return normalizeSettings(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") return defaultSettings();
    throw error;
  }
}

export async function saveSettings(root, settings) {
  return withNamedLock(root, ".settings.lock", async () => {
    const prev = await loadSettings(root);
    const patch = typeof settings === "function" ? await settings(prev) : settings;
    const next = normalizeSettings({ ...prev, ...patch });
    await atomicWrite(nodePath.join(root, SETTINGS_NAME), `${JSON.stringify(next, null, 2)}\n`, root);
    return next;
  });
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
  const dir = await assertSafePath(root, nodePath.join(root, "workspaces", id));
  const legacyId = legacyWorkspaceId(cwd, origin);
  if (!legacyId || legacyId === id) return dir;
  const oldDir = await assertSafePath(root, nodePath.join(root, "workspaces", legacyId));
  try { await fs.stat(oldDir); }
  catch (error) { if (error.code === "ENOENT") return dir; throw error; }
  throw new Error(`legacy workspace requires explicit migration after confirming the target origin: ${legacyId}`);
}

async function resolvedScopeDirs(root, cwd, origin) {
  const dirs = scopeDirs(root, cwd, origin);
  if (cwd && !isEphemeralCwd(cwd)) dirs.workspaceDir = await resolveWorkspaceDir(root, cwd, origin);
  return dirs;
}

function enqueueKey(key, fn) {
  const prev = manifestTails.get(key) || Promise.resolve();
  const job = prev.then(fn, fn);
  manifestTails.set(key, job.then(() => {}, () => {}));
  return job;
}

// The configured store root is trusted, but no child (including a scope) may
// redirect access through a symlink. Resolve existing ancestors even for new files.
export async function assertSafePath(root, target) {
  const base = nodePath.resolve(root);
  const abs = nodePath.resolve(target);
  if (abs !== base && !isPathInside(base, abs)) throw new Error("path escapes memory store");
  const relative = nodePath.relative(base, abs);
  let current = base;
  for (const part of ["", ...relative.split(nodePath.sep).filter(Boolean)]) {
    if (part) current = nodePath.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("path escapes memory store: symbolic link");
      if (current !== abs && !stat.isDirectory()) throw new Error("memory path ancestor is not a directory");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return abs;
}

export async function assertScopeSafe(scopeDir) {
  const scope = nodePath.resolve(scopeDir);
  const parent = nodePath.dirname(scope);
  const root = nodePath.basename(scope) === "global" ? parent
    : nodePath.basename(parent) === "workspaces" ? nodePath.dirname(parent) : null;
  if (!root) throw new Error("invalid memory scope");
  await assertSafePath(root, scope);
  return root;
}

async function atomicWrite(path, content, root = null, options = {}) {
  const base = root || await assertScopeSafe(nodePath.basename(path) === "MEMORY.md"
    ? nodePath.dirname(path) : nodePath.dirname(nodePath.dirname(path)));
  path = await assertSafePath(base, path);
  options.signal?.throwIfAborted();
  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  await assertSafePath(base, path);
  const tmp = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await assertSafePath(base, path);
    options.signal?.throwIfAborted();
    await fs.rename(tmp, path);
  } finally {
    await fs.unlink(tmp).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function lockOwner(path) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe memory lock");
    const text = await fs.readFile(path, "utf8");
    let owner;
    try { owner = JSON.parse(text); } catch { owner = null; }
    return { stat, text, pid: typeof owner === "number" ? owner : owner?.pid };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function cleanDeadLockClaims(root, name) {
  const prefix = `${name}.reclaim-`;
  for (const file of await fs.readdir(root)) {
    if (!file.startsWith(prefix)) continue;
    const match = file.slice(prefix.length).match(/^(\d+)-[a-f0-9]{32}$/);
    if (!match || processAlive(Number(match[1]))) continue;
    const claimPath = await assertSafePath(root, nodePath.join(root, file));
    try { await fs.unlink(claimPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function withNamedLock(root, name, fn) {
  await assertSafePath(root, root);
  await fs.mkdir(root, { recursive: true });
  const lockPath = await assertSafePath(root, nodePath.join(root, name));
  const token = randomBytes(16).toString("hex");
  const ownerText = JSON.stringify({ pid: process.pid, token });
  const started = Date.now();
  while (Date.now() - started < LOCK_WAIT_MS) {
    await cleanDeadLockClaims(root, name);
    let handle;
    try { handle = await fs.open(lockPath, "wx", 0o600); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (handle) {
      try {
        await handle.writeFile(ownerText);
        // A live process is never evicted on age alone. Lease timestamps aid
        // diagnosis and permit reclaiming incomplete files after a crash.
        const heartbeat = setInterval(() => {
          const now = new Date();
          void handle.utimes(now, now).catch(() => {});
        }, LOCK_STALE_MS / 3);
        heartbeat.unref();
        try { return await fn(); } finally { clearInterval(heartbeat); }
      } finally {
        await handle.close();
        const current = await lockOwner(lockPath);
        if (current?.text === ownerText) await fs.unlink(lockPath);
      }
    }
    const current = await lockOwner(lockPath);
    if (current && !processAlive(current.pid)
      && (current.pid || Date.now() - current.stat.mtimeMs > LOCK_STALE_MS)) {
      // A unique hardlink claim has no shared guard that can get stuck after a
      // crash. nlink=2 means only this claim plus the original lock exist.
      // Read the original *after* nlink: if another reclaimer removed it, its
      // replacement has a different inode/token and must never be removed.
      const claimPath = `${lockPath}.reclaim-${process.pid}-${token}`;
      let claimed = false;
      try {
        try { await fs.link(lockPath, claimPath); claimed = true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (claimed) {
          const claim = await fs.lstat(claimPath);
          if (claim.nlink === 2 && claim.ino === current.stat.ino) {
            const latest = await lockOwner(lockPath);
            if (latest && latest.stat.ino === current.stat.ino && latest.text === current.text) await fs.unlink(lockPath);
          }
        }
      } finally {
        if (claimed) await fs.unlink(claimPath);
      }
    }
    await sleep(15);
  }
  throw new Error("memory store is busy");
}

export async function withStoreLock(root, fn) {
  return withNamedLock(root, ".lock", fn);
}

async function ensureScope(scopeDir) {
  const root = await assertScopeSafe(scopeDir);
  for (const relative of ["topics", "observations/_inbox", "observations/_conflicts", "archive"]) {
    const dir = await assertSafePath(root, nodePath.join(scopeDir, relative));
    await fs.mkdir(dir, { recursive: true });
  }
  const manifest = await assertSafePath(root, nodePath.join(scopeDir, "MEMORY.md"));
  try {
    await fs.stat(manifest);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    await atomicWrite(manifest, emptyManifest(nodePath.basename(scopeDir) === "global" ? "global" : "workspace"), root);
  }
}

export async function ensureLayout(root, cwd, origin) {
  const { globalDir, workspaceDir } = await resolvedScopeDirs(root, cwd, origin);
  await assertSafePath(root, root);
  await fs.mkdir(root, { recursive: true });
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
  if (posix.startsWith("observations/_conflicts/") && posix.endsWith(".md") && posix.split("/").length === 3) {
    return "conflict";
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
    const root = await assertScopeSafe(scopeDir);
    await assertSafePath(root, dir);
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
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
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

async function describeTopic(file) {
  const handle = await fs.open(file.path, FS.O_RDONLY | FS.O_NOFOLLOW);
  try {
    // Listing only needs a bounded preview, not the entire topic body.
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    const title = (lines.find((line) => line.startsWith("# ")) || "").replace(/^#\s+/, "").trim() || file.name.replace(/\.md$/, "");
    const body = lines.find((line) => line.trim() && !line.startsWith("#") && !line.startsWith("Generated")) || "";
    return { ...file, title, description: body.trim().slice(0, 160) };
  } finally {
    await handle.close();
  }
}

export async function listEntries(root, cwd, origin) {
  const { globalDir, workspaceDir } = await resolvedScopeDirs(root, cwd, origin);
  await assertSafePath(root, globalDir);
  if (cwd && !isEphemeralCwd(cwd)) await assertSafePath(root, workspaceDir);
  const scopes = [{ id: "global", dir: globalDir, label: "全局" }];
  if (cwd && !isEphemeralCwd(cwd)) scopes.push({ id: "workspace", dir: workspaceDir, label: "工作区" });
  const entries = [];
  for (const scope of scopes) {
    const indexPath = await assertSafePath(root, nodePath.join(scope.dir, "MEMORY.md"));
    let indexSt = null;
    try {
      indexSt = await fs.stat(indexPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
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
    const conflicts = await listMd(nodePath.join(scope.dir, "observations", "_conflicts"), "observations/_conflicts", scope.dir);
    for (const file of conflicts) {
      entries.push({
        scope: scope.id,
        group: "conflict",
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
  return assertSafePath(root, requested);
}

export async function assertManagedPath(root, requested, cwd, origin) {
  const path = await assertSafePath(root, requested);
  const { globalDir, workspaceDir } = await resolvedScopeDirs(root, cwd, origin);
  const allowed = [nodePath.resolve(globalDir)];
  if (cwd && !isEphemeralCwd(cwd)) allowed.push(nodePath.resolve(workspaceDir));
  const ok = allowed.some((dir) => path === dir || isPathInside(dir, path));
  if (!ok) throw new Error("path escapes current memory scopes");
  return path;
}

export async function readEntry(root, requested, bounds = null) {
  const path = bounds
    ? await assertManagedPath(root, requested, bounds.cwd, bounds.origin)
    : await assertInsideStore(root, requested);
  let handle;
  try {
    handle = await fs.open(path, FS.O_RDONLY | FS.O_NOFOLLOW);
    const lst = await handle.stat();
    if (!lst.isFile()) throw new Error("not a file");
    if (lst.size > MAX_TOPIC_BYTES) throw new Error("file too large");
    const content = await handle.readFile("utf8");
    if (Buffer.byteLength(content) > MAX_TOPIC_BYTES) throw new Error("file too large");
    return { path, content, size: lst.size, mtimeMs: lst.mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("not found");
    if (error.code === "ELOOP") throw new Error("path escapes memory store: symbolic link");
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function deleteEntry(root, requested, bounds = null, options = {}) {
  const path = bounds
    ? await assertManagedPath(root, requested, bounds.cwd, bounds.origin)
    : await assertInsideStore(root, requested);
  const rel = toPosix(nodePath.relative(nodePath.resolve(root), path));
  const kind = classifyRelative(rel.replace(/^global\//, "").replace(/^workspaces\/[^/]+\//, ""));
  if (kind !== "topic" && kind !== "inbox" && kind !== "conflict" && kind !== "archive") {
    throw new Error("protected memory path");
  }
  options.signal?.throwIfAborted();
  await assertSafePath(root, path);
  try {
    await fs.unlink(path);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error("not found");
    throw error;
  }
  const scopeDir = kind === "inbox" || kind === "conflict"
    ? nodePath.dirname(nodePath.dirname(nodePath.dirname(path)))
    : nodePath.dirname(nodePath.dirname(path));
  await regenerateManifest(scopeDir);
  return { path };
}

function observationMarkdown({ statement, body, topicHint, type, createdAt, source = "manual" }) {
  const lines = [
    "---",
    `type: ${type || "project"}`,
    `source: ${["user", "derived", "manual"].includes(source) ? source : "unknown"}`,
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

export async function remember(root, cwd, origin, note, options = {}) {
  options.signal?.throwIfAborted();
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
  const fileName = `${stamp}-${randomBytes(16).toString("hex")}.md`;
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
    source: note.source,
    createdAt,
  }), root, options);
  await regenerateManifest(scopeDir);
  return { path, scope, relative: posixJoin("observations/_inbox", fileName) };
}

async function regenerateManifestUnlocked(scopeDir, { persist = true } = {}) {
  const root = await assertScopeSafe(scopeDir);
  const kind = nodePath.basename(scopeDir) === "global" ? "global" : "workspace";
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
  if (persist) await atomicWrite(nodePath.join(scopeDir, "MEMORY.md"), content, root);
  return content;
}

export async function regenerateManifest(scopeDir, options = {}) {
  const key = nodePath.resolve(scopeDir);
  return enqueueKey(key, () => regenerateManifestUnlocked(scopeDir, options));
}

export async function regenerateManifests(root, cwd, origin, options = {}) {
  const { globalDir, workspaceDir } = options.persist === false
    ? await resolvedScopeDirs(root, cwd, origin) : await ensureLayout(root, cwd, origin);
  const global = await regenerateManifest(globalDir, options);
  let workspace = "";
  if (cwd && !isEphemeralCwd(cwd)) workspace = await regenerateManifest(workspaceDir, options);
  return { global, workspace, globalDir, workspaceDir };
}

export async function inboxCount(scopeDir) {
  const files = await listMd(nodePath.join(scopeDir, "observations", "_inbox"), "observations/_inbox", scopeDir);
  return files.length;
}

export async function listWorkspaceScopeDirs(root) {
  const wsRoot = await assertSafePath(root, nodePath.join(root, "workspaces"));
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
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (!(await isResolvedInside(root, dir))) continue;
    out.push(dir);
  }
  return out;
}

export { listMd, observationMarkdown, atomicWrite };
