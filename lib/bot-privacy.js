import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const stateCache = new Map();

function persistentPrivateSessions(path) {
  let signature;
  try {
    const stat=statSync(path,{bigint:true});
    signature=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const cached=stateCache.get(path);
  if(cached?.signature===signature) return cached;
  let team;
  try { team = JSON.parse(readFileSync(path, 'utf8')); }
  catch {
    const invalid={signature,valid:false,sessions:new Set()};
    stateCache.set(path,invalid);return invalid;
  }
  if (team?.version !== 1 || !team.bots || typeof team.bots !== 'object' || !Array.isArray(team.privateArchives ?? [])) {
    const invalid={signature,valid:false,sessions:new Set()};
    stateCache.set(path,invalid);return invalid;
  }
  const bots = [...Object.values(team.bots).filter(bot => bot?.private === true), ...(team.privateArchives ?? [])];
  const sessions=new Set(bots.flatMap(bot => [bot.id, bot.sessionId, ...(bot.sessionIds ?? []), ...(bot.segments ?? []).map(part => part.sessionId)]).filter(Boolean));
  const loaded={signature,valid:true,sessions};
  stateCache.set(path,loaded);return loaded;
}

// dshbot exposes live checks so an in-memory privacy change takes effect before its
// asynchronous save. The persisted team protects archived Sessions after unload.
export function privateBotSession(sessionId, dshHome) {
  if (!sessionId) return false;
  const checks = globalThis[Symbol.for('dshbot.private-session-checks')];
  if (checks) for (const check of checks) if (check(sessionId)) return true;
  try {
    const state=persistentPrivateSessions(join(dshHome, 'dshbot', 'state.json'));
    if (!state) return false;
    // Unknown or corrupt state must not be treated as proof that a session is public.
    return !state.valid || state.sessions.has(sessionId);
  } catch { return true; }
}

export const memoryHasPrivateSource = (memory, isPrivate) => (memory.sources ?? []).some(source => isPrivate(source.sessionId));
