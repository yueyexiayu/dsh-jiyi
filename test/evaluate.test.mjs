import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { MemoryStore } from '../lib/store.js';
import { validateSettings, recallMessage, VERSION } from '../lib/index.js';
import { createRelevanceJudge } from '../lib/relevance.js';
import { EMBEDDING_MODEL, EMBEDDING_VERSION, EMBEDDING_DIMENSIONS } from '../lib/models.js';
import { latencyStats, summarize, loadEvaluationPlan, runIsolatedEvaluation } from '../lib/evaluate.js';
import { databaseSnapshot, sameDatabase, auditEvaluationReturn } from '../lib/eval-integrity.js';
import { createEvaluationIpc } from '../lib/eval-ipc.js';

class Assembler {
  text='';
  push(chunk) {if(chunk.type==='text-delta')this.text+=chunk.text;}
  blocks() {return [{type:'text',text:this.text}];}
}
const helpers={createUserMessage:x=>({...x,role:'user'}),BlockAssembler:Assembler};
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'ji-eval-'));
  mkdirSync(join(dir,'evidence'));mkdirSync(join(dir,'A'));mkdirSync(join(dir,'B'));
  const source=join(dir,'source.sqlite'),store=new MemoryStore(source);
  const a=store.resolveProject({cwd:join(dir,'A')}),b=store.resolveProject({cwd:join(dir,'B')});
  const sources=[{sessionId:'source-session',eventSeq:1,eventTime:'2026-10-24T01:00:00Z',quote:'持久事实'}];
  store.putMemory({id:'a',content:'甲项目发票金额使用整数分，禁止浮点元。',scope:'project',projectId:a.id,sources});
  store.putMemory({id:'b',content:'乙项目发票金额使用两位小数字符串，禁止整数分。',scope:'project',projectId:b.id,sources});
  store.enqueueEvent({sessionId:'copied-old-job',eventId:'old',eventSeq:1,eventTime:'2026-10-24T01:00:00Z',projectId:a.id,payload:{sources:[]}});
  const settings=validateSettings({relevance:{provider:'deepseek-account',model:'deepseek-flash'}});
  const settingsPath=join(dir,'settings.json');writeFileSync(settingsPath,JSON.stringify(settings));
  const cases=[
    {n:1,id:'R:1',split:'R',project:'A',folder:join(dir,'A'),query:'甲项目发票金额使用整数分吗？',expected:'inject',expectedMemoryIds:['a']},
    {n:2,id:'R:2',split:'R',project:'A',folder:join(dir,'A'),query:'甲项目发票金额使用整数分吗？',expected:'inject',expectedMemoryIds:['a']},
    {n:3,id:'oldU:3',split:'oldU',project:'B',folder:join(dir,'B'),query:'乙项目发票金额使用两位小数字符串吗？',expected:'inject',expectedMemoryIds:['b']},
    {n:4,id:'V:4',split:'V',project:'B',folder:join(dir,'B'),query:'无关：猫砂盆如何清理？',expected:'no-hit/reject',expectedMemoryIds:[]},
  ];
  const inputPath=join(dir,'evidence','cases.json');
  const save=items=>writeFileSync(inputPath,JSON.stringify({relevance:settings.relevance,cases:items}));save(cases);
  const inputs=[];let active=0,maxActive=0,embeddingCalls=0,judgeOverride;
  const ctx={llm:{prepareCall:async(config,signal,configure)=>{
    const controls=configure(config,{reasoning:{efforts:[]}});
    return {config:controls,stream:async function*(request){
      assert.equal(config.provider,'deepseek-account');assert.equal(config.model,'deepseek-flash');
      assert.deepEqual(request.tools,[]);assert.equal(request.sessionId,undefined);assert.equal(request.purpose,undefined);
      const payload=JSON.parse(request.messages[0].content[0].text);inputs.push(payload);active++;maxActive=Math.max(active,maxActive);
      try {
        await new Promise(resolve=>setImmediate(resolve));
        signal.throwIfAborted();if(judgeOverride)await judgeOverride(payload,signal);
        const ids=payload.query.includes('无关')?[]:payload.candidates.map(c=>({id:c.id,version:c.version,quote:c.content}));
        yield {type:'text-delta',index:0,text:JSON.stringify({ids})};yield {type:'finish',reason:{kind:'stop'}};
      } finally {active--;}
    }};
  }}};
  const models={getStatus:()=>({status:'ready'}),embed:async texts=>{
    embeddingCalls++;return {vectors:texts.map(()=>Array.from({length:EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0)),model:EMBEDDING_MODEL,version:EMBEDDING_VERSION};
  }};
  const run=async(options={})=>{
    const relevance=createRelevanceJudge({ctx,helpers,config:{...settings.relevance,...options.request?.timeoutMs?{timeoutMs:options.request.timeoutMs}:{}}});
    try {return await runIsolatedEvaluation({pluginDir:dir,sourceDatabase:source,settingsPath,settings,models,relevance,helpers,recallMessage,runtime:{pid:process.pid},version:VERSION,...options,request:{inputPath,...options.request}});}
    finally {await relevance.dispose();}
  };
  return {dir,source,store,settings,settingsPath,cases,inputPath,save,inputs,run,embeddingCalls:()=>embeddingCalls,maxActive:()=>maxActive,setJudge:fn=>{judgeOverride=fn;},cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('isolated evaluation writes vectors, recall ledger and seen state ONLY to SQLite snapshot; source SHA/WAL/all row counts unchanged',async()=>{
  const f=fixture();
  try {
    const before=databaseSnapshot(f.source),settings=readFileSync(f.settingsPath);
    const run=await f.run();assert.equal(run.ok,true);assert.equal(run.qualityPassed,true);assert.equal(run.integrity.unchanged,true);
    assert.equal(typeof run.integrity.snapshotMs.before,'number');assert.ok(run.integrity.snapshotMs.before>=0);
    assert.equal(typeof run.integrity.snapshotMs.after,'number');assert.ok(run.integrity.snapshotMs.after>=0);
    assert.equal(run.integrity.audit.timing.count,0);
    assert.equal(run.integrity.audit.timing.elapsedMs.samples,0);
    assert.equal(run.integrity.before.elapsedMs,undefined,'snapshot duration must not live on the compared database fingerprint');
    assert.deepEqual(databaseSnapshot(f.source),before);assert.deepEqual(readFileSync(f.settingsPath),settings);
    assert.equal(f.store.getStatus().vectors,0);assert.equal(f.store.listRecalls().length,0);assert.equal(f.store.listJobs()[0].state,'pending');
    const result=JSON.parse(readFileSync(run.resultPath,'utf8'));
    assert.equal(result.cases.length,4);assert.equal(new Set(result.cases.map(c=>c.sessionId)).size,4);
    assert.deepEqual(result.cases.map(c=>c.actualInjectedMemoryIds),[['a'],['a'],['b'],[]]);
    assert.ok(result.cases.every(c=>c.passed&&c.recallMs>=0&&c.relevanceMs>=0));
    assert.equal(result.cases[0].diagnostics.relevance.model,'deepseek-flash');assert.equal(f.embeddingCalls(),3);
    assert.equal(result.cases[1].queryEmbedding.status,'skipped','retain original singleton optimization, do not force a different retrieval path');
    const copy=new MemoryStore(result.database);
    try {
      assert.equal(copy.getStatus().vectors,2);assert.equal(copy.listRecalls().length,4);
      assert.deepEqual(copy.listRecalls().map(c=>c.status).sort(),['empty','injected','injected','injected']);
      assert.equal(copy.listJobs()[0].state,'pending','copied old extraction queue must never run');
      assert.equal(copy.listJobs()[0].attempts,0);
      for(const c of result.cases)assert.deepEqual(copy.getMetadata(`injected:${c.sessionId}`),Object.fromEntries(c.actualInjectedMemoryIds.map(id=>[id,1])));
    } finally {copy.close();}
    assert.equal(statSync(run.resultPath).mode&0o777,0o600);
    assert.match(readFileSync(run.summaryPath,'utf8'),/无。/);
    for(const p of f.inputs) {
      assert.deepEqual(Object.keys(p).sort(),['candidates','projectId','query']);
      assert.equal(p.expectedMemoryIds,undefined);assert.equal(p.sessionId,undefined);
      assert.ok(p.candidates.every(c=>c.projectId===p.projectId),'project hard filter must precede judge');
    }
  } finally {f.cleanup();}
});

test('per-case evaluation evidence persists full scope/scores/request/raw response at 0600, without contaminating ledgers or concurrent cases',async()=>{
  const f=fixture();
  try {
    const run=await f.run({request:{concurrency:2}}),result=JSON.parse(readFileSync(run.resultPath,'utf8'));
    assert.equal(run.ok,true);assert.equal(run.qualityPassed,true);assert.equal(run.integrity.unchanged,true);
    assert.equal(run.integrity.passed,true);assert.deepEqual(run.integrity.evaluationSessionLeaks,[]);
    const copy=new MemoryStore(result.database);
    try {
      for(const row of result.cases) {
        const events=row.evaluationDiagnostics;
        assert.deepEqual(events.map(e=>e.stage),['search-scope','scope','candidates','model-request','model-response']);
        const [search,scope,candidates,request,response]=events;
        assert.equal(search.requestedScope,row.projectId);assert.equal(search.currentProject.id,row.projectId);
        assert.equal(scope.query,row.query);assert.equal(scope.scopedRecords.length,1);
        assert.ok(scope.scopedRecords.every(m=>m.projectId===row.projectId));
        assert.equal(candidates.scores.length,1);assert.deepEqual(candidates.proposed.map(m=>m.id),scope.scopedRecords.map(m=>m.id));
        const payload=JSON.parse(request.messages[0].content[0].text);
        assert.equal(payload.query,row.query);assert.equal(payload.projectId,row.projectId);
        assert.deepEqual(payload.candidates.map(m=>m.id),candidates.proposed.map(m=>m.id));
        assert.deepEqual(payload,f.inputs.find(p=>p.query===row.query));
        const expectedIds=row.expected==='inject'?[{id:payload.candidates[0].id,version:1,quote:payload.candidates[0].content}]:[];
        assert.equal(response.rawText,JSON.stringify({ids:expectedIds}));assert.equal(response.complete,true);
        assert.equal(request.controls.values.provider,'deepseek-account');assert.equal(request.controls.values.model,'deepseek-flash');
        assert.ok(request.system.includes('历史记忆支持度判别器'));
        assert.equal(JSON.stringify(row.diagnostics).includes('rawText'),false);
      }
      for(const ledger of copy.listRecalls()) {
        assert.equal(JSON.stringify(ledger).includes('rawText'),false);
        assert.equal(JSON.stringify(ledger).includes('model-request'),false);
      }
    } finally {copy.close();}
    assert.equal(statSync(run.resultPath).mode&0o777,0o600);
    assert.equal(f.store.listRecalls().length,0);assert.equal(f.store.getStatus().vectors,0);
  } finally {f.cleanup();}
});

test('reject gold never turns service failure/timeout into a passed empty recall',async()=>{
  const f=fixture();
  try {
    f.setJudge(()=>{throw Object.assign(new Error('provider unavailable'),{code:'RELEVANCE_TIMEOUT'});});
    const run=await f.run({request:{caseIds:[4]}});const result=JSON.parse(readFileSync(run.resultPath,'utf8'));
    assert.equal(run.integrity.unchanged,true);assert.equal(run.qualityPassed,false);
    assert.equal(result.cases[0].passed,false);assert.equal(result.cases[0].status,'timeout');
    assert.ok(result.cases[0].relevanceMs>=0);assert.match(result.cases[0].error.code,/TIMEOUT/);
    assert.deepEqual(result.cases[0].actualInjectedMemoryIds,[]);
    assert.match(readFileSync(run.summaryPath,'utf8'),/V:4/);
  } finally {f.cleanup();}
});

test('authentication failure halts once and preserves explicitly unattempted suffix, without implicit retry',async()=>{
  const f=fixture();
  try {
    f.setJudge(()=>{throw Object.assign(new Error('authentication required'),{code:'AUTH_REQUIRED'});});
    const run=await f.run();const result=JSON.parse(readFileSync(run.resultPath,'utf8'));
    assert.equal(run.ok,false);assert.equal(run.status,'stopped');assert.equal(f.inputs.length,1);
    assert.equal(result.cases.filter(c=>c.attempted).length,1);assert.equal(result.cases.filter(c=>c.status==='not-attempted').length,3);
    assert.equal(result.statistics.overall.passed,0);assert.equal(run.integrity.unchanged,true);
  } finally {f.cleanup();}
});

test('cancellation preserves first-attempt prefix, clears copy injection state and leaves source unchanged',async()=>{
  const f=fixture(),controller=new AbortController();let started;
  const entered=new Promise(resolve=>{started=resolve;});
  try {
    f.setJudge((_payload,signal)=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'ABORTED'})),{once:true});}));
    const pending=f.run({signal:controller.signal});await entered;controller.abort();
    const run=await pending,result=JSON.parse(readFileSync(run.resultPath,'utf8'));
    assert.equal(run.ok,false);assert.equal(run.status,'stopped');assert.equal(run.integrity.unchanged,true);
    assert.equal(result.cases.filter(c=>c.attempted).length,1);assert.equal(result.cases[0].passed,false);
    assert.deepEqual(result.cases[0].actualInjectedMemoryIds,[]);
    const copy=new MemoryStore(result.database);
    try {assert.equal(copy.listRecalls()[0].status,'error');assert.deepEqual(copy.getMetadata(`injected:${result.cases[0].sessionId}`),{});}finally{copy.close();}
  } finally {f.cleanup();}
});

