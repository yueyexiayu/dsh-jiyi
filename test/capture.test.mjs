import test from "node:test";
import assert from "node:assert/strict";
import {
  collectTurnNotes,
  extractObservations,
  isTaskRequest,
  observationsFromTurn,
  shouldSkipLlmExtract,
  shouldSkipTurn,
  userTextsForTurn,
} from "../lib/capture.js";

test("extracts explicit remember phrases", () => {
  const a = extractObservations("记住：用 just test，不要 cargo test");
  assert.equal(a.length, 1);
  assert.match(a[0].statement, /just test/);
  assert.equal(a[0].topicHint, "testing");
  const b = extractObservations("remember to always open PR links after pushing");
  assert.equal(b[0].topicHint, "git");
});

test("skips secrets and tiny turns", () => {
  assert.equal(shouldSkipTurn("hi"), true);
  assert.equal(shouldSkipTurn("export OPENAI_API_KEY=sk-abcdefghijk"), true);
  assert.equal(extractObservations("password = hunter2 please remember").length, 0);
});

test("captures conventions without saying 记住", () => {
  const notes = extractObservations("用 just test，不要 cargo test");
  assert.equal(notes.length, 1);
  assert.match(notes[0].statement, /just test/);
  assert.equal(notes[0].topicHint, "testing");
  assert.equal(extractObservations("帮我修登录 bug").length, 0);
  assert.equal(extractObservations("这个函数怎么工作？").length, 0);
  assert.equal(extractObservations("你好").length, 0);
});

test("turn capture uses the user message, not plugin injects", () => {
  const events = [
    { type: "user/message", data: { turn: 3, message: { content: [{ type: "text", text: "用 just test，不要 cargo test" }] } } },
    { type: "assistant/message", data: { turn: 3, message: { content: [{ type: "text", text: "好，之后走 just test。" }] } } },
  ];
  const notes = observationsFromTurn(events, 3);
  assert.equal(notes.length, 1);
  assert.match(notes[0].statement, /just test/);
});

test("reads DSH user/message payload without nested message.turn", () => {
  const events = [
    { type: "turn/start", data: { turn: 4 } },
    {
      type: "user/message",
      data: {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "用 just test，不要 cargo test" }],
      },
    },
    {
      type: "assistant/message",
      data: { turn: 4, message: { content: [{ type: "text", text: "之后走 just test。" }] } },
    },
  ];
  assert.deepEqual(userTextsForTurn(events, 4), ["用 just test，不要 cargo test"]);
  const notes = observationsFromTurn(events, 4);
  assert.equal(notes.length, 1);
  assert.match(notes[0].statement, /just test/);
});

test("实测 and similar tasks skip LLM extract", () => {
  assert.equal(isTaskRequest("帮我实测 jiyi 插件是否存在漏洞"), true);
  assert.equal(shouldSkipLlmExtract("帮我实测 jiyi 插件是否存在漏洞"), true);
  assert.equal(shouldSkipTurn("帮我实测 jiyi 插件是否存在漏洞"), false);
  assert.equal(shouldSkipLlmExtract("用 just test，不要 cargo test"), false);
  assert.equal(shouldSkipLlmExtract("帮我实测 jiyi 插件，不要改源码"), true);
  assert.equal(shouldSkipLlmExtract("Please test the plugin"), true);
  assert.equal(isTaskRequest("测试用 just test，不要 cargo test"), false);
  assert.equal(shouldSkipLlmExtract("测试用 just test，不要 cargo test"), false);
  assert.equal(extractObservations("测试用 just test，不要 cargo test").length, 1);
  assert.equal(isTaskRequest("Run tests with just test, never cargo test"), false);
  assert.equal(extractObservations("Run tests with just test, never cargo test").length, 1);
});

test("collectTurnNotes uses local extract for tasks and keeps LLM noop", async () => {
  const taskEvents = [
    { type: "user/message", data: { turn: 1, message: { content: [{ type: "text", text: "帮我实测 jiyi 插件是否存在漏洞" }] } } },
  ];
  let llmCalls = 0;
  const skipped = await collectTurnNotes(taskEvents, 1, async () => {
    llmCalls += 1;
    return [{ statement: "should not save test chatter" }];
  });
  assert.equal(llmCalls, 0);
  assert.equal(skipped.length, 0);

  const rememberTask = [
    { type: "user/message", data: { turn: 2, message: { content: [{ type: "text", text: "帮我实测 jiyi 插件。记住：侧栏入口叫记忆" }] } } },
  ];
  const local = await collectTurnNotes(rememberTask, 2, async () => {
    llmCalls += 1;
    return [];
  });
  assert.equal(llmCalls, 0);
  assert.equal(local.length, 1);
  assert.match(local[0].statement, /侧栏入口叫记忆/);

  const durable = [
    { type: "user/message", data: { turn: 3, message: { content: [{ type: "text", text: "用 just test，不要 cargo test" }] } } },
  ];
  const fromLlm = await collectTurnNotes(durable, 3, async () => [{ statement: "Use just test", topicHint: "testing" }]);
  assert.equal(fromLlm[0].statement, "Use just test");
  const noop = await collectTurnNotes(durable, 3, async () => []);
  assert.deepEqual(noop, []);

  const englishTask = [
    { type: "user/message", data: { turn: 4, message: { content: [{ type: "text", text: "Please test the plugin" }] } } },
  ];
  const skippedEn = await collectTurnNotes(englishTask, 4, async () => {
    llmCalls += 1;
    return [{ statement: "should not save" }];
  });
  assert.equal(skippedEn.length, 0);
  assert.equal(llmCalls, 0);
});

test("ignores plugin and instruction user messages", () => {
  const events = [
    { type: "user/message", data: { turn: 1, source: { kind: "plugin", plugin: "jiyi" }, message: { content: [{ type: "text", text: "记住：secret index" }] } } },
    { type: "user/message", data: { turn: 1, source: { kind: "agent-instructions" }, message: { content: [{ type: "text", text: "记住：from agents" }] } } },
    { type: "user/message", data: { turn: 1, message: { content: [{ type: "text", text: "记住：真实约定" }] } } },
  ];
  assert.deepEqual(userTextsForTurn(events, 1), ["记住：真实约定"]);
  const notes = observationsFromTurn(events, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].statement, "真实约定");
});
