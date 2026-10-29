import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/store.js';
import { VERSION } from '../lib/index.js';
import { createEvaluationIpc } from '../lib/eval-ipc.js';
import { databaseSnapshot } from '../lib/eval-integrity.js';

test('CLI uses package version and rejects mismatched discovery and Host identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ji-cli-version-'));
  let close, runs=0;
  const cli=(...args)=>new Promise(resolve=>execFile('/usr/local/bin/node',[join(import.meta.dirname,'../scripts/evaluate.mjs'),...args],(error,stdout,stderr)=>resolve({exit:error?.code??0,stdout,stderr})));
  try {
    const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
    assert.equal(VERSION,packageVersion);
    assert.match((await cli('--help')).stdout,new RegExp(`jiyi ${packageVersion.replaceAll('.', '\\.')}`));
    close=await createEvaluationIpc({dataDir:dir,version:VERSION,runtime:{pid:process.pid,loadedAt:'fixture-host'},run:async()=>{runs++;return {ok:false};}});
    const receiptPath=join(dir,'eval-endpoint.json'),receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
    const status=await cli('--status','--data-dir',dir);
    assert.equal(status.exit,0,status.stderr);assert.equal(JSON.parse(status.stdout).version,packageVersion);
    for(const [change,expected] of [
      [{version:VERSION+'-different'},/Host 版本\/IPC路径不匹配/],
      [{socketPath:join(dir,'wrong.sock')},/Host 版本\/IPC路径不匹配/],
      [{loadedAt:'different-start'},/实际 Host 与 discovery receipt 不一致/],
    ]) {
      writeFileSync(receiptPath,JSON.stringify({...receipt,...change}));
      const result=await cli('--run','--input','fixture.json','--data-dir',dir);
      assert.equal(result.exit,1);assert.match(result.stderr,expected);assert.equal(runs,0);
    }
    writeFileSync(receiptPath,JSON.stringify(receipt));
    await close();close=null;
    close=await createEvaluationIpc({dataDir:dir,version:VERSION+'-different',runtime:{pid:process.pid,loadedAt:'fixture-host'},run:async()=>{runs++;}});
    writeFileSync(receiptPath,JSON.stringify(receipt));
    const result=await cli('--run','--input','fixture.json','--data-dir',dir);
    assert.equal(result.exit,1);assert.match(result.stderr,/实际 Host 与 discovery receipt 不一致/);assert.equal(runs,0);
  } finally {
    if(close)await close();
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:false});
  }
});

// Deliberately deceptive fixture Host: reports a true *old* proof then changes
// its own temporary database with an evaluation id before replying. CLI must catch it.
for(const mutation of ['metadata','missing-settings']) test(`CLI rejects successful Host proof with post-return ${mutation}`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ji-cli-audit-'));
  const root=resolve(import.meta.dirname,'../evidence/eval-runs');mkdirSync(root,{recursive:true});
  const runDir=mkdtempSync(join(root,'cli-post-return-fixture-'));
  const database=join(dir,'memory.sqlite'),settings=join(dir,'settings.json');
  const store=new MemoryStore(database);writeFileSync(settings,'{"enabled":true}');
  const settingsSha256=createHash('sha256').update(readFileSync(settings)).digest('hex');
  let close,afterMutation;
  try {
    const baseline=databaseSnapshot(database);
    close=await createEvaluationIpc({dataDir:dir,version:VERSION,runtime:{pid:process.pid,loadedAt:'fixture-host'},run:async()=>{
      if(mutation==='metadata') store.setMetadata('injected:jiyi-eval-cli-fixture-session',{actualWrite:true});
      else {assert.equal(settings,join(dir,'settings.json'));rmSync(settings);}
      afterMutation=databaseSnapshot(database);
      return {ok:true,qualityPassed:true,status:'completed',runDir,integrity:{unchanged:true,passed:true,evaluationPrefix:'jiyi-eval-cli-fixture-',before:baseline,after:baseline,settingsBefore:settingsSha256,settingsAfter:settingsSha256},error:null};
    }});
    const response=await new Promise(resolve=>{
      execFile('/usr/local/bin/node',[join(import.meta.dirname,'../scripts/evaluate.mjs'),'--run','--input','fixture-not-read.json','--data-dir',dir],{maxBuffer:2*1024*1024},(error,stdout,stderr)=>resolve({exit:error?.code??0,stdout,stderr}));
    });
    assert.equal(response.exit,1,response.stderr);
    const result=JSON.parse(response.stdout);
    assert.equal(result.ok,false);assert.equal(result.hostStatus,'completed');assert.equal(result.status,'integrity-failed-after-return');
    assert.equal(result.error.code,'EVAL_POST_RETURN_INTEGRITY');
    assert.equal(result.postReturnIntegrity.unchanged,false);
    const audit=JSON.parse(readFileSync(result.postReturnAuditPath,'utf8'));
    assert.equal(audit.unchanged,false);
    if(mutation==='metadata') {
      assert.equal(audit.after.tables.metadata,audit.hostAfter.tables.metadata+1);
      assert.notEqual(audit.after.walSha256,audit.hostAfter.walSha256);
    } else assert.equal(audit.error.code,'ENOENT');
    assert.deepEqual(databaseSnapshot(database),afterMutation,'CLI must not mutate or repair its source');
  } finally {
    if(close)await close();store.close();
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:false});
    assert.equal(dirname(resolve(runDir)),root);rmSync(runDir,{recursive:true,force:false});
  }
});