test('late synchronous packaging cannot persist a successful injection or pass a reject by deadline',async()=>{
  const f=fixture();let blocked=false;
  try {
    const customHelpers={...helpers,createUserMessage:input=>{
      if(input.source?.kind==='plugin:jiyi'&&!blocked){blocked=true;const end=performance.now()+1010;while(performance.now()<end){}}
      return helpers.createUserMessage(input);
    }};
    const run=await f.run({helpers:customHelpers,request:{caseIds:[1],timeoutMs:1000}});
    const result=JSON.parse(readFileSync(run.resultPath,'utf8')),row=result.cases[0];
    assert.equal(blocked,true);assert.equal(run.qualityPassed,false);assert.equal(run.integrity.unchanged,true);
    assert.equal(row.status,'timeout');assert.deepEqual(row.actualInjectedMemoryIds,[]);assert.equal(row.passed,false);
    const copy=new MemoryStore(result.database);
    try {assert.equal(copy.listRecalls()[0].status,'error');assert.deepEqual(copy.getMetadata(`injected:${row.sessionId}`),{});}finally{copy.close();}
  } finally {f.cleanup();}
});

test('seed and subset are deterministic; optional concurrency is bounded and never shares injected state',async()=>{
  const f=fixture();
  try {
    const request={inputPath:f.inputPath,caseIds:[1,2,3],seed:17,concurrency:2,timeoutMs:5000};
    const a=loadEvaluationPlan(f.dir,request),b=loadEvaluationPlan(f.dir,request);
    assert.deepEqual(a.cases.map(c=>c.id),b.cases.map(c=>c.id));assert.equal(a.cases.length,3);
    const run=await f.run({request});const result=JSON.parse(readFileSync(run.resultPath,'utf8'));
    assert.equal(run.qualityPassed,true);assert.deepEqual(result.cases.map(c=>c.id),a.cases.map(c=>c.id));
    assert.ok(f.maxActive()>1&&f.maxActive()<=2);assert.equal(result.settings.retrieval.timeoutMs,5000);
    assert.equal(result.settings.relevance.timeoutMs,5000);assert.equal(f.settings.retrieval.timeoutMs,10000);
  } finally {f.cleanup();}
});

