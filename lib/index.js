import {
  API_PATH,
  PLUGIN_ID,
  dshHome,
  extractRouteList,
  ORIGIN_CACHE_MS,
  storeRoot,
} from "./parse.js";
import { collectTurnNotes } from "./capture.js";
import { extractWithPool } from "./extract.js";
import { drainAll, drainPendingScopes } from "./dream.js";
import { buildMemoryReminder, memoryInjectMessage, shouldInject } from "./inject.js";
import { registerMemoryTools } from "./tools.js";
import {
  deleteEntry,
  ensureLayout,
  listEntries,
  loadSettings,
  readEntry,
  readGitOrigin,
  regenerateManifests,
  remember,
  saveSettings,
  withStoreLock,
} from "./storage.js";

export const name = PLUGIN_ID;
export const inject = ["connection", "credentials", "tools"];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fail(status, error) {
  return jsonResponse(status, { ok: false, error });
}

export function statusForError(error) {
  const message = error && error.message ? error.message : String(error);
  const code = error && error.code;
  if (error?.name === "AbortError") return 409;
  if (error instanceof SyntaxError) return 400;
  if (code === "ENOENT" || /not found|unknown topic|not a file/.test(message)) return 404;
  if (/memory disabled|memory settings are corrupt|legacy workspace requires explicit migration/.test(message)) return 409;
  if (/escapes|protected|empty memory|must be a string|too large|missing |no workspace|invalid |malformed|ambiguous topic/.test(message)) {
    return 400;
  }
  return 500;
}

function sessionCwd(ctx, sessionId) {
  if (!sessionId) return null;
  try {
    const agents = ctx.get("agents");
    const agent = agents && agents.get(String(sessionId));
    const session = agent && agent.session;
    if (!session) return null;
    if (session.header && typeof session.header.cwd === "string" && session.header.cwd) {
      return session.header.cwd;
    }
    if (typeof session.requestHeader === "function") {
      const header = session.requestHeader();
      if (header && typeof header.cwd === "string" && header.cwd) return header.cwd;
    }
  } catch {
    // optional
  }
  return null;
}

function agentCwd(agent) {
  try {
    const session = agent && agent.session;
    if (!session) return null;
    if (session.header && typeof session.header.cwd === "string" && session.header.cwd) {
      return session.header.cwd;
    }
    if (typeof session.requestHeader === "function") {
      const header = session.requestHeader();
      if (header && typeof header.cwd === "string" && header.cwd) return header.cwd;
    }
  } catch {
    // optional
  }
  return null;
}

