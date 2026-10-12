import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../lib/index.js";

const runtime = process.env.DSH_OFFICIAL_ROOT;
test("official SessionController/Query cold inspection bounds memory without activating or mutating a Session", { skip: !runtime }, async () => {
  const load = (name) => import(pathToFileURL(path.join(runtime, "node_modules/@deepseek-ai", name, "lib/index.js")).href);
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, { SessionQueryEngine }, { SessionController }] = await Promise.all([
    load("cordis"), load("dsh-session"), load("dsh-session-projection"), load("dsh-session-query"), load("dsh-api-session-controller"),
  ]);
  const home = await mkdtemp("/tmp/jiyi-official-history-");
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const ctx = new Context(); const fibers = []; const listeners = new Map(); let route, activations = 0, mutations = 0, handles = 0;
  const provide = (key, value) => { ctx.provide(key); ctx.set(key, value); };
  provide("typert", { lookups: { register() {}, configure() {} }, contexts: { configureHost() {} } });
  const forbidden = () => { activations++; throw new Error("Agent activation forbidden"); };
  provide("agents", { get: () => undefined, create: forbidden, resume: forbidden });
  provide("fileUploads", { registerAgentResolver: () => () => {} });
  provide("agentDefaultModel", { currentSelection: () => ({ provider: "fixture", model: "fixture" }) });
  provide("attachments", { imageLimits: { maxImageBytes: 1048576 } });
  provide("llm", {}); provide("fs", {}); provide("workspaceRegistry", { archivedSessionIds: new Set(), list: () => [] });
  let snapshot;
  provide("sessionPersistence", { identity: "fixture", stat: async (id) => id === "cold" ? { header: snapshot.meta, revision: "1" } : undefined,
    open: async (_id, access) => { assert.equal(access, "read"); handles++; return { header: snapshot.meta, inheritedEventCount: 0,
      read: async () => ({ events: [] }), close: async () => { handles--; } }; } });
  try {
    for (const Service of [SessionStore, SessionProjectionRegistry, SessionQueryEngine, SessionController]) {
      const fiber = ctx.plugin(Service, {}); fibers.push(fiber); await fiber.await();
    }
    snapshot = { meta: ctx.sessions.prepare("cold", { meta: { cwd: home } }).header };
    ctx.on("session/event", () => { mutations++; }); ctx.on("session/created", () => { mutations++; });
    apply({ get: (key) => ctx.get(key), credentials: { resolve: async () => null }, tools: { register() {} },
      on: (name, fn) => listeners.set(name, fn), connection: { fetch: { register(def) { route = def.fetch; } } } });
    const call = async (id) => { const response = await route(new Request("http://fixture/api/jiyi?action=status&sessionId=" + id)); return { status: response.status, body: await response.json() }; };
    const cold = await call("cold"); assert.equal(cold.status, 200); assert.equal(cold.body.cwd, home);
    assert.equal(cold.body.lastCapture, null); assert.equal(ctx.sessions.get("cold"), undefined);
    assert.equal((await call("unknown")).status, 404);
    assert.equal(activations, 0); assert.equal(mutations, 0); assert.equal(handles, 0);
  } finally {
    await listeners.get("dispose")?.();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
