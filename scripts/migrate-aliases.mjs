#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryStore, planProjectAliasBackfill } from '../lib/store.js';
import { databaseSnapshot } from '../lib/eval-integrity.js';

// Explicit two-phase, additive-only migration. --plan is entirely read-only.
try {
  const args=process.argv.slice(2),options={};let mode;
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(key==='--plan'||key==='--apply') {if(mode)throw Error('仅可选择一个模式');mode=key;continue;}
    if(!['--database','--preview','--backup','--output'].includes(key)||!args[i+1]||args[i+1].startsWith('--'))throw Error(`无效参数 ${key}`);
    options[key.slice(2)]=resolve(args[++i]);
  }
  if(!mode||!options.database||!options.output) throw Error('用法：--plan --database <memory.sqlite> --output <新预览.json>；--apply 另需 --preview <预览.json> --backup <新备份.sqlite>');
  if(existsSync(options.output))throw Error('输出文件已存在，拒绝覆盖');
  const database=realpathSync(options.database);
  if(mode==='--plan') {
    const db=new DatabaseSync(database,{readOnly:true});
    let plan;try {plan=planProjectAliasBackfill(db);}finally{db.close();}
    const result={database,plannedAt:new Date().toISOString(),plan};
    writeFileSync(options.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify(result,null,2));
  } else {
    if(!options.preview||!options.backup)throw Error('--apply 必须指定 --preview 和 --backup');
    const preview=JSON.parse(readFileSync(options.preview,'utf8'));
    if(preview.database!==database)throw Error('预览不是此数据库');
    if(existsSync(options.backup))throw Error('备份文件已存在，拒绝覆盖');
    const readonly=new DatabaseSync(database,{readOnly:true});
    try {
      if(JSON.stringify(planProjectAliasBackfill(readonly))!==JSON.stringify(preview.plan))throw Error('别名预览已变化，请重新预览');
      readonly.prepare('VACUUM INTO ?').run(options.backup);
    } finally {readonly.close();}
    chmodSync(options.backup,0o600);
    const backupCheck=new DatabaseSync(options.backup,{readOnly:true});
    try {if(backupCheck.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('备份 integrity_check 失败，不迁移');}finally{backupCheck.close();}
    const before=databaseSnapshot(database),store=new MemoryStore(database);
    let migration,aliasesBefore,aliasesAfter;
    try {
      aliasesBefore=store.db.prepare('SELECT alias,project_id FROM project_aliases ORDER BY alias').all();
      migration=store.applyProjectAliasBackfill(preview.plan);
      aliasesAfter=store.db.prepare('SELECT alias,project_id FROM project_aliases ORDER BY alias').all();
      if(aliasesBefore.some(a=>!aliasesAfter.some(b=>a.alias===b.alias&&a.project_id===b.project_id)))throw Error('原有别名丢失：迁移验收失败');
    } finally {store.close();}
    const result={ok:true,database,appliedAt:new Date().toISOString(),backup:options.backup,backupMethod:'VACUUM INTO via readOnly DatabaseSync',preview:options.preview,...migration,aliasesBefore,aliasesAfter,before,after:databaseSnapshot(database)};
    writeFileSync(options.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({ok:result.ok,backup:result.backup,backupMethod:result.backupMethod,added:result.added,removed:result.removed,conflicts:result.conflicts,output:options.output},null,2));
  }
} catch(e) {console.error(`jiyi alias migration failed: ${e.message}`);process.exitCode=1;}
