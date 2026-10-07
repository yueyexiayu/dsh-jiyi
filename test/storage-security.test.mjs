import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  assertSafePath, assertScopeSafe, atomicWrite, deleteEntry, ensureLayout,
  listEntries, listWorkspaceScopeDirs, loadSettings, readEntry,
  regenerateManifests, remember, saveSettings, withStoreLock, workspaceId, legacyWorkspaceId,
} from "../lib/storage.js";
import { registerMemoryTools } from "../lib/tools.js";
import { MAX_TOPIC_BYTES } from "../lib/parse.js";

const cwd = "/fixture/jiyi-project";
const storageUrl = new URL("../lib/storage.js", import.meta.url).href;
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(tmpdir(), "jiyi-storage-security-"));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, "store");
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  return { base, root, outside };
}
async function snapshot(dir) {
  const rows = [];
  async function visit(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const full = path.join(current, name);
      const stat = await fs.lstat(full);
      rows.push([path.relative(dir, full), stat.mode, stat.size, stat.mtimeMs,
        stat.isFile() ? await fs.readFile(full, "utf8") : null]);
      if (stat.isDirectory()) await visit(full);
    }
  }
  await visit(dir);
  return rows;
}
function child(code, args = []) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout.on("data", chunk => { stdout += chunk; });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  const done = once(proc, "close").then(([code]) => {
    assert.equal(code, 0, stderr);
    return stdout;
  });
  return { proc, done };
}

test("ambiguous legacy workspaces require explicit migration for every bounded reader and writer", async t => {
  const { root } = await fixture(t);
  const origins = ["github.com/owner/repo", "gitlab.com/owner/repo"];
  const legacyId = legacyWorkspaceId(cwd, origins[0]);
  assert.equal(legacyId, legacyWorkspaceId(cwd, origins[1]));
  const legacyDir = path.join(root, "workspaces", legacyId);
  await fs.mkdir(path.join(legacyDir, "topics"), { recursive: true });
  await fs.writeFile(path.join(legacyDir, "topics/fact.md"), "# Fact\n\nlegacy origin unknown\n");
  const before = await snapshot(root);
  for (const origin of origins) {
    const expected = /legacy workspace requires explicit migration/;
    await assert.rejects(() => ensureLayout(root, cwd, origin), expected);
    await assert.rejects(() => remember(root, cwd, origin, { text: "no implicit owner" }), expected);
    await assert.rejects(() => listEntries(root, cwd, origin), expected);
    await assert.rejects(() => regenerateManifests(root, cwd, origin, { persist: false }), expected);
    await assert.rejects(() => readEntry(root, path.join(root, "workspaces", workspaceId(cwd, origin), "topics/fact.md"), { cwd, origin }), expected);
    const tools = [];
    registerMemoryTools({ tools: { register(tool) { tools.push(tool); } } }, { root, cwdOf: () => cwd, originOf: () => origin });
    await assert.rejects(() => tools[0].execute({}), expected);
    await assert.rejects(() => tools[1].execute({ path: "fact" }), expected);
    await assert.rejects(() => tools[2].execute({ query: "legacy" }), expected);
  }
  assert.deepEqual(await snapshot(root), before);
});

test("read-only listing, read, search and manifests never create or change store files", async t => {
  const { root } = await fixture(t);
  assert.deepEqual((await listEntries(root, cwd, null)).entries, []);
  await regenerateManifests(root, cwd, null, { persist: false });
  await assert.rejects(() => fs.stat(root), { code: "ENOENT" });
  await ensureLayout(root, cwd, null);
  await fs.writeFile(path.join(root, "global/topics/test.md"), "# Test\n\nneedle\n");
  await fs.writeFile(path.join(root, "global/archive/recovery.md"), "recovery evidence");
  const before = await snapshot(root);
  const tools = [];
  registerMemoryTools({ tools: { register(tool) { tools.push(tool); } } }, { root, cwdOf: () => cwd });
  await tools[0].execute({});
  assert.match((await tools[1].execute({ path: "test" })).content, /needle/);
  assert.equal((await tools[2].execute({ query: "needle" })).hits.length, 1);
  await regenerateManifests(root, cwd, null, { persist: false });
  assert.deepEqual(await snapshot(root), before);
});

