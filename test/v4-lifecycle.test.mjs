import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, SCHEMA_VERSION, normalizeValidity } from '../lib/store.js';

const source={sessionId:'user-session',eventId:'1',eventSeq:1,eventTime:'2026-10-24T01:00:00.000Z',quote:'用户明确证据',evidence:'user-explicit'};
const fact=(content,extra={})=>({content,scope:'global',factKey:'stable-key',sources:[source],...extra});
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'jiyi-v4-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path:join(dir,'memory.sqlite')};}
function downgrade(path,version){
  const db=new DatabaseSync(path);
  try {
    db.exec(`DROP TABLE IF EXISTS recall_feedback; DROP TABLE IF EXISTS conflict_members; DROP TABLE IF EXISTS conflict_groups;
      DROP TABLE IF EXISTS memory_candidates; DROP TABLE IF EXISTS memory_decisions; DROP TABLE IF EXISTS memory_relations;
      DROP TABLE IF EXISTS memory_evidence; DROP TABLE IF EXISTS consolidation_jobs;`);
    for(const column of ['review_state','valid_from','valid_to','validity_kind','validity_precision','last_confirmed_at','time_zone']) db.exec(`ALTER TABLE memories DROP COLUMN ${column}`);
    if(version<3){db.exec('ALTER TABLE queue DROP COLUMN failure; ALTER TABLE queue DROP COLUMN attempt_history;');}
    if(version<2)db.exec('ALTER TABLE memories DROP COLUMN status_ttl_hours;');
    db.exec(`PRAGMA user_version=${version}`);
  } finally {db.close();}
}

test('v1, v2 and v3 migrate transactionally to v4 with WAL-consistent backups and idempotent reopen',t=>{
  const f=fixture(t),seed=new MemoryStore(f.path);
  const memory=seed.putMemory(fact('迁移事实'));seed.close();
  for(const version of [1,2,3]) {
    const path=join(f.dir,`v${version}.sqlite`);copyFileSync(f.path,path);downgrade(path,version);
    let store=new MemoryStore(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
    assert.ok(store.lastMigrationBackup&&existsSync(store.lastMigrationBackup),`v${version} backup`);
    assert.equal(store.getMemory(memory.id).validityKind,'unknown');assert.equal(store.getMemory(memory.id).reviewState,'clear');
    assert.equal(store.getMemoryDetail(memory.id).evidence[0].evidenceKind,'user_statement');
    assert.equal(store.getMemoryDetail(memory.id).relations[0].relation,'supports');
    store.close();store=new MemoryStore(path);assert.equal(store.db.prepare("SELECT count(*) n FROM memory_evidence WHERE memory_id=?").get(memory.id).n,1);store.close();
  }
});

test('migration fault rolls back schema and restores the pre-migration logical image',t=>{
  const f=fixture(t),seed=new MemoryStore(f.path);const memory=seed.putMemory(fact('回滚事实'));seed.close();
  downgrade(f.path,3);
  assert.throws(()=>new MemoryStore(f.path,{migrationFault:()=>{throw new Error('migration fault');}}),/migration fault/);
  const restored=new DatabaseSync(f.path,{readOnly:true});
  try {
    assert.equal(restored.prepare('PRAGMA user_version').get().user_version,3);
    assert.equal(restored.prepare('SELECT content FROM memories WHERE id=?').get(memory.id).content,'回滚事实');
    assert.equal(restored.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name='memory_evidence'").get().n,0);
    assert.equal(restored.prepare('PRAGMA table_info(memories)').all().some(row=>row.name==='review_state'),false);
  } finally {restored.close();}
});

test('memory, evidence, relations and decision write atomically and invalid embeddings roll all of them back',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    assert.throws(()=>store.putMemory(fact('原子失败',{embedding:[0,0],embeddingModel:'test'})),/nonzero/);
    for(const table of ['memories','memory_versions','memory_evidence','memory_relations','memory_decisions','vectors','memory_fts']) assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);
    const saved=store.putMemory(fact('原子成功'));assert.equal(store.getMemoryDetail(saved.id).evidence.length,1);assert.equal(store.getMemoryDetail(saved.id).relations.length,1);assert.equal(store.getMemoryDetail(saved.id).decisions.length,1);
  } finally {store.close();}
});

