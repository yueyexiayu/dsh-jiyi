import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';

const source = {sessionId:'session-new',eventId:'42',eventSeq:42,eventTime:'2026-10-24T01:00:00.000Z',quote:'User explicitly said this',evidence:'User explicitly said this'};
const fact = (content,extra={}) => ({content,scope:'global',sources:[source],...extra});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'jiyi-store-test-'));
  const path = join(dir,'memory.sqlite');
  let time = '2026-10-24T01:00:00.000Z';
  let store = openStore(path,{clock:()=>time});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},path,setTime(value){time=value;},restart(){store.close();store=openStore(path,{clock:()=>time});return store;}};
}

test('fresh database contains no imported history; project identities persist and names never merge',t=>{
  const f=fixture(t),s=f.store;
  assert.equal(s.getStatus().memories,0);
  const a=s.resolveProject({path:'/tmp/jiyi-project-a',name:'same'});
  const b=s.resolveProject({path:'/tmp/jiyi-project-b',name:'same'});
  assert.notEqual(a.id,b.id);
  assert.equal(s.getProject(a.id).ambiguities[0].id,b.id);
  s.addProjectAlias(a.id,'explicit-remote-a');
  assert.equal(s.resolveProject({path:'/tmp/jiyi-project-moved',aliases:['explicit-remote-a']}).id,a.id);
  assert.throws(()=>s.resolveProject({path:b.path,aliases:['explicit-remote-a']}),/different projects/);
  assert.equal(f.restart().resolveProject({path:a.path}).id,a.id);
});

test('optional project lookup preserves null/unknown semantics and propagates real SQLite errors',t=>{
  const {store:s}=fixture(t);
  const project=s.resolveProject({path:'/tmp/jiyi-optional-project',name:'Optional lookup'});
  assert.deepEqual(s.getProject(project.id),project);
  assert.equal(s.getProject('unknown-project-id'),null);
  assert.equal(s.getProject(''),null);
  assert.equal(s.getProject(null),null);
  assert.equal(s.getProject(),null);
  assert.equal(s.getProject(undefined),null);
  // An invalid named binding must still fail, not turn into a missing record.
  assert.throws(()=>s.getProject({unknownProjectParameter:'project-id'}));
  assert.deepEqual(s.getProject(project.id),project);
  // A missing context is not a blanket catch around query/schema failures.
  s.db.exec('ALTER TABLE projects RENAME TO projects_optional_lookup');
  try { assert.throws(()=>s.getProject(project.id),/no such table: projects/); }
  finally { s.db.exec('ALTER TABLE projects_optional_lookup RENAME TO projects'); }
  assert.deepEqual(s.getProject(project.id),project);
});

test('memory/vector/FTS atomicity, strict scopes, source provenance and optimistic correction',t=>{
  const {store:s}=fixture(t);
  const project=s.resolveProject({path:'/tmp/jiyi-scope-project'});
  const other=s.resolveProject({path:'/tmp/jiyi-other-project'});
  const original=s.putMemory(fact('Always use sqlite transactions',{embedding:[1,0],embeddingModel:'test-v1'}));
  assert.equal(original.version,1);
  assert.equal(original.sources[0].eventSeq,42);
  assert.equal(original.source.evidence,source.evidence);
  s.putMemory(fact('Project uses postgres',{scope:'project',projectId:project.id}));
  s.putMemory(fact('Other private fact',{scope:'project',projectId:other.id}));
  assert.equal(s.listCandidates().length,1);
  assert.equal(s.listCandidates({projectId:project.id}).length,2);
  assert.equal(s.listCandidates({projectId:project.id,scope:'global'}).length,1);
  assert.equal(s.listCandidates({projectId:project.id,scope:'project'}).length,1);
  assert.equal(s.searchText('private',{projectId:project.id}).length,0);
  assert.equal(s.searchText('sqlite')[0].id,original.id);
  assert.throws(()=>s.putMemory(fact('Broken transaction',{embedding:[NaN],embeddingModel:'test'})),/embedding/);
  assert.equal(s.getStatus().memories,3);
  assert.equal(s.searchText('Broken').length,0);
  assert.throws(()=>s.replaceMemory(original.id,fact('New value')),/version conflict/);
  const corrected=s.replaceMemory(original.id,fact('Always use WAL transactions'),{expectedVersion:1});
  assert.equal(corrected.id,original.id);
  assert.equal(corrected.version,2);
  assert.equal(corrected.embedding,null);
  assert.equal(s.searchText('sqlite').length,0);
  assert.equal(s.searchText('WAL')[0].id,original.id);
  assert.throws(()=>s.setEmbedding(original.id,[1,2],'test',{expectedVersion:1}),/version conflict/);
  s.setEmbedding(original.id,[1,2],'test',{expectedVersion:2});
  assert.deepEqual(s.getMemory(original.id).embedding,[1,2]);
  assert.equal(s.getVersions(original.id).length,2);
});

