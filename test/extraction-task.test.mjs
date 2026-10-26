import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExtraction, EXTRACTION_SYSTEM } from '../lib/extract.js';

// Synthetic task specification: no original conversation or private provenance.
const original=readFileSync(new URL('./fixtures/task-synthetic.txt',import.meta.url),'utf8');
const source=(quote,eventSeq=8)=>({sessionId:'synthetic-user',eventSeq,eventTime:'2026-01-01T00:00:00Z',quote});
const payload=(quote=original)=>({projectId:'current-project',projectNames:['jiyi'],sources:[source(quote)]});
const memory=(quote,overrides={})=>({content:quote,type:'status',scope:'project',factKey:'state',sourceSeqs:[8],quotes:[quote],supersedes:[],...overrides});
const parse=(memories,p=payload(),existing=[])=>parseExtraction(JSON.stringify({memories}),p,existing);
const problemQuotes=[
  '评测运行时，agent/pre-step 抛出 EVAL_BUSY，使正常会话无法继续，同时正式召回和管理操作不可用。',
  'kind=status 的记忆（例如“第7页失败、示例状态待核实”）在问题解决后仍原样注入。',
  '查询里写了“演示 A”或“演示A”，未扩展到对应项目，因为 project_aliases 表里没有登记。',
];

test('synthetic task specification cannot produce incidental status memories',()=>{
  const output=parse(problemQuotes.map((q,i)=>memory(q,{factKey:`problem-${i}`})));
  assert.deepEqual(output,[]);
});

test('task classification uses full source, not the short status quote returned by the model',()=>{
  assert.deepEqual(parse([memory('project_aliases 表里没有登记')]),[]);
});

test('explicit preference and rule in a task remain extractable while incidental status is discarded',()=>{
  const preference='我的长期偏好是代码评审报告使用中文。';
  const rule='不改相关性提示词，不换模型。';
  const output=parse([
    memory(problemQuotes[0]),
    memory(preference,{type:'preference',scope:'global',factKey:'review-language'}),
    memory(rule,{type:'decision',factKey:'model-policy'}),
  ],payload(original+'\n'+preference));
  assert.deepEqual(output.map(m=>m.type),['preference','decision']);
  assert.equal(output[0].scope,'global');assert.equal(output[1].projectId,'current-project');
});

test('requirements without an explicit task prefix also do not become status facts',()=>{
  for(const text of [
    '请帮我修复下面的问题。\n【问题】\n现状：第22页失败。\n目标：让页面通过。',
    '需求说明：排查第22页。\n现状：第22页失败。\n目标：定位原因。',
    '请修复第22页。\n现状：第22页失败。\n目标：验证通过。',
    '【实现要求】\n现状：第22页失败。\n目标：验证通过。\n【约束】\n不改模型。',
  ])assert.deepEqual(parse([memory('第22页失败')],payload(text)),[],text);
});

test('a genuine short status update and a long headed user account remain status evidence',()=>{
  for(const text of [
    '第22页的问题已经解决，我刚才重新验证通过了。',
    '现状：第22页的问题已经解决，我刚才重新验证通过了。',
    '【复查记录】\n'+('我逐项检查了现场记录，确认此前的问题没有再次出现。'.repeat(15))+'第22页的问题已经解决，我刚才重新验证通过了。',
  ]){
    const output=parse([memory('第22页的问题已经解决，我刚才重新验证通过了。')],payload(text));
    assert.equal(output.length,1);assert.equal(output[0].type,'status');
  }
});

test('an independent genuine status source in the same batch survives without task provenance',()=>{
  const update='第22页的问题已经解决，我刚才重新验证通过了。';
  const p={...payload(),sources:[source(original),source(update,9)]};
  const old={id:'old-state',scope:'project',projectId:'current-project',kind:'status',factKey:'page22'};
  const output=parse([memory(update,{sourceSeqs:[8,9],quotes:[problemQuotes[1],update],factKey:'page22'})],p,[old]);
  assert.equal(output.length,1);assert.deepEqual(output[0].sources.map(s=>s.eventSeq),[9]);
  assert.equal(output[0].factKey,'page22');assert.deepEqual(output[0].supersedes,['old-state']);
});

test('a separate short message declaring intent to execute requirements is not status evidence',()=>{
  const text='任务：请修复第22页失败的问题。';
  assert.deepEqual(parse([memory('第22页失败')],payload(text)),[]);
});

test('task filtering never hides malformed model output or fabricated quotes',()=>{
  assert.throws(()=>parse([memory('这是用户没有说过的话')]),{code:'EXTRACTION_EVIDENCE'});
  assert.throws(()=>parse([memory(problemQuotes[0],{supersedes:['another-project']})]),{code:'EXTRACTION_SCOPE'});
  assert.throws(()=>parse([memory(problemQuotes[0],{factKey:''})]),{code:'EXTRACTION_SCHEMA'});
});

test('extraction system explicitly separates task requirements from facts but retains explicit preferences and rules',()=>{
  assert.match(EXTRACTION_SYSTEM,/任务说明或需求描述/);
  assert.match(EXTRACTION_SYSTEM,/不得.*status/);
  assert.match(EXTRACTION_SYSTEM,/明确.*偏好.*规则/);
});
