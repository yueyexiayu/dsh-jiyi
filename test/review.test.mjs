import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, sanitizeReviewInput } from '../lib/review.js';

const source = {sessionId:'s',eventId:'2',eventSeq:2,eventTime:'2026-01-01T00:00:00Z',quote:'请记住我喜欢中文；以前的英文偏好已经不再适用。',evidence:'user-explicit'};
const payload = {projectId:'p',projectNames:['项目'],sources:[source],extractionModel:'test'};
const old = {id:'old',version:3,selectionRevision:2,status:'active',reviewState:'clear',scope:'global',projectId:null,factKey:'language',content:'喜欢英文',sources:[source]};
const op = {type:'update',memoryId:'old',kind:'preference',scope:'global',content:'喜欢中文',factKey:'language',sourceSeqs:[2],quotes:['我喜欢中文']};
const parse = (operations, existing=[old], conflictExisting=existing) => parseReview(JSON.stringify({operations}),payload,existing,conflictExisting);

test('review updates preserve identity, concurrency checks and local evidence',()=>{
  const result=parse([op]);
  assert.equal(result.memories[0].id,'old');assert.equal(result.memories[0].expectedVersion,3);assert.equal(result.memories[0].expectedSelectionRevision,2);assert.equal(result.memories[0].sources.at(-1).quote,'我喜欢中文');
  assert.deepEqual(result.candidates,[]);
});

test('an update without new time evidence preserves the target validity window',()=>{
  const timed={...old,validityKind:'interval',validFrom:'2026-01-01T00:00:00.000Z',validTo:'2026-02-01T00:00:00.000Z',validityPrecision:'day',timeZone:'Asia/Tokyo'};
  const updated=parse([op],[timed]).memories[0];
  assert.equal(updated.validityKind,'interval');assert.equal(updated.validFrom,timed.validFrom);assert.equal(updated.validTo,timed.validTo);assert.equal(updated.validityPrecision,'day');assert.equal(updated.timeZone,'Asia/Tokyo');
  assert.equal(parse([{...op,validity:{validityKind:'unknown'}}],[timed]).memories[0].validityKind,'unknown');
});

test('review input redacts credentials but preserves locators',()=>{
  const secretPayload={...payload,sources:[{...source,quote:'Authorization: Bearer syntheticToken12345; key：oc_sk_syntheticCredit1234567890; 请长期使用中文。'}]};
  const sanitized=sanitizeReviewInput({...secretPayload,existing:[{...old,content:'apiKey=syntheticSecret12345'}]});
  assert.equal(sanitized.sources[0].sessionId,'s');assert.equal(sanitized.sources[0].eventSeq,2);assert.doesNotMatch(sanitized.sources[0].quote,/syntheticToken12345|syntheticSecret12345|syntheticCredit1234567890/);assert.doesNotMatch(sanitized.existing[0].content,/syntheticSecret12345/);
});

test('manual and user-controlled memories cannot be changed or forgotten',()=>{
  for(const protectedOld of [{...old,userControlled:true},{...old,sources:[{origin:'manual'}]}]) {
    assert.deepEqual(parse([op],[protectedOld]),{memories:[],candidates:[],forget:[]});
    assert.deepEqual(parse([{type:'forget',memoryId:'old',sourceSeqs:[2],quotes:['英文偏好已经不再适用']}],[protectedOld]),{memories:[],candidates:[],forget:[]});
  }
});

test('forget requires exact user evidence and carries optimistic versions',()=>{
  assert.deepEqual(parse([{type:'forget',memoryId:'old',sourceSeqs:[2],quotes:['英文偏好已经不再适用']}]).forget,[{id:'old',expectedVersion:3,expectedSelectionRevision:2}]);
  assert.throws(()=>parse([{type:'forget',memoryId:'old',sourceSeqs:[2],quotes:['没有说过']}]),{code:'REVIEW_EVIDENCE'});
});

