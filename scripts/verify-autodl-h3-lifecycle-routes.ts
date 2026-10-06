import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildAutodlH3ClientRequestId,
  createAutodlH3PublicTaskId,
  enqueueAutodlH3VideoJob,
  isAutodlH3LifecycleEnabled,
  isStableAutodlH3ResultAssetUrl,
  sanitizeAutodlH3RequestPayload,
  type AutodlH3Job,
  type AutodlH3LifecycleStore,
} from "../src/lib/autodl-h3-lifecycle";
import {
  isAmbiguousAutodlH3SubmissionStatus,
  resolveAutodlH3ClientAttempt,
} from "../src/lib/autodl-h3-client-idempotency";

const root = process.cwd();
const networkCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  networkCalls.push(String(input));
  throw new Error("NETWORK_FORBIDDEN_IN_ZERO_NETWORK_VERIFICATION");
}) as typeof fetch;

function makeJob(input: Parameters<AutodlH3LifecycleStore["enqueueJob"]>[0]): AutodlH3Job {
  const now = new Date(0).toISOString();
  return {
    id: `job_${input.publicTaskId}`,
    publicTaskId: input.publicTaskId,
    clientRequestId: input.idempotencyKey,
    videoTaskInternalId: input.videoTaskInternalId,
    userId: input.userId,
    modelId: input.modelId,
    instanceUuid: input.instanceUuid,
    requestPayload: input.requestPayload,
    state: "ACCEPTED",
    upstreamTaskId: null,
    contentUrl: null,
    resultAssetUrl: null,
    progress: 0,
    attemptCount: 0,
    notBefore: null,
    leaseOwner: null,
    leaseToken: 0,
    leaseExpiresAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
  };
}

