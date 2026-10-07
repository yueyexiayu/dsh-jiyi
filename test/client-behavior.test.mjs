import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the shipped client, not a duplicate of its request/state logic.
const source = fs.readFileSync(process.env.JIYI_CLIENT_SOURCE || new URL("../lib/client.js", import.meta.url), "utf8");
function harness() {
  const hooks = [], requests = [], intervals = new Map(), timers = new Map();
  let cursor = 0, pending = [], dirty = false, mounted = true, component, tree;
  let props = { sessionId: "S" }, nextTimer = 0, writesAfterUnmount = 0;
  const same = (a, b) => a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: initial };
      return [hooks[i].value, value => {
        if (!mounted) writesAfterUnmount++;
        const next = typeof value === "function" ? value(hooks[i].value) : value;
        if (!Object.is(next, hooks[i].value)) { hooks[i].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; return hooks[i] || (hooks[i] = { current: initial }); },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { deps, fn };
      return hooks[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!hooks[i] || !same(hooks[i].deps, deps)) pending.push(() => {
        hooks[i]?.cleanup?.();
        hooks[i] = { deps, cleanup: fn() };
      });
    },
  };
  const ctx = {
    effect: fn => fn(), sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_, fn) => fn(), register: (options, fn) => {
      if (options.name === "sidebar.right.pane.tab") component = fn({}).type;
      return () => {};
    } },
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply(ctx) } },
    document: { getElementById: () => ({ textContent: "" }) }, URLSearchParams, AbortController,
    // Deliberately allow aborted requests to resolve: generation checks must still win.
    fetch: (url, init = {}) => new Promise((resolve, reject) => {
      const body = init.body ? JSON.parse(init.body) : Object.fromEntries(new URL(url, "http://fixture").searchParams);
      requests.push({ body, signal: init.signal, resolve: value => resolve({ json: async () => value }), reject });
    }),
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const all = node => !node || typeof node !== "object" ? [] : [node, ...node.children.flatMap(all)];
  const text = node => typeof node === "string" ? node : node?.children?.map(text).join("") || "";
  function render() {
    let count = 0;
    do {
      assert.ok(++count < 30, "render/effect loop terminates");
      dirty = false; cursor = 0; tree = component(props);
      const effects = pending; pending = []; effects.forEach(fn => fn());
    } while (dirty);
  }
  const button = label => all(tree).find(n => n.type === "button" && text(n) === label);
  const input = () => all(tree).find(n => n.props.className === "jy-input");
  render();
  return {
    requests, intervals, timers, render, button, input,
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); },
    click(label) { const b = button(label); assert.ok(b, `button ${label}`); assert.ok(!b.props.disabled, `${label} enabled`); b.props.onClick(); render(); },
    type(value) { input().props.onChange({ target: { value } }); render(); },
    preview: () => text(all(tree).find(n => n.type === "pre")),
    errors: () => all(tree).filter(n => n.props.className === "jy-error").map(text),
    text: () => text(tree),
    poll() { [...intervals.values()].forEach(fn => fn()); render(); },
    session(sessionId) { props = { sessionId }; render(); },
    unmount() { hooks.forEach(h => h?.cleanup?.()); mounted = false; },
    writesAfterUnmount: () => writesAfterUnmount,
  };
}
const entries = ["A", "B"].map(path => ({ path, label: path, relative: path, scope: "workspace", group: "topics", deletable: true }));
const status = (origin = "workspace", extra = {}) => ({ ok: true, enabled: true, origin, entries, ...extra });
async function ready() { const h = harness(); h.requests[0].resolve(status()); await h.settle(); return h; }

test("newest status wins even if superseded fetch resolves; loading is released", async () => {
  const h = harness(); h.poll();
  h.requests[1].resolve(status("NEW")); await h.settle();
  h.requests[0].resolve(status("OLD")); await h.settle();
  assert.match(h.text(), /NEW/); assert.doesNotMatch(h.text(), /OLD/);
  assert.equal(h.button("刷新").props.disabled, false);
  assert.equal(h.requests[0].signal.aborted, true);
  h.poll(); h.poll();
  h.requests[3].resolve(status("LATEST")); await h.settle();
  h.requests[2].reject(new Error("stale status error")); await h.settle();
  assert.deepEqual(h.errors(), []);
});

