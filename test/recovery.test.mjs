import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { apply } from '../lib/index.js';
import { MemoryStore } from '../lib/store.js';
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
const user = (seq,text='我长期偏好中文回复。',time=Date.now()) => ({seq,time,type:'user/message',data:{id:`user-${seq}`,role:'user',source:{kind:'user'},content:[{type:'text',text}]}});
const end = (seq,turn=1,time=Date.now()) => ({seq,time,type:'turn/end',data:{turn,reason:{kind:'completed'}}});
async function until(check,timeoutMs=20000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) { const result=await check(); if(result) return result; await new Promise(r=>setTimeout(r,20)); }
  throw new Error(`Recovery condition did not settle within ${timeoutMs}ms`);
}
function workspace(t) {
  const dir=mkdtempSync(join(tmpdir(),'jiyi-recovery-test-'));
  const session={id:`recovery-${randomUUID()}`,header:{cwd:join(dir,'ProjectA'),origin:'user'}};
  const events=[],activeStops=new Set();
  const db=fn=>{const s=new MemoryStore(join(dir,'memory.sqlite'));try{return fn(s);}finally{s.close();}};
  t.after(async()=>{
    for(const stop of activeStops) await stop();
    const target=resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir())+'/jiyi-recovery-test-'),'Cleanup must target this test-owned directory');
    rmSync(target,{recursive:true,force:true});
  });
  return {dir,session,events,db,activeStops};
}
async function launch(w,{read,extractMemories=false,beforeExtraction,guard}={}) {
  const listeners=new Map(),effects=[],routes=new Map(),inputs=[];
  let opens=0,closes=0,stopped=false;
  const helpers={createUserMessage:installedLlm?.createUserMessage??(x=>({...x,id:randomUUID(),role:'user'})),BlockAssembler:installedLlm?.BlockAssembler??FixtureTextAssembler};
  const ctx={
    connection:{fetch:{register:r=>routes.set(r.path,r)}},loader:{import:async()=>helpers},
    llm:{...(guard?{getTaskBudgetGuard:()=>guard}:{}),prepareCall:async(config,signal,configure)=>{
      signal?.throwIfAborted();const {provider,model,...controls}=config;
      const selected=configure?configure(controls,{reasoning:{efforts:[{id:'minimal',name:'Minimal'}]}}):controls;
      return {config:{provider,model,...selected},stream:async function*(request){
        assert.deepEqual(request.tools,[]);assert.equal(request.sessionId,undefined);assert.equal(request.purpose,undefined);
        const payload=JSON.parse(request.messages[0].content[0].text);
        let result;
        if(Array.isArray(payload.candidates)) {
          result={ids:payload.candidates.filter(c=>c.content.includes('长期偏好')).map(({id,version})=>({id,version}))};
        } else {
          assert.ok(Array.isArray(payload.sources));inputs.push(payload);
          if(beforeExtraction)await beforeExtraction(request);
          result={memories:extractMemories?payload.sources.map(s=>({content:s.quote,type:'preference',scope:'global',factKey:`preference:${s.quote}`,sourceSeqs:[s.eventSeq],quotes:[s.quote],supersedes:[]})):[]};
        }
        yield {type:'text-delta',index:0,text:JSON.stringify(result)};
        yield {type:'finish',reason:{kind:'stop'}};
      }};
    }},
    agents:{get:()=>null},sessions:{get:id=>id===w.session.id?w.session:null},
    sessionPersistence:{open:async id=>{
      assert.equal(id,w.session.id);opens++;
      return {header:w.session.header,read:async(from,to,{signal}={})=>{
        if(!read)return {events:w.events.filter(e=>e.seq>=from)};
        let abort;
        try{return await Promise.race([read(from),new Promise((_,reject)=>{
          abort=()=>reject(new Error('Fixture read aborted'));
          if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
        })]);}finally{if(abort)signal?.removeEventListener('abort',abort);}
      },close:async()=>{closes++;}};
    }},
    tools:{register:()=>{}},
    on:(name,fn)=>{listeners.set(name,fn);return ()=>{};},effect:fn=>effects.push(fn()),
  };
  await apply(ctx,{dataDir:w.dir});
  const state=async()=>{
    const response=await routes.get('/api/jiyi').fetch(new Request(`http://local/api/jiyi?op=state&sessionId=${w.session.id}`));
    assert.equal(response.status,200);return response.json();
  };
  const emit=event=>{
    if(!w.events.some(e=>e.seq===event.seq)) w.events.push(event);
    listeners.get('session/event')(w.session,event);
  };
  const stop=async()=>{if(stopped)return;stopped=true;for(const effect of effects.reverse())if(typeof effect==='function')await effect();w.activeStops.delete(stop);};
  w.activeStops.add(stop);
  return {emit,state,stop,inputs,get opens(){return opens;},get closes(){return closes;}};
}

