import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MemoryStore } from './store.js';
import { searchMemories, packRecall } from './search.js';
import { databaseSnapshot, sameDatabase, fileHash, verifyWriteAudit, evaluationSessionLeaks } from './eval-integrity.js';

const fail = (message, code = 'EVAL_INVALID_INPUT') => Object.assign(new Error(message), {code});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const errorInfo = e => ({code:e?.code || 'EVAL_ERROR',message:String(e?.message ?? e).slice(0,2000)});
const writeNew = (path, value) => writeFileSync(path, value, {flag:'wx',mode:0o600});
const inside = (base, path) => { const rel=relative(base,path); return rel!=='' && !rel.startsWith('..') && !isAbsolute(rel); };

export function latencyStats(values) {
  const sorted=values.filter(x=>typeof x==='number' && Number.isFinite(x)).sort((a,b)=>a-b);
  const percentile=p=>sorted.length ? sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] : null;
  return {samples:sorted.length,p50:percentile(.5),p95:percentile(.95),max:sorted.at(-1)??null};
}
function metrics(rows) {
  const passed=rows.filter(r=>r.passed).length;
  return {total:rows.length,attempted:rows.filter(r=>r.attempted).length,passed,passRate:rows.length?passed/rows.length:null,
    relevanceMs:latencyStats(rows.map(r=>r.relevanceMs)),recallMs:latencyStats(rows.map(r=>r.recallMs))};
}
export function summarize(rows) {
  const byGroup={},byExpectation={},byGroupAndExpectation={};
  for(const group of new Set(rows.map(r=>r.split))) {
    const groupRows=rows.filter(r=>r.split===group);
    byGroup[group]=metrics(groupRows);
    byGroupAndExpectation[group]={inject:metrics(groupRows.filter(r=>r.expected==='inject')),reject:metrics(groupRows.filter(r=>r.expected!=='inject'))};
  }
  for(const kind of ['inject','reject']) byExpectation[kind]=metrics(rows.filter(r=>(r.expected==='inject'?'inject':'reject')===kind));
  return {overall:metrics(rows),byGroup,byExpectation,byGroupAndExpectation};
}

export function loadEvaluationPlan(pluginDir, request) {
  const allowed=['inputPath','caseIds','seed','concurrency','timeoutMs'];
  if(!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(k=>!allowed.includes(k))) throw fail('未知评测参数');
  if(typeof request.inputPath!=='string' || !request.inputPath.endsWith('.json')) throw fail('inputPath 必须指向 evidence 内的 JSON 题单');
  const evidence=realpathSync(join(pluginDir,'evidence'));
  const inputPath=realpathSync(resolve(pluginDir,request.inputPath));
  if(!inside(evidence,inputPath) || !statSync(inputPath).isFile() || statSync(inputPath).size>5*1024*1024) throw fail('题单必须是 evidence 内不超过5MiB的普通文件');
  const text=readFileSync(inputPath,'utf8'), dataset=JSON.parse(text);
  if(!Array.isArray(dataset.cases) || !dataset.cases.length || dataset.cases.length>1000) throw fail('题单需要1–1000题');
  const ids=new Set(),numbers=new Set();
  for(const c of dataset.cases) {
    if(!c || typeof c.id!=='string' || !c.id.trim() || ids.has(c.id) || typeof c.split!=='string' || typeof c.query!=='string' || !c.query.trim() || c.query.length>6000 || typeof c.folder!=='string' || !isAbsolute(c.folder)) throw fail('题号、分组、题干或项目路径无效/重复');
    if(!['inject','no-hit/reject'].includes(c.expected) || !Array.isArray(c.expectedMemoryIds) || c.expectedMemoryIds.some(id=>typeof id!=='string'||!id) || new Set(c.expectedMemoryIds).size!==c.expectedMemoryIds.length || (c.expected==='inject')!==!!c.expectedMemoryIds.length) throw fail(`题目 ${c.id} 的标准答案无效`);
    if(c.n!=null && (!Number.isInteger(c.n)||c.n<1||numbers.has(c.n))) throw fail('n 必须是唯一的正整数');
    ids.add(c.id); if(c.n!=null) numbers.add(c.n);
  }
  let cases=dataset.cases;
  if(request.caseIds!==undefined) {
    if(!Array.isArray(request.caseIds) || !request.caseIds.length || new Set(request.caseIds).size!==request.caseIds.length) throw fail('caseIds 必须是非空、无重复的题号数组');
    for(const id of request.caseIds) if(!cases.some(c=>typeof id==='number'?c.n===id:c.id===id)) throw fail(`未知题号 ${id}`);
    cases=cases.filter(c=>request.caseIds.includes(c.id)||request.caseIds.includes(c.n));
  }
  const concurrency=request.concurrency??1;
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>2) throw fail('concurrency 必须为1或2（本地推理配额为2）');
  if(request.timeoutMs!==undefined && (!Number.isInteger(request.timeoutMs)||request.timeoutMs<100||request.timeoutMs>120000)) throw fail('timeoutMs 必须为100–120000的整数');
  if(request.seed!==undefined) {
    if(!Number.isInteger(request.seed)||request.seed<0||request.seed>0xffffffff) throw fail('seed 必须是 uint32');
    cases=[...cases]; let seed=request.seed>>>0;
    const random=()=>{let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};
    for(let i=cases.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[cases[i],cases[j]]=[cases[j],cases[i]];}
  }
  return {inputPath,inputSha256:sha(text),dataset,cases,concurrency,seed:request.seed??null,timeoutMs:request.timeoutMs??null};
}

