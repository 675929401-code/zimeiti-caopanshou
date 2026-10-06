import assert from "node:assert/strict";
import {
  ImageExactlyOnceError,
  MemoryImageExactlyOnceStore,
  imageUpstreamAttemptLimit,
  restrictImageCandidatesForNoRetry,
  runImageExactlyOnce,
  strictImagePayloadFingerprint,
} from "../src/lib/image-exactly-once";

async function main() {
  const store = new MemoryImageExactlyOnceStore();
  const base = {
    store,
    userId: "user-mock-001",
    clientIdempotencyKey: "imgkey_mock_001",
    clientTraceId: "imgtrace_mock_001",
    payloadFingerprint: strictImagePayloadFingerprint({ modelId: "pm_HabdJ5rvD_L3-HUkfMUmGsrm", prompt: "dog storyboard" }),
  };
  let upstreamPosts = 0;
  const submitOnce = async () => {
    upstreamPosts += 1;
    return { imageUrl: "https://example.invalid/already-generated.png" };
  };

  assert.equal(await store.get({
    userId: base.userId,
    clientIdempotencyKey: base.clientIdempotencyKey,
    clientTraceId: base.clientTraceId,
  }), null, "未提交前的本地状态查询必须是 not_found，且不得调用上游");

  const first = await runImageExactlyOnce({ ...base, submitOnce });
  assert.equal(first.replayed, false);
  assert.equal(upstreamPosts, 1, "首次请求必须且只能有 1 次上游 POST");
  const completedRecord = await store.get({
    userId: base.userId,
    clientIdempotencyKey: base.clientIdempotencyKey,
    clientTraceId: base.clientTraceId,
  });
  assert.equal(completedRecord?.state, "completed", "上游明确返回后必须可通过同键状态查询恢复");
  assert.deepEqual(completedRecord?.response, first.response);

  const replay = await runImageExactlyOnce({ ...base, submitOnce });
  assert.equal(replay.replayed, true);
  assert.equal(upstreamPosts, 1, "同键重放不得新增上游 POST");
  assert.deepEqual(replay.response, first.response, "同键必须回放同一明确结果");

  await assert.rejects(
    () => runImageExactlyOnce({
      ...base,
      payloadFingerprint: strictImagePayloadFingerprint({ modelId: "pm_HabdJ5rvD_L3-HUkfMUmGsrm", prompt: "different payload" }),
      submitOnce,
    }),
    (error: unknown) => error instanceof ImageExactlyOnceError
      && error.code === "IMAGE_IDEMPOTENCY_CONFLICT"
      && error.status === 409,
    "同键不同 payload 必须 409",
  );
  assert.equal(upstreamPosts, 1, "冲突请求不得触发上游 POST");

  const ambiguousStore = new MemoryImageExactlyOnceStore();
  let ambiguousPosts = 0;
  const ambiguous = {
    store: ambiguousStore,
    userId: "user-mock-002",
    clientIdempotencyKey: "imgkey_mock_002",
    clientTraceId: "imgtrace_mock_002",
    payloadFingerprint: strictImagePayloadFingerprint({ prompt: "ambiguous" }),
    submitOnce: async () => {
      ambiguousPosts += 1;
      throw new TypeError("mock network timeout after POST");
    },
  };
  await assert.rejects(() => runImageExactlyOnce(ambiguous), TypeError);
  await assert.rejects(
    () => runImageExactlyOnce(ambiguous),
    (error: unknown) => error instanceof ImageExactlyOnceError
      && error.code === "IMAGE_IDEMPOTENCY_FAIL_CLOSED"
      && error.status === 409,
    "模糊网络结果的同键后续请求必须 fail-closed",
  );
  assert.equal(ambiguousPosts, 1, "模糊网络结果也不得产生第二次上游 POST");
  const ambiguousRecord = await ambiguousStore.get({
    userId: ambiguous.userId,
    clientIdempotencyKey: ambiguous.clientIdempotencyKey,
    clientTraceId: ambiguous.clientTraceId,
  });
  assert.equal(ambiguousRecord?.state, "failed_unknown", "模糊结果必须持久化为 unknown，不得当成可重提失败");
  await assert.rejects(
    () => ambiguousStore.get({
      userId: ambiguous.userId,
      clientIdempotencyKey: ambiguous.clientIdempotencyKey,
      clientTraceId: "imgtrace_mock_conflict",
    }),
    (error: unknown) => error instanceof ImageExactlyOnceError
      && error.code === "IMAGE_IDEMPOTENCY_TRACE_CONFLICT"
      && error.status === 409,
    "状态刷新也必须绑定原 trace，防止跨请求误恢复",
  );
  assert.equal(ambiguousPosts, 1, "本地状态刷新不得产生任何上游 POST");

  const paidStore = new MemoryImageExactlyOnceStore();
  let walletReservations = 0;
  let paidProviderPosts = 0;
  const paidBase = {
    store: paidStore,
    userId: "user-paid-001",
    clientIdempotencyKey: "imgkey_paid_001",
    clientTraceId: "imgtrace_paid_001",
    payloadFingerprint: strictImagePayloadFingerprint({ prompt: "paid exact once" }),
    beforeSubmitOnce: async () => { walletReservations += 1; },
    submitOnce: async () => {
      paidProviderPosts += 1;
      return { imageUrl: "https://example.invalid/paid.png" };
    },
  };
  const [paidFirst, paidReplay] = await Promise.all([
    runImageExactlyOnce(paidBase),
    runImageExactlyOnce(paidBase).catch((error) => error),
  ]);
  assert.equal(walletReservations, 1, "并发同键只能由 durable-intent 赢家预留一次钱包");
  assert.equal(paidProviderPosts, 1, "并发同键只能调用一次付费上游");
  assert.equal(paidFirst.replayed, false);
  assert.ok(paidReplay instanceof ImageExactlyOnceError || paidReplay?.replayed === true,
    "并发重放只能命中 fail-closed 或已完成回放");
  await runImageExactlyOnce(paidBase);
  assert.equal(walletReservations, 1, "完成态重放不得再次预留钱包");
  assert.equal(paidProviderPosts, 1, "完成态重放不得再次调用上游");

  assert.equal(imageUpstreamAttemptLimit(true), 1, "strict 模式网络层不得自动重发");
  assert.equal(imageUpstreamAttemptLimit(false), 1, "普通图片模型在未知受理状态下也不得自动重发");
  assert.deepEqual(restrictImageCandidatesForNoRetry(["primary", "fallback"], true), ["primary"]);
  assert.deepEqual(restrictImageCandidatesForNoRetry(["primary", "fallback"], false), ["primary"],
    "普通生图也不得在一次用户提交中跨中转站自动发第二个 POST");

  console.log(JSON.stringify({
    ok: true,
    strictFirstPostCount: upstreamPosts,
    strictReplayAddedPosts: 0,
    conflictStatus: 409,
    ambiguousPostCount: ambiguousPosts,
    completedRefreshState: completedRecord?.state,
    ambiguousRefreshState: ambiguousRecord?.state,
    legacyAttemptLimit: imageUpstreamAttemptLimit(false),
    legacyCandidateCount: restrictImageCandidatesForNoRetry(["primary", "fallback"], false).length,
    networkCalls: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