test('time zones are IANA-only and validity boundaries exclude validTo',()=>{
  assert.equal(normalizeValidity({validityKind:'interval',validFrom:'2026-01-01T00:00:00Z',validTo:'2026-02-01T00:00:00Z',validityPrecision:'day',timeZone:'Asia/Tokyo'},[source],'project_fact').timeZone,'Asia/Tokyo');
  assert.throws(()=>normalizeValidity({validityKind:'interval',validFrom:'2026-01-01T00:00:00Z',validityPrecision:'day',timeZone:'+09:00'},[source],'project_fact'),{code:'INVALID_MEMORY_TIME'});
  assert.throws(()=>normalizeValidity({validityKind:'interval',validFrom:'2026-02-01T00:00:00Z',validTo:'2026-01-01T00:00:00Z',validityPrecision:'day'},[source],'project_fact'),{code:'INVALID_MEMORY_TIME'});
});

test('pending and expired memories stay out of automatic recall while explicit history remains available',t=>{
  const f=fixture(t),store=new MemoryStore(f.path,{clock:()=> '2026-03-01T00:00:00.000Z'});
  try {
    const pending=store.putMemory({...fact('待审事实'),reviewState:'pending'});
    const expired=store.putMemory({...fact('过期事实',{factKey:'expired'}),validityKind:'interval',validFrom:'2026-01-01T00:00:00Z',validTo:'2026-02-01T00:00:00Z',validityPrecision:'day'});
    const current=store.putMemory({...fact('当前事实',{factKey:'current'}),validityKind:'unknown'});
    assert.deepEqual(store.listCandidates().map(item=>item.id),[current.id]);
    assert.deepEqual(store.listMemories({scope:'all',status:'active',reviewState:'pending'}).map(item=>item.id),[pending.id]);
    assert.equal(store.getMemory(expired.id).content,'过期事实');
  } finally {store.close();}
});

test('conflict claims enforce tokens and leave multi-candidate groups for explicit resolution',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const old=store.putMemory(fact('旧事实'));
    const stage=(content)=>store.stageMemoryCandidate({memory:{content,scope:'global',factKey:'stable-key',sources:[{...source,eventId:String(Math.random()),quote:content,evidence:'user-correction'}]},conflictMemoryIds:[old.id],expectedMemberVersions:{[old.id]:old.version},route:{provider:'p',model:'m',timeoutMs:1000}});
    const first=stage('新事实一'),second=stage('新事实二');assert.equal(first.group.id,second.group.id);
    assert.equal(store.claimConflictGroups({limit:1,leaseMs:1000}).length,0,'multi-candidate groups must remain manual');
    const resolved=store.resolveConflict({groupId:first.group.id,candidateId:second.candidateId,decision:'same_claim_newer'});
    assert.equal(resolved.group.state,'resolved');assert.equal(store.getMemory(resolved.memory.id).content,'新事实二');
    assert.equal(store.db.prepare('SELECT state FROM memory_candidates WHERE id=?').get(first.candidateId).state,'rejected');
  } finally {store.close();}
});

test('single-candidate groups enforce leases and can resolve manual selection; zero-candidate reviews are manual-only',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const old=store.putMemory(fact('旧事实'));
    const staged=store.stageMemoryCandidate({memory:{content:'新事实',scope:'global',factKey:'stable-key',sources:[{...source,eventId:'2',eventSeq:2,quote:'新事实',evidence:'user-correction'}]},conflictMemoryIds:[old.id],expectedMemberVersions:{[old.id]:old.version},route:{provider:'p',model:'m',timeoutMs:1000}});
    const [claimed]=store.claimConflictGroups({limit:1,leaseMs:1000});assert.ok(claimed.token);
    assert.throws(()=>store.resolveConflict({groupId:claimed.id,decision:'same_claim_newer',token:'wrong'}),{code:'CONFLICT_LEASE_LOST'});
    assert.throws(()=>store.releaseConflictGroup(claimed.id,new Error('x'),'wrong'),{code:'CONFLICT_LEASE_LOST'});
    const resolved=store.resolveConflict({groupId:claimed.id,candidateId:staged.candidateId,decision:'same_claim_newer',token:claimed.token});
    assert.equal(resolved.group.state,'resolved');assert.equal(store.getMemory(resolved.memory.id).content,'新事实');
    const peer=store.putMemory({...fact('另一事实'),factKey:'stable-peer'}),review=store.openConflictReview({memories:[resolved.memory,peer],reasonCode:'validation'});
    assert.equal(store.claimConflictGroups({limit:1,leaseMs:1000}).length,0);assert.equal(store.getConflictGroup(review.id).state,'open');
  } finally {store.close();}
});

