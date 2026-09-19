import { listEntries, readEntry } from "./storage.js";
import { toPosix } from "./parse.js";

function textContent(value) {
  return [{ type: "text", text: value }];
}

function topicItems(listed) {
  return (listed.entries || []).filter((item) => item.group === "topics");
}

export function matchTopic(entries, requested, scope) {
  const raw = String(requested || "").trim();
  if (!raw) return { hit: null, ambiguous: false };
  let wantedScope = scope === "global" || scope === "workspace" ? scope : "";
  let needle = raw;
  const scoped = raw.match(/^(global|workspace)\s*[:/]\s*(.+)$/i);
  if (scoped) {
    wantedScope = scoped[1].toLowerCase();
    needle = scoped[2].trim();
  }
  const posix = toPosix(needle).replace(/^\.\//, "");
  const topics = (entries || []).filter((item) => item.group === "topics");
  const matches = topics.filter((item) => (
    item.path === raw
    || item.path === needle
    || toPosix(item.relative) === posix
    || toPosix(item.relative) === `topics/${posix}`
    || toPosix(item.relative) === `topics/${posix}.md`
    || item.label === raw
    || item.label === needle
  ));
  const scopedMatches = wantedScope ? matches.filter((item) => item.scope === wantedScope) : matches;
  if (scopedMatches.length === 1) return { hit: scopedMatches[0], ambiguous: false };
  if (scopedMatches.length > 1) {
    const exact = scopedMatches.find((item) => item.path === raw || item.path === needle);
    if (exact) return { hit: exact, ambiguous: false };
    return { hit: null, ambiguous: true, matches: scopedMatches };
  }
  return { hit: null, ambiguous: false };
}

export function summarizeTopics(listed) {
  return {
    workspaceId: listed.workspaceId || "",
    origin: listed.origin || "",
    inbox: (listed.entries || []).filter((item) => item.group === "inbox").length,
    topics: topicItems(listed).map((item) => ({
      scope: item.scope,
      label: item.label,
      relative: item.relative,
      description: item.description || "",
    })),
  };
}

export function snippetAround(content, needle, radius = 120) {
  const text = String(content || "");
  const lower = text.toLowerCase();
  const at = lower.indexOf(String(needle || "").toLowerCase());
  if (at < 0) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + String(needle).length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export async function searchTopics(root, listed, query) {
  const needle = String(query || "").trim();
  if (!needle) throw new Error("missing query");
  const lowered = needle.toLowerCase();
  const hits = [];
  for (const item of topicItems(listed)) {
    let content = "";
    try {
      const file = await readEntry(root, item.path, { cwd: listed.cwd, origin: listed.origin });
      content = file.content;
    } catch {
      continue;
    }
    const hay = [item.label, item.description, item.relative, content].join("\n").toLowerCase();
    if (!hay.includes(lowered)) continue;
    hits.push({
      scope: item.scope,
      label: item.label,
      relative: item.relative,
      snippet: snippetAround(content, needle),
    });
  }
  return hits;
}

function listTool(listedFor) {
  return {
    name: "jiyi_list",
    description: "List durable jiyi memory topics for the current workspace and global scopes. Read-only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspaceId: { type: "string" },
          origin: { type: "string" },
          inbox: { type: "integer" },
          topics: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                scope: { type: "string" },
                label: { type: "string" },
                relative: { type: "string" },
                description: { type: "string" },
              },
            },
          },
        },
      },
      render(_args, value) {
        const topics = value.topics || [];
        const lines = topics.map((item) => `- [${item.scope}] ${item.label} (\`${item.relative}\`)`);
        if (!topics.length) lines.push("No jiyi topics yet.");
        if (value.inbox) lines.push(`Inbox: ${value.inbox} unconsolidated observation(s).`);
        return textContent(lines.join("\n"));
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return summarizeTopics(await listedFor(exec));
    },
  };
}

function readTool(root, listedFor) {
  return {
    name: "jiyi_read",
    description: "Read one jiyi topic by slug, title, or topics/*.md relative path. Read-only; cannot read MEMORY.md or files outside the memory store.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Topic slug, title, relative path such as topics/testing.md, or scope-qualified path like workspace:testing." },
        scope: { type: "string", description: "Optional scope: global or workspace. Required when both scopes share the same slug." },
      },
      required: ["path"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: "string" },
          label: { type: "string" },
          relative: { type: "string" },
          content: { type: "string" },
        },
      },
      render(_args, value) {
        return textContent(`# ${value.label}\n\n${value.content}`);
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const listed = await listedFor(exec);
      const matched = matchTopic(listed.entries, args && args.path, args && args.scope);
      if (matched.ambiguous) throw new Error("ambiguous topic; pass scope=global or scope=workspace");
      if (!matched.hit) throw new Error("unknown topic");
      const file = await readEntry(root, matched.hit.path, { cwd: listed.cwd, origin: listed.origin });
      return {
        scope: matched.hit.scope,
        label: matched.hit.label,
        relative: matched.hit.relative,
        content: file.content,
      };
    },
  };
}

function searchTool(root, listedFor) {
  return {
    name: "jiyi_search",
    description: "Search jiyi topic titles and contents. Read-only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Plain-text query." },
      },
      required: ["query"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                scope: { type: "string" },
                label: { type: "string" },
                relative: { type: "string" },
                snippet: { type: "string" },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (!value.hits.length) return textContent(`No jiyi topics matched ${JSON.stringify(value.query)}.`);
        return textContent(value.hits.map((item) => `- [${item.scope}] ${item.label} (\`${item.relative}\`)\n  ${item.snippet}`).join("\n"));
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args && args.query || "").trim();
      const listed = await listedFor(exec);
      return { query, hits: await searchTopics(root, listed, query) };
    },
  };
}

export function registerMemoryTools(ctx, { root, cwdOf, originOf, enabledOf }) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== "function") return 0;
  const listedFor = async (exec) => {
    if (enabledOf && !(await enabledOf())) throw new Error("memory disabled");
    const cwd = cwdOf ? cwdOf(exec) : null;
    const origin = originOf ? await originOf(cwd) : null;
    return listEntries(root, cwd, origin);
  };
  ctx.tools.register(listTool(listedFor));
  ctx.tools.register(readTool(root, listedFor));
  ctx.tools.register(searchTool(root, listedFor));
  return 3;
}
