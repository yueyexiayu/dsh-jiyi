import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { applyDreamPlan, conflictsWith, dreamAll, mergeIntoTopic, parseDreamPlan, parseObservation, pickVia, sanitizeTopicContent } from "../lib/dream.js";
import { extractRouteList } from "../lib/parse.js";
import { remember } from "../lib/storage.js";

test("parseObservation reads frontmatter", () => {
  const parsed = parseObservation("---\ntype: project\ntopic: testing\ncreated: 2026-01-01T00:00:00.000Z\n---\n\nuse just test\n");
  assert.equal(parsed.topicHint, "testing");
  assert.equal(parsed.statement, "use just test");
});

test("mergeIntoTopic is idempotent on same statement", () => {
  const first = mergeIntoTopic("", { statement: "use just test", topicHint: "testing", created: "2026-04-01" });
  const second = mergeIntoTopic(first, { statement: "use just test", topicHint: "testing", created: "2026-04-02" });
  assert.equal(first, second);
  assert.match(first, /^# Testing/);
});

test("parseDreamPlan keeps only valid topic files", () => {
  const plan = parseDreamPlan(`\`\`\`json
{"topics":[
  {"slug":"Testing Stuff","content":"# Testing\\n\\nUse just test.\\n"},
  {"slug":"bad","content":"no heading"},
  {"slug":"x","content":""}
]}
\`\`\``);
  assert.equal(plan.topics.length, 1);
  assert.equal(plan.topics[0].slug, "testing-stuff");
  assert.match(plan.topics[0].content, /^# Testing/);
  assert.deepEqual(plan.rename, []);
  assert.deepEqual(plan.delete, []);
});

test("parseDreamPlan reads rename and delete", () => {
  const plan = parseDreamPlan(JSON.stringify({
    topics: [{ slug: "testing", content: "# Testing\n\njust test\n" }],
    rename: [{ from: "notes", to: "testing" }],
    delete: ["obsolete", "testing"],
  }));
  assert.deepEqual(plan.rename, [{ from: "notes", to: "testing" }]);
  assert.deepEqual(plan.delete, ["obsolete", "testing"]);
});

test("applyDreamPlan splits, renames, and deletes leftovers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jiyi-topics-"));
  await writeFile(path.join(dir, "notes.md"), "# Notes\n\n- just test\n- use pnpm\n");
  await writeFile(path.join(dir, "obsolete.md"), "# Obsolete\n\nold\n");
  const applied = await applyDreamPlan(dir, parseDreamPlan(JSON.stringify({
    topics: [
      { slug: "testing", content: "# Testing\n\nUse just test.\n" },
      { slug: "tooling", content: "# Tooling\n\nUse pnpm.\n" },
    ],
    rename: [{ from: "notes", to: "testing" }],
    delete: ["obsolete", "notes"],
  })));
  assert.deepEqual(applied.written.sort(), ["testing", "tooling"]);
  assert.equal(await readFile(path.join(dir, "testing.md"), "utf8"), "# Testing\n\nUse just test.\n");
  await assert.rejects(() => readFile(path.join(dir, "notes.md"), "utf8"));
  await assert.rejects(() => readFile(path.join(dir, "obsolete.md"), "utf8"));
});

test("sanitizeTopicContent drops invented fallbacks", () => {
  const text = sanitizeTopicContent("# Testing\n\n- Use just test\n- If just test is unavailable or fails, fall back to cargo test\n");
  assert.match(text, /just test/);
  assert.doesNotMatch(text, /fall back/);
});

test("sanitizeTopicContent keeps user-stated fallbacks", () => {
  const decision = "如果主测试失败则运行离线备选命令";
  const text = sanitizeTopicContent(`# Testing\n\n- ${decision}\n`, [decision]);
  assert.match(text, /备选命令/);
});

test("parseDreamPlan rejects missing topics", () => {
  assert.throws(() => parseDreamPlan("{}"), /malformed/);
  assert.throws(() => parseDreamPlan("{\"rename\":[],\"delete\":[]}"), /malformed/);
});

test("pickVia does not let noop cover failed", () => {
  assert.equal(pickVia("failed", "noop"), "failed");
  assert.equal(pickVia("noop", "failed"), "failed");
  assert.equal(pickVia("llm", "failed"), "failed");
});

test("dream folds inbox into topics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "use just test", topicHint: "testing" });
  await remember(root, cwd, null, { text: "prefer concise answers", scope: "global", topicHint: "preferences" });
  const globalDir = path.join(root, "global");
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const result = await dreamAll(globalDir, wsDir);
  assert.ok(result.merged >= 2);
  const testing = await readFile(path.join(wsDir, "topics", "testing.md"), "utf8");
  assert.match(testing, /just test/);
  const prefs = await readFile(path.join(globalDir, "topics", "preferences.md"), "utf8");
  assert.match(prefs, /concise/);
});

test("dream uses Flash plan when apiKey is provided", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "use just test", topicHint: "testing" });
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const result = await dreamAll(path.join(root, "global"), wsDir, {
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                topics: [{ slug: "testing", content: "# Testing\n\nAlways run `just test`.\n" }],
              }),
            },
          }],
        }),
      };
    },
  });
  assert.equal(result.via, "llm");
  const testing = await readFile(path.join(wsDir, "topics", "testing.md"), "utf8");
  assert.match(testing, /Always run `just test`/);
  const after = await listEntries(root, cwd, null);
  const inbox = after.entries.filter((item) => item.scope === "workspace" && item.group === "inbox");
  assert.equal(inbox.length, 0);
});

