import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { apply, validateSettings, recallMessage } from '../lib/index.js';
import { parseExtraction, userSource, eligibleSession } from '../lib/extract.js';
const installedTools = process.versions.electron ? await import('file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js') : null;
const installedLlm = process.versions.electron ? await import('file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js') : null;
class FixtureTextAssembler {
  text = ''; finish;
  push(chunk) {
    if (chunk.type === 'text-delta') this.text += chunk.text;
    else if (chunk.type === 'finish') this.finish = chunk.reason;
    else throw new Error(`Unexpected fixture chunk: ${chunk.type}`);
  }
  blocks() { return [{type:'text',text:this.text}]; }
}
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };

const source = {sessionId:'test-source',eventId:'3',eventSeq:3,eventTime:'2026-10-24T01:00:00Z',quote:'我长期偏好使用简体中文回答。'};
test('extraction accepts only supported exact user evidence and rejects guessed sources',()=>{
  const payload={projectId:'p-a',projectNames:['ProjectA'],sources:[source]};
  const m={content:'用户希望简体中文回答',type:'preference',scope:'global',factKey:'language',sourceSeqs:[3],quotes:['我长期偏好使用简体中文回答。'],supersedes:[]};
  assert.equal(parseExtraction(JSON.stringify({memories:[m]}),payload)[0].sources[0].evidence,'user-explicit');
  assert.throws(()=>parseExtraction(JSON.stringify({memories:[{...m,quotes:['助手已成功验证']}]}),payload),/原文/);
  assert.throws(()=>parseExtraction(JSON.stringify({memories:[{...m,sourceSeqs:[8]}]}),payload),/原文/);
  assert.throws(()=>parseExtraction(JSON.stringify({memories:[{...m,supersedes:['other-project']}]}),payload),/越界/);
  assert.equal(userSource({type:'user/message',data:{source:{kind:'plugin:jiyi'},content:[{type:'text',text:'quoted'}]}},'s'),null);
  assert.equal(eligibleSession({origin:'subagent'}),false);
});
test('settings keep failures explicit and reject invalid operational limits',()=>{
  assert.equal(validateSettings({extraction:{provider:null,model:null}}).extraction.provider,null);
  assert.throws(()=>validateSettings({retrieval:{timeoutMs:0}}),/timeoutMs/);
  assert.throws(()=>validateSettings({enabled:'yes'}),/boolean/);
});
test('recall messages are plugin user-role reference data, never fabricated tool results',()=>{
  const msg=recallMessage([{id:'m',version:1,scope:'global',updatedAt:'now',content:'中文',sources:[source]}],'r',x=>({...x,role:'user',id:'fresh'}),[]);
  assert.equal(msg.source.kind,'plugin:jiyi'); assert.equal(msg.role,'user');
  assert.equal(msg.toolCallId,undefined); assert.match(msg.content[0].text,/本轮用户明确要求优先/);
  assert.deepEqual(msg.source.memoryRefs,[{id:'m',version:1}]);
  assert.match(msg.content[0].text,/明确标注为“推论”或“建议”/);
  assert.match(msg.content[0].text,/不能称为已确认的额外项目规则、许可限制或实现行为/);
  assert.match(msg.content[0].text,/未记载的具体细节应说明未知/);
});