test('invalid gold, unknown subsets, unsafe paths and unsupported knobs fail before any model invocation',async()=>{
  const f=fixture();
  try {
    for(const options of [{caseIds:['missing']},{caseIds:[]},{caseIds:[1,1]},{concurrency:3},{seed:-1},{timeoutMs:0},{unexpected:true}]) assert.throws(()=>loadEvaluationPlan(f.dir,{inputPath:f.inputPath,...options}));
    assert.throws(()=>loadEvaluationPlan(f.dir,{inputPath:f.settingsPath}),/evidence/);
    const symlink=join(f.dir,'evidence','outside.json');symlinkSync(f.settingsPath,symlink);
    assert.throws(()=>loadEvaluationPlan(f.dir,{inputPath:symlink}),/evidence/);
    f.save([{...f.cases[0],expectedMemoryIds:[]}]);assert.throws(()=>loadEvaluationPlan(f.dir,{inputPath:f.inputPath}),/标准答案/);
    assert.equal(f.inputs.length,0);
  } finally {f.cleanup();}
});

test('source drift is visible even when main-file SHA and all table row counts are unchanged (WAL update)',()=>{
  const f=fixture();
  try {
    f.store.setMetadata('same-row','before');const before=databaseSnapshot(f.source);
    f.store.setMetadata('same-row','after');const after=databaseSnapshot(f.source);
    assert.deepEqual(before.tables,after.tables);assert.equal(before.sha256,after.sha256);
    assert.notEqual(before.walSha256,after.walSha256);assert.equal(sameDatabase(before,after),false);
  } finally {f.cleanup();}
});

