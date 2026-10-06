import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  AutodlH3AssetError,
  createAutodlH3AssetRef,
  resolveAutodlH3QueuedAssetPayload,
  signAutodlH3OwnedAssetRefForUser,
  stabilizeAutodlH3InputAssets,
  type AutodlH3AssetDependencies,
} from "../src/lib/autodl-h3-assets";
import {
  finalizeAutodlH3VideoSuccess,
  hasAutodlH3VideoFinalizerDependencies,
  installAutodlH3VideoFinalizerDependencies,
} from "../src/lib/autodl-h3-video-finalizer";
import type { AutodlH3Job } from "../src/lib/autodl-h3-lifecycle";
import { createAutodlH3ProductionFinalizerDependencies } from "../src/lib/autodl-h3-production-finalizer";

const networkCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  networkCalls.push(String(input));
  throw new Error("NETWORK_FORBIDDEN_IN_ZERO_NETWORK_VERIFICATION");
}) as typeof fetch;

const userId = "00000000-0000-4000-8000-000000000001";
const imageKey = "video-inputs/2026/08/21/input.png";
const signedImageUrl = `https://bucket-123.cos.ap-guangzhou.myqcloud.com/${imageKey}?q-signature=test`;

function assetDependencies(options?: { missing?: boolean }): AutodlH3AssetDependencies {
  return {
    async findOwnedAsset(input) {
      if (input.userId !== userId || input.key !== imageKey || input.category !== "image") return null;
      return { provider: "tencent_cos", key: imageKey, category: "image" };
    },
    async exists() { return !options?.missing; },
    async sign() { return signedImageUrl; },
  };
}

function job(): AutodlH3Job {
  const now = new Date(0).toISOString();
  return {
    id: "job-1",
    publicTaskId: "h3q_0123456789abcdef01234567",
    clientRequestId: "h3cr_0123456789abcdef",
    videoTaskInternalId: "vt_h3q_0123456789abcdef01234567",
    userId,
    modelId: "model-h3",
    instanceUuid: "pro-test",
    requestPayload: { prompt: "test" },
    state: "RESULT_STAGING",
    upstreamTaskId: "upstream-1",
    contentUrl: null,
    resultAssetUrl: null,
    progress: 99,
    attemptCount: 1,
    notBefore: null,
    leaseOwner: "worker-1",
    leaseToken: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  };
}

async function testStableAssets() {
  const deps = assetDependencies();
  const stable = await stabilizeAutodlH3InputAssets({
    userId,
    candidates: {
      imageUrl: `https://bucket-123.cos.ap-guangzhou.myqcloud.com/${imageKey}?q-signature=temporary`,
      imageUrls: [],
      audioUrls: [],
    },
  }, deps);
  assert.equal(stable.imageAssetRef, createAutodlH3AssetRef("tencent_cos", imageKey));
  assert.equal(JSON.stringify(stable).includes("q-signature"), false, "queue payload must not retain a signed URL");

  await assert.rejects(
    stabilizeAutodlH3InputAssets({
      userId: "00000000-0000-4000-8000-000000000002",
      candidates: { imageUrl: `https://bucket.example/${imageKey}` },
    }, deps),
    (error: unknown) => error instanceof AutodlH3AssetError && error.code === "H3_ASSET_NOT_OWNED",
  );
  await assert.rejects(
    stabilizeAutodlH3InputAssets({
      userId,
      candidates: { imageUrl: "https://attacker.example/not-owned.png" },
    }, deps),
    (error: unknown) => error instanceof AutodlH3AssetError && error.code === "H3_ASSET_NOT_OWNED",
  );
  await assert.rejects(
    stabilizeAutodlH3InputAssets({
      userId,
      candidates: { imageUrl: `https://attacker.example/${imageKey}` },
    }, deps),
    (error: unknown) => error instanceof AutodlH3AssetError && error.code === "H3_ASSET_NOT_OWNED",
  );

  const hydrated = await resolveAutodlH3QueuedAssetPayload({
    userId,
    payload: { prompt: "test", imageAssetRef: stable.imageAssetRef },
  }, deps);
  assert.equal(hydrated.imageUrl, signedImageUrl);
  assert.equal("imageAssetRef" in hydrated, false);
  assert.equal(
    await signAutodlH3OwnedAssetRefForUser({ userId, assetRef: stable.imageAssetRef!, category: "image" }, deps),
    signedImageUrl,
  );

  await assert.rejects(
    resolveAutodlH3QueuedAssetPayload({ userId, payload: { imageUrl: "https://arbitrary.example/a.png" } }, deps),
    (error: unknown) => error instanceof AutodlH3AssetError && error.code === "H3_LEGACY_URL_PAYLOAD_FORBIDDEN",
  );
  await assert.rejects(
    resolveAutodlH3QueuedAssetPayload({
      userId,
      payload: { imageAssetRef: stable.imageAssetRef },
    }, assetDependencies({ missing: true })),
    (error: unknown) => error instanceof AutodlH3AssetError && error.code === "H3_ASSET_MISSING",
  );
}

