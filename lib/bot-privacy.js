import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// dshbot exposes live checks so an in-memory privacy change takes effect before its
// asynchronous save. The persisted team protects archived Sessions after unload.
export function privateBotSession(sessionId, dshHome) {
  if (!sessionId) return false;
  const checks = globalThis[Symbol.for('dshbot.private-session-checks')];
  if (checks) for (const check of checks) if (check(sessionId)) return true;
  let team;
  try { team = JSON.parse(readFileSync(join(dshHome, 'dshbot', 'state.json'), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    // Unknown state must not be treated as proof that a session is public.
    return true;
  }
  if (team?.version !== 1 || !team.bots || typeof team.bots !== 'object' || !Array.isArray(team.privateArchives ?? [])) return true;
  const bots = [...Object.values(team.bots).filter(bot => bot?.private === true), ...(team.privateArchives ?? [])];
  return bots.some(bot => [bot.id, bot.sessionId, ...(bot.sessionIds ?? []), ...(bot.segments ?? []).map(part => part.sessionId)].includes(sessionId));
}

export const memoryHasPrivateSource = (memory, isPrivate) => (memory.sources ?? []).some(source => isPrivate(source.sessionId));