async function fixture({dataDir,removeOnCleanup=true}={}) {
  const dir=dataDir??mkdtempSync(join(tmpdir(),'jiyi-host-test-'));
  const listeners=new Map(),effects=[],routes=new Map(),sessions=new Map();
  const session={id:`jiyi-test-${randomUUID()}`,header:{cwd:join(dir,'ProjectA'),origin:'user'}};sessions.set(session.id,session);
  const helper={createUserMessage:installedLlm?.createUserMessage??(x=>({...x,id:randomUUID(),role:'user'})),BlockAssembler:installedLlm?.BlockAssembler??FixtureTextAssembler};
  let extractionCalls=0,relevanceCalls=0;
  let judge=async payload=>payload.candidates.filter(c=>c.content==='用户长期偏好使用简体中文回答').map(({id,version})=>({id,version}));
  const prepareCall=async(config,signal,configure)=>{
    signal?.throwIfAborted();
    const {provider,model,...controls}=config;
    const selected=configure?configure(controls,{reasoning:{efforts:[{id:'minimal',name:'Minimal'}]}}):controls;
    return {config:{provider,model,...selected},stream:async function*(request){
      assert.deepEqual(request.tools,[],'Programmatic subcalls must not expose tools');
      assert.equal(request.sessionId,undefined);assert.equal(request.purpose,undefined);
      const payload=JSON.parse(request.messages[0].content[0].text);
      let result;
      if(Array.isArray(payload.candidates)) {
        relevanceCalls++;result={ids:(await judge(payload)).map(ref=>({...ref,quote:payload.candidates.find(c=>c.id===ref.id&&c.version===ref.version)?.content??'invalid fixture reference'}))};
      } else {
        assert.ok(Array.isArray(payload.sources),'Extraction fixture requires explicit user sources');
        extractionCalls++;
        result={memories:payload.sources.map(s=>({content:'用户长期偏好使用简体中文回答',type:'preference',scope:'global',factKey:'language',sourceSeqs:[s.eventSeq],quotes:[s.quote],supersedes:[]}))};
      }
      yield {type:'text-delta',index:0,text:JSON.stringify(result)};
      yield {type:'finish',reason:{kind:'stop'}};
    }};
  };
  const ctx={connection:{fetch:{register:r=>routes.set(r.path,r)}},loader:{import:async()=>helper},llm:{prepareCall},agents:{get:()=>null},sessions:{get:id=>sessions.get(id)},sessionPersistence:{open:async()=>{throw new Error('No stored test session');}},tools:{register:definition=>{assert.equal(typeof definition.output?.render,'function','current Host requires tool output.render');assert.deepEqual(definition.output.schema,{type:'object'});if(installedTools){installedTools.assertSupportedJsonSchema(definition.parameters);installedTools.ToolRuntime.prototype.register.call({ctx:{},layers:{effect:(_ctx,fn)=>fn({tools:{insert:()=>()=>{}}})}},definition);}}},logger:{error:()=>{}},on:(name,fn)=>{listeners.set(name,fn);return ()=>{};},effect:fn=>{effects.push(fn());}};
  await apply(ctx,{dataDir:dir});
  const route=routes.get('/api/jiyi');
  const request=async(op,body)=>{const req=body?new Request('http://local/api/jiyi',{method:'POST',body:JSON.stringify({op,...body})}):new Request(`http://local/api/jiyi?op=${op}&sessionId=${session.id}`); const res=await route.fetch(req); return res.json();};
  const event=(seq,type,data)=>({seq,type,data,time:Date.now()});
  const emit=e=>listeners.get('session/event')(session,e);
  const state=()=>request('state');
  const cleanup=async()=>{for(const dispose of effects.reverse())if(typeof dispose==='function')await dispose();if(removeOnCleanup)rmSync(dir,{recursive:true,force:true});};
  return {ctx,helper,session,route,listeners,state,request,emit,event,cleanup,getExtractionCalls:()=>extractionCalls,getRelevanceCalls:()=>relevanceCalls,setJudge:fn=>{judge=fn;}};
}

test('Host GET search supports absent session context without SQLite binding errors or scope leakage',async()=>{
  const f=await fixture();
  try {
    const memory=await seedPreference(f);
    const response=await f.route.fetch(new Request('http://local/api/jiyi?op=search&query='+encodeURIComponent('请用汉语作答')+'&scope=global'));
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.ok,true);assert.equal(result.status,'hit');
    assert.deepEqual(result.memories.map(m=>m.id),[memory.id]);
    assert.equal(f.getRelevanceCalls(),1);
    assert.ok(result.diagnostics.hostLatency.events.some(e=>e.stage==='scopePreparation'&&e.status==='success'));
    assert.ok(result.diagnostics.stages.some(e=>e.component==='llm'&&e.stage==='prepare'&&e.status==='success'));
    const startup=(await f.state()).runtime;
    assert.equal(startup.pid,process.pid);assert.match(startup.sourceFilesAtStartup['lib/index.js'],/^[a-f0-9]{64}$/);
    const unknown=await (await f.route.fetch(new Request('http://local/api/jiyi?op=search&query=x&scope=unknown-project'))).json();
    assert.equal(unknown.status,'error');assert.equal(unknown.ok,false);
    assert.ok(unknown.diagnostics.hostLatency.events.some(e=>e.stage==='scopePreparation'&&e.status==='error'));
    const project=(await f.state()).projects.find(p=>p.path===f.session.header.cwd);
    assert.ok(project);
    const aliasAdded=await f.request('addProjectAlias',{id:project.id,alias:'项目 别名Ｂ'});
    assert.equal(aliasAdded.ok,true);assert.ok(aliasAdded.project.aliases.includes('项目 别名Ｂ'));
    const aliasDeleted=await f.request('deleteProjectAlias',{id:project.id,alias:'项目 别名Ｂ'});
    assert.equal(aliasDeleted.ok,true);assert.equal(aliasDeleted.project.aliases.includes('项目 别名Ｂ'),false);
    const scopedResponse=await f.route.fetch(new Request('http://local/api/jiyi?op=search&query='+encodeURIComponent('请用汉语作答')+'&scope='+project.id));
    assert.equal(scopedResponse.status,200);
    const scoped=await scopedResponse.json();
    assert.equal(scoped.ok,true);assert.equal(scoped.status,'no-hit');
    assert.deepEqual(scoped.memories,[],'An explicit project scope must not borrow the global preference');
    assert.equal(f.getRelevanceCalls(),1,'An actually empty scoped store needs no judge call');
    assert.equal((await f.state()).memories[0].version,memory.version);
  } finally {await f.cleanup();}
});

