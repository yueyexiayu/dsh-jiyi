import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySourceBoundary } from '../lib/index.js';
import { randomUUID } from 'node:crypto';
const sdk=process.versions.electron?await import('file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'):null;
class Assembler {text='';push(c){if(c.type==='text-delta')this.text+=c.text;}blocks(){return [{type:'text',text:this.text}];}}
const helpers={createUserMessage:sdk?.createUserMessage??(x=>({...x,id:randomUUID(),role:'user'})),BlockAssembler:sdk?.BlockAssembler??Assembler};
const fact={id:'owned-fact',version:1,status:'active',scope:'project',projectId:'owned-project',content:'验收项目的日报采用PDF交付。',updatedAt:'2026-10-25T00:00:00Z',sources:[{sessionId:'owned-seed',eventSeq:8,eventTime:'2026-10-25T00:00:00Z'}]};
const projects=[{id:'owned-project',name:'独立验收项目'}];
const config={provider:'fixture-provider',model:'fixture-model'};
const options={query:'日报生成器是否支持后台定时？',hits:[fact],projects,config};

test('controlled replay sends actual user-role reference separately without gold or extra correction',async()=>{
  let calls=0;
  const ctx={llm:{prepareCall:async controls=>({config:controls,stream:async function*(request){
    calls++;assert.equal(request.messages.length,2);assert.equal(request.system,'你是对话助手。');assert.deepEqual(request.tools,[]);
    assert.equal(request.messages[0].role,'user');assert.equal(request.messages[0].source.kind,'user');assert.equal(request.messages[0].content[0].text,options.query);
    assert.equal(request.messages[1].role,'user');assert.equal(request.messages[1].source.kind,'plugin:jiyi');assert.deepEqual(request.messages[1].source.memoryRefs,[{id:fact.id,version:1}]);
    assert.match(request.messages[1].content[0].text,/验收项目的日报采用PDF交付/);assert.doesNotMatch(request.messages[1].content[0].text,/expectedIds|gold|正确答案/);
    yield {type:'text-delta',index:0,text:'未记载。'};yield {type:'finish',reason:{kind:'stop'}};
  }})}};
  const result=await replaySourceBoundary(ctx,helpers,options);
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.terminal,'stop');assert.equal(result.observedToolCalls,0);assert.equal(result.answer,'未记载。');
  assert.equal(result.mode,'controlled-source-boundary-replay-not-native');assert.match(result.referenceSha256,/^[a-f0-9]{64}$/);
});

test('controlled replay retains abnormal finish as failure with actual materials and diagnostics',async()=>{
  const ctx={llm:{prepareCall:async config=>({config,stream:async function*(){yield {type:'text-delta',index:0,text:'partial'};yield {type:'finish',reason:{kind:'max-tokens'}};}})}};
  const result=await replaySourceBoundary(ctx,helpers,options);
  assert.equal(result.ok,false);assert.equal(result.answer,null);assert.equal(result.terminal,'error');assert.equal(result.messages[1].source.kind,'plugin:jiyi');assert.match(result.errorCode,/BOUNDARY_FINISH/);assert.ok(result.diagnostics.events.some(e=>e.status==='error'));
});

test('controlled replay rejects attempted tools and does not claim a completed main-model branch',async()=>{
  const ctx={llm:{prepareCall:async config=>({config,stream:async function*(){yield {type:'tool-call-delta',index:0,text:'{}'};}})}};
  const result=await replaySourceBoundary(ctx,helpers,options);
  assert.equal(result.ok,false);assert.equal(result.answer,null);assert.equal(result.observedToolCalls,1);assert.match(result.errorCode,/TOOL_CALL/);
});

test('replay bounds reference before model invocation and no malformed user input becomes a call',async()=>{
  let calls=0;const ctx={llm:{prepareCall:()=>{calls++;throw new Error('must not call');}}};
  await assert.rejects(replaySourceBoundary(ctx,helpers,{...options,query:''}),/问题/);
  await assert.rejects(replaySourceBoundary(ctx,helpers,{...options,hits:[{...fact,content:'界'.repeat(2000)}]}),/4000/);
  assert.equal(calls,0);
});