test('external source write during evaluation invalidates integrity, never restores or hides changed production data',async()=>{
  const f=fixture();
  try {
    let changed=false;f.setJudge(()=>{if(!changed){changed=true;f.store.setMetadata('external-change',true);}});
    const run=await f.run();assert.equal(run.ok,false);assert.equal(run.status,'integrity-failed');
    assert.equal(run.integrity.unchanged,false);assert.equal(f.store.getMetadata('external-change'),true);
    assert.equal(JSON.parse(readFileSync(run.resultPath,'utf8')).error.code,'EVAL_SOURCE_CHANGED');
  } finally {f.cleanup();}
});

test('audited production writes and rollback reversals are not evaluation contamination',async()=>{
  const f=fixture();let changed=false;
  try {
    f.store.beginWriteAudit();
    f.setJudge(()=>{if(!changed){changed=true;f.store.withWriteSource({kind:'session-event',sessionId:'real-user'},()=>{
      f.store.setMetadata('real-user-write',{completed:true});
      assert.throws(()=>f.store.transaction(()=>{f.store.setMetadata('rolled-back',true);throw new Error('rollback');}),/rollback/);
    });}});
    const run=await f.run({finishWriteAudit:()=>({writes:f.store.endWriteAudit(),settingsWrites:[]})});
    assert.equal(run.ok,true,JSON.stringify(run.error));assert.equal(run.integrity.unchanged,false);
    assert.equal(run.integrity.passed,true);assert.equal(run.integrity.audit.passed,true);
    assert.ok(run.integrity.productionWrites.every(w=>w.source.connection==='production-host'));
    assert.ok(run.integrity.productionWrites.some(w=>w.source.sessionId==='real-user'));
    assert.ok(run.integrity.productionWrites.every(w=>Number.isFinite(w.elapsedMs)&&w.elapsedMs>=0&&Array.isArray(w.tables)&&w.tables.length>0));
    assert.ok(run.integrity.productionWrites.some(w=>w.tables.includes('metadata')&&w.source.kind==='session-event'));
    assert.equal(run.integrity.audit.timing.count,run.integrity.productionWrites.length);
    assert.equal(run.integrity.audit.timing.elapsedMs.samples,run.integrity.productionWrites.length);
    assert.ok(run.integrity.audit.timing.elapsedMs.max>=run.integrity.audit.timing.elapsedMs.p50);
    assert.match(readFileSync(run.summaryPath,'utf8'),/审计耗时 p50 \/ p95 \/ 最大：/);
    assert.match(readFileSync(run.summaryPath,'utf8'),/全库快照开始 \/ 结束：/);
    assert.deepEqual(run.integrity.evaluationSessionLeaks,[]);
    assert.equal(f.store.getMetadata('rolled-back'),null);
    assert.equal(auditEvaluationReturn({sourceDatabase:f.source,settingsPath:f.settingsPath,expected:run.integrity}).passed,true);
  } finally {if(f.store.writeAudit)f.store.endWriteAudit();f.cleanup();}
});