test('open conflict review blocks a consolidation update before it can reject the candidate',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const old=store.putMemory(fact('待裁决事实',{factKey:'guarded'})),staged=store.stageMemoryCandidate({memory:{content:'保留的候选',scope:'global',factKey:'guarded',sources:[{...source,eventId:'2',eventSeq:2,quote:'保留的候选'}]},conflictMemoryIds:[old.id],route:{provider:'p',model:'m'}});
    assert.throws(()=>store.putMemory({...old,content:'巩固误写',sources:[...old.sources,{...source,eventId:'3',eventSeq:3,eventTime:'2026-10-24T02:00:00.000Z',quote:'巩固误写'}],expectedVersion:old.version},{requireClear:true}),{code:'CONFLICT_REVIEW_OPEN'});
    assert.equal(store.getConflictGroup(staged.group.id).state,'open');assert.equal(store.getConflictGroup(staged.group.id).members.find(item=>item.kind==='candidate').candidate.state,'pending');
  } finally {store.close();}
});

test('distinct claims can coexist only when their fact keys do not collide',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const old=store.putMemory(fact('旧键事实'));
    const stage=store.stageMemoryCandidate({memory:{content:'新键事实',scope:'global',factKey:'new-key',sources:[{...source,eventId:'2',eventSeq:2,quote:'新键事实',evidence:'user-explicit'}]},conflictMemoryIds:[old.id],expectedMemberVersions:{[old.id]:old.version},route:{provider:'p',model:'m'}});
    const [claimed]=store.claimConflictGroups({limit:1,leaseMs:1000});
    const resolved=store.resolveConflict({groupId:stage.group.id,decision:'distinct_claims',token:claimed.token});
    assert.equal(resolved.group.state,'resolved');assert.equal(resolved.memory.factKey,'new-key');
    assert.equal(store.getMemory(old.id).reviewState,'clear');assert.equal(store.getMemory(resolved.memory.id).reviewState,'clear');
  } finally {store.close();}
});

test('resolving one conflict does not unisolate a memory owned by another open group',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const a=store.putMemory(fact('共享事实 A',{factKey:'a'})),b=store.putMemory(fact('事实 B',{factKey:'b'})),c=store.putMemory(fact('事实 C',{factKey:'c'}));
    const ab=store.stageMemoryCandidate({memory:{content:'候选 AB',scope:'global',factKey:'ab-candidate',sources:[{...source,eventId:'2',eventSeq:2,quote:'候选 AB'}]},conflictMemoryIds:[a.id,b.id],route:{provider:'p',model:'m'}});
    const ac=store.stageMemoryCandidate({memory:{content:'候选 AC',scope:'global',factKey:'ac-candidate',sources:[{...source,eventId:'3',eventSeq:3,quote:'候选 AC'}]},conflictMemoryIds:[a.id,c.id],route:{provider:'p',model:'m'}});
    const [claimed]=store.claimConflictGroups({limit:1,leaseMs:1000});
    store.resolveConflict({groupId:ab.group.id,decision:'distinct_claims',token:claimed.token});
    assert.equal(store.getConflictGroup(ac.group.id).state,'open');assert.equal(store.getMemory(a.id).reviewState,'pending');assert.equal(store.getMemory(b.id).reviewState,'clear');
  } finally {store.close();}
});

test('updating or deleting a conflict member dismisses every stale group',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const old=store.putMemory(fact('待替换事实'));
    const staged=store.stageMemoryCandidate({memory:{content:'冲突候选',scope:'global',factKey:'new-key',sources:[{...source,eventId:'2',eventSeq:2,quote:'冲突候选'}]},conflictMemoryIds:[old.id],route:{provider:'p',model:'m'}});
    const updated=store.putMemory({...old,content:'用户已手工纠正',sources:[...old.sources,{...source,eventId:'3',eventSeq:3,eventTime:'2026-10-24T02:00:00.000Z',quote:'用户已手工纠正',evidence:'user-correction'}],expectedVersion:old.version});
    assert.equal(store.getConflictGroup(staged.group.id).state,'dismissed');assert.equal(updated.reviewState,'clear');
  } finally {store.close();}
});

test('recall-only list filtering happens before the 2000-record cap',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const current=store.putMemory({...fact('应被检索的当前事实'),factKey:'current',createdAt:undefined});
    store.transaction(()=>{
      for(let i=0;i<2001;i++) store.putMemory({...fact(`待审 ${i}`,{factKey:`pending-${i}`}),reviewState:'pending'});
    });
    const rows=store.listAllMemories({limit:2000,recallOnly:true});
    assert.equal(rows.length,1);assert.equal(rows[0].id,current.id);
  } finally {store.close();}
});

