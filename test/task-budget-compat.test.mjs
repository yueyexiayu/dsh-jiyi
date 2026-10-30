import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callExtraction } from '../lib/extract.js';
import { createRelevanceJudge } from '../lib/relevance.js';
import { searchMemories } from '../lib/search.js';
import { EMBEDDING_MODEL, EMBEDDING_VERSION, EMBEDDING_DIMENSIONS } from '../lib/models.js';
import { openStore } from '../lib/store.js';

class Assembler {
  constructor(){this.text='';}
  push(chunk){if(chunk.type==='text-delta')this.text+=chunk.text;if(chunk.type==='finish')this.finish=chunk.reason;}
  blocks(){return [{type:'text',text:this.text}];}
}
function modelFixture(answer) {
  const attribution=new WeakMap(),requests=[];
  const helpers={BlockAssembler:Assembler,createUserMessage:value=>({...value,id:'isolated',role:'user'}),markTaskBudgetSession:(request,id)=>attribution.set(request,id)};
  const ctx={llm:{getTaskBudgetGuard:()=>({}),prepareCall:async(config,_signal,configure)=>({config:configure(config,{}),stream:request=>{
    requests.push({request,id:attribution.get(request)});
    return (async function*(){yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};})();
  }})}};
  return {helpers,ctx,requests};
}

test('background extraction uses an explicit local session identity and keeps SDK replay isolated',async()=>{
  const f=modelFixture('{"memories":[]}');
  await callExtraction(f.ctx,f.helpers,{extraction:{provider:'fixture',model:'model'}},{sessionId:'actual-session',sources:[{sessionId:'actual-session',eventSeq:1,quote:'test'}]},undefined,{budgetSessionId:'actual-session'});
  const {request,id}=f.requests[0];assert.equal(id,'actual-session');
  for(const key of ['sessionId','purpose','context','replayState'])assert.equal(Object.hasOwn(request,key),false);
  const input=JSON.parse(request.messages[0].content[0].text);assert.equal(Object.hasOwn(input,'sessionId'),false);assert.equal(Object.hasOwn(input.sources[0],'sessionId'),false);assert.equal(JSON.stringify(request).includes('actual-session'),false);
  assert.deepEqual(request.tools,[]);
  const noLocalMarker=modelFixture('{"memories":[]}');delete noLocalMarker.helpers.markTaskBudgetSession;
  await assert.rejects(callExtraction(noLocalMarker.ctx,noLocalMarker.helpers,{extraction:{provider:'fixture',model:'model'}},{sources:[]},undefined,{budgetSessionId:'actual-session'}),{code:'EXTRACTION_BUDGET_ATTRIBUTION_UNAVAILABLE'});
  assert.equal(noLocalMarker.requests.length,0);
  delete noLocalMarker.ctx.llm.getTaskBudgetGuard;
  assert.equal(await callExtraction(noLocalMarker.ctx,noLocalMarker.helpers,{extraction:{provider:'fixture',model:'model'}},{sources:[]},undefined,{budgetSessionId:'actual-session'}),'{"memories":[]}');
});

test('legacy extraction selects explicit unattributed background marker',async()=>{
  const f=modelFixture('{"memories":[]}');let marked=0;
  f.helpers.markTaskBudgetUnattributedBackground=(request,id)=>{marked++;assert.equal(id,'session');};
  f.helpers.markTaskBudgetSession=()=>{throw new Error('must not bind the current task');};
  await callExtraction(f.ctx,f.helpers,{extraction:{provider:'fixture',model:'model'}},{sources:[]},undefined,{budgetSessionId:'session'});
  assert.equal(marked,1);
});

