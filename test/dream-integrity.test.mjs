import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dreamScope, parseDreamPlan, recoverDreamTransaction, MAX_DREAM_BATCH, MAX_DREAM_INPUT_CHARS } from "../lib/dream.js";
import { ensureLayout, remember } from "../lib/storage.js";

const reply = (plan) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }) });
async function fixture(count = 1) {
  const root = await mkdtemp(path.join(tmpdir(), "jiyi-integrity-"));
  const { globalDir: scope } = await ensureLayout(root, "/tmp/fixture-project", null);
  for (let i = 0; i < count; i++) await remember(root, "/tmp/fixture-project", null, { text: `Use durable convention ${i}`, scope: "global", topicHint: "notes" });
  return { root, scope, inbox: path.join(scope, "observations", "_inbox"), topics: path.join(scope, "topics") };
}

test("partial invalid and oversized plans never consume observations", async () => {
  for (const topics of [
    [{ slug: "one", content: "# One\n\nFact" }, { slug: "two", content: "missing title" }],
    Array.from({ length: 17 }, (_, i) => ({ slug: `topic-${i}`, content: `# Topic ${i}\n\nFact` })),
  ]) {
    const f = await fixture(2);
    const result = await dreamScope(f.scope, { apiKey: "fake", fetchImpl: reply({ topics }) });
    assert.equal(result.via, "failed");
    assert.equal(result.merged, 0);
    assert.equal((await readdir(f.inbox)).length, 2);
    assert.deepEqual(await readdir(f.topics), []);
  }
});

test("existing explicitly sourced fallback survives consolidation", async () => {
  const f = await fixture();
  await writeFile(path.join(f.topics, "notes.md"), "# Notes\n\n- If unavailable, fall back to offline tests\n");
  const result = await dreamScope(f.scope, { apiKey: "fake", fetchImpl: reply({ topics: [{ slug: "notes", content: "# Notes\n\n- If unavailable, fall back to offline tests\n- Use durable convention 0" }] }) });
  assert.equal(result.merged, 0);
  assert.equal(result.processed, 1);
  assert.equal(result.coverage, "unverified");
  assert.match(await readFile(path.join(f.topics, "notes.md"), "utf8"), /fall back to offline tests/);
  assert.equal((await readdir(path.join(f.scope, "archive"))).filter((n) => n.endsWith(".md")).length, 1);
  const journal = (await readdir(path.join(f.scope, "archive"))).find((n) => n.endsWith(".json"));
  assert.match(await readFile(path.join(f.scope, "archive", journal), "utf8"), /fall back to offline tests/);
});

test("noop reports archived not merged and retains recoverable source", async () => {
  const f = await fixture();
  const result = await dreamScope(f.scope, { apiKey: "fake", fetchImpl: reply({ topics: [] }) });
  assert.equal(result.merged, 0);
  assert.equal(result.archived, 1);
  assert.equal((await readdir(f.inbox)).length, 0);
  const archive = path.join(f.scope, "archive");
  const name = (await readdir(archive)).find((n) => n.endsWith(".md"));
  assert.match(await readFile(path.join(archive, name), "utf8"), /durable convention 0/);
});

test("batch and prompt budgets defer unconsumed inputs", async () => {
  const f = await fixture(MAX_DREAM_BATCH + 3);
  let prompt;
  const result = await dreamScope(f.scope, { apiKey: "fake", fetchImpl: async (url, init) => {
    prompt = JSON.parse(init.body).messages[1].content;
    return reply({ topics: [] })();
  } });
  assert.ok(prompt.length <= MAX_DREAM_INPUT_CHARS);
  assert.equal(JSON.parse(prompt).observations.length, MAX_DREAM_BATCH);
  assert.equal(result.remaining, 3);
  assert.equal((await readdir(f.inbox)).length, 3);
});

test("oversized existing context fails explicitly without network or input loss", async () => {
  const f = await fixture();
  await writeFile(path.join(f.topics, "large.md"), `# Large\n${"x".repeat(MAX_DREAM_INPUT_CHARS)}`);
  const result = await dreamScope(f.scope, { apiKey: "fake", fetchImpl: () => { throw new Error("must not request"); } });
  assert.equal(result.via, "failed");
  assert.match(result.error, /budget/);
  assert.equal((await readdir(f.inbox)).length, 1);
});

test("abort after model response cannot write topics or consume inputs", async () => {
  const f = await fixture();
  const controller = new AbortController();
  await assert.rejects(dreamScope(f.scope, { apiKey: "fake", signal: controller.signal, fetchImpl: async () => {
    controller.abort();
    return reply({ topics: [{ slug: "notes", content: "# Notes\n\nBad write" }] })();
  } }), { name: "AbortError" });
  assert.deepEqual(await readdir(f.topics), []);
  assert.equal((await readdir(f.inbox)).length, 1);
});

