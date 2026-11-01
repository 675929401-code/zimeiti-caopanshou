import assert from "node:assert/strict";

process.env.SERVER_ENV_DISCOVERY_DISABLED = "1";

async function main() {
  const { LLMProxy } = await import("../src/lib/llm-proxy/proxy");
  const originalFetch = globalThis.fetch;
  const proxy = new LLMProxy({ apiBase: "https://fixture.invalid/v1", apiKey: "synthetic-fixture", defaultModel: "fixture", provider: "fixture", protocol: "openai_chat", authScheme: "bearer", timeout: 0.05, retryCount: 2, retryDelay: 0 });
  const request = { model: "fixture", messages: [{ role: "user", content: "OK" }] };
  let attempts = 0;
  let transportCancelled = false;
  let liveProducer = false;
  let capturedSignal: AbortSignal = new AbortController().signal;
  try {
    globalThis.fetch = async (_url, init) => {
      attempts++;
      const signal = init!.signal!;
      capturedSignal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          liveProducer = true;
          const producer = setInterval(() => undefined, 1000);
          // Mimic Fetch's signal-connected transport: abort cancels the source
          // and rejects the already-started body consumer. No orphan request.
          signal.addEventListener("abort", () => {
            transportCancelled = true;
            liveProducer = false;
            clearInterval(producer);
            controller.error(signal.reason);
          }, { once: true });
          controller.enqueue(new TextEncoder().encode('{"choices":'));
          // Headers and an incomplete JSON prefix arrive; body never ends.
        },
      });
      return new Response(body, { status: 200 });
    };
    const started = Date.now();
    await assert.rejects(proxy.chat(request), (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(attempts, 1, "successful headers must not replay a body timeout");
    assert.equal(transportCancelled, true);
    assert.equal(liveProducer, false);
    assert.equal(capturedSignal!.aborted, true);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 35 && elapsed < 1000, "whole-response deadline must cover the stalled body");

    attempts = 0;
    globalThis.fetch = async (_url, init) => {
      attempts++;
      capturedSignal = init!.signal!;
      return attempts === 1 ? new Response("temporary", { status: 503 })
        : Response.json({ model: "fixture", choices: [{ message: { content: "OK" } }] });
    };
    assert.equal((await proxy.chat(request)).content, "OK");
    assert.equal(attempts, 2, "existing configured 5xx retry remains available");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(capturedSignal!.aborted, false, "successful body completion clears the deadline");

    attempts = 0;
    globalThis.fetch = async () => { attempts++; return new Response("invalid-json", { status: 200 }); };
    await assert.rejects(proxy.chat(request), SyntaxError);
    assert.equal(attempts, 1, "body parsing failures retain their previous no-retry contract");
    console.log(JSON.stringify({ passed: true, cases: 3, stalledBodyDeadlineMs: 50, elapsedMs: elapsed, abortCancelsFixtureSource: true, orphanProducer: false, successfulHeadersNotReplayed: true, previous5xxRetryPreserved: true, completedRequestTimerCleared: true, externalProviderCalls: 0 }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