test('background task and job identity stays local and is never sent in model input',async()=>{
  const f=modelFixture('{"memories":[]}');let received;
  f.helpers.markTaskBudgetBackground=(request,sessionId,taskId,jobId)=>{received={request,sessionId,taskId,jobId};};
  const job='12345678-1234-1234-1234-123456789abc';
  await callExtraction(f.ctx,f.helpers,{extraction:{provider:'fixture',model:'model'}},
    {sessionId:'session',budgetTaskId:'task',sources:[{sessionId:'session',eventSeq:1,quote:'test'}]},undefined,
    {budgetSessionId:'session',budgetTaskId:'task',budgetJobId:job});
  assert.equal(received.sessionId,'session');assert.equal(received.taskId,'task');assert.equal(received.jobId,job);
  const request=f.requests[0].request;
  assert.equal(JSON.stringify(request).includes(job),false);assert.equal(JSON.stringify(request).includes('budgetTaskId'),false);
  delete f.helpers.markTaskBudgetBackground;
  await assert.rejects(callExtraction(f.ctx,f.helpers,{extraction:{provider:'fixture',model:'model'}},{sources:[]},undefined,
    {budgetSessionId:'session',budgetTaskId:'task',budgetJobId:job}),{code:'EXTRACTION_BUDGET_ATTRIBUTION_UNAVAILABLE'});
});

test('native search carries identity only in local attribution through the relevance chain',async()=>{
  const f=modelFixture('{"ids":[{"id":"m1","version":1,"quote":"weather preference"}]}');
  const relevance=createRelevanceJudge({ctx:f.ctx,helpers:f.helpers,config:{provider:'fixture',model:'model'}});
  const vector=Array.from({length:EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0);
  const memory={id:'m1',version:1,status:'active',scope:'global',projectId:null,content:'weather preference',embedding:vector,embeddingModel:EMBEDDING_MODEL,embeddingVersion:EMBEDDING_VERSION};
  const models={getStatus:()=>({status:'ready'}),embed:async texts=>({vectors:texts.map(()=>vector),model:EMBEDDING_MODEL,version:EMBEDDING_VERSION})};
  const store={listProjects:()=>[],listCandidates:()=>[memory],searchText:()=>[],getMemory:()=>memory};
  const settings={enabled:true,retrieval:{maxMemories:6,maxCandidates:12,maxChars:4000,semanticThreshold:0.2,statusStaleHours:72,timeoutMs:10000}};
  const result=await searchMemories({query:'weather',store,settings,models,relevance,readOnly:true,budgetSessionId:'real-session'});
  assert.equal(result.status,'hit',JSON.stringify(result));assert.equal(f.requests[0].id,'real-session');
  const request=f.requests[0].request,payload=JSON.parse(request.messages[0].content[0].text);
  assert.equal(Object.hasOwn(request,'sessionId'),false);assert.equal(Object.hasOwn(payload,'sessionId'),false);assert.deepEqual(request.tools,[]);
  await relevance.dispose();
});

test('controlled deferral preserves attempts and payload, does not starve other jobs, and survives restart',t=>{
  const dir=mkdtempSync(join(tmpdir(),'jiyi-budget-test-')),path=join(dir,'memory.sqlite');
  let now='2026-10-29T00:00:00.000Z',store=openStore(path,{clock:()=>now});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const job=store.enqueueEvent({sessionId:'s1',eventId:'1',eventTime:now,payload:{evidence:'preserved'},maxAttempts:1});
  const other=store.enqueueEvent({sessionId:'s2',eventId:'2',eventTime:now,payload:{evidence:'other'},maxAttempts:1});
  const claimed=store.claimJobs()[0];assert.equal(claimed.id,job.id);assert.equal(claimed.attempts,1);
  const deferred=store.deferJob(job.id,claimed.token,{code:'TASK_TREE_PAUSED',message:'task paused'});
  assert.equal(deferred.state,'pending');assert.equal(deferred.attempts,0);assert.deepEqual(deferred.payload,{evidence:'preserved'});assert.match(deferred.lastError,/TASK_TREE_PAUSED/);
  assert.equal(store.claimJobs()[0].id,other.id);assert.equal(store.claimJobs().length,0);
  store.close();store=openStore(path,{clock:()=>now});assert.equal(store.getJob(job.id).attempts,0);
  now='2026-10-29T00:01:01.000Z';assert.equal(store.claimJobs()[0].id,job.id);
});
