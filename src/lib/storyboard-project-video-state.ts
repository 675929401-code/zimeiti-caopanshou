import { toPublicModelId } from "@/lib/public-model-dto";
import { classifyVideoProviderError, localVideoTaskFailureMessage } from "@/lib/video-error-policy";
import { canRetryVideoHistoryTask } from "@/lib/video-history-presentation";

const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export type StoryboardVideoStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type StoryboardVideoTaskSnapshot = {
  id?: unknown;
  task_id_external?: unknown;
  model_id?: unknown;
  status?: unknown;
  error_message?: unknown;
  submission_error_code?: unknown;
  billing_state?: unknown;
  price_charged?: unknown;
  provider_result_url?: unknown;
  completed_at?: unknown;
  source_expired_at?: unknown;
  history_hidden_at?: unknown;
};

type StoryboardCardLike = Record<string, unknown> & {
  videoTaskId?: unknown;
  videoTaskModelId?: unknown;
  videoStatus?: unknown;
};

type StoryboardDocumentLike = Record<string, unknown> & {
  cards?: unknown;
};

const completedStatuses = new Set(["completed", "success", "succeeded", "ready"]);
const failedStatuses = new Set(["failed", "error", "failure", "terminated", "expired", "rejected"]);
const cancelledStatuses = new Set(["cancelled", "canceled"]);
const queuedStatuses = new Set(["queued", "pending", "waiting", "submitted", "created", "initializing"]);
const runningStatuses = new Set(["processing", "running", "generating", "in_progress", "trimming", "finalizing", "asset_persisting", "billing_pending"]);

function normalizedString(value: unknown) {
  return String(value || "").trim();
}

export function normalizeStoryboardVideoTaskStatus(status: unknown): StoryboardVideoStatus | null {
  const normalized = normalizedString(status).toLowerCase();
  if (completedStatuses.has(normalized)) return "done";
  if (failedStatuses.has(normalized)) return "failed";
  if (cancelledStatuses.has(normalized)) return "cancelled";
  if (queuedStatuses.has(normalized)) return "queued";
  if (runningStatuses.has(normalized)) return "running";
  return null;
}

function cardsOf(value: unknown): StoryboardCardLike[] {
  if (!value || typeof value !== "object") return [];
  const cards = (value as StoryboardDocumentLike).cards;
  return Array.isArray(cards)
    ? cards.filter((card): card is StoryboardCardLike => Boolean(card) && typeof card === "object")
    : [];
}

function sameTaskModel(card: StoryboardCardLike, task: StoryboardVideoTaskSnapshot) {
  const cardModelId = normalizedString(card.videoTaskModelId);
  const taskModelId = normalizedString(task.model_id);
  return Boolean(cardModelId && taskModelId)
    && (cardModelId === taskModelId || cardModelId === toPublicModelId("video", taskModelId));
}

export function findStoryboardVideoTask(
  card: StoryboardCardLike,
  tasks: readonly StoryboardVideoTaskSnapshot[],
): StoryboardVideoTaskSnapshot | undefined {
  const taskId = normalizedString(card.videoTaskId);
  if (!taskId) return undefined;
  return tasks.find((task) => normalizedString(task.id) === taskId)
    || tasks.find((task) => normalizedString(task.task_id_external) === taskId && sameTaskModel(card, task));
}

export function collectStoryboardVideoTaskIds(
  documents: readonly unknown[],
  options: { onlyActive?: boolean } = {},
) {
  const taskIds = new Set<string>();
  for (const document of documents) {
    for (const card of cardsOf(document)) {
      if (options.onlyActive && card.videoStatus !== "queued" && card.videoStatus !== "running") continue;
      const taskId = normalizedString(card.videoTaskId);
      if (taskId) taskIds.add(taskId);
    }
  }
  return [...taskIds];
}

