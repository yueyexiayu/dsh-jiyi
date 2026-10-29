import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../lib/index.js';

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const versionRe = VERSION.replaceAll('.', '\\.');
const memory = { id: 'm1', content: '偏好中文 <script>不会执行</script>', scope: 'project', projectId: 'p1', type: 'preference', status: 'active', version: 2, createdAt: '2026-10-20T01:02:00Z', updatedAt: '2026-10-21T01:02:00Z', extractionModel: 'extract-test', embeddingModel: 'embed-test', embeddingVersion: 3, sources: [{ sessionId: 'origin-session', eventSeq: 42, quote: '用户明确表达的原话' }] };
function state(overrides = {}) {
  return { ok: true, version: VERSION, settings: { enabled: true, extraction: { provider: 'openai-codex', model: 'gpt-6.1-sol', timeoutMs: 60000 }, embedding: { backend: 'local', model: 'local-test' }, relevance: { provider: 'openai-codex', model: 'gpt-6.1-sol', timeoutMs: 10000 }, retrieval: { timeoutMs: 10000, maxMemories: 6, maxCandidates: 12, maxChars: 4000, semanticThreshold: 0.2, statusStaleHours: 72 }, queue: { maxAttempts: 3 } }, memories: [memory], projects: [{ id: 'p1', name: '测试项目' }], queue: [{ id: 'q1', sessionId: 's1', eventSeq: 9, status: 'failed', attempts: 2, error: '实际提取失败', updatedAt: '2026-10-21T00:00:00Z' }], retrievals: [{ sessionId: 's1', messageId: 'msg-1', status: 'timeout', query: '当前问题', memoryIds: [], error: '实际召回超时', createdAt: '2026-10-21T00:00:00Z' }, { sessionId: 'other', messageId: 'other-msg', status: 'hit', query: '其他会话不展示', memoryIds: ['m1'] }], models: { extraction: { status: 'not-verified' }, embedding: { status: 'not-verified' }, relevance: { provider: 'openai-codex', model: 'gpt-6.1-sol', version: 'relevance-test-v1', status: 'not-verified', ready: false, activeRequests: 0, lastSuccessAt: null, error: null } }, ...overrides };
}
function legacyState(version = '0.1.2') {
  const value = state({ version });
  delete value.settings.relevance; delete value.settings.retrieval.maxCandidates; delete value.models.relevance;
  value.settings.retrieval.semanticThreshold = 0.5;
  return value;
}
function harness(handler = () => state()) {
  let definition, plugin, body, tree, current, dirty = true;
  const instances = new Map(), calls = [], opened = [], registrations = [], effects = [], timers = new Map();
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) { const instance = current, i = instance.index++; if (!(i in instance.hooks)) instance.hooks[i] = typeof initial === 'function' ? initial() : initial; return [instance.hooks[i], value => { instance.hooks[i] = typeof value === 'function' ? value(instance.hooks[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = current.index++; return current.hooks[i] || (current.hooks[i] = { current: initial }); },
    useEffect(fn, deps) { const instance = current, i = instance.index++, previous = instance.hooks[i]; if (!previous || deps.some((v, n) => v !== previous.deps[n])) { effects.push(() => { previous?.cleanup?.(); instance.hooks[i] = { deps, cleanup: fn() }; }); } },
  };
  const styles = new Map();
  vm.runInNewContext(code, { window: { location: { origin: 'http://127.0.0.1:57479' }, __ModuleLoader__: { load(value) { definition = value; } } }, document: { getElementById: id => styles.get(id), createElement: () => ({}), head: { appendChild(el) { styles.set(el.id, el); } } }, URL, AbortController, console, setInterval(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); }, fetch: async (url, options) => { const parsed = new URL(url, 'http://localhost'); const call = { url: parsed, options, op: parsed.searchParams.get('op'), body: options.body ? JSON.parse(options.body) : null }; calls.push(call); const result = await handler(call); return { ok: (result.httpStatus || 200) < 400, status: result.httpStatus || 200, json: async () => result }; } });
  plugin = definition.factory(name => { assert.equal(name, 'react'); return React; });
  const declared = Array.from(plugin.inject);
  const services = { sidebarRightTabs: { register(value) { registrations.push(value); return () => {}; } }, slots: { inject(name, register) { return register(); }, register(options, component) { registrations.push(options); if (options.name === 'sidebar.right.pane.tab') body = component; return () => {}; } }, uiWorkspace: { openSession(id) { opened.push(id); } }, effect(fn) { fn(); } };
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
    return { ...node, props: { ...node.props, children: (node.props.children || []).map((child, i) => expand(child, path + '/' + (child?.props?.key || i))) } };
  }
  function render() { dirty = false; tree = expand(React.createElement(body, { useTabInfo: () => ({ tab: { sessionId: 's1' } }) })); while (effects.length) effects.shift()(); return tree; }
  function all(node = tree) { if (node == null || typeof node !== 'object') return []; return [node, ...(node.props.children || []).flatMap(child => all(child))]; }
  function text(node = tree) { if (node == null) return ''; if (typeof node !== 'object') return String(node); return (node.props.children || []).map(text).join(' '); }
  async function settle() { for (let i = 0; i < 6; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } if (dirty) render(); }
  function find(label) { const result = all().find(node => node.props['aria-label'] === label || (node.type === 'button' && text(node) === label)); assert.ok(result, `missing control: ${label}\n${text()}`); return result; }
  async function click(label) { const node = find(label); assert.equal(!!node.props.disabled, false, `${label} disabled`); await node.props.onClick?.(); await settle(); }
  async function change(label, value) { find(label).props.onChange({ target: { value } }); await settle(); }
  render();
  return { plugin, calls, opened, registrations, timers, settle, text, all, find, click, change, render, async poll() { for (const fn of timers.values()) await fn(); await settle(); }, async submit() { await all().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); }, destroy() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); } };
}