test('an unaudited connection remains a visible integrity failure even alongside legitimate writes',async()=>{
  const f=fixture();let changed=false;
  try {
    f.store.beginWriteAudit();
    f.setJudge(()=>{if(!changed){changed=true;
      const other=new MemoryStore(f.source);try {other.setMetadata('external-connection',true);}finally{other.close();}
      f.store.setMetadata('legitimate-write',true);
    }});
    const run=await f.run({finishWriteAudit:()=>({writes:f.store.endWriteAudit(),settingsWrites:[]})});
    assert.equal(run.ok,false);assert.equal(run.integrity.passed,false);
    assert.match(run.integrity.audit.errors.join(' '),/not fully explained/);
  } finally {if(f.store.writeAudit)f.store.endWriteAudit();f.cleanup();}
});

test('nearest-rank statistics exclude unmeasured relevance, group and expectation denominators remain explicit',()=>{
  assert.deepEqual(latencyStats([1,2,3,4,null]),{samples:4,p50:2,p95:4,max:4});
  assert.deepEqual(latencyStats([null]),{samples:0,p50:null,p95:null,max:null});
  const s=summarize([{split:'R',expected:'inject',attempted:true,passed:true,relevanceMs:5,recallMs:9},{split:'R',expected:'no-hit/reject',attempted:false,passed:false,relevanceMs:null,recallMs:null}]);
  assert.equal(s.byGroup.R.passRate,.5);assert.equal(s.byExpectation.inject.passRate,1);assert.equal(s.byExpectation.reject.attempted,0);
});

