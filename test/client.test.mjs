import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../lib/index.js';

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const versionRe = VERSION.replaceAll('.', '\\.');
const memory = { id: 'm1', content: '偏好中文 <script>不会执行</script>', scope: 'project', projectId: 'p1', type: 'preference', status: 'active', version: 2, createdAt: '2026-10-20T01:02:00Z', updatedAt: '2026-10-21T01:02:00Z', extractionModel: 'extract-test', embeddingModel: 'embed-test', embeddingVersion: 3, sources: [{ sessionId: 'origin-session', eventSeq: 42, quote: '用户明确表达的原话' }] };
function state(overrides = {}) {
  return { ok: true, version: VERSION, capabilities:{schemaVersion:4,reviewState:true,evidence:true,decisions:true,feedback:['explicit_useful','explicit_irrelevant','explicit_wrong'],conflicts:true,consolidation:true,operations:['feedback','resolveConflict','verifyAdjudication','consolidation-trigger']}, settings: { enabled: true, extraction: { provider: 'openai-codex', model: 'gpt-6.1-sol', timeoutMs: 60000 }, lessons:{enabled:true,repeatedFailures:2,maxEvidenceChars:4000}, embedding: { backend: 'local', model: 'local-test',timeoutMs:10000,loadTimeoutMs:120000 }, relevance: { provider: 'openai-codex', model: 'gpt-6.1-sol', timeoutMs: 10000 }, retrieval: { timeoutMs: 10000, maxMemories: 6, maxCandidates: 12, maxChars: 4000, semanticThreshold: 0.2 }, adjudication:{provider:'openai-codex',model:'gpt-6.1-sol',timeoutMs:15000,modelPolicy:'fixed',reasoningEffort:null,minConfidence:.85},consolidation:{enabled:false,minMemories:50,intervalHours:24,batchSize:5,timeoutMs:15000},feedback:{modelSamplingRate:0}, queue: { maxAttempts: 3 } }, memories: [memory], projects: [{ id: 'p1', name: '测试项目' }], queue: [{ id: 'q1', sessionId: 's1', eventSeq: 9, status: 'failed', attempts: 2, error: '实际提取失败', updatedAt: '2026-10-21T00:00:00Z' }], retrievals: [{ id:'r1',sessionId: 's1', requestId:'msg-1',messageId: 'msg-1', memoryRefs:[],feedback:[],status: 'timeout', query: '当前问题', memoryIds: [], error: '实际召回超时', createdAt: '2026-10-21T00:00:00Z' }, { id:'r2',sessionId: 'other', requestId:'other-msg',messageId: 'other-msg',memoryRefs:[],feedback:[],status: 'hit', query: '其他会话不展示', memoryIds: ['m1'] }], conflicts:[],consolidationJobs:[],consolidation:{status:'disabled'},models: { extraction: { status: 'not-verified' }, embedding: { status: 'not-verified' }, relevance: { provider: 'openai-codex', model: 'gpt-6.1-sol', version: 'relevance-test-v1', status: 'not-verified', ready: false, activeRequests: 0, lastSuccessAt: null, error: null },adjudication:{status:'not-verified'} }, ...overrides };
}
function legacyState(version = '0.1.2') {
  const value = state({ version });
  delete value.settings.relevance; delete value.settings.retrieval.maxCandidates; delete value.models.relevance;
  value.settings.retrieval.semanticThreshold = 0.5;
  return value;
}
function harness(handler = () => state()) {
  let definition, plugin, body, tail, tree, current, dirty = true, tailProps = null, configSection = null, section = 'body';
  const instances = new Map(), calls = [], opened = [], registrations = [], effects = [], timers = new Map();
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) { const instance = current, i = instance.index++; if (!(i in instance.hooks)) instance.hooks[i] = typeof initial === 'function' ? initial() : initial; return [instance.hooks[i], value => { instance.hooks[i] = typeof value === 'function' ? value(instance.hooks[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = current.index++; return current.hooks[i] || (current.hooks[i] = { current: initial }); },
    useEffect(fn, deps) { const instance = current, i = instance.index++, previous = instance.hooks[i]; if (!previous || deps.some((v, n) => v !== previous.deps[n])) { effects.push(() => { previous?.cleanup?.(); instance.hooks[i] = { deps, cleanup: fn() }; }); } },
  };
  const styles = new Map(), listeners = new Map(), observers = new Set();
  let tabVisible = true, cssVisible = true;
  const root = { getClientRects: () => tabVisible ? [{}] : [] };
  const document = { hidden: false, getElementById: id => styles.get(id), createElement: () => ({}), head: { appendChild(el) { styles.set(el.id, el); } }, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  class IntersectionObserver { constructor(fn) { this.fn = fn; observers.add(this); } observe() {} disconnect() { observers.delete(this); } }
  vm.runInNewContext(code, { window: { location: { origin: 'http://127.0.0.1:57479' }, getComputedStyle: () => ({ visibility: cssVisible ? 'visible' : 'hidden' }), __ModuleLoader__: { load(value) { definition = value; } } }, document, IntersectionObserver, URL, AbortController, console, setInterval(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); }, fetch: async (url, options) => { const parsed = new URL(url, 'http://localhost'); const call = { url: parsed, options, op: parsed.searchParams.get('op'), body: options.body ? JSON.parse(options.body) : null }; calls.push(call); const result = await handler(call); return { ok: (result.httpStatus || 200) < 400, status: result.httpStatus || 200, json: async () => result }; } });
  plugin = definition.factory(name => { assert.equal(name, 'react'); return React; });
  const declared = Array.from(plugin.inject);
  const services = { sidebarRightTabs: { register(value) { registrations.push(value); return () => {}; } }, slots: { inject(name, register) { return register(); }, register(options, component) { registrations.push(options); if (options.name === 'sidebar.right.pane.tab') body = component; if (options.name === 'conversation.input.dock') tail = component; if (options.name === 'plugins.bundle.config') configSection = component; return () => {}; } }, uiWorkspace: { openSession(id) { opened.push(id); } }, effect(fn) { fn(); } };
  const context = new Proxy(services, { get(target, key) { if (key !== 'effect') assert.ok(declared.includes(key), `undeclared service ${String(key)}`); return target[key]; } });
  plugin.apply(context);
  function expand(node, path = 'root') {
    if (node == null || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const key = path + '/' + node.type.name + ':' + (node.props.key || '');
      const instance = instances.get(key) || { hooks: [], index: 0 };
      instances.set(key, instance); instance.index = 0; const before = current; current = instance;
      const result = node.type(node.props); current = before;
      return expand(result, key);
    }
    if (node.props.ref) node.props.ref.current = root;
    return { ...node, props: { ...node.props, children: (node.props.children || []).map((child, i) => expand(child, path + '/' + (child?.props?.key || i))) } };
  }
  function render() { dirty = false; tree = expand(section === 'config' ? React.createElement(configSection, {}) : tailProps ? React.createElement(tail, tailProps) : React.createElement(body, { useTabInfo: () => ({ tab: { sessionId: 's1' } }) })); while (effects.length) effects.shift()(); return tree; }
  function all(node = tree) { if (node == null || typeof node !== 'object') return []; return [node, ...(node.props.children || []).flatMap(child => all(child))]; }
  function text(node = tree) { if (node == null) return ''; if (typeof node !== 'object') return String(node); return (node.props.children || []).map(text).join(' '); }
  async function settle() { for (let i = 0; i < 6; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } if (dirty) render(); }
  function find(label) { const result = all().find(node => node.props['aria-label'] === label || (node.type === 'button' && text(node) === label)); assert.ok(result, `missing control: ${label}\n${text()}`); return result; }
  async function click(label) { const node = find(label); assert.equal(!!node.props.disabled, false, `${label} disabled`); await node.props.onClick?.(); await settle(); }
  async function change(label, value) { find(label).props.onChange({ target: { value } }); await settle(); }
  render();
  return { plugin, calls, opened, registrations, timers, listeners, observers, settle, text, all, find, click, change, render, showConfig() { section = 'config'; render(); }, showTail(props) { tailProps = props; render(); }, async setDocumentVisible(value) { document.hidden = !value; listeners.get('visibilitychange')?.(); await settle(); }, async setTabVisible(value) { tabVisible = value; for (const observer of observers) observer.fn(); await settle(); }, async setCssVisible(value) { cssVisible = value; for (const observer of observers) observer.fn(); await settle(); }, async poll() { for (const fn of timers.values()) await fn(); await settle(); }, async submit() { await all().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); }, destroy() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); } };
}

