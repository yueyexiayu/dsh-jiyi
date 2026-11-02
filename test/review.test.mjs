import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview } from '../lib/review.js';

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
test('status update keeps its identity without superseding itself',()=>{
  const status={...old,kind:'status'};
  const result=parse([{...op,kind:'status'}],[status]);
  assert.equal(result.memories[0].id,'old');
  assert.deepEqual(result.memories[0].supersedes,[]);
});