test('same fact key produces an isolated candidate without weakening the unique index',()=>{
  const add={...op,type:'add',inclusion:'essential'};
  const result=parse([add]);
  assert.equal(result.memories.length,0);assert.equal(result.candidates.length,1);assert.deepEqual(result.candidates[0].conflictMemoryIds,['old']);assert.equal(result.candidates[0].reasonCode,'fact_key_conflict');assert.equal(result.candidates[0].memory.inclusion,'essential');
});

test('same-key short content is detected before token heuristics',()=>{
  const existing={...old,kind:'status',factKey:'up',content:'好了'},quote='坏了';
  const request={type:'add',kind:'status',scope:'global',content:'坏了',factKey:'up',sourceSeqs:[2],quotes:[quote]};
  const result=parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[existing]);
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].reasonCode,'fact_key_conflict');
});

test('different semantic keys become pending review while clearly different subjects remain separate',()=>{
  const existing={...old,kind:'status',factKey:'page22-old',content:'第22页现场状态显示失败'},quote='第22页现场状态已经恢复通过';
  const request={type:'add',kind:'status',scope:'global',content:quote,factKey:'page22-current',sourceSeqs:[2],quotes:[quote]};
  assert.equal(parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[existing]).candidates.length,1);
  const other={...existing,factKey:'service-a',content:'服务 A 当前正常运行'};const otherQuote='服务 B 当前正常运行';
  const separate={type:'add',kind:'status',scope:'global',content:otherQuote,factKey:'service-b',sourceSeqs:[2],quotes:[otherQuote]};
  assert.equal(parseReview(JSON.stringify({operations:[separate]}),{...payload,sources:[{...source,quote:otherQuote}]},[other]).memories[0].factKey,'service-b');
});

test('conflicts outside the model context are still staged locally instead of retried by prose',()=>{
  const hidden={...old,id:'hidden',kind:'status',factKey:'shared',content:'旧的共享事实'};
  const request={type:'add',kind:'project_fact',scope:'global',content:'新的共享事实',factKey:'shared',sourceSeqs:[2],quotes:[source.quote]};
  const result=parseReview(JSON.stringify({operations:[request]}),payload,[],[hidden]);
  assert.equal(result.candidates.length,1);assert.deepEqual(result.candidates[0].expectedMemberVersions,{hidden:3});
});

test('deterministic correction requires locally marked user-correction evidence',()=>{
  const correctionPayload={...payload,sources:[{...source,evidence:'user-correction',quote:'不是英文，我喜欢中文。'}]};
  const add={type:'add',kind:'preference',scope:'global',content:'喜欢中文',factKey:'language',sourceSeqs:[2],quotes:['我喜欢中文'],relation:'corrects'};
  const result=parseReview(JSON.stringify({operations:[add]}),correctionPayload,[old]);
  assert.deepEqual(result.memories[0].supersedes,['old']);assert.equal(result.memories[0].relation,'corrects');
  const unsafe=parseReview(JSON.stringify({operations:[add]}),payload,[old]);
  assert.equal(unsafe.candidates.length,1);assert.equal(unsafe.memories.length,0);
});

test('validity fields are strict and unknown fields fail closed',()=>{
  const withValidity={...op,type:'add',memoryId:undefined,validity:{validityKind:'interval',validFrom:'2026-01-01T00:00:00Z',validTo:'2026-02-01T00:00:00Z',validityPrecision:'day',timeZone:'Asia/Tokyo'}};
  const result=parse([withValidity],[]);assert.equal(result.memories[0].validityKind,'interval');assert.equal(result.memories[0].timeZone,'Asia/Tokyo');
  assert.throws(()=>parse([{...withValidity,validity:{...withValidity.validity,guess:true}}],[]),{code:'EXTRACTION_SCHEMA'});
  assert.throws(()=>parse([{...withValidity,statusConflicts:[]}],[]),{code:'REVIEW_SCHEMA'});
});
