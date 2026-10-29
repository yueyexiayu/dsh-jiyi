import { createLatencyTrace } from './models.js';
import { retrieve } from './retrieve.js';
import { textOf } from './extract.js';
import { normalizeProjectLabel } from './store.js';

const fail = (message, code = 'INVALID_ARGS') => Object.assign(new Error(message), { code });
const errorText = e => `${e?.code ? `${e.code}: ` : ''}${e?.message ?? e}`.slice(0, 2000);

// The same search implementation serves production and isolated evaluation.
// All persistence is through the explicitly supplied store. No global/session state.
export async function searchMemories({ query, store, settings, models, relevance, resolveCurrentProject = () => null, lifetimeSignal, signal, scope = 'auto', deadlineAt, readOnly = false, onEvaluationDiagnostic, budgetSessionId }) {
  if (!settings.enabled) return {status:'disabled',memories:[],ambiguities:[]};
  if (!query?.trim()) return {status:'skipped',memories:[],ambiguities:[]};
  if (models.getStatus().status==='not-configured') return {status:'not-configured',memories:[],ambiguities:[],error:'Embedding 未配置'};
  if (relevance.getStatus().status==='not-configured') return {status:'not-configured',memories:[],ambiguities:[],error:'相关性判别模型未配置'};
  const expiresAt=deadlineAt??performance.now()+settings.retrieval.timeoutMs;
  const remainingMs=()=>Math.max(1,Math.ceil(expiresAt-performance.now()));
  const deadline=AbortSignal.timeout(remainingMs());
  const combined=AbortSignal.any([deadline,...lifetimeSignal?[lifetimeSignal]:[],...signal?[signal]:[]]);
  const ensureActive=()=>{
    combined.throwIfAborted();
    if(performance.now()>=expiresAt) throw fail('召回截止时间已到','RETRIEVAL_TIMEOUT');
  };
  const events=[];
  const onDiagnostic=event=>{if(events.length<512) events.push(structuredClone(event));};
  const trace=createLatencyTrace('host-search',onDiagnostic);
  trace.begin('scopePreparation');
  try {
    ensureActive();
    const current = resolveCurrentProject();
    const projects = store.listProjects();
    const labels = new Map(),normalizedQuery=normalizeProjectLabel(query);
    const explicitlyIdentified=p=>query.includes(p.path)||query.includes(p.id);
    for(const p of projects) for(const raw of new Set([p.name,...p.aliases,...(p.aliasConflict?[p.aliasConflict]:[])])) {
      const label=normalizeProjectLabel(raw);
      if(label.length<2 || !normalizedQuery.includes(label)) continue;
      if(!labels.has(label)) labels.set(label,new Map());
      labels.get(label).set(p.id,p);
    }
    const ambiguousNames=[...labels].filter(([,matches])=>matches.size>1 && ![...matches.values()].some(explicitlyIdentified)).map(([label])=>label);
    const explicitProjectIds=[...new Set([...labels].flatMap(([label,matches])=>ambiguousNames.includes(label)?[]:[...matches.values()].filter(p=>matches.size===1 || explicitlyIdentified(p)).map(p=>p.id)))];
    let records = [...store.listCandidates({projectId:current?.id,limit:2000}),...store.searchText(query,{projectId:current?.id,limit:100})];
    for (const id of explicitProjectIds) records.push(...store.listCandidates({projectId:id,includeGlobal:false}),...store.searchText(query,{projectId:id,includeGlobal:false,limit:100}));
    records = [...new Map(records.map(m=>[m.id,m])).values()];
    if (scope==='global') records=records.filter(m=>m.scope==='global');
    else if (scope!=='auto' && scope!=='all') {
      if (!projects.some(p=>p.id===scope)) throw fail('未知项目范围');
      records=store.listCandidates({projectId:scope,includeGlobal:false}); explicitProjectIds.push(scope);
    } else if (scope==='all') { records=store.listAllMemories({limit:10000}); explicitProjectIds.push(...projects.map(p=>p.id)); }
    ensureActive();
    trace.begin('retrieve',{recordCount:records.length});
    try {
      const projectId = !['auto','all','global'].includes(scope) ? scope : current?.id;
      const projectLabels = Object.fromEntries(projects.map(p=>[p.id,p.name]));
      onEvaluationDiagnostic?.({ stage: 'search-scope', requestedScope: scope, currentProject: current ? { id: current.id, name: current.name, path: current.path } : null, projectId: projectId ?? null, explicitProjectIds: [...explicitProjectIds], ambiguousNames: [...ambiguousNames] });
      const result = await retrieve({query,records,projectId,projectLabels,includeGlobal:true,explicitProjectIds,maxMemories:settings.retrieval.maxMemories,maxCandidates:settings.retrieval.maxCandidates,maxChars:settings.retrieval.maxChars,budgetTokens:settings.retrieval.maxChars,semanticThreshold:settings.retrieval.semanticThreshold,statusStaleHours:settings.retrieval.statusStaleHours,timeoutMs:remainingMs(),signal:combined,budgetSessionId,onDiagnostic,onEvaluationDiagnostic},models,relevance);
      trace.begin('versionAndPersistence');
      ensureActive();
      if (result.hits.some(m=>store.getMemory(m.id,{includeInactive:false})?.version!==m.version)) throw fail('检索期间记忆已被纠正或删除，本次不注入旧版本，请重新检索','RECALL_STALE');
      if (!readOnly && result.embeddingUpdates?.length) store.transaction(()=>{ for(const u of result.embeddingUpdates) store.setEmbedding(u.id,u.embedding,u.embeddingModel,{expectedVersion:u.version,embeddingVersion:u.embeddingVersion}); });
      if (!result.hits.length && result.diagnostics.budgetSkipped) throw fail('已判定相关的记忆超出完整上下文预算，未注入；不是无相关记忆','MEMORY_BUDGET_EXCEEDED');
      ensureActive();
      trace.finish();
      return {status:result.hits.length?'hit':ambiguousNames.length?'ambiguous':'no-hit',memories:result.hits,ambiguities:ambiguousNames,diagnostics:{...result.diagnostics,hostLatency:trace.snapshot(),stages:structuredClone(events)}};
    } catch(e) {
      const code=String(e?.code??'');
      const timedOut=deadline.aborted || performance.now()>=expiresAt || code.includes('TIMEOUT');
      const observedError=signal?.aborted?fail('请求已取消','ABORTED'):timedOut?fail('召回截止时间已到','RETRIEVAL_TIMEOUT'):e;
      trace.finish(observedError);
      const diagnostics={...(e.diagnostics||{}),hostLatency:trace.snapshot(),stages:structuredClone(events),errorCode:observedError.code||'UNKNOWN',timedOut,cancelled:!!signal?.aborted};
      if (signal?.aborted) return {status:'cancelled',memories:[],ambiguities:[],error:'请求已取消',diagnostics};
      return {status:timedOut?'timeout':code==='NOT_CONFIGURED' || code.endsWith('_NOT_CONFIGURED')?'not-configured':'error',memories:[],ambiguities:ambiguousNames,error:errorText(observedError),diagnostics};
    }
  } catch(e) {
    const timedOut=deadline.aborted||performance.now()>=expiresAt||String(e?.code??'').includes('TIMEOUT');
    const observedError=signal?.aborted?fail('请求已取消','ABORTED'):timedOut?fail('召回截止时间已到','RETRIEVAL_TIMEOUT'):e;
    trace.finish(observedError);
    return {status:signal?.aborted?'cancelled':timedOut?'timeout':'error',memories:[],ambiguities:[],error:errorText(observedError),diagnostics:{hostLatency:trace.snapshot(),stages:structuredClone(events),errorCode:observedError.code||'UNKNOWN',timedOut,cancelled:!!signal?.aborted}};
  }
}

// Identical version, deduplication and UTF-8 packaging gate for Native and eval.
export function packRecall({ memories, store, seen, projects, requestId, helper, recallMessage, maxChars }) {
  const hits=[];
  let stale=0, packedBudgetSkipped=0, reference=null;
  for(const m of memories) {
    if(store.getMemory(m.id,{includeInactive:false})?.version!==m.version) {stale++;continue;}
    if(seen[m.id]===m.version) continue;
    const packed=recallMessage([...hits,m],requestId,helper,projects);
    const packedText=textOf(packed);
    if(packedText.length<=maxChars && Buffer.byteLength(packedText,'utf8')<=maxChars) {hits.push(m);reference=packed;}
    else packedBudgetSkipped++;
  }
  let error;
  if(stale || !hits.length && packedBudgetSkipped) {
    hits.length=0;
    error=stale?'RECALL_STALE: 记忆版本已变化，本次未注入旧版本':'MEMORY_BUDGET_EXCEEDED: 相关记忆超出完整注入消息预算，未注入';
  }
  // Return exactly the timestamped message that passed the complete byte gate.
  if(!hits.length) reference=null;
  return {hits,reference,stale,packedBudgetSkipped,error};
}