test('fact-key substitution is transactional and cannot replace across project/global boundary',t=>{
  const {store:s}=fixture(t);
  const p=s.resolveProject({path:'/tmp/jiyi-replace-project'});
  const a=s.putMemory(fact('Old preference',{factKey:'editor',embedding:[1,0],embeddingModel:'test'}));
  const b=s.putMemory(fact('New preference',{factKey:'editor'}));
  assert.equal(s.getMemory(a.id).status,'superseded');
  assert.equal(s.getMemory(a.id).supersededBy,b.id);
  assert.equal(s.getMemory(a.id).embedding,null);
  assert.equal(s.searchText('Old').length,0);
  const before=s.getStatus();
  assert.throws(()=>s.putMemory(fact('Cross project replacement',{scope:'project',projectId:p.id,supersedes:b.id})),/another scope/);
  assert.deepEqual(s.getStatus(),before);
  assert.throws(()=>s.putMemory(fact('Bad new key',{factKey:'editor',embedding:[0,0],embeddingModel:'test'})),/nonzero/);
  assert.equal(s.getMemory(b.id).status,'active');
  assert.equal(s.searchText('New preference')[0].id,b.id);
  // A caller may handle a failed nested write and still commit other work.
  s.transaction(()=>{
    assert.throws(()=>s.putMemory(fact('Nested broken substitution',{factKey:'editor',embedding:[0,0],embeddingModel:'test'})),/nonzero/);
    s.setMetadata('unrelated-commit',true);
  });
  assert.equal(s.getMetadata('unrelated-commit'),true);
  assert.equal(s.getMemory(b.id).status,'active');
  assert.equal(s.searchText('Nested').length,0);
});

test('Chinese keyword search, deletion removes vectors/FTS and historical evidence',t=>{
  const {store:s}=fixture(t);
  const m=s.putMemory(fact('用户偏好中文回复',{embedding:[1,2,3],embeddingModel:'test'}));
  assert.equal(s.searchText('中文')[0].id,m.id);
  assert.equal(s.searchText('偏好中文')[0].id,m.id);
  s.replaceMemory(m.id,fact('始终中文回复'),{expectedVersion:1});
  const deleted=s.deleteMemory(m.id,{expectedVersion:2});
  assert.equal(deleted.status,'deleted');
  assert.equal(deleted.content,'');
  assert.deepEqual(deleted.sources,[{sessionId:source.sessionId,eventId:source.eventId,eventSeq:source.eventSeq,eventTime:source.eventTime}]);
  assert.equal(s.searchText('中文').length,0);
  assert.equal(s.getStatus().vectors,0);
  assert.deepEqual(s.getVersions(m.id).map(v=>v.version),[1,2,3]);
  assert.ok(s.getVersions(m.id).every(v=>v.content==='' && v.sources[0].eventId==='42' && !('quote' in v.sources[0]) && !('evidence' in v.sources[0]) && v.embedding===null));
  assert.throws(()=>s.putMemory(fact('revive',{id:m.id,expectedVersion:deleted.version})),/cannot be revived/);
});