test('creates global and project memories, preserves failed drafts and shows the full saved content', async () => {
  let fail = false;
  const app = harness(call => call.op === 'createMemory' ? fail ? { ok: false, httpStatus: 400, error: '创建失败' } : { ok: true, memory: { id: 'new', content: call.body.content } } : state());
  await app.settle();
  assert.equal(app.find('保存新记忆').props.disabled, true);
  assert.equal(app.find('新建记忆内容').props.maxLength, 1500);
  const content = '第一行\n第二行 <script>完整内容</script>';
  await app.change('新建记忆内容', content); await app.click('保存新记忆');
  assert.deepEqual(app.calls.find(c => c.op === 'createMemory').body, { op: 'createMemory', content, scope: 'global', projectId: null });
  assert.match(app.text(), /第一行\n第二行 <script>完整内容<\/script>/); assert.equal(app.find('新建记忆内容').props.value, '');
  await app.change('新建记忆范围', 'project'); await app.change('新建记忆内容', '项目草稿');
  assert.equal(app.find('保存新记忆').props.disabled, true); await app.change('新建记忆项目', 'p1');
  fail = true; await app.click('保存新记忆'); assert.match(app.text(), /操作失败：创建失败/); assert.equal(app.find('新建记忆内容').props.value, '项目草稿');
  fail = false; await app.click('保存新记忆'); assert.deepEqual(app.calls.filter(c => c.op === 'createMemory').at(-1).body, { op: 'createMemory', content: '项目草稿', scope: 'project', projectId: 'p1' });
  app.destroy();
});

test('queue classifies stored errors conservatively and displays every character', async () => {
  const full = 'Adapter openai not registered\n详细诊断：' + '很长'.repeat(3000) + '末尾';
  const app = harness(() => state({ queue: [{ id: 'q1', status: 'failed', error: full }, { id: 'q2', status: 'failed', error: '抽取结果 schema 无效或超过 12 条' }, { id: 'q3', status: 'failed', error: 'request timed out' }] }));
  await app.settle(); assert.match(app.text(), /失败分类：adapter 未注册/); assert.match(app.text(), /失败分类：抽取 schema 无效/); assert.match(app.text(), /失败分类：未知/); assert.ok(app.text().includes(full)); app.destroy();
});

test('structured provider failures show the actual category and stage', async () => {
  const app=harness(()=>state({queue:[{id:'q-timeout',status:'failed',attempts:3,error:'文本模型调用超时',failure:{code:'EXTRACTION_TIMEOUT',category:'provider_timeout',stage:'memory-review',retryable:true},updatedAt:'2026-11-07T00:00:00Z'}]}));
  await app.settle();assert.match(app.text(),/provider 超时/);assert.match(app.text(),/memory-review/);app.destroy();
});

