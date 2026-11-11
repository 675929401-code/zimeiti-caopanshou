import assert from "node:assert/strict";
import test from "node:test";
import { NativeAgentStartSchema, NativeAgentDecisionSchema, NativeAgentToolSchema, nativeAgentCanonical, nativeAgentMainRequestKey } from "../src/lib/native-agent-contract";
import { NativeAgentSseDecoder, readNativeAgentMainFrame } from "../src/lib/native-agent-stream";

const id = "3415676f-d80b-45ba-9b44-390dc66c2f2c";
test("native task turns require stable keys, public model selection and paired continuation CAS", () => {
  const start = { requestKey: "agent-turn-00001", prompt: "生成一份选题计划", modelId: "pm_model_test" };
  assert.equal(NativeAgentStartSchema.parse(start).context.draftIds.length, 0);
  assert.equal(NativeAgentStartSchema.safeParse({ ...start, taskId: id }).success, false);
  assert.equal(NativeAgentStartSchema.safeParse({ ...start, taskId: id, expectedRevision: 1 }).success, true);
  for (const extra of [{ apiKey: "fixture" }, { runtime: "shell" }, { providerUrl: "https://example.invalid" }, { userId: id }]) {
    assert.equal(NativeAgentStartSchema.safeParse({ ...start, ...extra }).success, false);
  }
  assert.equal(nativeAgentMainRequestKey(id, 0), `native-agent:${id}:llm:0`);
  assert.throws(() => nativeAgentMainRequestKey(id, -1));
});
test("tool approval cannot carry a replacement action or a client supplied quote", () => {
  const approve = { proposalId: id, expectedRevision: 2, decision: "approve", requestKey: "action-000001" };
  assert.equal(NativeAgentDecisionSchema.safeParse(approve).success, true);
  assert.equal(NativeAgentDecisionSchema.safeParse({ ...approve, args: { content: "changed" } }).success, false);
  assert.equal(NativeAgentDecisionSchema.safeParse({ ...approve, price: 0 }).success, false);
  assert.equal(NativeAgentToolSchema.safeParse({ kind: "http", args: { url: "https://example.invalid" } }).success, false);
  assert.equal(NativeAgentToolSchema.safeParse({ kind: "read_draft", args: { draftId: id } }).success, true);
  assert.equal(NativeAgentToolSchema.safeParse({ kind: "read_draft", args: { draftId: id, ownerId: id } }).success, false);
});
test("native task canonical input preserves order without locale or undefined coercion", () => {
  assert.equal(nativeAgentCanonical({ a: [3, 1], B: false, _: null }), '{"B":false,"_":null,"a":[3,1]}');
  assert.throws(() => nativeAgentCanonical({ x: undefined }));
  assert.throws(() => nativeAgentCanonical({ amount: Number.NaN }));
});
test("main SSE survives byte fragmentation and requires explicit billing and done frames", () => {
  const text = 'data: {"choices":[{"delta":{"content":"中文🙂"}}]}\r\n\r\ndata: {"billing_complete":true,"operation_id":"receipt-1","credits_charged":0.5}\n\ndata: [DONE]\n\n';
  const decoder = new NativeAgentSseDecoder();
  const frames = [...new TextEncoder().encode(text)].flatMap(byte => decoder.push(Uint8Array.of(byte)));
  frames.push(...decoder.finish());
  assert.equal(frames.map(frame => frame.text).join(""), "中文🙂");
  assert.deepEqual(frames.find(frame => frame.billing)?.billing, { operationId: "receipt-1", creditsCharged: 0.5 });
  assert.equal(frames.filter(frame => frame.done).length, 1);
  assert.equal(readNativeAgentMainFrame('data: {"choices":[{"delta":{"content":"billing_complete:true [DONE]"}}]}').done, false);
});
test("malformed, oversized and truncated streams cannot be mistaken for completion", () => {
  const decoder = new NativeAgentSseDecoder();
  decoder.push(new TextEncoder().encode('data: {"choices":'));
  assert.throws(() => decoder.finish(), /TRUNCATED/u);
  assert.throws(() => new NativeAgentSseDecoder().push(new TextEncoder().encode(`data: ${"x".repeat(65537)}`)), /TOO_LARGE/u);
  assert.throws(() => new NativeAgentSseDecoder().push(Uint8Array.of(255)), /encoded data/u);
  const error = readNativeAgentMainFrame('data: {"error":"<raw provider details>","code":"LLM_UPSTREAM_RESULT_UNKNOWN"}');
  assert.equal(error.errorCode, "LLM_UPSTREAM_RESULT_UNKNOWN");
  assert.equal(error.text, "");
  assert.equal(error.done, false);
});