test("selection clears old preview and disables deletion until matching read succeeds", async () => {
  const h = await ready(); h.click("AA");
  h.requests[1].resolve({ ok: true, content: "CONTENT A" }); await h.settle();
  h.click("BB");
  assert.equal(h.preview(), "加载中…"); assert.equal(h.button("删除").props.disabled, true);
  h.requests[2].resolve({ ok: true, content: "CONTENT B" }); await h.settle();
  assert.equal(h.preview(), "CONTENT B"); assert.equal(h.button("删除").props.disabled, false);
});

test("late preview cannot return after successful deletion", async () => {
  const h = await ready(); h.click("AA");
  h.requests[1].resolve({ ok: true, content: "A" }); await h.settle();
  h.click("删除"); h.click("确认删除");
  const deletion = h.requests[2];
  h.poll(); h.requests[3].resolve(status("workspace", { entries: entries.map(e => ({ ...e, mtimeMs: 2, size: 5 })) })); await h.settle();
  const lateRead = h.requests[4]; assert.equal(lateRead.body.action, "read");
  deletion.resolve({ ok: true }); await h.settle();
  lateRead.resolve({ ok: true, content: "DELETED CONTENT" }); await h.settle();
  assert.equal(h.preview(), "选择左侧一条记忆");
  assert.equal(h.button("删除"), undefined);
  assert.equal(lateRead.signal?.aborted, true);
});

test("operation error survives healthy polls and a retry can replace it", async () => {
  const h = await ready(); h.click("整理");
  h.requests[1].resolve({ ok: false, error: "permission denied" }); await h.settle();
  h.poll(); h.requests[2].resolve(status()); await h.settle();
  assert.deepEqual(h.errors(), ["permission denied"]);
  h.click("整理"); h.requests[3].resolve({ ok: true }); await h.settle();
  h.requests[4].resolve(status()); await h.settle();
  assert.deepEqual(h.errors(), []);
});

test("remember only clears the submitted draft revision", async () => {
  const h = await ready(); h.type("first note"); h.click("记下");
  h.type("second unsent note");
  h.requests[1].resolve({ ok: true }); await h.settle();
  assert.equal(h.input().props.value, "second unsent note");
  h.requests[2].resolve(status()); await h.settle();
  h.click("记下"); h.requests[3].resolve({ ok: true }); await h.settle();
  assert.equal(h.input().props.value, "");
});

test("successful empty read is not loading; read errors disable deletion", async () => {
  const h = await ready(); h.click("AA");
  h.requests[1].resolve({ ok: true, content: "" }); await h.settle();
  assert.equal(h.preview(), ""); assert.equal(h.button("删除").props.disabled, false);
  h.click("BB"); h.requests[2].resolve({ ok: false, error: "missing B" }); await h.settle();
  assert.equal(h.preview(), "missing B"); assert.equal(h.button("删除").props.disabled, true);
});

test("session change cancels status/read/operation, prevents stale writes and clears refresh timer", async () => {
  const h = await ready(); h.click("AA"); h.type("old session"); h.click("记下");
  const read = h.requests[1], operation = h.requests[2];
  h.poll(); const poll = h.requests[3];
  h.session("T");
  for (const request of [read, operation, poll]) assert.equal(request.signal?.aborted, true);
  read.resolve({ ok: true, content: "OLD PREVIEW" }); operation.resolve({ ok: true }); poll.resolve(status("OLD SESSION"));
  await h.settle();
  assert.doesNotMatch(h.text(), /OLD PREVIEW|OLD SESSION/); assert.equal(h.timers.size, 0);
  const current = h.requests.findLast(r => r.body.action === "status" && r.body.sessionId === "T");
  current.resolve(status("NEW SESSION")); await h.settle();
  assert.match(h.text(), /NEW SESSION/);
  h.type("T draft"); h.click("记下"); h.requests.at(-1).resolve({ ok: true }); await h.settle();
  assert.equal(h.timers.size, 1);
  const pendingStatus = h.requests.at(-1); h.unmount();
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0); assert.equal(pendingStatus.signal.aborted, true);
  pendingStatus.resolve(status()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.writesAfterUnmount(), 0);
});

