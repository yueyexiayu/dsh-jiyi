import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { apply, statusForError } from "../lib/index.js";
import { remember } from "../lib/storage.js";

const TEST_CWD = "/Users/ning/.dsh/jiyi-test-workspace";

function mockCtx({ cwd = TEST_CWD, keys = {} } = {}) {
  let handler;
  const tools = [];
  const listeners = new Map();
  const agents = new Map([
    ["s1", { session: { header: { cwd }, requestHeader: () => ({ cwd }) } }],
  ]);
  return {
    ctx: {
      credentials: {
        resolve: async (ref) => (keys[ref] ? { value: keys[ref] } : null),
      },
      get: (name) => (name === "agents" ? agents : null),
      on(name, handler) {
        const handlers = listeners.get(name) || [];
        handlers.push(handler);
        listeners.set(name, handlers);
      },
      tools: { register(tool) { tools.push(tool); } },
      connection: {
        fetch: {
          register(def) { handler = def.fetch; },
        },
      },
    },
    tools,
    emit: async (name, ...args) => {
      for (const listener of listeners.get(name) || []) await listener(...args);
    },
    call: (request) => handler(request),
  };
}

async function withHome(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "jiyi-home-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev == null) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

test("statusForError maps client vs server failures", () => {
  assert.equal(statusForError(new SyntaxError("bad json")), 400);
  assert.equal(statusForError(new Error("not found")), 404);
  assert.equal(statusForError(new Error("unknown topic")), 404);
  assert.equal(statusForError(new Error("memory disabled")), 409);
  assert.equal(statusForError(new Error("path escapes memory store")), 400);
  assert.equal(statusForError(new Error("boom")), 500);
});

async function status(mock) {
  return (await mock.call(new Request("http://127.0.0.1/api/jiyi?action=status&sessionId=s1"))).json();
}

async function waitCapture(mock) {
  for (let i = 0; i < 100; i += 1) {
    const body = await status(mock);
    if (body.lastCapture && body.lastCapture.status !== "running") return body;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("capture did not settle");
}

test("capture waits for committed turn/end after all same-turn continuation", async () => {
  await withHome(async () => {
    const mock = mockCtx();
    apply(mock.ctx);
    const session = { id: "s1", requestHeader: () => ({ cwd: TEST_CWD }) };
    const agent = { id: "s1", session };
    await mock.emit("agent/created", { agent });
    await mock.emit("session/event", session, { type: "turn/start", data: { turn: 1 } });
    await mock.emit("session/event", session, {
      type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我检查配置。记住：侧栏入口叫记忆" }] },
    });
    await mock.emit("agent/turn-stopping", { agent, turn: 1 });
    assert.equal((await status(mock)).inboxCount, 0);
    await mock.emit("session/event", session, {
      type: "user/message", data: { source: { kind: "plugin:xuxie" }, content: [{ type: "text", text: "记住：伪造的续写偏好" }] },
    });
    await mock.emit("session/event", session, {
      type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "续写后的最终回复" }] } },
    });
    await mock.emit("session/event", session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    const body = await waitCapture(mock);
    assert.equal(body.lastCapture.status, "saved");
    assert.equal(body.lastCapture.count, 1);
    assert.equal(body.inboxCount, 1);
    await mock.emit("session/event", session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    assert.equal((await status(mock)).inboxCount, 1);
  });
});

test("extraction and manual consolidation failures stay visible instead of noop", async () => {
  await withHome(async () => {
    const mock = mockCtx();
    apply(mock.ctx);
    const session = { id: "s1", requestHeader: () => ({ cwd: TEST_CWD }) };
    const agent = { session };
    await mock.emit("agent/created", { agent });
    await mock.emit("session/event", session, { type: "turn/start", data: { turn: 2 } });
    await mock.emit("session/event", session, { type: "user/message", data: {
      source: { kind: "user" }, content: [{ type: "text", text: "默认测试使用 just test" }],
    } });
    await mock.emit("session/event", session, { type: "turn/end", data: { turn: 2, reason: { kind: "error", error: { code: "UNKNOWN", message: "model failed" } } } });
    const body = await waitCapture(mock);
    assert.equal(body.lastCapture.status, "failed");
    assert.equal(body.lastCapture.error, "capture failed");
    const remembered = await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST", body: JSON.stringify({ action: "remember", sessionId: "s1", text: "Use just test" }),
    }));
    assert.equal(remembered.status, 200);
    const dream = await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST", body: JSON.stringify({ action: "dream", sessionId: "s1" }),
    }));
    assert.equal(dream.status, 502);
    assert.equal((await dream.json()).ok, false);
    assert.equal((await status(mock)).lastDream.via, "failed");
  });
});

test("a failed workspace observation write is not reported as saved", async () => {
  await withHome(async () => {
    const mock = mockCtx({ keys: { ZAI_CODING_CN_API_KEY: "test-key" } });
    apply(mock.ctx);
    const session = { id: "no-cwd", requestHeader: () => ({}) };
    const agent = { session };
    await mock.emit("agent/created", { agent });
    await mock.emit("session/event", session, { type: "turn/start", data: { turn: 1 } });
    await mock.emit("session/event", session, { type: "user/message", data: {
      source: { kind: "user" }, content: [{ type: "text", text: "默认侧栏入口叫记忆" }],
    } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      outcome: "observations", observations: [{ type: "project", scope: "workspace", statement: "侧栏入口叫记忆" }],
    }) } }] }) });
    try {
      await mock.emit("session/event", session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
      const body = await waitCapture(mock);
      assert.equal(body.lastCapture.status, "failed");
      assert.equal(body.lastCapture.count, 0);
      assert.equal(body.inboxCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("host rejects invalid json and scoped path escapes", async () => {
  await withHome(async (home) => {
    const mock = mockCtx();
    apply(mock.ctx);
    const bad = await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST",
      body: "null",
    }));
    assert.equal(bad.status, 400);
    const missing = await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST",
      body: JSON.stringify({ action: "read", path: 1, sessionId: "s1" }),
    }));
    assert.equal(missing.status, 400);

    const root = path.join(home, "jiyi");
    const other = await remember(root, "/Users/ning/.dsh/jiyi-other-workspace", "github.com/other/app", {
      text: "secret from other repo",
    });
    const cross = await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST",
      body: JSON.stringify({ action: "read", path: other.path, sessionId: "s1" }),
    }));
    assert.equal(cross.status, 400);
  });
});

test("status reports missing credentials and disable blocks delete", async () => {
  await withHome(async () => {
    const mock = mockCtx();
    apply(mock.ctx);
    const status = await mock.call(new Request("http://127.0.0.1/api/jiyi?action=status&sessionId=s1"));
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.hasCredentials, false);
    assert.equal(body.ok, true);

    await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST",
      body: JSON.stringify({ action: "toggle", sessionId: "s1" }),
    }));
    const remembered = await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST",
      body: JSON.stringify({ action: "remember", text: "nope", sessionId: "s1" }),
    }));
    assert.equal(remembered.status, 409);
    const del = await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST",
      body: JSON.stringify({ action: "delete", path: "/tmp/x", sessionId: "s1" }),
    }));
    assert.equal(del.status, 409);
  });
});

test("tools refuse to run when memory is disabled", async () => {
  await withHome(async () => {
    const mock = mockCtx();
    apply(mock.ctx);
    await mock.call(new Request("http://127.0.0.1/api/jiyi", {
      method: "POST",
      body: JSON.stringify({ action: "toggle", sessionId: "s1" }),
    }));
    await assert.rejects(() => mock.tools[0].execute({}, { agent: {} }), /memory disabled/);
  });
});