test('registers isolated keyed jiyi tab and reads only declared services', async () => {
  const app = harness(); await app.settle();
  assert.deepEqual(Array.from(app.plugin.inject), ['slots', 'sidebarRightTabs', 'uiWorkspace']);
  assert.equal(app.registrations[0].id, 'jiyi'); assert.equal(app.registrations[0].kind, 'jiyi');
  assert.deepEqual(app.registrations.slice(1).map(x => [x.name, x.key]), [['sidebar.right.pane.tab', 'jiyi'], ['sidebar.right.pane.tab.title', 'jiyi']]);
  assert.match(app.text(), new RegExp('v' + versionRe)); assert.match(app.text(), /extract-test/); assert.match(app.text(), /embed-test/); assert.match(app.text(), /seq 42/); assert.match(app.text(), /用户明确表达的原话/);
  assert.doesNotMatch(app.text(), /其他会话不展示/); assert.equal(app.all().some(n => n.type === 'script'), false);
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

test('statusStaleHours field saves the numeric setting and remount reloads it before restoring 72',async()=>{
  let persisted=state();
  const handler=call=>{
    if(call.op==='settings') {persisted={...persisted,settings:structuredClone(call.body.settings)};return {ok:true,settings:persisted.settings};}
    return persisted;
  };
  let app=harness(handler);await app.settle();
  try {
    await app.change('状态记忆降序时长（小时）','96');
    assert.equal(JSON.parse(app.find('高级设置 JSON').props.value).retrieval.statusStaleHours,96);
    await app.click('保存设置');
    assert.equal(app.calls.find(c=>c.op==='settings').body.settings.retrieval.statusStaleHours,96);
    assert.equal(persisted.settings.retrieval.statusStaleHours,96);
    app.destroy();app=harness(handler);await app.settle();
    assert.equal(app.find('状态记忆降序时长（小时）').props.value,96);
    await app.change('状态记忆降序时长（小时）','72');await app.click('保存设置');
    assert.equal(persisted.settings.retrieval.statusStaleHours,72);
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