function taskTimestamp(task: StoryboardVideoTaskSnapshot) {
  const timestamp = Date.parse(normalizedString(task.completed_at));
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function applyTaskMetadata(card: StoryboardCardLike, task: StoryboardVideoTaskSnapshot) {
  const billingState = normalizedString(task.billing_state);
  if (billingState) card.videoBillingState = billingState;
  const priceCharged = Number(task.price_charged);
  if (Number.isFinite(priceCharged) && priceCharged >= 0) card.videoPriceCharged = priceCharged;
  const lastCheckedAt = taskTimestamp(task);
  if (lastCheckedAt !== undefined) card.videoLastCheckedAt = lastCheckedAt;
}

function publicFailure(task: StoryboardVideoTaskSnapshot) {
  const status = normalizedString(task.status).toLowerCase();
  const code = normalizedString(task.submission_error_code);
  const localMessage = localVideoTaskFailureMessage(code);
  const retryCandidate = status === "expired" ? { ...task, status: "failed" } : task;
  const safelyRetryable = canRetryVideoHistoryTask(retryCandidate as Record<string, unknown>);
  if (status === "expired") {
    return { message: localMessage || "视频任务已过期，请重新生成", retryable: safelyRetryable };
  }
  const classified = classifyVideoProviderError(task.error_message || "视频生成失败");
  return {
    message: localMessage || classified.publicMessage,
    retryable: safelyRetryable && (code === "VIDEO_SUBMISSION_CONFIRMATION_EXPIRED" || !localMessage && classified.retryable),
  };
}

function applyTerminalState(
  card: StoryboardCardLike,
  task: StoryboardVideoTaskSnapshot,
  status: "done" | "failed" | "cancelled",
) {
  card.videoStatus = status;
  card.videoPollFailures = 0;
  delete card.videoLifecycle;
  delete card.videoLifecycleError;
  if (status === "done") {
    card.videoProgress = 100;
    card.videoRetryable = false;
    if (task.source_expired_at || task.history_hidden_at) {
      const message = task.source_expired_at ? "生成已成功，上游视频已确认失效；原任务和账务凭据保留" : "生成已成功，素材已从可见历史移除；原任务和账务凭据保留";
      card.videoStatusDetail = message;
      card.videoError = message;
      delete card.videoUrl;
      delete card.videoContentUrl;
      delete card.videoThumbnailUrl;
      return;
    }
    card.videoStatusDetail = "生成成功，播放地址正在同步";
    delete card.videoError;
    return;
  }
  delete card.videoProgress;
  if (status === "cancelled") {
    card.videoRetryable = true;
    card.videoStatusDetail = "视频任务已终止，可以重新生成";
    delete card.videoError;
    return;
  }
  const failure = publicFailure(task);
  card.videoRetryable = failure.retryable;
  card.videoError = failure.message;
  card.videoStatusDetail = failure.message;
}

/**
 * Return a response-only project snapshot reconciled with authoritative owned
 * video task rows. Raw provider diagnostics never enter the project document.
 */
export function reconcileStoryboardProjectVideoTasks<T>(
  input: T,
  tasks: readonly StoryboardVideoTaskSnapshot[],
): T {
  if (!input || typeof input !== "object") return input;
  const document = structuredClone(input) as T;
  for (const card of cardsOf(document)) {
    const task = findStoryboardVideoTask(card, tasks);
    if (!task) continue;
    const status = normalizeStoryboardVideoTaskStatus(task.status);
    if (!status) continue;
    applyTaskMetadata(card, task);
    if (status === "done" || status === "failed" || status === "cancelled") {
      applyTerminalState(card, task, status);
      continue;
    }
    card.videoStatus = status;
    card.videoStatusDetail = status === "queued" ? "视频任务正在排队" : "视频任务正在生成";
    delete card.videoError;
  }
  return document;
}

export function isStoryboardProjectActive(value: unknown) {
  return cardsOf(value).some((card) => card.imageStatus === "queued" || card.imageStatus === "running"
    || card.videoStatus === "queued" || card.videoStatus === "running");
}

export function isStoryboardProjectRecentBeijingDay(
  value: string | null | undefined,
  now: number | Date = Date.now(),
) {
  const timestamp = Date.parse(String(value || ""));
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs)) return false;
  const currentDay = Math.floor((nowMs + BEIJING_OFFSET_MS) / DAY_MS);
  const projectDay = Math.floor((timestamp + BEIJING_OFFSET_MS) / DAY_MS);
  const ageInCalendarDays = currentDay - projectDay;
  return ageInCalendarDays >= 0 && ageInCalendarDays <= 2;
}

export function shouldRetainStoryboardProject(
  document: unknown,
  submittedAt: string | null | undefined,
  now: number | Date = Date.now(),
) {
  // Project visibility must not expire a still-deliverable provider result.
  // Explicit user deletion and confirmed source expiry are separate controls.
  void submittedAt;
  void now;
  return Boolean(document && typeof document === "object");
}
