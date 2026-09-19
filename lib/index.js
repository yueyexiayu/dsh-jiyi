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
import { dreamAll, dreamPendingScopes } from "./dream.js";
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
  if (error instanceof SyntaxError) return 400;
  if (code === "ENOENT" || /not found|unknown topic|not a file/.test(message)) return 404;
  if (/memory disabled/.test(message)) return 409;
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
  const injected = new WeakSet();
  const captured = new WeakMap();
  const originCache = new Map();
  let dreamTail = Promise.resolve();
  let lastDream = { via: null, remaining: 0, merged: 0, at: null };
  const inflightTurns = new WeakMap();

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

  async function captureTurn(agent, turn) {
    if (!(await isEnabled())) return;
    let seen = captured.get(agent);
    if (!seen) {
      seen = new Set();
      captured.set(agent, seen);
    }
    if (seen.has(turn)) return;
    let inflight = inflightTurns.get(agent);
    if (!inflight) {
      inflight = new Set();
      inflightTurns.set(agent, inflight);
    }
    if (inflight.has(turn)) return;
    inflight.add(turn);
    try {
      let events;
      try {
        events = agent.session.snapshotEvents();
      } catch {
        return;
      }
      const notes = await collectTurnNotes(events, turn, async (transcript) => {
        const pool = await resolvePool();
        return extractWithPool({
          routes: pool.routes,
          keys: pool.keys,
          transcript,
        });
      });
      if (!(await isEnabled())) return;
      seen.add(turn);
      if (notes.length === 0) return;
      const cwd = agentCwd(agent);
      const origin = await originFor(cwd);
      for (const note of notes) {
        if (!(await isEnabled())) return;
        await remember(root, cwd, origin, note);
      }
      if (!(await isEnabled())) return;
      void enqueueDream(cwd, origin);
    } finally {
      inflight.delete(turn);
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

  async function doDream(cwd, origin, { pending = false } = {}) {
    if (!(await isEnabled())) {
      lastDream = { via: "disabled", remaining: 0, merged: 0, at: Date.now() };
      return lastDream;
    }
    const pool = await resolvePool();
    const llm = { routes: pool.routes, keys: pool.keys };
    const result = await withStoreLock(root, async () => {
      if (pending) return dreamPendingScopes(root, llm);
      const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
      return dreamAll(globalDir, cwd ? workspaceDir : null, llm);
    });
    lastDream = {
      via: result.via,
      remaining: result.remaining,
      merged: result.merged,
      at: Date.now(),
    };
    return result;
  }

  function enqueueDream(cwd, origin, extra = {}) {
    const job = dreamTail.then(
      () => doDream(cwd, origin, extra),
      () => doDream(cwd, origin, extra),
    );
    dreamTail = job.then(() => {}, () => {});
    return job;
  }

  ctx.on("agent/pre-step", async ({ agent, step, signal, messages }, next) => {
    const decision = typeof next === "function"
      ? await next()
      : { kind: "enter", messages: Array.isArray(messages) ? messages : [] };
    try {
      if (signal?.aborted) return decision;
      if (!shouldInject(decision, step, injected.has(agent))) return decision;
      const settings = await loadSettings(root);
      if (!settings.enabled) return decision;
      const cwd = agentCwd(agent);
      const origin = await originFor(cwd);
      const listed = await listEntries(root, cwd, origin);
      if (!listed.entries.some((item) => item.group === "topics")) return decision;
      const manifests = await regenerateManifests(root, cwd, origin);
      const text = buildMemoryReminder({
        globalManifest: manifests.global,
        workspaceManifest: manifests.workspace,
        globalDir: manifests.globalDir,
        workspaceDir: cwd ? manifests.workspaceDir : null,
      });
      if (!text) return decision;
      injected.add(agent);
      return {
        kind: "enter",
        messages: [...decision.messages, memoryInjectMessage(text)],
      };
    } catch {
      return decision;
    }
  });

  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    void captureTurn(agent, turn).catch(() => {});
  });

  registerMemoryTools(ctx, {
    root,
    cwdOf: (exec) => agentCwd(exec && exec.agent),
    originOf: (cwd) => originFor(cwd),
    enabledOf: isEnabled,
  });

  void enqueueDream(null, null, { pending: true });

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
          const deleted = await deleteEntry(root, path, bounds);
          return jsonResponse(200, { ok: true, ...deleted });
        }
        if (action === "remember") {
          if (request.method !== "POST") return fail(405, "remember requires POST");
          const settings = await loadSettings(root);
          if (!settings.enabled) return fail(409, "memory disabled");
          const saved = await remember(root, cwd, origin, { text, scope });
          void enqueueDream(cwd, origin);
          return jsonResponse(200, { ok: true, ...saved });
        }
        if (action === "dream") {
          if (request.method !== "POST") return fail(405, "dream requires POST");
          const settings = await loadSettings(root);
          if (!settings.enabled) return fail(409, "memory disabled");
          const result = await enqueueDream(cwd, origin);
          return jsonResponse(200, { ok: true, ...result, busy: false });
        }
        if (action === "toggle") {
          if (request.method !== "POST") return fail(405, "toggle requires POST");
          const settings = await loadSettings(root);
          const next = await saveSettings(root, { enabled: !settings.enabled });
          return jsonResponse(200, { ok: true, ...next });
        }
        return fail(400, "unknown action");
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        return fail(statusForError(error), message);
      }
    },
  });
}
