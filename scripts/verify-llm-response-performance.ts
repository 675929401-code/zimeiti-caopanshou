import assert from "node:assert/strict";
import { observeLlmPerformanceResponse } from "../src/lib/llm-response-performance";
import { createOperationPerformanceTrace, type OperationPerformanceEvent } from "../src/lib/operation-performance-trace";

const encoder = new TextEncoder();
const checks: string[] = [];
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\r\n\r\n`;
const delivery = frame({ type: "stream_delivery", stream_delivery: "live" });
const text = frame({ choices: [{ delta: { content: "你好" } }] });
const billing = frame({ billing_complete: true });
const done = "data: [DONE]\r\n\r\n";
function fixture(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const events: OperationPerformanceEvent[] = [];
  const trace = createOperationPerformanceTrace({ domain: "chat", operation: "llm.chat_request", route: "/api/llm" }, e => { events.push(e); });
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }),
    { headers: { "content-type": "text/event-stream", "x-fixture": "preserved", ...headers } });
  return { response: observeLlmPerformanceResponse(response, trace), events };
}
async function check(name: string, source: string, outcome: string, code: string | null, split = false, headers = {}) {
  const bytes = encoder.encode(source);
  const chunks = split ? [...bytes].map(byte => Uint8Array.of(byte)) : [bytes];
  const { response, events } = fixture(chunks, headers);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes, "exact bytes must be preserved");
  assert.equal(response.headers.get("x-fixture"), "preserved");
  const terminals = events.filter(e => e.phase === "response.terminal");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].outcome, outcome);
  assert.equal(terminals[0].error_code, code);
  assert.equal(events.filter(e => e.phase === "response.first_byte").length, 1);
  assert.equal(events.filter(e => e.phase === "upstream.wait").length, 0, "local first bytes cannot establish upstream timing");
  checks.push(name);
}
async function main() {
  await check("HTTP 200 upstream unknown remains unknown", delivery + frame({ error: "unknown", code: "LLM_UPSTREAM_RESULT_UNKNOWN" }), "unknown", "LLM_UPSTREAM_RESULT_UNKNOWN");
  await check("known failure overrides DONE", frame({ error: "empty", code: "LLM_EMPTY_RESPONSE" }) + done, "error", "LLM_EMPTY_RESPONSE");
  await check("plain SSE error event overrides completion", "event: error\ndata: upstream failed\n\n" + billing + done, "error", "LLM_RESPONSE_ERROR");
  await check("success with billing and DONE, UTF8 and CRLF split at every byte", delivery + text + billing + done, "success", null, true);
  await check("text mentioning errors and DONE is ordinary content", frame({ choices: [{ delta: { content: "LLM_UPSTREAM_RESULT_UNKNOWN [DONE]" } }] }) + billing + done, "success", null);
  await check("local control and content without terminal remain unknown", delivery + text, "unknown", "LLM_STREAM_TERMINAL_UNKNOWN");
  await check("DONE without settlement remains unknown", text + done, "unknown", "LLM_STREAM_TERMINAL_UNKNOWN");
  await check("settlement without completion remains unknown", text + billing, "unknown", "LLM_STREAM_TERMINAL_UNKNOWN");
  await check("persistence recovery error overrides settled completion", billing + frame({ error: "history pending", code: "LLM_ASSISTANT_PERSISTENCE_FAILED", reconciliation_required: true }) + done, "unknown", "LLM_ASSISTANT_PERSISTENCE_FAILED");
  await check("guarded zero-cost response has deliberate completion", text + done, "success", null, false, { "X-LLM-Guarded": "true" });
  const events: OperationPerformanceEvent[] = [];
  const trace = createOperationPerformanceTrace({ domain: "chat", operation: "llm.chat_request", route: "/api/llm" }, e => { events.push(e); });
  let cancelled = false;
  const response = observeLlmPerformanceResponse(new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(delivery)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }), trace);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), delivery, "first control frame must deliver without awaiting terminal");
  await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
  assert.deepEqual(events.filter(e => e.phase === "response.terminal").map(e => e.outcome), ["cancelled"]);
  checks.push("live first frame and consumer cancellation propagate without duplicate terminal");
  const brokenEvents: OperationPerformanceEvent[] = [];
  const brokenTrace = createOperationPerformanceTrace({ domain: "chat", operation: "llm.chat_request", route: "/api/llm" }, e => { brokenEvents.push(e); });
  const broken = observeLlmPerformanceResponse(new Response(new ReadableStream({ start(c) { c.error(new Error("fixture disconnected")); } }), { headers: { "content-type": "text/event-stream" } }), brokenTrace);
  await assert.rejects(broken.text(), /fixture disconnected/u);
  assert.deepEqual(brokenEvents.filter(e => e.phase === "response.terminal").map(e => [e.outcome, e.error_code]), [["error", "LLM_STREAM_OBSERVE_FAILED"]]);
  checks.push("source stream exception propagates and records one failure");
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
}
void main();