test('recall health separates normal no-hit results from failures and shows stage latency', async () => {
  const app=harness(()=>state({retrievalStats:{total:12,last24h:{total:5,failures:1},byStatus:{hit:2,'no-hit':8,timeout:1,error:1},byFailureStage:{'relevance-llm':1,packaging:1},byErrorCode:{RETRIEVAL_TIMEOUT:1},latencyMs:{samples:12,p50:1200,p95:9000,max:10000},note:'no-hit 是正常的零命中决策，不计为失败'}}));
  await app.settle();assert.match(app.text(),/召回健康度 · 12 次/);assert.match(app.text(),/no-hit 8/);assert.match(app.text(),/relevance-llm 1/);assert.match(app.text(),/延迟 p50 1200ms/);app.destroy();
});

test('history loads failed entries on demand, classifies full errors and pages without mutations', async () => {
  const longError = 'no adapter registered for provider "openai-codex"\n' + '细节'.repeat(1000);
  const app = harness(call => call.op === 'failedQueue' ? {ok:true,offset:Number(call.url.searchParams.get('offset')),total:101,queue: Number(call.url.searchParams.get('offset')) === 0 ? Array.from({length:100},(_,i)=>({id:String(i),status:'failed',error:i===0?longError:'抽取记忆缺少有效内容/类型/范围/来源'})) : [{id:'old',status:'failed',error:'其他错误'}]} : state({queue:[]}));
  await app.settle(); assert.equal(app.calls.some(c=>c.op==='failedQueue'),false);
  await app.click('查看历史失败项'); assert.ok(app.text().includes(longError));
  assert.match(app.text(),/失败分类：adapter 未注册/); assert.match(app.text(),/失败分类：抽取 schema 无效/);
  await app.click('下一页失败项'); assert.match(app.text(),/失败分类：未知/); assert.equal(app.find('下一页失败项').props.disabled,true);
  await app.click('上一页失败项'); assert.equal(app.calls.filter(c=>c.op==='failedQueue').map(c=>c.url.searchParams.get('offset')).join(','),'0,100,0');
  assert.equal(app.calls.some(c=>c.options.method==='POST'),false); app.destroy();
});

test('history read failure is visible and does not show a stale page as current', async () => {
  let fail=false;
  const app=harness(call=>call.op==='failedQueue' ? fail ? {ok:false,httpStatus:500,error:'队列读取失败'} : {ok:true,offset:0,total:1,queue:[{id:'old',status:'failed',error:'旧错误'}]} : state());
  await app.settle(); await app.click('查看历史失败项'); assert.match(app.text(),/旧错误/);
  fail=true; await app.click('查看历史失败项'); assert.match(app.text(),/加载历史失败队列失败：队列读取失败/); assert.doesNotMatch(app.text(),/旧错误/); app.destroy();
});

test('memory list loads older bounded pages without hiding records behind the first page', async () => {
  const older={...memory,id:'m-older',content:'第二页记忆',version:1,updatedAt:'2026-10-19T01:02:00Z'};
  const app=harness(call=>call.op==='memories' ? {ok:true,memories:[older],memoryPage:{offset:200,limit:200,total:201}} : state({memoryPage:{offset:0,limit:200,total:201}}));
  await app.settle();
  assert.match(app.text(),/已加载 1 \/ 201 条记录/);
  await app.click('加载更多记忆');
  assert.match(app.text(),/第二页记忆/);
  assert.equal(app.calls.find(call=>call.op==='memories').url.searchParams.get('memoryOffset'),'200');
  app.destroy();
});

test('document or tab hiding stops polling and visibility restoration refreshes once', async () => {
  const app = harness(); await app.settle();
  const count = () => app.calls.filter(c => c.op === 'state').length;
  assert.equal(count(), 1); await app.setDocumentVisible(false); await app.poll(); assert.equal(count(), 1);
  await app.setDocumentVisible(true); assert.equal(count(), 2);
  await app.setTabVisible(false); await app.poll(); assert.equal(count(), 2);
  await app.setDocumentVisible(false); await app.setTabVisible(true); await app.poll(); assert.equal(count(), 2);
  await app.setDocumentVisible(true); assert.equal(count(), 3);
  await app.setCssVisible(false); await app.poll(); assert.equal(count(), 3);
  await app.setCssVisible(true); assert.equal(count(), 4);
  app.destroy(); assert.equal(app.timers.size, 0); assert.equal(app.listeners.size, 0); assert.equal(app.observers.size, 0);
});

test('registers isolated keyed jiyi tab and reads only declared services', async () => {
  const app = harness(); await app.settle();
  assert.deepEqual(Array.from(app.plugin.inject), ['slots', 'sidebarRightTabs', 'uiWorkspace']);
  assert.equal(app.registrations[0].id, 'jiyi'); assert.equal(app.registrations[0].kind, 'jiyi');
  assert.deepEqual(app.registrations.slice(1).map(x => [x.name, x.key || x.id]), [['sidebar.right.pane.tab', 'jiyi'], ['sidebar.right.pane.tab.title', 'jiyi'], ['conversation.input.dock', 'jiyi'], ['plugins.bundle.config', 'jiyi']]);
  assert.match(app.text(), new RegExp('v' + versionRe)); assert.match(app.text(), /extract-test/); assert.match(app.text(), /embed-test/); assert.match(app.text(), /seq 42/); assert.match(app.text(), /用户明确表达的原话/);
  assert.doesNotMatch(app.text(), /其他会话不展示/); assert.equal(app.all().some(n => n.type === 'script'), false);
  app.destroy();
});

test('plugin page config section edits the same settings through op=settings without verification buttons', async () => {
  const app = harness(call => call.op === 'settings' ? { ok: true, settings: { ...state().settings, relevance: { ...state().settings.relevance, timeoutMs: 12345 } } } : state());
  await app.settle();
  app.showConfig(); await app.settle();
  assert.ok(app.all().some(node => node.props['aria-label'] === '记忆模型设置'));
  assert.match(app.text(), /这里的模型与阈值用于 Host 后台的记忆提取/);
  assert.equal(app.calls.filter(c => c.op === 'state').length, 2);
  assert.ok(app.find('相关性超时（ms）'));
  assert.equal(app.text().includes('真实验证提取'), false);
  await app.change('相关性超时（ms）', '12345');
  await app.click('保存设置');
  const saved = app.calls.filter(c => c.op === 'settings').at(-1);
  assert.equal(saved.options.method, 'POST');
  assert.equal(saved.body.settings.relevance.timeoutMs, 12345);
  assert.match(app.text(), /设置已保存；尚未因此验证模型/);
  assert.equal(app.find('相关性超时（ms）').props.value, 12345);
  app.destroy();
});