test("commit failure rolls back earlier topic writes and preserves input", async () => {
  const f = await fixture();
  await writeFile(path.join(f.topics, "one.md"), "# One\n\noriginal");
  await writeFile(path.join(f.topics, "source.md"), "# Source\n\noriginal");
  await writeFile(path.join(f.topics, "target.md"), "# Target\n\noriginal");
  await assert.rejects(dreamScope(f.scope, { apiKey: "fake", fetchImpl: reply({
    topics: [{ slug: "one", content: "# One\n\nchanged" }], rename: [{ from: "source", to: "target" }],
  }) }), /destination exists/);
  assert.equal(await readFile(path.join(f.topics, "one.md"), "utf8"), "# One\n\noriginal");
  assert.equal((await readdir(f.inbox)).length, 1);
  await assert.rejects(readFile(path.join(f.scope, ".dream-transaction.json")), { code: "ENOENT" });
});

test("interrupted transaction is rolled back on recovery", async () => {
  const f = await fixture(0);
  await writeFile(path.join(f.topics, "notes.md"), "# Notes\n\npartial");
  await writeFile(path.join(f.scope, ".dream-transaction.json"), JSON.stringify({ version: 1,
    before: [{ name: "notes.md", text: "# Notes\n\noriginal" }, { name: "new.md", text: null }],
    inbox: [{ name: "recovered.md", text: "durable original input" }],
  }));
  await writeFile(path.join(f.topics, "new.md"), "# New\npartial");
  await recoverDreamTransaction(f.scope);
  assert.equal(await readFile(path.join(f.topics, "notes.md"), "utf8"), "# Notes\n\noriginal");
  assert.equal(await readFile(path.join(f.inbox, "recovered.md"), "utf8"), "durable original input");
  await assert.rejects(readFile(path.join(f.topics, "new.md")), { code: "ENOENT" });
});

test("invalid later journal entries cannot partially restore earlier topics", async () => {
  for (const invalid of ["topic", "input", "symlink", "conflict"]) {
    const f = await fixture(0);
    const topic = path.join(f.topics, "notes.md");
    await writeFile(topic, "# Notes\n\ncurrent must remain");
    const journal = { version: 1, before: [{ name: "notes.md", text: "# Notes\n\nold" }], inbox: [] };
    if (invalid === "topic") journal.before.push({ name: "../escape.md", text: "invalid" });
    if (invalid === "input") journal.inbox.push({ name: "../escape.md", text: "invalid" });
    if (invalid === "symlink") {
      const external = path.join(f.root, "external.md");
      await writeFile(external, "untouched");
      await symlink(external, path.join(f.inbox, "unsafe.md"));
      journal.inbox.push({ name: "unsafe.md", text: "invalid" });
    }
    if (invalid === "conflict") {
      await writeFile(path.join(f.inbox, "conflicting.md"), "new input");
      journal.inbox.push({ name: "conflicting.md", text: "old input" });
    }
    const journalPath = path.join(f.scope, ".dream-transaction.json");
    const text = JSON.stringify(journal);
    await writeFile(journalPath, text);
    await assert.rejects(recoverDreamTransaction(f.scope), /invalid|symlink|symbolic|conflict/i);
    assert.equal(await readFile(topic, "utf8"), "# Notes\n\ncurrent must remain");
    assert.equal(await readFile(journalPath, "utf8"), text);
  }
});

test("symlink output target never overwrites outside files", async () => {
  const f = await fixture();
  const external = path.join(f.root, "outside.md");
  await writeFile(external, "outside untouched");
  await symlink(external, path.join(f.topics, "notes.md"));
  await assert.rejects(dreamScope(f.scope, { apiKey: "fake", fetchImpl: reply({ topics: [{ slug: "notes", content: "# Notes\n\nchanged" }] }) }), /symlink|symbolic/i);
  assert.equal(await readFile(external, "utf8"), "outside untouched");
  assert.equal((await readdir(f.inbox)).length, 1);
});

test("schema rejects malformed operation collections and duplicate slugs", () => {
  for (const plan of [ { topics: [], rename: "bad" }, { topics: [], delete: {} },
    { topics: [{ slug: "a", content: "# A\nfact" }, { slug: "a", content: "# A\nother" }] },
  ]) assert.throws(() => parseDreamPlan(JSON.stringify(plan)), /malformed/);
});
