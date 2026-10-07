import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("client declares every accessed service and registers the sidebar slots", async () => {
  const src = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  const slots = [], tabs = [];
  let plugin;
  vm.runInNewContext(src, {
    window: { __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, "jiyi");
      plugin = factory(name => { assert.equal(name, "react"); return {}; });
    } } },
    document: { getElementById: () => ({ textContent: "" }) },
  });
  const services = {
    effect: fn => fn(),
    sidebarRightTabs: { register: value => tabs.push(value) },
    slots: { inject: (_, fn) => fn(), register: options => slots.push(options) },
  };
  plugin.apply(new Proxy(services, { get(target, key) {
    if (key !== "effect") assert.ok(plugin.inject.includes(key), `${key} must be declared in inject`);
    return target[key];
  } }));
  assert.deepEqual(tabs.map(t => t.kind), ["jiyi"]);
  assert.deepEqual(slots.map(s => [s.name, s.key]), [
    ["sidebar.right.pane.tab", "jiyi"], ["sidebar.right.pane.tab.title", "jiyi"],
  ]);
});
