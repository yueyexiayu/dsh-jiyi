import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { recallMessage, validateSettings } from '../lib/index.js';
import { retrieve, statusTiming, renderMemoryContext } from '../lib/retrieve.js';
import { parseExtraction, userSource, EXTRACTION_SYSTEM } from '../lib/extract.js';
import { MemoryStore } from '../lib/store.js';
import { packRecall } from '../lib/search.js';
import { EMBEDDING_MODEL, EMBEDDING_VERSION, EMBEDDING_DIMENSIONS } from '../lib/models.js';

const source=(eventTime,quote,eventSeq=1)=>({sessionId:'real-user',eventSeq,eventTime,quote});
const vector=Array.from({length:EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0);
const adapter={embed:async texts=>({vectors:texts.map(()=>vector),model:EMBEDDING_MODEL,version:EMBEDDING_VERSION})};
const make=(id,kind,age)=>({id,version:1,status:'active',scope:'global',kind,content:'第22页现场状态待核实',createdAt:new Date(Date.now()-age*3600000).toISOString(),sources:[source(new Date(Date.now()-age*3600000).toISOString(),'用户原文')],updatedAt:new Date().toISOString(),embedding:vector,embeddingModel:EMBEDDING_MODEL,embeddingVersion:EMBEDDING_VERSION});

test('status time falls back createdAt -> updatedAt -> latest valid source, then explicit unknown',()=>{
  const createdAt='2026-10-20T00:00:00.000Z',updatedAt='2026-10-21T00:00:00.000Z';
  const m={...make('status','status',48.1),createdAt,updatedAt,sources:[source('invalid','原文'),source('2026-10-22T00:00:00Z','原文'),source('2026-10-23T00:00:00Z','原文')]};
  const now=Date.parse('2026-10-25T00:00:00Z');
  assert.equal(statusTiming(m,now).recordedAt,createdAt);
  assert.equal(statusTiming({...m,createdAt:'invalid'},now).recordedAt,updatedAt);
  assert.equal(statusTiming({...m,createdAt:null,updatedAt:''},now).recordedAt,'2026-10-23T00:00:00.000Z');
  const unknown={...m,createdAt:undefined,updatedAt:'invalid',sources:[source('invalid','原文')]};
  assert.equal(statusTiming(unknown,now).recordedAt,null);
  assert.equal(statusTiming(unknown,now).statusAgeHours,null);
  assert.match(statusTiming(unknown,now).statusNotice,/记录时间未知，请核实/);
  assert.match(recallMessage([unknown],'request',x=>x,[]).content[0].text,/记录时间未知，请核实/);
  assert.match(renderMemoryContext([unknown]),/记录时间未知，请核实/);
  assert.deepEqual(statusTiming({...unknown,kind:'project_fact'}),{});
  const aged={...m,createdAt:'2026-10-23T00:00:00Z'};
  assert.match(statusTiming(aged,now).statusNotice,/记录于 2 天前，可能已过时，请核实/);
});

test('timestamped reference returns the same snapshot that passed its complete byte budget',()=>{
  const m=make('status','status',48);let calls=0;
  const result=packRecall({memories:[m],store:{getMemory:()=>m},seen:{},projects:[],requestId:'r',helper:x=>x,maxChars:10,recallMessage:()=>({content:[{type:'text',text:++calls===1?'short':'x'.repeat(20)}]})});
  assert.equal(calls,1);assert.equal(result.reference.content[0].text,'short');assert.deepEqual(result.hits,[m]);
});

test('stale status is demoted before the candidate cap but retained when capacity allows; non-status is unchanged',async()=>{
  const old=make('a-old','status',80),fresh=make('b-fresh','status',1),fact=make('c-fact','project_fact',1000);
  let proposed;
  const judge={judge:async({candidates})=>{proposed=candidates;return {ids:candidates.map(({id,version})=>({id,version}))};}};
  const options={query:'现场状态',records:[old,fresh,fact],statusStaleHours:72,maxCandidates:2,budgetTokens:10000,maxChars:10000};
  const first=await retrieve(options,adapter,judge);
  assert.deepEqual(proposed.map(c=>c.id),['b-fresh','c-fact']);
  assert.deepEqual(first.hits.map(h=>h.id),['b-fresh','c-fact']);
  const all=await retrieve({...options,maxCandidates:3},adapter,judge);
  assert.deepEqual(all.hits.map(h=>h.id),['b-fresh','c-fact','a-old']);
  assert.equal(all.hits.at(-1).statusStale,true);
  const relaxed=await retrieve({...options,statusStaleHours:100},adapter,judge);
  assert.equal(relaxed.hits[0].id,'a-old','changing the setting reaches the actual ranking');
  assert.equal(validateSettings({}).retrieval.statusStaleHours,72);
  for(const value of [0,-1,1.5,'72',87601]) assert.throws(()=>validateSettings({retrieval:{statusStaleHours:value}}),/statusStaleHours/);
});

test('unknown-time status ranks exactly as stale, never refreshes or changes non-status eligibility',async()=>{
  const unknown={...make('a-unknown','status',1),createdAt:null,updatedAt:'invalid',sources:[]};
  const stale=make('b-stale','status',1000),fresh=make('c-fresh','status',1);
  const fact={...make('d-fact','project_fact',1),createdAt:null,updatedAt:null,sources:[]};
  const judge={judge:async({candidates})=>({ids:candidates.map(({id,version})=>({id,version}))})};
  const options={query:'现场状态',records:[unknown,stale,fresh,fact],statusStaleHours:72,maxCandidates:4,budgetTokens:10000,maxChars:10000};
  const result=await retrieve(options,adapter,judge);
  assert.deepEqual(result.hits.map(m=>m.id),['c-fresh','d-fact','a-unknown','b-stale']);
  const byId=Object.fromEntries(result.hits.map(m=>[m.id,m]));
  assert.equal(byId['a-unknown'].score,byId['b-stale'].score);
  assert.equal(byId['a-unknown'].score,byId['c-fresh'].score*.5);
  assert.equal(byId['a-unknown'].statusStale,true);assert.equal(byId['d-fact'].statusStale,false);
  const capped=await retrieve({...options,maxCandidates:2},adapter,judge);
  assert.deepEqual(capped.hits.map(m=>m.id),['c-fresh','d-fact']);
});

test('explicit new user status replaces the same stable key through existing versions, FTS and vector invalidation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jiyi-status-')),store=new MemoryStore(join(dir,'memory.sqlite'));
  try {
    const project=store.resolveProject({cwd:join(dir,'project')});
    const old=store.putMemory({id:'old-state',kind:'status',scope:'project',projectId:project.id,factKey:'page22-status',content:'第22页失败，现场状态待核实',sources:[source('2026-10-20T00:00:00Z','第22页失败，现场状态待核实')],embedding:vector,embeddingModel:EMBEDDING_MODEL});
    const quote='第22页的问题已经解决，我刚才重新验证通过了。';
    const payload={projectId:project.id,sources:[source('2026-10-25T00:00:00Z',quote,2)]};
    const response={memories:[{content:'第22页问题已解决，用户重新验证通过',type:'status',scope:'project',factKey:'ＰＡＧＥ２２-STATUS',sourceSeqs:[2],quotes:[quote],supersedes:[]}]};
    const parsed=parseExtraction(JSON.stringify(response),payload,[old])[0];
    assert.equal(parsed.factKey,'page22-status');assert.deepEqual(parsed.supersedes,['old-state']);
    const next=store.putMemory(parsed);
    assert.equal(store.getMemory(old.id).status,'superseded');assert.equal(store.getMemory(old.id).supersededBy,next.id);
    assert.equal(store.getMemory(old.id).version,2);assert.deepEqual(store.getVersions(old.id).map(v=>v.status),['active','superseded']);
    assert.equal(store.getMemory(old.id).embedding,null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_fts WHERE memory_id=?').get(old.id).n,0);
    assert.deepEqual(store.listCandidates({projectId:project.id}).map(m=>m.id),[next.id]);
    assert.throws(()=>store.putMemory({...parsed,supersedes:[],content:'旧消息重放',sources:old.sources}),{code:'STALE_MEMORY_FACT'});
    response.memories[0].quotes=['助手猜测已经解决'];
    assert.throws(()=>parseExtraction(JSON.stringify(response),payload,[next]),{code:'EXTRACTION_EVIDENCE'});
    assert.equal(userSource({type:'assistant/message',data:{source:{kind:'assistant'},content:[{type:'text',text:quote}]}},'assistant'),null);
    assert.match(EXTRACTION_SYSTEM,/用户自己明确给出的新状态/);
    assert.match(EXTRACTION_SYSTEM,/同一 topic/);
  } finally {store.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true});}
});
