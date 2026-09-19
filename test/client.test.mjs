import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("client guards Enter, versions preview reads, and surfaces dream failures", async () => {
  const src = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(src, /event\.key === "Enter" && note\.trim\(\) && !busy && !off/);
  assert.match(src, /previewGen/);
  assert.match(src, /previewGen\.current !== gen/);
  assert.match(src, /via === "failed"/);
  assert.match(src, /disabled: busy \|\| off/);
  assert.match(src, /模型读取\/删除/);
});
