import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { apply } from "../lib/index.js";
import { ensureLayout, remember, loadSettings, listEntries } from "../lib/storage.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await tick(); }
  throw new Error("condition did not settle");
}
async function fixture(fn, keys = false) {
  const home = await fs.mkdtemp("/tmp/jiyi-host-safe-");
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const session = { id: "s1", header: { cwd: home } };
  const agent = { session };
  const agents = new Map([["s1", agent]]);
  const listeners = new Map();
  let handler;
  const ctx = {
    credentials: { resolve: async () => keys ? { value: "fixture-not-a-real-key" } : null },
    tools: { register() {} },
    get: (name) => name === "agents" ? agents : undefined,
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
    await fn({ home, root: path.join(home, "jiyi"), call, status, emit, agent, agents });
  } finally {
    await emit("dispose");
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
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

test("injection failure and success remain isolated between sessions", async () => {
  await fixture(async ({ home, root, emit, agent, agents, call, status }) => {
    const { globalDir } = await ensureLayout(root, home, null);
    await fs.writeFile(path.join(globalDir, "topics", "testing.md"), "# Testing\n\nUse just test.\n");
    await fs.writeFile(path.join(root, "settings.json"), "{corrupt-fixture");
    const pre = (current) => emit("agent/pre-step", { agent: current, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [{ role: "user", content: "hi" }] }));
    await pre(agent);
    await fs.unlink(path.join(root, "settings.json"));
    const other = { session: { id: "s2", header: { cwd: home } } }; agents.set("s2", other);
    await pre(other);
    const first = (await status()).lastInjection;
    const second = (await (await call("status", { sessionId: "s2" })).json()).lastInjection;
    assert.equal(first.status, "failed"); assert.equal(first.sessionId, "s1");
    assert.equal(second.status, "injected"); assert.equal(second.sessionId, "s2");
  });
});

test("parallel toggles each apply one atomic transition", async () => {
  await fixture(async ({ call, status }) => {
    const responses = await Promise.all([call("toggle"), call("toggle")]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.equal((await status()).enabled, true);
  });
});

test("plugin dispose waits for an admitted extraction even when fetch ignores abort", async () => {
  const originalFetch = globalThis.fetch; const entered = deferred(), release = deferred();
  globalThis.fetch = async () => { entered.resolve(); await release.promise; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ outcome: "observations", observations: [{ type: "user", scope: "global", statement: "默认测试使用 just test" }] }) } }] }) }; };
  try {
    await fixture(async ({ emit, agent, status, root, home }) => {
      await emit("agent/created", { agent });
      await emit("session/event", agent.session, { type: "turn/start", data: { turn: 1 } });
      await emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "默认测试使用 just test" }] } });
      await emit("session/event", agent.session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
      await entered.promise; let disposed = false;
      const disposal = emit("dispose").then(() => { disposed = true; });
      await tick(); assert.equal(disposed, false);
      release.resolve(); await disposal;
      assert.equal((await status()).lastCapture.status, "cancelled");
      assert.equal((await listEntries(root, home, null)).entries.length, 0);
    }, true);
  } finally { release.resolve(); globalThis.fetch = originalFetch; }
});

test("late completed-turn extraction cannot overwrite newer cancelled-turn status", async () => {
  const originalFetch = globalThis.fetch;
  const entered = deferred(), release = deferred();
  globalThis.fetch = async () => {
    entered.resolve(); await release.promise;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ outcome: "noop" }) } }] }) };
  };
  try {
    await fixture(async ({ emit, agent, status, call }) => {
      await emit("agent/created", { agent });
      await emit("session/event", agent.session, { type: "turn/start", data: { turn: 1 } });
      await emit("session/event", agent.session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "默认测试使用 just test" }] } });
      await emit("session/event", agent.session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
      await entered.promise;
      await emit("session/event", agent.session, { type: "turn/start", data: { turn: 2 } });
      await emit("session/event", agent.session, { type: "turn/end", data: { turn: 2, reason: { kind: "aborted", reason: { kind: "user" } } } });
      release.resolve();
      await until(async () => (await (await call("status", { sessionId: "" })).json()).lastCapture.status === "noop");
      const capture = (await status()).lastCapture;
      assert.equal(capture.turn, 2); assert.equal(capture.status, "cancelled");
    }, true);
  } finally { release.resolve(); globalThis.fetch = originalFetch; }
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
