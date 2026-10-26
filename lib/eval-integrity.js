import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// Only WAL is optional; a missing main database/settings file must remain an error.
export const fileHash = (path,optional=false) => optional&&!existsSync(path) ? null : createHash('sha256').update(readFileSync(path)).digest('hex');

// Shared read-only evidence primitive; no Store, queue, model or checkpoint.
// The main file alone misses uncheckpointed writes, so compare WAL and every table too.
export function databaseSnapshot(filename, {allowConcurrentWrites=false} = {}) {
  const path=realpathSync(filename), db=new DatabaseSync(path,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const before={sha256:fileHash(path),walSha256:fileHash(`${path}-wal`,true)};
    const tables={};
    for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()) {
      tables[name]=db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"','""')}"`).get().n;
    }
    const logical=logicalSnapshot(db);
    const after={sha256:fileHash(path),walSha256:fileHash(`${path}-wal`,true)};
    const filesStable=isDeepStrictEqual(before,after);
    if(!filesStable&&!allowConcurrentWrites) throw Object.assign(new Error('只读取证期间正式库发生变化'),{code:'EVAL_SOURCE_CHANGED'});
    return {path,...after,tables,logical,filesStable};
  } finally {db.close();}
}
export const sameDatabase = (before,after) => isDeepStrictEqual(before,after);

// Logical row fingerprints permit concurrent, attributable production writes.
// No memory text, query or source quote is copied into the audit.
function auditRows(db,name) {
  const quoted=`"${name.replaceAll('"','""')}"`;
  const pk=db.prepare(`PRAGMA table_info(${quoted})`).all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
  return db.prepare(`SELECT ${pk.length?'':'rowid AS __audit_rowid__,'}* FROM ${quoted}`).all().map(row=>{
    const key=JSON.stringify(pk.length?pk.map(k=>row[k]):[row.__audit_rowid__]);
    const {__audit_rowid__,...value}=row;
    return {key,value};
  });
}
export function logicalSnapshot(db, selectedTables = null) {
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const tables={};
  for(const {name} of schema.filter(r=>r.type==='table' && (selectedTables===null || selectedTables.has(r.name)))) {
    tables[name]=Object.fromEntries(auditRows(db,name).map(({key,value})=>[key,createHash('sha256').update(JSON.stringify(value)).digest('hex')]));
  }
  return {schemaSha256:createHash('sha256').update(JSON.stringify(schema)).digest('hex'),tables};
}
export function rowChanges(before,after) {
  const changes=[];
  for(const table of new Set([...Object.keys(before.tables),...Object.keys(after.tables)])) {
    const a=before.tables[table]??{},b=after.tables[table]??{};
    for(const key of new Set([...Object.keys(a),...Object.keys(b)])) if(a[key]!==b[key]) changes.push({table,key,before:a[key]??null,after:b[key]??null});
  }
  return changes;
}
export function verifyWriteAudit(before,after,audit,evaluationPrefix) {
  const replay=structuredClone(before.logical);
  const errors=[];
  if(replay.schemaSha256!==after.logical.schemaSha256) errors.push('schema changed');
  for(const entry of audit??[]) {
    if(entry.source?.connection!=='production-host') errors.push('untrusted write source');
    if(JSON.stringify(entry.source).includes(evaluationPrefix)) errors.push('evaluation write source in production');
    for(const c of entry.changes) {
      const table=replay.tables[c.table];
      if(!table || (table[c.key]??null)!==c.before) {errors.push(`unattributed write: ${c.table}:${c.key}`);continue;}
      if(c.after===null) delete table[c.key]; else table[c.key]=c.after;
    }
  }
  if(!isDeepStrictEqual(replay,after.logical)) errors.push('logical changes not fully explained by production audit');
  return {passed:errors.length===0,errors,writeCount:audit?.length??0};
}
export function evaluationSessionLeaks(filename,prefix) {
  const db=new DatabaseSync(realpathSync(filename),{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const leaks=[];
    for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()) {
      for(const {key,value} of auditRows(db,name)) if(Object.values(value).some(v=>typeof v==='string'&&v.includes(prefix))) leaks.push({table:name,key});
    }
    return leaks;
  } finally {db.close();}
}

// Executed by the CLI process only after it has received the Host's reply.
// This is an additional boundary, not a substitute for the Host's cleanup proof.
export function auditEvaluationReturn({sourceDatabase,settingsPath,expected}) {
  const after=databaseSnapshot(sourceDatabase,{allowConcurrentWrites:true}),settingsAfter=fileHash(settingsPath);
  if(typeof expected.evaluationPrefix!=='string'||!expected.evaluationPrefix.startsWith('jiyi-eval-')) throw Object.assign(new Error('Host 完整性证明缺少评测会话前缀'),{code:'EVAL_MISSING_PROOF'});
  const leaks=evaluationSessionLeaks(sourceDatabase,expected.evaluationPrefix);
  const unchanged=expected.unchanged===true&&sameDatabase(expected.before,expected.after)&&sameDatabase(expected.after,after)&&expected.settingsBefore===settingsAfter;
  const passed=expected.passed===true&&leaks.length===0;
  return {schemaVersion:2,at:new Date().toISOString(),window:'cli-after-host-reply',
    before:expected.before,hostAfter:expected.after,after,settingsBefore:expected.settingsBefore,settingsAfter,
    unchanged,passed,evaluationSessionLeaks:leaks,
    note:'Host窗口逐写审计；返回后仅独立检查评测会话污染，正常并行写入和配置变化不作污染结论。'};
}