async function main() {
  const originalEnabled = process.env.AUTODL_H3_LIFECYCLE_ENABLED;
  delete process.env.AUTODL_H3_LIFECYCLE_ENABLED;
  assert.equal(isAutodlH3LifecycleEnabled(), false, "feature flag must fail closed when absent");
  process.env.AUTODL_H3_LIFECYCLE_ENABLED = "TRUE";
  assert.equal(isAutodlH3LifecycleEnabled(), false, "feature flag must be exact lowercase true");
  process.env.AUTODL_H3_LIFECYCLE_ENABLED = "true";
  assert.equal(isAutodlH3LifecycleEnabled(), true);

  const actionA = "h3-video-card-a-0001";
  const actionB = "h3-video-card-b-0001";
  const stableA1 = buildAutodlH3ClientRequestId({ userId: "user-a", idempotencyKey: actionA });
  const stableA2 = buildAutodlH3ClientRequestId({ userId: "user-a", idempotencyKey: actionA });
  const stableB = buildAutodlH3ClientRequestId({ userId: "user-a", idempotencyKey: actionB });
  assert.equal(stableA1, stableA2, "same action retry must keep the same server idempotency key");
  assert.notEqual(stableA1, stableB, "separate card/action must not share an idempotency key");
  assert.notEqual(
    stableA1,
    buildAutodlH3ClientRequestId({ userId: "user-b", idempotencyKey: actionA }),
    "same browser key must be tenant scoped",
  );
  assert.equal(
    createAutodlH3PublicTaskId({ userId: "user-a", clientRequestId: stableA1 }),
    createAutodlH3PublicTaskId({ userId: "user-a", clientRequestId: stableA2 }),
  );

  let factoryCounter = 0;
  const firstAttempt = resolveAutodlH3ClientAttempt({
    enabled: true,
    fingerprint: "payload-a",
    createRequestId: () => `h3-video-unit-${++factoryCounter}`,
  });
  const ambiguousRetry = resolveAutodlH3ClientAttempt({
    enabled: true,
    fingerprint: "payload-a",
    previousRequestId: firstAttempt.clientRequestId,
    previousFingerprint: firstAttempt.clientRequestFingerprint,
    createRequestId: () => `h3-video-unit-${++factoryCounter}`,
  });
  assert.equal(ambiguousRetry.clientRequestId, firstAttempt.clientRequestId, "network/5xx retry must reuse the key");
  assert.equal(factoryCounter, 1, "retries must not call the ID factory again");
  const newManualRound = resolveAutodlH3ClientAttempt({
    enabled: true,
    fingerprint: "payload-a",
    previousRequestId: firstAttempt.clientRequestId,
    previousFingerprint: firstAttempt.clientRequestFingerprint,
    previousTerminal: true,
    createRequestId: () => `h3-video-unit-${++factoryCounter}`,
  });
  assert.notEqual(newManualRound.clientRequestId, firstAttempt.clientRequestId, "a new action after terminal state needs a new key");
  const changedPayload = resolveAutodlH3ClientAttempt({
    enabled: true,
    fingerprint: "payload-b",
    previousRequestId: firstAttempt.clientRequestId,
    previousFingerprint: firstAttempt.clientRequestFingerprint,
    createRequestId: () => `h3-video-unit-${++factoryCounter}`,
  });
  assert.notEqual(changedPayload.clientRequestId, firstAttempt.clientRequestId, "changed input needs a new key");
  assert.equal(isAmbiguousAutodlH3SubmissionStatus(503), true);
  assert.equal(isAmbiguousAutodlH3SubmissionStatus(429), true);
  assert.equal(isAmbiguousAutodlH3SubmissionStatus(400), false);
  assert.equal(isAmbiguousAutodlH3SubmissionStatus(402), false);

  const jobs = new Map<string, AutodlH3Job>();
  const enqueueCalls: string[] = [];
  const store = {
    async enqueueJob(input: Parameters<AutodlH3LifecycleStore["enqueueJob"]>[0]) {
      const uniqueKey = `${input.userId}\u0000${input.idempotencyKey}`;
      enqueueCalls.push(uniqueKey);
      const existing = jobs.get(uniqueKey);
      if (existing) return { job: existing, created: false };
      const job = makeJob(input);
      jobs.set(uniqueKey, job);
      return { job, created: true };
    },
  } as AutodlH3LifecycleStore;
  const enqueueInput = {
    userId: "user-a",
    modelId: "model-h3",
    idempotencyKey: actionA,
    instanceUuid: "instance-test",
    videoTaskInternalId: "vt-test-a",
    requestPayload: { prompt: "zero-network test", duration: 10 },
  };
  const queued1 = await enqueueAutodlH3VideoJob(enqueueInput, { store });
  const queued2 = await enqueueAutodlH3VideoJob(enqueueInput, { store });
  assert.equal(queued1.publicTaskId, queued2.publicTaskId);
  assert.equal(queued1.created, true);
  assert.equal(queued2.created, false);
  assert.equal(jobs.size, 1, "same request must map to one durable lifecycle job");
  assert.equal(enqueueCalls.length, 2, "a lost response may safely replay the atomic upsert");

  assert.throws(
    () => sanitizeAutodlH3RequestPayload({ prompt: "safe", api_key: "forbidden" }),
    /PAYLOAD_CONTAINS_SECRET_FIELD/u,
  );
  assert.equal(isStableAutodlH3ResultAssetUrl("object://tencent_cos/video/user/task.mp4"), true);
  assert.equal(isStableAutodlH3ResultAssetUrl("object://tencent_cos/video/../secret"), false);
  assert.equal(isStableAutodlH3ResultAssetUrl("https://example.com/video.mp4?token=forbidden"), false);
  assert.equal(isStableAutodlH3ResultAssetUrl("https://gateway.seetacloud.com/video.mp4"), false);

  const source = async (relative: string) => readFile(path.join(root, relative), "utf8");
  const [generate, status, stream, page, canvas, terminalFinalizer] = await Promise.all([
    source("src/app/api/video/generate/route.ts"),
    source("src/app/api/video/status/route.ts"),
    source("src/app/api/video/stream/route.ts"),
    source("src/app/video/page.tsx"),
    source("src/components/manual-canvas.tsx"),
    source("src/lib/video-terminal-finalizer.ts"),
  ]);
  const lifecycleStart = generate.indexOf("if (useAutodlH3Lifecycle)");
  const businessReservation = generate.indexOf("await reserveVideoGenerationTask({", lifecycleStart);
  const lifecycleEnqueue = generate.indexOf("await enqueueAutodlH3VideoJob", lifecycleStart);
  const legacySubmit = generate.indexOf("await submitVideoTask(channelConfig", lifecycleStart);
  assert.ok(
    lifecycleStart >= 0 && businessReservation > lifecycleStart && lifecycleEnqueue > businessReservation,
    "atomic business-task reservation must complete before lifecycle enqueue",
  );
  assert.ok(legacySubmit > lifecycleEnqueue, "legacy provider submit must remain outside the lifecycle branch");
  assert.ok(generate.includes("getAutodlH3VideoJobForUser({ publicTaskId, userId })"), "ambiguous enqueue must recover by deterministic public id");
  assert.ok(generate.includes("H3_LIFECYCLE_ENQUEUE_OUTCOME_UNKNOWN"), "unknown enqueue outcome must remain recoverable");
  assert.ok(!generate.slice(lifecycleStart, legacySubmit).includes("submitVideoTask("), "lifecycle H3 branch must never directly submit on 5xx");

  for (const [name, route] of [["status", status], ["stream", stream]] as const) {
    assert.ok(route.includes("const isLifecyclePublicTaskId = /^h3q_"), `${name} must isolate lifecycle lookup to h3q ids`);
    assert.ok(route.includes("H3_LIFECYCLE_DISABLED"), `${name} must fail closed when the flag is off for an h3q id`);
    assert.ok(route.includes("H3_LIFECYCLE_JOB_NOT_VISIBLE"), `${name} must fail closed when the job is unavailable`);
    assert.ok(route.includes("providerTaskId"), `${name} must resolve the upstream id before polling`);
    assert.ok(!route.includes("pollVideoTask(config, taskId"), `${name} must never poll with the public lifecycle id`);
    for (const state of ["WAITING_POWER", "WAITING_READY", "RETRY_WAIT", "RECOVERY_REQUIRED", "FINALIZING"]) {
      assert.ok(route.includes(state), `${name} must expose ${state}`);
    }
  }
  assert.ok(status.includes("finalizeVideoGenerationSuccess"), "status completion must use the unified terminal gate");
  assert.ok(stream.includes("finalizeVideoGenerationSuccess"), "stream completion must use the unified terminal gate");
  assert.ok(terminalFinalizer.includes("persistStableVideoFromUrl"), "terminal gate must persist the provider result before delivery");
  assert.ok(terminalFinalizer.includes("STABLE_VIDEO_URI_PATTERN"), "terminal gate must attest the stable object URI");
  assert.ok(terminalFinalizer.includes("finalize_video_generation_task_atomic"), "terminal gate must atomically commit billing and delivery");
  assert.ok(terminalFinalizer.includes("createVideoAccessUrl"), "terminal gate must expose only an owned playback ticket");
  assert.ok(page.includes("resolveBrowserClientAttempt"));
  assert.ok(page.includes("isAmbiguousAutodlH3SubmissionStatus(res.status)"));
  assert.ok(canvas.includes("resolveAutodlH3ClientAttempt"));
  assert.ok(canvas.indexOf("resolveAutodlH3ClientAttempt") < canvas.indexOf("for (let attempt = 1; attempt <= VIDEO_SUBMIT_MAX_ATTEMPTS"), "manual retries must reuse one precomputed key");

  assert.deepEqual(networkCalls, [], "verification must perform zero network calls");
  if (typeof originalEnabled === "undefined") delete process.env.AUTODL_H3_LIFECYCLE_ENABLED;
  else process.env.AUTODL_H3_LIFECYCLE_ENABLED = originalEnabled;
  console.log("PASS verify-autodl-h3-lifecycle-routes (zero network)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