test('saved statusStaleHours persists through complete plugin disposal/reapply and changes actual search order, then restores 72',async()=>{
  const {MemoryStore}=await import('../lib/store.js');
  const {EMBEDDING_MODEL,EMBEDDING_VERSION,EMBEDDING_DIMENSIONS}=await import('../lib/models.js');
  let f=await fixture({removeOnCleanup:false}),dir;
  try {
    const state=await f.state();dir=state.paths.dataDir;
    let stamp=new Date(Date.now()-80*3600000).toISOString();
    const seed=new MemoryStore(state.paths.database,{clock:()=>stamp});
    try {
      const base={scope:'global',kind:'status',content:'持久化排序基准状态等待核实',sources:[source],embedding:Array.from({length:EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0),embeddingModel:EMBEDDING_MODEL,embeddingVersion:EMBEDDING_VERSION};
      seed.putMemory({...base,id:'a-aging-status'});
      stamp=new Date().toISOString();seed.putMemory({...base,id:'b-fresh-status'});
    } finally {seed.close();}
    const all=async({candidates})=>candidates.map(({id,version})=>({id,version}));
    const search=async()=>{
      f.setJudge(all);
      const response=await f.route.fetch(new Request('http://local/api/jiyi?op=search&scope=global&query='+encodeURIComponent('持久化排序基准状态等待核实')));
      const result=await response.json();assert.equal(result.status,'hit',JSON.stringify(result));return result;
    };
    assert.deepEqual((await search()).memories.map(m=>m.id),['b-fresh-status','a-aging-status']);
    const next={...state.settings,retrieval:{...state.settings.retrieval,statusStaleHours:96}};
    assert.equal((await f.request('settings',{settings:next})).ok,true);
    assert.equal(JSON.parse(readFileSync(state.paths.settings,'utf8')).retrieval.statusStaleHours,96);
    assert.deepEqual((await search()).memories.map(m=>m.id),['a-aging-status','b-fresh-status']);
    await f.cleanup();f=null;
    f=await fixture({dataDir:dir,removeOnCleanup:false});
    const reopened=await f.state();assert.equal(reopened.settings.retrieval.statusStaleHours,96);
    assert.deepEqual((await search()).memories.map(m=>m.id),['a-aging-status','b-fresh-status']);
    assert.equal((await f.request('settings',{settings:{...reopened.settings,retrieval:{...reopened.settings.retrieval,statusStaleHours:72}}})).ok,true);
    assert.equal(JSON.parse(readFileSync(reopened.paths.settings,'utf8')).retrieval.statusStaleHours,72);
    assert.deepEqual((await search()).memories.map(m=>m.id),['b-fresh-status','a-aging-status']);
  } finally {if(f)await f.cleanup();if(dir)rmSync(dir,{recursive:true,force:true});}
});

async function until(check,timeout=20000){const started=Date.now();while(Date.now()-started<timeout){const r=await check();if(r)return r;await new Promise(r=>setTimeout(r,25));}throw new Error('Test condition timeout');}

test('Host exposes unconfigured models and extraction service failure instead of success or no-hit',async()=>{
  const f=await fixture();
  try {
    const saved=await f.request('settings',{settings:{extraction:{provider:null,model:null},embedding:{backend:null}}});
    assert.equal(saved.ok,true);
    const verification=await f.request('verifyExtraction',{});
    assert.equal(verification.ok,false);assert.match(verification.error,/未配置/);
    const state=await f.state();
    assert.equal(state.models.extraction.status,'not-configured');assert.equal(state.models.embedding.status,'not-configured');
    const {DatabaseSync}=await import('node:sqlite');
    const persisted=()=>{const db=new DatabaseSync(state.paths.database,{readOnly:true});try{return JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='extractionState'").get().value);}finally{db.close();}};
    assert.equal(persisted().status,'not-configured');
    const failedEmbedding=await f.request('verifyEmbedding',{});assert.equal(failedEmbedding.ok,false);
    await f.request('settings',{settings:{}});
    assert.equal(persisted().status,'not-verified','saving settings must durably invalidate an older verification');
    f.ctx.llm.prepareCall=async()=>{throw Object.assign(new Error('Injected extraction service unavailable'),{code:'TEST_SERVICE_FAILURE'});};
    const failed=await f.request('verifyExtraction',{});
    assert.equal(failed.ok,false);assert.match(failed.error,/TEST_SERVICE_FAILURE/);
    assert.equal((await f.state()).models.extraction.status,'error');
    assert.equal(persisted().status,'error');
    assert.match(persisted().error,/TEST_SERVICE_FAILURE/);
  } finally { await f.cleanup(); }
});

test('Host event→durable queue→real local embedding→automatic pre-step injection, replay and tool continuation',async()=>{
  const f=await fixture();
  try {
    const pre=f.listeners.get('agent/pre-step');
    const agent={session:f.session};const signal=new AbortController().signal;
    const blank={kind:'enter',messages:[]};
    assert.equal(await pre({agent,signal},async()=>blank),blank);
    const user={id:'new-user-1',role:'user',source:{kind:'user'},content:[{type:'text',text:source.quote}]};
    f.emit(f.event(1,'user/message',user));f.emit(f.event(2,'turn/end',{turn:1,reason:{kind:'completed'}}));
    await until(async()=>{const s=await f.state();return s.queue.some(j=>j.status==='done')&&s;});
    let s=await f.state();assert.equal(s.memories.length,1);assert.equal(f.getExtractionCalls(),1);
    f.emit(f.event(2,'turn/end',{turn:1,reason:{kind:'completed'}}));
    assert.equal((await f.state()).queue.length,1);
    const newMessage={...user,id:'new-user-2',content:[{type:'text',text:'请用汉语作答'}]};
    const decision=await pre({agent,signal},async()=>({kind:'enter',messages:[newMessage]}));
    assert.equal(decision.messages.length,2);const injected=decision.messages[1];assert.equal(injected.source.kind,'plugin:jiyi');
    f.emit(f.event(3,'user/message',injected));
    const injectedState=await f.state(),recall=injectedState.retrievals[0];
    assert.equal(recall.status,'injected');
    const diagnostics=recall.details.diagnostics;
    assert.equal(diagnostics.relevance.version,'jiyi-relevance-v7');
    assert.deepEqual(diagnostics.relevance.grounding.items,[{id:s.memories[0].id,version:1,contentSha256:'f5ffb00a38b35e32ca7ec088aee4a977b9cc6700cf02b7e20a63bcc4d3d9e227',quoteSha256:'f5ffb00a38b35e32ca7ec088aee4a977b9cc6700cf02b7e20a63bcc4d3d9e227',quoteStart:0,quoteEnd:14,quoteBytes:42}]);
    assert.equal(injectedState.memories[0].content,'用户长期偏好使用简体中文回答','Existing full memory content must not be replaced by a quote');
    assert.equal(JSON.stringify(diagnostics).includes('用户长期偏好使用简体中文回答'),false,'New diagnostics must not retain a second quote/raw response copy');
    assert.equal(diagnostics.embeddingExecutionStatus,'observed');
    assert.equal(diagnostics.embeddingExecutions.length,1);
    const execution=diagnostics.embeddingExecutions[0];
    assert.ok(Number.isSafeInteger(execution.pid)&&execution.pid>0);
    assert.equal(execution.exitCode,0);assert.equal(execution.signal,null);
    assert.throws(()=>process.kill(execution.pid,0),{code:'ESRCH'},'Actual returned query child is closed and no longer present at this check');
    const continuation={kind:'enter',messages:[{id:'tool-next',role:'tool',source:{kind:'tool'},content:[]}]};
    assert.equal(await pre({agent,signal},async()=>continuation),continuation);
    const repeated=await pre({agent,signal},async()=>({kind:'enter',messages:[newMessage]}));assert.equal(repeated.messages.length,1);
    f.emit(f.event(4,'turn/end',{turn:2,reason:{kind:'completed'}}));assert.equal((await f.state()).queue.length,1);
    f.emit(f.event(5,'user/message',{...user,id:'cancelled-user'}));f.emit(f.event(6,'turn/end',{turn:3,reason:{kind:'aborted'}}));
    assert.equal((await f.state()).queue.length,1);
    const result=await f.request('source',{sessionId:'unrelated',eventSeq:3});assert.equal(result.ok,false);
    const corrected=await f.request('correct',{id:s.memories[0].id,version:s.memories[0].version,content:'用户长期偏好使用中文进行代码评审'});
    assert.equal(corrected.ok,true);
    const audit=corrected.memory.sources.find(s=>s.origin==='manual');
    assert.ok(audit.sessionId.startsWith('jiyi-manual:'));assert.equal(audit.eventSeq,0);
    const auditRead=await f.request('source',{sessionId:audit.sessionId,eventSeq:0});
    assert.equal(auditRead.ok,true);assert.equal(auditRead.source.event.type,'jiyi/manual-correction');
    assert.equal(auditRead.source.event.data.content,'用户长期偏好使用中文进行代码评审');
    assert.ok(corrected.memory.sources.some(s=>s.sessionId===f.session.id));
    const removed=await f.request('delete',{id:s.memories[0].id,version:corrected.memory.version});assert.equal(removed.ok,true);
    const query={...newMessage,id:'after-delete'};
    assert.equal((await pre({agent,signal},async()=>({kind:'enter',messages:[query]}))).messages.length,1);
    assert.ok(f.getRelevanceCalls()>=1,'Automatic recall must use the relevance judge before injection');
  } finally {await f.cleanup();}
});

async function seedPreference(f) {
  f.emit(f.event(1,'user/message',{id:'seed-user',role:'user',source:{kind:'user'},content:[{type:'text',text:source.quote}]}));
  f.emit(f.event(2,'turn/end',{turn:1,reason:{kind:'completed'}}));
  return until(async()=>{const s=await f.state();return s.queue.some(j=>j.status==='done')&&s.memories[0];});
}

test('Host keeps relevance failure explicit and retries only for a new genuine user message',async()=>{
  const f=await fixture();
  try {
    await seedPreference(f);
    f.setJudge(async()=>{throw Object.assign(new Error('Injected relevance service unavailable'),{code:'TEST_RELEVANCE_FAILURE'});});
    const pre=f.listeners.get('agent/pre-step'),signal=new AbortController().signal,agent={session:f.session};
    const decision={kind:'enter',messages:[{id:'relevance-failure-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'请用汉语作答'}]}]};
    assert.equal(await pre({agent,signal},async()=>decision),decision,'Failed relevance must preserve the original message list');
    const failed=await f.state();
    assert.equal(failed.version,'0.1.14');
    assert.equal(failed.retrievals[0].status,'error');
    assert.match(failed.retrievals[0].error,/TEST_RELEVANCE_FAILURE/);
    assert.deepEqual(failed.retrievals[0].memoryIds,[]);
    assert.equal(failed.models.relevance.status,'error');
    assert.equal(f.getRelevanceCalls(),1);
    f.setJudge(async payload=>payload.candidates.filter(c=>c.content==='用户长期偏好使用简体中文回答').map(({id,version})=>({id,version})));
    assert.equal(await pre({agent,signal},async()=>decision),decision,'A continued step with the same user input must not retry a failed LLM subcall');
    assert.equal(f.getRelevanceCalls(),1,'Only new genuine input may trigger automatic relevance again');
    const continued=await f.state();
    assert.equal(continued.retrievals.length,1);
    assert.equal(continued.retrievals[0].status,'error','Failure deduplication must not rewrite error as an empty successful recall');
    assert.match(continued.retrievals[0].error,/TEST_RELEVANCE_FAILURE/);
    assert.deepEqual(continued.retrievals[0].memoryIds,[]);
    const newInput={kind:'enter',messages:[{...decision.messages[0],id:'relevance-new-genuine-user'}]};
    const retried=await pre({agent,signal},async()=>newInput);
    assert.equal(retried.messages.length,2,'A new genuine user id permits a new automatic relevance attempt');
    assert.equal(retried.messages[1].source.kind,'plugin:jiyi');
    assert.equal(f.getRelevanceCalls(),2);
    assert.ok((await f.state()).retrievals.some(r=>r.status==='error'&&/TEST_RELEVANCE_FAILURE/.test(r.error)),'The earlier explicit failure remains in recall history');
  } finally {await f.cleanup();}
});

test('Host rejects a stale selected version corrected while relevance is awaiting',async()=>{
  const f=await fixture(),gate=deferred();let pending;
  try {
    const original=await seedPreference(f);let entered=false;
    f.setJudge(async payload=>{entered=true;await gate.promise;return payload.candidates.filter(c=>c.id===original.id).map(({id,version})=>({id,version}));});
    const pre=f.listeners.get('agent/pre-step'),signal=new AbortController().signal,agent={session:f.session};
    const decision={kind:'enter',messages:[{id:'relevance-stale-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'请用汉语作答'}]}]};
    pending=pre({agent,signal},async()=>decision);
    await until(()=>entered);
    const corrected=await f.request('correct',{id:original.id,version:original.version,content:'用户长期偏好使用中文进行代码评审'});
    assert.equal(corrected.ok,true);assert.equal(corrected.memory.version,original.version+1);
    gate.resolve();
    assert.equal(await pending,decision,'A stale LLM selection must never be injected');
    const state=await f.state();
    assert.equal(state.retrievals[0].status,'error');
    assert.match(state.retrievals[0].error,/RECALL_STALE/);
    assert.deepEqual(state.retrievals[0].memoryIds,[]);
    assert.equal(state.memories.find(m=>m.id===original.id).version,corrected.memory.version);
  } finally {gate.resolve();await pending;await f.cleanup();}
});

test('Native packaging refuses late recall after synchronous work despite an undelivered timeout signal',async()=>{
  const f=await fixture();
  try {
    await seedPreference(f);
    await f.request('settings',{settings:{retrieval:{timeoutMs:3000}}});
    const original=f.helper.createUserMessage;let blocked=false;
    f.helper.createUserMessage=input=>{
      if(input.source?.kind==='plugin:jiyi'&&!blocked){
        blocked=true;
        const until=performance.now()+3010;
        while(performance.now()<until){} // Deliberately prevents timeout-event delivery.
      }
      return original(input);
    };
    const signal=new AbortController().signal;
    const decision={kind:'enter',messages:[{id:'late-pack-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'请用汉语作答'}]}]};
    const actual=await f.listeners.get('agent/pre-step')({agent:{session:f.session},signal},async()=>decision);
    assert.equal(f.getRelevanceCalls(),1,'The judge actually succeeded before the artificial synchronous stall');
    assert.equal(blocked,true);assert.equal(signal.aborted,false,'No external cancellation may hide the deadline guard');
    assert.equal(actual,decision,'No late reference may enter the main-model input');
    const record=(await f.state()).retrievals[0];
    assert.equal(record.status,'timeout');assert.deepEqual(record.memoryIds,[]);
    assert.match(record.error,/RETRIEVAL_TIMEOUT/);
  } finally {await f.cleanup();}
});

for(const transport of ['ipc','cli']) for(const liveEvents of [false,true]) test(`Host ${transport} evaluation: formal recall continues, legitimate live events=${liveEvents}`,async()=>{
  const {MemoryStore}=await import('../lib/store.js');
  const {databaseSnapshot}=await import('../lib/eval-integrity.js');
  const {createConnection}=await import('node:net');
  const {dirname,resolve}=await import('node:path');
  const f=await fixture(),gate=deferred();let pending,runDir,inputDir;
  const exchange=(path,body)=>new Promise((resolve,reject)=>{
    const socket=createConnection(path);let text='';socket.setEncoding('utf8');
    socket.on('connect',()=>socket.write(JSON.stringify(body)+'\n'));socket.on('data',chunk=>{text+=chunk;});socket.on('error',reject);
    socket.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });
  try {
    const state=await f.state();
    await f.request('settings',{settings:{relevance:{provider:'deepseek-account',model:'deepseek-flash'}}});
    const sourceStore=new MemoryStore(state.paths.database);
    const folder=resolve(import.meta.dirname,'./fixtures/projects/alpha');
    let memory;
    try {
      const project=sourceStore.resolveProject({cwd:folder});
      memory=sourceStore.putMemory({id:'synthetic-host-evaluation-memory',scope:'project',projectId:project.id,content:'水杉A项目约定：normalizeInvoiceSS(invoice) 的金额字段使用整数分，禁止使用浮点元。',sources:[source]});
    } finally {sourceStore.close();}
    inputDir=mkdtempSync(join(resolve(import.meta.dirname,'../evidence'),'host-evaluation-fixture-'));
    const inputPath=join(inputDir,'cases.json');
    writeFileSync(inputPath,JSON.stringify({relevance:{provider:'deepseek-account',model:'deepseek-flash'},cases:[{n:1,id:'fixture:1',split:'R',folder,query:memory.content,expected:'inject',expectedMemoryIds:[memory.id]}]}));
    const pre=f.listeners.get('agent/pre-step');
    const originalDecision={kind:'enter',messages:[{id:'orchestrator-original',role:'user',source:{kind:'user'},content:[{type:'text',text:'a genuine request before evaluation'}]}]};
    await pre({agent:{session:f.session},signal:new AbortController().signal},async()=>originalDecision);
    if(liveEvents) {
      const production=new MemoryStore(state.paths.database);
      try {production.putMemory({id:'live-recall-preference',scope:'global',content:'用户长期偏好使用简体中文回答',sources:[source]});} finally {production.close();}
    }
    const endpoint=JSON.parse(readFileSync(join(state.paths.dataDir,'eval-endpoint.json'),'utf8'));
    assert.equal((await exchange(endpoint.socketPath,{op:'status'})).version,'0.1.14');
    const before=databaseSnapshot(state.paths.database);let entered=false;
    f.setJudge(async payload=>{if(payload.candidates.some(c=>c.id===memory.id)){entered=true;await gate.promise;}return payload.candidates.map(({id,version})=>({id,version}));});
    if(transport==='cli') {
      const {execFile}=await import('node:child_process');
      pending=new Promise((resolve,reject)=>{
        execFile('/usr/local/bin/node',[join(import.meta.dirname,'../scripts/evaluate.mjs'),'--run','--input',inputPath,'--cases','1','--data-dir',state.paths.dataDir],{maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
          try {resolve({...JSON.parse(stdout),cliExit:error?.code??0,cliStderr:stderr});}catch(e){reject(new Error(`${e.message}: ${stderr}`));}
        });
      });
    } else pending=exchange(endpoint.socketPath,{op:'run',version:'0.1.14',inputPath,caseIds:[1]});
    await until(()=>entered);
    const renamed=await f.request('project',{id:memory.projectId,name:'并行正式管理',aliases:[]});
    assert.equal(renamed.ok,true,'management remains available during evaluation');
    const search=await (await f.route.fetch(new Request('http://local/api/jiyi?op=search&query=&scope=global'))).json();
    assert.equal(search.status,'skipped');assert.equal(search.code,undefined);
    const continuation={kind:'enter',messages:[]};
    assert.equal(await pre({agent:{session:f.session},signal:new AbortController().signal},async()=>continuation),continuation,'unrelated tool continuation must not become an EVAL_BUSY error turn');
    assert.equal(await pre({agent:{session:f.session},signal:new AbortController().signal},async()=>originalDecision),originalDecision,'recorded genuine request must survive tool continuation without a new recall or error turn');
    if(liveEvents) {
      // No user event has registered this cwd. pre-step/search must register it
      // even while evaluation is active, not silently fall back to global-only.
      f.session.header.cwd=join(state.paths.dataDir,'BrandNewDuringEvaluation');
      assert.equal((await f.state()).projects.some(p=>p.path===f.session.header.cwd),false);
      const fresh={kind:'enter',messages:[{id:'fresh-during-eval',role:'user',source:{kind:'user'},content:[{type:'text',text:'请用汉语作答'}]}]};
      const liveDecision=await pre({agent:{session:f.session},signal:new AbortController().signal},async()=>fresh);
      const registered=(await f.state()).projects.find(p=>p.path===f.session.header.cwd);
      assert.ok(registered,'first recall must persist the new current project during evaluation');
      assert.ok(registered.aliases.includes('BrandNewDuringEvaluation'));
      const scoped=await (await f.route.fetch(new Request('http://local/api/jiyi?op=search&sessionId='+f.session.id+'&query='+encodeURIComponent('请用汉语作答')+'&scope='+registered.id))).json();
      assert.equal(scoped.status,'no-hit','new project scope is valid and must not borrow the global preference');
      assert.deepEqual(scoped.memories,[]);
      f.emit(f.event(501,'user/message',{id:'deferred-real-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'deferred real user event'}]}));
      assert.equal(liveDecision.messages.length,2,'fresh production recall injects before evaluation finishes');
      assert.deepEqual(liveDecision.messages[1].source.memoryRefs,[{id:'live-recall-preference',version:1}]);
      const readOnlyCheck=new MemoryStore(state.paths.database);
      try {assert.equal(readOnlyCheck.getMemory('live-recall-preference').embedding,null,'formal recall must not persist embeddings during evaluation');}finally{readOnlyCheck.close();}
      f.emit(f.event(502,'turn/end',{turn:2,reason:{kind:'completed'}}));
      const live=await f.state();assert.equal(live.queue[0].status,'pending','extraction is durable but deferred');
      assert.equal(f.getExtractionCalls(),0);
    }
    assert.notDeepEqual(databaseSnapshot(state.paths.database),before,'normal production writes are allowed and audited');
    gate.resolve();const result=await pending;runDir=result.runDir;
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.integrity.unchanged,false);
    assert.equal(result.integrity.passed,true);assert.equal(result.integrity.audit.passed,true);
    assert.ok(result.integrity.productionWrites.length>0);assert.deepEqual(result.integrity.evaluationSessionLeaks,[]);
    if(liveEvents) {
      const registrations=result.integrity.productionWrites.filter(w=>w.source.kind==='project-registration'&&w.source.sessionId===f.session.id);
      assert.ok(registrations.some(w=>w.changes.some(c=>c.table==='projects')));
      assert.ok(registrations.some(w=>w.changes.some(c=>c.table==='project_aliases')));
    }
    assert.deepEqual(result.integrity.before,before);
    if(transport==='cli') {
      assert.equal(result.cliExit,0);
      assert.equal(result.postReturnIntegrity.passed,true);
      assert.equal(JSON.parse(readFileSync(result.postReturnAuditPath,'utf8')).passed,true);
    }
    const artifact=JSON.parse(readFileSync(result.resultPath,'utf8'));
    assert.equal(artifact.cleanup.ok,true);assert.equal(artifact.cleanup.productionContinued,true);assert.equal(artifact.cleanup.modelsDisposed,true);
    assert.equal(artifact.cases[0].passed,true);
    assert.equal(artifact.status,'completed');
    assert.deepEqual(artifact.cases[0].actualInjectedMemoryIds,[memory.id]);
    assert.equal(artifact.cases[0].diagnostics.relevance.provider,'deepseek-account');assert.equal(f.getRelevanceCalls(),liveEvents?2:1);
    const after=new MemoryStore(state.paths.database);
    try {
      assert.equal(after.getMemory(memory.id).content,memory.content);assert.equal(after.getMemory(memory.id).embedding,null);
      assert.equal(after.listRecalls().length,liveEvents?2:1);assert.equal(after.listJobs().length,liveEvents?1:0);
      assert.equal(after.getMetadata(`skipped:${f.session.id}`),null,'evaluation must never manufacture the orchestrator skipped metadata that caused the live failure');
      if(liveEvents) assert.equal(after.getMetadata(`recentUser:${f.session.id}`)[0].text,'deferred real user event','real event must not be discarded');
      assert.equal(after.db.prepare('PRAGMA query_only').get().query_only,0);
    } finally {after.close();}
    const idleCorrection=await f.request('correct',{id:memory.id,version:1,content:'normal production mutation resumes'});
    assert.equal(idleCorrection.ok,true,'regular behavior resumes after evaluation');
  } finally {
    gate.resolve();if(pending){const r=await pending;runDir??=r.runDir;}
    await f.cleanup();
    if(inputDir){assert.equal(dirname(resolve(inputDir)),resolve(import.meta.dirname,'../evidence'));rmSync(inputDir,{recursive:true,force:false});}
    if(runDir){
      assert.equal(dirname(resolve(runDir)),resolve(import.meta.dirname,'../evidence/eval-runs'));
      assert.match(runDir,/\d{4}-\d{2}-\d{2}T.*-[a-f0-9]{8}$/);
      rmSync(runDir,{recursive:true,force:false});
    }
  }
});
