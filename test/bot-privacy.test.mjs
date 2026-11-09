import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateBotSession, memoryHasPrivateSource } from '../lib/bot-privacy.js';

test('private Bot sessions and archives stay closed across live and saved state', () => {
  const home = mkdtempSync(join(tmpdir(), 'jiyi-bot-privacy-'));
  const key = Symbol.for('dshbot.private-session-checks');
  try {
    mkdirSync(join(home, 'dshbot'));
    const path = join(home, 'dshbot', 'state.json');
    writeFileSync(path, JSON.stringify({version:1,bots:{b:{id:'b',private:true,sessionId:'current',segments:[{sessionId:'past'}]},p:{id:'p'}},privateArchives:[{id:'old',sessionIds:['archived']}]}));
    for (const id of ['b','current','past','old','archived']) assert.equal(privateBotSession(id,home),true,id);
    assert.equal(privateBotSession('p',home),false);
    const live = id => id === 'changing';
    globalThis[key] ??= new Set(); globalThis[key].add(live);
    assert.equal(privateBotSession('changing',home),true);
    globalThis[key].delete(live);
    assert.equal(privateBotSession('changing',home),false);
    assert.equal(memoryHasPrivateSource({sources:[{sessionId:'past'}]},id=>privateBotSession(id,home)),true);
    writeFileSync(path, '{broken');
    assert.equal(privateBotSession('unknown',home),true);
    writeFileSync(path, JSON.stringify({version:1,bots:{refreshed:{id:'refreshed',private:true,sessionId:'new-private'}},privateArchives:[]}));
    assert.equal(privateBotSession('new-private',home),true);
    assert.equal(privateBotSession('past',home),false,'file changes invalidate the cached privacy set');
  } finally { if (globalThis[key]?.size === 0) delete globalThis[key]; rmSync(home,{recursive:true,force:true}); }
});
