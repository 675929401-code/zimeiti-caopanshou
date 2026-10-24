import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fetchStoryboardJson, openStoryboardStream, StoryboardRequestTimeoutError } from "../src/lib/storyboard-request-deadline";

const originalFetch = globalThis.fetch;
const checks: string[] = [];
const forever = <T>() => new Promise<T>(() => undefined);
async function check(name: string, action: () => Promise<void>) { await action(); checks.push(name); }

async function main() {
try {
  await check("normal JSON completes before the deadline", async () => {
    globalThis.fetch = async () => Response.json({ found: true });
    const result = await fetchStoryboardJson<{ found: boolean }>("https://transport-fixture.invalid/status", {}, { timeoutMs: 100 });
    assert.equal(result.response.status, 200); assert.equal(result.data.found, true);
  });
  await check("missing response headers releases the caller and aborts its transport", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => { signal = init?.signal; return forever<Response>(); };
    await assert.rejects(fetchStoryboardJson("https://transport-fixture.invalid/status", {}, { timeoutMs: 15 }), StoryboardRequestTimeoutError);
    assert.equal(signal?.aborted, true);
  });
  await check("a JSON body that never finishes is also bounded", async () => {
    globalThis.fetch = async () => new Response(new ReadableStream());
    await assert.rejects(fetchStoryboardJson("https://transport-fixture.invalid/status", {}, { timeoutMs: 15 }), StoryboardRequestTimeoutError);
  });
  await check("an already cancelled caller never dispatches fetch", async () => {
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchStoryboardJson("https://transport-fixture.invalid/status", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 0);
  });
  await check("caller cancellation interrupts the pending request", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => { signal = init?.signal; return forever<Response>(); };
    const controller = new AbortController();
    const pending = fetchStoryboardJson("https://transport-fixture.invalid/status", { signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await assert.rejects(pending, { name: "AbortError" }); assert.equal(signal?.aborted, true);
  });
  await check("submission timeout makes exactly one POST without retrying or changing its key", async () => {
    const bodies: string[] = [];
    globalThis.fetch = async (_input, init) => { assert.equal(init?.method, "POST"); bodies.push(String(init?.body)); return forever<Response>(); };
    const body = JSON.stringify({ client_request_id: "stable-fixture-request" });
    await assert.rejects(fetchStoryboardJson("https://transport-fixture.invalid/generate", { method: "POST", body }, { timeoutMs: 15 }), StoryboardRequestTimeoutError);
    await delay(20); assert.deepEqual(bodies, [body]);
  });
  await check("SSE handshake and error-body waits are bounded", async () => {
    globalThis.fetch = async () => forever<Response>();
    await assert.rejects(openStoryboardStream("https://transport-fixture.invalid/stream", {}, { timeoutMs: 15 }), StoryboardRequestTimeoutError);
    globalThis.fetch = async () => new Response(new ReadableStream(), { status: 503 });
    await assert.rejects(openStoryboardStream("https://transport-fixture.invalid/stream", {}, { timeoutMs: 15 }), StoryboardRequestTimeoutError);
  });
  await check("successful SSE stays open after its handshake deadline and closes explicitly", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => { signal = init?.signal; return new Response(new ReadableStream()); };
    const stream = await openStoryboardStream("https://transport-fixture.invalid/stream", {}, { timeoutMs: 15 });
    await delay(30); assert.equal(signal?.aborted, false);
    stream.close(); assert.equal(signal?.aborted, true);
  });
  await check("parent cancellation remains connected after the SSE handshake", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => { signal = init?.signal; return new Response(new ReadableStream()); };
    const controller = new AbortController();
    const stream = await openStoryboardStream("https://transport-fixture.invalid/stream", { signal: controller.signal });
    controller.abort(); assert.equal(signal?.aborted, true); stream.close();
  });
  console.log(JSON.stringify({ passed: true, checks, realNetworkCalls: 0, realGenerationCalls: 0 }));
} finally { globalThis.fetch = originalFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
