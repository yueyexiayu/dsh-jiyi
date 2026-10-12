import { after } from "node:test";
import { mkdtemp as createTemp, rm } from "node:fs/promises";
import path from "node:path";

const roots = new Set();
const previousHome = process.env.DSH_HOME;
// Even an accidentally unwrapped apply() in this test process must never use
// the production fallback. Individual Host fixtures may temporarily override it.
process.env.DSH_HOME = await mkdtemp("/tmp/jiyi-default-home-");
export const tmpdir = () => "/tmp";
export async function mkdtemp(prefix) {
  const absolute = path.resolve(prefix);
  if (!absolute.startsWith("/tmp/jiyi-")) throw new Error("memory tests require an explicit /tmp/jiyi-* fixture");
  const root = await createTemp(absolute); roots.add(root); return root;
}
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  for (const root of roots) {
    if (!path.resolve(root).startsWith("/tmp/jiyi-")) throw new Error("refusing unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
