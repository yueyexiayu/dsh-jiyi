import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, retryDelayMs, providerCooldownMs } from '../lib/retry.js';

test('provider failures are classified and retried with minute-scale bounded backoff',()=>{
  const timeout=classifyFailure(Object.assign(new Error('文本模型调用超时'),{code:'EXTRACTION_TIMEOUT'}),{stage:'memory-review'});
  const busy=classifyFailure(new Error('Service is too busy; request_id: req-42'),{stage:'relevance-llm'});
  const server=classifyFailure(Object.assign(new Error('Internal Server Error'),{code:'SERVER'}),{stage:'memory-review'});
  assert.equal(timeout.category,'provider_timeout');assert.equal(timeout.retryable,true);
  assert.equal(busy.category,'provider_busy');assert.equal(busy.requestId,'req-42');
  assert.equal(server.category,'provider_server');
  assert.equal(retryDelayMs(timeout,1,{random:()=>0}),30000);
  assert.equal(retryDelayMs(server,2,{random:()=>0}),60000);
  assert.equal(providerCooldownMs(timeout,1),30000);
  assert.equal(providerCooldownMs(server,3),120000);
});

test('configuration failures do not trigger provider cooldown while invalid model output retries without blocking the provider',()=>{
  const config=classifyFailure(Object.assign(new Error('invalid input'),{code:'RELEVANCE_INPUT'}));
  const output=classifyFailure(Object.assign(new Error('bad json'),{code:'EXTRACTION_JSON'}));
  const cooldown=classifyFailure(Object.assign(new Error('cooling down'),{code:'RELEVANCE_COOLDOWN'}));
  assert.equal(config.retryable,false);assert.equal(providerCooldownMs(config,1),0);
  assert.equal(output.category,'model_output');assert.equal(output.retryable,true);
  assert.equal(retryDelayMs(output,1,{random:()=>0}),5000);
  assert.equal(providerCooldownMs(output,1),0);
  assert.equal(cooldown.category,'cooldown');assert.equal(cooldown.retryable,false);assert.equal(providerCooldownMs(cooldown,3),0);
});