async function testFinalizerFailClosedAndSuccess() {
  const originalLifecycle = process.env.AUTODL_H3_LIFECYCLE_ENABLED;
  const originalAtomic = process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED;
  process.env.AUTODL_H3_LIFECYCLE_ENABLED = "true";
  delete process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED;
  assert.equal(hasAutodlH3VideoFinalizerDependencies(), false);
  const disabled = await finalizeAutodlH3VideoSuccess({ job: job(), resultUrl: "http://127.0.0.1/result" });
  assert.equal(disabled.state, "RECOVERY_REQUIRED");
  assert.equal(disabled.errorCode, "H3_ATOMIC_FINALIZER_DISABLED");

  process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED = "true";
  const progress: string[] = [];
  let persisted = 0;
  installAutodlH3VideoFinalizerDependencies({
    async loadContext(current) {
      return {
        userId: current.userId,
        userRole: "student",
        modelId: current.modelId,
        modelName: "H3",
        videoTaskInternalId: current.videoTaskInternalId!,
        publicTaskId: current.publicTaskId,
        upstreamTaskId: current.upstreamTaskId!,
        providerProtocol: "autodl_h3_selfhost",
        providerEndpoint: "http://127.0.0.1:16011/v1",
        durationSeconds: 5,
        priceYuan: 1,
        costPrice: 0,
        alreadyCompleted: false,
      };
    },
    async persistResult() {
      persisted += 1;
      return "object://tencent_cos/videos%2Fgenerated%2Fresult.mp4";
    },
    async settleAtomically() {
      return { committed: false, alreadyCommitted: false, stableAssetUrl: "", chargedYuan: 0 };
    },
    async markProgress(input) { progress.push(input.state); return input; },
  });
  assert.equal(hasAutodlH3VideoFinalizerDependencies(), true);
  const notCommitted = await finalizeAutodlH3VideoSuccess({ job: job(), resultUrl: "http://127.0.0.1/result" });
  assert.equal(notCommitted.state, "RECOVERY_REQUIRED");
  assert.equal(notCommitted.errorCode, "H3_ATOMIC_SETTLEMENT_NOT_COMMITTED");
  assert.equal(persisted, 1);
  assert.equal(progress.includes("SUCCEEDED"), false, "uncommitted settlement must never publish success");

  progress.length = 0;
  installAutodlH3VideoFinalizerDependencies({
    async loadContext(current) {
      return {
        userId: current.userId,
        userRole: "student",
        modelId: current.modelId,
        modelName: "H3",
        videoTaskInternalId: current.videoTaskInternalId!,
        publicTaskId: current.publicTaskId,
        upstreamTaskId: current.upstreamTaskId!,
        providerProtocol: "autodl_h3_selfhost",
        providerEndpoint: "http://127.0.0.1:16011/v1",
        durationSeconds: 5,
        priceYuan: 1,
        costPrice: 0,
        alreadyCompleted: false,
      };
    },
    async persistResult() { return "object://tencent_cos/videos%2Fgenerated%2Fresult.mp4"; },
    async settleAtomically(input) {
      assert.equal(input.job.leaseOwner, "worker-1");
      return { committed: true, alreadyCommitted: false, stableAssetUrl: input.stableAssetUrl, chargedYuan: 1 };
    },
    async markProgress(input) { progress.push(input.state); return input; },
  });
  const completed = await finalizeAutodlH3VideoSuccess({ job: job(), resultUrl: "http://127.0.0.1/result" });
  assert.equal(completed.state, "SUCCEEDED");
  assert.deepEqual(progress, ["PERSISTING", "FINALIZING"]);

  if (typeof originalLifecycle === "undefined") delete process.env.AUTODL_H3_LIFECYCLE_ENABLED;
  else process.env.AUTODL_H3_LIFECYCLE_ENABLED = originalLifecycle;
  if (typeof originalAtomic === "undefined") delete process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED;
  else process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED = originalAtomic;
}

