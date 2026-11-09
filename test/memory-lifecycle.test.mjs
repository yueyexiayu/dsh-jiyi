import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdjudication, parseConsolidation, callAdjudication, strictlyNewerMemory } from '../lib/memory-lifecycle.js';

class Assembler{text='';push(chunk){if(chunk.type==='text-delta')this.text+=chunk.text;}blocks(){return [{type:'text',text:this.text}];}}
const helpers={BlockAssembler:Assembler,createUserMessage:x=>x};
const source=(id)=>({sessionId:id,eventSeq:1,eventTime:'2026-10-24T01:00:00Z',quote:'明确用户证据',evidence:'user-correction'});
const group={id:'g',scope:'global',projectId:null,factKey:'key',reasonCode:'fact_key_conflict',members:[
  {kind:'memory',id:'old',version:1,memory:{id:'old',version:1,scope:'global',projectId:null,content:'旧事实',reviewState:'pending',sources:[source('private-session-a')],validityKind:'as_of',validFrom:'2026-10-20T00:00:00Z'}},
  {kind:'candidate',id:'candidate',version:null,candidate:{id:'candidate',state:'pending',conflictMemoryIds:['old'],memory:{scope:'global',projectId:null,content:'新事实',reviewState:'pending',sources:[source('private-session-b')],validityKind:'as_of',validFrom:'2026-10-24T00:00:00Z'}}},
]};
const valid={decision:'same_claim_newer',confidence:.9,references:[{kind:'memory',id:'old',version:1},{kind:'candidate',id:'candidate',version:null}],reasonCode:'newer_user_evidence'};

test('adjudication parser rejects unknown fields, fabricated and duplicate references, malformed confidence and decisions',()=>{
  assert.deepEqual(parseAdjudication(JSON.stringify(valid),group),valid);
  assert.throws(()=>parseAdjudication(JSON.stringify({...valid,extra:true}),group),/严格匹配/);
  assert.throws(()=>parseAdjudication(JSON.stringify({...valid,references:[{kind:'memory',id:'other',version:1}]}),group),{code:'LIFECYCLE_REFERENCE'});
  assert.throws(()=>parseAdjudication(JSON.stringify({...valid,references:[valid.references[0],valid.references[0]]}),group),/重复/);
  assert.throws(()=>parseAdjudication(JSON.stringify({...valid,confidence:2}),group),/confidence/);
  assert.throws(()=>parseAdjudication(JSON.stringify({...valid,decision:'merge'}),group),/decision/);
  assert.throws(()=>parseAdjudication(JSON.stringify({...valid,reasonCode:'Not a safe code'}),group),/reasonCode/);
  assert.deepEqual(parseAdjudication(JSON.stringify({...valid,reasonCode:'model_selected_newer_claim'}),group).reasonCode,'model_selected_newer_claim');
  assert.throws(()=>parseAdjudication('```json\n{broken\n```',group),{code:'LIFECYCLE_JSON'});
});

test('adjudication model input is bounded data-only and never carries source session identifiers',async()=>{
  let request,config;
  const ctx={llm:{prepareCall:async(c,_signal,configure)=>({config:configure(c,{reasoning:{efforts:[{id:'low'},{id:'high'}]}}),stream:async function*(value){request=value;config=c;yield {type:'text-delta',index:0,text:JSON.stringify(valid)};yield {type:'finish',reason:{kind:'stop'}};}})}};
  const parsed=await callAdjudication(ctx,helpers,{provider:'p',model:'m',timeoutMs:1000,reasoningEffort:'high'},group,new AbortController().signal);
  assert.equal(parsed.decision,'same_claim_newer');assert.equal(request.sessionId,undefined);assert.deepEqual(request.tools,[]);assert.equal(config.maxTokens,900);
  const input=request.messages[0].content[0].text;assert.doesNotMatch(input,/private-session-a|private-session-b/);assert.match(input,/新事实/);
});

test('consolidation parser accepts only the conservative vocabulary and complete input references',()=>{
  const members=[{kind:'memory',id:'a',version:1},{kind:'memory',id:'b',version:2}];
  const result={decision:'keep_separate',confidence:.8,references:members.map(({kind,id,version})=>({kind,id,version})),reasonCode:'different_claims'};
  assert.deepEqual(parseConsolidation(JSON.stringify(result),members),result);
  assert.throws(()=>parseConsolidation(JSON.stringify({...result,decision:'delete_one'}),members),/decision/);
  assert.throws(()=>parseConsolidation(JSON.stringify({...result,references:[{kind:'memory',id:'a',version:2}]}),members),{code:'LIFECYCLE_REFERENCE'});
});

test('consolidation requires an unambiguous strict confirmation order',()=>{
  const earlier={id:'earlier',lastConfirmedAt:'2026-01-01T00:00:00.000Z'},later={id:'later',lastConfirmedAt:'2026-01-02T00:00:00.000Z'};
  assert.equal(strictlyNewerMemory(earlier,later),later);assert.equal(strictlyNewerMemory(later,earlier),later);
  assert.equal(strictlyNewerMemory(earlier,{...earlier,id:'equal'}),null);
  assert.equal(strictlyNewerMemory(earlier,{id:'missing',lastConfirmedAt:null}),null);
  assert.equal(strictlyNewerMemory(earlier,{id:'invalid',lastConfirmedAt:'not-a-date'}),null);
});
