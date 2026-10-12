import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { apply } from "../lib/index.js";

async function fixture(t) {
  const home = await mkdtemp("/tmp/jiyi-lifecycle-");
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const listeners = new Map(); let route;
  const agents = new Map();
  const services = { agents, sessionController: { inspect: async (id) => {
    if (id === "missing") throw Object.assign(new Error("absent"), { name: "ApiSessionNotFound" });
    if (id === "corrupt") throw Object.assign(new Error("broken"), { code: "SESSION_QUERY_CORRUPT_SESSION" });
    return { meta: { id, cwd: home }, events: [] };
  } } };
  apply({ get: (name) => services[name], credentials: { resolve: async () => null }, tools: { register() {} },
    on(name, fn) { listeners.set(name, fn); }, connection: { fetch: { register(def) { route = def.fetch; } } } });
  const emit = (name, ...args) => listeners.get(name)?.(...args);
  const call = async (id = "s1", extra = {}) => {
    const response = await route(new Request("http://fixture/api/jiyi", { method: "POST", body: JSON.stringify({ action: "status", sessionId: id, ...extra }) }));
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await emit("dispose"); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const turn = async (id, reason, dispose = false) => {
    const session = { id, header: { cwd: home } }, agent = { session };
    agents.set(id, agent); await emit("agent/created", { agent });
    await emit("session/event", session, { type: "turn/start", data: { turn: 1 } });
    await emit("session/event", session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我检查。记住：默认用中文回复" }] } });
    await emit("session/event", session, { type: "turn/end", data: { turn: 1, reason } });
    if (dispose) { agents.delete(id); await emit("agent/disposed", { agent }); }
    for (let i = 0; i < 200; i++) {
      const state = await call(id);
      if (state.body.lastCapture && state.body.lastCapture.status !== "running") return state.body;
      await new Promise(setImmediate);
    }
    throw new Error("capture did not settle");
  };
  return { home, call, turn, emit, services };
}

test("completed capture survives immediate agent release and history status remains scoped", async (t) => {
  const h = await fixture(t); const result = await h.turn("s1", { kind: "completed" }, true);
  assert.equal(result.lastCapture.status, "saved"); assert.equal(result.lastCapture.count, 1);
  assert.equal((await h.call("s2")).body.lastCapture, null);
});
for (const [reason, expected] of [[{ kind: "aborted", reason: { kind: "user" } }, "cancelled"], [{ kind: "aborted", reason: { kind: "dispose" } }, "cancelled"], [{ kind: "max-tokens" }, "skipped"], [{ kind: "error", error: { code: "UNKNOWN" } }, "failed"]]) {
  test(`${reason.kind}/${reason.reason?.kind || "end"} does not save a partial turn as completed`, async (t) => {
    const h = await fixture(t); const result = await h.turn("s1", reason);
    assert.equal(result.lastCapture.status, expected); assert.equal(result.inboxCount, 0);
  });
}
test("live header exceptions are visible rather than silently unbinding workspace", async (t) => {
  const h = await fixture(t);
  h.services.agents.set("s1", { session: { requestHeader() { throw new Error("fixture header failure"); } } });
  const result = await h.call("s1");
  assert.equal(result.status, 500); assert.equal(result.body.ok, false);
});

for (const source of ["cold", "live"]) test(`${source} relative cwd cannot default memory scope to the Host workspace`, async (t) => {
  const h = await fixture(t);
  if (source === "live") h.services.agents.set("s1", { session: { header: { cwd: "." } } });
  else h.services.sessionController.inspect = async () => ({ meta: { id: "s1", cwd: "." }, events: [] });
  const result = await h.call("s1"); assert.equal(result.status, 400); assert.equal(result.body.code, "SESSION_NO_WORKSPACE");
});

test("historical lookup errors never degrade to unbound global memory", async (t) => {
  const h = await fixture(t);
  assert.equal((await h.call("s1")).body.cwd, h.home);
  assert.equal((await h.call("missing")).status, 404);
  assert.equal((await h.call("corrupt")).status, 500);
  h.services.sessionController = undefined;
  assert.equal((await h.call("s1")).status, 503);
});
