import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  completeLlmAttemptResponse,
  finalizeLlmAttemptFromThrownError,
  fingerprintLlmRequest,
  responseForLlmAttemptClaim,
  type LlmRequestAttemptExecution,
  type LlmRequestAttemptRecord,
  type LlmRequestAttemptStore,
} from "../src/lib/llm-request-idempotency";

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN_IN_ZERO_COST_VERIFIER");
}) as typeof fetch;

function baseRecord(): LlmRequestAttemptRecord {
  return {
    recordId: "a".repeat(64),
    userId: "user-test",
    clientRequestId: "llm-test-0001",
    payloadFingerprint: "b".repeat(64),
    state: "running",
    attemptNo: 1,
    leaseOwner: "lease-test",
    leaseToken: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    providerCallStartedAt: new Date().toISOString(),
    httpStatus: null,
    responseHeaders: {},
    responseBody: null,
    responseFingerprint: null,
    resultReference: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

class CaptureStore implements LlmRequestAttemptStore {
  record = baseRecord();
  finalizations: Array<Parameters<LlmRequestAttemptStore["finalize"]>[0]> = [];

  async claim(): Promise<never> {
    throw new Error("claim is not used by response tests");
  }

  async markProviderCallStarted(execution: LlmRequestAttemptExecution) {
    return execution;
  }

  async finalize(input: Parameters<LlmRequestAttemptStore["finalize"]>[0]) {
    this.finalizations.push(input);
    this.record = {
      ...this.record,
      state: input.state,
      leaseOwner: null,
      leaseExpiresAt: null,
      httpStatus: input.httpStatus ?? null,
      responseHeaders: input.responseHeaders || {},
      responseBody: input.responseBody ?? null,
      responseFingerprint: input.responseFingerprint || null,
      resultReference: input.resultReference || null,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      updatedAt: new Date().toISOString(),
    };
    return structuredClone(this.record);
  }
}

function execution(store: CaptureStore): LlmRequestAttemptExecution {
  return { record: structuredClone(store.record), leaseOwner: "lease-test", leaseToken: 1 };
}

async function testJsonSuccessReplay() {
  const store = new CaptureStore();
  const originalBody = JSON.stringify({ answer: "durable" });
  const delivered = await completeLlmAttemptResponse(
    store,
    execution(store),
    new Response(originalBody, { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  assert.equal(await delivered.text(), originalBody);
  assert.equal(store.record.state, "succeeded");
  assert.match(store.record.resultReference || "", /^llm-result:/u);

  const replay = responseForLlmAttemptClaim({ action: "replay", record: store.record });
  assert.equal(await replay.text(), originalBody);
  assert.equal(replay.headers.get("X-LLM-Replayed"), "true");
  assert.equal(replay.headers.get("X-LLM-Result-Reference"), store.record.resultReference);
}

async function testSseSuccessReplay() {
  const store = new CaptureStore();
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"billing_com'));
      controller.enqueue(encoder.encode('plete":true,"operation_id":"llm:test:response"}\n'));
      controller.enqueue(encoder.encode('\ndata: [DO'));
      controller.enqueue(encoder.encode("NE]\n\n"));
      controller.close();
    },
  });
  const delivered = await completeLlmAttemptResponse(
    store,
    execution(store),
    new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
  );
  const deliveredBody = await delivered.text();
  assert.match(deliveredBody, /billing_complete/u);
  assert.match(deliveredBody, /data: \[DONE\]/u);
  assert.equal(store.record.state, "succeeded");
  const replay = responseForLlmAttemptClaim({ action: "replay", record: store.record });
  assert.equal(await replay.text(), store.record.responseBody);
  assert.match(store.record.responseBody || "", /data: \[DONE\]/u);
}

async function testCozeEventCompletionReplay() {
  const store = new CaptureStore();
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: conversation.message.delta\ndata: {"type":"answer","content":"ok"}\n\n'));
      controller.enqueue(encoder.encode('event: billing.completed\ndata: {"billing_com'));
      controller.enqueue(encoder.encode('plete":true,"operation_id":"llm:test:coze-response"}\n\n'));
      controller.enqueue(encoder.encode('event: conversation.chat.com'));
      controller.enqueue(encoder.encode('pleted\ndata: {"type":"answer"}\n\n'));
      controller.close();
    },
  });
  const delivered = await completeLlmAttemptResponse(
    store,
    execution(store),
    new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
  );
  const body = await delivered.text();
  assert.equal(store.record.state, "succeeded");
  assert.match(body, /event: conversation\.chat\.completed/u);
  assert.match(body, /data: \[DONE\]/u);
  assert.match(store.record.responseBody || "", /data: \[DONE\]/u);
  const replay = responseForLlmAttemptClaim({ action: "replay", record: store.record });
  const replayBody = await replay.text();
  assert.equal(replayBody, store.record.responseBody);
  assert.match(replayBody, /data: \[DONE\]/u);
}

