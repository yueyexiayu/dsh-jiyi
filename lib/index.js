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
import { dreamAll } from "./dream.js";
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

  async function originFor(cwd) {
    if (!cwd) return null;
    const hit = originCache.get(cwd);
    if (hit && Date.now() - hit.at < ORIGIN_CACHE_MS) return hit.origin;
    const origin = await readGitOrigin(cwd);
    originCache.set(cwd, { origin, at: Date.now() });
    return origin;
  }

  async function captureTurn(agent, turn) {
    const settings = await loadSettings(root);
    if (!settings.enabled) return;
    let seen = captured.get(agent);
    if (!seen) {
      seen = new Set();
      captured.set(agent, seen);
    }
    if (seen.has(turn)) return;
    seen.add(turn);
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
    if (notes.length === 0) return;
    const cwd = agentCwd(agent);
    const origin = await originFor(cwd);
    for (const note of notes) {
      await remember(root, cwd, origin, note);
    }
    void enqueueDream(cwd, origin);
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

  async function doDream(cwd, origin) {
    const { globalDir, workspaceDir } = await ensureLayout(root, cwd, origin);
    const pool = await resolvePool();
    return dreamAll(globalDir, cwd ? workspaceDir : null, {
      routes: pool.routes,
      keys: pool.keys,
    });
  }

  function enqueueDream(cwd, origin) {
    const job = dreamTail.then(
      () => doDream(cwd, origin),
      () => doDream(cwd, origin),
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
  });

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
          const body = raw ? JSON.parse(raw) : {};
          action = body.action;
          sessionId = body.sessionId;
          path = body.path;
          text = body.text;
          scope = body.scope;
        }
        const cwd = sessionCwd(ctx, sessionId);
        const origin = await originFor(cwd);
        if (action === "status") {
          const settings = await loadSettings(root);
          const listed = await listEntries(root, cwd, origin);
          return jsonResponse(200, {
            ok: true,
            enabled: settings.enabled,
            extractPrimary: settings.extractPrimary,
            extractFallbacks: settings.extractFallbacks,
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
          const file = await readEntry(root, path);
          return jsonResponse(200, { ok: true, ...file });
        }
        if (action === "delete") {
          if (request.method !== "POST") return fail(405, "delete requires POST");
          if (!path) return fail(400, "missing path");
          const deleted = await deleteEntry(root, path);
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
        const status = /escapes|protected|empty memory|must be a string|too large|not a file|missing |unknown topic|no workspace|memory disabled/.test(message) ? 400 : 500;
        return fail(status, message);
      }
    },
  });
}