test('queue is idempotent, leases survive restart and bounded retries become visible failures',t=>{
  const f=fixture(t),s=f.store;
  const job=s.enqueueEvent({sessionId:'s',eventSeq:1,eventTime:source.eventTime,payload:{text:'new event'},maxAttempts:2});
  assert.equal(s.enqueueEvent({sessionId:'s',eventId:'1',eventTime:source.eventTime,payload:{text:'duplicate'}}).id,job.id);
  assert.equal(s.getStatus().queue.pending,1);
  const claimed=s.claimJobs({leaseMs:1000})[0];
  assert.equal(claimed.attempts,1);
  assert.equal(s.claimJobs().length,0);
  f.restart();
  f.setTime('2026-10-24T01:00:02.000Z');
  const retry=f.store.claimJobs()[0];
  assert.equal(retry.id,job.id);
  assert.equal(retry.attempts,2);
  assert.notEqual(retry.token,claimed.token);
  assert.throws(()=>f.store.completeJob(job.id,claimed.token),/lease lost/);
  const failed=f.store.failJob(job.id,retry.token,new Error('model unavailable'));
  assert.equal(failed.state,'failed');
  assert.equal(failed.lastError,'model unavailable');
  assert.equal(f.store.claimJobs().length,0);
  assert.equal(f.restart().getStatus().queue.failed,1);
  assert.equal(f.store.listJobs({limit:1})[0].id,job.id);
  const reset=f.store.retryJob(job.id);
  assert.equal(reset.state,'pending');
  assert.equal(reset.attempts,0);
  assert.deepEqual(reset.payload,{text:'new event'});
  assert.throws(()=>f.store.retryJob(job.id),/Only failed/);
  const final=f.store.claimJobs()[0];
  f.store.completeJob(final.id,final.token);
  assert.throws(()=>f.store.retryJob(final.id),/Only failed/);
});

test('completeJob commits memory, vector, FTS, cursor and done state as one batch',t=>{
  const {store:s}=fixture(t);
  const queued=s.enqueueEvent({sessionId:'s',eventId:'evt',eventTime:source.eventTime});
  const claimed=s.claimJobs()[0];
  assert.throws(()=>s.completeJob(queued.id,claimed.token,{memories:[fact('valid atomic memory'),fact('invalid',{embedding:[],embeddingModel:'test'})],cursor:{key:'s',value:42}}),/embedding/);
  assert.equal(s.getStatus().memories,0);
  assert.equal(s.getCursor('s'),null);
  assert.equal(s.getJob(queued.id).state,'running');
  const result=s.completeJob(queued.id,claimed.token,{memories:[fact('Atomic committed memory',{embedding:[1,1],embeddingModel:'test'})],cursor:{key:'s',value:42}});
  assert.equal(result.job.state,'done');
  assert.deepEqual(result.job.payload,{});
  assert.equal(result.memories.length,1);
  assert.equal(s.getStatus().vectors,1);
  assert.equal(s.searchText('committed').length,1);
  assert.equal(s.getCursor('s'),42);
  assert.throws(()=>s.completeJob(queued.id,claimed.token),/lease lost/);
});

test('model versions and explicit management APIs do not weaken retrieval scopes',t=>{
  const f=fixture(t),s=f.store;
  const project=s.resolveProject({path:'/tmp/jiyi-management-project',name:'Before'});
  assert.equal(s.renameProject(project.id,'After',['explicit-project-alias']).name,'After');
  assert.ok(s.getProject(project.id).aliases.includes('explicit-project-alias'));
  const other=s.resolveProject({path:'/tmp/jiyi-management-other'});
  assert.throws(()=>s.renameProject(project.id,'Should rollback',[other.path]),/another project/);
  assert.equal(s.getProject(project.id).name,'After');
  const m=s.putMemory(fact('Model metadata',{type:'preference',extractionModel:'extractor-v1',extractionVersion:'prompt-sha-1',embedding:[1,2],embeddingModel:'embed-v1',embeddingVersion:'asset-sha-1',scope:'project',projectId:project.id}));
  assert.equal(m.kind,'preference');
  assert.equal(m.extractionVersion,'prompt-sha-1');
  assert.equal(m.embeddingVersion,'asset-sha-1');
  assert.equal(s.listAllMemories().length,1);
  assert.equal(s.listCandidates().length,0);
  s.setEmbedding(m.id,[2,3],'embed-v2',{expectedVersion:1,embeddingVersion:'asset-sha-2'});
  const reopened=f.restart();
  assert.equal(reopened.getMemory(m.id).embeddingVersion,'asset-sha-2');
  assert.equal(reopened.getMemory(m.id).extractionModel,'extractor-v1');
  assert.equal(reopened.getProject(project.id).name,'After');
  assert.throws(()=>reopened.transaction(()=>{reopened.putMemory(fact('not committed'));return Promise.resolve();}),/synchronous/);
  assert.equal(reopened.listAllMemories().length,1);
});

