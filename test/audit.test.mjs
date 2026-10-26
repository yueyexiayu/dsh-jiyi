import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { databaseSnapshot, verifyWriteAudit, evaluationSessionLeaks } from '../lib/eval-integrity.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'jiyi-audit-')),path=join(dir,'memory.sqlite'),store=new MemoryStore(path);
  return {store,path,close(){if(store.writeAudit)store.endWriteAudit();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const source={sessionId:'real-user',eventSeq:1,eventTime:'2026-10-25T00:00:00Z',quote:'真实事实'};

test('metadata audit and its transaction boundaries never fingerprint unrelated memory/vector/FTS tables',()=>{
  const f=fixture();
  try {
    f.store.putMemory({id:'fact',content:'真实事实',scope:'global',sources:[source]});
    const before=databaseSnapshot(f.path),raw=f.store.db,reads=[];
    f.store.db=new Proxy(raw,{get(t,k){
      if(k==='prepare')return sql=>{if(/^SELECT .*\* FROM /u.test(sql))reads.push(sql);return t.prepare(sql);};
      return typeof t[k]==='function'?t[k].bind(t):t[k];
    }});
    f.store.beginWriteAudit();
    f.store.withWriteSource({kind:'session-event',sessionId:'real-user'},()=>f.store.transaction(()=>f.store.setMetadata('event',true)));
    const writes=f.store.endWriteAudit();
    assert.equal(writes.length,1);assert.ok(reads.length>0);
    assert.ok(reads.every(sql=>sql.endsWith('FROM "metadata"')),JSON.stringify(reads));
    assert.equal(typeof writes[0].elapsedMs,'number');assert.ok(Number.isFinite(writes[0].elapsedMs)&&writes[0].elapsedMs>=0);
    assert.deepEqual(writes[0].tables,['metadata']);
    assert.equal(writes[0].source.connection,'production-host');
    assert.equal(writes[0].source.kind,'session-event');
    assert.equal(writes[0].source.sessionId,'real-user');
    assert.equal(verifyWriteAudit(before,databaseSnapshot(f.path),writes,'jiyi-eval-test').passed,true);
  } finally {f.close();}
});

test('scoped audit covers FTS shadow rows, nested rollbacks, trigger writes and RETURNING methods',()=>{
  const f=fixture();
  try {
    f.store.db.exec(`CREATE TABLE side(id TEXT PRIMARY KEY,value TEXT);
      CREATE TRIGGER metadata_side AFTER INSERT ON metadata BEGIN INSERT INTO side VALUES(new.key,new.value); END;`);
    const before=databaseSnapshot(f.path);
    f.store.beginWriteAudit();
    f.store.withWriteSource({kind:'session-event',sessionId:'real-user'},()=>{
      f.store.transaction(()=>{
        f.store.putMemory({id:'fact',content:'真实事实使用中文',scope:'global',sources:[source]});
        assert.throws(()=>f.store.transaction(()=>{f.store.setMetadata('undo',true);throw new Error('undo');}),/undo/);
        f.store.db.prepare('INSERT INTO metadata VALUES(?,?,?) RETURNING key').get('get','1','now');
        f.store.db.prepare('INSERT INTO metadata VALUES(?,?,?) RETURNING key').all('all','1','now');
        assert.equal([...f.store.db.prepare('INSERT INTO metadata VALUES(?,?,?) RETURNING key').iterate('iter','1','now')].length,1);
      });
      assert.throws(()=>f.store.transaction(()=>{f.store.deleteMemory('fact');throw new Error('undo');}),/undo/);
    });
    const writes=f.store.endWriteAudit(),proof=verifyWriteAudit(before,databaseSnapshot(f.path),writes,'jiyi-eval-test');
    assert.equal(proof.passed,true,JSON.stringify(proof));
    assert.ok(writes.every(w=>Number.isFinite(w.elapsedMs)&&w.elapsedMs>=0&&Array.isArray(w.tables)));
    assert.ok(writes.some(w=>w.tables.some(t=>t.startsWith('memory_fts_'))));
    assert.ok(writes.some(w=>w.changes.some(c=>c.table.startsWith('memory_fts_'))));
    assert.ok(writes.some(w=>w.changes.some(c=>c.table==='side')));
    assert.equal(f.store.getMetadata('undo'),null);
    assert.deepEqual(evaluationSessionLeaks(f.path,'jiyi-eval-test'),[]);
  } finally {f.close();}
});

test('a multi-statement exec starting with ROLLBACK still audits writes to previously untouched tables',()=>{
  const f=fixture();
  try {
    const before=databaseSnapshot(f.path);f.store.beginWriteAudit();
    f.store.withWriteSource({kind:'session-event',sessionId:'real-user'},()=>{
      f.store.db.exec('BEGIN');f.store.setMetadata('temporary',true);
      f.store.db.exec("ROLLBACK; INSERT INTO projects VALUES('new-project','/tmp/new-project','new-project','now');");
    });
    const writes=f.store.endWriteAudit(),proof=verifyWriteAudit(before,databaseSnapshot(f.path),writes,'jiyi-eval-test');
    assert.equal(proof.passed,true,JSON.stringify(proof));
    assert.ok(writes.some(w=>w.changes.some(c=>c.table==='projects')));
    assert.equal(f.store.getMetadata('temporary'),null);
  } finally {f.close();}
});

test('evaluation source and session leaks still fail even for an otherwise fully explained write',()=>{
  const f=fixture();
  try {
    const before=databaseSnapshot(f.path);f.store.beginWriteAudit();
    f.store.withWriteSource({sessionId:'jiyi-eval-test-case'},()=>f.store.setMetadata('leak','jiyi-eval-test-case'));
    const writes=f.store.endWriteAudit();
    assert.equal(verifyWriteAudit(before,databaseSnapshot(f.path),writes,'jiyi-eval-test').passed,false);
    assert.equal(evaluationSessionLeaks(f.path,'jiyi-eval-test').length,1);
  } finally {f.close();}
});