test("scope and ancestor symlinks cannot cause outside reads, writes or deletion", async t => {
  const { root, outside } = await fixture(t);
  await fs.mkdir(root);
  await fs.mkdir(path.join(outside, "topics"));
  await fs.mkdir(path.join(outside, "archive"));
  await fs.writeFile(path.join(outside, "topics/secret.md"), "# Secret\n\nexternal\n");
  await fs.writeFile(path.join(outside, "archive/recovery.md"), "keep");
  const before = await snapshot(outside);
  await fs.symlink(outside, path.join(root, "global"));
  await assert.rejects(() => listEntries(root, cwd, null), /escapes/);
  await assert.rejects(() => ensureLayout(root, cwd, null), /escapes/);
  await assert.rejects(() => remember(root, cwd, null, { text: "blocked", scope: "global" }), /escapes/);
  await assert.rejects(() => readEntry(root, path.join(root, "global/topics/secret.md")), /escapes/);
  await assert.rejects(() => deleteEntry(root, path.join(root, "global/topics/secret.md")), /escapes/);
  assert.deepEqual(await snapshot(outside), before);
  await fs.symlink(outside, path.join(root, "workspaces"));
  await assert.rejects(() => listWorkspaceScopeDirs(root), /escapes/);
  await assert.rejects(() => assertSafePath(root, path.join(root, "workspaces/new/topics/new.md")), /escapes/);
});

test("atomic writes reject existing final symlinks and leave outside file intact", async t => {
  const { root, outside } = await fixture(t);
  const { globalDir } = await ensureLayout(root, cwd, null);
  assert.equal(await assertScopeSafe(globalDir), root);
  const target = path.join(globalDir, "topics/test.md");
  const secret = path.join(outside, "secret.md");
  await fs.writeFile(secret, "untouched");
  await fs.symlink(secret, target);
  await assert.rejects(() => atomicWrite(target, "overwrite", root), /escapes/);
  assert.equal(await fs.readFile(secret, "utf8"), "untouched");
  assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
});

test("same-second observations retain distinct bodies and unique IDs", async t => {
  const { root } = await fixture(t);
  const createdAt = "2026-10-07T00:00:00.000Z";
  const results = await Promise.all(["first detail", "second detail"].map(body => remember(root, cwd, null, {
    statement: "same statement", body, createdAt, scope: "global",
  })));
  assert.notEqual(results[0].path, results[1].path);
  assert.match(await fs.readFile(results[0].path, "utf8"), /first detail/);
  assert.match(await fs.readFile(results[1].path, "utf8"), /second detail/);
  assert.equal((await listEntries(root, cwd, null)).entries.filter(x => x.group === "inbox").length, 2);
});

test("concurrent setting patches and updater toggles do not lose updates", async t => {
  const { root } = await fixture(t);
  await Promise.all([
    saveSettings(root, { enabled: false }),
    saveSettings(root, { extractPrimary: "deepseek-flash", extractFallbacks: ["glm-5.3-flash"] }),
  ]);
  assert.deepEqual(await loadSettings(root), { enabled: false, extractPrimary: "deepseek-flash", extractFallbacks: ["glm-5.3-flash"] });
  await Promise.all(Array.from({ length: 8 }, () => saveSettings(root, prev => ({ enabled: !prev.enabled }))));
  assert.equal((await loadSettings(root)).enabled, false);
});

test("setting updates are serialized across processes", async t => {
  const { root } = await fixture(t);
  await saveSettings(root, { enabled: false });
  const code = `import {saveSettings} from ${JSON.stringify(storageUrl)}; const root=process.argv[1]; for(let i=0;i<5;i++) await saveSettings(root, async prev => { await new Promise(r=>setTimeout(r,5)); return {enabled:!prev.enabled}; });`;
  const a = child(code, [root]);
  const b = child(code, [root]);
  await Promise.all([a.done, b.done]);
  assert.equal((await loadSettings(root)).enabled, false);
});

