import test from 'node:test';
import assert from 'node:assert/strict';
import { correctionEvidence, failureEvidence, failureSignature, lessonToolCall, redactLessonText, reviewChangesEvidence } from '../lib/lessons.js';
import { parseLessonReview, LESSON_SYSTEM } from '../lib/review.js';

const event=(seq,type,data)=>({seq,type,data,time:Date.parse('2026-11-08T00:00:00Z')+seq});

test('lesson triggers ignore ordinary errors and accept explicit user corrections',()=>{
  const ordinary=event(1,'user/message',{source:{kind:'user'},content:[{type:'text',text:'请修复测试。'}]});
  const correction=event(2,'user/message',{source:{kind:'user'},content:[{type:'text',text:'不对，你改错了，我说的是保留接口。'}]});
  assert.equal(correctionEvidence(ordinary,'s'),null);
  assert.equal(correctionEvidence(correction,'s').evidence,'user-correction');
});

test('tool evidence is bounded, redacted and repeated by a stable normalized signature',()=>{
  const raw='TEST_FAILED: api_key=sk-abcdefghijklmnop at /Users/ning/project/a.test.ts line 42';
  assert.doesNotMatch(redactLessonText(raw,400),/sk-abcdefghijklmnop/);
  const call=lessonToolCall(event(1,'tool/call',{callId:'c',name:'bash',arguments:JSON.stringify({command:'npm test'})}));
  assert.equal(call.highSignal,true);
  const result=event(2,'tool/result',{message:{toolCallId:'c',isError:true,content:[{type:'text',text:raw}]},error:{name:'Error',code:'TEST_FAILED'}});
  const failure=failureEvidence(result,call,'s',400);
  assert.equal(failure.highSignal,true);
  assert.doesNotMatch(failure.source.quote,/sk-abcdefghijklmnop/);
  assert.equal(failure.signature,failureSignature('bash',{code:'TEST_FAILED'},failure.source.quote));
  const readCall=lessonToolCall(event(3,'tool/call',{callId:'r',name:'read',arguments:JSON.stringify({path:'/tmp/tests/failure.test.ts'})}));
  assert.equal(readCall.highSignal,false);
  const nonCheckBash=lessonToolCall(event(4,'tool/call',{callId:'b',name:'bash',arguments:JSON.stringify({command:'cat tests/failure.test.ts'})}));
  assert.equal(nonCheckBash.highSignal,false);
});

test('review CHANGES is lesson evidence while file-not-found is not high signal',()=>{
  const reviewCall={name:'subagent_review',highSignal:true};
  const review=reviewChangesEvidence(event(3,'tool/result',{message:{toolCallId:'r',isError:false,content:[{type:'text',text:'{"verdict":"CHANGES","findings":["missing test"]}'}]}}),reviewCall,'s');
  assert.equal(review.highSignal,true);
  const readCall={name:'read',highSignal:false};
  const missing=failureEvidence(event(4,'tool/result',{message:{toolCallId:'x',isError:true,content:[{type:'text',text:'ENOENT'}]},error:{name:'Error',code:'ENOENT'}}),readCall,'s');
  assert.equal(missing.highSignal,false);
});

test('lesson parser accepts only exact source quotes and produces a lesson memory',()=>{
  const source={sessionId:'s',eventId:'2',eventSeq:2,eventTime:'2026-11-08T00:00:00.000Z',quote:'TEST_FAILED: expected OK',evidence:'tool-error:bash'};
  const payload={projectId:'p',projectNames:['P'],sources:[source],extractionModel:'m'};
  const lesson={content:'先核对共同失败假设，再用真实测试证明修复。',scope:'project',factKey:'lesson:repeated-failure',confidence:0.9,sourceSeqs:[2],quotes:['TEST_FAILED: expected OK']};
  const parsed=parseLessonReview(JSON.stringify({lessons:[lesson]}),payload,[]);
  assert.equal(parsed[0].type,'lesson');
  assert.equal(parsed[0].sources[0].evidence,'tool-error:bash');
  assert.throws(()=>parseLessonReview(JSON.stringify({lessons:[{...lesson,quotes:['fabricated']} ]}),payload,[]),/原文/);
  assert.match(LESSON_SYSTEM,/不得要求自动修改代码/);
});

test('lesson parser maps memoryId to the existing lesson and preserves optimistic-update identity',()=>{
  const source={sessionId:'s',eventId:'2',eventSeq:2,eventTime:'2026-11-08T00:00:00.000Z',quote:'TEST_FAILED: expected OK',evidence:'tool-error:bash'};
  const payload={projectId:'p',projectNames:['P'],sources:[source],extractionModel:'m'};
  const existing={id:'lesson-1',version:2,scope:'project',projectId:'p',factKey:'lesson:checks',kind:'lesson',selectionRevision:4,sources:[source],content:'旧做法'};
  const lesson={memoryId:'lesson-1',content:'更新后的做法',scope:'project',factKey:'lesson:changed',confidence:0.9,sourceSeqs:[2],quotes:['TEST_FAILED: expected OK']};
  const [updated]=parseLessonReview(JSON.stringify({lessons:[lesson]}),payload,[existing]);
  assert.equal(updated.id,'lesson-1');
  assert.equal(updated.expectedVersion,2);
  assert.equal(updated.expectedSelectionRevision,4);
  assert.equal(updated.factKey,'lesson:checks');
  assert.equal(updated.sources.length,2);
  assert.throws(()=>parseLessonReview(JSON.stringify({lessons:[{...lesson,memoryId:'missing'}]}),payload,[existing]),/不存在/);
});
