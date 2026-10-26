import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraction, EXTRACTION_SYSTEM } from '../lib/extract.js';

// Synthetic relayed-blocker example, not a private conversation transcript.
const original='卡点：浏览器入口显示 authentication required。请解决这个问题';
const source=(quote,eventSeq=898)=>({sessionId:'synthetic-user',eventSeq,eventTime:'2026-01-01T00:00:00Z',quote});
const payload=(quote=original)=>({projectId:'current-project',projectNames:['jiyi'],sources:[source(quote)]});
const memory=(quote,overrides={})=>({content:quote,type:'status',scope:'project',factKey:'chrome-auth',sourceSeqs:[898],quotes:[quote],supersedes:[],...overrides});
const parse=(memories,p=payload(),existing=[])=>parseExtraction(JSON.stringify({memories}),p,existing);

test('synthetic blocker relay cannot produce a status memory',()=>{
  assert.deepEqual(parse([memory(original)]),[]);
  assert.deepEqual(parse([memory('浏览器入口显示 authentication required')]),[]);
});

test('short instructions starting with 卡点/报错/blocked/解决一下 are not status evidence',()=>{
  for(const text of [
    original,
    '卡点：评测抛出 EVAL_BUSY。解决这个问题',
    '报错：dsh web authentication required，请处理',
    'blocked: Chrome entry needs authentication',
    'Blocked: host returned EVAL_BUSY',
    '解决一下 Chrome 入口认证',
    '解决这个问题',
    '请解决这个问题',
  ])assert.deepEqual(parse([memory(text)],payload(text)),[],text);
});

test('user-owned long-term status and decisions remain extractable',()=>{
  const status='Chrome 入口认证已经完成，可以继续。';
  assert.equal(parse([memory(status,{factKey:'chrome-ready'})],payload(status))[0].type,'status');
  assert.equal(parse([memory('银杏B已上线',{factKey:'yinxing-live'})],payload('银杏B已上线'))[0].type,'status');
  const decision=parse([memory('改用方案 B',{type:'decision',factKey:'plan-b'})],payload('改用方案 B'));
  assert.equal(decision[0].type,'decision');
});

test('extraction system names relayed blockers without dropping genuine status examples',()=>{
  assert.match(EXTRACTION_SYSTEM,/转述 agent 报告的卡点/);
  assert.match(EXTRACTION_SYSTEM,/解决这个问题\/解决一下/);
  assert.match(EXTRACTION_SYSTEM,/XX 已上线/);
  assert.match(EXTRACTION_SYSTEM,/改用方案 B/);
});
