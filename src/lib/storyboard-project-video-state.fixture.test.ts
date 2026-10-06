import assert from "node:assert/strict";
import {
  collectStoryboardVideoTaskIds,
  isStoryboardProjectActive,
  isStoryboardProjectRecentBeijingDay,
  normalizeStoryboardVideoTaskStatus,
  reconcileStoryboardProjectVideoTasks,
  shouldRetainStoryboardProject,
  type StoryboardVideoTaskSnapshot,
} from "./storyboard-project-video-state";

let passed = 0;

function equal(actual: unknown, expected: unknown, message: string) {
  assert.equal(actual, expected, message);
  passed += 1;
}

function matches(actual: string, expected: RegExp, message: string) {
  assert.match(actual, expected, message);
  passed += 1;
}

function notMatches(actual: string, expected: RegExp, message: string) {
  assert.doesNotMatch(actual, expected, message);
  passed += 1;
}

function card(taskId: string, modelId = "public-model"): Record<string, unknown> {
  return {
    id: `card-${taskId}`,
    imageStatus: "done",
    videoStatus: "running",
    videoTaskId: taskId,
    videoTaskModelId: modelId,
    videoProgress: 61,
    videoLifecycle: { headline: "仍在渲染" },
    videoError: "旧错误",
  };
}

function task(input: StoryboardVideoTaskSnapshot): StoryboardVideoTaskSnapshot {
  return {
    id: "task-default",
    model_id: "model-default",
    status: "processing",
    completed_at: "2026-09-25T04:05:06.000Z",
    ...input,
  };
}

const sensitiveFailure = "Bearer super-secret-token https://provider.example/jobs/1?token=leak 401 unauthorized";
const failedDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("task-failed")] },
  [task({ id: "task-failed", status: "failed", error_message: sensitiveFailure })],
);
const failedCard = failedDocument.cards[0];
equal(failedCard.videoStatus, "failed", "failed task must replace stale running state");
matches(String(failedCard.videoError), /渠道认证配置异常/u, "failed task must expose an actionable public error");
notMatches(JSON.stringify(failedCard), /super-secret-token|provider\.example|token=leak/iu, "raw provider diagnostics must not enter the project document");
equal(failedCard.videoLifecycle, undefined, "terminal reconciliation must clear stale running lifecycle");
equal(failedCard.videoProgress, undefined, "failed reconciliation must clear stale progress");

const cancelledDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("task-cancelled")] },
  [task({ id: "task-cancelled", status: "canceled", error_message: sensitiveFailure })],
);
const cancelledCard = cancelledDocument.cards[0];
equal(cancelledCard.videoStatus, "cancelled", "canceled alias must map to cancelled");
equal(cancelledCard.videoError, undefined, "cancelled task must not expose provider error text");
equal(cancelledCard.videoStatusDetail, "视频任务已终止，可以重新生成", "cancelled task must use a fixed public message");
equal(cancelledCard.videoRetryable, true, "cancelled task can be regenerated");
notMatches(JSON.stringify(cancelledCard), /super-secret-token|provider\.example|token=leak/iu, "cancelled task must not leak raw diagnostics");

const expiredDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("task-expired")] },
  [task({ id: "task-expired", status: "expired", error_message: sensitiveFailure })],
);
const expiredCard = expiredDocument.cards[0];
equal(expiredCard.videoStatus, "failed", "expired task must be a failed terminal card state");
equal(expiredCard.videoError, "视频任务已过期，请重新生成", "expired task must use a fixed public error");
equal(expiredCard.videoRetryable, true, "expired task can be regenerated");
notMatches(JSON.stringify(expiredCard), /super-secret-token|provider\.example|token=leak/iu, "expired task must not leak raw diagnostics");

const confirmationExpiredDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("task-confirmation-expired")] },
  [task({
    id: "task-confirmation-expired",
    status: "failed",
    submission_error_code: "VIDEO_SUBMISSION_CONFIRMATION_EXPIRED",
    billing_state: "submission_failed",
    price_charged: 0,
    error_message: sensitiveFailure,
  })],
);
const confirmationExpiredCard = confirmationExpiredDocument.cards[0];
matches(String(confirmationExpiredCard.videoError), /确认时限/u, "local expiry code must use its public-safe message");
equal(confirmationExpiredCard.videoRetryable, true, "confirmed unsubmitted expiry can be regenerated");
notMatches(JSON.stringify(confirmationExpiredCard), /super-secret-token|provider\.example|token=leak/iu, "local failure mapping must not expose provider diagnostics");

const providerEvidenceDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("task-with-provider-evidence")] },
  [task({
    id: "task-with-provider-evidence",
    status: "failed",
    error_message: "provider network timeout",
    provider_result_url: "https://provider.example/result/kept-private",
  })],
);
equal(providerEvidenceDocument.cards[0].videoRetryable, false, "provider result evidence must prevent an unsafe duplicate retry");

const completedDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("task-completed")] },
  [task({ id: "task-completed", status: "succeeded", billing_state: "settled", price_charged: 1.25 })],
);
const completedCard = completedDocument.cards[0];
equal(completedCard.videoStatus, "done", "completed alias must map to done");
equal(completedCard.videoProgress, 100, "completed task must reach 100 percent");
equal(completedCard.videoError, undefined, "completed task must clear stale errors");
equal(completedCard.videoBillingState, "settled", "safe billing state must hydrate with terminal status");
equal(completedCard.videoPriceCharged, 1.25, "safe charged amount must hydrate with terminal status");

const externalDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("provider-task-7", "public-model-7")] },
  [task({ id: "internal-task-7", task_id_external: "provider-task-7", model_id: "public-model-7", status: "cancelled" })],
);
equal(externalDocument.cards[0].videoStatus, "cancelled", "external task id must hydrate only with the bound model");
const wrongModelDocument = reconcileStoryboardProjectVideoTasks(
  { cards: [card("provider-task-7", "other-model")] },
  [task({ id: "internal-task-7", task_id_external: "provider-task-7", model_id: "public-model-7", status: "failed" })],
);
equal(wrongModelDocument.cards[0].videoStatus, "running", "external task id from another model must not overwrite the card");

equal(normalizeStoryboardVideoTaskStatus("asset_persisting"), "running", "asset persistence remains active");
equal(normalizeStoryboardVideoTaskStatus("terminated"), "failed", "terminated is a failed terminal state");
equal(normalizeStoryboardVideoTaskStatus("unknown-provider-state"), null, "unknown provider states must not overwrite saved state");

const collected = collectStoryboardVideoTaskIds([
  { cards: [card("active-a"), { ...card("terminal-b"), videoStatus: "failed" }] },
  { cards: [{ ...card("active-a"), videoStatus: "queued" }] },
], { onlyActive: true });
equal(JSON.stringify(collected), JSON.stringify(["active-a"]), "active task collection must deduplicate and exclude terminal cards");
equal(isStoryboardProjectActive(failedDocument), false, "reconciled failure must no longer keep a project active forever");
equal(isStoryboardProjectActive({ cards: [{ imageStatus: "running", videoStatus: "failed" }] }), true, "active image work must still retain its project");

// 2026-09-25T16:30Z is 2026-09-26 00:30 in Beijing.
const now = Date.parse("2026-09-25T16:30:00.000Z");
equal(isStoryboardProjectRecentBeijingDay("2026-09-25T16:05:00.000Z", now), true, "Beijing today must be retained");
equal(isStoryboardProjectRecentBeijingDay("2026-09-24T15:59:59.000Z", now), true, "Beijing yesterday must be retained");
equal(isStoryboardProjectRecentBeijingDay("2026-09-23T16:00:00.000Z", now), true, "Beijing day before yesterday must be retained");
equal(isStoryboardProjectRecentBeijingDay("2026-09-23T15:59:59.000Z", now), false, "older terminal project must fall outside the three-day window");
equal(isStoryboardProjectRecentBeijingDay("2026-09-26T16:00:00.000Z", now), false, "future calendar days must not be retained");
equal(shouldRetainStoryboardProject(failedDocument, "2026-09-23T15:59:59.000Z", now), false, "old reconciled terminal project must be filtered out");
equal(shouldRetainStoryboardProject({ cards: [card("still-active")] }, "2026-09-20T00:00:00.000Z", now), true, "old active project must remain visible");

console.log(JSON.stringify({
  suite: "storyboard-project-video-state-fixture",
  passed,
  networkRequests: 0,
  databaseWrites: 0,
  paidRequests: 0,
}, null, 2));