test('plugin page config section refuses to save when Host protocol is incompatible', async () => {
  const app = harness(() => legacyState(VERSION));
  await app.settle(); app.showConfig(); await app.settle();
  assert.match(app.text(), /Host 缺少/);
  assert.equal(app.find('保存设置').props.disabled, true);
  assert.equal(app.calls.some(c => c.op === 'settings'), false);
  app.destroy();
});

test('lets the user choose whether a memory is always loaded', async () => {
  const item = { ...memory, inclusion: 'searchable', userControlled: false, selectionRevision: 3 };
  const app = harness(call => {
    if (call.op === 'set-inclusion') { item.inclusion = call.body.inclusion; item.userControlled = true; item.selectionRevision++; return { ok: true }; }
    return state({ memories: [item] });
  });
  await app.settle();
  await app.change('记忆使用方式 m1', 'essential');
  assert.deepEqual(app.calls.find(call => call.op === 'set-inclusion').body, { op: 'set-inclusion', id: 'm1', inclusion: 'essential', expectedRevision: 3 });
  assert.match(app.text(), /由你指定/); assert.equal(app.find('记忆使用方式 m1').props.value, 'essential');
  app.destroy();
});
test('memory detail shows review state, validity, evidence relations and decision timeline', async () => {
  const item={...memory,id:'status-memory',type:'status',content:'临时维护窗口',reviewState:'pending',validityKind:'interval',validFrom:'2026-10-20T00:00:00Z',validTo:'2026-10-25T00:00:00Z',validityPrecision:'day',timeZone:'Asia/Tokyo',lastConfirmedAt:'2026-10-21T00:00:00Z',evidence:[{id:'e1',evidenceKind:'user_statement',quote:'用户确认',quoteSha256:'a'.repeat(64),source:{sessionId:'origin-session',eventSeq:42}}],relations:[{id:'r1',relation:'supports',fromVersion:2,evidenceId:'e1',source:{sessionId:'origin-session',eventSeq:42}}],decisions:[{id:'d1',decisionType:'update',outcome:'applied',reasonCode:'corrected',shortReason:'证据更新',provider:'p',model:'m',reasoningEffort:'high',evidenceCount:1,createdAt:'2026-10-21T00:00:00Z'}]};
  const app=harness(()=>state({memories:[item]}));await app.settle();
  assert.match(app.text(),/复核 pending/);assert.match(app.text(),/有效期：interval/);assert.match(app.text(),/Asia\/Tokyo/);assert.match(app.text(),/证据关系 · 1/);assert.match(app.text(),/决策时间线 · 1/);assert.match(app.text(),/corrected/);
  app.destroy();
});

test('recall records expose explicit feedback only for an injected recall', async () => {
  const injected={id:'r-hit',sessionId:'s1',requestId:'req-hit',messageId:'req-hit',status:'injected',query:'问题',memoryIds:['m1'],memoryRefs:[{id:'m1',version:2}],feedback:[],createdAt:'2026-10-21T00:00:00Z'};
  const app=harness(call=>call.op==='feedback'?{ok:true,feedback:[]}:state({retrievals:[injected]}));await app.settle();
  await app.click('有用');
  assert.deepEqual(app.calls.find(call=>call.op==='feedback').body,{sessionId:'s1',recallId:'r-hit',requestId:'req-hit',memoryId:'m1',version:2,kind:'explicit_useful',op:'feedback'});
  assert.match(app.text(),/召回反馈已记录/);app.destroy();
});

test('open conflict groups render isolated members and allow an explicit distinct-claims decision', async () => {
  const group={id:'g1',scope:'global',projectId:null,factKey:'key',state:'open',reasonCode:'fact_key_conflict',attempts:0,maxAttempts:3,route:{provider:'p',model:'m',reasoningEffort:'high',effortSource:'explicit'},members:[{kind:'memory',id:'old',version:1,memory:{content:'旧事实',reviewState:'pending'}},{kind:'candidate',id:'c1',candidate:{state:'pending',memory:{content:'新事实'}}}]};
  const app=harness(call=>call.op==='resolveConflict'?{ok:true,conflict:{...group,state:'resolved'},memory:null}:state({conflicts:[group]}));await app.settle();
  assert.match(app.text(),/待复核冲突 · 1/);assert.match(app.text(),/旧事实/);assert.match(app.text(),/新事实/);assert.match(app.text(),/p\/m · high · explicit/);
  await app.click('判为不同事实');assert.deepEqual(app.calls.find(call=>call.op==='resolveConflict').body,{groupId:'g1',candidateId:'c1',decision:'distinct_claims',op:'resolveConflict'});assert.match(app.text(),/冲突组已处理/);app.destroy();
});

test('same-key conflict candidates cannot be labelled as separate facts', async () => {
  const group={id:'g2',scope:'global',projectId:null,factKey:'key',state:'open',reasonCode:'fact_key_conflict',attempts:0,maxAttempts:3,route:{provider:'p',model:'m'},members:[{kind:'memory',id:'old',version:1,memory:{factKey:'key',content:'旧事实',reviewState:'pending'}},{kind:'candidate',id:'c2',candidate:{state:'pending',memory:{factKey:'key',content:'新事实'}}}]};
  const app=harness(()=>state({conflicts:[group]}));await app.settle();
  assert.equal(app.find('判为不同事实').props.disabled,true);app.destroy();
});

