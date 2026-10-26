import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const sdkBase = 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';

if (!process.versions.electron) {
  test('installed desktop SDK actually executes and consumes jiyi_search output', () => {
    assert.ok(existsSync(executable), 'Installed desktop Electron executable is required; this regression must not silently skip SDK execution');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    // A nested Node test worker marker suppresses discovery in a spawned runner.
    // Remove it and also demand the named SDK test output, never accept an empty run.
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(executable, ['--test', fileURLToPath(import.meta.url)], {
      env, encoding: 'utf8', timeout: 30000,
    });
    assert.ifError(child.error);
    assert.match(child.stdout, /real ToolRuntime executes disabled search/, `No installed SDK assertions ran:\n${child.stdout}\n${child.stderr}`);
    assert.equal(child.status, 0, `Installed SDK execution regression failed:\n${child.stdout}\n${child.stderr}`);
  });
} else {
  const [{ Context }, { ToolRuntime }, llm, { apply, validateSettings }, { MemoryStore }] = await Promise.all([
    import(sdkBase + 'cordis/lib/index.js'),
    import(sdkBase + 'dsh-tools/lib/index.js'),
    import(sdkBase + 'dsh-llm/lib/index.js'),
    import('../lib/index.js'),
    import('../lib/store.js'),
  ]);

  async function fixture({ enabled = false, seed = false, configured = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'jiyi-tool-runtime-'));
    // Explicit isolated storage: null backend for disabled/error cases; configured
    // backend only with zero records, which returns before any embedding call.
    // Never use ~/.dsh/storages/jiyi, load a model, or start a Host/server.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(validateSettings({ enabled, extraction: { provider: null, model: null }, embedding: { backend: configured ? 'local' : null } })), { mode: 0o600 });
    if (seed) {
      const store = new MemoryStore(join(dir, 'memory.sqlite'));
      try {
        store.putMemory({ id: 'isolated-tool-memory', scope: 'global', kind: 'preference', content: '测试来源偏好中文', sources: [{ sessionId: 'isolated-tool-source', eventSeq: 1, eventId: '1', eventTime: '2026-10-24T01:00:00Z', quote: '测试来源偏好中文', evidence: 'user-explicit' }] });
      } finally { store.close(); }
    }
    const context = new Context();
    const releasePrompt = context.reflect.provide('systemPrompt', { tools: () => () => {} });
    const runtime = new ToolRuntime(context);
    const disposers = [];
    const session = { id: 'isolated-tool-session', header: { cwd: join(dir, 'workspace'), origin: 'user' } };
    const agent = { session };
    let forbiddenCalls = 0;
    const forbidden = () => { forbiddenCalls++; throw new Error('Runtime output regression must not call models or persisted production sessions'); };
    const pluginContext = {
      connection: { fetch: { register: () => () => {} } },
      loader: { import: async name => { assert.equal(name, '@deepseek-ai/dsh-llm'); return llm; } },
      llm: { prepareCall: forbidden }, agents: { get: () => undefined }, sessions: { get: id => id === session.id ? session : undefined },
      sessionPersistence: { open: forbidden },
      tools: { register(definition) { disposers.push(runtime.register(definition)); } },
      on: () => () => {}, effect(factory) { disposers.push(factory()); },
    };
    try { await apply(pluginContext, { dataDir: dir }); }
    catch (error) { await cleanup(); throw error; }
    async function cleanup() {
      try { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose(); }
      finally {
        releasePrompt();
        // Verify the absolute generated target before removing this test's files.
        assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
        assert.match(basename(dir), /^jiyi-tool-runtime-/);
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return {
      runtime, cleanup,
      assertNoModelCalls() { assert.equal(forbiddenCalls, 0); },
      execute() { return runtime.execute({ name: 'jiyi_search', callId: 'isolated-runtime-call', agent, arguments: { query: '中文偏好', scope: 'global' }, signal: new AbortController().signal }); },
    };
  }

  function consume(result, expectedStatus) {
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.status, expectedStatus);
    // These are the installed SDK consumers, NOT reimplementations of their
    // array logic. The original plugin's string render reproduces precisely
    // `content.some is not a function` here, after a real ToolRuntime.execute().
    assert.equal(llm.contentHasImage(result.content), false);
    assert.equal(llm.contentHasFile(result.content), false);
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(result.content[0].text), result.value);
    assert.ok(Object.isFrozen(result.value));
    assert.ok(Object.isFrozen(result.content));
  }

  test('real ToolRuntime executes disabled search and LLM consumers accept rendered blocks', async () => {
    const f = await fixture();
    try { consume(await f.execute(), 'disabled'); f.assertNoModelCalls(); }
    finally { await f.cleanup(); }
  });

  test('real ToolRuntime executes an empty search without inventing hits or calling a model', async () => {
    const f = await fixture({ enabled: true, configured: true });
    try {
      const result = await f.execute(); consume(result, 'no-hit');
      assert.deepEqual(result.value.memories, []); f.assertNoModelCalls();
    } finally { await f.cleanup(); }
  });

  test('real ToolRuntime preserves explicit not-configured errors in both value and content', async () => {
    const f = await fixture({ enabled: true, seed: true });
    try {
      const result = await f.execute(); consume(result, 'not-configured');
      assert.match(result.value.error, /Embedding 未配置/);
      assert.deepEqual(result.value.memories, []); f.assertNoModelCalls();
    } finally { await f.cleanup(); }
  });
}
