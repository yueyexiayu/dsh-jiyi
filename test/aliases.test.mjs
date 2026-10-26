import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryStore, planProjectAliasBackfill, normalizeProjectLabel } from '../lib/store.js';
import { searchMemories } from '../lib/search.js';
import { validateSettings } from '../lib/index.js';
import { databaseSnapshot } from '../lib/eval-integrity.js';
import { EMBEDDING_MODEL, EMBEDDING_VERSION, EMBEDDING_DIMENSIONS } from '../lib/models.js';
const sources=[{sessionId:'user',eventTime:'2026-10-24T00:00:00Z',eventSeq:1,quote:'用户明确陈述的项目事实'}];
const vector=Array.from({length:EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0);
const models={getStatus:()=>({status:'ready'}),embed:async texts=>({vectors:texts.map(()=>vector),model:EMBEDDING_MODEL,version:EMBEDDING_VERSION})};
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'jiyi-alias-')),database=join(dir,'memory.sqlite'),store=new MemoryStore(database);
  t.after(()=>{store.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true});});
  return {dir,database,store};
}

test('first project recognition registers its folder; alias recall ignores spacing, width and case without scope leakage',async t=>{
  const {dir,store}=fixture(t);
  const a=store.resolveProject({cwd:join(dir,'水杉A')}),b=store.resolveProject({cwd:join(dir,'银杏B'),name:'后台财务项目'});
  assert.ok(b.aliases.includes('银杏B'));assert.equal(normalizeProjectLabel(' 银 杏　Ｂ '),'银杏b');
  store.putMemory({id:'b-fact',content:'项目发票金额使用字符串',scope:'project',projectId:b.id,sources});
  const relevance={getStatus:()=>({status:'ready'}),judge:async({candidates})=>({ids:candidates.map(({id,version})=>({id,version}))})};
  for(const label of ['银杏 B','银杏B','银杏　Ｂ','银杏 b']) {
    const result=await searchMemories({query:label+' 的发票金额规则',store,settings:validateSettings({}),models,relevance,resolveCurrentProject:()=>a});
    assert.equal(result.status,'hit',result.error);assert.deepEqual(result.memories.map(m=>m.id),['b-fact']);
  }
  const unrelated=await searchMemories({query:'发票金额规则',store,settings:validateSettings({}),models,relevance,resolveCurrentProject:()=>a});
  assert.equal(unrelated.status,'no-hit');
  store.deleteProjectAlias(b.id,'银杏B');
  assert.equal(store.resolveProject({cwd:b.path}).aliases.includes('银杏B'),false,'explicit deletion must not be re-added on every turn');
  store.addProjectAlias(b.id,'财政Ｂ');store.addProjectAlias(b.id,'财政 b');
  assert.equal(store.getProject(b.id).aliases.filter(a=>normalizeProjectLabel(a)==='财政b').length,1);
  assert.throws(()=>store.addProjectAlias(a.id,'财政 B'),{code:'PROJECT_ALIAS_CONFLICT'});
});

test('folder alias collisions do not merge projects or break recognition, and are visibly ambiguous',async t=>{
  const {dir,store}=fixture(t);
  const a=store.resolveProject({cwd:join(dir,'first','银杏B'),name:'甲'}),b=store.resolveProject({cwd:join(dir,'second','银杏 B'),name:'乙'});
  assert.notEqual(a.id,b.id);assert.equal(b.aliasConflict,'银杏 B');
  const result=await searchMemories({query:'银杏 Ｂ的状态',store,settings:validateSettings({}),models,relevance:{getStatus:()=>({status:'ready'})}});
  assert.equal(result.status,'ambiguous');assert.deepEqual(result.memories,[]);
});

test('legacy migration previews additions, preserves all existing aliases, is idempotent and rejects stale plans',t=>{
  const {dir,store}=fixture(t);
  const p=store.resolveProject({cwd:join(dir,'银杏B')});
  store.deleteProjectAlias(p.id,'银杏B');store.addProjectAlias(p.id,'旧别名');
  const before=store.db.prepare('SELECT alias,project_id FROM project_aliases ORDER BY alias').all();
  const plan=planProjectAliasBackfill(store.db);
  assert.deepEqual(plan.additions.map(r=>r.alias),['银杏B']);assert.deepEqual(plan.conflicts,[]);
  assert.deepEqual(store.db.prepare('SELECT alias,project_id FROM project_aliases ORDER BY alias').all(),before,'preview is read-only');
  const migrated=store.applyProjectAliasBackfill(plan);assert.deepEqual(migrated.removed,[]);
  assert.ok(store.getProject(p.id).aliases.includes('旧别名'));assert.ok(store.getProject(p.id).aliases.includes(p.path));
  assert.deepEqual(planProjectAliasBackfill(store.db).additions,[]);
  assert.throws(()=>store.applyProjectAliasBackfill(plan),/预览已变化/);
});

test('migration CLI backs up WAL-aware SQLite before writing and never deletes old aliases',t=>{
  const {dir,database,store}=fixture(t),p=store.resolveProject({cwd:join(dir,'银杏B')});store.deleteProjectAlias(p.id,'银杏B');store.addProjectAlias(p.id,'保留别名');
  const script=resolve(import.meta.dirname,'../scripts/migrate-aliases.mjs'),preview=join(dir,'preview.json'),backup=join(dir,'backup.sqlite'),output=join(dir,'result.json');
  const before=databaseSnapshot(database);
  execFileSync('/usr/local/bin/node',[script,'--plan','--database',database,'--output',preview]);
  assert.deepEqual(databaseSnapshot(database),before);
  assert.deepEqual(JSON.parse(readFileSync(preview,'utf8')).plan.additions.map(r=>r.alias),['银杏B']);
  execFileSync('/usr/local/bin/node',[script,'--apply','--database',database,'--preview',preview,'--backup',backup,'--output',output]);
  const result=JSON.parse(readFileSync(output,'utf8'));assert.equal(result.ok,true);assert.deepEqual(result.removed,[]);
  assert.ok(store.getProject(p.id).aliases.includes('保留别名'));assert.ok(store.getProject(p.id).aliases.includes('银杏B'));
  const restored=new MemoryStore(backup);try {assert.ok(restored.getProject(p.id).aliases.includes('保留别名'));assert.equal(restored.getProject(p.id).aliases.includes('银杏B'),false);}finally{restored.close();}
});