const fmt=x=>x===null?'未测得':x.toFixed(1);
const rate=m=>`${m.passed}/${m.total}（${m.passRate===null?'不适用':(m.passRate*100).toFixed(1)+'%'}）`;
const cell=x=>String(x??'').replaceAll('|','\\|').replaceAll('\n',' ');
export function renderSummary(result) {
  const s=result.statistics;
  const lines=[`# jiyi ${result.pluginVersion} 隔离副本评测`, '',
    `状态：${result.status}；已尝试 ${s.overall.attempted}/${s.overall.total}；精确通过 ${rate(s.overall)}。`,
    `相关性：${result.settings.relevance.provider}/${result.settings.relevance.model}；并发 ${result.options.concurrency}；种子 ${result.options.seed??'未设置（原顺序）'}。`,
    '', '## 方法与边界', '',
    '正式召回/管理继续可用，抽取任务持久排队至评测结束。宿主在副本关闭和模型 dispose 后取证；逐次 SQL 写入记录耗时、涉及表、来源及各表行指纹变化，重放审计必须完整解释正式库变化，且本次评测 session id 不得出现在正式库。文件/WAL hash 变化如实记录，不把正常并行写入判为污染。CLI 返回后独立检查评测会话污染，passed 与字节 unchanged 分开报告。',
    '使用正式 SQLite 的只读连接执行 VACUUM INTO，再以独立 MemoryStore 运行共享 searchMemories → 原 retrieve → MiniLM/原 singleton 优化 → createRelevanceJudge → 宿主 callTextModel。最终复用 Native 的版本/去重/完整 UTF-8 包装门。每题使用新 UUID 和空 seen 状态；标准答案不传给模型。',
    '这是宿主内的召回与注入包装评测，不创建真实 DSH Agent，不生成主模型回答，不冒充界面端到端验收。实际注入 id 指本题内存决策中已包装的参考消息；副本记账为 injected。复制来的历史队列不启动，不抽取题单或评测对话。',
    '首试不重采。超时、取消和错误均判失败，不能作为正确拒绝。相关性耗时未调用时为 null，不计入分位数；成功取 judge 实测，失败取 LLM trace 或 retrieve 的相关性等待时间，relevanceTimingSource 明示来源，不冒充超时后服务端完成时间。整次召回含 scope、模型、回写、包装和副本记账。分位数使用 nearest-rank，单位 ms。',
    '', '## 分组通过率和耗时', '', '| 组别 | 精确通过 | 相关性 p50 / p95 / 最大 | 整次召回 p50 / p95 / 最大 |', '|---|---:|---:|---:|'];
  for(const [key,m] of Object.entries(s.byGroup)) lines.push(`| ${cell(key)} | ${rate(m)} | ${fmt(m.relevanceMs.p50)} / ${fmt(m.relevanceMs.p95)} / ${fmt(m.relevanceMs.max)} | ${fmt(m.recallMs.p50)} / ${fmt(m.recallMs.p95)} / ${fmt(m.recallMs.max)} |`);
  lines.push('', '## 应注入 / 应拒绝', '', '| 类别 | 精确通过 | 相关性 p50 / p95 / 最大 | 整次召回 p50 / p95 / 最大 |','|---|---:|---:|---:|');
  for(const [kind,m] of Object.entries(s.byExpectation)) lines.push(`| ${kind==='inject'?'应注入':'应拒绝'} | ${rate(m)} | ${fmt(m.relevanceMs.p50)} / ${fmt(m.relevanceMs.p95)} / ${fmt(m.relevanceMs.max)} | ${fmt(m.recallMs.p50)} / ${fmt(m.recallMs.p95)} / ${fmt(m.recallMs.max)} |`);
  lines.push('', '| 组别 | 应注入 | 应拒绝 |','|---|---:|---:|');
  for(const [group,m] of Object.entries(s.byGroupAndExpectation)) lines.push(`| ${cell(group)} | ${rate(m.inject)} | ${rate(m.reject)} |`);
  lines.push('', '## 全部失败题', '');
  const failures=result.cases.filter(c=>!c.passed);
  if(!failures.length) lines.push('无。');
  for(const r of failures) lines.push(`- ${r.n??''} ${r.id}：${r.query}\n  - 期望：${r.expected}；id=${JSON.stringify(r.expectedMemoryIds)}；事实=${JSON.stringify(r.expectedFacts)}\n  - 实际：${r.status}；id=${JSON.stringify(r.actualInjectedMemoryIds)}；错误=${JSON.stringify(r.error)}`);
  const auditMs=result.integrity.audit?.timing?.elapsedMs, snap=result.integrity.snapshotMs;
  lines.push('', '## 正式库完整性', '', `字节一致：${result.integrity.unchanged}；隔离完整性通过：${result.integrity.passed}；已归因正式写入：${result.integrity.audit?.writeCount??0}；审计耗时 p50 / p95 / 最大：${fmt(auditMs?.p50??null)} / ${fmt(auditMs?.p95??null)} / ${fmt(auditMs?.max??null)} ms；全库快照开始 / 结束：${fmt(snap?.before??null)} / ${fmt(snap?.after??null)} ms；评测会话污染：${result.integrity.evaluationSessionLeaks?.length??'未取得'}。主文件 SHA-256：`, `- 前：\`${result.integrity.before?.sha256??'未取得'}\``, `- 后：\`${result.integrity.after?.sha256??'未取得'}\``,
    `- WAL 前/后：\`${result.integrity.before?.walSha256??'不存在'}\` / \`${result.integrity.after?.walSha256??'不存在'}\``,
    `- settings SHA 前/后：\`${result.integrity.settingsBefore??'未取得'}\` / \`${result.integrity.settingsAfter??'未取得'}\``, '', '| 表 | 前 | 后 |','|---|---:|---:|');
  for(const [name,count] of Object.entries(result.integrity.before?.tables??{})) lines.push(`| ${name} | ${count} | ${result.integrity.after?.tables?.[name]??'未取得'} |`);
  lines.push('', '## 与 0.1.7 比较', '');
  if(result.baseline017) {
    lines.push(`来源：${result.baseline017.path}；SHA-256 ${result.baseline017.sha256}。`, '', '| 组别 | 0.1.7 全集 exact / p95 ms | 本次子集 exact / p95 ms |','|---|---:|---:|');
    for(const [key,old] of Object.entries(result.baseline017.groups)) { const m=s.byGroup[key]; if(m) lines.push(`| ${key} | ${old.exact} / ${old.p95Ms} | ${rate(m)} / ${fmt(m.recallMs.p95)} |`); }
    lines.push('', '0.1.7 的 R/旧U/V unsupported 分别为 1/1/0，原冻结质量门槛未通过。历史报告未给出本36题配对子集成绩或应注入/应拒绝分类耗时，不能据全集与小样本差异声称质量改善。样本、相关性模型、并行负载和测量边界不同；本次是已见集回归，不是未见泛化或因果对照。0.1.7 采集期间另有真实会话并行，历史延迟不作折扣。');
  } else lines.push('未找到 0.1.7 报告；不生成虚构比较。');
  if(result.error) lines.push('', '## 运行错误', '', JSON.stringify(result.error));
  return lines.join('\n')+'\n';
}

