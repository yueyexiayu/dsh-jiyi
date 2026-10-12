import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("isolated Chrome shows cancelled/skipped capture and global dream scope without false injection success", async (t) => {
  const module = process.env.BIANJI_PLAYWRIGHT_MODULE;
  const react = process.env.BIANJI_REACT_UMD, reactDOM = process.env.BIANJI_REACT_DOM_UMD;
  if (!module || !react || !reactDOM) { t.skip("Set existing Playwright and React18 UMD fixture paths"); return; }
  const { chromium } = await import(module);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BIANJI_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage(); await page.route("**/*", (route) => route.abort());
    await page.setContent('<!doctype html><main id="root"></main>');
    for (const file of [react, reactDOM]) await page.addScriptTag({ content: readFileSync(file, "utf8") });
    await page.evaluate(() => {
      window.__fixture = { ok: true, enabled: true, hasCredentials: true, cwd: "/tmp", entries: [], lastCapture: { status: "cancelled" }, lastDream: { via: "noop", remaining: 0 } };
      window.fetch = async () => ({ ok: true, json: async () => structuredClone(window.__fixture) });
      window.__ModuleLoader__ = { load(spec) { window.__plugin = spec.factory(() => window.React); } };
    });
    await page.addScriptTag({ content: readFileSync(new URL("../lib/client.js", import.meta.url), "utf8") });
    await page.evaluate(() => {
      let Pane;
      window.__plugin.apply({ effect: fn => fn(), sidebarRightTabs: { register() {} }, slots: { inject: (_name, fn) => fn(), register(options, component) { if (options.name === "sidebar.right.pane.tab") Pane = component; } } });
      window.__root = window.ReactDOM.createRoot(document.getElementById("root"));
      window.__root.render(window.React.createElement(Pane, { sessionId: "fixture" }));
    });
    await page.getByText(/本会话回合已取消，未完成采集/).waitFor();
    assert.match(await page.locator("body").innerText(), /后台整理范围：全局及所有工作区/);
    await page.evaluate(() => { window.__fixture.lastCapture = { status: "skipped", reason: "max-tokens" }; window.__fixture.lastInjection = { status: "failed", sessionId: "fixture", code: "FIXTURE" }; });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByText(/未正常完成，已跳过采集/).waitFor();
    await page.getByText("记忆注入失败（FIXTURE）", { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("body").innerText(), /回合已取消|注入成功|采集成功/);
    await page.evaluate(() => window.__root.unmount()); assert.equal(await page.locator("#root").innerText(), "");
  } finally { await browser.close(); }
});
