import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { resolve, isAbsolute, basename } from 'node:path';
import { logicalSnapshot, rowChanges } from './eval-integrity.js';
import { redactSensitiveText } from './redact.js';

export const SCHEMA_VERSION = 4;
export const ESSENTIAL_MEMORY_BUDGET_BYTES = 8192;
export const REVIEW_STATES = ['clear', 'pending', 'resolved'];
export const VALIDITY_KINDS = ['as_of', 'interval', 'timeless', 'unknown'];
export const VALIDITY_PRECISIONS = ['instant', 'day', 'month', 'year', 'unknown'];
export const EVIDENCE_KINDS = ['user_statement', 'tool_result', 'manual', 'unknown'];
export const RELATION_KINDS = ['supports', 'contradicts', 'corrects', 'derived_from'];
export const FEEDBACK_KINDS = ['explicit_useful', 'explicit_irrelevant', 'explicit_wrong', 'model_used', 'model_irrelevant', 'model_contradicted', 'model_stale'];
const nowISO = () => new Date().toISOString();
const bounded = (value, fallback, max = 10000) => {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid limit');
  return n;
};
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
};
function validateVector(vector) {
  if (!Array.isArray(vector) || !vector.length || vector.length > 65536 || !vector.every(Number.isFinite)) throw new Error('Invalid embedding');
  if (!vector.some(x => x !== 0)) throw new Error('Embedding must be nonzero');
  return vector;
}
function canonicalPath(value) {
  const path = resolve(required(value, 'Project path'));
  try { return realpathSync.native(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path;
  }
}
export const normalizeProjectLabel = value => value.normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
const aliasKey = value => isAbsolute(required(value, 'Alias')) ? canonicalPath(value) : value.trim();
export function planProjectAliasBackfill(db) {
  const projects=db.prepare('SELECT id,path,name FROM projects ORDER BY path').all();
  const aliases=db.prepare('SELECT alias,project_id FROM project_aliases ORDER BY alias').all();
  const additions=[],existing=[],conflicts=[];
  for(const p of projects) {
    const alias=basename(p.path);if(!alias)continue;
    const key=normalizeProjectLabel(alias),owners=aliases.filter(a=>normalizeProjectLabel(a.alias)===key);
    const peers=projects.filter(other=>normalizeProjectLabel(basename(other.path))===key&&other.id!==p.id);
    const row={projectId:p.id,projectName:p.name,path:p.path,alias};
    if(owners.some(a=>a.project_id===p.id)) existing.push(row);
    else if(owners.length||peers.length) conflicts.push({...row,otherProjectIds:[...new Set([...owners.map(a=>a.project_id),...peers.map(p=>p.id)])]});
    else additions.push(row);
  }
  return {additions,existing,conflicts};
}
const decode = value => value == null ? null : JSON.parse(value);
const staleFact = () => Object.assign(new Error('Older source cannot replace the current or deleted fact'),{code:'STALE_MEMORY_FACT'});
const sha256 = value => createHash('sha256').update(String(value ?? '')).digest('hex');
const sourceKey = source => `${source.sessionId}\u0000${source.eventId}\u0000${source.eventSeq ?? ''}`;
const oneOf = (value, allowed, label) => {
  if (!allowed.includes(value)) throw Object.assign(new Error(`${label} is invalid`), { code: 'INVALID_MEMORY_METADATA' });
  return value;
};
function evidenceKind(source) {
  const marker = String(source?.evidence ?? '').toLowerCase();
  if (source?.origin === 'manual' || marker.startsWith('manual-') || String(source?.sessionId).startsWith('jiyi-manual:')) return 'manual';
  if (marker.startsWith('tool-') || marker === 'review-changes') return 'tool_result';
  if (marker === 'user-explicit' || marker === 'user-correction') return 'user_statement';
  return 'unknown';
}
function normalizeTimeZone(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 80 || !/^(?:UTC|Etc\/[A-Za-z0-9_+-]+|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/u.test(value)) {
    throw Object.assign(new Error('timeZone must be a verified IANA name or null'), { code: 'INVALID_MEMORY_TIME' });
  }
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0)); }
  catch { throw Object.assign(new Error('timeZone must be a verified IANA name or null'), { code: 'INVALID_MEMORY_TIME' }); }
  return value;
}
function isoTimeOrNull(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw Object.assign(new Error(`${label} must be an ISO timestamp`), { code: 'INVALID_MEMORY_TIME' });
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw Object.assign(new Error(`${label} must be an ISO timestamp`), { code: 'INVALID_MEMORY_TIME' });
  return new Date(time).toISOString();
}
export function normalizeValidity(input, sources, kind) {
  const latest = newestSource(sources);
  let validityKind = input.validityKind ?? input.validity_kind ?? 'unknown';
  if (validityKind === 'unknown' && ['status', 'decision'].includes(kind) && latest) validityKind = 'as_of';
  oneOf(validityKind, VALIDITY_KINDS, 'validityKind');
  let validFrom = isoTimeOrNull(input.validFrom ?? input.valid_from, 'validFrom');
  let validTo = isoTimeOrNull(input.validTo ?? input.valid_to, 'validTo');
  let precision = input.validityPrecision ?? input.validity_precision ?? (validityKind === 'unknown' ? 'unknown' : 'instant');
  oneOf(precision, VALIDITY_PRECISIONS, 'validityPrecision');
  const timeZone = normalizeTimeZone(input.timeZone ?? input.time_zone ?? null);
  if (validityKind === 'as_of' && !validFrom && latest) validFrom = new Date(latest.time).toISOString();
  if (validityKind === 'as_of' && (!validFrom || validTo)) throw Object.assign(new Error('as_of validity requires validFrom and no validTo'), { code: 'INVALID_MEMORY_TIME' });
  if (validityKind === 'interval' && (!validFrom || validFrom && validTo && Date.parse(validTo) <= Date.parse(validFrom))) throw Object.assign(new Error('interval validity requires validFrom before validTo'), { code: 'INVALID_MEMORY_TIME' });
  if (validityKind === 'timeless' && (validFrom || validTo)) throw Object.assign(new Error('timeless validity cannot carry bounds'), { code: 'INVALID_MEMORY_TIME' });
  if (validityKind === 'unknown') { validFrom = null; validTo = null; precision = 'unknown'; }
  return { validFrom, validTo, validityKind, validityPrecision: precision, timeZone };
}
export function validityIsCurrent(memory, at = nowISO()) {
  if (!memory || memory.validityKind === 'unknown') return true;
  const time = Date.parse(at);
  const from = memory.validFrom == null ? null : Date.parse(memory.validFrom);
  const to = memory.validTo == null ? null : Date.parse(memory.validTo);
  return Number.isFinite(time) && (from == null || from <= time) && (to == null || time < to);
}
function newestSource(sources) {
  return sources.reduce((latest,source) => {
    const time = Date.parse(source.eventTime);
    if (!Number.isFinite(time)) throw new Error('Invalid source eventTime');
    if (!latest || time > latest.time || (time === latest.time && source.sessionId === latest.source.sessionId && Number.isSafeInteger(source.eventSeq) && Number.isSafeInteger(latest.source.eventSeq) && source.eventSeq > latest.source.eventSeq)) return {source,time};
    return latest;
  },null);
}
function assertFreshSources(incoming,existing) {
  const next = newestSource(incoming), old = newestSource(existing);
  if (!next || !old) return;
  if (next.time < old.time || (next.time === old.time && next.source.sessionId === old.source.sessionId && Number.isSafeInteger(next.source.eventSeq) && Number.isSafeInteger(old.source.eventSeq) && next.source.eventSeq < old.source.eventSeq)) throw staleFact();
}

