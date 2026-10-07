import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { apply } from "../lib/index.js";
import { ensureLayout, remember, loadSettings, listEntries } from "../lib/storage.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await tick(); }
  throw new Error("condition did not settle");
}
async function fixture(fn, keys = false) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "jiyi-host-safe-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const session = { id: "s1", header: { cwd: home } };
  const agent = { session };
  const listeners = new Map();
  let handler;
  const ctx = {
    credentials: { resolve: async () => keys ? { value: "fixture-not-a-real-key" } : null },
    tools: { register() {} },
    get: () => new Map([["s1", agent]]),
    on(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    connection: { fetch: { register(def) { handler = def.fetch; } } },
  };
  const emit = async (name, ...args) => { let out; for (const fn of listeners.get(name) || []) out = await fn(...args); return out; };
  const call = (action, extra = {}) => handler(new Request("http://fixture/api/jiyi", {
    method: "POST", body: JSON.stringify({ action, sessionId: "s1", ...extra }),
  }));
  const status = async () => (await call("status")).json();
  try {
    apply(ctx);
    await until(async () => (await status()).lastDream.at !== null);
    await fn({ home, root: path.join(home, "jiyi"), call, status, emit, agent });
  } finally {
    await emit("dispose");
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
}

test("injection preserves downstream metadata and refreshes changed/empty indexes", async () => {
  await fixture(async ({ root, home, emit, agent }) => {
    const { globalDir } = await ensureLayout(root, home, null);
    const file = path.join(globalDir, "topics", "testing.md");
    await fs.writeFile(file, "# Testing\n\nRun just test.\n");
    const decision = { kind: "enter", startsRequestSeries: true, futureMetadata: { value: 7 }, messages: [{ id: "user", role: "user", content: "hello" }] };
    const pre = () => emit("agent/pre-step", { agent, step: 1, signal: new AbortController().signal }, async () => decision);
    const first = await pre();
    assert.equal(first.startsRequestSeries, true);
    assert.deepEqual(first.futureMetadata, { value: 7 });
    assert.equal(first.messages.length, 2);
    assert.equal((await pre()).messages.length, 1, "unchanged index is not repeated");
    await fs.writeFile(file, "# New testing\n\nUse npm test.\n");
    assert.match((await pre()).messages[1].content[0].text, /New testing/);
    await fs.unlink(file);
    assert.match((await pre()).messages[1].content[0].text, /已无记忆主题/);
    assert.equal((await pre()).messages.length, 1);
  });
});

test("disable cancels active and queued consolidation even if fetch ignores abort", { timeout: 10000 }, async () => {
  const originalFetch = globalThis.fetch;
  const entered = deferred(), release = deferred();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    entered.resolve();
    await release.promise;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      topics: [{ slug: "testing", title: "Testing", content: "# Testing\n\nUse just test." }],
    }) } }] }) };
  };
  try {
    await fixture(async ({ root, home, call, status }) => {
      await remember(root, home, null, { scope: "global", text: "Use just test" });
      const first = call("dream");
      await entered.promise;
      const queued = call("dream");
      const disabled = call("toggle");
      await until(async () => (await loadSettings(root)).enabled === false);
      release.resolve();
      assert.equal((await disabled).status, 200);
      assert.equal((await first).status, 409);
      assert.equal((await queued).status, 409);
      const listed = await listEntries(root, home, null);
      assert.equal(listed.entries.filter((x) => x.group === "inbox").length, 1);
      assert.equal(listed.entries.filter((x) => x.group === "topics").length, 0);
      assert.equal((await status()).lastDream.status, "cancelled");
      assert.equal(requests, 1);
    }, true);
  } finally { release.resolve(); globalThis.fetch = originalFetch; }
});

test("disable prevents a late extraction response from saving observations", { timeout: 10000 }, async () => {
  const originalFetch = globalThis.fetch;
  const entered = deferred(), release = deferred();
  globalThis.fetch = async () => {
    entered.resolve();
    await release.promise;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      outcome: "observations", observations: [{ type: "user", scope: "global", statement: "默认测试使用 just test" }],
    }) } }] }) };
  };
  try {
    await fixture(async ({ root, home, call, status, emit, agent }) => {
      await emit("agent/created", { agent });
      await emit("session/event", agent.session, { type: "turn/start", data: { turn: 1 } });
      await emit("session/event", agent.session, { type: "user/message", data: {
        source: { kind: "user" }, content: [{ type: "text", text: "默认测试使用 just test" }],
      } });
      await emit("session/event", agent.session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
      await entered.promise;
      const disabled = call("toggle");
      await until(async () => !(await loadSettings(root)).enabled);
      release.resolve();
      assert.equal((await disabled).status, 200);
      assert.equal((await status()).lastCapture.status, "cancelled");
      assert.equal((await listEntries(root, home, null)).entries.length, 0);
    }, true);
  } finally { release.resolve(); globalThis.fetch = originalFetch; }
});

test("parallel toggles each apply one atomic transition", async () => {
  await fixture(async ({ call, status }) => {
    const responses = await Promise.all([call("toggle"), call("toggle")]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.equal((await status()).enabled, true);
  });
});

test("unexpected API errors do not expose exception contents", async () => {
  await fixture(async ({ call, root, home }) => {
    await ensureLayout(root, home, null);
    await fs.writeFile(path.join(root, "settings.json"), "{secret-invalid");
    const response = await call("status");
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(JSON.stringify(await response.json()), /secret-invalid/);
  });
});
