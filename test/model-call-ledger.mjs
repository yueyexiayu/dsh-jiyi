// Optional regression-only observer. It never imports a model or opens a Host.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const target=process.env.JIYI_TEST_MODEL_LEDGER;
if(target){
  const evidence=resolve(dirname(fileURLToPath(import.meta.url)),'../evidence');
  const path=resolve(target);
  // Version-agnostic so a new version's regression run does not need this guard edited again;
  // it still requires a brand-new file directly inside evidence/.
  if(dirname(path)!==evidence||!/^reliability-v\d{3,}-[a-z0-9-]+\.jsonl$/.test(basename(path)))throw new Error('Regression model ledger must be a new reliability-vNNN evidence JSONL under evidence/.');
  try{writeFileSync(path,'',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const record=event=>appendFileSync(path,JSON.stringify({at:new Date().toISOString(),parentPid:process.pid,...event})+'\n');
  const fork=childProcess.fork;
  childProcess.fork=function(modulePath,args,options){
    const isEmbedding=String(modulePath).endsWith('/jiyi/lib/models.js')&&args?.includes('--jiyi-embedding-child');
    const child=fork.call(this,modulePath,args,options);
    if(isEmbedding){
      record({type:'embedding-spawn',pid:child.pid});
      child.once('close',(exitCode,signal)=>record({type:'embedding-close',pid:child.pid,exitCode,signal}));
    }
    return child;
  };
  syncBuiltinESMExports();
}