test('zero-candidate review groups expose an explicit close action', async () => {
  const group={id:'g3',scope:'global',projectId:null,factKey:null,state:'open',reasonCode:'consolidation_needs_review',attempts:0,maxAttempts:3,route:{},members:[{kind:'memory',id:'old',version:1,memory:{content:'须人工复核的事实',reviewState:'pending'}}]};
  const app=harness(call=>call.op==='resolveConflict'?{ok:true,conflict:{...group,state:'resolved'},memory:null}:state({conflicts:[group]}));await app.settle();
  await app.click('判为不同事实');assert.deepEqual(app.calls.find(call=>call.op==='resolveConflict').body,{groupId:'g3',decision:'distinct_claims',op:'resolveConflict'});assert.match(app.text(),/冲突组已处理/);app.destroy();
});

test('triggering offline consolidation reports its actual operation', async () => {
  const enabled=state();enabled.settings.consolidation.enabled=true;enabled.consolidation={status:'ready'};
  const app=harness(call=>call.op==='consolidation-trigger'?{ok:true}:enabled);await app.settle();
  await app.click('立即检查候选');
  assert.match(app.text(),/已触发离线巩固检查/);app.destroy();
});

test('shows the latest committed changes above the input and isolates sessions', async () => {
  let items = [];
  const app = harness(call => call.op === 'changes' ? { ok: true, changes: call.url.searchParams.get('sessionId') === 's1' ? [{ turn: 2, eventSeq: 20, items }, { turn: 1, eventSeq: 30, items: [{ type: 'added', id: 'old', content: '旧回合' }] }] : [{ turn: 1, items: [{ type: 'added', id: 'other', content: '另一个会话' }] }] } : state());
  await app.settle(); app.showTail({ session: { sessionId: 's1' } }); await app.settle();
  assert.match(app.text(), /旧回合/);
  items = [{ type: 'added', id: 'm1', content: '偏好中文' }, { type: 'updated', id: 'm2', content: '项目事实' }];
  await app.poll(); assert.match(app.text(), /记忆\s+已变更 2 条/); assert.match(app.text(), /新增：偏好中文/); assert.match(app.text(), /更新：项目事实/); assert.doesNotMatch(app.text(), /旧回合/);
  assert.equal(app.calls.find(call => call.op === 'changes').url.searchParams.get('sessionId'), 's1');
  assert.equal(app.all().find(node=>node.type==='details').props['data-jiyi-turn'], 2);
  app.showTail({ sessionId: 's2' }); assert.doesNotMatch(app.text(), /偏好中文|项目事实/); await app.settle();
  assert.match(app.text(), /另一个会话/); assert.doesNotMatch(app.text(), /偏好中文|项目事实/);
  app.destroy();
});

test('a newer Client safely renders older Hosts with absent relevance fields and blocks all runtime actions', async () => {
  for (const version of ['0.1.0', '0.1.2']) {
    const app = harness(() => legacyState(version)); await app.settle();
    assert.match(app.text(), new RegExp('Client v' + versionRe + ' / Host v' + version.replaceAll('.', '\\.')));
    assert.match(app.text(), /不一致.*完全重启/); assert.match(app.text(), /相关性状态：Host 未提供（未验证）/);
    for (const label of ['保存设置', '真实验证提取', '真实验证 Embedding', '真实验证相关性', '纠正', '删除', '重试提取', '检索']) assert.equal(app.find(label).props.disabled, true, label);
    // Even direct handler dispatch must not bypass disabled controls.
    await app.find('真实验证相关性').props.onClick(); await app.find('保存设置').props.onClick(); await app.submit();
    assert.equal(app.calls.some(call => call.options.method === 'POST' || call.op === 'search'), false);
    assert.equal(app.find('相关性提供方').props.value, ''); assert.equal(app.find('向量候选阈值').props.value, 0.5);
    app.destroy();
  }
});

test('new Client refuses mutations against a fully capable but still loaded 0.1.6 Host', async () => {
  const app = harness(() => state({ version: '0.1.6' })); await app.settle();
  assert.match(app.text(), new RegExp('Client v' + versionRe + ' / Host v0\\.1\\.6'));
  assert.match(app.text(), /不一致.*完全重启/);
  for (const label of ['保存设置', '真实验证提取', '真实验证 Embedding', '真实验证相关性', '纠正', '删除', '重试提取', '检索']) assert.equal(app.find(label).props.disabled, true, label);
  await app.find('真实验证相关性').props.onClick(); await app.find('保存设置').props.onClick(); await app.submit();
  assert.equal(app.calls.some(call => call.options.method === 'POST' || call.op === 'search'), false);
  app.destroy();
});

test('project aliases can be viewed, added and deleted; failed additions keep their draft and visible error', async () => {
  const project={id:'p1',name:'测试项目',path:'/project',aliases:['/project','旧别名']};let fail=false;
  const app=harness(call=>{
    if(call.op==='addProjectAlias') {
      if(fail)return {ok:false,httpStatus:400,error:'别名冲突'};
      project.aliases.push(call.body.alias);return {ok:true,project};
    }
    if(call.op==='deleteProjectAlias') {project.aliases=project.aliases.filter(a=>a!==call.body.alias);return {ok:true,project};}
    return state({projects:[project]});
  });
  await app.settle();assert.match(app.text(),/项目别名/);assert.match(app.text(),/旧别名/);
  await app.change('测试项目的新别名','银杏 B');await app.click('添加 测试项目 的别名');
  assert.deepEqual(app.calls.find(c=>c.op==='addProjectAlias').body,{id:'p1',alias:'银杏 B',op:'addProjectAlias'});
  assert.equal(app.find('测试项目的新别名').props.value,'');assert.match(app.text(),/项目别名已添加/);
  await app.click('删除别名 银杏 B');assert.match(app.text(),/项目别名已删除/);
  assert.equal(project.aliases.includes('银杏 B'),false);
  fail=true;await app.change('测试项目的新别名','保留草稿');await app.click('添加 测试项目 的别名');
  assert.equal(app.find('测试项目的新别名').props.value,'保留草稿');assert.match(app.text(),/操作失败：别名冲突/);
  await app.poll();assert.match(app.text(),/操作失败：别名冲突/);app.destroy();
});

