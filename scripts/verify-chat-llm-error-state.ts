import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { reducer, initialState, type Action } from "../src/contexts/chat-reducer";
import type { Conversation } from "../src/types/coze";

// Execute the production consumer's actual branches, without mounting React,
// connecting a provider, or copying the transition logic into this test.
const source = readFileSync("src/contexts/app-context.tsx", "utf8");
const ast = ts.createSourceFile("app-context.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findIf(condition: string): ts.IfStatement {
  let found: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (!found && ts.isIfStatement(node) && node.expression.getText(ast) === condition) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `production branch exists: ${condition}`);
  return found;
}
const sseError = findIf("data.error");
const incomplete = findIf("expectsSseCompletion && !receivedDoneSignal");
const caught = findIf("isUserAborted");
const silentConsole = { log() {}, warn() {}, error() {} };
function execute(node: ts.IfStatement, values: Record<string, unknown> = {}) {
  const actions: Action[] = [];
  const context = {
    data: { error: "timeout", code: "LLM_UPSTREAM_TIMEOUT" },
    customerStreamError: () => "本次回复等待超时",
    convId: "fixture-conv", assistantMsgId: "fixture-assistant", userMsgId: "fixture-user",
    fullContent: "", reasoningContent: "", finalContent: "（无回复内容）", sseChunkCount: 0,
    receivedDoneSignal: false, expectsSseCompletion: true, sseStreamEndReason: "not_started",
    streamStartTime: Date.now(), streamErrored: false,
    isUserAborted: false, continueAfterDisconnect: true, isWatchdogAborted: false, isSignalAborted: false, isAbortError: false,
    responseErrorMessage: null, error: new Error("fixture disconnect"),
    classifyError: () => ({ userMessage: "网络错误" }), console: silentConsole,
    ...values, dispatch: (action: Action) => actions.push(action),
  };
  const js = ts.transpileModule(`do { ${node.getText(ast)} } while (false);`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, context);
  return { actions, context };
}
function apply(actions: Action[]) {
  const conv: Conversation = { id: "fixture-conv", messages: [
    { id: "fixture-user", role: "user", content: "用户原文", timestamp: 1 },
    { id: "fixture-assistant", role: "assistant", content: "", timestamp: 2, isStreaming: true },
  ] } as Conversation;
  return actions.reduce(reducer, { ...initialState, conversations: [conv] }).conversations[0].messages;
}
const checks: string[] = [];
function test(name: string, run: () => void) { run(); checks.push(name); }
test("SSE error without output marks current assistant and keeps user intact", () => {
  const { actions, context } = execute(sseError);
  const messages = apply(actions);
  assert.equal(messages[0].content, "用户原文");
  assert.equal(messages[0].error, undefined);
  assert.equal(messages[1].error, "本次回复等待超时");
  assert.equal(context.streamErrored, true);
  assert.match(context.fullContent, /⚠/u);
});
test("partial output plus SSE unknown preserves text and unknown metadata through final paint", () => {
  const failure = "最终结果暂未确认。避免重复发送。";
  const { actions, context } = execute(sseError, { fullContent: "已有回复", customerStreamError: () => failure });
  actions.push({ type: "UPDATE_MESSAGE", payload: { conversationId: "fixture-conv", messageId: "fixture-assistant", content: context.fullContent } });
  const assistant = apply(actions)[1];
  assert.equal(assistant.error, failure);
  assert.match(assistant.content, /^已有回复/u);
});
test("successful SSE completion and non-stream JSON do not get failure metadata", () => {
  assert.equal(execute(incomplete, { receivedDoneSignal: true }).actions.length, 0);
  assert.equal(execute(incomplete, { expectsSseCompletion: false }).actions.length, 0);
  assert.equal(execute(sseError, { data: { choices: [{ delta: { content: "⚠ 是普通正文" } }] } }).actions.length, 0);
});
test("EOF missing completion marks unknown even with zero content chunks", () => {
  const { actions } = execute(incomplete);
  assert.match(apply(actions)[1].error || "", /最终结果暂未确认/u);
});
test("partial EOF records unknown and retains received content", () => {
  const { actions, context } = execute(incomplete, { sseChunkCount: 4, fullContent: "部分正文", finalContent: "部分正文" });
  assert.match(context.finalContent, /^部分正文/u);
  assert.match(apply(actions)[1].error || "", /避免重复发送/u);
});
test("user cancellation retains prior stop semantics without marking assistant failure", () => {
  const { actions } = execute(caught, { isUserAborted: true, fullContent: "部分正文" });
  assert.equal(actions.some(a => a.type === "MARK_MESSAGE_ERROR"), false);
  assert.match(apply(actions)[1].content, /^部分正文/u);
});
test("automatic cancellation marks assistant unknown and retains output", () => {
  const { actions } = execute(caught, { isSignalAborted: true, fullContent: "部分正文" });
  const assistant = apply(actions)[1];
  assert.match(assistant.error || "", /最终结果暂未确认/u);
  assert.match(assistant.content, /^部分正文/u);
});
test("exception after partial content marks assistant failure without dropping content", () => {
  const { actions } = execute(caught, { fullContent: "部分正文" });
  const assistant = apply(actions)[1];
  assert.equal(assistant.error, "本次回复等待超时");
  assert.match(assistant.content, /^部分正文/u);
});
test("empty exception preserves existing user error and removes only assistant placeholder", () => {
  const messages = apply(execute(caught).actions);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].error, "网络错误");
});
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
