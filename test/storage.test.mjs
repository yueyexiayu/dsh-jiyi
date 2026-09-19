import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  classifyRelative,
  deleteEntry,
  isEphemeralCwd,
  listEntries,
  loadSettings,
  normalizeOrigin,
  observationStamp,
  readEntry,
  regenerateManifest,
  remember,
  saveSettings,
  workspaceId,
} from "../lib/storage.js";
import { MAX_MANIFEST_BYTES, MAX_NOTE_BYTES } from "../lib/parse.js";

const TEST_CWD = "/Users/ning/.dsh/jiyi-test-workspace";
import { slugify } from "../lib/parse.js";

test("normalizeOrigin keeps host and full repo path", () => {
  assert.equal(normalizeOrigin("git@github.com:xai-org/grok-build.git"), "github.com/xai-org/grok-build");
  assert.equal(normalizeOrigin("https://github.com/openai/codex.git"), "github.com/openai/codex");
  assert.equal(normalizeOrigin("https://github.com/openai/codex"), "github.com/openai/codex");
  assert.equal(normalizeOrigin("ssh://git@github.com/openai/codex.git"), "github.com/openai/codex");
  assert.equal(normalizeOrigin("https://gitlab.com/team/app.git"), "gitlab.com/team/app");
  assert.notEqual(
    normalizeOrigin("https://github.com/team/app.git"),
    normalizeOrigin("https://gitlab.com/team/app.git"),
  );
});

test("workspaceId is stable for origin", () => {
  const a = workspaceId("/tmp/a", "acme/app");
  const b = workspaceId("/elsewhere/app", "acme/app");
  assert.equal(a, b);
  assert.match(a, /^app-[a-f0-9]{8}$/);
  assert.notEqual(
    workspaceId("/repo", "github.com/team/app"),
    workspaceId("/repo", "gitlab.com/team/app"),
  );
});

test("remember writes inbox and regenerates manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = TEST_CWD;
  const saved = await remember(root, cwd, null, { text: "run tests with just test", topicHint: "testing" });
  assert.equal(saved.scope, "workspace");
  const file = await readFile(saved.path, "utf8");
  assert.match(file, /run tests with just test/);
  const listed = await listEntries(root, cwd, null);
  const inbox = listed.entries.filter((item) => item.group === "inbox" && item.scope === "workspace");
  assert.equal(inbox.length, 1);
  const index = listed.entries.find((item) => item.generated && item.scope === "workspace");
  const manifest = await readFile(index.path, "utf8");
  assert.match(manifest, /Inbox: 1/);
});

test("delete refuses MEMORY.md and allows inbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = TEST_CWD;
  const saved = await remember(root, cwd, null, { text: "prefer concise answers", scope: "global" });
  await assert.rejects(() => deleteEntry(root, path.join(root, "global", "MEMORY.md")), /protected/);
  const deleted = await deleteEntry(root, saved.path);
  assert.ok(deleted.path);
  await assert.rejects(() => readEntry(root, saved.path));
});

test("workspace remember without cwd fails instead of writing global", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  await assert.rejects(
    () => remember(root, null, null, { text: "use just test", scope: "workspace" }),
    /no workspace/,
  );
});

test("temp subdirectories are ephemeral", () => {
  assert.equal(isEphemeralCwd(path.join(tmpdir(), "proj")), true);
  assert.equal(isEphemeralCwd("/tmp/foo"), true);
  assert.equal(isEphemeralCwd(TEST_CWD), false);
});

test("observationStamp separates date and time", () => {
  assert.equal(observationStamp("2026-09-18T09:18:05.000Z"), "2026-09-18-09-18-05");
});

test("settings default enabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  assert.deepEqual(await loadSettings(root), {
    enabled: true,
    extractPrimary: "glm-5.3-flash",
    extractFallbacks: ["deepseek-flash"],
  });
  await saveSettings(root, { enabled: false });
  const next = await loadSettings(root);
  assert.equal(next.enabled, false);
  assert.equal(next.extractPrimary, "glm-5.3-flash");
  assert.deepEqual(next.extractFallbacks, ["deepseek-flash"]);
});

