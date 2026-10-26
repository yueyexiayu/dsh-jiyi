// Synthetic only. Compare the caller-supplied frozen 0.1.11 against this tree.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryStore } from '../lib/store.js';
import { databaseSnapshot, verifyWriteAudit } from '../lib/eval-integrity.js';
const [baselineDir,output]=process.argv.slice(2);
if(!baselineDir||!output)throw new Error('Usage: node scripts/benchmark-audit.mjs BASELINE_PLUGIN NEW_OUTPUT_JSON');
const {MemoryStore:BaselineStore}=await import(pathToFileURL(join(resolve(baselineDir),'lib/store.js')));
const dir=mkdtempSync(join(tmpdir(),'jiyi-audit-bench-'));
const count=5000,rounds=30,warmup=5,results=[];
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
try {
  const template=join(dir,'template.sqlite'),seed=new MemoryStore(template);
  const insert=seed.db.prepare('INSERT INTO memories VALUES(?,1,?,\'global\',NULL,\'fact\',NULL,1,\'active\',?,?,?,NULL,NULL,NULL)');
  const version=seed.db.prepare('INSERT INTO memory_versions VALUES(?,1,?)');
  const vector=seed.db.prepare('INSERT INTO vectors VALUES(?,1,?,384,?,?)');
  const fts=seed.db.prepare('INSERT INTO memory_fts(memory_id,content) VALUES(?,?)');
  const embedding=JSON.stringify(Array.from({length:384},(_,i)=>i===0?1:0));
  seed.transaction(()=>{
    for(let i=0;i<count;i++) {
      const id=`synthetic-${i}`,content=`合成记忆 ${i}：项目使用整数分表示金额，审计基准没有真实用户数据。`,stamp='2026-10-25T00:00:00Z';
      insert.run(id,content,'[]',stamp,stamp);version.run(id,JSON.stringify({id,version:1,content}));
      vector.run(id,'synthetic-model',embedding,'synthetic-v1');fts.run(id,content);
    }
  });seed.setMetadata('bench-write',-1);seed.close();
  for(const [label,Store] of [['0.1.11',BaselineStore],['0.1.12',MemoryStore]]) {
    const path=join(dir,`${label}.sqlite`),src=new DatabaseSync(template,{readOnly:true});
    src.prepare('VACUUM INTO ?').run(path);src.close();const store=new Store(path);
    try {
      const plain=[],audited=[];
      for(let i=-warmup;i<rounds;i++) {
        const t=performance.now();store.setMetadata('bench-write',i);if(i>=0)plain.push(performance.now()-t);
      }
      const before=databaseSnapshot(path);store.beginWriteAudit();
      store.withWriteSource({kind:'synthetic-benchmark',sessionId:'synthetic-real'},()=>{
        for(let i=-warmup;i<rounds;i++) {
          const t=performance.now();store.setMetadata('bench-write',{iteration:i});if(i>=0)audited.push(performance.now()-t);
        }
      });
      const writes=store.endWriteAudit(),proof=verifyWriteAudit(before,databaseSnapshot(path),writes,'jiyi-eval-benchmark');
      if(!proof.passed)throw new Error(JSON.stringify(proof));
      results.push({version:label,plainMs:{median:percentile(plain,.5),p95:percentile(plain,.95)},auditedMs:{median:percentile(audited,.5),p95:percentile(audited,.95)},auditOverheadMedianMs:percentile(audited,.5)-percentile(plain,.5),plainSamplesMs:plain,auditedSamplesMs:audited,proof});
    } finally {store.close();}
  }
  const report={at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,baseline:resolve(baselineDir),memories:count,vectors:count,memoryVersions:count,ftsRows:count,rounds,warmup,operation:'single production metadata UPSERT, same key; excludes begin/end audit and evaluation boundary full snapshots',results,speedup:results[0].auditOverheadMedianMs/results[1].auditOverheadMedianMs};
  writeFileSync(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report,null,2));
} finally {rmSync(dir,{recursive:true,force:true});}
