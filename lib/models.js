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

// ORT's N-API objects must never inhabit a Host worker_threads environment.
// Each request owns a separate OS process; no native model is imported by Host.
// There is no queue: a third simultaneous request gets an explicit BUSY error.
export function createModels({ config = {}, pluginDir = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  const settings = validateEmbeddingConfig(config);
  const requests = new Set();
  let disposed = false;
  let lastError = null;
  let lastSuccessAt = null;
  const getStatus = () => ({ backend: settings.backend, model: settings.model, version: EMBEDDING_VERSION, dimensions: EMBEDDING_DIMENSIONS, isolation: 'child-process', status: settings.backend === null ? 'not-configured' : lastError ? 'error' : lastSuccessAt ? 'ready' : 'not-verified', ready: settings.backend !== null && lastSuccessAt !== null && lastError === null, activeRequests: requests.size, activeProcesses: [...requests].map(request => ({ pid: request.child.pid ?? null, phase: request.phase })), lastSuccessAt, lastError, error: lastError });
  async function embed(texts, options = {}) {
    const trace = createLatencyTrace('embedding', options.onDiagnostic);
    const counters = { queueWaitMs: 0 }; // This adapter rejects overload; it has no queue.
    trace.begin('input');
    try {
    if (disposed) throw new ModelError('MODEL_DISPOSED', 'Embedding service is disposed.');
    if (settings.backend === null) throw new ModelError('EMBEDDING_NOT_CONFIGURED', 'Embedding backend is not configured; select and verify the installed local model first.');
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 64 || texts.some(t => typeof t !== 'string' || !t.trim() || t.length > 16000)) throw new ModelError('INVALID_EMBEDDING_INPUT', 'Embedding requires 1–64 nonempty strings, each at most 16000 characters.');
    if (options.signal?.aborted) throw new ModelError('ABORTED', 'Embedding request was aborted.');
    if (requests.size >= 2) throw new ModelError('EMBEDDING_BUSY', 'Two local embedding processes are already running; retry after they exit.');
    const timeouts = validateEmbeddingConfig({ ...settings, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.loadTimeoutMs === undefined ? {} : { loadTimeoutMs: options.loadTimeoutMs }) });
    counters.textCount = texts.length;
    counters.inputBytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
    trace.begin('load', counters);
    return await new Promise((resolveResult, reject) => {
      let child;
      try {
        child = fork(fileURLToPath(import.meta.url), ['--jiyi-embedding-child'], {
          execPath: process.execPath, execArgv: [],
          cwd: dirname(fileURLToPath(import.meta.url)),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
      } catch (cause) {
        const error = new ModelError('EMBEDDING_PROCESS_START', `Cannot start isolated embedding process: ${cause.message}`, { cause });
        lastError = { code: error.code, message: error.message, phase: 'load', at: new Date().toISOString() };
        reject(error); return;
      }
      let resolveClosed;
      const request = { child, phase: 'load', closed: new Promise(resolve => { resolveClosed = resolve; }), stop: null };
      requests.add(request);
      let closed = false;
      let result = null;
      let failure = null;
      let timer;
      let killTimer, cleanupStarted;
      const stop = error => {
        if (closed) return;
        if (!failure) {
          trace.end(error, counters);
          cleanupStarted = performance.now();
          trace.begin('cleanup', { cleanupClosed: 0 });
        }
        failure ??= error;
        clearTimeout(timer);
        if (!killTimer) {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 500);
        }
      };
      request.stop = stop;
      const abort = () => stop(new ModelError('ABORTED', 'Embedding request was aborted.'));
      const arm = ms => {
        clearTimeout(timer);
        timer = setTimeout(() => stop(new ModelError(request.phase === 'load' ? 'EMBEDDING_LOAD_TIMEOUT' : 'EMBEDDING_TIMEOUT', `Local embedding ${request.phase} exceeded ${ms}ms.`)), ms);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      child.on('message', message => {
        if (failure || closed) return;
        // Only copy known finite timing counters, never arbitrary child payloads.
        for (const key of ['assetVerifyMs', 'runtimeImportMs', 'pipelineLoadMs', 'inferenceMs', 'disposeMs']) {
          const value = message?.timings?.[key];
          if (Number.isFinite(value) && value >= 0) counters[key] = value;
        }
        if (message?.type === 'ready' && request.phase === 'load') {
          trace.begin('inferenceAndDispose', counters);
          request.phase = 'inference'; arm(timeouts.timeoutMs);
        } else if (message?.type === 'error') {
          stop(new ModelError('EMBEDDING_FAILED', message.message));
        } else if (message?.type === 'result' && request.phase === 'inference' && !result) {
          try {
            result = { vectors: validateVectors(message.vectors, texts.length), model: settings.model, version: EMBEDDING_VERSION };
            request.phase = 'shutdown';
            trace.begin('shutdown', counters);
            // Keep the inference deadline until normal exit, including native disposal.
          } catch (error) { stop(error); }
        } else stop(new ModelError('EMBEDDING_PROTOCOL', 'Isolated embedding process returned an unexpected message.'));
      });
      child.on('error', cause => stop(new ModelError('EMBEDDING_PROCESS_START', `Isolated embedding process failed: ${cause.message}`, { cause })));
      // close also covers spawn failures and waits for process/IPC closure.
      child.once('close', (code, signal) => {
        closed = true;
        counters.cleanupClosed = 1;
        if (cleanupStarted !== undefined) counters.cleanupWaitMs = performance.now() - cleanupStarted;
        clearTimeout(timer); clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
        requests.delete(request);
        if (!failure && (code !== 0 || signal || !result)) failure = new ModelError(signal ? 'EMBEDDING_PROCESS_CRASH' : 'EMBEDDING_PROCESS_EXIT', `Isolated embedding process exited without a complete successful result (code ${code}, signal ${signal ?? 'none'}).`);
        if (failure) {
          lastError = { code: failure.code ?? 'EMBEDDING_FAILED', message: failure.message, phase: request.phase, exitCode: code, signal, at: new Date().toISOString() };
          reject(failure);
        } else {
          lastSuccessAt = new Date().toISOString(); lastError = null;
          trace.finish(null, counters);
          resolveResult({ ...result, execution: { isolation: 'child-process', pid: child.pid, exitCode: code, signal, latency: trace.snapshot() } });
        }
        resolveClosed();
      });
      arm(timeouts.loadTimeoutMs);
      child.send({ type: 'embed', pluginDir: resolve(pluginDir), model: settings.model, texts }, error => {
        if (error) stop(new ModelError('EMBEDDING_PROCESS_START', `Cannot deliver isolated embedding request: ${error.message}`, { cause: error }));
      });
    });
    } catch (error) {
      trace.finish(error, counters);
      try { error.diagnostics = { ...error.diagnostics, embedding: trace.snapshot() }; } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
  return {
    embed, getStatus,
    async validate(options) { const result = await embed(['本地语义模型可用性检查'], options); return { ok: true, ...getStatus(), execution: result.execution }; },
    async dispose() {
      disposed = true;
      const active = [...requests];
      for (const request of active) request.stop(new ModelError('MODEL_DISPOSED', 'Embedding service was disposed during a request.'));
      await Promise.all(active.map(request => request.closed));
    },
  };
}

// Only the forked entry point handles IPC and loads ONNX. Ordinary imports never do.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--jiyi-embedding-child' && typeof process.send === 'function') {
  let closing = false;
  const timings = {};
  let timingKey, timingStarted;
  const phase = key => {
    if (timingKey) timings[timingKey] = performance.now() - timingStarted;
    timingKey = key; timingStarted = performance.now();
  };
  process.once('disconnect', () => { if (!closing) process.exit(1); });
  const send = message => new Promise((resolveSent, reject) => {
    if (!process.connected) { reject(new Error('Embedding parent disconnected.')); return; }
    process.send(message, error => error ? reject(error) : resolveSent());
  });
  try {
    const request = await new Promise(resolveRequest => process.once('message', resolveRequest));
    if (request?.type !== 'embed' || request.model !== EMBEDDING_MODEL) throw new Error('Invalid isolated embedding request.');
    phase('assetVerifyMs');
    await verifyModelAssets(request.pluginDir, request.model);
    phase('runtimeImportMs');
    const runtime = pathToFileURL(resolve(request.pluginDir, 'deps/node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href;
    const { env, pipeline } = await import(runtime);
    env.allowRemoteModels = false;
    env.localModelPath = resolve(request.pluginDir, 'models') + '/';
    env.cacheDir = resolve(request.pluginDir, 'models');
    phase('pipelineLoadMs');
    const model = await pipeline('feature-extraction', request.model, {
      dtype: 'q8', device: 'cpu', local_files_only: true,
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
    phase(null);
    await send({ type: 'ready', timings });
    phase('inferenceMs');
    const output = await model(request.texts, { pooling: 'mean', normalize: true, truncation: true });
    const vectors = validateVectors(output.tolist(), request.texts.length);
    phase('disposeMs');
    await model.dispose();
    phase(null);
    await send({ type: 'result', vectors, timings });
    process.exitCode = 0;
  } catch (error) {
    process.exitCode = 1;
    try { await send({ type: 'error', message: `Local embedding failed: ${error.message}` }); } catch { /* Parent has exited; failure remains exit 1. */ }
  } finally {
    closing = true;
    if (process.connected) process.disconnect();
  }
}
