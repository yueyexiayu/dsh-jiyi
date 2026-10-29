import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_VERSION = 'transformers-3.8.1:minilm-l12-v2:q8:66fc00f5f29a:mean:384';
const MODEL_ASSETS = {
  'config.json': '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7',
  'tokenizer_config.json': '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2',
  'tokenizer.json': 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441',
  'onnx/model_quantized.onnx': '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc',
};
async function verifyModelAssets(pluginDir, model) {
  for (const [file, expected] of Object.entries(MODEL_ASSETS)) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(resolve(pluginDir, 'models', model, file))) hash.update(bytes);
    if (hash.digest('hex') !== expected) throw new ModelError('MODEL_INTEGRITY', `Installed model asset checksum mismatch: ${file}`);
  }
}
export const EMBEDDING_DIMENSIONS = 384;

export class ModelError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'ModelError'; this.code = code; }
}

// Request-local metadata only. Observers cannot change model execution.
export function createLatencyTrace(component, onDiagnostic) {
  const started = performance.now(), events = [];
  let active = null, settled = false;
  const emit = (stage, status, since, extra = {}) => {
    const now = performance.now();
    const snapshot = { component, stage, status, elapsedMs: now - started, durationMs: now - since, ...structuredClone(extra) };
    events.push(snapshot);
    try {
      const observed = onDiagnostic?.(structuredClone(snapshot));
      if (observed?.then) Promise.resolve(observed).catch(() => {});
    } catch { /* Diagnostic observers are not execution controls. */ }
  };
  const close = (status, extra) => { if (active) { emit(active.stage, status, active.started, extra); active = null; } };
  const end = (error, counters) => {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : error ? 'UNKNOWN' : undefined;
    const cancelled = !!code && (code === 'ABORTED' || code.endsWith('_DISPOSED'));
    const timedOut = !!code && code.includes('TIMEOUT');
    close(error ? timedOut ? 'timeout' : cancelled ? 'cancelled' : 'error' : 'success', { ...(code ? { errorCode: code } : {}), ...(cancelled ? { cancelled: true } : {}), ...(timedOut ? { timedOut: true } : {}), ...(counters ? { counters } : {}) });
  };
  return {
    end(error, counters) { if (!settled) end(error, counters); },
    begin(stage, counters, metadata) {
      if (settled) return;
      close('success'); active = { stage, started: performance.now() };
      emit(stage, 'running', active.started, { ...(counters ? { counters } : {}), ...(metadata ? { metadata } : {}) });
    },
    finish(error, counters) {
      if (settled) return;
      settled = true;
      end(error, counters);
    },
    snapshot() { return { component, elapsedMs: performance.now() - started, usage: structuredClone(events.at(-1)?.counters?.usage ?? 'unknown'), events: structuredClone(events) }; },
  };
}

export function validateEmbeddingConfig(config = {}) {
  const value = { backend: 'local', model: EMBEDDING_MODEL, loadTimeoutMs: 120000, timeoutMs: 10000, ...config };
  if (value.backend !== null && value.backend !== 'local') throw new ModelError('INVALID_EMBEDDING_CONFIG', 'Only the installed local embedding backend is supported; chat credentials are not embedding credentials.');
  if (value.backend !== null && value.model !== EMBEDDING_MODEL) throw new ModelError('INVALID_EMBEDDING_CONFIG', `Local embedding model is not installed: ${value.model}`);
  for (const key of ['loadTimeoutMs', 'timeoutMs']) {
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 300000) throw new ModelError('INVALID_EMBEDDING_CONFIG', `${key} must be an integer from 1 to 300000.`);
  }
  return value;
}

export function validateVectors(vectors, count, dimensions = EMBEDDING_DIMENSIONS) {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new ModelError('INVALID_EMBEDDING', 'Embedding output count does not match input.');
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(x => !Number.isFinite(x)) || !vector.some(x => x !== 0)) throw new ModelError('INVALID_EMBEDDING', `Embedding must be a finite nonzero ${dimensions}-dimensional vector.`);
  }
  return vectors;
}