async function exchange(path,request) {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(path);let text='';socket.setEncoding('utf8');
    socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));socket.on('data',c=>{text+=c;});socket.on('error',reject);
    socket.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });
}
test('private host IPC is inert by default, mode0600, explicit version-gated and cleans up owned endpoint',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ji-ipc-'));let calls=0,release;
  try {
    release=await createEvaluationIpc({dataDir:dir,version:VERSION,runtime:{loadedAt:'test'},run:async options=>{calls++;return {ok:true,inputPath:options.inputPath};}});
    const endpoint=JSON.parse(readFileSync(join(dir,'eval-endpoint.json'),'utf8'));
    assert.equal(statSync(endpoint.socketPath).mode&0o777,0o600);assert.equal(calls,0);
    const status=await exchange(endpoint.socketPath,{op:'status'});assert.equal(status.version,VERSION);assert.equal(calls,0);
    assert.equal((await exchange(endpoint.socketPath,{op:'run',version:'0.1.8'})).ok,false);assert.equal(calls,0);
    assert.equal((await exchange(endpoint.socketPath,{op:'run',version:VERSION,inputPath:'evidence/x.json'})).ok,true);assert.equal(calls,1);
    await release();release=null;assert.equal(existsSync(endpoint.socketPath),false);assert.equal(existsSync(join(dir,'eval-endpoint.json')),false);
  } finally {if(release)await release();rmSync(dir,{recursive:true,force:true});}
});

test('final integrity includes cleanup writes, never certifies a pre-cleanup snapshot as final',async()=>{
  const f=fixture();let cleanupCalls=0;
  try {
    const run=await f.run({request:{caseIds:[1]},cleanup:async()=>{
      cleanupCalls++;f.store.setMetadata('skipped:orchestrator',{status:'skipped',reason:{kind:'error'}});
      return {modelsDisposed:true,guardRestored:true,replayedEvents:1};
    }});
    assert.equal(cleanupCalls,1);
    assert.equal(run.ok,false);assert.equal(run.status,'integrity-failed');assert.equal(run.integrity.unchanged,false);
    assert.equal(run.integrity.after.tables.metadata,run.integrity.before.tables.metadata+1);
    const artifact=JSON.parse(readFileSync(run.resultPath,'utf8'));
    assert.equal(artifact.cleanup.modelsDisposed,true);assert.equal(artifact.cleanup.replayedEvents,1);
    assert.equal(artifact.error.code,'EVAL_SOURCE_CHANGED');
    assert.match(readFileSync(run.summaryPath,'utf8'),/一致：false/);
  } finally {f.cleanup();}
});