async function testProductionAtomicRpcAdapter() {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dependencies = createAutodlH3ProductionFinalizerDependencies({
    store: { async markJobProgress(input: unknown) { return input; } } as never,
    client: {
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return { data: { committed: true, already_committed: false, stable_asset_url: "object://tencent_cos/video/final.mp4", charged_yuan: 1 }, error: null };
      },
    } as never,
    persist: async () => "object://tencent_cos/video/final.mp4",
  });
  const current = job();
  const settlementInput = {
    job: current,
    context: {
      userId: current.userId, userRole: "student", modelId: current.modelId, modelName: "H3",
      videoTaskInternalId: current.videoTaskInternalId!, publicTaskId: current.publicTaskId,
      upstreamTaskId: current.upstreamTaskId!, providerProtocol: "autodl_h3_selfhost",
      providerEndpoint: "http://127.0.0.1:16011/v1/video/generations", durationSeconds: 5,
      priceYuan: 1, costPrice: 0.5, alreadyCompleted: false,
    },
    stableAssetUrl: "object://tencent_cos/video/final.mp4",
    responseMs: 123,
  } as const;
  const settled = await dependencies.settleAtomically(settlementInput);
  assert.equal(settled.committed, true);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "autodl_h3_finalize_video");
  assert.equal(rpcCalls[0].args.p_owner, "worker-1");
  assert.equal(rpcCalls[0].args.p_lease_token, 1);

  const mismatchedCharge = createAutodlH3ProductionFinalizerDependencies({
    store: { async markJobProgress(input: unknown) { return input; } } as never,
    client: {
      async rpc() {
        return { data: { committed: true, stable_asset_url: settlementInput.stableAssetUrl, charged_yuan: 0 }, error: null };
      },
    } as never,
    persist: async () => settlementInput.stableAssetUrl,
  });
  await assert.rejects(
    mismatchedCharge.settleAtomically(settlementInput),
    /AUTODL_H3_ATOMIC_SETTLEMENT_RESPONSE_INVALID/,
    "a committed response with a partial charge must fail closed",
  );

  const emptyRpc = createAutodlH3ProductionFinalizerDependencies({
    store: { async markJobProgress(input: unknown) { return input; } } as never,
    client: { async rpc() { return { data: null, error: null }; } } as never,
    persist: async () => settlementInput.stableAssetUrl,
  });
  await assert.rejects(
    emptyRpc.settleAtomically(settlementInput),
    /AUTODL_H3_ATOMIC_SETTLEMENT_RPC_EMPTY/,
    "an empty RPC result must fail closed",
  );
}

