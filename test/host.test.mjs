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
  const agents = new Map([
    ["s1", { session: { header: { cwd }, requestHeader: () => ({ cwd }) } }],
  ]);
  return {
    ctx: {
      credentials: {
        resolve: async (ref) => (keys[ref] ? { value: keys[ref] } : null),
      },
      get: (name) => (name === "agents" ? agents : null),
      on() {},
      tools: { register(tool) { tools.push(tool); } },
      connection: {
        fetch: {
          register(def) { handler = def.fetch; },
        },
      },
    },
    tools,
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