/** Synchronous, local-only SQLite store. Callers create the owned data directory. */
export class MemoryStore {
  constructor(filename, { clock = nowISO, migrationFault = null } = {}) {
    this.clock = clock;
    this.depth = 0;
    this.db = new DatabaseSync(filename);
    let backupFile = null;
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Unsupported jiyi schema ${version}`);
      if (version > 0 && version < SCHEMA_VERSION) {
        backupFile = `${filename}.v${version}-backup-${Date.now()}-${randomUUID()}.sqlite`;
        this.db.exec(`VACUUM main INTO '${backupFile.replaceAll("'", "''")}'`);
        this.lastMigrationBackup = backupFile;
      }
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS project_aliases(alias TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id));
          CREATE TABLE IF NOT EXISTS memories(
            id TEXT PRIMARY KEY,version INTEGER NOT NULL,content TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('global','project')),
            project_id TEXT REFERENCES projects(id),kind TEXT NOT NULL,fact_key TEXT,confidence REAL NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),sources TEXT NOT NULL,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL,superseded_by TEXT,extraction_model TEXT,extraction_version TEXT,status_ttl_hours INTEGER,
            review_state TEXT NOT NULL DEFAULT 'clear' CHECK(review_state IN ('clear','pending','resolved')),
            valid_from TEXT,valid_to TEXT,validity_kind TEXT NOT NULL DEFAULT 'unknown',validity_precision TEXT NOT NULL DEFAULT 'unknown',
            last_confirmed_at TEXT,time_zone TEXT,
            CHECK((scope='global' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL)));
          CREATE INDEX IF NOT EXISTS memories_scope ON memories(status,scope,project_id);
          CREATE UNIQUE INDEX IF NOT EXISTS memories_active_key ON memories(scope,COALESCE(project_id,''),fact_key) WHERE status='active' AND fact_key IS NOT NULL;
          CREATE TABLE IF NOT EXISTS memory_versions(memory_id TEXT NOT NULL REFERENCES memories(id),version INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(memory_id,version));
          CREATE TABLE IF NOT EXISTS memory_selections(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            inclusion TEXT NOT NULL CHECK(inclusion IN ('essential','searchable')),
            user_controlled INTEGER NOT NULL CHECK(user_controlled IN (0,1)),revision INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS vectors(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,memory_version INTEGER NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,embedding TEXT NOT NULL,embedding_version TEXT);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED,content,tokenize='trigram');
          CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,event_id TEXT NOT NULL,event_seq INTEGER,event_time TEXT NOT NULL,
            project_id TEXT REFERENCES projects(id),payload TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed')),
            attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,available_at TEXT NOT NULL,lease_until TEXT,token TEXT,last_error TEXT,failure TEXT,attempt_history TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
            UNIQUE(session_id,event_id));
          CREATE INDEX IF NOT EXISTS queue_ready ON queue(state,available_at);
          CREATE TABLE IF NOT EXISTS cursors(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS recall_ledger(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,
            memory_refs TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,request_id));
          CREATE TABLE IF NOT EXISTS memory_evidence(
            id TEXT PRIMARY KEY,memory_id TEXT NOT NULL REFERENCES memories(id),memory_version INTEGER NOT NULL,evidence_kind TEXT NOT NULL,
            source_session_id TEXT NOT NULL,source_event_id TEXT NOT NULL,source_event_seq INTEGER,source_event_time TEXT NOT NULL,
            quote TEXT NOT NULL DEFAULT '',quote_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
            UNIQUE(memory_id,memory_version,source_session_id,source_event_id,source_event_seq,quote_sha256));
          CREATE INDEX IF NOT EXISTS memory_evidence_memory ON memory_evidence(memory_id,memory_version);
          CREATE TABLE IF NOT EXISTS memory_relations(
            id TEXT PRIMARY KEY,from_memory_id TEXT NOT NULL REFERENCES memories(id),from_memory_version INTEGER NOT NULL,
            relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','corrects','derived_from')),
            source_session_id TEXT NOT NULL,source_event_id TEXT NOT NULL,source_event_seq INTEGER,source_event_time TEXT NOT NULL,
            target_memory_id TEXT,evidence_id TEXT REFERENCES memory_evidence(id),created_at TEXT NOT NULL,
            UNIQUE(from_memory_id,from_memory_version,relation,source_session_id,source_event_id,source_event_seq,target_memory_id));
          CREATE INDEX IF NOT EXISTS memory_relations_from ON memory_relations(from_memory_id,from_memory_version);
          CREATE TABLE IF NOT EXISTS memory_decisions(
            id TEXT PRIMARY KEY,decision_type TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES memories(id),from_version INTEGER,to_version INTEGER,
            source_refs TEXT NOT NULL,algorithm_version TEXT,prompt_version TEXT,provider TEXT,model TEXT,reasoning_effort TEXT,
            config_hash TEXT,evidence_count INTEGER NOT NULL DEFAULT 0,confidence REAL,conflict_score REAL,
            outcome TEXT NOT NULL CHECK(outcome IN ('applied','held','rejected')),reason_code TEXT NOT NULL,short_reason TEXT NOT NULL,
            correlation_id TEXT NOT NULL,created_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS memory_decisions_memory ON memory_decisions(memory_id,created_at);
          CREATE TABLE IF NOT EXISTS memory_candidates(
            id TEXT PRIMARY KEY,original_memory_id TEXT REFERENCES memories(id),conflict_group_id TEXT,state TEXT NOT NULL DEFAULT 'pending'
              CHECK(state IN ('pending','applied','rejected')),payload TEXT NOT NULL,expected_version INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS memory_candidates_group ON memory_candidates(conflict_group_id,state);
          CREATE TABLE IF NOT EXISTS conflict_groups(
            id TEXT PRIMARY KEY,scope TEXT NOT NULL CHECK(scope IN ('global','project')),project_id TEXT REFERENCES projects(id),fact_key TEXT,
            state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','adjudicating','resolved','dismissed')),reason_code TEXT NOT NULL,
            provider TEXT,model TEXT,reasoning_effort TEXT,effort_source TEXT,model_policy TEXT,timeout_ms INTEGER,config_hash TEXT,
            token TEXT,lease_until TEXT,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,last_error TEXT,
            resolution TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,resolved_at TEXT,
            CHECK((scope='global' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL)));
          CREATE INDEX IF NOT EXISTS conflict_groups_ready ON conflict_groups(state,lease_until,created_at);
          CREATE UNIQUE INDEX IF NOT EXISTS conflict_groups_open_key ON conflict_groups(scope,COALESCE(project_id,''),fact_key) WHERE state IN ('open','adjudicating') AND fact_key IS NOT NULL;
          CREATE TABLE IF NOT EXISTS conflict_members(
            group_id TEXT NOT NULL REFERENCES conflict_groups(id),member_kind TEXT NOT NULL CHECK(member_kind IN ('memory','candidate')),
            member_id TEXT NOT NULL,memory_version INTEGER,role TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(group_id,member_kind,member_id));
          CREATE TABLE IF NOT EXISTS recall_feedback(
            id TEXT PRIMARY KEY,recall_ledger_id TEXT NOT NULL REFERENCES recall_ledger(id),request_id TEXT NOT NULL,session_id TEXT NOT NULL,
            memory_id TEXT NOT NULL REFERENCES memories(id),memory_version INTEGER NOT NULL,source_session_id TEXT,source_event_id TEXT,
            source_event_seq INTEGER,source_event_time TEXT,feedback_kind TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('user','model','ui')),
            confidence REAL,created_at TEXT NOT NULL,UNIQUE(recall_ledger_id,memory_id,feedback_kind,origin));
          CREATE INDEX IF NOT EXISTS recall_feedback_memory ON recall_feedback(memory_id,feedback_kind,created_at);
          CREATE TABLE IF NOT EXISTS consolidation_jobs(
            id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed','cancelled')),
            attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,available_at TEXT NOT NULL,lease_until TEXT,token TEXT,
            payload TEXT NOT NULL,result TEXT,last_error TEXT,failure TEXT,attempt_history TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS consolidation_jobs_ready ON consolidation_jobs(state,available_at);
        `);
        const memoryColumns=new Set(this.db.prepare('PRAGMA table_info(memories)').all().map(row=>row.name));
        if(!memoryColumns.has('status_ttl_hours')) this.db.exec('ALTER TABLE memories ADD COLUMN status_ttl_hours INTEGER');
        for (const [name, declaration] of [
          ['review_state',"TEXT NOT NULL DEFAULT 'clear' CHECK(review_state IN ('clear','pending','resolved'))"],
          ['valid_from','TEXT'],['valid_to','TEXT'],['validity_kind',"TEXT NOT NULL DEFAULT 'unknown'"],
          ['validity_precision',"TEXT NOT NULL DEFAULT 'unknown'"],['last_confirmed_at','TEXT'],['time_zone','TEXT'],
        ]) if (!memoryColumns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${declaration}`);
        const queueColumns=new Set(this.db.prepare('PRAGMA table_info(queue)').all().map(row=>row.name));
        if(!queueColumns.has('failure')) this.db.exec('ALTER TABLE queue ADD COLUMN failure TEXT');
        if(!queueColumns.has('attempt_history')) this.db.exec("ALTER TABLE queue ADD COLUMN attempt_history TEXT NOT NULL DEFAULT '[]'");
        if (version < SCHEMA_VERSION) {
          migrationFault?.(version);
          this._backfillV4(version);
        }
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
      this._cleanupDeletedManualAudits();
    } catch (error) {
      try { this.db.close(); } catch {}
      if (backupFile && existsSync(backupFile)) {
        for (const suffix of ['-wal','-shm']) { try { rmSync(`${filename}${suffix}`,{force:true}); } catch {} }
        copyFileSync(backupFile,filename);
        this.lastMigrationRestored = backupFile;
      }
      throw error;
    }
  }

  _backfillV4(version) {
    const insertEvidence=this.db.prepare(`INSERT OR IGNORE INTO memory_evidence(id,memory_id,memory_version,evidence_kind,source_session_id,source_event_id,source_event_seq,source_event_time,quote,quote_sha256,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const insertRelation=this.db.prepare(`INSERT OR IGNORE INTO memory_relations(id,from_memory_id,from_memory_version,relation,source_session_id,source_event_id,source_event_seq,source_event_time,target_memory_id,evidence_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of this.db.prepare('SELECT id,version,sources FROM memories').all()) {
      let sources=[];
      try { sources=decode(row.sources); } catch { sources=[]; }
      if (!Array.isArray(sources)) sources=[];
      let confirmed=null;
      for (const item of sources) {
        if (!item || typeof item.sessionId !== 'string' || !item.sessionId || item.eventTime == null) continue;
        const evidenceId=randomUUID(),quote=String(item.quote ?? item.evidence ?? ''),kind=evidenceKind(item),stamp=this.clock();
        const eventId=String(item.eventId ?? item.eventSeq ?? ''),eventSeq=Number.isSafeInteger(item.eventSeq)?item.eventSeq:null,eventTime=isoTimeOrNull(item.eventTime,'source eventTime') ?? this.clock();
        insertEvidence.run(evidenceId,row.id,row.version,kind,item.sessionId,String(item.eventId ?? item.eventSeq ?? ''),Number.isSafeInteger(item.eventSeq)?item.eventSeq:null,
          isoTimeOrNull(item.eventTime,'source eventTime') ?? this.clock(),quote,sha256(quote),stamp);
        const actualEvidence=this.db.prepare('SELECT id FROM memory_evidence WHERE memory_id=? AND memory_version=? AND source_session_id=? AND source_event_id=? AND source_event_seq IS ? AND quote_sha256=?').get(
          row.id,row.version,item.sessionId,eventId,eventSeq,sha256(quote));
        insertRelation.run(randomUUID(),row.id,row.version,'supports',item.sessionId,eventId,eventSeq,eventTime,null,actualEvidence.id,stamp);
        if (['user_statement','tool_result'].includes(kind)) {
          const at=new Date(item.eventTime).toISOString();if(!confirmed||at>confirmed)confirmed=at;
        }
      }
      this.db.prepare(`UPDATE memories SET review_state='clear',valid_from=NULL,valid_to=NULL,validity_kind='unknown',validity_precision='unknown',last_confirmed_at=?,time_zone=NULL WHERE id=?`).run(confirmed,row.id);
    }
    for (const row of this.db.prepare('SELECT memory_id,version,snapshot FROM memory_versions').all()) {
      let snapshot;
      try { snapshot=decode(row.snapshot); } catch { continue; }
      if (!snapshot || typeof snapshot!=='object') continue;
      const current=this.db.prepare('SELECT review_state,valid_from,valid_to,validity_kind,validity_precision,last_confirmed_at,time_zone FROM memories WHERE id=?').get(row.memory_id);
      const normalized={...snapshot,reviewState:current?.review_state??'clear',validFrom:current?.valid_from??null,validTo:current?.valid_to??null,
        validityKind:current?.validity_kind??'unknown',validityPrecision:current?.validity_precision??'unknown',lastConfirmedAt:current?.last_confirmed_at??null,timeZone:current?.time_zone??null};
      this.db.prepare('UPDATE memory_versions SET snapshot=? WHERE memory_id=? AND version=?').run(JSON.stringify(normalized),row.memory_id,row.version);
    }
    this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('schemaMigration',?,?)").run(JSON.stringify({from:version,to:SCHEMA_VERSION,at:this.clock()}),this.clock());
  }

  // Observe every SQL write on this production connection, including metadata,
  // queue, embeddings and FTS shadow rows. Rollbacks are recorded as reversals.
  beginWriteAudit() {
    if(this.writeAudit) throw new Error('Write audit already active');
    const raw=this.db,entries=[],dirty=new Set();
    const operation=sql=>sql.trim().split(/\s+/u).slice(0,3).join(' ');
    const record=(sql,tables,fn)=>{
      if(tables?.size===0) return fn();
      const started=performance.now();
      const before=logicalSnapshot(raw,tables);
      for(const table of Object.keys(before.tables)) dirty.add(table);
      try {return fn();} finally {
        const after=logicalSnapshot(raw,tables),changes=rowChanges(before,after);
        if(changes.length || before.schemaSha256!==after.schemaSha256) entries.push({at:this.clock(),elapsedMs:performance.now()-started,tables:[...new Set(changes.map(c=>c.table))].sort(),source:{connection:'production-host',...this.writeSource},operation:operation(sql),changes});
        if(!raw.isTransaction) dirty.clear();
      }
    };
    this.writeAudit={raw,entries};
    this.db=new Proxy(raw,{get:(target,key)=>{
      if(key==='exec') return sql=>{
        // FTS can flush shadow rows on COMMIT/SAVEPOINT/RELEASE. Fingerprint
        // only tables touched in this transaction, including rollback reversals.
        if(/^\s*BEGIN(?:\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE))?\s*;?\s*$/iu.test(sql)) return target.exec(sql);
        if(/^\s*(?:COMMIT|END|SAVEPOINT\s+\w+|RELEASE(?:\s+SAVEPOINT)?\s+\w+|ROLLBACK(?:\s+TRANSACTION)?(?:\s+TO(?:\s+SAVEPOINT)?\s+\w+)?)\s*;?\s*$/iu.test(sql)) {
          // FTS5 can flush shadow rows only at the outer commit. A full snapshot there
          // makes those final internal writes attributable without widening each statement.
          const outerCommit=/^\s*(?:COMMIT|END)\s*;?\s*$/iu.test(sql)&&this.depth<=1&&dirty.has('memory_fts');
          return record(sql,outerCommit?null:dirty,()=>target.exec(sql));
        }
        // Arbitrary multi-statement exec/DDL remains conservative, never guessed.
        return record(sql,null,()=>target.exec(sql));
      };
      if(key==='prepare') return sql=>{
        const tables=new Set();let statement;
        // SQLite itself resolves quoted names, triggers and foreign-key cascades.
        target.setAuthorizer((action,table)=>{
          if([sqlite.SQLITE_INSERT,sqlite.SQLITE_UPDATE,sqlite.SQLITE_DELETE].includes(action)) tables.add(table);
          return sqlite.SQLITE_OK;
        });
        try {statement=target.prepare(sql);} finally {target.setAuthorizer(null);}
        // Virtual-table internals are compiled lazily. Include their shadow tables.
        const schema=target.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table'").all();
        for(const row of schema) if(tables.has(row.name)&&/^CREATE VIRTUAL TABLE\b/iu.test(row.sql??'')) {
          for(const shadow of schema) if(shadow.name.startsWith(`${row.name}_`)) tables.add(shadow.name);
        }
        return new Proxy(statement,{get:(s,k)=>{
          if(['run','get','all'].includes(k)) return (...args)=>record(sql,tables,()=>s[k](...args));
          if(k==='iterate') return function*(...args) {
            // Materialize write RETURNING iterators so partial consumption cannot
            // leave an unaudited write. Ordinary read iterators remain lazy.
            if(!tables.size) {yield* s.iterate(...args);return;}
            yield* record(sql,tables,()=>[...s.iterate(...args)]);
          };
          return typeof s[k]==='function'?s[k].bind(s):s[k];
        }});
      };
      return typeof target[key]==='function'?target[key].bind(target):target[key];
    }});
  }
  endWriteAudit() {
    if(!this.writeAudit) throw new Error('No active write audit');
    const {raw,entries}=this.writeAudit;this.db=raw;this.writeAudit=null;return entries;
  }
  withWriteSource(source,fn) {
    const previous=this.writeSource;this.writeSource=source;
    try {return fn();} finally {this.writeSource=previous;}
  }
  close() { this.db.close(); }
  transaction(fn) {
    const savepoint = this.depth ? `jiyi_nested_${this.depth}` : null;
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.depth++;
    try {
      const value = fn();
      if (value && typeof value.then === 'function') throw new Error('Transactions must be synchronous');
      this.db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      this.db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK');
      throw error;
    } finally { this.depth--; }
  }

  resolveProject({ cwd, path = cwd, name, aliases = [] }) {
    const canonical = canonicalPath(path);
    const keys = [...new Set([canonical, ...aliases.map(aliasKey)])];
    return this.transaction(() => {
      const registered=this.db.prepare('SELECT alias,project_id FROM project_aliases').all();
      const found = keys.flatMap(key=>registered.filter(a=>isAbsolute(key)?a.alias===key:normalizeProjectLabel(a.alias)===normalizeProjectLabel(key)).map(a=>a.project_id));
      const exact = this.db.prepare('SELECT id FROM projects WHERE path=?').get(canonical)?.id;
      const ids = [...new Set([...found, exact].filter(Boolean))];
      if (ids.length > 1) throw new Error('Project aliases refer to different projects');
      let id = ids[0];
      const created=!id;
      if (!id) {
        id = randomUUID();
        this.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(id, canonical, name?.trim() || canonical.split('/').pop() || canonical, this.clock());
      }
      for (const key of keys) this.addProjectAlias(id, key);
      if(created && basename(canonical)) {
        const folder=basename(canonical),conflict=this.db.prepare('SELECT alias,project_id FROM project_aliases').all().some(a=>normalizeProjectLabel(a.alias)===normalizeProjectLabel(folder)&&a.project_id!==id);
        // A colliding folder label must not merge projects or break real turns.
        // getProject exposes the conflict; recall treats it as ambiguous.
        if(!conflict) this.addProjectAlias(id,folder);
      }
      return this.getProject(id);
    });
  }
  getProject(id) {
    if (id === undefined || id === null) return null;
    const p = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!p) return null;
    const aliases=this.db.prepare('SELECT alias FROM project_aliases WHERE project_id=? ORDER BY alias').all(id).map(r=>r.alias);
    const folder=basename(p.path),key=normalizeProjectLabel(folder);
    const aliasConflict=!aliases.some(a=>normalizeProjectLabel(a)===key)&&this.db.prepare('SELECT alias,project_id FROM project_aliases WHERE project_id<>?').all(id).some(a=>normalizeProjectLabel(a.alias)===key)?folder:null;
    return { id:p.id,path:p.path,name:p.name,createdAt:p.created_at,aliases,aliasConflict,
      ambiguities:this.db.prepare('SELECT id,path,name FROM projects WHERE name=? AND id<>? ORDER BY path').all(p.name,id).map(r=>({...r})) };
  }
  listProjects() { return this.db.prepare('SELECT id FROM projects ORDER BY path').all().map(r=>this.getProject(r.id)); }
  renameProject(id,name,aliases = []) {
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(required(name,'Project name'),id);
      if (!result.changes) throw new Error('Project not found');
      for (const alias of aliases) this.addProjectAlias(id,alias);
      return this.getProject(id);
    });
  }
  addProjectAlias(id, alias) {
    return this.transaction(()=>{
      if(!this.getProject(id)) throw new Error('Project not found');
      const key=aliasKey(alias);
      if(key.length>1000) throw new Error('Project alias is too long');
      const matches=this.db.prepare('SELECT alias,project_id FROM project_aliases').all().filter(a=>isAbsolute(key)?a.alias===key:!isAbsolute(a.alias)&&normalizeProjectLabel(a.alias)===normalizeProjectLabel(key));
      if(matches.some(a=>a.project_id!==id)) throw Object.assign(new Error('Project alias already belongs to another project'),{code:'PROJECT_ALIAS_CONFLICT'});
      if(!matches.length) this.db.prepare('INSERT INTO project_aliases VALUES(?,?)').run(key,id);
      return this.getProject(id);
    });
  }
  deleteProjectAlias(id,alias) {
    return this.transaction(()=>{
      const project=this.getProject(id);if(!project)throw new Error('Project not found');
      const key=aliasKey(alias);
      if(key===project.path) throw new Error('规范项目路径不是可删除的自定义别名');
      const result=this.db.prepare('DELETE FROM project_aliases WHERE alias=? AND project_id=?').run(key,id);
      if(!result.changes) throw new Error('Project alias not found');
      return this.getProject(id);
    });
  }
  applyProjectAliasBackfill(plan) {
    return this.transaction(()=>{
      const current=planProjectAliasBackfill(this.db);
      if(JSON.stringify(current)!==JSON.stringify(plan)) throw new Error('别名迁移预览已变化，请重新列出清单');
      for(const row of current.additions) this.addProjectAlias(row.projectId,row.alias);
      return {added:current.additions,conflicts:current.conflicts,removed:[]};
    });
  }

  _record(row) {
    if (!row) return null;
    const vector = this.db.prepare('SELECT * FROM vectors WHERE memory_id=? AND memory_version=?').get(row.id,row.version);
    const selection = this.db.prepare('SELECT inclusion,user_controlled,revision FROM memory_selections WHERE memory_id=?').get(row.id);
    const feedback=this.db.prepare("SELECT COALESCE(sum(CASE feedback_kind WHEN 'explicit_useful' THEN 2 WHEN 'model_used' THEN 1 WHEN 'explicit_irrelevant' THEN -1 WHEN 'model_irrelevant' THEN -.5 WHEN 'model_stale' THEN -.5 WHEN 'model_contradicted' THEN -2 WHEN 'explicit_wrong' THEN -4 ELSE 0 END),0) weight FROM recall_feedback WHERE memory_id=? AND memory_version=?").get(row.id,row.version);
    const sources = decode(row.sources);
    return { id:row.id,version:row.version,content:redactSensitiveText(row.content),scope:row.scope,projectId:row.project_id,kind:row.kind,type:row.kind,
      factKey:row.fact_key,key:row.fact_key,confidence:row.confidence,status:row.status,sources,source:sources[0] ?? null,
      createdAt:row.created_at,updatedAt:row.updated_at,supersededBy:row.superseded_by,
      extractionModel:row.extraction_model,extractionVersion:row.extraction_version,
      reviewState:row.review_state,validFrom:row.valid_from,validTo:row.valid_to,validityKind:row.validity_kind,
      validityPrecision:row.validity_precision,lastConfirmedAt:row.last_confirmed_at,timeZone:row.time_zone,
      inclusion:selection?.inclusion ?? 'searchable',userControlled:!!selection?.user_controlled,selectionRevision:selection?.revision ?? 0,
      feedbackWeight:Number(feedback?.weight??0),
      embedding:vector ? decode(vector.embedding) : null,embeddingModel:vector?.model ?? null,embeddingVersion:vector?.embedding_version ?? null };
  }
  getMemory(id, { includeInactive = true } = {}) {
    return this._record(this.db.prepare(`SELECT * FROM memories WHERE id=?${includeInactive ? '' : " AND status='active'"}`).get(id));
  }
  _snapshot(id) {
    const record = this.getMemory(id);
    this.db.prepare('INSERT INTO memory_versions VALUES(?,?,?)').run(id,record.version,JSON.stringify(record));
    return record;
  }
  getVersions(id) { return this.db.prepare('SELECT snapshot FROM memory_versions WHERE memory_id=? ORDER BY version').all(id).map(r=>decode(r.snapshot)); }
  _sourceRefs(sources) {
    return sources.map(source=>({sessionId:source.sessionId,eventId:source.eventId,eventSeq:source.eventSeq??null,eventTime:source.eventTime,quoteSha256:sha256(source.quote??source.evidence)}));
  }
  recordDecision({memoryId,decisionType='update',fromVersion=null,toVersion=null,sourceRefs=[],algorithmVersion=null,promptVersion=null,
    provider=null,model=null,reasoningEffort=null,configHash=null,evidenceCount=0,confidence=null,conflictScore=null,
    outcome='applied',reasonCode='change',shortReason='普通记忆变更',correlationId=randomUUID()}) {
    oneOf(outcome,['applied','held','rejected'],'decision outcome');
    if (!required(reasonCode,'Decision reasonCode')) throw new Error('reasonCode required');
    const safeReason=redactSensitiveText(String(shortReason??'').slice(0,240));
    this.db.prepare(`INSERT INTO memory_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(),required(decisionType,'Decision type'),required(memoryId,'Decision memoryId'),fromVersion,toVersion,JSON.stringify(sourceRefs),
      algorithmVersion,promptVersion,provider,model,reasoningEffort,configHash,Number.isInteger(evidenceCount)?evidenceCount:0,
      Number.isFinite(confidence)?confidence:null,Number.isFinite(conflictScore)?conflictScore:null,outcome,reasonCode,safeReason,required(correlationId,'Decision correlationId'),this.clock());
  }
  _writeEvidence(id,version,sources,relation='supports',targetMemoryId=null) {
    const previousKeys=new Set();
    if (version>1) {
      for(const row of this.db.prepare('SELECT source_session_id,source_event_id,source_event_seq FROM memory_evidence WHERE memory_id=? AND memory_version=?').all(id,version-1))
        previousKeys.add(`${row.source_session_id}\u0000${row.source_event_id}\u0000${row.source_event_seq??''}`);
    }
    for(const source of sources) {
      const key=sourceKey(source),kind=evidenceKind(source),quote=String(source.quote??source.evidence??'');
      const evidenceId=randomUUID(),at=isoTimeOrNull(source.eventTime,'source eventTime');
      this.db.prepare(`INSERT OR IGNORE INTO memory_evidence(id,memory_id,memory_version,evidence_kind,source_session_id,source_event_id,source_event_seq,source_event_time,quote,quote_sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(evidenceId,id,version,kind,source.sessionId,source.eventId,source.eventSeq??null,at,quote,sha256(quote),this.clock());
      const actual=this.db.prepare('SELECT id FROM memory_evidence WHERE memory_id=? AND memory_version=? AND source_session_id=? AND source_event_id=? AND source_event_seq IS ? AND quote_sha256=?').get(
        id,version,source.sessionId,source.eventId,source.eventSeq??null,sha256(quote));
      const sourceRelation=relation!=='supports'&&!previousKeys.has(key) ? relation : (source.evidence==='manual-correction'?'corrects':'supports');
      this.db.prepare(`INSERT OR IGNORE INTO memory_relations(id,from_memory_id,from_memory_version,relation,source_session_id,source_event_id,source_event_seq,source_event_time,target_memory_id,evidence_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),id,version,sourceRelation,source.sessionId,source.eventId,source.eventSeq??null,at,sourceRelation==='corrects'?targetMemoryId:null,actual.id,this.clock());
    }
    const evidenceCount=this.db.prepare('SELECT count(*) n FROM memory_evidence WHERE memory_id=? AND memory_version=?').get(id,version).n;
    const relationCount=this.db.prepare('SELECT count(*) n FROM memory_relations WHERE from_memory_id=? AND from_memory_version=?').get(id,version).n;
    if(evidenceCount!==sources.length||relationCount<sources.length) throw Object.assign(new Error('Evidence and source relations are inconsistent'),{code:'MEMORY_EVIDENCE_INCONSISTENT'});
  }
  _invalidate(id, status, replacement = null, {validFrom=null,decision=null}={}) {
    const current=this.getMemory(id);
    const validTo=status==='superseded'&&validFrom&&current?.validityKind!=='unknown'?validFrom:current?.validTo??null;
    this.db.prepare('UPDATE memories SET status=?,superseded_by=?,valid_to=?,version=version+1,updated_at=?,review_state=? WHERE id=?')
      .run(status,replacement,validTo,this.clock(),status==='active'?'clear':'resolved',id);
    this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(id);
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(id);
    const saved=this._snapshot(id);
    this.recordDecision({memoryId:id,decisionType:status==='superseded'?'supersede':'delete',fromVersion:current?.version??null,toVersion:saved.version,
      sourceRefs:decision?.sourceRefs??this._sourceRefs(current?.sources??[]),algorithmVersion:decision?.algorithmVersion,promptVersion:decision?.promptVersion,
      provider:decision?.provider,model:decision?.model,reasoningEffort:decision?.reasoningEffort,configHash:decision?.configHash,
      evidenceCount:decision?.evidenceCount??current?.sources?.length??0,confidence:decision?.confidence,conflictScore:decision?.conflictScore,
      outcome:'applied',reasonCode:decision?.reasonCode??(status==='superseded'?'superseded':'deleted'),shortReason:decision?.shortReason??'记忆状态变更',correlationId:decision?.correlationId});
    return saved;
  }
  putMemory(input, options = {}) {
    return this.transaction(() => {
      const id = input.id ?? randomUUID();
      const current = this.getMemory(id);
      if (current && current.status !== 'active') throw new Error('Inactive memory cannot be revived');
      const expected = options.expectedVersion ?? input.expectedVersion;
      if (current && expected !== current.version) throw new Error('Memory version conflict');
      if (!current && expected != null && expected !== 0) throw new Error('Memory version conflict');
      const scope = input.scope ?? current?.scope ?? 'project';
      const projectId = input.projectId ?? current?.projectId ?? null;
      if (!['global','project'].includes(scope) || (scope === 'global' ? projectId !== null : !projectId)) throw new Error('Invalid memory scope/project');
      if (current && (scope !== current.scope || projectId !== current.projectId)) throw new Error('Memory scope cannot change');
      const content = required(input.content,'Memory content');
      const sources = input.sources ?? (input.source ? [input.source] : current?.sources);
      if (!Array.isArray(sources) || !sources.length) throw new Error('Memory sources are required');
      const normalized = sources.map(s => ({...s,sessionId:required(s.sessionId,'Source sessionId'),eventId:required(String(s.eventId ?? s.eventSeq ?? ''),'Source eventId'),
        eventTime:required(s.eventTime,'Source eventTime'),evidence:required(s.evidence ?? s.quote,'Source evidence')}));
      const confidence = input.confidence ?? current?.confidence ?? 1;
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Invalid confidence');
      const kind = input.kind ?? input.type ?? current?.kind ?? 'fact';
      const factKey = input.factKey ?? input.key ?? current?.factKey ?? null;
      const latest = newestSource(normalized);
      if (current) assertFreshSources(normalized,current.sources);
      if (options.requireClear && current && (current.reviewState!=='clear'||this.hasOpenConflict(id))) throw Object.assign(new Error('Memory has an open conflict review'),{code:'CONFLICT_REVIEW_OPEN'});
      const reviewState = input.reviewState ?? 'clear';
      oneOf(reviewState, REVIEW_STATES, 'reviewState');
      const validity=normalizeValidity(input,normalized,kind);
      const hasSupersedes=Array.isArray(input.supersedes)?input.supersedes.length>0:Boolean(input.supersedes);
      const relation=input.relation ?? (hasSupersedes?'corrects':'supports');
      oneOf(relation, RELATION_KINDS, 'relation');
      if (factKey != null) {
        const deleted = this.db.prepare("SELECT updated_at FROM memories WHERE status='deleted' AND scope=? AND project_id IS ? AND fact_key=?").all(scope,projectId,factKey);
        if (deleted.some(row => latest.time <= Date.parse(row.updated_at))) throw staleFact();
      }
      const supersedes = input.supersedes == null ? [] : Array.isArray(input.supersedes) ? input.supersedes : [input.supersedes];
      const conflicting = factKey == null ? [] : this.db.prepare("SELECT id FROM memories WHERE status='active' AND scope=? AND project_id IS ? AND fact_key=? AND id<>?").all(scope,projectId,factKey,id).map(r=>r.id);
      if (conflicting.length && !current && !supersedes.length && relation!=='corrects') {
        for(const oldId of conflicting) assertFreshSources(normalized,this.getMemory(oldId).sources);
        throw Object.assign(new Error('Conflicting active fact requires correction or adjudication'),{code:'MEMORY_CONFLICT',conflictMemoryIds:conflicting});
      }
      const decision={sourceRefs:this._sourceRefs(normalized),algorithmVersion:input.decision?.algorithmVersion??input.extractionVersion,
        promptVersion:input.decision?.promptVersion??input.extractionVersion,provider:input.decision?.provider,model:input.decision?.model,
        reasoningEffort:input.decision?.reasoningEffort,configHash:input.decision?.configHash,evidenceCount:normalized.length,
        confidence:input.decision?.confidence,conflictScore:input.decision?.conflictScore,correlationId:input.decision?.correlationId??randomUUID(),
        reasonCode:input.decision?.reasonCode??(current?'updated':'added'),shortReason:input.decision?.shortReason??(current?'记忆更新':'新记忆')};
      for (const oldId of new Set([...supersedes,...conflicting])) {
        const old = this.getMemory(oldId);
        if (!old || old.id === id || old.status !== 'active') throw new Error('Invalid superseded memory');
        if (old.scope !== scope || old.projectId !== projectId) throw new Error('Cannot supersede another scope/project');
        assertFreshSources(normalized,old.sources);
        this._dismissConflictGroupsForMemory(oldId,{reason:'Conflict member was superseded',exceptGroupId:options.conflictGroupId??null});
        this._invalidate(oldId,'superseded',id,{validFrom:validity.validFrom,decision:{...decision,reasonCode:'superseded',shortReason:'确定性纠正或显式替代'}});
      }
      if (current) this._dismissConflictGroupsForMemory(id,{reason:'Conflict member was updated',exceptGroupId:options.conflictGroupId??null});
      const stamp = this.clock();
      const version = (current?.version ?? 0) + 1;
      const confirmed=normalized.reduce((latestAt,source)=>{
        if(!['supports','corrects'].includes(relation)||!['user_statement','tool_result'].includes(evidenceKind(source))) return latestAt;
        const at=new Date(source.eventTime).toISOString();return !latestAt||at>latestAt?at:latestAt;
      },current?.lastConfirmedAt??null);
      this.db.prepare(`INSERT INTO memories(id,version,content,scope,project_id,kind,fact_key,confidence,status,sources,created_at,updated_at,superseded_by,extraction_model,extraction_version,status_ttl_hours,review_state,valid_from,valid_to,validity_kind,validity_precision,last_confirmed_at,time_zone) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        version=excluded.version,content=excluded.content,kind=excluded.kind,fact_key=excluded.fact_key,confidence=excluded.confidence,sources=excluded.sources,updated_at=excluded.updated_at,
        extraction_model=excluded.extraction_model,extraction_version=excluded.extraction_version,status_ttl_hours=excluded.status_ttl_hours,
        review_state=excluded.review_state,valid_from=excluded.valid_from,valid_to=excluded.valid_to,validity_kind=excluded.validity_kind,
        validity_precision=excluded.validity_precision,last_confirmed_at=excluded.last_confirmed_at,time_zone=excluded.time_zone`).run(
        id,version,content,scope,projectId,kind,factKey,confidence,'active',JSON.stringify(normalized),current?.createdAt ?? stamp,stamp,null,
        input.extractionModel ?? current?.extractionModel ?? null,input.extractionVersion ?? current?.extractionVersion ?? null,null,
        reviewState,validity.validFrom,validity.validTo,validity.validityKind,validity.validityPrecision,confirmed,validity.timeZone);
      this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(id);
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(id);
      this.db.prepare('INSERT INTO memory_fts(memory_id,content) VALUES(?,?)').run(id,content);
      this._writeEvidence(id,version,normalized,relation,relation==='corrects'?(supersedes[0]??conflicting[0]??current?.id??null):null);
      if (current?.inclusion==='essential') this._assertEssentialBudget(scope,projectId);
      const embedding = options.vector ?? input.embedding;
      if (embedding != null) this.setEmbedding(id,embedding,options.model ?? input.embeddingModel,{expectedVersion:version,embeddingVersion:options.embeddingVersion ?? input.embeddingVersion});
      const saved=this._snapshot(id);
      this.recordDecision({memoryId:id,decisionType:current?'update':'add',fromVersion:current?.version??null,toVersion:version,...decision,outcome:'applied'});
      return saved;
    });
  }
  replaceMemory(id,input,options = {}) { return this.putMemory({...input,id,expectedVersion:options.expectedVersion ?? input.expectedVersion},options); }
  _cleanupDeletedManualAudits() {
    const retained=new Set();
    for(const row of this.db.prepare("SELECT status,sources FROM memories WHERE status<>'deleted'").all()) {
      try { for(const source of decode(row.sources)) if(String(source?.sessionId).startsWith('jiyi-manual:')) retained.add(source.sessionId); }
      catch { /* Malformed legacy sources are not authority to retain credential-bearing audit bodies. */ }
    }
    let removed=0;
    for(const {key} of this.db.prepare("SELECT key FROM metadata WHERE key LIKE 'manual:%'").all()) {
      if(!retained.has(key.slice('manual:'.length))) { this.db.prepare('DELETE FROM metadata WHERE key=?').run(key); removed++; }
    }
    return removed;
  }
  deleteMemory(id,{expectedVersion} = {}) {
    return this.transaction(() => {
      const current = this.getMemory(id);
      if (!current) throw new Error('Memory not found');
      if (expectedVersion != null && expectedVersion !== current.version) throw new Error('Memory version conflict');
      this._dismissConflictGroupsForMemory(id,{reason:'Conflict member was deleted'});
      if (current.status === 'deleted') return current;
      for (const source of current.sources) {
        if (source.origin === 'manual' || String(source.evidence).startsWith('manual-') || String(source.sessionId).startsWith('jiyi-manual:')) {
          this.db.prepare('DELETE FROM metadata WHERE key=?').run(`manual:${source.sessionId}`);
        }
      }
      const redactSources = sources => sources.map(({sessionId,eventId,eventSeq,eventTime}) => ({sessionId,eventId,eventSeq,eventTime}));
      this.db.prepare("UPDATE memories SET content='',sources=? WHERE id=?").run(JSON.stringify(redactSources(current.sources)),id);
      const tombstone = this._invalidate(id,'deleted');
      // Retain only source locators and historical version identities, never deleted text/quotes/vectors.
      for (const row of this.db.prepare('SELECT version,snapshot FROM memory_versions WHERE memory_id=?').all(id)) {
        const old = decode(row.snapshot);
        const redacted = {...old,content:'',sources:redactSources(old.sources??[]),embedding:null,embeddingModel:null,embeddingVersion:null,status:'deleted',reviewState:'resolved'};
        redacted.source = redacted.sources[0] ?? null;
        this.db.prepare('UPDATE memory_versions SET snapshot=? WHERE memory_id=? AND version=?').run(JSON.stringify(redacted),id,row.version);
      }
      this.db.prepare("UPDATE memory_evidence SET quote='' WHERE memory_id=?").run(id);
      for(const row of this.db.prepare('SELECT id,payload FROM memory_candidates WHERE original_memory_id=? OR payload LIKE ?').all(id,`%${id}%`)) {
        let payload;
        try { payload=decode(row.payload); } catch { payload=null; }
        const references=payload?.originalMemoryId===id||payload?.conflictMemoryIds?.includes(id)||payload?.memory?.id===id;
        if(references) this.db.prepare("UPDATE memory_candidates SET payload='{\"redacted\":true}',state='rejected',updated_at=? WHERE id=?").run(this.clock(),row.id);
      }
      return tombstone;
    });
  }
  setEmbedding(id,embedding,model,{expectedVersion,embeddingVersion=null} = {}) {
    validateVector(embedding);
    required(model,'Embedding model');
    return this.transaction(() => {
      const memory = this.getMemory(id);
      if (!memory || memory.status !== 'active') throw new Error('Active memory not found');
      if (expectedVersion != null && expectedVersion !== memory.version) throw new Error('Memory version conflict');
      this.db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET memory_version=excluded.memory_version,model=excluded.model,dimensions=excluded.dimensions,embedding=excluded.embedding,embedding_version=excluded.embedding_version').run(id,memory.version,model,embedding.length,JSON.stringify(embedding),embeddingVersion);
      return this.getMemory(id);
    });
  }
  _memoryFilter({projectId,scope,status=null,reviewState=null,recallOnly=false,includeGlobal=true,includeInactive=false,query=''} = {}) {
    if (scope != null && !['all','global','project'].includes(scope)) throw new Error('Invalid scope');
    if (status != null && !['active','superseded','deleted'].includes(status)) throw new Error('Invalid status');
    if (reviewState != null) oneOf(reviewState,REVIEW_STATES,'reviewState');
    if (typeof query !== 'string' || query.length > 1000) throw new Error('Invalid memory query');
    const clauses = [], args = [];
    if (status != null) { clauses.push('status=?'); args.push(status); }
    else if (!includeInactive) clauses.push("status='active'");
    if (reviewState != null) { clauses.push('review_state=?'); args.push(reviewState); }
    else if (recallOnly) clauses.push("review_state='clear'");
    if (recallOnly) {
      const now=this.clock();
      clauses.push("(validity_kind='unknown' OR ((valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>?)))");
      args.push(now,now);
    }
    if (scope === 'global' || (scope == null && !projectId)) clauses.push("scope='global'");
    else if (scope === 'project' || scope == null && !includeGlobal) { clauses.push("scope='project' AND project_id=?"); args.push(projectId); }
    else if (scope == null) { clauses.push("(scope='global' OR (scope='project' AND project_id=?))"); args.push(projectId); }
    if (scope === 'project' && !projectId) clauses.push('0');
    const needle=query.trim();
    if (needle) { clauses.push('instr(lower(content),lower(?))>0'); args.push(needle); }
    return {where:clauses.length?clauses.join(' AND '):'1',args};
  }
  listMemories(options = {}) {
    const {limit=500,offset=0}=options;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const {where,args}=this._memoryFilter(options);
    return this.db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args,bounded(limit,500),offset).map(r=>this._record(r));
  }
  countMemories(options = {}) {
    const {where,args}=this._memoryFilter(options);
    return this.db.prepare(`SELECT count(*) AS n FROM memories WHERE ${where}`).get(...args).n;
  }
  listAllMemories({includeInactive=false,limit=500,offset=0,recallOnly=false} = {}) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const {where,args}=this._memoryFilter({scope:'all',includeInactive,recallOnly});
    return this.db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args,bounded(limit,500),offset).map(r=>this._record(r));
  }
  listCandidates(options = {}) { return this.listMemories({...options,includeInactive:false,recallOnly:true,limit:options.limit ?? 2000}); }
  listEssentialMemories({projectId} = {}) {
    return this.listMemories({projectId,limit:10000,recallOnly:true}).filter(memory=>memory.inclusion==='essential');
  }
  _assertEssentialBudget(scope,projectId) {
    const ids=scope==='global' ? [null,...this.listProjects().map(project=>project.id)] : [projectId];
    for (const id of ids) {
      const bytes=this.listEssentialMemories({projectId:id}).reduce((sum,item)=>sum+Buffer.byteLength(item.content,'utf8'),0);
      if (bytes>ESSENTIAL_MEMORY_BUDGET_BYTES) throw new Error('Essential memory budget exceeded');
    }
  }
  /** User selections win over automatic review. Check the combined global/project budget atomically. */
  setMemoryInclusion(id,inclusion,{expectedRevision,userControlled=true} = {}) {
    if (!['essential','searchable'].includes(inclusion)) throw new Error('Invalid memory inclusion');
    return this.transaction(()=>{
      const memory=this.getMemory(id,{includeInactive:false});
      if (!memory) throw new Error('Active memory not found');
      if (expectedRevision != null && expectedRevision!==memory.selectionRevision) throw new Error('Memory selection conflict');
      if (!userControlled && memory.userControlled) throw new Error('Memory selection is user controlled');
      const revision=memory.selectionRevision+1;
      this.db.prepare(`INSERT INTO memory_selections VALUES(?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET
        inclusion=excluded.inclusion,user_controlled=excluded.user_controlled,revision=excluded.revision`).run(id,inclusion,Number(userControlled || memory.userControlled),revision);
      if (inclusion==='essential') this._assertEssentialBudget(memory.scope,memory.projectId);
      return this.getMemory(id);
    });
  }
  searchText(query,{projectId,scope,includeGlobal=true,limit=100} = {}) {
    const text = required(query,'Search query');
    if(scope != null && !['all','global','project'].includes(scope)) throw new Error('Invalid scope');
    if(scope === 'project' && !projectId) return [];
    const terms = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    // Quote literals so user text is never interpreted as FTS operators.
    const match = terms.filter(t=>[...t].length >= 3).map(t=>`"${t.replaceAll('"','""')}"`).join(' OR ');
    const max=bounded(limit,100);
    const clauses=["m.status='active'","m.review_state='clear'"],args=[];
    clauses.push("(m.validity_kind='unknown' OR ((m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_to IS NULL OR m.valid_to>?)))");
    args.push(this.clock(),this.clock());
    if (scope === 'global' || scope == null && !projectId) clauses.push("m.scope='global'");
    else if (scope === 'project' || scope == null && !includeGlobal) { clauses.push("m.scope='project' AND m.project_id=?"); args.push(projectId); }
    else if (scope == null) { clauses.push("(m.scope='global' OR (m.scope='project' AND m.project_id=?))"); args.push(projectId); }
    if (!match) {
      clauses.push('instr(lower(m.content),lower(?))>0');args.push(text);
      return this.db.prepare(`SELECT m.* FROM memories m WHERE ${clauses.join(' AND ')} ORDER BY m.updated_at DESC,m.id LIMIT ?`).all(...args,max).map(r=>({...this._record(r),textScore:1}));
    }
    const rows=this.db.prepare(`SELECT m.*,bm25(memory_fts) AS rank FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id WHERE memory_fts MATCH ? AND ${clauses.join(' AND ')} ORDER BY rank LIMIT ?`).all(match,...args,max);
    return rows.map(r=>({...this._record(r),textScore:-r.rank}));
  }

  getMemoryDetail(id) {
    const memory=this.getMemory(id);
    if(!memory) return null;
    const evidence=this.db.prepare('SELECT * FROM memory_evidence WHERE memory_id=? ORDER BY memory_version,source_event_time,rowid').all(id).map(row=>({
      id:row.id,memoryVersion:row.memory_version,evidenceKind:row.evidence_kind,source:{sessionId:row.source_session_id,eventId:row.source_event_id,eventSeq:row.source_event_seq,eventTime:row.source_event_time},
      quote:redactSensitiveText(row.quote),quoteSha256:row.quote_sha256,createdAt:row.created_at,
    }));
    const relations=this.db.prepare('SELECT * FROM memory_relations WHERE from_memory_id=? ORDER BY from_memory_version,rowid').all(id).map(row=>({
      id:row.id,fromVersion:row.from_memory_version,relation:row.relation,source:{sessionId:row.source_session_id,eventId:row.source_event_id,eventSeq:row.source_event_seq,eventTime:row.source_event_time},
      targetMemoryId:row.target_memory_id,evidenceId:row.evidence_id,createdAt:row.created_at,
    }));
    const decisions=this.listMemoryDecisions(id);
    return {...memory,evidence,relations,decisions};
  }
  listMemoryDecisions(id) {
    return this.db.prepare('SELECT * FROM memory_decisions WHERE memory_id=? ORDER BY created_at,rowid').all(id).map(row=>({
      id:row.id,decisionType:row.decision_type,fromVersion:row.from_version,toVersion:row.to_version,sourceRefs:decode(row.source_refs),
      algorithmVersion:row.algorithm_version,promptVersion:row.prompt_version,provider:row.provider,model:row.model,reasoningEffort:row.reasoning_effort,
      configHash:row.config_hash,evidenceCount:row.evidence_count,confidence:row.confidence,conflictScore:row.conflict_score,
      outcome:row.outcome,reasonCode:row.reason_code,shortReason:row.short_reason,correlationId:row.correlation_id,createdAt:row.created_at,
    }));
  }
  stageMemoryCandidate({memory,conflictMemoryIds=[],expectedMemberVersions={},reasonCode='semantic_conflict',route={},correlationId=randomUUID()}) {
    if(!memory||!Array.isArray(conflictMemoryIds)||!conflictMemoryIds.length) throw new Error('Conflict candidate requires at least one memory');
    return this.transaction(()=>{
      const normalizedSources=(memory.sources??[]).map(source=>({...source,sessionId:required(source.sessionId,'Candidate source sessionId'),eventId:required(String(source.eventId??source.eventSeq??''),'Candidate source eventId'),
        eventTime:required(source.eventTime,'Candidate source eventTime'),evidence:required(source.evidence??source.quote,'Candidate source evidence')}));
      const validity=normalizeValidity(memory,normalizedSources,memory.kind??memory.type??'fact');
      memory={...memory,sources:normalizedSources,...validity};
      const members=conflictMemoryIds.map(id=>this.getMemory(id,{includeInactive:false}));
      const candidateProjectId=memory.projectId??null;
      if(members.some(item=>!item||item.status!=='active')) throw Object.assign(new Error('Conflict member is no longer active'),{code:'CONFLICT_STALE'});
      if(members.some(item=>Number.isInteger(expectedMemberVersions[item.id])&&expectedMemberVersions[item.id]!==item.version)) throw Object.assign(new Error('Conflict member version changed'),{code:'CONFLICT_STALE'});
      if(members.some(item=>item.userControlled||item.sources.some(source=>source.origin==='manual'||source.sessionId.startsWith('jiyi-manual:')))) throw Object.assign(new Error('Protected memory cannot be staged for automatic replacement'),{code:'PROTECTED_MEMORY'});
      if(members.some(item=>item.scope!==memory.scope||item.projectId!==candidateProjectId)) throw Object.assign(new Error('Conflict members must share scope'),{code:'CONFLICT_SCOPE'});
      const factKey=memory.factKey??null;
      let group=factKey==null?null:this.db.prepare("SELECT * FROM conflict_groups WHERE scope=? AND project_id IS ? AND fact_key=? AND state IN ('open','adjudicating') ORDER BY created_at LIMIT 1").get(memory.scope,candidateProjectId,factKey);
      const stamp=this.clock();
      if(!group) {
        const id=randomUUID();
        this.db.prepare(`INSERT INTO conflict_groups(id,scope,project_id,fact_key,state,reason_code,provider,model,reasoning_effort,effort_source,model_policy,timeout_ms,config_hash,created_at,updated_at)
          VALUES(?,?,?,?, 'open',?,?,?,?,?,?,?,?,?,?)`).run(id,memory.scope,candidateProjectId,factKey,reasonCode,route.provider??null,route.model??null,route.reasoningEffort??null,
          route.effortSource??null,route.modelPolicy??null,Number.isInteger(route.timeoutMs)?route.timeoutMs:null,route.configHash??null,stamp,stamp);
        group=this.db.prepare('SELECT * FROM conflict_groups WHERE id=?').get(id);
      }
      const candidateId=randomUUID(),expected=members[0].version;
      this.db.prepare("INSERT INTO memory_candidates VALUES(?,?,?, 'pending',?,?,?,?)").run(candidateId,factKey?members[0].id:null,group.id,
        JSON.stringify({memory,conflictMemoryIds,originalMemoryIds:members.map(item=>item.id)}),expected,stamp,stamp);
      this.db.prepare('INSERT OR IGNORE INTO conflict_members VALUES(?,?,?,?,?,?)').run(group.id,'candidate',candidateId,null,'candidate',stamp);
      for(const member of members) {
        this.db.prepare('INSERT OR IGNORE INTO conflict_members VALUES(?,?,?,?,?,?)').run(group.id,'memory',member.id,member.version,'existing',stamp);
        this.db.prepare("UPDATE memories SET review_state='pending' WHERE id=? AND status='active'").run(member.id);
        this.recordDecision({memoryId:member.id,decisionType:'conflict_hold',fromVersion:member.version,toVersion:member.version,
          sourceRefs:this._sourceRefs(memory.sources??[]),algorithmVersion:'jiyi-conflict-v1',promptVersion:null,provider:route.provider,model:route.model,
          reasoningEffort:route.reasoningEffort,configHash:route.configHash,evidenceCount:memory.sources?.length??0,outcome:'held',
          reasonCode,shortReason:'冲突候选已隔离，等待裁决',correlationId});
      }
      return {group:this.getConflictGroup(group.id),candidateId};
    });
  }
  getConflictGroup(id) {
    const row=this.db.prepare('SELECT * FROM conflict_groups WHERE id=?').get(id);
    if(!row) return null;
    const members=this.db.prepare('SELECT * FROM conflict_members WHERE group_id=? ORDER BY role,rowid').all(id).map(member=>{
      if(member.member_kind==='memory') return {kind:'memory',id:member.member_id,version:member.memory_version,role:member.role,memory:this.getMemory(member.member_id)};
      const candidate=this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(member.member_id);
      let payload=null;try{payload=decode(candidate?.payload);}catch{}
      return {kind:'candidate',id:member.member_id,version:null,role:member.role,candidate:candidate?{id:candidate.id,state:candidate.state,memory:payload?.memory??null,conflictMemoryIds:payload?.conflictMemoryIds??[]}:null};
    });
    return {id:row.id,scope:row.scope,projectId:row.project_id,factKey:row.fact_key,state:row.state,reasonCode:row.reason_code,
      route:{provider:row.provider,model:row.model,reasoningEffort:row.reasoning_effort,effortSource:row.effort_source,modelPolicy:row.model_policy,timeoutMs:row.timeout_ms,configHash:row.config_hash},
      token:row.token,leaseUntil:row.lease_until,attempts:row.attempts,maxAttempts:row.max_attempts,lastError:row.last_error,resolution:row.resolution,createdAt:row.created_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at,members};
  }
  hasOpenConflict(memoryId) {
    return this.db.prepare(`SELECT 1 FROM conflict_members cm JOIN conflict_groups cg ON cg.id=cm.group_id
      WHERE cm.member_kind='memory' AND cm.member_id=? AND cg.state IN ('open','adjudicating') LIMIT 1`).get(memoryId)!=null;
  }
  _syncReviewState(memoryId) {
    const memory=this.getMemory(memoryId,{includeInactive:false});
    if(!memory) return;
    this.db.prepare("UPDATE memories SET review_state=? WHERE id=? AND status='active'").run(this.hasOpenConflict(memoryId)?'pending':'clear',memoryId);
  }
  _dismissConflictGroupsForMemory(memoryId,{reason='Conflict member changed',exceptGroupId=null}={}) {
    const groups=this.db.prepare(`SELECT DISTINCT cg.id FROM conflict_groups cg JOIN conflict_members cm ON cm.group_id=cg.id
      WHERE cm.member_kind='memory' AND cm.member_id=? AND cg.state IN ('open','adjudicating') AND cg.id IS NOT ?`).all(memoryId,exceptGroupId);
    if(!groups.length) return;
    const stamp=this.clock();
    for(const {id} of groups) {
      const memberIds=this.db.prepare("SELECT member_id FROM conflict_members WHERE group_id=? AND member_kind='memory'").all(id).map(row=>row.member_id);
      const candidateIds=this.db.prepare("SELECT member_id FROM conflict_members WHERE group_id=? AND member_kind='candidate'").all(id).map(row=>row.member_id);
      this.db.prepare("UPDATE conflict_groups SET state='dismissed',token=NULL,lease_until=NULL,last_error=?,resolution='dismissed',resolved_at=?,updated_at=? WHERE id=?").run(reason,stamp,stamp,id);
      for(const candidateId of candidateIds) this.db.prepare("UPDATE memory_candidates SET state='rejected',payload='{\"redacted\":true}',updated_at=? WHERE id=?").run(stamp,candidateId);
      for(const memberId of memberIds) this._syncReviewState(memberId);
    }
  }
  listConflictGroups({state=null,limit=100} = {}) {
    if(state!=null&&!['open','adjudicating','resolved','dismissed'].includes(state)) throw new Error('Invalid conflict state');
    const rows=state?this.db.prepare('SELECT id FROM conflict_groups WHERE state=? ORDER BY created_at DESC LIMIT ?').all(state,bounded(limit,100)):
      this.db.prepare('SELECT id FROM conflict_groups ORDER BY created_at DESC LIMIT ?').all(bounded(limit,100));
    return rows.map(row=>this.getConflictGroup(row.id));
  }
  openConflictReview({memories=[],reasonCode='needs_review',route={},correlationId=randomUUID()}) {
    if(!Array.isArray(memories)||memories.length<2) throw new Error('Conflict review requires at least two memories');
    return this.transaction(()=>{
      const current=memories.map(item=>this.getMemory(item.id,{includeInactive:false}));
      if(current.some((item,index)=>!item||item.status!=='active'||item.version!==memories[index].version)) throw Object.assign(new Error('Conflict member version changed'),{code:'CONFLICT_STALE'});
      if(current.some(item=>item.scope!==current[0].scope||item.projectId!==current[0].projectId)) throw Object.assign(new Error('Conflict members must share scope'),{code:'CONFLICT_SCOPE'});
      const stamp=this.clock(),shareKey=current.every(item=>item.factKey===current[0].factKey)?current[0].factKey:null,id=randomUUID();
      this.db.prepare(`INSERT INTO conflict_groups(id,scope,project_id,fact_key,state,reason_code,provider,model,reasoning_effort,effort_source,model_policy,timeout_ms,config_hash,created_at,updated_at)
        VALUES(?,?,?,?, 'open',?,?,?,?,?,?,?,?,?,?)`).run(id,current[0].scope,current[0].projectId,shareKey,reasonCode,route.provider??null,route.model??null,route.reasoningEffort??null,
        route.effortSource??null,route.modelPolicy??null,Number.isInteger(route.timeoutMs)?route.timeoutMs:null,route.configHash??null,stamp,stamp);
      for(const item of current) {
        this.db.prepare('INSERT OR IGNORE INTO conflict_members VALUES(?,?,?,?,?,?)').run(id,'memory',item.id,item.version,'existing',stamp);
        this.db.prepare("UPDATE memories SET review_state='pending' WHERE id=?").run(item.id);
        this.recordDecision({memoryId:item.id,decisionType:'consolidation_hold',fromVersion:item.version,toVersion:item.version,sourceRefs:this._sourceRefs(item.sources),
          algorithmVersion:'jiyi-consolidation-v1',provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort,configHash:route.configHash,
          evidenceCount:item.sources.length,outcome:'held',reasonCode,shortReason:'离线巩固结果需要人工复核',correlationId});
      }
      return this.getConflictGroup(id);
    });
  }
  claimConflictGroups({limit=1,leaseMs=60000}={}) {
    bounded(limit,1,20);
    if(!Number.isInteger(leaseMs)||leaseMs<1||leaseMs>3600000) throw new Error('Invalid lease');
    return this.transaction(()=>{
      const stamp=this.clock();
      this.db.prepare("UPDATE conflict_groups SET state=CASE WHEN attempts>=max_attempts THEN 'open' ELSE 'open' END,token=NULL,lease_until=NULL,updated_at=? WHERE state='adjudicating' AND lease_until<=?")
        .run(stamp,stamp);
      const rows=this.db.prepare(`SELECT g.id FROM conflict_groups g WHERE g.state='open' AND (g.lease_until IS NULL OR g.lease_until<=?)
        AND g.attempts<g.max_attempts AND g.provider IS NOT NULL AND g.model IS NOT NULL
        AND (SELECT count(*) FROM conflict_members cm JOIN memory_candidates mc ON mc.id=cm.member_id
          WHERE cm.group_id=g.id AND cm.member_kind='candidate' AND mc.state='pending')=1
        ORDER BY g.created_at LIMIT ?`)
        .all(stamp,bounded(limit,1,20));
      for(const row of rows) this.db.prepare("UPDATE conflict_groups SET state='adjudicating',attempts=attempts+1,token=?,lease_until=?,updated_at=? WHERE id=?").run(randomUUID(),new Date(Date.parse(stamp)+leaseMs).toISOString(),stamp,row.id);
      return rows.map(row=>this.getConflictGroup(row.id));
    });
  }
  releaseConflictGroup(id,error,token=null) {
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT state,token,lease_until,attempts,max_attempts FROM conflict_groups WHERE id=?').get(id);
      if(!row) throw new Error('Conflict group not found');
      if(row.state==='adjudicating'&&(!token||token!==row.token||row.lease_until<=this.clock())) throw Object.assign(new Error('Conflict lease lost'),{code:'CONFLICT_LEASE_LOST'});
      this.db.prepare("UPDATE conflict_groups SET state='open',token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=?").run(String(error?.message??error).slice(0,2000),this.clock(),id);
      return this.getConflictGroup(id);
    });
  }
  resolveConflict({groupId,candidateId=null,decision,correlationId=randomUUID(),route={},confidence=null,conflictScore=null,token=null}) {
    oneOf(decision,['same_claim_newer','distinct_claims','temporal_change','unresolved'],'conflict decision');
    return this.transaction(()=>{
      const group=this.getConflictGroup(groupId);
      if(!group||!['open','adjudicating'].includes(group.state)) throw Object.assign(new Error('Conflict group is not open'),{code:'CONFLICT_STALE'});
      if(group.state==='adjudicating'&&(!token||token!==group.token||group.leaseUntil<=this.clock())) throw Object.assign(new Error('Conflict lease lost'),{code:'CONFLICT_LEASE_LOST'});
      if(decision==='unresolved') return group;
      const pendingCandidates=group.members.filter(item=>item.kind==='candidate'&&item.candidate?.state==='pending');
      if(candidateId!=null&&!pendingCandidates.some(item=>item.id===candidateId)) throw Object.assign(new Error('Conflict candidate is no longer pending'),{code:'CONFLICT_STALE'});
      if(pendingCandidates.length>1&&candidateId==null) throw Object.assign(new Error('Conflict group has multiple candidates; select one candidate'),{code:'CONFLICT_CANDIDATE_REQUIRED'});
      const member=candidateId==null?pendingCandidates[0]:pendingCandidates.find(item=>item.id===candidateId);
      if(!member?.candidate?.memory) {
        if(decision!=='distinct_claims') throw Object.assign(new Error('Open conflict has no applicable candidate'),{code:'CONFLICT_NO_CANDIDATE'});
        const stamp=this.clock();this.db.prepare("UPDATE conflict_groups SET state='resolved',resolution='distinct_claims',token=NULL,lease_until=NULL,resolved_at=?,updated_at=? WHERE id=?").run(stamp,stamp,groupId);
        for(const item of group.members.filter(item=>item.kind==='memory')) this._syncReviewState(item.id);
        return this.getConflictGroup(groupId);
      }
      const candidate=member.candidate,memory=candidate.memory,originals=candidate.conflictMemoryIds.map(id=>this.getMemory(id,{includeInactive:false}));
      if(originals.some(item=>!item||item.status!=='active'||item.version!==group.members.find(m=>m.kind==='memory'&&m.id===item.id)?.version)) throw Object.assign(new Error('Conflict member version changed'),{code:'CONFLICT_STALE'});
      const replacement=decision==='same_claim_newer'||decision==='temporal_change';
      const sameKeyMembers=memory.factKey==null?[]:originals.filter(item=>item.factKey===memory.factKey);
      if(!replacement&&sameKeyMembers.length) throw Object.assign(new Error('Same fact key requires replacement, not coexistence'),{code:'CONFLICT_KEY_REQUIRES_REPLACEMENT'});
      let saved=null;
      if(replacement) {
        saved=this.putMemory({...memory,supersedes:originals.map(item=>item.id),relation:'corrects',reviewState:'clear',decision:{...route,reasonCode:'conflict_resolved',shortReason:decision,correlationId,confidence,conflictScore}},{conflictGroupId:groupId});
      } else {
        const stamp=this.clock();this.db.prepare("UPDATE conflict_groups SET state='resolved',resolution=?,token=NULL,lease_until=NULL,last_error=NULL,resolved_at=?,updated_at=? WHERE id=?").run(decision,stamp,stamp,groupId);
        for(const item of originals) this._syncReviewState(item.id);
        saved=this.putMemory({...memory,reviewState:'clear',decision:{...route,reasonCode:'distinct_claims',shortReason:'裁决为不同事实',correlationId,confidence,conflictScore}});
      }
      const stamp=this.clock();
      this.db.prepare("UPDATE memory_candidates SET state='applied',payload='{\"redacted\":true}',updated_at=? WHERE id=?").run(stamp,member.id);
      for(const other of pendingCandidates.filter(item=>item.id!==member.id)) {
        this.db.prepare("UPDATE memory_candidates SET state='rejected',payload='{\"redacted\":true}',updated_at=? WHERE id=?").run(stamp,other.id);
        this.recordDecision({memoryId:originals[0]?.id??saved?.id,decisionType:'adjudication_rejected',fromVersion:originals[0]?.version??null,toVersion:saved?.version??null,
          sourceRefs:[],algorithmVersion:'jiyi-adjudication-v1',provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort,configHash:route.configHash,
          evidenceCount:0,outcome:'rejected',reasonCode:'alternative_candidate_rejected',shortReason:'用户选择另一个冲突候选，本候选未采用',correlationId});
      }
      this.db.prepare("UPDATE conflict_groups SET state='resolved',resolution=?,token=NULL,lease_until=NULL,last_error=NULL,resolved_at=?,updated_at=? WHERE id=?").run(decision,stamp,stamp,groupId);
      this._syncReviewState(saved.id);
      for(const item of originals) this._syncReviewState(item.id);
      return {group:this.getConflictGroup(groupId),memory:saved};
    });
  }
  recordRecallFeedback({recallId,requestId,memoryId,memoryVersion,kind,origin='ui',source=null,confidence=null,expectedSessionId=null}) {
    oneOf(kind,FEEDBACK_KINDS,'feedback kind');oneOf(origin,['user','model','ui'],'feedback origin');
    return this.transaction(()=>{
      const recall=this.db.prepare('SELECT * FROM recall_ledger WHERE id=? AND request_id=?').get(recallId,requestId);
      if(!recall) throw Object.assign(new Error('Recall record not found'),{code:'RECALL_NOT_FOUND'});
      if(expectedSessionId!=null&&recall.session_id!==expectedSessionId) throw Object.assign(new Error('Recall belongs to another session'),{code:'FEEDBACK_SESSION_MISMATCH'});
      if(recall.status!=='injected'&&origin!=='model') throw Object.assign(new Error('Feedback requires an actually injected recall'),{code:'FEEDBACK_NOT_INJECTED'});
      const refs=decode(recall.memory_refs)??[];
      if(!refs.some(ref=>ref.id===memoryId&&ref.version===memoryVersion)) {
        if(refs.some(ref=>ref.id===memoryId)) throw Object.assign(new Error('Feedback version is stale'),{code:'FEEDBACK_STALE'});
        throw Object.assign(new Error('Memory was not recalled by this request'),{code:'FEEDBACK_NOT_RECALLED'});
      }
      const memory=this.getMemory(memoryId,{includeInactive:false});
      if(!memory||memory.version!==memoryVersion) throw Object.assign(new Error('Feedback version is stale'),{code:'FEEDBACK_STALE'});
      const id=randomUUID(),stamp=this.clock();
      const sourceEvent=source?{sessionId:source.sessionId,eventId:source.eventId,eventSeq:source.eventSeq??null,eventTime:source.eventTime}:
        {sessionId:origin==='ui'?`jiyi-feedback:${memoryId}`:null,eventId:null,eventSeq:null,eventTime:null};
      this.db.prepare(`INSERT OR IGNORE INTO recall_feedback(id,recall_ledger_id,request_id,session_id,memory_id,memory_version,source_session_id,source_event_id,source_event_seq,source_event_time,feedback_kind,origin,confidence,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,recallId,requestId,recall.session_id,memoryId,memoryVersion,sourceEvent.sessionId,sourceEvent.eventId,sourceEvent.eventSeq,sourceEvent.eventTime,kind,origin,confidence,stamp);
      const row=this.db.prepare('SELECT id FROM recall_feedback WHERE recall_ledger_id=? AND memory_id=? AND feedback_kind=? AND origin=?').get(recallId,memoryId,kind,origin);
      if(kind==='explicit_wrong'&&origin!=='model') {
        this.db.prepare("UPDATE memories SET review_state='pending' WHERE id=? AND status='active'").run(memoryId);
        let group=this.db.prepare("SELECT * FROM conflict_groups WHERE scope=? AND project_id IS ? AND fact_key=? AND state IN ('open','adjudicating') LIMIT 1").get(memory.scope,memory.projectId,memory.factKey);
        if(!group) {
          const groupId=randomUUID();this.db.prepare(`INSERT INTO conflict_groups(id,scope,project_id,fact_key,state,reason_code,created_at,updated_at) VALUES(?,?,?,?, 'open','explicit_wrong',?,?)`).run(groupId,memory.scope,memory.projectId,memory.factKey,stamp,stamp);
          group=this.db.prepare('SELECT * FROM conflict_groups WHERE id=?').get(groupId);
        }
        this.db.prepare('INSERT OR IGNORE INTO conflict_members VALUES(?,?,?,?,?,?)').run(group.id,'memory',memoryId,memoryVersion,'existing',stamp);
        this.recordDecision({memoryId,decisionType:'feedback_review',fromVersion:memoryVersion,toVersion:memoryVersion,sourceRefs:this._sourceRefs([source].filter(Boolean)),
          evidenceCount:source?1:0,outcome:'held',reasonCode:'explicit_wrong',shortReason:'用户标记召回错误，等待纠正',correlationId:id});
      }
      return this.db.prepare('SELECT * FROM recall_feedback WHERE id=?').get(row.id);
    });
  }
  listRecallFeedback({recallId=null,memoryId=null,limit=100}={}) {
    const rows=recallId?this.db.prepare('SELECT * FROM recall_feedback WHERE recall_ledger_id=? ORDER BY created_at DESC LIMIT ?').all(recallId,bounded(limit,100)):
      memoryId?this.db.prepare('SELECT * FROM recall_feedback WHERE memory_id=? ORDER BY created_at DESC LIMIT ?').all(memoryId,bounded(limit,100)):
      this.db.prepare('SELECT * FROM recall_feedback ORDER BY created_at DESC LIMIT ?').all(bounded(limit,100));
    return rows.map(row=>({id:row.id,recallId:row.recall_ledger_id,requestId:row.request_id,sessionId:row.session_id,memoryId:row.memory_id,memoryVersion:row.memory_version,
      source:{sessionId:row.source_session_id,eventId:row.source_event_id,eventSeq:row.source_event_seq,eventTime:row.source_event_time},kind:row.feedback_kind,origin:row.origin,confidence:row.confidence,createdAt:row.created_at}));
  }
  enqueueConsolidation({idempotencyKey,payload,maxAttempts=3}) {
    required(idempotencyKey,'Consolidation idempotencyKey');bounded(maxAttempts,3,5);const stamp=this.clock(),id=randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO consolidation_jobs(id,idempotency_key,state,attempts,max_attempts,available_at,payload,created_at,updated_at) VALUES(?,?, 'pending',0,?,?,?,?,?)").run(id,idempotencyKey,maxAttempts,stamp,JSON.stringify(payload??{}),stamp,stamp);
    return this.getConsolidationJob(this.db.prepare('SELECT id FROM consolidation_jobs WHERE idempotency_key=?').get(idempotencyKey).id);
  }
  getConsolidationJob(id) {
    const row=this.db.prepare('SELECT * FROM consolidation_jobs WHERE id=?').get(id);if(!row)return null;
    return {id:row.id,idempotencyKey:row.idempotency_key,state:row.state,attempts:row.attempts,maxAttempts:row.max_attempts,availableAt:row.available_at,leaseUntil:row.lease_until,token:row.token,
      payload:decode(row.payload),result:decode(row.result),lastError:row.last_error,failure:decode(row.failure),attemptHistory:decode(row.attempt_history)??[],createdAt:row.created_at,updatedAt:row.updated_at};
  }
  claimConsolidationJobs({limit=1,leaseMs=60000}={}) {
    bounded(limit,1,20);if(!Number.isInteger(leaseMs)||leaseMs<1||leaseMs>3600000)throw new Error('Invalid lease');
    return this.transaction(()=>{const stamp=this.clock();
      this.db.prepare("UPDATE consolidation_jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,token=NULL,lease_until=NULL,last_error='Lease expired',updated_at=? WHERE state='running' AND lease_until<=?").run(stamp,stamp);
      const ids=this.db.prepare("SELECT id FROM consolidation_jobs WHERE state='pending' AND attempts<max_attempts AND available_at<=? ORDER BY created_at,rowid LIMIT ?").all(stamp,bounded(limit,1,20));
      for(const row of ids)this.db.prepare("UPDATE consolidation_jobs SET state='running',attempts=attempts+1,token=?,lease_until=?,updated_at=? WHERE id=?").run(randomUUID(),new Date(Date.parse(stamp)+leaseMs).toISOString(),stamp,row.id);
      return ids.map(row=>this.getConsolidationJob(row.id));
    });
  }
  _ownedConsolidationJob(id,token) {
    const job=this.getConsolidationJob(id);
    if(!job||job.state!=='running'||!token||job.token!==token||!job.leaseUntil||Date.parse(job.leaseUntil)<=Date.parse(this.clock()))
      throw Object.assign(new Error('Consolidation lease lost'),{code:'CONSOLIDATION_LEASE_LOST'});
    return job;
  }
  completeConsolidationJob(id,token,result={}) {
    return this.transaction(()=>{this._ownedConsolidationJob(id,token);
      this.db.prepare("UPDATE consolidation_jobs SET state='done',token=NULL,lease_until=NULL,result=?,last_error=NULL,failure=NULL,updated_at=? WHERE id=?").run(JSON.stringify(result),this.clock(),id);return this.getConsolidationJob(id);});
  }
  failConsolidationJob(id,token,error,{retryDelayMs=60000,terminal=false,failure=null}={}) {
    if(!Number.isInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>3600000)throw new Error('Invalid retry delay');
    return this.transaction(()=>{const job=this._ownedConsolidationJob(id,token);
      const stamp=this.clock(),state=terminal||job.attempts>=job.maxAttempts?'failed':'pending',at=new Date(Date.parse(stamp)+retryDelayMs).toISOString();
      const history=[...(job.attemptHistory??[]),{attempt:job.attempts,state,error:String(error?.message??error).slice(0,2000),failure,retryDelayMs,at:stamp,nextAt:state==='pending'?at:null}].slice(-20);
      this.db.prepare('UPDATE consolidation_jobs SET state=?,available_at=?,token=NULL,lease_until=NULL,last_error=?,failure=?,attempt_history=?,updated_at=? WHERE id=?').run(state,at,String(error?.message??error).slice(0,2000),failure?JSON.stringify(failure):null,JSON.stringify(history),stamp,id);return this.getConsolidationJob(id);});
  }
  listConsolidationJobs({limit=100}={}) {return this.db.prepare('SELECT id FROM consolidation_jobs ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(bounded(limit,100)).map(row=>this.getConsolidationJob(row.id));}

  enqueueEvent({sessionId,eventId,eventSeq,eventTime,projectId=null,payload,maxAttempts=3}) {
    required(sessionId,'Event sessionId');
    const event = required(String(eventId ?? eventSeq ?? ''),'Event id');
    required(eventTime,'Event time');
    bounded(maxAttempts,3,10);
    if (eventSeq != null && (!Number.isSafeInteger(eventSeq) || eventSeq < 0)) throw new Error('Invalid eventSeq');
    const stamp = this.clock();
    const id = randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO queue(id,session_id,event_id,event_seq,event_time,project_id,payload,state,max_attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(id,sessionId,event,eventSeq ?? null,eventTime,projectId,JSON.stringify(payload ?? {}),maxAttempts,stamp,stamp,stamp);
    return this.getJob(this.db.prepare('SELECT id FROM queue WHERE session_id=? AND event_id=?').get(sessionId,event).id);
  }
  getJob(id) {
    const r = this.db.prepare('SELECT * FROM queue WHERE id=?').get(id);
    return r ? {id:r.id,sessionId:r.session_id,eventId:r.event_id,eventSeq:r.event_seq,eventTime:r.event_time,projectId:r.project_id,payload:decode(r.payload),state:r.state,attempts:r.attempts,maxAttempts:r.max_attempts,availableAt:r.available_at,leaseUntil:r.lease_until,token:r.token,lastError:r.last_error,failure:decode(r.failure),attemptHistory:decode(r.attempt_history)??[],createdAt:r.created_at,updatedAt:r.updated_at} : null;
  }
  listJobs({limit=100} = {}) {
    return this.db.prepare('SELECT id FROM queue ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(bounded(limit,100)).map(r=>this.getJob(r.id));
  }
  listFailedJobs({limit=100,offset=0} = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    return this.db.prepare("SELECT id FROM queue WHERE state='failed' ORDER BY updated_at DESC,rowid DESC LIMIT ? OFFSET ?").all(bounded(limit,100,100),offset).map(r=>this.getJob(r.id));
  }
  retryJob(id) {
    return this.transaction(() => {
      const stamp = this.clock();
      const result = this.db.prepare("UPDATE queue SET state='pending',attempts=0,available_at=?,lease_until=NULL,token=NULL,last_error=NULL,failure=NULL,updated_at=? WHERE id=? AND state='failed'").run(stamp,stamp,id);
      if (!result.changes) throw new Error('Only failed jobs can be retried');
      return this.getJob(id);
    });
  }
  claimJobs({limit=1,leaseMs=60000} = {}) {
    bounded(limit,1,100);
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000) throw new Error('Invalid lease');
    return this.transaction(() => {
      const stamp = this.clock();
      for(const expired of this.db.prepare("SELECT id,attempts,attempt_history FROM queue WHERE state='running' AND lease_until<=?").all(stamp)) {
        const state=expired.attempts>=this.getJob(expired.id).maxAttempts?'failed':'pending';
        const failure={code:'LEASE_EXPIRED',category:'worker_lease',retryable:true,stage:'queue',message:'Worker lease expired',requestId:null,at:stamp};
        const history=[...(decode(expired.attempt_history)??[]),{attempt:expired.attempts,state,error:failure.message,failure,retryDelayMs:0,at:stamp,nextAt:null}].slice(-20);
        this.db.prepare('UPDATE queue SET state=?,token=NULL,lease_until=NULL,last_error=?,failure=?,attempt_history=?,updated_at=? WHERE id=?').run(state,failure.message,JSON.stringify(failure),JSON.stringify(history),stamp,expired.id);
      }
      const ids = this.db.prepare("SELECT id FROM queue WHERE state='pending' AND attempts<max_attempts AND available_at<=? ORDER BY created_at,rowid LIMIT ?").all(stamp,limit);
      for (const {id} of ids) this.db.prepare("UPDATE queue SET state='running',attempts=attempts+1,token=?,lease_until=?,updated_at=? WHERE id=?").run(randomUUID(),new Date(Date.parse(stamp)+leaseMs).toISOString(),stamp,id);
      return ids.map(({id})=>this.getJob(id));
    });
  }
  _ownedJob(id,token) {
    const job = this.getJob(id);
    if (!job || job.state !== 'running' || !token || job.token !== token || job.leaseUntil <= this.clock()) throw new Error('Queue lease lost');
    return job;
  }
  completeJob(id,token,{memories=[],cursor} = {}) {
    return this.transaction(() => {
      const job = this._ownedJob(id,token);
      const saved = memories.map(memory=>this.putMemory(memory));
      if (cursor) this.setCursor(cursor.key,cursor.value);
      const retained=job.payload?.kind?{kind:job.payload.kind}:{};
      this.db.prepare("UPDATE queue SET state='done',token=NULL,lease_until=NULL,last_error=NULL,failure=NULL,payload=?,updated_at=? WHERE id=?").run(JSON.stringify(retained),this.clock(),id);
      return {job:this.getJob(job.id),memories:saved};
    });
  }
  failJob(id,token,error,{retryDelayMs=1000,terminal=false,failure=null} = {}) {
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 3600000) throw new Error('Invalid retry delay');
    return this.transaction(() => {
      const job = this._ownedJob(id,token);
      const stamp = this.clock();
      const state=terminal||job.attempts>=job.maxAttempts?'failed':'pending';
      const availableAt=new Date(Date.parse(stamp)+retryDelayMs).toISOString();
      const attempt={attempt:job.attempts,state,error:String(error?.message ?? error).slice(0,2000),failure,retryDelayMs,at:stamp,nextAt:state==='pending'?availableAt:null};
      const history=[...(job.attemptHistory??[]),attempt].slice(-20);
      this.db.prepare('UPDATE queue SET state=?,available_at=?,token=NULL,lease_until=NULL,last_error=?,failure=?,attempt_history=?,updated_at=? WHERE id=?').run(state,availableAt,String(error?.message ?? error).slice(0,2000),failure?JSON.stringify(failure):null,JSON.stringify(history),stamp,id);
      return this.getJob(id);
    });
  }
  deferJob(id,token,error,{retryDelayMs=60000} = {}) {
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1000 || retryDelayMs > 3600000) throw new Error('Invalid defer delay');
    return this.transaction(() => {
      const job = this._ownedJob(id,token),stamp = this.clock();
      const availableAt=new Date(Date.parse(stamp)+retryDelayMs).toISOString();
      const failure={code:String(error?.code??'TASK_CONTROL'),category:'paused',retryable:false,stage:'queue',message:String(error?.message??error).slice(0,1900),requestId:null,at:stamp};
      const history=[...(job.attemptHistory??[]),{attempt:job.attempts,state:'pending',error:failure.message,failure,retryDelayMs,at:stamp,nextAt:availableAt}].slice(-20);
      this.db.prepare("UPDATE queue SET state='pending',attempts=attempts-1,available_at=?,token=NULL,lease_until=NULL,last_error=?,failure=?,attempt_history=?,updated_at=? WHERE id=?")
        .run(availableAt,String(error?.code ?? 'TASK_CONTROL')+': '+String(error?.message ?? error).slice(0,1900),JSON.stringify(failure),JSON.stringify(history),stamp,id);
      return this.getJob(job.id);
    });
  }
  releaseJob(id,token,error) {
    return this.transaction(() => {
      const job=this._ownedJob(id,token),stamp=this.clock();
      const failure={code:'HOST_STOPPED',category:'host_shutdown',retryable:false,stage:'lifecycle',message:String(error?.message??error).slice(0,1900),requestId:null,at:stamp};
      const history=[...(job.attemptHistory??[]),{attempt:job.attempts,state:'pending',error:failure.message,failure,retryDelayMs:0,at:stamp,nextAt:stamp}].slice(-20);
      this.db.prepare("UPDATE queue SET state='pending',attempts=attempts-1,available_at=?,token=NULL,lease_until=NULL,last_error=?,failure=?,attempt_history=?,updated_at=? WHERE id=?")
        .run(stamp,`HOST_STOPPED: ${failure.message}`,JSON.stringify(failure),JSON.stringify(history),stamp,id);
      return this.getJob(job.id);
    });
  }
  _getValue(table,key) { return decode(this.db.prepare(`SELECT value FROM ${table} WHERE key=?`).get(key)?.value); }
  _setValue(table,key,value) {
    required(key,'Key');
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('Value must be JSON serializable');
    this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,json,this.clock());
    return value;
  }
  getCursor(key) { return this._getValue('cursors',key); }
  setCursor(key,value) { return this._setValue('cursors',key,value); }
  getMetadata(key) { return this._getValue('metadata',key); }
  setMetadata(key,value) { return this._setValue('metadata',key,value); }
  recordRecall({sessionId,requestId,status,memoryRefs=[],memories,details={}}) {
    required(sessionId,'Recall sessionId'); required(requestId,'Recall requestId');
    if (!['injected','empty','error','skipped','prepared'].includes(status)) throw new Error('Invalid recall status');
    const refs = memories?.map(m=>({id:m.id,version:m.version})) ?? memoryRefs;
    this.db.prepare(`INSERT INTO recall_ledger VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,request_id) DO UPDATE SET status=excluded.status,memory_refs=excluded.memory_refs,details=excluded.details,created_at=excluded.created_at`).run(randomUUID(),sessionId,requestId,status,JSON.stringify(refs),JSON.stringify(details),this.clock());
    return this.getRecallStatus(sessionId,requestId);
  }
  listRecalls({sessionId,limit=100} = {}) {
    const rows = sessionId == null
      ? this.db.prepare('SELECT * FROM recall_ledger ORDER BY created_at DESC,rowid DESC LIMIT ?').all(bounded(limit,100))
      : this.db.prepare('SELECT * FROM recall_ledger WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(sessionId,bounded(limit,100));
    return rows.map(r=>({id:r.id,sessionId:r.session_id,requestId:r.request_id,status:r.status,memoryRefs:decode(r.memory_refs),details:decode(r.details),createdAt:r.created_at}));
  }
  getRecallStats({now=Date.now()}={}) {
    const effective="COALESCE(json_extract(details,'$.status'),status)";
    const total=this.db.prepare('SELECT count(*) AS n FROM recall_ledger').get().n;
    const status={},failureStage={},errorCode={},latencies=[];
    for(const row of this.db.prepare(`SELECT ${effective} effective_status,count(*) count FROM recall_ledger GROUP BY effective_status`).all()) status[row.effective_status]=row.count;
    const cutoff=new Date(now-24*3600000).toISOString();
    const recent=this.db.prepare('SELECT count(*) AS n FROM recall_ledger WHERE created_at>=?').get(cutoff).n;
    const recentFailure=this.db.prepare(`SELECT count(*) AS n FROM recall_ledger WHERE created_at>=? AND ${effective} IN ('timeout','error','disabled','not-configured')`).get(cutoff).n;
    const percentile=(values,p)=>values.length?values[Math.max(0,Math.ceil(values.length*p)-1)]:null;
    for(const row of this.db.prepare(`SELECT ${effective} effective_status,details FROM recall_ledger WHERE ${effective} IN ('timeout','error','disabled','not-configured')`).all()) {
        const details=decode(row.details)??{}, diagnostics=details.diagnostics??{};
        const events=Array.isArray(diagnostics.retrieve?.events)?diagnostics.retrieve.events:[];
        const failed=[...events].reverse().find(event=>['timeout','error','cancelled'].includes(event.status));
        const stage=['disabled','not-configured'].includes(row.effective_status)?'configuration':failed?.stage==='llm'?'relevance-llm':failed?.stage?failed.stage:diagnostics.failureStage??'unknown';
        failureStage[stage]=(failureStage[stage]??0)+1;
        const code=diagnostics.errorCode??'UNKNOWN';
        errorCode[code]=(errorCode[code]??0)+1;
    }
    for(const row of this.db.prepare("SELECT COALESCE(json_extract(details,'$.diagnostics.hostLatency.elapsedMs'),json_extract(details,'$.diagnostics.retrieve.elapsedMs')) elapsed FROM recall_ledger").all()) if(Number.isFinite(row.elapsed)&&row.elapsed>=0) latencies.push(row.elapsed);
    latencies.sort((a,b)=>a-b);
    return {total,last24h:{total:recent,failures:recentFailure},byStatus:status,byFailureStage:failureStage,byErrorCode:errorCode,latencyMs:{samples:latencies.length,p50:percentile(latencies,.5),p95:percentile(latencies,.95),max:latencies.at(-1)??null},note:'no-hit 是正常的零命中决策，不计为失败'};
  }
  getRecallStatus(sessionId,requestId) {
    const r = requestId ? this.db.prepare('SELECT * FROM recall_ledger WHERE session_id=? AND request_id=?').get(sessionId,requestId)
      : this.db.prepare('SELECT * FROM recall_ledger WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(sessionId);
    return r ? {id:r.id,sessionId:r.session_id,requestId:r.request_id,status:r.status,memoryRefs:decode(r.memory_refs),details:decode(r.details),createdAt:r.created_at} : null;
  }
  getStatus() {
    const count = (table,where='1') => this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
    return {schemaVersion:SCHEMA_VERSION,memories:count('memories',"status='active'"),vectors:count('vectors'),projects:count('projects'),
      review:{pending:count('memories',"status='active' AND review_state='pending'"),resolved:count('memories',"review_state='resolved'"),openConflicts:count('conflict_groups',"state IN ('open','adjudicating')")},
      feedback:count('recall_feedback','1'),evidence:count('memory_evidence','1'),decisions:count('memory_decisions','1'),
      consolidation:{pending:count('consolidation_jobs',"state='pending'"),running:count('consolidation_jobs',"state='running'"),failed:count('consolidation_jobs',"state='failed'"),done:count('consolidation_jobs',"state='done'")},
      queue:{pending:count('queue',"state='pending'"),running:count('queue',"state='running'"),failed:count('queue',"state='failed'"),done:count('queue',"state='done'")}};
  }
}
export const openStore = (filename,options) => new MemoryStore(filename,options);