async function main() {
  await testStableAssets();
  await testFinalizerFailClosedAndSuccess();
  await testProductionAtomicRpcAdapter();
  const [generateSource, historySource, activeTasksSource, pollSource, migrationSource, rollbackSource] = await Promise.all([
    readFile("src/app/api/video/generate/route.ts", "utf8"),
    readFile("src/app/api/video/history/route.ts", "utf8"),
    readFile("src/app/api/video/active-tasks/route.ts", "utf8"),
    readFile("src/app/api/video/poll/route.ts", "utf8"),
    readFile("scripts/migrations/20260821_autodl_h3_lifecycle.sql", "utf8"),
    readFile("scripts/migrations/20260821_autodl_h3_lifecycle_rollback.sql", "utf8"),
  ]);
  const lifecycleStart = generateSource.indexOf("if (useAutodlH3Lifecycle)");
  const lifecycleEnd = generateSource.indexOf("const submitMs", lifecycleStart);
  const lifecycleSource = generateSource.slice(lifecycleStart, lifecycleEnd);
  const reservationIndex = lifecycleSource.indexOf("await reserveVideoGenerationTask({");
  const enqueueIndex = lifecycleSource.indexOf("await enqueueAutodlH3VideoJob({");
  assert.ok(lifecycleSource.includes("firstFrameUrl: stableInputAssets.imageAssetRef"));
  assert.ok(lifecycleSource.includes("...stableInputAssets"));
  assert.ok(
    reservationIndex >= 0 && enqueueIndex > reservationIndex,
    "owned input refs must be durably reserved before lifecycle enqueue",
  );
  assert.equal(lifecycleSource.includes("imageUrl: image_url || undefined"), false);
  assert.ok(historySource.includes("signAutodlH3OwnedAssetRefForUser"));
  assert.ok(activeTasksSource.includes("resolveOwnedImagePreview(t.first_frame_url, userId)"));
  assert.ok(activeTasksSource.includes("resolveOwnedImagePreview(t.last_frame_url, userId)"));
  assert.ok(activeTasksSource.includes("resolveOwnedImagePreview(t.reference_image_url, userId)"));
  assert.ok(pollSource.includes("!AUTODL_H3_LIFECYCLE_TASK_ID.test(task.task_id_external)"));
  assert.ok(pollSource.includes("signAutodlH3OwnedAssetRefForUser"));
  assert.ok(migrationSource.includes("CREATE OR REPLACE FUNCTION autodl_h3_finalize_video"));
  assert.ok(migrationSource.includes("autodl_h3_mark_claimed_job_progress"));
  assert.ok(migrationSource.includes("AUTODL_H3_SUCCESS_REQUIRES_ATOMIC_SETTLEMENT"));
  assert.ok(migrationSource.includes("CREATE TABLE IF NOT EXISTS autodl_h3_settlements"));
  assert.ok(migrationSource.includes("user_id varchar NOT NULL REFERENCES users(id)"));
  assert.equal(migrationSource.includes("p_user_id uuid"), false);
  assert.ok(migrationSource.includes("p_user_id text"));
  assert.ok(migrationSource.includes("v_ledger_user_id uuid"));
  assert.ok(migrationSource.includes("VALUES (v_ledger_user_id, p_price_yuan"));
  assert.ok(migrationSource.includes("VALUES (v_ledger_user_id, p_model_id"));
  assert.ok(migrationSource.includes("AUTODL_H3_FINALIZE_INSUFFICIENT_CASH"));
  assert.equal(migrationSource.includes("cash_debt_records"), false);
  assert.equal(migrationSource.includes("debt_yuan"), false);
  assert.ok(rollbackSource.includes("autodl_h3_enqueue_job(text, text, text, text, text, text, jsonb)"));
  assert.ok(rollbackSource.includes("autodl_h3_finalize_video(uuid, text, text, text, text, text, text, bigint"));
  assert.equal(rollbackSource.includes("cash_debt_records"), false);
  assert.equal(
    migrationSource.match(/OR v_state\.lease_expires_at IS NULL/g)?.length,
    2,
    "both shutdown gates must fail closed when the instance lease expiry is missing",
  );
  assert.deepEqual(networkCalls, []);
  console.log("PASS verify-autodl-h3-assets-finalizer (zero network)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
