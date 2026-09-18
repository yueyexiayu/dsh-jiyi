/** Path policy, IDs, and constants for jiyi. No credentials. */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import * as nodePath from "node:path";

export const PLUGIN_ID = "jiyi";
export const API_PATH = "/api/jiyi";
export const MAX_NOTE_BYTES = 16 * 1024;
export const MAX_TOPIC_BYTES = 256 * 1024;
export const MAX_MANIFEST_BYTES = 8 * 1024;
export const MAX_MANIFEST_ENTRIES = 64;
export const EXTRACT_MODEL = "glm-5.3-flash";
export const EXTRACT_KEY_REF = "ZAI_CODING_CN_API_KEY";
export const EXTRACT_URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";
export const EXTRACT_TIMEOUT_MS = 20_000;
export const DEEPSEEK_EXTRACT_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_KEY_REF = "DEEPSEEK_API_KEY";
export const DEFAULT_EXTRACT_PRIMARY = "glm-5.3-flash";
export const DEFAULT_EXTRACT_FALLBACKS = ["deepseek-flash"];
export const EXTRACT_ROUTES = {
  "glm-5.3-flash": {
    id: "glm-5.3-flash",
    url: EXTRACT_URL,
    keyRef: EXTRACT_KEY_REF,
  },
  "deepseek-flash": {
    id: "deepseek-flash",
    url: DEEPSEEK_EXTRACT_URL,
    keyRef: DEEPSEEK_KEY_REF,
  },
};

export function extractRouteList(settings = {}) {
  const primaryId = EXTRACT_ROUTES[settings.extractPrimary] ? settings.extractPrimary : DEFAULT_EXTRACT_PRIMARY;
  const list = [EXTRACT_ROUTES[primaryId]];
  const seen = new Set([primaryId]);
  const fallbacks = Array.isArray(settings.extractFallbacks)
    ? settings.extractFallbacks
    : DEFAULT_EXTRACT_FALLBACKS;
  for (const id of fallbacks) {
    const route = EXTRACT_ROUTES[id];
    if (!route || seen.has(route.id)) continue;
    seen.add(route.id);
    list.push(route);
  }
  return list;
}
export const MAX_TRANSCRIPT_CHARS = 24_000;
export const MAX_TOOL_EVENTS = 12;
export const MAX_TOOL_OUTPUT_EDGE = 400;
export const MAX_EXTRACT_OBSERVATIONS = 8;
export const MAX_DREAM_TOPICS = 16;
export const DREAM_TIMEOUT_MS = 30_000;
export const MAX_ARCHIVE_FILES = 80;
export const ORIGIN_CACHE_MS = 30_000;

export function dshHome() {
  return process.env.DSH_HOME || nodePath.join(homedir(), ".dsh");
}

export function storeRoot(home = dshHome()) {
  return nodePath.join(home, "jiyi");
}

export function isPathInside(root, candidate) {
  const rel = nodePath.relative(root, candidate);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel);
}

export function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 8);
}

export function slugify(text, max = 40) {
  const slug = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "notes";
}

export function posixJoin(...parts) {
  return parts
    .filter((part) => part !== "" && part != null)
    .join("/")
    .replace(/\/+/g, "/");
}

export function toPosix(rel) {
  return String(rel || "").split(nodePath.sep).join("/");
}