// No production Store/Session/queue pump is accepted here: only its read-only path.
export async function runIsolatedEvaluation({pluginDir,sourceDatabase,settingsPath,settings,request,models,relevance,helpers,recallMessage,runtime,version,signal,cleanup=async()=>({required:false}),finishWriteAudit}) {
  const plan=loadEvaluationPlan(pluginDir,request);
  if(!settings.enabled) throw fail('记忆已停用，不能评测','EVAL_DISABLED');
  for(const key of ['provider','model']) if(plan.dataset.relevance?.[key] && plan.dataset.relevance[key]!==settings.relevance[key]) throw fail(`题单 relevance.${key} 与当前配置不符`,'EVAL_CONFIG_MISMATCH');
  if(plan.dataset.relevance?.timeoutMs && !plan.timeoutMs && plan.dataset.relevance.timeoutMs!==settings.relevance.timeoutMs) throw fail('题单相关性超时与当前配置不符','EVAL_CONFIG_MISMATCH');
  const evalSettings=structuredClone(settings);
  if(plan.timeoutMs!==null) {evalSettings.retrieval.timeoutMs=plan.timeoutMs;evalSettings.relevance.timeoutMs=plan.timeoutMs;}
  const root=join(pluginDir,'evidence','eval-runs'); mkdirSync(root,{recursive:true,mode:0o700});
  if(!inside(realpathSync(join(pluginDir,'evidence')),realpathSync(root))) throw fail('eval-runs 不能指向 evidence 外部');
  const runId=`${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`;
  const runDir=join(root,runId); mkdirSync(runDir,{mode:0o700});
  const database=join(runDir,'memory.sqlite');
  const result={schemaVersion:1,pluginVersion:version,mode:'isolated-search-and-native-packaging-not-agent-e2e',runId,runDir,database,startedAt:new Date().toISOString(),status:'running',runtime,
    input:{path:plan.inputPath,sha256:plan.inputSha256},options:{caseIds:request.caseIds??null,seed:plan.seed,concurrency:plan.concurrency,timeoutMs:evalSettings.retrieval.timeoutMs},settings:evalSettings,integrity:{unchanged:false,passed:false,window:'host-including-disposal',evaluationPrefix:`jiyi-eval-${runId}-`,snapshotMs:{before:null,after:null}},cleanup:null,cases:[],error:null};
  result.cases=plan.cases.map(c=>({n:c.n??null,id:c.id,split:c.split,group:c.group??null,query:c.query,expected:c.expected,expectedMemoryIds:c.expectedMemoryIds,expectedFacts:c.expectedFacts??[],attempted:false,passed:false,status:'not-attempted',actualInjectedMemoryIds:[],relevanceMs:null,recallMs:null,error:null}));
  let store;
  try {
    const beforeStarted=performance.now();
    result.integrity.before=databaseSnapshot(sourceDatabase);
    result.integrity.snapshotMs.before=performance.now()-beforeStarted;
    result.integrity.settingsBefore=settingsPath?fileHash(settingsPath):null;
    signal?.throwIfAborted();
    // VACUUM INTO is SQLite's consistent, WAL-aware snapshot operation. Source is read-only.
    const source=new DatabaseSync(realpathSync(sourceDatabase),{readOnly:true});
    try {source.prepare('VACUUM INTO ?').run(database);} finally {source.close();}
    chmodSync(database,0o600);
    result.snapshot={method:'VACUUM INTO via readOnly DatabaseSync',sha256:fileHash(database)};
    writeNew(join(runDir,'input.json'),JSON.stringify(plan.dataset,null,2)+'\n');
    store=new MemoryStore(database);
    const projects=store.listProjects();
    const prepared=plan.cases.map(c=>{
      const folder=realpathSync(c.folder);
      const project=projects.find(p=>p.path===folder||p.aliases.includes(folder));
      if(!project) throw fail(`题目 ${c.id} 的目录不属于副本中的已存项目`,'EVAL_UNKNOWN_PROJECT');
      return {c,project};
    });
    const baselinePath=join(pluginDir,'evidence','reliability-v017-lead-final-report.md');
    if(existsSync(baselinePath)) {
      const text=readFileSync(baselinePath,'utf8');
      // Bind the historical numbers to the report, never silently apply stale constants.
      if(!text.includes('| R | 100/102 | 1 |') || !text.includes('| 旧U | 31/32 | 1 |') || !text.includes('| V | 32/32 | 0 |') || !text.includes('R 7264.1ms、旧U 8610.8ms、V 5542.9ms')) throw fail('0.1.7 历史报告内容与比较口径不匹配','EVAL_BASELINE_MISMATCH');
      result.baseline017={path:baselinePath,sha256:sha(text),groups:{R:{exact:'100/102',p95Ms:7264.1},oldU:{exact:'31/32',p95Ms:8610.8},V:{exact:'32/32',p95Ms:5542.9}}};
    }
    let next=0,halt=null;
    const rows=new Array(prepared.length);
    const worker=async()=>{
      while(next<prepared.length && !halt && !signal?.aborted) {
        const order=next++,{c,project}=prepared[order];
        const sessionId=`jiyi-eval-${runId}-${randomUUID()}`,requestId=randomUUID();
        const row={n:c.n??null,id:c.id,split:c.split,group:c.group??null,project:c.project??null,projectId:project.id,folder:c.folder,query:c.query,expected:c.expected,expectedMemoryIds:[...c.expectedMemoryIds],expectedFacts:c.expectedFacts??[],order:order+1,sessionId,requestId,attempted:true,actualInjectedMemoryIds:[],passed:false,status:'running',relevanceMs:null,recallMs:null,error:null};
        const started=performance.now(),expiresAt=started+evalSettings.retrieval.timeoutMs;
        try {
          // Per-case sink exists only for this isolated run. Keep raw evidence
          // out of shared latency diagnostics and even the copy's recall ledger.
          row.evaluationDiagnostics=[];
          const onEvaluationDiagnostic=event=>row.evaluationDiagnostics.push(structuredClone(event));
          const recalled=await searchMemories({query:c.query,store,settings:evalSettings,models,relevance,resolveCurrentProject:()=>project,scope:project.id,signal,deadlineAt:expiresAt,onEvaluationDiagnostic});
          row.status=recalled.status;row.diagnostics=recalled.diagnostics??null;
          const judgeCalled=recalled.diagnostics?.judge?.called===true;
          const judgeStage=recalled.diagnostics?.retrieve?.events?.findLast(e=>e.stage==='llm'&&e.status!=='running');
          row.relevanceMs=judgeCalled?(recalled.diagnostics?.relevance?.elapsedMs??recalled.diagnostics?.llm?.elapsedMs??judgeStage?.durationMs??null):null;
          row.relevanceTimingSource=!judgeCalled?'not-called':recalled.diagnostics?.relevance?'judge-elapsed':recalled.diagnostics?.llm?'llm-trace':judgeStage?'retrieve-llm-wait':'unknown';
          row.judgeCalled=judgeCalled;row.queryEmbedding=recalled.diagnostics?.queryEmbedding??null;
          if(!['hit','no-hit','ambiguous'].includes(recalled.status)) throw fail(recalled.error??`召回状态 ${recalled.status}`,recalled.diagnostics?.errorCode??recalled.status.toUpperCase());
          const packed=packRecall({memories:recalled.memories,store,seen:{},projects,requestId,helper:helpers.createUserMessage,recallMessage,maxChars:evalSettings.retrieval.maxChars});
          if(packed.error) throw fail(packed.error,'EVAL_PACKAGING');
          signal?.throwIfAborted();
          if(performance.now()>=expiresAt) throw fail('召回截止时间已到，未注入迟到的记忆','RETRIEVAL_TIMEOUT');
          // A fresh local decision, not a persisted DSH Session or a main-model call.
          const messages=packed.reference?[packed.reference]:[];
          const refs=messages.flatMap(m=>m.source.memoryRefs);
          row.actualInjectedMemoryIds=refs.map(m=>m.id);
          row.injectionEvidence='packaged-reference-in-fresh-local-decision';
          store.transaction(()=>{
            store.recordRecall({sessionId,requestId,status:refs.length?'injected':'empty',memories:packed.hits,details:{query:c.query,status:recalled.status,diagnostics:recalled.diagnostics,evaluation:true}});
            store.setMetadata(`injected:${sessionId}`,Object.fromEntries(refs.map(m=>[m.id,m.version])));
          });
          if(performance.now()>=expiresAt) throw fail('副本记账后已超过召回截止时间','RETRIEVAL_TIMEOUT');
          row.passed=isDeepStrictEqual([...row.actualInjectedMemoryIds].sort(),[...c.expectedMemoryIds].sort());
        } catch(e) {
          row.error=errorInfo(e); row.status=String(e?.code??'').includes('TIMEOUT')?'timeout':'error';row.passed=false;row.actualInjectedMemoryIds=[];
          store.transaction(()=>{
            store.recordRecall({sessionId,requestId,status:'error',memories:[],details:{query:c.query,status:row.status,error:row.error,diagnostics:row.diagnostics,evaluation:true}});
            store.setMetadata(`injected:${sessionId}`,{});
          });
          if(/AUTH|CREDENTIAL|NOT_CONFIGURED|EVAL_CONFIG|INVALID_SCOPE|HTTP_40[13]/.test(row.error.code)) halt=row.error;
        } finally {row.recallMs=performance.now()-started;rows[order]=row;result.cases[order]=row;}
      }
    };
    // Even a storage failure must settle all already-started workers before closing the copy.
    const settled=await Promise.allSettled(Array.from({length:plan.concurrency},()=>worker()));
    const rejected=settled.find(r=>r.status==='rejected');
    if(rejected) throw rejected.reason;
    result.cases=prepared.map(({c,project},i)=>rows[i]??{n:c.n??null,id:c.id,split:c.split,group:c.group??null,query:c.query,expected:c.expected,expectedMemoryIds:c.expectedMemoryIds,expectedFacts:c.expectedFacts??[],projectId:project.id,attempted:false,passed:false,status:'not-attempted',actualInjectedMemoryIds:[],relevanceMs:null,recallMs:null,error:halt??{code:'ABORTED',message:'评测已取消'}});
    result.status=result.cases.every(r=>r.attempted)?'completed':'stopped';
    result.error=halt??(signal?.aborted?errorInfo(signal.reason):null);
  } catch(e) {result.status='failed';result.error=errorInfo(e);}
  finally {
    try {store?.close();} catch(e) {result.status='failed';result.error=errorInfo(e);}
    // Dispose evaluation resources before ending the production write audit.
    try {result.cleanup=await cleanup();}
    catch(e) {result.status='cleanup-failed';result.error=errorInfo(e);result.cleanup={ok:false,error:errorInfo(e)};}
    try {
      const afterStarted=performance.now();
      result.integrity.after=databaseSnapshot(sourceDatabase);
      result.integrity.snapshotMs.after=performance.now()-afterStarted;
      result.integrity.settingsAfter=settingsPath?fileHash(settingsPath):null;
      result.integrity.unchanged=sameDatabase(result.integrity.before,result.integrity.after)&&result.integrity.settingsBefore===result.integrity.settingsAfter;
      const audit=finishWriteAudit?.()??{writes:[],settingsWrites:[]};
      result.integrity.productionWrites=audit.writes;
      result.integrity.settingsWrites=audit.settingsWrites;
      const writes=audit.writes??[];
      result.integrity.audit={...verifyWriteAudit(result.integrity.before,result.integrity.after,writes,result.integrity.evaluationPrefix),timing:{count:writes.length,elapsedMs:latencyStats(writes.map(w=>w.elapsedMs))}};
      result.integrity.evaluationSessionLeaks=evaluationSessionLeaks(sourceDatabase,result.integrity.evaluationPrefix);
      const settingsAccounted=result.integrity.settingsBefore===result.integrity.settingsAfter || audit.settingsWrites.at(-1)?.sha256===result.integrity.settingsAfter;
      result.integrity.passed=result.integrity.audit.passed&&result.integrity.evaluationSessionLeaks.length===0&&settingsAccounted;
      if(!result.integrity.passed) {result.status='integrity-failed';result.error=errorInfo(fail('正式库存在未归因写入或评测会话污染；保留全部变化证据','EVAL_SOURCE_CHANGED'));}
    } catch(e) {result.status='integrity-failed';result.error=errorInfo(e);}
  }
  result.finishedAt=new Date().toISOString();result.statistics=summarize(result.cases);
  const resultPath=join(runDir,'results.json'),summaryPath=join(runDir,'summary.md');
  writeNew(resultPath,JSON.stringify(result,null,2)+'\n');
  writeNew(summaryPath,renderSummary(result));
  return {ok:result.status==='completed'&&result.integrity.passed,qualityPassed:result.status==='completed'&&result.cases.every(c=>c.passed),status:result.status,runDir,resultPath,summaryPath,statistics:result.statistics,integrity:result.integrity,error:result.error};
}
