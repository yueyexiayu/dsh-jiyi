import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  remember,
  saveSettings,
  workspaceId,
} from "../lib/storage.js";

const TEST_CWD = "/Users/ning/.dsh/jiyi-test-workspace";
import { slugify } from "../lib/parse.js";

test("normalizeOrigin extracts org/repo", () => {
  assert.equal(normalizeOrigin("git@github.com:xai-org/grok-build.git"), "xai-org/grok-build");
  assert.equal(normalizeOrigin("https://github.com/openai/codex.git"), "openai/codex");
  assert.equal(normalizeOrigin("https://github.com/openai/codex"), "openai/codex");
});

test("workspaceId is stable for origin", () => {
  const a = workspaceId("/tmp/a", "acme/app");
  const b = workspaceId("/elsewhere/app", "acme/app");
  assert.equal(a, b);
  assert.match(a, /^app-[a-f0-9]{8}$/);
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