test('deletion clears quote and candidate bodies while retaining hashes, locators, versions, relations and decisions',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const old=store.putMemory(fact('删除正文',{embedding:[1,2],embeddingModel:'test'}));
    const candidate='候选敏感正文';store.stageMemoryCandidate({memory:{content:candidate,scope:'global',factKey:'stable-key',sources:[{...source,eventId:'2',eventSeq:2,quote:candidate,evidence:'user-correction'}]},conflictMemoryIds:[old.id],route:{provider:'p',model:'m'}});
    const deleted=store.deleteMemory(old.id,{expectedVersion:old.version});assert.equal(deleted.content,'');
    assert.equal(store.getStatus().vectors,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_fts').get().n,0);
    assert.ok(store.getMemoryDetail(old.id).evidence.every(item=>item.quote===''&&/^[a-f0-9]{64}$/.test(item.quoteSha256)));
    assert.ok(store.getMemoryDetail(old.id).relations.length>=1);assert.ok(store.getMemoryDetail(old.id).decisions.length>=1);
    assert.ok(store.getVersions(old.id).every(item=>item.content===''&&item.sources.every(source=>!('quote' in source)&&!('evidence' in source))));
    const raw=store.db.prepare("SELECT payload FROM memory_candidates").get().payload;assert.doesNotMatch(raw,/候选敏感正文|删除正文/);
  } finally {store.close();}
});

test('recall feedback requires an injected recall in the same session and only user feedback can trigger review',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const memory=store.putMemory(fact('反馈事实'));
    const prepared=store.recordRecall({sessionId:'s',requestId:'r',status:'prepared',memories:[memory]});
    assert.throws(()=>store.recordRecallFeedback({recallId:prepared.id,requestId:'r',memoryId:memory.id,memoryVersion:memory.version,kind:'explicit_useful',origin:'user',expectedSessionId:'s'}),{code:'FEEDBACK_NOT_INJECTED'});
    store.recordRecall({sessionId:'s',requestId:'r',status:'injected',memories:[memory]});
    assert.throws(()=>store.recordRecallFeedback({recallId:prepared.id,requestId:'r',memoryId:memory.id,memoryVersion:memory.version,kind:'explicit_useful',origin:'user',expectedSessionId:'other'}),{code:'FEEDBACK_SESSION_MISMATCH'});
    store.recordRecallFeedback({recallId:prepared.id,requestId:'r',memoryId:memory.id,memoryVersion:memory.version,kind:'explicit_wrong',origin:'user',expectedSessionId:'s'});
    assert.equal(store.getMemory(memory.id).reviewState,'pending');assert.ok(store.listRecallFeedback({recallId:prepared.id}).some(item=>item.kind==='explicit_wrong'&&item.origin==='user'));
  } finally {store.close();}
});

test('consolidation jobs are idempotent, leased and separate from the extraction queue',t=>{
  const f=fixture(t),store=new MemoryStore(f.path);
  try {
    const one=store.enqueueConsolidation({idempotencyKey:'pair',payload:{a:1}}),two=store.enqueueConsolidation({idempotencyKey:'pair',payload:{a:2}});
    assert.equal(one.id,two.id);assert.equal(store.getStatus().queue.pending,0);assert.equal(store.getStatus().consolidation.pending,1);
    const [job]=store.claimConsolidationJobs({leaseMs:1000});assert.ok(job.token);assert.throws(()=>store.completeConsolidationJob(job.id,'wrong'),/lease lost/);
    assert.equal(store.failConsolidationJob(job.id,job.token,new Error('retry'),{retryDelayMs:0}).state,'pending');
  } finally {store.close();}
});

test('consolidation completion and failure reject an expired lease',t=>{
  let now='2026-03-01T00:00:00.000Z';
  const f=fixture(t),store=new MemoryStore(f.path,{clock:()=>now});
  try {
    store.enqueueConsolidation({idempotencyKey:'expired-complete',payload:{a:1},maxAttempts:3});
    const [completeJob]=store.claimConsolidationJobs({leaseMs:1000});now='2026-03-01T00:00:02.000Z';
    assert.throws(()=>store.completeConsolidationJob(completeJob.id,completeJob.token,{ok:true}),{code:'CONSOLIDATION_LEASE_LOST'});
    assert.throws(()=>store.failConsolidationJob(completeJob.id,completeJob.token,new Error('late')),{code:'CONSOLIDATION_LEASE_LOST'});
  } finally {store.close();}
});