test("aged live lock is not stolen, and later contenders enter after release", async t => {
  const { root } = await fixture(t);
  await fs.mkdir(root);
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const holder = withStoreLock(root, async () => {
    await fs.utimes(path.join(root, ".lock"), new Date(0), new Date(0));
    entered();
    await new Promise(resolve => { release = resolve; });
  });
  await ready;
  const code = `import {withStoreLock} from ${JSON.stringify(storageUrl)}; console.log('started'); await withStoreLock(process.argv[1], async()=>console.log('entered'));`;
  const waiter = child(code, [root]);
  await once(waiter.proc.stdout, "data");
  let completed = false;
  void waiter.done.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(completed, false, "live holder must exclude contender even with an old timestamp");
  const text = await fs.readFile(path.join(root, ".lock"), "utf8");
  assert.equal(JSON.parse(text).pid, process.pid);
  release();
  await holder;
  assert.match(await waiter.done, /entered/);
});

test("dead process locks are reclaimed and old owner release preserves replacement", async t => {
  const { root } = await fixture(t);
  await fs.mkdir(root);
  const dead = child("", []);
  await dead.done;
  await fs.writeFile(path.join(root, ".lock"), JSON.stringify({ pid: dead.proc.pid, token: "dead" }));
  const orphanClaim = path.join(root, `.lock.reclaim-${dead.proc.pid}-${"a".repeat(32)}`);
  await fs.link(path.join(root, ".lock"), orphanClaim);
  assert.equal(await withStoreLock(root, async () => "recovered"), "recovered");
  await assert.rejects(() => fs.stat(orphanClaim), { code: "ENOENT" });
  let replacement;
  await withStoreLock(root, async () => {
    replacement = JSON.stringify({ pid: process.pid, token: "replacement" });
    await fs.writeFile(path.join(root, ".lock"), replacement);
  });
  assert.equal(await fs.readFile(path.join(root, ".lock"), "utf8"), replacement);
});

test("competing cross-process stale lock reclaimers remain mutually exclusive", async t => {
  const { root } = await fixture(t);
  await fs.mkdir(root);
  const dead = child("");
  await dead.done;
  await fs.writeFile(path.join(root, ".lock"), JSON.stringify({ pid: dead.proc.pid, token: "dead" }));
  const orphanClaim = path.join(root, `.lock.reclaim-${dead.proc.pid}-${"b".repeat(32)}`);
  await fs.link(path.join(root, ".lock"), orphanClaim);
  const code = `import {withStoreLock} from ${JSON.stringify(storageUrl)}; import {promises as fs} from 'node:fs'; import path from 'node:path'; const root=process.argv[1]; await withStoreLock(root, async()=> { const marker=path.join(root,'exclusive'); const h=await fs.open(marker,'wx'); await new Promise(r=>setTimeout(r,15)); await h.close(); await fs.unlink(marker); });`;
  await Promise.all(Array.from({ length: 6 }, () => child(code, [root]).done));
  assert.deepEqual(await fs.readdir(root), []);
});

test("observations persist source provenance", async t => {
  const { root } = await fixture(t);
  for (const source of ["user", "derived", "manual", "untrusted"]) {
    const saved = await remember(root, cwd, null, { text: "source fact", scope: "global", source });
    const expected = source === "untrusted" ? "unknown" : source;
    assert.match(await fs.readFile(saved.path, "utf8"), new RegExp(`source: ${expected}\\n`));
  }
});

test("aborted mutations do not commit topic or observation changes", async t => {
  const { root } = await fixture(t);
  const saved = await remember(root, cwd, null, { text: "keep me", scope: "global" });
  const before = await snapshot(root);
  const signal = AbortSignal.abort(new Error("disabled"));
  await assert.rejects(() => remember(root, cwd, null, { text: "never saved" }, { signal }), /disabled/);
  await assert.rejects(() => deleteEntry(root, saved.path, null, { signal }), /disabled/);
  await assert.rejects(() => atomicWrite(saved.path, "replacement", root, { signal }), /disabled/);
  assert.deepEqual(await snapshot(root), before);
});

test("search reports unreadable oversized topics rather than successful no hits", async t => {
  const { root } = await fixture(t);
  await ensureLayout(root, cwd, null);
  await fs.writeFile(path.join(root, "global/topics/large.md"), "# Large\n\nneedle\n" + "x".repeat(MAX_TOPIC_BYTES));
  const tools = [];
  registerMemoryTools({ tools: { register(tool) { tools.push(tool); } } }, { root, cwdOf: () => cwd });
  await assert.rejects(() => tools[2].execute({ query: "needle" }), /search could not read.*file too large/);
});
