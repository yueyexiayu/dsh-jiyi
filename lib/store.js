import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve, isAbsolute, basename } from 'node:path';
import { logicalSnapshot, rowChanges } from './eval-integrity.js';

export const SCHEMA_VERSION = 1;
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
  constructor(filename, { clock = nowISO } = {}) {
    this.clock = clock;
    this.depth = 0;
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Unsupported jiyi schema ${version}`);
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS project_aliases(alias TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id));
          CREATE TABLE IF NOT EXISTS memories(
            id TEXT PRIMARY KEY,version INTEGER NOT NULL,content TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('global','project')),
            project_id TEXT REFERENCES projects(id),kind TEXT NOT NULL,fact_key TEXT,confidence REAL NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),sources TEXT NOT NULL,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL,superseded_by TEXT,extraction_model TEXT,extraction_version TEXT,
            CHECK((scope='global' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL)));
          CREATE INDEX IF NOT EXISTS memories_scope ON memories(status,scope,project_id);
          CREATE UNIQUE INDEX IF NOT EXISTS memories_active_key ON memories(scope,COALESCE(project_id,''),fact_key) WHERE status='active' AND fact_key IS NOT NULL;
          CREATE TABLE IF NOT EXISTS memory_versions(memory_id TEXT NOT NULL REFERENCES memories(id),version INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(memory_id,version));
          CREATE TABLE IF NOT EXISTS vectors(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,memory_version INTEGER NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,embedding TEXT NOT NULL,embedding_version TEXT);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED,content,tokenize='trigram');
          CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,event_id TEXT NOT NULL,event_seq INTEGER,event_time TEXT NOT NULL,
            project_id TEXT REFERENCES projects(id),payload TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed')),
            attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,available_at TEXT NOT NULL,lease_until TEXT,token TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
            UNIQUE(session_id,event_id));
          CREATE INDEX IF NOT EXISTS queue_ready ON queue(state,available_at);
          CREATE TABLE IF NOT EXISTS cursors(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS recall_ledger(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,
            memory_refs TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,request_id));
          PRAGMA user_version=1;
        `);
      });
    } catch (error) { this.db.close(); throw error; }
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
        if(/^\s*(?:COMMIT|END|SAVEPOINT\s+\w+|RELEASE(?:\s+SAVEPOINT)?\s+\w+|ROLLBACK(?:\s+TRANSACTION)?(?:\s+TO(?:\s+SAVEPOINT)?\s+\w+)?)\s*;?\s*$/iu.test(sql)) return record(sql,dirty,()=>target.exec(sql));
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
    const sources = decode(row.sources);
    return { id:row.id,version:row.version,content:row.content,scope:row.scope,projectId:row.project_id,kind:row.kind,type:row.kind,
      factKey:row.fact_key,key:row.fact_key,confidence:row.confidence,status:row.status,sources,source:sources[0] ?? null,
      createdAt:row.created_at,updatedAt:row.updated_at,supersededBy:row.superseded_by,
      extractionModel:row.extraction_model,extractionVersion:row.extraction_version,
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
  _invalidate(id, status, replacement = null) {
    this.db.prepare('UPDATE memories SET status=?,superseded_by=?,version=version+1,updated_at=? WHERE id=?').run(status,replacement,this.clock(),id);
    this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(id);
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(id);
    return this._snapshot(id);
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
      const factKey = input.factKey ?? input.key ?? current?.factKey ?? null;
      const latest = newestSource(normalized);
      if (current) assertFreshSources(normalized,current.sources);
      if (factKey != null) {
        const deleted = this.db.prepare("SELECT updated_at FROM memories WHERE status='deleted' AND scope=? AND project_id IS ? AND fact_key=?").all(scope,projectId,factKey);
        if (deleted.some(row => latest.time <= Date.parse(row.updated_at))) throw staleFact();
      }
      const supersedes = input.supersedes == null ? [] : Array.isArray(input.supersedes) ? input.supersedes : [input.supersedes];
      const conflicting = factKey == null ? [] : this.db.prepare("SELECT id FROM memories WHERE status='active' AND scope=? AND project_id IS ? AND fact_key=? AND id<>?").all(scope,projectId,factKey,id).map(r=>r.id);
      for (const oldId of new Set([...supersedes,...conflicting])) {
        const old = this.getMemory(oldId);
        if (!old || old.id === id || old.status !== 'active') throw new Error('Invalid superseded memory');
        if (old.scope !== scope || old.projectId !== projectId) throw new Error('Cannot supersede another scope/project');
        assertFreshSources(normalized,old.sources);
        this._invalidate(oldId,'superseded',id);
      }
      const stamp = this.clock();
      const version = (current?.version ?? 0) + 1;
      this.db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        version=excluded.version,content=excluded.content,kind=excluded.kind,fact_key=excluded.fact_key,confidence=excluded.confidence,sources=excluded.sources,updated_at=excluded.updated_at,
        extraction_model=excluded.extraction_model,extraction_version=excluded.extraction_version`).run(
        id,version,content,scope,projectId,input.kind ?? input.type ?? current?.kind ?? 'fact',factKey,confidence,'active',JSON.stringify(normalized),current?.createdAt ?? stamp,stamp,null,
        input.extractionModel ?? current?.extractionModel ?? null,input.extractionVersion ?? current?.extractionVersion ?? null);
      this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(id);
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(id);
      this.db.prepare('INSERT INTO memory_fts(memory_id,content) VALUES(?,?)').run(id,content);
      const embedding = options.vector ?? input.embedding;
      if (embedding != null) this.setEmbedding(id,embedding,options.model ?? input.embeddingModel,{expectedVersion:version,embeddingVersion:options.embeddingVersion ?? input.embeddingVersion});
      return this._snapshot(id);
    });
  }
  replaceMemory(id,input,options = {}) { return this.putMemory({...input,id,expectedVersion:options.expectedVersion ?? input.expectedVersion},options); }
  deleteMemory(id,{expectedVersion} = {}) {
    return this.transaction(() => {
      const current = this.getMemory(id);
      if (!current) throw new Error('Memory not found');
      if (expectedVersion != null && expectedVersion !== current.version) throw new Error('Memory version conflict');
      if (current.status === 'deleted') return current;
      const redactSources = sources => sources.map(({sessionId,eventId,eventSeq,eventTime}) => ({sessionId,eventId,eventSeq,eventTime}));
      this.db.prepare("UPDATE memories SET content='',sources=? WHERE id=?").run(JSON.stringify(redactSources(current.sources)),id);
      const tombstone = this._invalidate(id,'deleted');
      // Retain only source locators and historical version identities, never deleted text/quotes/vectors.
      for (const row of this.db.prepare('SELECT version,snapshot FROM memory_versions WHERE memory_id=?').all(id)) {
        const old = decode(row.snapshot);
        const redacted = {...old,content:'',sources:redactSources(old.sources),embedding:null,embeddingModel:null,embeddingVersion:null,status:'deleted'};
        redacted.source = redacted.sources[0] ?? null;
        this.db.prepare('UPDATE memory_versions SET snapshot=? WHERE memory_id=? AND version=?').run(JSON.stringify(redacted),id,row.version);
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
  listMemories({projectId,scope,includeGlobal=true,includeInactive=false,limit=500,offset=0} = {}) {
    if (scope != null && !['global','project'].includes(scope)) throw new Error('Invalid scope');
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const clauses = [], args = [];
    if (!includeInactive) clauses.push("status='active'");
    if (scope === 'global' || !projectId) clauses.push("scope='global'");
    else if (scope === 'project' || !includeGlobal) { clauses.push("scope='project' AND project_id=?"); args.push(projectId); }
    else { clauses.push("(scope='global' OR (scope='project' AND project_id=?))"); args.push(projectId); }
    if (scope === 'project' && !projectId) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args,bounded(limit,500),offset).map(r=>this._record(r));
  }
  listAllMemories({includeInactive=false,limit=500,offset=0} = {}) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
    return this.db.prepare(`SELECT * FROM memories ${includeInactive ? '' : "WHERE status='active'"} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(bounded(limit,500),offset).map(r=>this._record(r));
  }
  listCandidates(options = {}) { return this.listMemories({...options,includeInactive:false,limit:options.limit ?? 2000}); }
  searchText(query,{projectId,scope,includeGlobal=true,limit=100} = {}) {
    const text = required(query,'Search query');
    const terms = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    // Quote literals so user text is never interpreted as FTS operators.
    const match = terms.filter(t=>[...t].length >= 3).map(t=>`"${t.replaceAll('"','""')}"`).join(' OR ');
    const allowed = this.listCandidates({projectId,scope,includeGlobal,limit:10000});
    if (!match) return allowed.filter(r=>r.content.toLocaleLowerCase().includes(text.toLocaleLowerCase())).slice(0,bounded(limit,100)).map(r=>({...r,textScore:1}));
    const scores = new Map(this.db.prepare('SELECT memory_id,bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank').all(match).map(r=>[r.memory_id,-r.rank]));
    return allowed.filter(r=>scores.has(r.id)).map(r=>({...r,textScore:scores.get(r.id)})).sort((a,b)=>b.textScore-a.textScore).slice(0,bounded(limit,100));
  }

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
    return r ? {id:r.id,sessionId:r.session_id,eventId:r.event_id,eventSeq:r.event_seq,eventTime:r.event_time,projectId:r.project_id,payload:decode(r.payload),state:r.state,attempts:r.attempts,maxAttempts:r.max_attempts,availableAt:r.available_at,leaseUntil:r.lease_until,token:r.token,lastError:r.last_error,createdAt:r.created_at,updatedAt:r.updated_at} : null;
  }
  listJobs({limit=100} = {}) {
    return this.db.prepare('SELECT id FROM queue ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(bounded(limit,100)).map(r=>this.getJob(r.id));
  }
  retryJob(id) {
    return this.transaction(() => {
      const stamp = this.clock();
      const result = this.db.prepare("UPDATE queue SET state='pending',attempts=0,available_at=?,lease_until=NULL,token=NULL,last_error=NULL,updated_at=? WHERE id=? AND state='failed'").run(stamp,stamp,id);
      if (!result.changes) throw new Error('Only failed jobs can be retried');
      return this.getJob(id);
    });
  }
  claimJobs({limit=1,leaseMs=60000} = {}) {
    bounded(limit,1,100);
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000) throw new Error('Invalid lease');
    return this.transaction(() => {
      const stamp = this.clock();
      this.db.prepare("UPDATE queue SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,token=NULL,lease_until=NULL,last_error='Worker lease expired',updated_at=? WHERE state='running' AND lease_until<=?").run(stamp,stamp);
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
      this.db.prepare("UPDATE queue SET state='done',token=NULL,lease_until=NULL,last_error=NULL,payload='{}',updated_at=? WHERE id=?").run(this.clock(),id);
      return {job:this.getJob(job.id),memories:saved};
    });
  }
  failJob(id,token,error,{retryDelayMs=1000} = {}) {
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 3600000) throw new Error('Invalid retry delay');
    return this.transaction(() => {
      const job = this._ownedJob(id,token);
      const stamp = this.clock();
      this.db.prepare('UPDATE queue SET state=?,available_at=?,token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=?').run(job.attempts>=job.maxAttempts?'failed':'pending',new Date(Date.parse(stamp)+retryDelayMs).toISOString(),String(error?.message ?? error).slice(0,2000),stamp,id);
      return this.getJob(id);
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
  getRecallStatus(sessionId,requestId) {
    const r = requestId ? this.db.prepare('SELECT * FROM recall_ledger WHERE session_id=? AND request_id=?').get(sessionId,requestId)
      : this.db.prepare('SELECT * FROM recall_ledger WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(sessionId);
    return r ? {id:r.id,sessionId:r.session_id,requestId:r.request_id,status:r.status,memoryRefs:decode(r.memory_refs),details:decode(r.details),createdAt:r.created_at} : null;
  }
  getStatus() {
    const count = (table,where='1') => this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
    return {schemaVersion:SCHEMA_VERSION,memories:count('memories',"status='active'"),vectors:count('vectors'),projects:count('projects'),
      queue:{pending:count('queue',"state='pending'"),running:count('queue',"state='running'"),failed:count('queue',"state='failed'"),done:count('queue',"state='done'")}};
  }
}
export const openStore = (filename,options) => new MemoryStore(filename,options);