test("dream pool failure leaves inbox and does not rule-merge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "use just test", topicHint: "testing" });
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const result = await dreamAll(path.join(root, "global"), wsDir, {
    routes: extractRouteList(),
    keys: { ZAI_CODING_CN_API_KEY: "zai" },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(result.via, "failed");
  const after = await listEntries(root, cwd, null);
  const inbox = after.entries.filter((item) => item.scope === "workspace" && item.group === "inbox");
  assert.equal(inbox.length, 1);
});

test("conflictsWith detects negated existing facts", () => {
  const existing = "# Testing\n\n- Use just test, never cargo test\n";
  assert.equal(conflictsWith(existing, "Use just test, never cargo test"), false);
  assert.equal(conflictsWith(existing, "switch to cargo test"), true);
  assert.equal(conflictsWith(existing, "prefer concise replies"), false);
});

test("empty dream plan archives inbox", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "use just test", topicHint: "testing" });
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const result = await dreamAll(path.join(root, "global"), wsDir, {
    routes: extractRouteList(),
    keys: { ZAI_CODING_CN_API_KEY: "zai" },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"topics\":[],\"rename\":[],\"delete\":[]}" } }],
      }),
    }),
  });
  assert.equal(result.via, "noop");
  const after = await listEntries(root, cwd, null);
  assert.equal(after.entries.filter((item) => item.scope === "workspace" && item.group === "inbox").length, 0);
  assert.equal(after.entries.filter((item) => item.scope === "workspace" && item.group === "archive").length, 0);
});

test("apiKey empty plan archives instead of rule-merging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "use just test", topicHint: "testing" });
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const result = await dreamAll(path.join(root, "global"), wsDir, {
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ topics: [], rename: [], delete: [] }) } }],
      }),
    }),
  });
  assert.equal(result.via, "noop");
  const after = await listEntries(root, cwd, null);
  assert.equal(after.entries.filter((item) => item.scope === "workspace" && item.group === "inbox").length, 0);
  assert.equal(after.entries.filter((item) => item.scope === "workspace" && item.group === "topics").length, 0);
});

test("malformed empty object keeps inbox and fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "use just test", topicHint: "testing" });
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const result = await dreamAll(path.join(root, "global"), wsDir, {
    routes: extractRouteList(),
    keys: { ZAI_CODING_CN_API_KEY: "zai" },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "{}" } }] }),
    }),
  });
  assert.equal(result.via, "failed");
  const after = await listEntries(root, cwd, null);
  assert.equal(after.entries.filter((item) => item.scope === "workspace" && item.group === "inbox").length, 1);
});

test("in-flight dream does not resurrect a deleted topic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "use just test", topicHint: "testing" });
  const { deleteEntry, listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const topicPath = path.join(wsDir, "topics", "testing.md");
  await writeFile(topicPath, "# Testing\n\n- old\n");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = dreamAll(path.join(root, "global"), wsDir, {
    routes: extractRouteList(),
    keys: { ZAI_CODING_CN_API_KEY: "zai" },
    fetchImpl: async () => {
      entered();
      await gate;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                topics: [{ slug: "testing", content: "# Testing\n\nresurrected\n" }],
                rename: [],
                delete: [],
              }),
            },
          }],
        }),
      };
    },
  });
  await started;
  await deleteEntry(root, topicPath);
  release();
  await pending;
  await assert.rejects(() => readFile(topicPath, "utf8"));
});

test("in-flight dream does not merge a deleted inbox observation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "keep this workspace fact", topicHint: "notes" });
  const removed = await remember(root, cwd, null, { text: "delete this inbox fact", topicHint: "notes" });
  const { deleteEntry, listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = dreamAll(path.join(root, "global"), wsDir, {
    routes: extractRouteList(),
    keys: { ZAI_CODING_CN_API_KEY: "zai" },
    fetchImpl: async () => {
      entered();
      await gate;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                topics: [{
                  slug: "notes",
                  content: "# Notes\n\n- keep this workspace fact\n- delete this inbox fact\n",
                }],
                rename: [],
                delete: [],
              }),
            },
          }],
        }),
      };
    },
  });
  await started;
  await deleteEntry(root, removed.path);
  release();
  await pending;
  const topic = await readFile(path.join(wsDir, "topics", "notes.md"), "utf8");
  assert.match(topic, /keep this workspace fact/);
  assert.doesNotMatch(topic, /delete this inbox fact/);
});

test("conflicting observation is kept visible and not merged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  await writeFile(path.join(wsDir, "topics", "testing.md"), "# Testing\n\n- Use just test, never cargo test\n");
  await remember(root, cwd, null, { text: "switch to cargo test", topicHint: "testing" });
  await dreamAll(path.join(root, "global"), wsDir);
  const after = await listEntries(root, cwd, null);
  assert.equal(after.entries.filter((item) => item.group === "conflict").length, 1);
  assert.equal(after.entries.filter((item) => item.group === "inbox").length, 0);
  const topic = await readFile(path.join(wsDir, "topics", "testing.md"), "utf8");
  assert.match(topic, /just test/);
  assert.doesNotMatch(topic, /switch to cargo test/);
});

test("failed global is not covered by workspace noop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-"));
  const cwd = "/Users/ning/.dsh/jiyi-test-workspace";
  await remember(root, cwd, null, { text: "prefer concise answers", scope: "global", topicHint: "preferences" });
  const { listEntries } = await import("../lib/storage.js");
  const listed = await listEntries(root, cwd, null);
  const wsDir = path.dirname(listed.entries.find((item) => item.scope === "workspace" && item.group === "index").path);
  const result = await dreamAll(path.join(root, "global"), wsDir, {
    routes: extractRouteList(),
    keys: { ZAI_CODING_CN_API_KEY: "zai" },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(result.via, "failed");
  assert.equal(result.remaining >= 1, true);
});
