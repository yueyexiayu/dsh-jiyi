import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {installExpression} from './fixtures/native-driver.mjs';
// Synthetic protocol fixture; no private project, session or evaluation record.
const plan={projects:{N:{cwd:'/tmp/jiyi-synthetic-project'}},cases:[{id:'N01-seed',project:'N',inputs:['Synthetic project: reports use plain text.']}]};
const expectedHash='a'.repeat(64);
function fixture(version='0.1.6'){
  const calls=[],events=[];
  const session={openState:'cold',running:false,openError:null,eventSource:{getSnapshot:()=>({hasMore:false,entries:events})},async open(){this.openState='open';},async dispose(){calls.push({method:'dispose'});}};
  const method=name=>async request=>{calls.push({method:name,request});return{ok:true,value:name==='create'?{sessionId:request.sessionId}:{accepted:true}};};
  const remote={session:Object.fromEntries(['create','selectModel','prompt','cancel'].map(name=>[name,method(name)]))};
  const window={__jiyiLeadRemote:remote,__jiyiLeadUi:{sessions:{manager:{get:()=>session}}}};
  const context=vm.createContext({window,crypto:{randomUUID},Intl,fetch:async()=>({ok:true,json:async()=>({version,runtime:{sourceFilesAtStartup:{'lib/index.js':expectedHash}},settings:{relevance:{provider:'openai-codex',model:'gpt-6.1-sol',timeoutMs:10000},retrieval:{timeoutMs:10000}},models:{embedding:{activeRequests:0},relevance:{activeRequests:0}}})})});
  const expression=installExpression(plan,expectedHash);const installed=vm.runInContext(expression,context);
  return {window,session,calls,installed,expression};
}

test('Native driver preparation uses official SDK only, preserves exact frozen input and rejects duplicates',async()=>{
  const f=fixture();assert.equal(f.installed.performedNetworkOrModelCalls,false);assert.equal(f.calls.length,0);assert.ok(f.expression.length<=8000);
  const driver=f.window.__jiyiV016Native;
  const created=await driver.create('N01-seed');assert.equal(created.preloadCount,0);
  await driver.submit('N01-seed');
  const prompt=f.calls.find(c=>c.method==='prompt').request;
  assert.equal(prompt.content[0].text,plan.cases[0].inputs[0]);assert.equal(prompt.mode,'queue');
  assert.deepEqual(Object.keys(prompt).sort(),['clientTimeZone','content','mode','requestId','sessionId']);
  assert.equal(prompt.sessionId,created.sessionId);assert.equal('gold'in prompt,false);
  await assert.rejects(driver.submit('N01-seed'),/duplicate/);await assert.rejects(driver.create('N01-seed'),/duplicate/);
  assert.equal(f.calls.filter(c=>c.method==='prompt').length,1);assert.equal(f.calls.filter(c=>c.method==='create').length,1);
  await assert.rejects(driver.cancel('N01-seed'),/Only frozen/);
  assert.equal(f.calls.some(c=>c.method==='cancel'),false);
  await driver.closeObservers();assert.equal(f.calls.at(-1).method,'dispose');
});

test('Native driver will not admit an input or create a Session against an unloaded final version',async()=>{
  const f=fixture('0.1.6-rc.1');await assert.rejects(f.window.__jiyiV016Native.create('N01-seed'),/Actual final version/);assert.equal(f.calls.length,0);
});