test('load failures stay visible instead of pretending an empty success', async () => {
  const app = harness(() => ({ ok: false, httpStatus: 503, error: 'storage unavailable' })); await app.settle();
  assert.match(app.text(), /加载失败：storage unavailable/); assert.match(app.text(), /未加载记忆数据/); assert.doesNotMatch(app.text(), /没有匹配的记忆/); app.destroy();
});

test('sources use official session API and read exact whitelisted event', async () => {
  const app = harness(call => call.op === 'source' ? { ok: true, source: { sessionId: 'origin-session', eventSeq: 42, event: { type: 'message', content: '原始事件正文' } } } : state()); await app.settle();
  await app.click('打开来源会话'); assert.deepEqual(app.opened, ['origin-session']);
  await app.click('查看来源事件'); assert.match(app.text(), /原始事件正文/);
  assert.deepEqual(app.calls.find(c => c.op === 'source').body, { sessionId: 'origin-session', eventSeq: 42, op: 'source' });
  assert.equal(app.calls.some(c => /session.*route/.test(c.url.pathname)), false); app.destroy();
});

test('manual correction audit is not exposed as a real session and keeps exact event access', async () => {
  const manual = { origin: 'manual', sessionId: 'jiyi-manual:audit-uuid', eventSeq: 0, eventId: 'audit-uuid', eventTime: '2026-10-24T01:00:00Z', quote: '界面手动纠正正文', evidence: 'manual-correction' };
  const app = harness(call => call.op === 'source' ? { ok: true, source: { ...manual, event: { type: 'manual-correction', content: '审计原始事件' } } } : state({ memories: [{ ...memory, projectName: '友好项目名称', sources: [manual] }] })); await app.settle();
  assert.match(app.text(), /管理界面手动纠正记录/); assert.match(app.text(), /项目 友好项目名称/); assert.match(app.text(), /界面手动纠正正文/);
  assert.equal(app.all().filter(n => n.type === 'button' && app.text(n) === '打开来源会话').length, 0);
  await app.click('查看来源事件'); assert.deepEqual(app.calls.find(c => c.op === 'source').body, { sessionId: 'jiyi-manual:audit-uuid', eventSeq: 0, op: 'source' });
  assert.match(app.text(), /审计原始事件/); assert.deepEqual(app.opened, []); app.destroy();
});

test('manual creation provenance is not mislabeled as correction', async () => {
  const source = { origin: 'manual', evidence: 'manual-create', sessionId: 'jiyi-manual:new', eventSeq: 0, quote: '新建正文' };
  const app = harness(() => state({ memories: [{ ...memory, sources: [source] }] })); await app.settle();
  assert.match(app.text(), /管理界面手动新建记录/); assert.doesNotMatch(app.text(), /管理界面手动纠正记录/);
  assert.equal(app.all().filter(n => n.type === 'button' && app.text(n) === '打开来源会话').length, 0); app.destroy();
});

test('correction failure retains draft; poll does not clear operation errors; delete requires confirmation', async () => {
  const app = harness(call => call.op === 'correct' ? { ok: false, httpStatus: 409, error: '版本冲突' } : call.op === 'delete' ? { ok: true } : state()); await app.settle();
  await app.click('纠正'); await app.change('纠正记忆内容', '真实纠正草稿'); await app.click('保存纠正');
  assert.equal(app.find('纠正记忆内容').props.value, '真实纠正草稿'); assert.match(app.text(), /操作失败：版本冲突/); assert.doesNotMatch(app.text(), /记忆已纠正/);
  await app.poll(); assert.match(app.text(), /操作失败：版本冲突/);
  await app.click('删除'); assert.equal(app.calls.some(c => c.op === 'delete'), false);
  await app.click('确认删除'); assert.deepEqual(app.calls.find(c => c.op === 'delete').body, { id: 'm1', version: 2, op: 'delete' }); app.destroy();
});

test('search sends session and filters, exposes timeout, and range filter works locally', async () => {
  const app = harness(call => call.op === 'search' ? { ok: true, status: 'timeout', memories: [], ambiguities: [], error: 'embedding timed out' } : state()); await app.settle();
  await app.change('记忆范围', 'global'); assert.match(app.text(), /显示 0 条/);
  await app.change('记忆范围', 'p1'); await app.change('搜索记忆', '中文'); await app.submit();
  const call = app.calls.find(c => c.op === 'search'); assert.equal(call.url.searchParams.get('sessionId'), 's1'); assert.equal(call.url.searchParams.get('scope'), 'p1'); assert.equal(call.url.searchParams.get('query'), '中文');
  assert.equal(call.url.searchParams.has('status'), false);
  assert.match(app.text(), /检索状态：timeout · embedding timed out/); assert.match(app.text(), /本次检索未能完成/); assert.doesNotMatch(app.text(), /没有匹配的记忆/);
  await app.change('记忆状态', 'deleted'); assert.match(app.text(), /显示 0 条/);
  app.destroy();
});

test('changing a query while search is in flight discards stale results and releases busy state', async () => {
  let resolveSearch; const app = harness(call => call.op === 'search' ? new Promise(resolve => { resolveSearch = resolve; }) : state()); await app.settle();
  const pending = app.submit(); await app.settle(); await app.change('搜索记忆', 'new query');
  resolveSearch({ ok: true, status: 'hit', memories: [{ ...memory, content: 'STALE RESULT' }] }); await pending;
  assert.doesNotMatch(app.text(), /STALE RESULT/); assert.equal(app.find('检索').props.disabled, false); app.destroy();
});