test("classifyRelative recognizes layout", () => {
  assert.equal(classifyRelative("MEMORY.md"), "index");
  assert.equal(classifyRelative("topics/testing.md"), "topic");
  assert.equal(classifyRelative("observations/_inbox/n.md"), "inbox");
  assert.equal(classifyRelative("topics/nested/no.md"), "other");
});

test("slugify keeps CJK", () => {
  assert.equal(slugify("测试 约定"), "测试-约定");
});

test("remember rejects non-string text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  await assert.rejects(
    () => remember(root, TEST_CWD, null, { text: { foo: 1 } }),
    /must be a string/,
  );
  await assert.rejects(
    () => remember(root, TEST_CWD, null, { statement: 12 }),
    /must be a string/,
  );
  const listed = await listEntries(root, TEST_CWD, null);
  assert.equal(listed.entries.filter((item) => item.group === "inbox").length, 0);
});

test("path escape is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.md`);
  await writeFile(outside, "nope");
  await assert.rejects(() => readEntry(root, outside), /escapes/);
});

test("corrupt settings recover to defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  await writeFile(path.join(root, "settings.json"), "null");
  assert.equal((await loadSettings(root)).enabled, true);
  await writeFile(path.join(root, "settings.json"), "{");
  assert.equal((await loadSettings(root)).enabled, true);
});

test("remember rejects oversized body", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  await assert.rejects(
    () => remember(root, TEST_CWD, null, { text: "short", body: "x".repeat(MAX_NOTE_BYTES + 20) }),
    /too large/,
  );
});

test("concurrent remember writes all inbox files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => remember(root, TEST_CWD, null, { text: `fact ${i} about the project` })),
  );
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 8);
  const listed = await listEntries(root, TEST_CWD, null);
  assert.equal(listed.entries.filter((item) => item.group === "inbox" && item.scope === "workspace").length, 8);
});

test("manifest truncation respects utf8 bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const listed = await listEntries(root, TEST_CWD, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  await mkdir(path.join(wsDir, "topics"), { recursive: true });
  for (let i = 0; i < 25; i += 1) {
    const title = `中文标题很长很长很长-${i}`;
    const desc = "这是一段用于撑满索引预算的中文描述，重复几次。".repeat(4);
    await writeFile(path.join(wsDir, "topics", `topic-${i}.md`), `# ${title}\n\n${desc}\n`);
  }
  const manifest = await regenerateManifest(wsDir);
  assert.ok(Buffer.byteLength(manifest, "utf8") <= MAX_MANIFEST_BYTES);
});

test("directory symlink outside store is not listed or written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const outside = await mkdtemp(path.join(tmpdir(), "jiyi-out-"));
  await writeFile(path.join(outside, "secret.md"), "# Secret\n\nexternal\n");
  await listEntries(root, TEST_CWD, null);
  const { rm } = await import("node:fs/promises");
  const globalTopics = path.join(root, "global", "topics");
  await rm(globalTopics, { recursive: true, force: true });
  await symlink(outside, globalTopics);
  const listed = await listEntries(root, TEST_CWD, null);
  assert.equal(listed.entries.filter((item) => item.scope === "global" && item.group === "topics").length, 0);

  const inbox = path.join(root, "global", "observations", "_inbox");
  await rm(inbox, { recursive: true, force: true });
  await symlink(outside, inbox);
  await assert.rejects(
    () => remember(root, TEST_CWD, null, { text: "should not write outside", scope: "global" }),
    /escapes/,
  );
});

test("github and gitlab clones do not share a workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const github = await remember(root, TEST_CWD, "github.com/team/app", { text: "github only fact" });
  const gitlab = await remember(root, TEST_CWD, "gitlab.com/team/app", { text: "gitlab only fact" });
  assert.notEqual(github.path, gitlab.path);
  await assert.rejects(
    () => readEntry(root, github.path, { cwd: TEST_CWD, origin: "gitlab.com/team/app" }),
    /escapes current memory scopes/,
  );
});

test("readEntry with bounds cannot read another workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const saved = await remember(root, "/Users/ning/.dsh/jiyi-other-workspace", "github.com/other/app", {
    text: "other repo fact",
    topicHint: "notes",
  });
  await assert.rejects(
    () => readEntry(root, saved.path, { cwd: TEST_CWD, origin: "github.com/acme/app" }),
    /escapes current memory scopes/,
  );
});