test('review pause retains original task sources through restart and extracts only after matching continuation',async t=>{
  const w=workspace(t);let f=await launch(w);
  t.after(async()=>{await f?.stop();});
  const original=user(1);original.data.taskId='task-original';f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_REVIEW_PAUSED',message:'paused'}}}});
  assert.equal((await f.state()).queue.length,0);
  w.db(s=>assert.equal(s.getMetadata('watchedSessions')[w.session.id].reviewPendingTaskId,'task-original'));
  await f.stop();
  f=await launch(w);
  await until(()=>f.closes===1);
  f.emit(end(3,2));
  assert.equal((await f.state()).queue.length,0,'an unrelated completion cannot consume retained sources');
  f.emit({seq:4,time:Date.now(),type:'user/message',data:{id:'review-cont',taskId:'task-original',role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续原任务'}]}});
  f.emit(end(5,3));
  await until(async()=> (await f.state()).queue.some(j=>j.status==='done'));
  assert.deepEqual(f.inputs[0].sources.map(s=>s.eventSeq),[1]);
  w.db(s=>assert.deepEqual(s.getMetadata('watchedSessions')[w.session.id].pending,[]));
});

test('correction pause preserves sources across restart until the same task explicitly continues',async t=>{
  const w=workspace(t);let f=await launch(w);t.after(async()=>{await f?.stop();});
  const original=user(1);original.data.taskId='correction-task';f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  assert.equal((await f.state()).queue.length,0);
  w.db(s=>assert.equal(s.getMetadata('watchedSessions')[w.session.id].reviewPendingTaskId,'correction-task'));
  await f.stop();f=await launch(w);await until(()=>f.closes===1);
  f.emit(end(3,2));assert.equal((await f.state()).queue.length,0);
  f.emit({seq:4,time:Date.now(),type:'user/message',data:{id:'correction-cont',taskId:'correction-task',role:'user',source:{kind:'plugin:jiupian-continuation'},content:[{type:'text',text:'继续原任务'}]}});
  f.emit(end(5,3));await until(async()=> (await f.state()).queue.some(j=>j.status==='done'));
  assert.deepEqual(f.inputs[0].sources.map(s=>s.eventSeq),[1]);
});

test('correction continuation from a different or unattributed task never inherits old sources',async t=>{
  for(const taskId of ['other-task',undefined]) {
    const w=workspace(t),f=await launch(w);t.after(()=>f.stop());
    const original=user(1);original.data.taskId='original-task';f.emit(original);
    f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
    f.emit({seq:3,time:Date.now(),type:'user/message',data:{id:'wrong-cont',...(taskId?{taskId}:{}),role:'user',source:{kind:'plugin:jiupian-continuation'},content:[{type:'text',text:'继续原任务'}]}});
    f.emit(end(4,2));assert.equal((await f.state()).queue.length,0);
    w.db(s=>assert.deepEqual(s.getMetadata('watchedSessions')[w.session.id].pending,[]));
  }
});

test('a failed continuation attempt does not extract or discard a correction-paused task before matching continuation',async t=>{
  const w=workspace(t),f=await launch(w);t.after(()=>f.stop());
  const original=user(1);original.data.taskId='original-task';f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  f.emit({seq:3,time:Date.now(),type:'turn/end',data:{turn:2,reason:{kind:'error',error:{code:'RESUME_FAILED'}}}});
  assert.equal((await f.state()).queue.length,0);
  w.db(s=>assert.equal(s.getMetadata('watchedSessions')[w.session.id].pending.length,1));
  f.emit({seq:4,time:Date.now(),type:'user/message',data:{id:'correction-cont',taskId:'original-task',role:'user',source:{kind:'plugin:jiupian-continuation'},content:[{type:'text',text:'继续原任务'}]}});
  f.emit(end(5,3));await until(async()=> (await f.state()).queue.some(j=>j.status==='done'));
  assert.deepEqual(f.inputs[0].sources.map(s=>s.eventSeq),[1]);
});

test('an unrelated review continuation cannot authorize correction-paused memory extraction',async t=>{
  const w=workspace(t),f=await launch(w);t.after(()=>f.stop());
  const original=user(1);original.data.taskId='same-task';f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  f.emit({seq:3,time:Date.now(),type:'user/message',data:{id:'review-cont',taskId:'same-task',role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续原任务'}]}});
  f.emit(end(4,2));assert.equal((await f.state()).queue.length,0);
});

test('historical cross-reason continuation keeps its sources without calling the removed service',async t=>{
  const w=workspace(t),identity={taskId:'original-task',requestId:'correction-123',epoch:4};let calls=0;
  const guard={getCorrectionRelease(sessionId,query){calls++;assert.equal(sessionId,w.session.id);assert.deepEqual(query,{taskId:identity.taskId,requestId:identity.requestId});return {taskId:identity.taskId,requestId:identity.requestId,epoch:4,remainingOwners:['review']};}};
  let f=await launch(w,{guard});t.after(async()=>{await f?.stop();});
  const original=user(1);original.data.taskId=identity.taskId;f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'plugin:jiupian/pause',ignorable:true,data:identity});
  f.emit({seq:3,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  await f.stop();f=await launch(w,{guard});await until(()=>f.closes===1);
  f.emit({seq:4,time:Date.now(),type:'user/message',data:{id:'review-cont',taskId:identity.taskId,role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续原任务'}]}});
  f.emit(end(5,2));assert.equal((await f.state()).queue.length,0);
  assert.equal(calls,0);w.db(s=>assert.deepEqual(s.getMetadata('watchedSessions')[w.session.id].pending.map(source=>source.eventSeq),[1]));
});

test('historical cross-reason continuation without an identity record keeps its sources',async t=>{
  const w=workspace(t),f=await launch(w);t.after(()=>f.stop());const original=user(1);original.data.taskId='original-task';f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  f.emit({seq:3,time:Date.now(),type:'user/message',data:{id:'review-cont',taskId:'original-task',role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续原任务'}]}});
  f.emit(end(4,2));assert.equal((await f.state()).queue.length,0);
  w.db(s=>assert.equal(s.getMetadata('watchedSessions')[w.session.id].pending.length,1));
});

test('deferred historical cross-reason sources remain after restart',async t=>{
  const w=workspace(t),identity={taskId:'original-task',requestId:'correction-late',epoch:7};
  let f=await launch(w);t.after(async()=>{await f?.stop();});
  const original=user(1);original.data.taskId=identity.taskId;f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'plugin:jiupian/pause',ignorable:true,data:identity});
  f.emit({seq:3,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  const continuation={seq:4,time:Date.now(),type:'user/message',data:{id:'review-cont',taskId:identity.taskId,role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续原任务'}]}};
  f.emit(continuation);f.emit(continuation);const completed=end(5,2);f.emit(completed);f.emit(completed);
  assert.equal((await f.state()).queue.length,0);w.db(s=>assert.equal(s.getMetadata('watchedSessions')[w.session.id].pending.length,1));
  await f.stop();f=await launch(w);
  await until(()=>f.closes===1);
  assert.equal((await f.state()).queue.length,0);w.db(s=>assert.deepEqual(s.getMetadata('watchedSessions')[w.session.id].pending.map(source=>source.eventSeq),[1]));
});

test('a fresh different task cannot inherit sources from a deferred cross-reason continuation',async t=>{
  const w=workspace(t),identity={taskId:'original-task',requestId:'correction-new',epoch:7};
  const f=await launch(w);t.after(()=>f.stop());const original=user(1);original.data.taskId=identity.taskId;f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'plugin:jiupian/pause',ignorable:true,data:identity});
  f.emit({seq:3,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  f.emit({seq:4,time:Date.now(),type:'user/message',data:{id:'review-cont',taskId:identity.taskId,role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续原任务'}]}});
  f.emit(end(5,2));const next=user(6,'新任务的长期偏好');next.data.taskId='new-task';f.emit(next);f.emit(end(7,3));
  await until(async()=> (await f.state()).queue.some(j=>j.status==='done'));
  assert.equal((await f.state()).queue.length,1);assert.deepEqual(f.inputs[0].sources.map(s=>s.eventSeq),[6]);
  w.db(s=>assert.deepEqual(s.getMetadata(`retainedPausedSources:${w.session.id}:6`).sources.map(source=>source.eventSeq),[1]));
});

test('a different task continuation invalidates the earlier deferred completion candidate',async t=>{
  const w=workspace(t),identity={taskId:'original-task',requestId:'correction-switch',epoch:7};
  const f=await launch(w);t.after(()=>f.stop());const original=user(1);original.data.taskId=identity.taskId;f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'plugin:jiupian/pause',ignorable:true,data:identity});
  f.emit({seq:3,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  const cont=(seq,taskId)=>({seq,time:Date.now(),type:'user/message',data:{id:`review-${seq}`,taskId,role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续'}]}});
  f.emit(cont(4,identity.taskId));f.emit(cont(5,'other-task'));f.emit(end(6,2));
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal((await f.state()).queue.length,0);
  w.db(s=>{const watch=s.getMetadata('watchedSessions')[w.session.id];assert.equal(watch.pending.length,1);assert.equal(watch.crossContinuation,undefined);});
});

test('repeated historical cross-reason continuations remain pending',async t=>{
  const w=workspace(t),identity={taskId:'original-task',requestId:'correction-again',epoch:7};
  const f=await launch(w);t.after(()=>f.stop());const original=user(1);original.data.taskId=identity.taskId;f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'plugin:jiupian/pause',ignorable:true,data:identity});
  f.emit({seq:3,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_CORRECTION_PAUSED'}}}});
  const cont=seq=>({seq,time:Date.now(),type:'user/message',data:{id:`review-${seq}`,taskId:identity.taskId,role:'user',source:{kind:'chengben-review'},content:[{type:'text',text:'继续'}]}});
  f.emit(cont(4));f.emit(end(5,2));f.emit(cont(6));
  await new Promise(resolve=>setTimeout(resolve,2200));assert.equal((await f.state()).queue.length,0,'old completed turn must not authorize extraction during the new turn');
  f.emit(end(7,3));assert.equal((await f.state()).queue.length,0);
  w.db(s=>assert.deepEqual(s.getMetadata('watchedSessions')[w.session.id].pending.map(source=>source.eventSeq),[1]));
});

test('a new task cannot inherit sources from a paused review, and ordinary errors still discard sources',async t=>{
  const w=workspace(t),f=await launch(w);t.after(()=>f.stop());
  const old=user(1,'旧任务的长期偏好');old.data.taskId='old-task';f.emit(old);
  f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_REVIEW_PAUSED'}}}});
  const next=user(3,'新任务的长期偏好');next.data.taskId='new-task';f.emit(next);f.emit(end(4,2));
  await until(async()=> (await f.state()).queue.some(j=>j.status==='done'));
  assert.deepEqual(f.inputs[0].sources.map(s=>s.eventSeq),[3]);
  w.db(s=>assert.deepEqual(s.getMetadata(`retainedPausedSources:${w.session.id}:3`).sources.map(source=>source.eventSeq),[1]));
  const failed=user(5,'失败任务的长期偏好');failed.data.taskId='failed-task';f.emit(failed);
  f.emit({seq:6,time:Date.now(),type:'turn/end',data:{turn:3,reason:{kind:'error',error:{code:'OTHER'}}}});
  w.db(s=>assert.deepEqual(s.getMetadata('watchedSessions')[w.session.id].pending,[]));
  assert.equal((await f.state()).queue.length,1);
});

test('a failed historical review retry retains the paused sources separately',async t=>{
  const w=workspace(t),f=await launch(w);t.after(()=>f.stop());
  const original=user(1);original.data.taskId='old-task';f.emit(original);
  f.emit({seq:2,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TASK_REVIEW_PAUSED'}}}});
  f.emit({seq:3,time:Date.now(),type:'turn/end',data:{turn:2,reason:{kind:'error',error:{code:'OTHER'}}}});
  w.db(s=>assert.deepEqual(s.getMetadata(`retainedPausedSources:${w.session.id}:3`).sources.map(source=>source.eventSeq),[1]));
  assert.equal((await f.state()).queue.length,0);
});

test('watch metadata failure rolls back queue and recovers duplicate end-event exactly once',async t=>{
  const w=workspace(t);let f;
  const original=MemoryStore.prototype.setMetadata;
  let throwOnce=false,throws=0;
  MemoryStore.prototype.setMetadata=function(key,value){
    if(key==='watchedSessions' && throwOnce){throwOnce=false;throws++;throw new Error('INJECTED_ONCE_WATCH_WRITE');}
    return original.call(this,key,value);
  };
  t.after(async()=>{MemoryStore.prototype.setMetadata=original;await f?.stop();});
  f=await launch(w);
  f.emit(user(1));
  assert.equal(w.db(s=>s.getMetadata('watchedSessions')[w.session.id].pending.length),1);
  throwOnce=true;
  const completed=end(2);f.emit(completed);
  assert.equal(throws,1);
  w.db(s=>{
    assert.equal(s.listJobs().length,0,'Failed watch write must roll back its queue insertion');
    assert.equal(s.getMetadata('watchedSessions')[w.session.id].cursor,2);
    assert.equal(s.getMetadata('watchedSessions')[w.session.id].pending.length,1);
  });
  f.emit(completed); // Buffered live replay overlaps the persisted recovery suffix.
  const settled=await until(async()=>{const state=await f.state();return state.queue.length===1&&state.queue[0].status==='done'&&state;});
  assert.equal(settled.queue.length,1);
  assert.equal(f.inputs.length,1);
  assert.deepEqual(f.inputs[0].sources.map(s=>s.eventSeq),[1]);
  assert.match(settled.failure?.error ?? '',/INJECTED_ONCE_WATCH_WRITE/);
  w.db(s=>{
    const watch=s.getMetadata('watchedSessions')[w.session.id];
    assert.equal(watch.cursor,3);assert.deepEqual(watch.pending,[]);
  });
  await f.stop();
});

test('startup recovery barrier preserves durable prefix before buffered live seq20',async t=>{
  const w=workspace(t),gate=deferred(),started=deferred();let f;
  t.after(async()=>{gate.resolve({events:[]});await f?.stop();});
  const base=Date.now()-1000;
  w.events.push(user(10,'我长期偏好中文回复。',base+100),end(11,1,base+200));
  w.db(s=>{
    const project=s.resolveProject({cwd:w.session.header.cwd});
    s.setMetadata('enabledAt',new Date(base).toISOString());
    s.setMetadata('watchedSessions',{[w.session.id]:{cursor:10,pending:[],projectId:project.id}});
  });
  f=await launch(w,{read:async from=>{assert.equal(from,10);started.resolve();return gate.promise;}});
  await started.promise;
  f.emit(user(20,'我长期偏好简洁报告。',base+300));
  assert.equal(w.db(s=>s.getMetadata('watchedSessions')[w.session.id].cursor),10);
  gate.resolve({events:[...w.events]}); // seq20 is in both persisted suffix and live buffer.
  await until(async()=>{const state=await f.state();return state.queue.some(j=>j.eventSeq===11&&j.status==='done');});
  assert.equal(f.inputs.length,1);
  assert.deepEqual(f.inputs[0].sources.map(s=>s.eventSeq),[10]);
  w.db(s=>{
    const watch=s.getMetadata('watchedSessions')[w.session.id];
    assert.equal(watch.cursor,21);assert.deepEqual(watch.pending.map(s=>s.eventSeq),[20]);
  });
  f.emit(end(21,2,base+400));
  await until(async()=>{const state=await f.state();return state.queue.length===2&&state.queue.every(j=>j.status==='done');});
  assert.deepEqual(f.inputs.map(p=>p.sources.map(s=>s.eventSeq)),[[10],[20]]);
  assert.equal(f.opens,1);assert.equal(f.closes,1);
  await f.stop();
});

test('closing Host aborts an active extraction and releases its lease before SQLite closes',async t=>{
  const w=workspace(t);let f;
  t.after(async()=>{await f?.stop();});
  f=await launch(w,{beforeExtraction:request=>new Promise((_,reject)=>{
    const abort=()=>reject(new Error('Fixture extraction aborted'));
    if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});
  })});
  f.emit(user(1));f.emit(end(2));
  await until(()=>f.inputs.length===1);
  w.db(s=>assert.equal(s.listJobs()[0].state,'running'));
  await f.stop();
  w.db(s=>{
    const job=s.listJobs()[0];
    assert.equal(job.state,'pending');assert.equal(job.token,null);assert.equal(job.leaseUntil,null);
    assert.equal(job.attempts,1);assert.match(job.lastError,/取消|aborted/i);
    assert.equal(s.getStatus().memories,0);
  });
  f=await launch(w);
  await until(async()=>{const state=await f.state();return state.queue.length===1&&state.queue[0].status==='done';});
  assert.equal(f.inputs.length,1);
  w.db(s=>assert.equal(s.listJobs()[0].attempts,2));
  await f.stop();
});

test('real SQLite restart restores pending watch and pending queue with real local vectors once',async t=>{
  const w=workspace(t);let f;
  t.after(async()=>{await f?.stop();});
  f=await launch(w,{extractMemories:true});
  const statement=user(1);f.emit(statement);
  await f.stop();
  const sourceTime=new Date(statement.time).toISOString();
  w.db(s=>{
    const watch=s.getMetadata('watchedSessions')[w.session.id];
    assert.equal(watch.cursor,2);assert.deepEqual(watch.pending.map(s=>s.eventSeq),[1]);
    s.enqueueEvent({sessionId:'already-enqueued-new-session',eventId:'turn-end:6',eventSeq:6,eventTime:sourceTime,projectId:watch.projectId,
      payload:{sessionId:'already-enqueued-new-session',projectId:watch.projectId,projectNames:['ProjectA'],sources:[{sessionId:'already-enqueued-new-session',eventId:'5',eventSeq:5,eventTime:sourceTime,quote:'我长期偏好简洁报告。'}]}});
    assert.equal(s.getStatus().queue.pending,1);
  });
  w.events.push(end(2)); // Durable turn/end occurred after the first Host stopped.
  f=await launch(w,{extractMemories:true});
  const recovered=await until(async()=>{const state=await f.state();return state.queue.length===2&&state.queue.every(j=>j.status==='done')&&state;},40000);
  assert.equal(f.inputs.length,2);
  assert.equal(recovered.memories.length,2);
  assert.equal(recovered.counts.vectors,2);
  w.db(s=>{
    const rows=s.listAllMemories();assert.equal(rows.length,2);
    assert.ok(rows.every(m=>m.embedding.length===384&&m.embeddingVersion&&m.version===1));
    assert.equal(s.getMetadata('watchedSessions')[w.session.id].cursor,3);
    assert.deepEqual(s.getMetadata('watchedSessions')[w.session.id].pending,[]);
  });
  await f.stop();
  f=await launch(w,{extractMemories:true});
  await until(()=>f.closes===1);
  const replayed=await f.state();
  assert.equal(replayed.queue.length,2);assert.ok(replayed.queue.every(j=>j.status==='done'));
  assert.equal(replayed.memories.length,2);assert.equal(f.inputs.length,0);
  await f.stop();
});