test('adjudication and consolidation settings persist from UI while legacy status setting stays removed',async()=>{
  let persisted=state();
  const handler=call=>{
    if(call.op==='settings') {persisted={...persisted,settings:structuredClone(call.body.settings)};return {ok:true,settings:persisted.settings};}
    return persisted;
  };
  let app=harness(handler);await app.settle();
  try {
    await app.change('自动裁决最低置信度','0.9');await app.change('巩固间隔（小时）','12');
    await app.click('保存设置');
    assert.equal(app.calls.find(c=>c.op==='settings').body.settings.adjudication.minConfidence,0.9);assert.equal(persisted.settings.consolidation.intervalHours,12);assert.equal(Object.hasOwn(persisted.settings.retrieval,'statusStaleHours'),false);
    app.destroy();app=harness(handler);await app.settle();
    assert.equal(app.find('自动裁决最低置信度').props.value,0.9);assert.equal(app.find('巩固间隔（小时）').props.value,12);
  } finally {app.destroy();}
});

test('settings saving is distinct from real extraction and embedding validation', async () => {
  const app = harness(call => call.op === 'settings' ? { ok: true } : call.op === 'verifyExtraction' ? { ok: false, httpStatus: 500, error: '真实服务未连接' } : call.op === 'verifyEmbedding' ? { ok: true, result: { ok: true, status: 'ready', model: 'local-test', dimensions: 384 } } : state()); await app.settle();
  await app.click('保存设置'); assert.match(app.text(), /设置已保存；尚未因此验证模型/); assert.equal(app.calls.some(c => /^verify/.test(c.op)), false);
  await app.click('真实验证提取'); assert.match(app.text(), /操作失败：真实服务未连接/); assert.doesNotMatch(app.text(), /真实提取验证成功/);
  await app.click('真实验证 Embedding'); assert.match(app.text(), /真实 Embedding 验证成功/); assert.match(app.text(), /384/);
  await app.change('高级设置 JSON', '{broken'); const before = app.calls.length; await app.click('保存设置'); assert.equal(app.calls.length, before); assert.ok(app.all().some(n => n.props.role === 'alert')); app.destroy();
});

test('nested failed or absent verification never renders verified success', async () => {
  const app = harness(call => call.op === 'verifyEmbedding' ? { ok: true, result: { ok: false, status: 'ready', error: '向量结果校验失败' } } : call.op === 'verifyExtraction' ? { ok: true } : state()); await app.settle();
  await app.click('真实验证 Embedding'); assert.match(app.text(), /操作失败：向量结果校验失败/); assert.doesNotMatch(app.text(), /真实 Embedding 验证成功/);
  await app.click('真实验证提取'); assert.match(app.text(), /Host 未返回真实验证成功状态/); assert.doesNotMatch(app.text(), /真实提取验证成功/); app.destroy();
});

test('relevance settings are independent and saving candidate controls never auto-verifies or enables Host', async () => {
  const settings = { ...state().settings, enabled: false };
  const app = harness(call => call.op === 'settings' ? { ok: true, settings: call.body.settings } : state({ settings })); await app.settle();
  assert.equal(app.find('相关性提供方').props.value, 'openai-codex'); assert.equal(app.find('相关性模型').props.value, 'gpt-6.1-sol');
  assert.equal(app.find('相关性超时（ms）').props.value, 10000); assert.equal(app.find('候选上限（1–20）').props.value, 12); assert.equal(app.find('向量候选阈值').props.value, 0.2);
  assert.equal(app.find('候选上限（1–20）').props.min, 1); assert.equal(app.find('候选上限（1–20）').props.max, 20);
  assert.match(app.text(), /保存配置不等于验证/); assert.match(app.text(), /后台独立 LLM.*已配置的账号/); assert.match(app.text(), /不是主会话模型工具调用/); assert.match(app.text(), /不退回向量分数注入/); assert.match(app.text(), /0\.2 仅用于扩展候选，不是注入门槛/);
  await app.poll(); assert.equal(app.calls.some(call => call.options.method === 'POST'), false);
  await app.change('相关性提供方', 'independent-provider'); await app.change('相关性模型', 'independent-model'); await app.change('相关性超时（ms）', '17000'); await app.change('候选上限（1–20）', '16');
  assert.equal(app.calls.some(call => call.options.method === 'POST'), false); await app.click('保存设置');
  const saved = app.calls.find(call => call.op === 'settings').body.settings;
  assert.deepEqual(saved.relevance, { provider: 'independent-provider', model: 'independent-model', timeoutMs: 17000 }); assert.equal(saved.retrieval.maxCandidates, 16); assert.equal(saved.retrieval.semanticThreshold, 0.2); assert.equal(saved.enabled, false);
  assert.deepEqual(saved.extraction, state().settings.extraction); assert.deepEqual(saved.embedding, state().settings.embedding);
  assert.equal(app.calls.some(call => /^verify/.test(call.op)), false); assert.match(app.text(), /设置已保存；尚未因此验证模型/); assert.match(app.text(app.find('相关性状态')), /not-verified/); app.destroy();
});

test('a current Host with an existing threshold is not silently changed to the new default', async () => {
  const settings = { ...state().settings, retrieval: { ...state().settings.retrieval, semanticThreshold: 0.5 } };
  const app = harness(() => state({ settings })); await app.settle(); await app.poll();
  assert.equal(app.find('向量候选阈值').props.value, 0.5); assert.equal(JSON.parse(app.find('高级设置 JSON').props.value).retrieval.semanticThreshold, 0.5); assert.equal(app.calls.some(call => call.options.method === 'POST'), false); app.destroy();
});