async function testUnknownAndSafeFailureClassification() {
  const unknownStore = new CaptureStore();
  const unknown = await completeLlmAttemptResponse(
    unknownStore,
    execution(unknownStore),
    new Response(JSON.stringify({ error: "gateway timeout" }), { status: 503, headers: { "Content-Type": "application/json" } }),
  );
  assert.equal(unknown.status, 503);
  assert.equal(unknownStore.record.state, "failed_unknown");
  assert.equal(JSON.parse(await unknown.text()).retry_safe, false);

  const failedStore = new CaptureStore();
  const failed = await completeLlmAttemptResponse(
    failedStore,
    execution(failedStore),
    new Response(JSON.stringify({ error: "invalid request" }), { status: 400, headers: { "Content-Type": "application/json" } }),
  );
  assert.equal(failedStore.record.state, "failed");
  assert.equal(failed.headers.get("X-LLM-Retry-Safe"), "true");

  const thrownStore = new CaptureStore();
  await finalizeLlmAttemptFromThrownError(thrownStore, execution(thrownStore), true, new Error("socket reset"));
  assert.equal(thrownStore.record.state, "failed_unknown");

  const rejectedStore = new CaptureStore();
  await finalizeLlmAttemptFromThrownError(rejectedStore, execution(rejectedStore), true, new Error("HTTP status 429 rate limit"));
  assert.equal(rejectedStore.record.state, "failed");
  assert.equal(rejectedStore.record.httpStatus, 429);
}

async function testStaticRouteAndMigrationContract() {
  const root = process.cwd();
  const [route, cozeRoute, idempotencySource, migration, rollback] = await Promise.all([
    readFile(path.join(root, "src/app/api/llm/route.ts"), "utf8"),
    readFile(path.join(root, "src/app/api/chat/route.ts"), "utf8"),
    readFile(path.join(root, "src/lib/llm-request-idempotency.ts"), "utf8"),
    readFile(path.join(root, "supabase/migrations/20260901170000_llm_request_attempts_exactly_once.sql"), "utf8"),
    readFile(path.join(root, "supabase/rollbacks/20260901170000_llm_request_attempts_exactly_once.rollback.sql"), "utf8"),
  ]);
  assert.match(route, /new DatabaseLlmRequestAttemptStore\(\)/u);
  assert.doesNotMatch(route, /new FileLlmRequestIdempotencyStore\(\)/u);
  assert.match(route, /requestFingerprintPayload[\s\S]*?fingerprintLlmRequest\(requestFingerprintPayload\)/u);
  assert.match(route, /markProviderCallStarted/u);
  assert.match(route, /completeLlmAttemptResponse/u);
  assert.match(cozeRoute, /new DatabaseLlmRequestAttemptStore\(\)/u);
  assert.match(cozeRoute, /cozeRequestAttemptStore\.claim/u);
  assert.match(cozeRoute, /markProviderCallStarted/u);
  assert.match(cozeRoute, /completeLlmAttemptResponse\(cozeRequestAttemptStore[\s\S]*?billingStream/u);
  assert.match(cozeRoute, /LLM_IDEMPOTENCY_KEY_REQUIRED/u);
  assert.doesNotMatch(cozeRoute, /FileLlmRequestIdempotencyStore|claimLlmRequestOnce/u);
  assert.doesNotMatch(idempotencySource, /node:fs\/promises|FileLlmRequestIdempotencyStore|MemoryLlmRequestIdempotencyStore/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /lease_token/u);
  assert.match(migration, /provider_call_started_at/u);
  assert.match(migration, /WHEN 'failed' THEN/u);
  assert.match(migration, /retry_claimed/u);
  assert.match(migration, /reconciliation_required/u);
  assert.match(migration, /reconcile_llm_request_attempt_atomic/u);
  assert.match(migration, /GRANT EXECUTE[\s\S]+service_role/u);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.claim_llm_request_attempt_atomic/u);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.llm_request_attempts/u);
}

async function main() {
  assert.equal(
    fingerprintLlmRequest({ nested: { b: 2, a: 1 }, z: true }),
    fingerprintLlmRequest({ z: true, nested: { a: 1, b: 2 } }),
  );
  await testJsonSuccessReplay();
  await testSseSuccessReplay();
  await testCozeEventCompletionReplay();
  await testUnknownAndSafeFailureClassification();
  await testStaticRouteAndMigrationContract();
  assert.equal(networkCalls, 0);
  console.log("LLM durable exactly-once verifier: PASS (network=0, paid_calls=0)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