// Each process runs at most one request at a time. Idle processes retain their
// model; failed or cancelled requests own and terminate only their process.
export function createModels({ config = {}, pluginDir = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  const settings = validateEmbeddingConfig(config);
  const workers = new Set();
  let disposed = false, lastError = null, lastSuccessAt = null;
  const getStatus = () => ({ backend: settings.backend, model: settings.model, version: EMBEDDING_VERSION, dimensions: EMBEDDING_DIMENSIONS, isolation: 'child-process', status: settings.backend === null ? 'not-configured' : lastError ? 'error' : lastSuccessAt ? 'ready' : 'not-verified', ready: settings.backend !== null && lastSuccessAt !== null && lastError === null, activeRequests: [...workers].filter(w => w.request).length, activeProcesses: [...workers].map(w => ({ pid: w.child.pid ?? null, phase: w.phase })), lastSuccessAt, lastError, error: lastError });
  function createWorker() {
    let child;
    try {
      child = fork(fileURLToPath(import.meta.url), ['--jiyi-embedding-child'], {
        execPath: process.execPath, execArgv: [], cwd: dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch (cause) {
      const error = new ModelError('EMBEDDING_PROCESS_START', `Cannot start isolated embedding process: ${cause.message}`, { cause });
      lastError = { code: error.code, message: error.message, phase: 'load', at: new Date().toISOString() };
      throw error;
    }
    let resolveClosed;
    const worker = { child, phase: 'load', request: null, stopping: false, closed: new Promise(resolve => { resolveClosed = resolve; }) };
    workers.add(worker);
    worker.stop = error => {
      if (worker.stopping) return;
      worker.stopping = true;
      if (worker.request) {
        worker.request.failure = error;
        worker.request.trace.end(error, worker.request.counters);
        worker.request.cleanupStarted = performance.now();
        worker.request.trace.begin('cleanup', { cleanupClosed: 0 });
        clearTimeout(worker.request.timer);
      }
      child.kill('SIGTERM');
      worker.killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    };
    child.on('message', message => {
      const request = worker.request;
      if (worker.stopping) return;
      if (!request) { worker.stop(new ModelError('EMBEDDING_PROTOCOL', 'Isolated embedding process returned an unexpected message.')); return; }
      for (const key of ['assetVerifyMs', 'runtimeImportMs', 'pipelineLoadMs', 'inferenceMs', 'disposeMs']) {
        const value = message?.timings?.[key];
        if (Number.isFinite(value) && value >= 0) request.counters[key] = value;
      }
      if (message?.type === 'ready' && worker.phase === 'load') {
        worker.phase = 'inference'; request.arm(request.timeouts.timeoutMs);
        request.trace.begin('inference', request.counters);
      } else if (message?.type === 'error') {
        worker.stop(new ModelError('EMBEDDING_FAILED', message.message));
      } else if (message?.type === 'result' && worker.phase === 'inference') {
        try {
          const vectors = validateVectors(message.vectors, request.count);
          clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.abort);
          worker.phase = 'idle'; worker.request = null;
          lastSuccessAt = new Date().toISOString(); lastError = null;
          request.trace.finish(null, request.counters);
          request.resolve({ vectors, model: settings.model, version: EMBEDDING_VERSION, execution: { isolation: 'child-process', pid: child.pid, exitCode: null, signal: null, latency: request.trace.snapshot() } });
        } catch (error) { worker.stop(error); }
      } else worker.stop(new ModelError('EMBEDDING_PROTOCOL', 'Isolated embedding process returned an unexpected message.'));
    });
    child.on('error', cause => worker.stop(new ModelError('EMBEDDING_PROCESS_START', `Isolated embedding process failed: ${cause.message}`, { cause })));
    child.once('close', (code, signal) => {
      clearTimeout(worker.killTimer); workers.delete(worker);
      worker.stopping = true;
      const request = worker.request;
      worker.request = null;
      if (request) {
        clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.abort);
        const failure = request.failure ?? new ModelError(signal ? 'EMBEDDING_PROCESS_CRASH' : 'EMBEDDING_PROCESS_EXIT', `Isolated embedding process exited without a complete successful result (code ${code}, signal ${signal ?? 'none'}).`);
        request.counters.cleanupClosed = 1;
        if (request.cleanupStarted !== undefined) request.counters.cleanupWaitMs = performance.now() - request.cleanupStarted;
        lastError = { code: failure.code ?? 'EMBEDDING_FAILED', message: failure.message, phase: worker.phase, exitCode: code, signal, at: new Date().toISOString() };
        request.reject(failure);
      }
      resolveClosed();
    });
    return worker;
  }
  async function embed(texts, options = {}) {
    const trace = createLatencyTrace('embedding', options.onDiagnostic), counters = { queueWaitMs: 0 };
    trace.begin('input');
    try {
      if (disposed) throw new ModelError('MODEL_DISPOSED', 'Embedding service is disposed.');
      if (settings.backend === null) throw new ModelError('EMBEDDING_NOT_CONFIGURED', 'Embedding backend is not configured; select and verify the installed local model first.');
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 64 || texts.some(t => typeof t !== 'string' || !t.trim() || t.length > 16000)) throw new ModelError('INVALID_EMBEDDING_INPUT', 'Embedding requires 1–64 nonempty strings, each at most 16000 characters.');
      if (options.signal?.aborted) throw new ModelError('ABORTED', 'Embedding request was aborted.');
      const timeouts = validateEmbeddingConfig({ ...settings, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.loadTimeoutMs === undefined ? {} : { loadTimeoutMs: options.loadTimeoutMs }) });
      let worker = [...workers].find(w => w.phase === 'idle' && !w.stopping);
      if (!worker && workers.size >= 2) throw new ModelError('EMBEDDING_BUSY', 'Two local embedding processes are already running; retry after they exit.');
      counters.textCount = texts.length; counters.inputBytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
      const reused = !!worker;
      if (!worker) worker = createWorker();
      return await new Promise((resolveResult, reject) => {
        const request = { resolve: resolveResult, reject, trace, counters, timeouts, count: texts.length, signal: options.signal };
        worker.request = request;
        if (reused) worker.phase = 'inference';
        request.abort = () => worker.stop(new ModelError('ABORTED', 'Embedding request was aborted.'));
        request.arm = ms => {
          clearTimeout(request.timer);
          request.timer = setTimeout(() => worker.stop(new ModelError(worker.phase === 'load' ? 'EMBEDDING_LOAD_TIMEOUT' : 'EMBEDDING_TIMEOUT', `Local embedding ${worker.phase} exceeded ${ms}ms.`)), ms);
        };
        options.signal?.addEventListener('abort', request.abort, { once: true });
        request.arm(reused ? timeouts.timeoutMs : timeouts.loadTimeoutMs);
        trace.begin(reused ? 'inference' : 'load', counters);
        if (!worker.stopping) childSend(worker, request, { type: 'embed', pluginDir: resolve(pluginDir), model: settings.model, texts });
      });
    } catch (error) {
      trace.finish(error, counters);
      try { error.diagnostics = { ...error.diagnostics, embedding: trace.snapshot() }; } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
  function childSend(worker, request, message) {
    try {
      worker.child.send(message, error => { if (error && worker.request === request) worker.stop(new ModelError('EMBEDDING_PROCESS_START', `Cannot deliver isolated embedding request: ${error.message}`, { cause: error })); });
    } catch (cause) { worker.stop(new ModelError('EMBEDDING_PROCESS_START', `Cannot deliver isolated embedding request: ${cause.message}`, { cause })); }
  }
  return {
    embed, getStatus,
    async validate(options) { const result = await embed(['本地语义模型可用性检查'], options); return { ok: true, ...getStatus(), execution: result.execution }; },
    async dispose() {
      disposed = true;
      const active = [...workers];
      for (const worker of active) worker.stop(new ModelError('MODEL_DISPOSED', 'Embedding service was disposed during a request.'));
      await Promise.all(active.map(worker => worker.closed));
    },
  };
}

// Only the forked entry point handles IPC and loads ONNX. Ordinary imports never do.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--jiyi-embedding-child' && typeof process.send === 'function') {
  let model, busy = false;
  process.once('disconnect', () => process.exit(1));
  const send = message => new Promise((resolveSent, reject) => {
    if (!process.connected) { reject(new Error('Embedding parent disconnected.')); return; }
    process.send(message, error => error ? reject(error) : resolveSent());
  });
  process.on('message', async request => {
    if (busy) { process.exitCode = 1; process.disconnect(); return; }
    busy = true;
    const timings = {};
    let timingKey, timingStarted;
    const phase = key => {
      if (timingKey) timings[timingKey] = performance.now() - timingStarted;
      timingKey = key; timingStarted = performance.now();
    };
    try {
      if (request?.type !== 'embed' || request.model !== EMBEDDING_MODEL) throw new Error('Invalid isolated embedding request.');
      if (!model) {
        phase('assetVerifyMs'); await verifyModelAssets(request.pluginDir, request.model);
        phase('runtimeImportMs');
        const runtime = pathToFileURL(resolve(request.pluginDir, 'deps/node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href;
        const { env, pipeline } = await import(runtime);
        env.allowRemoteModels = false; env.localModelPath = resolve(request.pluginDir, 'models') + '/'; env.cacheDir = resolve(request.pluginDir, 'models');
        phase('pipelineLoadMs');
        model = await pipeline('feature-extraction', request.model, { dtype: 'q8', device: 'cpu', local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
        phase(null); await send({ type: 'ready', timings });
      }
      phase('inferenceMs');
      const output = await model(request.texts, { pooling: 'mean', normalize: true, truncation: true });
      const vectors = validateVectors(output.tolist(), request.texts.length);
      phase(null);
      // Ready to accept the next request before the result reaches the parent.
      busy = false;
      await send({ type: 'result', vectors, timings });
    } catch (error) {
      process.exitCode = 1;
      try { await send({ type: 'error', message: `Local embedding failed: ${error.message}` }); } catch { /* Parent has exited. */ }
      if (process.connected) process.disconnect();
    }
  });
}