test('cleanup failures fail the run even if source bytes and row counts remain unchanged',async()=>{
  const f=fixture();let cleanupCalls=0;
  try {
    const run=await f.run({request:{caseIds:[1]},cleanup:async()=>{cleanupCalls++;throw Object.assign(new Error('disposal failed'),{code:'EVAL_CLEANUP'});}});
    assert.equal(cleanupCalls,1);assert.equal(run.ok,false);assert.equal(run.qualityPassed,false);
    assert.equal(run.status,'cleanup-failed');assert.equal(run.integrity.unchanged,true);assert.equal(run.error.code,'EVAL_CLEANUP');
  } finally {f.cleanup();}
});

test('post-return audit detects writes after a true Host proof without touching the source itself',async()=>{
  const f=fixture();
  try {
    const run=await f.run({request:{caseIds:[1]}});assert.equal(run.ok,true);
    assert.equal(auditEvaluationReturn({sourceDatabase:f.source,settingsPath:f.settingsPath,expected:run.integrity}).unchanged,true);
    assert.deepEqual(databaseSnapshot(f.source),run.integrity.after,'audit must remain read-only');
    f.store.setMetadata('after-host-proof',{written:true});
    const audit=auditEvaluationReturn({sourceDatabase:f.source,settingsPath:f.settingsPath,expected:run.integrity});
    assert.equal(audit.unchanged,false);assert.equal(audit.after.tables.metadata,audit.before.tables.metadata+1);
    assert.notEqual(audit.after.walSha256,audit.hostAfter.walSha256);
  } finally {f.cleanup();}
});

test('post-return read-only proof tolerates a genuinely concurrent production writer, not just an earlier write',async()=>{
  const f=fixture();let worker,exited,stop;
  try {
    f.store.setMetadata('concurrent-counter',0);
    const run=await f.run({request:{caseIds:[1]}});assert.equal(run.ok,true);
    stop=new Int32Array(new SharedArrayBuffer(4));
    worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const stop=new Int32Array(workerData.stop);const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000');const update=db.prepare('UPDATE metadata SET value=? WHERE key=?');parentPort.postMessage('ready');let n=0;while(!Atomics.load(stop,0))update.run(JSON.stringify(++n),'concurrent-counter');db.close();parentPort.postMessage(n);`,{eval:true,workerData:{path:f.source,stop:stop.buffer}});
    exited=once(worker,'exit');await once(worker,'message');
    const audit=auditEvaluationReturn({sourceDatabase:f.source,settingsPath:f.settingsPath,expected:run.integrity});
    assert.equal(audit.passed,true);assert.equal(audit.unchanged,false);assert.deepEqual(audit.evaluationSessionLeaks,[]);
  } finally {if(stop)Atomics.store(stop,0,1);if(exited)await exited;f.cleanup();}
});

test('missing mandatory settings fails before sampling rather than treating two missing hashes as unchanged',async()=>{
  const f=fixture();
  try {
    assert.equal(f.settingsPath,join(f.dir,'settings.json'));rmSync(f.settingsPath);
    const run=await f.run({request:{caseIds:[1]}});
    assert.equal(run.ok,false);assert.equal(run.error.code,'ENOENT');assert.equal(f.inputs.length,0);
    assert.equal(run.statistics.overall.attempted,0);
  } finally {f.cleanup();}
});

test('post-return audit also rejects settings-only drift',async()=>{
  const f=fixture();
  try {
    const run=await f.run({request:{caseIds:[1]}});
    writeFileSync(f.settingsPath,JSON.stringify({...f.settings,enabled:false}));
    const audit=auditEvaluationReturn({sourceDatabase:f.source,settingsPath:f.settingsPath,expected:run.integrity});
    assert.equal(audit.unchanged,false);assert.deepEqual(audit.before,audit.after);assert.notEqual(audit.settingsBefore,audit.settingsAfter);
  } finally {f.cleanup();}
});