test("poll completion does not release an in-flight operation lock", async () => {
  const h = await ready(); h.click("整理"); h.poll();
  h.requests[2].resolve(status()); await h.settle();
  assert.equal(h.button("整理").props.disabled, true);
  h.requests[1].reject(new Error("network failed")); await h.settle();
  assert.match(h.errors().join(), /network failed/);
});

test("unchanged polls preserve pending reads, preview and delete confirmation; refresh forces read", async () => {
  const h = await ready(); h.click("AA");
  const read = h.requests[1];
  h.poll(); h.requests[2].resolve(status()); await h.settle();
  assert.equal(h.requests.length, 3); assert.equal(read.signal.aborted, false);
  read.resolve({ ok: true, content: "STABLE A" }); await h.settle();
  h.click("删除");
  h.poll(); h.requests[3].resolve(status()); await h.settle();
  assert.equal(h.requests.length, 4); assert.equal(h.preview(), "STABLE A");
  assert.equal(h.button("确认删除").props.disabled, false);
  h.click("刷新");
  assert.equal(h.requests[4].body.action, "status");
  assert.equal(h.requests[5].body.action, "read");
  assert.equal(h.preview(), "加载中…");
  h.requests[4].resolve(status()); h.requests[5].resolve({ ok: true, content: "FORCED A" }); await h.settle();
  assert.equal(h.preview(), "FORCED A"); assert.equal(h.requests.length, 6);
  assert.equal(h.button("确认删除"), undefined);
});

test("mtime and size changes refresh only the selected file; removal clears preview", async () => {
  const h = await ready(); h.click("AA");
  h.requests[1].resolve({ ok: true, content: "A" }); await h.settle();
  const changedB = entries.map(e => e.path === "B" ? { ...e, mtimeMs: 3, size: 7 } : e);
  h.poll(); h.requests[2].resolve(status("workspace", { entries: changedB })); await h.settle();
  assert.equal(h.requests.length, 3); assert.equal(h.preview(), "A");
  const changedA = changedB.map(e => e.path === "A" ? { ...e, mtimeMs: 4, size: 8 } : e);
  h.poll(); h.requests[3].resolve(status("workspace", { entries: changedA })); await h.settle();
  assert.equal(h.requests[4].body.action, "read"); assert.equal(h.preview(), "加载中…");
  h.requests[4].resolve({ ok: true, content: "CHANGED A" }); await h.settle();
  h.poll(); h.requests[5].resolve(status("workspace", { entries: changedA.map(e => e.path === "A" ? { ...e, size: 9 } : e) })); await h.settle();
  assert.equal(h.requests[6].body.action, "read");
  h.poll(); h.requests[7].resolve(status("workspace", { entries: [] })); await h.settle();
  h.requests[6].resolve({ ok: true, content: "REMOVED" }); await h.settle();
  assert.equal(h.preview(), "选择左侧一条记忆");
});

test("archived raw observations are explicitly reported as recoverable even for noop", async () => {
  const h = harness(); h.requests[0].resolve(status("workspace", { lastDream: { via: "model-noop", archived: 3, remaining: 0 } })); await h.settle();
  assert.match(h.text(), /本次归档 3 条原始观察（可恢复）/);
  assert.deepEqual(h.errors(), []);
});

test("unverified LLM coverage reports processing and archive without claiming merge", async () => {
  const h = harness(); h.requests[0].resolve(status("workspace", { lastDream: { via: "model", merged: 0, processed: 4, archived: 4, coverage: "unverified" } })); await h.settle();
  assert.match(h.text(), /已处理 4 条；原文已归档，未逐条验证主题覆盖/);
  assert.doesNotMatch(h.text(), /已合并|全部合并/);
});

test("disabled memory blocks Enter and displays backend failures", async () => {
  const h = harness(); h.requests[0].resolve(status("workspace", { enabled: false, lastDream: { via: "failed", remaining: 2 } })); await h.settle();
  h.type("draft"); h.input().props.onKeyDown({ key: "Enter" });
  assert.equal(h.requests.length, 1); assert.equal(h.button("记下").props.disabled, true);
  assert.match(h.errors().join(), /整理失败/); assert.match(h.text(), /模型读取\/删除/);
});