test('fact replacements respect actual source time, same-session seq, and deletion barriers',t=>{
  const f=fixture(t),s=f.store;
  const at=(eventTime,eventSeq=42,sessionId='session-new')=>[{...source,eventTime,eventSeq,eventId:String(eventSeq),sessionId}];
  const latest=s.putMemory(fact('newest value',{factKey:'latest',sources:at('2026-10-24T02:00:00.000Z',100)}));
  const expectStale=fn=>assert.throws(fn,error=>error.code==='STALE_MEMORY_FACT');
  expectStale(()=>s.putMemory(fact('old value',{factKey:'latest',sources:at('2026-10-24T01:00:00.000Z',999)})));
  expectStale(()=>s.putMemory(fact('old seq value',{factKey:'latest',sources:at('2026-10-24T02:00:00.000Z',99)})));
  expectStale(()=>s.putMemory(fact('old explicit replacement',{sources:at('2026-10-24T01:00:00.000Z'),supersedes:latest.id})));
  expectStale(()=>s.replaceMemory(latest.id,fact('old correction',{sources:at('2026-10-24T01:00:00.000Z')}),{expectedVersion:1}));
  assert.equal(s.getMemory(latest.id).status,'active');
  const cross=s.putMemory(fact('other session same time',{factKey:'latest',sources:at('2026-10-24T02:00:00.000Z',1,'different-session')}));
  assert.equal(cross.status,'active');
  f.setTime('2026-10-24T03:00:00.000Z');
  s.deleteMemory(cross.id);
  expectStale(()=>s.putMemory(fact('old queued resurrection',{factKey:'latest',sources:at('2026-10-24T02:59:59.999Z')})));
  expectStale(()=>s.putMemory(fact('same-time resurrection',{factKey:'latest',sources:at('2026-10-24T03:00:00.000Z')})));
  assert.equal(s.listCandidates().length,0);
  const fresh=s.putMemory(fact('new explicit user statement after delete',{factKey:'latest',sources:at('2026-10-24T03:00:01.000Z')}));
  assert.equal(fresh.status,'active');
  assert.throws(()=>s.putMemory(fact('invalid source time',{sources:at('not-a-date')})),/eventTime/);
});

test('same-millisecond recovery enqueues retain durable insertion order across restart',t=>{
  const f=fixture(t);
  for (let seq=1;seq<=20;seq++) f.store.enqueueEvent({sessionId:'recover-order',eventSeq:seq,eventTime:source.eventTime});
  assert.deepEqual(f.restart().claimJobs({limit:20}).map(j=>j.eventSeq),Array.from({length:20},(_,i)=>i+1));
});

test('watch checkpoint, cursors and recall ledger persist accurate status/reference versions',t=>{
  const f=fixture(t),s=f.store;
  s.setMetadata('watchedSessions',{s:{after:42,enabledAt:source.eventTime}});
  s.setCursor('watch:s',42);
  const m=s.putMemory(fact('recall test'));
  const prepared=s.recordRecall({sessionId:'s',requestId:'request',status:'prepared',memories:[m],details:{mode:'semantic'}});
  assert.equal(prepared.status,'prepared');
  s.recordRecall({sessionId:'s',requestId:'request',status:'injected',memories:[m],details:{tokens:32}});
  const reopened=f.restart();
  assert.equal(reopened.getMetadata('watchedSessions').s.after,42);
  assert.equal(reopened.getCursor('watch:s'),42);
  assert.equal(reopened.getRecallStatus('s').status,'injected');
  assert.deepEqual(reopened.getRecallStatus('s').memoryRefs,[{id:m.id,version:1}]);
  assert.equal(reopened.listRecalls({sessionId:'s'})[0].status,'injected');
  assert.equal(reopened.listRecalls({sessionId:'unrelated'}).length,0);
  assert.equal(reopened.listRecalls().length,1);
  assert.throws(()=>reopened.recordRecall({sessionId:'s',requestId:'bad',status:'success'}),/Invalid recall status/);
});
