import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, sanitizeReviewInput } from '../lib/review.js';

const source = {sessionId:'s',eventId:'2',eventSeq:2,eventTime:'2026-01-01T00:00:00Z',quote:'请记住我喜欢中文；以前的英文偏好已经不再适用。'};
const payload = {projectId:'p',projectNames:['项目'],sources:[source],extractionModel:'test'};
const old = {id:'old',version:3,selectionRevision:2,scope:'global',projectId:null,factKey:'language',content:'喜欢英文',sources:[{origin:'automatic'}]};
const op = {type:'update',memoryId:'old',kind:'preference',scope:'global',content:'喜欢中文',factKey:'language',sourceSeqs:[2],quotes:['我喜欢中文']};
const parse = (operations, existing=[old]) => parseReview(JSON.stringify({operations}),payload,existing);

test('review updates preserve identity and concurrency checks with original evidence',()=>{
  const result=parse([op]);
  assert.equal(result.memories[0].id,'old');
  assert.equal(result.memories[0].expectedVersion,3);
  assert.equal(result.memories[0].expectedSelectionRevision,2);
  assert.equal(result.memories[0].sources.at(-1).quote,'我喜欢中文');
});
test('review model input redacts credentials while preserving evidence identities',()=>{
  const secretPayload={...payload,sources:[{...source,quote:'Authorization: Bearer syntheticToken12345; key：oc_sk_syntheticCredit1234567890; 请长期使用中文。'}]};
  const secretExisting={...old,content:'apiKey=syntheticSecret12345',sources:[{origin:'automatic'}]};
  const sanitized=sanitizeReviewInput({...secretPayload,existing:[secretExisting]});
  assert.equal(sanitized.sources[0].sessionId,'s');
  assert.equal(sanitized.sources[0].eventSeq,2);
  assert.doesNotMatch(sanitized.sources[0].quote,/syntheticToken12345|syntheticSecret12345|syntheticCredit1234567890/);
  assert.doesNotMatch(sanitized.existing[0].content,/syntheticSecret12345/);
  assert.match(sanitized.sources[0].quote,/请长期使用中文/);
});
test('manual and user-controlled memories cannot be changed or forgotten',()=>{
  for (const protectedOld of [{...old,userControlled:true},{...old,sources:[{origin:'manual'}]}]) {
    assert.deepEqual(parse([op], [protectedOld]),{memories:[],forget:[]});
    assert.deepEqual(parse([{type:'forget',memoryId:'old',sourceSeqs:[2],quotes:['英文偏好已经不再适用']}],[protectedOld]),{memories:[],forget:[]});
  }
});
test('forget requires original user evidence and carries both revisions',()=>{
  assert.deepEqual(parse([{type:'forget',memoryId:'old',sourceSeqs:[2],quotes:['英文偏好已经不再适用']}]).forget,[{id:'old',expectedVersion:3,expectedSelectionRevision:2}]);
  assert.throws(()=>parse([{type:'forget',memoryId:'old',sourceSeqs:[2],quotes:['没有说过']}]),{code:'REVIEW_EVIDENCE'});
});
test('new essential memory cannot collide with an existing fact key',()=>{
  const add={...op,type:'add',inclusion:'essential'};
  assert.throws(()=>parse([add]),{code:'REVIEW_CONFLICT'});
  assert.equal(parse([{...add,factKey:'other'}]).memories[0].inclusion,'essential');
});
test('similar statuses under a changed fact key require updating the existing topic',()=>{
  const existing={...old,kind:'status',factKey:'page22-status',content:'第22页现场状态显示失败'}, quote='第22页现场状态已经恢复通过';
  const request={type:'add',kind:'status',scope:'global',content:'第22页现场状态已经恢复通过',factKey:'page22-current',sourceSeqs:[2],quotes:[quote]};
  assert.throws(()=>parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[existing]),{code:'REVIEW_CONFLICT'});
  const update={...request,type:'update',memoryId:existing.id};
  assert.equal(parseReview(JSON.stringify({operations:[update]}),{...payload,sources:[{...source,quote}]},[existing]).memories[0].id,existing.id);
});
test('different named subjects with identical generic status wording do not conflict',()=>{
  const existing={...old,kind:'status',factKey:'service-a-status',content:'服务 A 当前正常运行'}, quote='服务 B 当前正常运行';
  const request={type:'add',kind:'status',scope:'global',content:quote,factKey:'service-b-status',sourceSeqs:[2],quotes:[quote]};
  const result=parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[existing]);
  assert.equal(result.memories[0].factKey,'service-b-status');
});
test('different Chinese named subjects require an explicit distinct-subject decision instead of being force-merged',()=>{
  const existing={...old,kind:'status',factKey:'beijing-stock',content:'北京仓库存充足'},quote='上海仓库存也充足';
  const request={type:'add',kind:'status',scope:'global',content:quote,factKey:'shanghai-stock',sourceSeqs:[2],quotes:[quote]};
  assert.throws(()=>parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[existing]),{code:'REVIEW_CONFLICT'});
  const result=parseReview(JSON.stringify({operations:[{...request,statusConflicts:[{memoryId:existing.id,decision:'distinct-subject'}]}]}),{...payload,sources:[{...source,quote}]},[existing]);
  assert.equal(result.memories[0].id,undefined);assert.equal(result.memories[0].factKey,'shanghai-stock');
});
test('same Chinese subject remains a hidden conflict when no structural anchor is available',()=>{
  const target={...old,id:'beijing-hidden',kind:'status',factKey:'beijing-old',content:'北京仓库存充足'},quote='北京仓库存不足';
  const request={type:'add',kind:'status',scope:'global',content:quote,factKey:'beijing-current',sourceSeqs:[2],quotes:[quote]};
  assert.throws(()=>parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[],[target]),error=>error.code==='REVIEW_CONFLICT'&&error.conflictMemoryIds.join()==='beijing-hidden');
});
test('a shared environment does not prove that different interfaces are the same subject',()=>{
  const existing={...old,kind:'status',factKey:'production-payment',content:'生产环境支付接口正常'},quote='生产环境登录接口正常';
  const request={type:'add',kind:'status',scope:'global',content:quote,factKey:'production-login',sourceSeqs:[2],quotes:[quote]};
  assert.throws(()=>parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[existing]),{code:'REVIEW_CONFLICT'});
  assert.equal(parseReview(JSON.stringify({operations:[{...request,statusConflicts:[{memoryId:existing.id,decision:'distinct-subject'}]}]}),{...payload,sources:[{...source,quote}]},[existing]).memories[0].factKey,'production-login');
});
test('different pages and environments remain separate statuses',()=>{
  const cases=[['第1页导出失败','第2页导出成功'],['测试环境已恢复','生产环境已恢复']];
  for(const [left,right] of cases) {
    const existing={...old,kind:'status',factKey:`left-${left}`,content:left}, quote=right;
    const request={type:'add',kind:'status',scope:'global',content:right,factKey:`right-${right}`,sourceSeqs:[2],quotes:[quote]};
    assert.equal(parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[existing]).memories.length,1,left);
  }
});
test('conflict detection uses the full status set and exposes the hidden target for a model retry',()=>{
  const target={...old,id:'older-status',kind:'status',factKey:'page22-old',content:'第22页现场状态显示失败'};
  const fillers=Array.from({length:100},(_,i)=>({...old,id:`filler-${i}`,kind:'status',factKey:`other-${i}`,content:`第${i+30}页其他状态`}));
  const quote='第22页现场状态已经恢复通过';
  const request={type:'add',kind:'status',scope:'global',content:quote,factKey:'page22-current',sourceSeqs:[2],quotes:[quote]};
  assert.throws(()=>parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},fillers,[...fillers,target]),error=>error.code==='REVIEW_CONFLICT'&&error.conflictMemoryIds.join()==='older-status');
});
test('every hidden status conflict must be supplied before any similar new status can be accepted',()=>{
  const payment={...old,id:'production-payment',kind:'status',factKey:'payment',content:'生产环境支付接口正常'};
  const login={...old,id:'production-login',kind:'status',factKey:'login',content:'生产环境登录接口正常'};
  const quote='生产环境监控接口正常';
  const request={type:'add',kind:'status',scope:'global',content:quote,factKey:'monitoring',sourceSeqs:[2],quotes:[quote]};
  assert.throws(()=>parseReview(JSON.stringify({operations:[request]}),{...payload,sources:[{...source,quote}]},[],[payment,login]),error=>error.code==='REVIEW_CONFLICT'&&error.conflictMemoryIds.length===2&&error.conflictMemoryIds.includes(payment.id)&&error.conflictMemoryIds.includes(login.id));
  const decisions=[payment,login].map(memory=>({memoryId:memory.id,decision:'distinct-subject'}));
  assert.equal(parseReview(JSON.stringify({operations:[{...request,statusConflicts:decisions}]}),{...payload,sources:[{...source,quote}]},[payment,login]).memories.length,1);
});
test('hidden fact-key and duplicate conflicts also expose every target instead of failing blind',()=>{
  const hiddenKey={...old,id:'hidden-key',factKey:'shared',content:'旧的共享事实'};
  const hiddenDuplicate={...old,id:'hidden-duplicate',factKey:'duplicate-copy',content:'完全相同的状态'};
  const keyOp={type:'add',kind:'project_fact',scope:'global',content:'新的共享事实',factKey:'shared',sourceSeqs:[2],quotes:['请记住我喜欢中文；以前的英文偏好已经不再适用。']};
  const duplicateOp={type:'add',kind:'project_fact',scope:'global',content:'完全相同的状态',factKey:'new-copy',sourceSeqs:[2],quotes:['请记住我喜欢中文；以前的英文偏好已经不再适用。']};
  assert.throws(()=>parseReview(JSON.stringify({operations:[keyOp,duplicateOp]}),payload,[],[hiddenKey,hiddenDuplicate]),error=>error.code==='REVIEW_CONFLICT'&&error.conflictMemoryIds.includes('hidden-key')&&error.conflictMemoryIds.includes('hidden-duplicate'));
});
test('status TTL is validated and carried through extraction parsing',()=>{
  const status={...op,type:'add',kind:'status',content:'临时维护窗口开放',factKey:'maintenance-window',statusTtlHours:24,quotes:['请记住我喜欢中文；以前的英文偏好已经不再适用。']};
  assert.equal(parseReview(JSON.stringify({operations:[status]}),payload,[]).memories[0].statusTtlHours,24);
  assert.throws(()=>parseReview(JSON.stringify({operations:[{...status,statusTtlHours:0}]}),payload,[]),{code:'EXTRACTION_SCHEMA'});
});
test('status update keeps its identity without superseding itself',()=>{
  const status={...old,kind:'status'};
  const result=parse([{...op,kind:'status'}],[status]);
  assert.equal(result.memories[0].id,'old');
  assert.deepEqual(result.memories[0].supersedes,[]);
});