test('the third real verification uses only verifyRelevance and displays actual ready state', async () => {
  let relevance = state().models.relevance;
  const app = harness(call => {
    if (call.op === 'verifyRelevance') { relevance = { ...relevance, status: 'ready', ready: true, lastSuccessAt: '2026-10-24T10:00:00Z' }; return { ok: true, result: { ok: true, status: 'ready', ready: true, model: 'judge-actual-model' }, models: { relevance } }; }
    return state({ models: { ...state().models, relevance } });
  }); await app.settle();
  assert.match(app.text(app.find('相关性状态')), /not-verified/); assert.doesNotMatch(app.text(app.find('相关性状态')), /"ready":true/);
  await app.click('真实验证相关性');
  assert.deepEqual(app.calls.find(call => call.op === 'verifyRelevance').body, { op: 'verifyRelevance' }); assert.equal(app.calls.filter(call => /^verify/.test(call.op)).length, 1);
  assert.match(app.text(), /真实相关性验证成功/); assert.match(app.text(), /judge-actual-model/); assert.match(app.text(app.find('相关性状态')), /"ready":true/); app.destroy();
});

test('relevance verification failures and contradictory ready results never claim success', async () => {
  for (const response of [
    { ok: false, httpStatus: 400, error: '相关性模型未配置' },
    { ok: true, result: { status: 'timeout', error: '相关性真实请求超时' } },
    { ok: true, result: { status: 'ready', ok: false, error: '判别结果无效' } },
    { ok: true, result: { status: 'ready', ready: false, error: '判别模型未就绪' } },
    { ok: true },
  ]) {
    const relevance = { ...state().models.relevance, status: 'error', ready: false, error: '后台判别失败，不注入候选' };
    const app = harness(call => call.op === 'verifyRelevance' ? response : state({ models: { ...state().models, relevance } })); await app.settle();
    assert.match(app.text(app.find('相关性状态')), /后台判别失败，不注入候选/); await app.click('真实验证相关性');
    assert.match(app.text(), /操作失败/); assert.doesNotMatch(app.text(), /真实相关性验证成功/); assert.doesNotMatch(app.text(app.find('相关性状态')), /"ready":true/); app.destroy();
  }
});

test('missing required relevance capabilities fail closed and upgrade polling restores actual fields without auto-saving', async () => {
  let value = legacyState(VERSION);
  const app = harness(() => value); await app.settle();
  assert.match(app.text(), new RegExp('缺少 v' + versionRe + ' 相关性配置或状态字段')); assert.equal(app.find('保存设置').props.disabled, true); assert.equal(app.find('真实验证相关性').props.disabled, true);
  await app.find('真实验证相关性').props.onClick(); assert.equal(app.calls.some(call => call.options.method === 'POST'), false);
  value = state(); await app.poll(); assert.equal(app.find('相关性提供方').props.value, 'openai-codex'); assert.equal(app.find('候选上限（1–20）').props.value, 12); assert.equal(app.find('真实验证相关性').props.disabled, false); assert.equal(app.calls.some(call => call.options.method === 'POST'), false);
  const staleVerify = app.find('真实验证相关性').props.onClick;
  value = legacyState(); await app.poll(); await staleVerify(); await app.settle();
  assert.equal(app.calls.some(call => call.options.method === 'POST'), false); assert.match(app.text(), /不一致.*完全重启/); app.destroy();
});

test('HTTP 200 search failures retain actual status and disabled Host failures remain visible', async () => {
  const app = harness(call => call.op === 'search' ? { ok: false, status: 'not-configured', memories: [], ambiguities: [], error: '尚未配置模型' } : state({ settings: { ...state().settings, enabled: false }, failure: { where: 'queue', error: '磁盘写入失败' } })); await app.settle();
  assert.match(app.text(), /自动记忆已停用/); assert.match(app.text(), /Host 后台失败/); assert.match(app.text(), /磁盘写入失败/);
  await app.submit(); assert.match(app.text(), /检索状态：not-configured · 尚未配置模型/); assert.doesNotMatch(app.text(), /没有匹配的记忆/); app.destroy();
});

test('stage diagnostics remain visible for failed searches and automatic recall records', async () => {
  const diagnostics={errorCode:'RETRIEVAL_TIMEOUT',stages:[{component:'llm',stage:'stream',status:'timeout',durationMs:9}]};
  const app=harness(call=>call.op==='search'?{ok:false,status:'timeout',memories:[],ambiguities:[],error:'真实失败',diagnostics}:state({retrievals:[{sessionId:'s1',messageId:'r',status:'timeout',query:'q',memoryIds:[],details:{diagnostics}}]}));
  await app.settle();assert.match(app.text(),/阶段诊断（失败不等于无命中）/);assert.match(app.text(),/RETRIEVAL_TIMEOUT/);
  await app.submit();assert.match(app.text(),/检索状态：timeout/);assert.match(app.text(),/"stage": "stream"/);assert.doesNotMatch(app.text(),/没有匹配的记忆/);app.destroy();
});

test('Host settingsError is shown on the panel until the payload omits it', async () => {
  let value = state({ settingsError: '设置文件无法加载：Unexpected token' });
  const app = harness(() => value); await app.settle();
  assert.match(app.text(), /设置文件错误：设置文件无法加载：Unexpected token/);
  value = state(); await app.poll();
  assert.doesNotMatch(app.text(), /设置文件错误/);
  app.destroy();
});

test('retry sends queue id and unmount aborts only client reads, never disables Host', async () => {
  const app = harness(call => call.op === 'retry' ? { ok: true } : state()); await app.settle();
  await app.click('重试提取'); assert.deepEqual(app.calls.find(c => c.op === 'retry').body, { id: 'q1', op: 'retry' }); assert.match(app.text(), /结果以队列状态为准/);
  app.destroy(); assert.equal(app.timers.size, 0); assert.equal(app.calls.some(c => ['stop', 'shutdown', 'disable'].includes(c.op)), false); assert.equal(app.calls.some(c => c.op === 'settings'), false);
});
