import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { recallMessage, validateSettings } from '../lib/index.js';
import { retrieve, memoryTiming, renderMemoryContext } from '../lib/retrieve.js';
import { parseExtraction, userSource } from '../lib/extract.js';
import { REVIEW_SYSTEM } from '../lib/review.js';
import { MemoryStore } from '../lib/store.js';
import { packRecall } from '../lib/search.js';
import { EMBEDDING_MODEL, EMBEDDING_VERSION, EMBEDDING_DIMENSIONS } from '../lib/models.js';

const source=(eventTime,quote,eventSeq=1)=>({sessionId:'real-user',eventId:String(eventSeq),eventSeq,eventTime,quote,evidence:'user-explicit'});
const vector=Array.from({length:EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0);
const adapter={embed:async texts=>({vectors:texts.map(()=>vector),model:EMBEDDING_MODEL,version:EMBEDDING_VERSION})};
const make=(id,kind,age,extra={})=>({id,version:1,status:'active',reviewState:'clear',scope:'global',kind,content:`${id} 第22页现场状态待核实`,createdAt:new Date(Date.now()-age*3600000).toISOString(),sources:[source(new Date(Date.now()-age*3600000).toISOString(),'用户原文')],updatedAt:new Date().toISOString(),validityKind:'unknown',validityPrecision:'unknown',lastConfirmedAt:new Date(Date.now()-age*3600000).toISOString(),embedding:vector,embeddingModel:EMBEDDING_MODEL,embeddingVersion:EMBEDDING_VERSION,...extra});

test('time semantics use explicit confirmation and validTo endpoints, never updatedAt fallback',()=>{
  const now=Date.parse('2026-10-25T00:00:00Z');
  const memory={...make('status','status',48),createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',lastConfirmedAt:'2026-10-23T00:00:00.000Z',validityKind:'interval',validityPrecision:'day',validFrom:'2026-10-23T00:00:00.000Z',validTo:'2026-10-25T00:00:00.000Z'};
  const timing=memoryTiming(memory,now);
  assert.equal(timing.recordedAt,'2026-10-23T00:00:00.000Z');assert.equal(timing.validityExpired,true);assert.match(timing.validityNotice,/有效期已结束/);
  const unknown={...memory,lastConfirmedAt:null,validFrom:null,validTo:null,validityKind:'unknown'};
  assert.equal(memoryTiming(unknown,now).recordedAt,null);assert.equal(memoryTiming(unknown,now).confirmedAgeHours,null);assert.equal(memoryTiming(unknown,now).validityExpired,false);
  assert.equal(memoryTiming({...unknown,kind:'project_fact'},now).validityExpired,false);
  assert.match(recallMessage([memory],'request',x=>x,[]).content[0].text,/"validTo":"2026-10-25T00:00:00.000Z"/);
  assert.match(renderMemoryContext([memory]),/有效期已结束/);
});

test('timestamped reference returns the same snapshot that passed its complete byte budget',()=>{
  const m=make('status','status',48);let calls=0;
  const result=packRecall({memories:[m],store:{getMemory:()=>m},seen:{},projects:[],requestId:'r',helper:x=>x,maxChars:10,recallMessage:()=>({content:[{type:'text',text:++calls===1?'short':'x'.repeat(20)}]})});
  assert.equal(calls,1);assert.equal(result.reference.content[0].text,'short');assert.deepEqual(result.hits,[m]);
});

test('known expired validity is excluded while unknown validity remains eligible and feedback only nudges rank',async()=>{
  const expired=make('a-expired','project_fact',1,{validityKind:'interval',validFrom:'2026-01-01T00:00:00Z',validTo:'2026-02-01T00:00:00Z'});
  const useful=make('b-useful','project_fact',100,{feedbackWeight:3});
  const current=make('c-current','project_fact',5,{feedbackWeight:0});
  let proposed=[];
  const judge={judge:async({candidates})=>{proposed=candidates;return {ids:candidates.map(({id,version})=>({id,version}))};}};
  const result=await retrieve({query:'现场状态',records:[expired,useful,current],maxCandidates:4,budgetTokens:10000,maxChars:10000},adapter,judge);
  assert.deepEqual(proposed.map(item=>item.id).sort(),['b-useful','c-current']);
  assert.ok(result.hits[0].id==='b-useful'||result.hits[0].id==='c-current');
});

test('explicit user correction deterministically supersedes the same stable key and writes evidence, relations and decisions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jiyi-status-')),store=new MemoryStore(join(dir,'memory.sqlite'));
  try {
    const project=store.resolveProject({cwd:join(dir,'project')});
    const oldSource=source('2026-10-20T00:00:00Z','第22页失败，现场状态待核实',1);
    const old=store.putMemory({id:'old-state',kind:'status',scope:'project',projectId:project.id,factKey:'page22-status',content:'第22页失败，现场状态待核实',sources:[oldSource],embedding:vector,embeddingModel:EMBEDDING_MODEL});
    const quote='第22页的问题已经解决，我刚才重新验证通过了。';
    const payload={projectId:project.id,sources:[{...source('2026-10-25T00:00:00Z',quote,2),evidence:'user-correction'}]};
    const response={memories:[{content:'第22页问题已解决，用户重新验证通过',type:'status',scope:'project',factKey:'page22-status',sourceSeqs:[2],quotes:[quote],relation:'corrects',supersedes:[]}]};
    const parsed=parseExtraction(JSON.stringify(response),payload,[old])[0];
    assert.equal(parsed.relation,'corrects');
    const next=store.putMemory(parsed);
    assert.equal(store.getMemory(old.id).status,'superseded');assert.equal(store.getMemory(old.id).supersededBy,next.id);
    assert.equal(store.getMemory(old.id).validTo,next.validFrom);
    assert.ok(store.getMemoryDetail(old.id).relations.some(item=>item.relation==='supports'));
    assert.ok(store.getMemoryDetail(next.id).relations.some(item=>item.relation==='corrects'));
    assert.ok(store.getMemoryDetail(next.id).decisions.some(item=>item.reasonCode==='added'));
    assert.equal(store.db.prepare('SELECT count(*) n FROM memory_fts WHERE memory_id=?').get(old.id).n,0);
    assert.deepEqual(store.listCandidates({projectId:project.id}).map(m=>m.id),[next.id]);
    assert.throws(()=>store.putMemory({...parsed,supersedes:[],content:'旧消息重放',sources:[oldSource]}),{code:'STALE_MEMORY_FACT'});
    response.memories[0].quotes=['助手猜测已经解决'];
    assert.throws(()=>parseExtraction(JSON.stringify(response),payload,[next]),{code:'EXTRACTION_EVIDENCE'});
    assert.equal(userSource({type:'assistant/message',data:{source:{kind:'assistant'},content:[{type:'text',text:quote}]}},'assistant'),null);
    assert.match(REVIEW_SYSTEM,/relation/);assert.match(REVIEW_SYSTEM,/validTo 为不含端点/);
  } finally {store.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true});}
});

test('legacy status-only TTL setting is accepted and removed while v4 settings gain adjudication and disabled consolidation defaults',()=>{
  const settings=validateSettings({retrieval:{statusStaleHours:96}});
  assert.equal(Object.hasOwn(settings.retrieval,'statusStaleHours'),false);
  assert.equal(settings.adjudication.modelPolicy,'fixed');
  assert.equal(settings.consolidation.enabled,false);
  assert.equal(settings.consolidation.minMemories,50);
  assert.equal(settings.feedback.modelSamplingRate,0);
});