export function apply(ctx) {
  const root = storeRoot(dshHome());
  const injected = new WeakMap();
  const active = new Set();
  let workController = new AbortController();
  let toggleTail = Promise.resolve();

  function runActive(fn, controller = workController) {
    const job = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return fn(controller.signal);
    });
    active.add(job);
    void job.finally(() => active.delete(job)).catch(() => {});
    return job;
  }

  function cancelledOperation(operation, extra = {}) {
    return { status: "cancelled", error: `${operation} cancelled`, at: Date.now(), ...extra };
  }

  async function toggleEnabled() {
    const next = await saveSettings(root, (settings) => ({ enabled: !settings.enabled }));
    if (!next.enabled) {
      workController.abort(new DOMException("memory disabled", "AbortError"));
      // Do not acknowledge disabled while a previously admitted write can still finish.
      await Promise.allSettled([...active]);
    } else {
      workController = new AbortController();
    }
    return next;
  }
  const sessionAgents = new WeakMap();
  const turnEvents = new WeakMap();
  const originCache = new Map();
  let dreamTail = Promise.resolve();
  let lastDream = { via: null, remaining: 0, merged: 0, at: null };
  let dreamRetry = null;
  let dreamRetryCount = 0;
  const DREAM_RETRY_LIMIT = 5;
  const DREAM_RETRY_MS = 60_000;
  let lastCapture = null;
  let lastInjection = null;

  function failedOperation(operation, error, extra = {}) {
    // Exception text may contain credentials or tool output. Expose the failed
    // operation and safe error identity, never raw exception text.
    const code = typeof error?.code === "string" && /^[A-Z_]{1,32}$/.test(error.code)
      ? error.code : "UNKNOWN";
    return { status: "failed", error: `${operation} failed`, code, at: Date.now(), ...extra };
  }

  async function originFor(cwd) {
    if (!cwd) return null;
    const hit = originCache.get(cwd);
    if (hit && Date.now() - hit.at < ORIGIN_CACHE_MS) return hit.origin;
    const origin = await readGitOrigin(cwd);
    originCache.set(cwd, { origin, at: Date.now() });
    return origin;
  }

  async function isEnabled() {
    const settings = await loadSettings(root);
    return settings.enabled !== false;
  }

  async function captureTurn(agent, turn, events, signal) {
    const identity = { sessionId: agent.session.id || agent.id || null, turn };
    let saved = 0;
    try {
      if (!(await isEnabled())) return;
      lastCapture = { status: "running", ...identity, at: Date.now() };
      const notes = await collectTurnNotes(events, turn, async (transcript) => {
        const pool = await resolvePool();
        return extractWithPool({
          routes: pool.routes,
          keys: pool.keys,
          transcript,
          signal,
        });
      });
      signal.throwIfAborted();
      if (!(await isEnabled())) throw new DOMException("memory disabled", "AbortError");
      if (notes.length === 0) {
        lastCapture = { status: notes.rejectedSecrets ? "filtered" : "noop", ...identity, count: 0, rejectedSecrets: notes.rejectedSecrets || 0, at: Date.now() };
        return;
      }
      const cwd = agentCwd(agent);
      const origin = await originFor(cwd);
      for (const note of notes) {
        signal.throwIfAborted();
        if (!(await isEnabled())) throw new DOMException("memory disabled", "AbortError");
        await remember(root, cwd, origin, note, { signal });
        saved += 1;
      }
      lastCapture = { status: "saved", ...identity, count: saved, at: Date.now() };
      if (!(await isEnabled())) return;
      backgroundDream(null, null, { pending: true });
    } catch (error) {
      lastCapture = error?.name === "AbortError"
        ? cancelledOperation("capture", { ...identity, count: saved })
        : failedOperation("capture", error, { ...identity, count: saved });
    }
  }

  async function resolvePool() {
    const settings = await loadSettings(root);
    const routes = extractRouteList(settings);
    const keys = {};
    for (const route of routes) {
      if (keys[route.keyRef]) continue;
      try {
        const hit = await ctx.credentials.resolve(route.keyRef);
        if (hit && typeof hit.value === "string" && hit.value) keys[route.keyRef] = hit.value;
      } catch {
        // skip this credential
      }
    }
    return { routes, keys };
  }

  async function doDream(cwd, origin, { pending = false, signal } = {}) {
    signal.throwIfAborted();
    if (!(await isEnabled())) {
      lastDream = { via: "disabled", remaining: 0, merged: 0, at: Date.now() };
      return lastDream;
    }
    const pool = await resolvePool();
    const llm = { routes: pool.routes, keys: pool.keys, signal };
    const result = await withStoreLock(root, async () => {
      signal.throwIfAborted();
      if (!(await isEnabled())) throw new DOMException("memory disabled", "AbortError");
      if (pending) return drainPendingScopes(root, llm);
      const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
      return drainAll(globalDir, cwd ? workspaceDir : null, llm);
    });
    lastDream = {
      status: result.via === "failed" ? "failed" : "completed",
      via: result.via,
      remaining: result.remaining,
      merged: result.merged,
      archived: result.archived || 0,
      processed: result.processed || 0,
      coverage: result.coverage || null,
      at: Date.now(),
      ...(result.via === "failed" ? { error: "consolidation failed" } : {}),
    };
    if (!signal.aborted && result.remaining > 0 && result.via !== "disabled") scheduleDreamRetry();
    else if (!result.remaining) {
      dreamRetryCount = 0;
      clearDreamRetry();
    }
    return result;
  }

  function clearDreamRetry() {
    if (!dreamRetry) return;
    clearTimeout(dreamRetry);
    dreamRetry = null;
  }

  function scheduleDreamRetry() {
    if (workController.signal.aborted || dreamRetry || dreamRetryCount >= DREAM_RETRY_LIMIT) return;
    dreamRetryCount += 1;
    dreamRetry = setTimeout(() => {
      dreamRetry = null;
      if (workController.signal.aborted) return;
      backgroundDream(null, null, { pending: true, retry: true });
    }, DREAM_RETRY_MS);
    dreamRetry.unref?.();
  }

  function enqueueDream(cwd, origin, extra = {}) {
    const controller = workController;
    const run = () => runActive((signal) => doDream(cwd, origin, { ...extra, signal }), controller);
    const job = dreamTail.then(run, run).catch((error) => {
      lastDream = error?.name === "AbortError"
        ? { ...cancelledOperation("consolidation"), via: "cancelled", remaining: null, merged: 0 }
        : { ...failedOperation("consolidation", error), via: "failed", remaining: null, merged: 0 };
      throw error;
    });
    dreamTail = job.then(() => {}, () => {});
    return job;
  }

  function backgroundDream(cwd, origin, extra) {
    if (!extra?.retry) dreamRetryCount = 0;
    clearDreamRetry();
    // enqueueDream records failure before this background rejection is handled.
    void enqueueDream(cwd, origin, extra).catch(() => {});
  }

  ctx.on("dispose", () => {
    clearDreamRetry();
    workController.abort(new DOMException("memory plugin disposed", "AbortError"));
  });
  ctx.on("agent/created", ({ agent }) => { sessionAgents.set(agent.session, agent); });
  ctx.on("agent/disposed", ({ agent }) => {
    sessionAgents.delete(agent.session);
    turnEvents.delete(agent.session);
    injected.delete(agent);
  });
  const capturedTypes = new Set(["turn/start", "user/message", "assistant/message", "tool/call", "tool/result", "turn/end"]);
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/start") turnEvents.set(session, []);
    const events = turnEvents.get(session);
    if (!events) return;
    if (capturedTypes.has(event.type)) events.push(event);
    if (event.type !== "turn/end") return;
    turnEvents.delete(session);
    const agent = sessionAgents.get(session);
    if (agent) void runActive((signal) => captureTurn(agent, event.data.turn, events, signal)).catch((error) => {
      lastCapture = error?.name === "AbortError"
        ? cancelledOperation("capture", { sessionId: session.id || null, turn: event.data.turn })
        : failedOperation("capture", error);
    });
  });

  ctx.on("agent/pre-step", async ({ agent, step, signal, messages }, next) => {
    sessionAgents.set(agent.session, agent);
    const decision = typeof next === "function"
      ? await next()
      : { kind: "enter", messages: Array.isArray(messages) ? messages : [] };
    try {
      if (signal?.aborted) return decision;
      if (!shouldInject(decision, step, false)) return decision;
      const settings = await loadSettings(root);
      if (!settings.enabled) return decision;
      const cwd = agentCwd(agent);
      const origin = await originFor(cwd);
      const manifests = await regenerateManifests(root, cwd, origin, { persist: false });
      const text = buildMemoryReminder({
        globalManifest: manifests.global,
        workspaceManifest: manifests.workspace,
        globalDir: manifests.globalDir,
        workspaceDir: cwd ? manifests.workspaceDir : null,
      });
      signal?.throwIfAborted();
      const previous = injected.get(agent);
      if (previous === text || (!text && previous === undefined)) return decision;
      const update = text || "jiyi 记忆索引更新：当前作用域已无记忆主题。此前注入的 jiyi 索引已失效，不应再作为当前记忆使用。";
      injected.set(agent, text);
      lastInjection = { status: "injected", at: Date.now() };
      return {
        ...decision,
        messages: [...decision.messages, memoryInjectMessage(update)],
      };
    } catch (error) {
      lastInjection = failedOperation("injection", error);
      return decision;
    }
  });

  registerMemoryTools(ctx, {
    root,
    cwdOf: (exec) => agentCwd(exec && exec.agent),
    originOf: (cwd) => originFor(cwd),
    enabledOf: isEnabled,
  });

  backgroundDream(null, null, { pending: true });

  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        const url = new URL(request.url);
        let action;
        let sessionId;
        let path;
        let text;
        let scope;
        if (request.method === "GET") {
          action = url.searchParams.get("action") || "status";
          sessionId = url.searchParams.get("sessionId");
          path = url.searchParams.get("path");
        } else {
          const raw = await request.text();
          let body = {};
          if (raw) {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              return fail(400, "invalid json");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              return fail(400, "invalid json");
            }
            body = parsed;
          }
          action = body.action;
          sessionId = body.sessionId;
          path = body.path;
          text = body.text;
          scope = body.scope;
        }
        if (path != null && typeof path !== "string") return fail(400, "path must be a string");
        const cwd = sessionCwd(ctx, sessionId);
        const origin = await originFor(cwd);
        const bounds = { cwd, origin };
        if (action === "status") {
          const settings = await loadSettings(root);
          const listed = await listEntries(root, cwd, origin);
          const pool = await resolvePool();
          const keyRefs = [...new Set(pool.routes.map((route) => route.keyRef))];
          const keysAvailable = keyRefs.filter((ref) => pool.keys[ref]).length;
          return jsonResponse(200, {
            ok: true,
            enabled: settings.enabled,
            extractPrimary: settings.extractPrimary,
            extractFallbacks: settings.extractFallbacks,
            hasCredentials: keysAvailable > 0,
            keysAvailable,
            lastDream,
            lastCapture,
            lastInjection,
            inboxCount: listed.entries.filter((item) => item.group === "inbox").length,
            root,
            ...listed,
          });
        }
        if (action === "list") {
          const listed = await listEntries(root, cwd, origin);
          return jsonResponse(200, { ok: true, ...listed });
        }
        if (action === "read") {
          if (!path) return fail(400, "missing path");
          const file = await readEntry(root, path, bounds);
          return jsonResponse(200, { ok: true, ...file });
        }
        if (action === "delete") {
          if (request.method !== "POST") return fail(405, "delete requires POST");
          if (!path) return fail(400, "missing path");
          const settings = await loadSettings(root);
          if (!settings.enabled) return fail(409, "memory disabled");
          const deleted = await runActive((signal) => deleteEntry(root, path, bounds, { signal }));
          return jsonResponse(200, { ok: true, ...deleted });
        }
        if (action === "remember") {
          if (request.method !== "POST") return fail(405, "remember requires POST");
          const settings = await loadSettings(root);
          if (!settings.enabled) return fail(409, "memory disabled");
          const saved = await runActive((signal) => remember(root, cwd, origin, { text, scope }, { signal }));
          backgroundDream(null, null, { pending: true });
          return jsonResponse(200, { ok: true, ...saved });
        }
        if (action === "dream") {
          if (request.method !== "POST") return fail(405, "dream requires POST");
          const settings = await loadSettings(root);
          if (!settings.enabled) return fail(409, "memory disabled");
          const result = await enqueueDream(null, null, { pending: true });
          if (result.via === "disabled" || result.via === "cancelled") return fail(409, "memory disabled or cancelled");
          if (result.via === "failed") {
            return jsonResponse(502, { ...result, ok: false, error: "consolidation failed", busy: false });
          }
          return jsonResponse(200, { ok: true, ...result, busy: false });
        }
        if (action === "toggle") {
          if (request.method !== "POST") return fail(405, "toggle requires POST");
          const job = toggleTail.then(toggleEnabled, toggleEnabled);
          toggleTail = job.then(() => {}, () => {});
          const next = await job;
          return jsonResponse(200, { ok: true, ...next });
        }
        return fail(400, "unknown action");
      } catch (error) {
        const status = statusForError(error);
        const message = error?.name === "AbortError" ? "memory operation cancelled"
          : /legacy workspace requires explicit migration/.test(error?.message || "") ? "legacy workspace requires explicit migration after confirming the target origin"
          : /memory settings are corrupt/.test(error?.message || "") ? "memory settings are corrupt; repair settings before enabling"
            : status === 400 ? "invalid memory request"
              : status === 404 ? "memory entry not found"
                : status === 409 ? "memory disabled"
                  : "memory operation failed";
        return fail(status, message);
      }
    },
  });
}
