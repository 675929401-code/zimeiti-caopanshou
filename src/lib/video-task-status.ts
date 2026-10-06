import { digitalDispatchStatus } from '@/lib/digital-video-dispatch';
import { startDigitalVideoQueueWorker } from '@/lib/digital-video-queue-worker';
import { isCurrentDigitalHumanTask } from '@/lib/digital-human-task';
import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { pollVideoTask } from "@/lib/video-adapter";
import type { VideoModelConfig, VideoTaskResult } from "@/lib/video-adapter";
import { getProductionVideoModelById } from "@/lib/production-data-source";
import { findModelByPublicId } from "@/lib/public-model-dto";
import { classifyVideoProviderError, localVideoTaskFailureMessage } from "@/lib/video-error-policy";
import { recordVideoTerminalOutcome } from "@/lib/video-terminal-accounting";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import { canRetryVideoHistoryTask } from "@/lib/video-history-presentation";
import {
  assertAutodlH3SelfhostModelBinding,
} from "@/lib/autodl-h3-selfhost";
import {
  getAutodlH3VideoJobForUser,
  isAutodlH3LifecycleEnabled,
  type AutodlH3JobState,
} from "@/lib/autodl-h3-lifecycle";
import {
  finalizeVideoGenerationFailure,
  finalizeVideoGenerationSuccess,
  videoTerminalErrorResponse,
} from "@/lib/video-terminal-finalizer";
import { reconcileStaleVideoSubmissionsForUser } from "@/lib/video-submission-reconciliation";
import { confirmObservedVideoTaskCancellation } from "@/lib/video-cancellation-runtime";
import {
  parseVideoRoutingSnapshot,
  resolveVideoRoutingCredential,
  videoModelConfigFromRoutingSnapshot,
  type VideoRoutingSnapshot,
} from "@/lib/video-routing-snapshot";


// ── 模型配置缓存（避免每2秒轮询时重复查DB） ──
// 模型配置（api_endpoint, api_key, protocol_type等）基本不变，缓存60秒
const modelConfigCache = new Map<string, { config: VideoModelConfig; price_per_use: number; cost_price: number; name: string; cachedAt: number }>();
const MODEL_CONFIG_TTL = 60_000; // 60秒缓存

function normalizeProviderProgress(value: unknown) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const percent = raw > 0 && raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, percent));
}

function providerPollMessage(result: VideoTaskResult, modelName: string) {
  if (result.error) return classifyVideoProviderError(result.error, modelName).publicMessage;
  return result.status === "queued" ? "上游已回报：任务正在排队" : "上游已回报：视频正在生成";
}

async function persistProviderPollSnapshot(input: {
  supabase: ReturnType<typeof getSupabaseClient>;
  taskIdInternal: string;
  result: VideoTaskResult;
  modelName: string;
}) {
  const status = input.result.status === "queued" ? "queued" : "processing";
  const progress = normalizeProviderProgress(input.result.progress);
  const message = providerPollMessage(input.result, input.modelName);
  const lastSyncedAt = new Date().toISOString();
  const { error } = await input.supabase.from("video_tasks").update({
    status,
    provider_progress: progress,
    provider_status_message: message,
    provider_last_polled_at: lastSyncedAt,
    provider_poll_failures: 0,
  }).eq("id", input.taskIdInternal).in("status", ["pending", "queued", "processing", "generating"]);
  if (error) throw error;
  return { status, progress, message, lastSyncedAt };
}

const H3_LIFECYCLE_PRE_DISPATCH_STATES = new Set([
  "ACCEPTED",
  "WAITING_POWER",
  "WAITING_READY",
  "DISPATCHING",
  "RETRY_WAIT",
  "PERSISTING",
  "FINALIZING",
]);

function h3LifecycleStage(state: string) {
  switch (state) {
    case "ACCEPTED": return { status: "queued", stage: "accepted", message: "任务已登记，等待 GPU 调度" };
    case "WAITING_POWER": return { status: "queued", stage: "waiting_power", message: "正在启动 GPU 实例" };
    case "WAITING_READY": return { status: "queued", stage: "waiting_ready", message: "GPU 已启动，正在等待 H3 服务就绪" };
    case "DISPATCHING": return { status: "processing", stage: "dispatching", message: "H3 服务已就绪，正在安全派发任务" };
    case "RETRY_WAIT": return { status: "queued", stage: "retry_wait", message: "调度暂时中断，系统正继续核对同一任务编号" };
    case "RECOVERY_REQUIRED": return { status: "processing", stage: "recovery_required", message: "正在核对 H3 任务状态，不会重复提交" };
    case "RESULT_STAGING": return { status: "processing", stage: "result_staging", message: "模型已完成，正在接收结果" };
    case "PERSISTING": return { status: "processing", stage: "persisting", message: "正在写入稳定存储" };
    case "FINALIZING": return { status: "processing", stage: "finalizing", message: "正在完成结算与历史保存" };
    default: return { status: "processing", stage: "lifecycle", message: "H3 任务正在处理" };
  }
}

async function syncH3LifecycleProgress(input: {
  publicTaskId: string;
  userId: string;
  state: AutodlH3JobState;
  upstreamTaskId?: string | null;
  contentUrl?: string | null;
  resultAssetUrl?: string | null;
  progress?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  // Lifecycle H3 state is worker-owned and fencing-token protected. Status
  // polling is read-only; legacy providers continue through their old paths.
  void input;
}

async function reconcileObservedProviderCancellation(input: {
  task: Record<string, unknown>;
  publicTaskId: string;
  providerTaskId: string;
  userId: string;
}) {
  const result = await confirmObservedVideoTaskCancellation({
    userId: input.userId,
    clientRequestId: String(input.task.client_request_id || ""),
    taskId: String(input.task.id || ""),
    providerTaskId: input.providerTaskId,
  });
  if (!result) return null;
  if (result.statusCode === 200 && result.body.status === "cancelled") {
    await syncH3LifecycleProgress({
      publicTaskId: input.publicTaskId,
      userId: input.userId,
      state: "CANCELLED",
      upstreamTaskId: input.providerTaskId,
    });
    return NextResponse.json({
      taskId: input.publicTaskId,
      status: "cancelled",
      videoUrl: "",
      thumbnailUrl: "",
      errorMessage: "上游已确认终止，本地任务与费用预留已同步释放",
      priceCharged: 0,
      billingState: "failed",
      upstreamCancellationRequested: true,
    });
  }
  return NextResponse.json({
    ...result.body,
    taskId: input.publicTaskId,
    processingStage: "cancellation_reconciliation",
    videoUrl: "",
    thumbnailUrl: "",
    errorMessage: String(result.body.error || result.body.message || "终止状态正在核对"),
    priceCharged: 0,
  }, { status: result.statusCode });
}

async function claimTaskFinalization(
  supabase: ReturnType<typeof getSupabaseClient>,
  taskIdInternal: string,
) {
  const { data, error } = await supabase
    .from("video_tasks")
    .update({ status: "finalizing" })
    .eq("id", taskIdInternal)
    // A previous finalization attempt may have moved the row to `finalizing`
    // before the atomic failure RPC temporarily failed.  Re-claiming that
    // state lets polling finish the same task instead of leaving it stuck
    // forever.  The terminal RPC is itself idempotent and row-locked.
    .in("status", ["pending", "queued", "processing", "finalizing"])
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

function finalizationInProgress(taskId: string) {
  return NextResponse.json({
    taskId,
    status: "processing",
    processingStage: "finalizing",
    providerCompleted: true,
    videoUrl: "",
    storageUrl: "",
    thumbnailUrl: "",
    errorMessage: "视频已生成，正在完成结算与历史保存",
    priceCharged: 0,
  });
}

async function finalizeVideoStatusSuccess(input: {
  existingTask: Record<string, unknown> | null;
  taskId: string;
  videoUrl: string;
  userId: string;
  userRole: "admin" | "student";
  requestStartedAt: number;
  upstreamTaskId: string;
}) {
  const taskIdInternal = String(input.existingTask?.id || "");
  if (!taskIdInternal) {
    return NextResponse.json({
      taskId: input.taskId,
      status: "failed",
      videoUrl: "",
      storageUrl: "",
      errorMessage: "视频任务缺少提交前的确定性业务记录，禁止结算与交付",
      errorCode: "VIDEO_RESERVATION_REQUIRED",
      retryable: false,
      priceCharged: 0,
    }, { status: 503 });
  }

  const outcome = await finalizeVideoGenerationSuccess({
    taskIdInternal,
    userId: input.userId,
    userRole: input.userRole,
    providerTaskId: input.upstreamTaskId || input.taskId,
    providerVideoUrl: input.videoUrl || undefined,
    responseMs: Date.now() - input.requestStartedAt,
  });

  if (outcome.state !== "completed") {
    return NextResponse.json({
      taskId: input.taskId,
      status: outcome.state === "billing_pending" ? "billing_pending" : "processing",
      processingStage: outcome.state === "billing_pending" ? "billing" : "finalizing",
      providerCompleted: true,
      videoUrl: "",
      storageUrl: "",
      thumbnailUrl: "",
      errorMessage: outcome.message || "视频正在完成永久存储与原子结算",
      errorCode: outcome.code,
      retryable: true,
      priceCharged: 0,
    }, { status: outcome.code === "BILLING_DEDUCTION_FAILED" ? 503 : 202 });
  }

  return NextResponse.json({
    taskId: input.taskId,
    status: "completed",
    processingStage: "ready",
    providerCompleted: true,
    videoUrl: outcome.playbackUrl || "",
    storageUrl: "",
    thumbnailUrl: "",
    errorMessage: "",
    priceCharged: outcome.priceCharged,
    billingState: outcome.billingState,
    needsProxy: false,
    temporaryPlayback: false,
    trimRequired: false,
  });
}

async function readLocalVideoTaskSnapshot(input: {
  task: Record<string, unknown>;
  taskId: string;
  userId: string;
  userRole: "admin" | "student";
}) {
  const status = String(input.task.status || "pending");
  const taskIdInternal = String(input.task.id || "");
  const priceCharged = Number(input.task.price_charged || 0);
  if (status === "completed") {
    return NextResponse.json({
      taskId: input.taskId,
      status: "completed",
      processingStage: "ready",
      providerCompleted: true,
      videoUrl: await createVideoAccessUrl({
        taskId: taskIdInternal,
        userId: input.userId,
        role: input.userRole,
        scope: "playback",
      }),
      storageUrl: "",
      thumbnailUrl: "",
      errorMessage: "",
      priceCharged,
      billingState: String(input.task.billing_state || "settled"),
      needsProxy: false,
      temporaryPlayback: false,
      trimRequired: false,
    });
  }
  if (status === "failed" || status === "expired" || status === "cancelled") {
    const failed = status === "expired" ? "failed" : status;
    const classified = classifyVideoProviderError(input.task.error_message || "生成失败");
    const localFailure = localVideoTaskFailureMessage(input.task.submission_error_code);
    return NextResponse.json({
      taskId: input.taskId,
      status: failed,
      videoUrl: "",
      thumbnailUrl: "",
      errorMessage: status === "cancelled"
        ? String(input.task.error_message || "任务已由用户终止")
        : status === "expired"
          ? String(input.task.error_message || "任务已过期，请重新生成")
          : localFailure || classified.publicMessage,
      errorCode: String(input.task.submission_error_code || classified.code),
      retryable: status === "failed" && !localFailure && canRetryVideoHistoryTask(input.task),
      priceCharged: status === "cancelled" ? 0 : priceCharged,
      billingState: String(input.task.billing_state || ""),
    });
  }
  const processingStage = status === "finalizing" || status === "billing_pending"
    ? status
    : status === "queued"
      ? "queued"
      : status === "pending" && input.task.submission_error_code === "VIDEO_SUBMIT_OUTCOME_UNKNOWN"
        ? "confirming_submission"
        : "processing";
  const progress = normalizeProviderProgress(input.task.provider_progress);
  const startedAt = String(input.task.created_at || "");
  const lastSyncedAt = String(input.task.provider_last_polled_at || "");
  const startedMs = Date.parse(startedAt);
  const lastSyncedMs = Date.parse(lastSyncedAt);
  const elapsedSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : null;
  const lastSyncAgeSeconds = Number.isFinite(lastSyncedMs) ? Math.max(0, Math.floor((Date.now() - lastSyncedMs) / 1000)) : null;
  const providerMessage = String(input.task.provider_status_message || "");
  const statusMessage = processingStage === "confirming_submission"
    ? "上游提交结果待确认，请保留原任务，暂不要重复生成"
    : status === "finalizing"
      ? "视频已生成，正在完成结算与历史保存"
      : status === "billing_pending"
        ? "视频已生成，正在完成原子结算"
        : providerMessage || (lastSyncedAt
          ? "上游任务仍在处理中，系统会继续查询原任务"
          : "任务已受理，等待上游首次状态回报");
  return NextResponse.json({
    taskId: input.taskId,
    status: status === "billing_pending" ? "billing_pending" : status === "finalizing" ? "processing" : status,
    processingStage,
    providerCompleted: status === "finalizing" || status === "billing_pending",
    progress,
    videoUrl: "",
    thumbnailUrl: "",
    message: statusMessage,
    errorMessage: statusMessage,
    errorCode: processingStage === "confirming_submission" ? "VIDEO_SUBMIT_OUTCOME_UNKNOWN" : undefined,
    retryable: false,
    priceCharged: 0,
    billingState: String(input.task.billing_state || ""),
    startedAt: startedAt || undefined,
    lastSyncedAt: lastSyncedAt || undefined,
    elapsedSeconds,
    lastSyncAgeSeconds,
    providerPollFailures: Math.max(0, Number(input.task.provider_poll_failures) || 0),
  }, { status: processingStage === "confirming_submission" ? 202 : 200 });
}

// GET /api/video/status?taskId=xxx&modelId=xxx&contentUrl=xxx&prompt=xxx
// 浏览器读取本地快照；只有独立媒体 worker 可以把 advanceProvider 设为 true。
async function resolveOwnedVideoTaskStatus(payload: { userId: string; role: 'admin' | 'student' }, searchParams: URLSearchParams, advanceProvider: boolean) {
  const requestStartedAt = Date.now();
  let providerPollFailureContext: {
    supabase: ReturnType<typeof getSupabaseClient>;
    taskIdInternal: string;
    priorFailures: number;
  } | null = null;
  try {
    const userId = payload.userId;
    const userRole = payload.role;
    const taskId = searchParams.get("taskId");       // 外部task_id
    const modelId = searchParams.get("modelId");     // 模型ID
    let contentUrl = searchParams.get("contentUrl") || "";  // 轮询URL
    if (!taskId) {
      return NextResponse.json({ error: "缺少taskId" }, { status: 400 });
    }

    if (!modelId) {
      return NextResponse.json({ error: "缺少modelId" }, { status: 400 });
    }

    // 公开 taskId 是本地业务任务 ID，不是 H3 网关 ID。必须先查生命周期队列；
    // 只有 worker 已记录 upstreamTaskId 后，才允许进入旧的轮询/COS/结算链路。
    const isLifecyclePublicTaskId = /^h3q_[a-f0-9]+$/u.test(taskId);
    let lifecycleJob: Awaited<ReturnType<typeof getAutodlH3VideoJobForUser>> = null;
    if (isLifecyclePublicTaskId) {
      if (!isAutodlH3LifecycleEnabled()) {
        return NextResponse.json({
          error: "H3 生命周期调度当前未启用，系统不会把业务编号当作上游编号轮询",
          errorCode: "H3_LIFECYCLE_DISABLED",
          retryable: true,
        }, { status: 503 });
      }
      try {
        lifecycleJob = await getAutodlH3VideoJobForUser({ publicTaskId: taskId, userId });
      } catch {
        return NextResponse.json({
          error: "H3 任务状态库暂时不可用，系统已停止直接轮询以避免重复任务",
          errorCode: "H3_LIFECYCLE_STORE_UNAVAILABLE",
          retryable: true,
        }, { status: 503 });
      }
      if (!lifecycleJob) {
        return NextResponse.json({
          error: "H3 任务调度记录暂时不可见，系统不会把业务编号当作上游编号轮询",
          errorCode: "H3_LIFECYCLE_JOB_NOT_VISIBLE",
          retryable: true,
        }, { status: 503 });
      }
    }
    const lifecycleState = String(lifecycleJob?.state || "");
    if (lifecycleJob && lifecycleState === "FAILED_TERMINAL") {
      return NextResponse.json({
        taskId,
        status: "failed",
        lifecycleState,
        videoUrl: "",
        thumbnailUrl: "",
        errorMessage: "H3 任务未能完成，请重新生成",
        errorCode: String(lifecycleJob.errorCode || "H3_LIFECYCLE_FAILED"),
        retryable: false,
        priceCharged: 0,
      });
    }
    if (lifecycleJob && lifecycleState === "CANCELLED") {
      return NextResponse.json({
        taskId,
        status: "cancelled",
        lifecycleState,
        videoUrl: "",
        thumbnailUrl: "",
        errorMessage: "任务已取消",
        priceCharged: 0,
      });
    }
    if (lifecycleJob && (H3_LIFECYCLE_PRE_DISPATCH_STATES.has(lifecycleState) || !lifecycleJob.upstreamTaskId)) {
      const mapped = h3LifecycleStage(lifecycleState);
      return NextResponse.json({
        taskId,
        status: mapped.status,
        lifecycleState,
        processingStage: mapped.stage,
        progress: Number(lifecycleJob.progress) || 0,
        providerCompleted: ["RESULT_STAGING", "PERSISTING", "FINALIZING"].includes(lifecycleState),
        videoUrl: "",
        thumbnailUrl: "",
        errorMessage: mapped.message,
        priceCharged: 0,
      });
    }
    let providerTaskId = String(lifecycleJob?.upstreamTaskId || taskId);

    // 先查DB是否已有此任务的记录（可能是之前轮询成功写入的）
    // 使用 maybeSingle 避免重复记录导致 .single() 报错
    const supabase = getSupabaseClient();
    await reconcileStaleVideoSubmissionsForUser({ userId, supabase });
    const { data: existingTasks, error: taskLookupError } = await supabase
      .from("video_tasks")
      .select("*")
      .eq("task_id_external", taskId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (taskLookupError) return NextResponse.json({error:'任务状态暂时无法读取，请稍后重试'},{status:503});
    let existingTask = existingTasks?.[0] || null;
    if (!existingTask && /^vt_[a-f0-9]{40}$/u.test(taskId)) {
      const { data, error } = await supabase.from("video_tasks").select("*").eq("id", taskId).eq("user_id", userId).maybeSingle();
      if (error) return NextResponse.json({error:'任务状态暂时无法读取，请稍后重试'},{status:503});
      existingTask = data;
    }
    // Ownership must be established before any provider lookup, including legacy task IDs.
    if (!existingTask) return NextResponse.json({error:'视频任务不存在'},{status:404});
    contentUrl = String(existingTask.content_url || '');
    providerTaskId = String(existingTask.task_id_external || providerTaskId);
    if (existingTask?.submission_error_code === "VIDEO_SUBMIT_OUTCOME_UNKNOWN" && !existingTask.task_id_external) {
      return NextResponse.json({ taskId, status: "pending", progress: null, processingStage: "confirming_submission",
        message: "上游提交结果待确认，请保留原任务，暂不要重复生成", errorCode: "VIDEO_SUBMIT_OUTCOME_UNKNOWN", retryable: false });
    }
    if (String(existingTask?.task_label || "").startsWith("digital-human:") && !isCurrentDigitalHumanTask(existingTask)) {
      return NextResponse.json(
        {
          error: "该历史任务对应的功能已下线",
          code: "FEATURE_RETIRED",
        },
        { status: 410 },
      );
    }
    if (!advanceProvider) {
      return readLocalVideoTaskSnapshot({
        task: existingTask as Record<string, unknown>,
        taskId,
        userId,
        userRole,
      });
    }
    // The browser receives an opaque public model ID. The task row keeps the
    // internal model ID required by the provider and is already ownership-scoped.
    let resolvedModelId = String(existingTask?.model_id || modelId);
    if (!existingTask && resolvedModelId.startsWith("pm_")) {
      const { data: activeModels } = await supabase
        .from("video_models")
        .select("*")
        .eq("is_active", true)
        .eq("is_hidden", false);
      const matched = findModelByPublicId(
        "video",
        (activeModels || []) as Array<Record<string, unknown> & { id?: unknown }>,
        resolvedModelId,
      );
      if (!matched?.id) return NextResponse.json({ error: "视频模型不存在或已停用" }, { status: 404 });
      resolvedModelId = String(matched.id);
    }

    if (existingTask?.status === "completed") {
      return finalizeVideoStatusSuccess({
        existingTask,
        taskId,
        videoUrl: String(existingTask.provider_result_url || existingTask.video_url || ""),
        userId,
        userRole,
        requestStartedAt,
        upstreamTaskId: providerTaskId,
      });
    }

    // Once a provider result or a stable asset has been saved, recovery must
    // continue from our durable checkpoint.  Polling the provider again here
    // can strand a valid result whenever its status endpoint is temporarily
    // unavailable or has already expired the task.
    if (
      ["finalizing", "billing_pending"].includes(String(existingTask?.status || ""))
      && (existingTask?.storage_url || existingTask?.provider_result_url || existingTask?.video_url)
    ) {
      return finalizeVideoStatusSuccess({
        existingTask,
        taskId,
        videoUrl: String(existingTask.provider_result_url || existingTask.video_url || ""),
        userId,
        userRole,
        requestStartedAt,
        upstreamTaskId: providerTaskId,
      });
    }

    if (existingTask?.status === "cancelled") {
      return NextResponse.json({
        taskId,
        status: "cancelled",
        videoUrl: "",
        thumbnailUrl: "",
        errorMessage: existingTask.error_message || "任务已由用户终止",
        priceCharged: 0,
      });
    }

    if (existingTask?.status === "expired") {
      return NextResponse.json({
        taskId,
        status: "failed",
        videoUrl: "",
        thumbnailUrl: "",
        errorMessage: existingTask.error_message || "任务已过期，请重新生成",
        priceCharged: 0,
      });
    }

    // 状态严格跟随上游平台：上游说失败才失败，上游说成功才成功。
    if (existingTask?.status === "failed") {
      const existingFailure = classifyVideoProviderError(existingTask.error_message || "生成失败");
      const localFailure=localVideoTaskFailureMessage(existingTask.submission_error_code);
      if (!existingTask.task_id_external && existingTask.billing_state === "submission_failed") {
        return NextResponse.json({
          taskId,
          status: "failed",
          videoUrl: "",
          thumbnailUrl: "",
          errorMessage: localFailure || existingTask.error_message || existingFailure.publicMessage,
          errorCode: String(existingTask.submission_error_code || existingFailure.code),
          retryable: localFailure ? false : existingFailure.retryable,
          priceCharged: 0,
          billingState: "submission_failed",
        });
      }
      const settledFailure = await finalizeVideoGenerationFailure({
        taskIdInternal: String(existingTask.id),
        userId,
        providerTaskId,
        errorCode: String(existingTask.submission_error_code || existingFailure.code),
        errorMessage: String(existingTask.error_message || existingFailure.publicMessage),
      });
      return NextResponse.json({
        taskId,
        status: "failed",
        videoUrl: "",
        thumbnailUrl: "",
        errorMessage: localFailure || existingFailure.publicMessage,
        errorCode: localFailure ? existingTask.submission_error_code : existingFailure.code,
        retryable: localFailure ? false : existingFailure.retryable,
        priceCharged: settledFailure.priceCharged,
        billingState: settledFailure.billingState,
      });
    }

    if (String(existingTask?.task_label || '').startsWith('digital-human:')) {
      const queued = await digitalDispatchStatus(existingTask.id, userId);
      if (queued) {
        startDigitalVideoQueueWorker();
        return NextResponse.json({taskId,status:queued.state==='queued'?'queued':queued.state==='submission_unknown'?'pending':queued.state==='finalizing'?'finalizing':'processing',
          processingStage:queued.state,queuePosition:queued.position,progress:null,errorMessage:queued.message,priceCharged:0,videoUrl:''});
      }
    }
    if (!existingTask.task_id_external) return NextResponse.json({taskId,status:'pending',progress:null,
      processingStage:'confirming_submission',errorMessage:'正在确认原任务，请勿重复生成',priceCharged:0,videoUrl:''},{status:202});
    // New tasks carry an immutable non-secret provider route. Model catalog
    // edits may rotate the credential reference, but can never move an
    // already accepted task to another endpoint, protocol, or model name.
    let taskRoutingSnapshot: VideoRoutingSnapshot | null = null;
    let taskRoutingConfig: { config: VideoModelConfig; price_per_use: number; cost_price: number; name: string; cachedAt: number } | null = null;
    if (existingTask.routing_snapshot) {
      try {
        taskRoutingSnapshot = parseVideoRoutingSnapshot(existingTask.routing_snapshot, resolvedModelId);
        const providerApiKey = await resolveVideoRoutingCredential({
          snapshot: taskRoutingSnapshot,
          resolveSecret: resolveProviderSecret,
          lookupModelCredential: async (snapshotModelId) => {
            const { data: credentialRow, error: credentialError } = await supabase
              .from("video_models")
              .select("api_key")
              .eq("id", snapshotModelId)
              .maybeSingle();
            if (credentialError) throw credentialError;
            if (credentialRow?.api_key) return credentialRow.api_key;
            const fallback = await getProductionVideoModelById(snapshotModelId);
            return fallback?.api_key;
          },
        });
        taskRoutingConfig = {
          config: videoModelConfigFromRoutingSnapshot(taskRoutingSnapshot, providerApiKey),
          price_per_use: 0,
          cost_price: 0,
          name: taskRoutingSnapshot.displayName,
          cachedAt: Date.now(),
        };
      } catch (routingError) {
        console.error("[VideoStatus] Immutable routing snapshot unavailable", {
          taskId: String(existingTask.id || ""),
          modelId: resolvedModelId,
          error: routingError instanceof Error ? routingError.message : "VIDEO_ROUTING_SNAPSHOT_UNAVAILABLE",
        });
        return NextResponse.json({
          taskId,
          status: "processing",
          processingStage: "routing_reconciliation",
          videoUrl: "",
          errorMessage: "原任务的供应商路由正在核对，系统不会切换通道或重复提交",
          errorCode: "VIDEO_ROUTING_SNAPSHOT_UNAVAILABLE",
          retryable: false,
          priceCharged: 0,
        }, { status: 503 });
      }
    }

    // Legacy tasks created before the routing migration retain the old
    // catalog/cache fallback. Snapshot-backed tasks never enter that path.
    const cachedModel = taskRoutingConfig || modelConfigCache.get(resolvedModelId);
    let model: Record<string, unknown> | null = null;

    if (cachedModel && (taskRoutingSnapshot || Date.now() - cachedModel.cachedAt < MODEL_CONFIG_TTL)) {
      // 命中缓存 → 直接使用，跳过DB查询
      const config = cachedModel.config;
      const modelName = cachedModel.name;

      // 轮询外部API
      providerPollFailureContext = {
        supabase,
        taskIdInternal: String(existingTask.id),
        priorFailures: Math.max(0, Number(existingTask.provider_poll_failures) || 0),
      };
      const result = await pollVideoTask(config, providerTaskId, contentUrl);

      if (result.status === "success" && result.videoUrl) {
        return finalizeVideoStatusSuccess({
          existingTask,
          taskId,
          videoUrl: result.videoUrl,
          userId,
          userRole,
          requestStartedAt,
          upstreamTaskId: providerTaskId,
        });
      }

      if (result.terminalState === "cancelled") {
        const cancellation = await reconcileObservedProviderCancellation({
          task: existingTask,
          publicTaskId: taskId,
          providerTaskId,
          userId,
        });
        if (cancellation) return cancellation;
      }

      if (result.status === "failed" || result.status === "success") {
        // ❌ 生成失败
        if (existingTask && !await claimTaskFinalization(supabase, existingTask.id)) {
          return finalizationInProgress(taskId);
        }
        const providerError = result.status === "success"
          ? "上游回报成功但未返回可用视频地址"
          : result.error;
        const classifiedError = classifyVideoProviderError(providerError, modelName);
        await syncH3LifecycleProgress({
          publicTaskId: taskId,
          userId,
          state: "FAILED_TERMINAL",
          upstreamTaskId: providerTaskId,
          errorCode: classifiedError.code,
          errorMessage: classifiedError.operatorMessage,
        });
        console.error("[Video/ProviderDiagnostic] polling failed", {
          taskId,
          modelId: resolvedModelId,
          code: classifiedError.code,
          category: classifiedError.category,
          rawError: classifiedError.operatorMessage,
        });
        const settledFailure = existingTask ? await finalizeVideoGenerationFailure({
          taskIdInternal: String(existingTask.id),
          userId,
          providerTaskId,
          errorCode: classifiedError.code,
          errorMessage: classifiedError.publicMessage,
        }) : null;

        if (existingTask && !settledFailure?.alreadyFailed) {
          await recordVideoTerminalOutcome({
            modelId: resolvedModelId,
            outcome: "fail",
            responseMs: Date.now() - requestStartedAt,
            errorMessage: classifiedError.operatorMessage,
          }).catch((error) => console.warn("[Video/Accounting] Failed to record status failure", error));
        }

        return NextResponse.json({
          taskId,
          status: "failed",
          videoUrl: "",
          thumbnailUrl: "",
          errorMessage: classifiedError.publicMessage,
          errorCode: classifiedError.code,
          retryable: classifiedError.retryable,
          priceCharged: settledFailure?.priceCharged || 0,
          billingState: settledFailure?.billingState || "failed",
        });
      }

      // 仍在处理中 — 持久化上游真实进度，刷新页面后继续显示同一任务。
      const providerSnapshot = await persistProviderPollSnapshot({
        supabase,
        taskIdInternal: String(existingTask.id),
        result,
        modelName,
      });
      const newStatus = providerSnapshot.status;
      await syncH3LifecycleProgress({
        publicTaskId: taskId,
        userId,
        state: result.status === "queued" ? "QUEUED" : "RUNNING",
        upstreamTaskId: providerTaskId,
        progress: typeof result.progress === "number" ? result.progress : undefined,
      });
      return NextResponse.json({
        taskId,
        status: newStatus,
        videoUrl: "",
        thumbnailUrl: "",
        message: providerSnapshot.message,
        errorMessage: providerSnapshot.message,
        progress: providerSnapshot.progress,
        lastSyncedAt: providerSnapshot.lastSyncedAt,
        priceCharged: 0,
      });
    }

    // 未命中缓存 → 从DB查询并缓存
    const { data: modelData } = await supabase
      .from("video_models")
      .select("*")
      .eq("id", resolvedModelId)
      .single();

    model = (modelData || await getProductionVideoModelById(resolvedModelId)) as Record<string, unknown> | null;

    let providerApiKey = "";
    try {
      assertAutodlH3SelfhostModelBinding({
        kind: "video",
        provider: model?.provider,
        protocolType: model?.protocol_type,
        modelName: model?.model_name,
        apiEndpoint: model?.api_endpoint,
        apiKey: model?.api_key,
      });
      providerApiKey = resolveProviderSecret(model?.api_key);
    } catch (secretError) {
      console.error("[VideoStatus] Provider credential unavailable", secretError instanceof Error ? secretError.message : "Unknown secret error");
    }

    if (!model?.api_endpoint || !providerApiKey) {
      return NextResponse.json({ error: "模型配置不完整" }, { status: 500 });
    }

    const config: VideoModelConfig = {
      id: model.id as string,
      name: model.name as string,
      provider: (model.provider as string) || "",
      api_endpoint: model.api_endpoint as string,
      api_key: providerApiKey,
      protocol_type: (model.protocol_type as string) || "openai_compatible",
      price_per_use: Number(model.price_per_use) || 0,
      duration_seconds: (model.duration_seconds as number) || 5,
      supports_image_input: (model.supports_image_input as boolean) || false,
      model_name: (model.model_name as string) || (model.id as string),
      api_protocol_config: (model.api_protocol_config as Record<string, unknown> | undefined) || undefined,
    };

    // 写入缓存
    modelConfigCache.set(resolvedModelId, {
      config,
      price_per_use: Number(model.price_per_use) || 0,
      cost_price: Number(model.cost_price) || 0,
      name: model.name as string,
      cachedAt: Date.now(),
    });

    // 轮询外部API
    providerPollFailureContext = {
      supabase,
      taskIdInternal: String(existingTask.id),
      priorFailures: Math.max(0, Number(existingTask.provider_poll_failures) || 0),
    };
    const result = await pollVideoTask(config, providerTaskId, contentUrl);

    if (result.status === "success" && result.videoUrl) {
      return finalizeVideoStatusSuccess({
        existingTask,
        taskId,
        videoUrl: result.videoUrl,
        userId,
        userRole,
        requestStartedAt,
        upstreamTaskId: providerTaskId,
      });
    }

    if (result.terminalState === "cancelled") {
      const cancellation = await reconcileObservedProviderCancellation({
        task: existingTask,
        publicTaskId: taskId,
        providerTaskId,
        userId,
      });
      if (cancellation) return cancellation;
    }

    if (result.status === "failed" || result.status === "success") {
      // ❌ 生成失败 — 更新已有 pending 记录为 failed
      if (existingTask && !await claimTaskFinalization(supabase, existingTask.id)) {
        return finalizationInProgress(taskId);
      }
      const providerError = result.status === "success"
        ? "上游回报成功但未返回可用视频地址"
        : result.error;
      const classifiedError = classifyVideoProviderError(providerError, String(model.name || "所选视频模型"));
      await syncH3LifecycleProgress({
        publicTaskId: taskId,
        userId,
        state: "FAILED_TERMINAL",
        upstreamTaskId: providerTaskId,
        errorCode: classifiedError.code,
        errorMessage: classifiedError.operatorMessage,
      });
      console.error("[Video/ProviderDiagnostic] polling failed", {
        taskId,
        modelId: resolvedModelId,
        code: classifiedError.code,
        category: classifiedError.category,
        rawError: classifiedError.operatorMessage,
      });
      const settledFailure = existingTask ? await finalizeVideoGenerationFailure({
        taskIdInternal: String(existingTask.id),
        userId,
        providerTaskId,
        errorCode: classifiedError.code,
        errorMessage: classifiedError.publicMessage,
      }) : null;

      if (existingTask && !settledFailure?.alreadyFailed) {
        await recordVideoTerminalOutcome({
          modelId: resolvedModelId,
          outcome: "fail",
          responseMs: Date.now() - requestStartedAt,
          errorMessage: classifiedError.operatorMessage,
        }).catch((error) => console.warn("[Video/Accounting] Failed to record status failure", error));
      }

      return NextResponse.json({
        taskId,
        status: "failed",
        videoUrl: "",
        thumbnailUrl: "",
        errorMessage: classifiedError.publicMessage,
        errorCode: classifiedError.code,
        retryable: classifiedError.retryable,
        priceCharged: settledFailure?.priceCharged || 0,
        billingState: settledFailure?.billingState || "failed",
      });
    }

    // 仍在处理中 — 持久化上游真实进度，刷新页面后继续显示同一任务。
    const providerSnapshot = await persistProviderPollSnapshot({
      supabase,
      taskIdInternal: String(existingTask.id),
      result,
      modelName: String(model.name || "所选视频模型"),
    });
    const newStatus = providerSnapshot.status;
    await syncH3LifecycleProgress({
      publicTaskId: taskId,
      userId,
      state: result.status === "queued" ? "QUEUED" : "RUNNING",
      upstreamTaskId: providerTaskId,
      progress: typeof result.progress === "number" ? result.progress : undefined,
    });
    return NextResponse.json({
      taskId,
      status: newStatus,
      videoUrl: "",
      thumbnailUrl: "",
      message: providerSnapshot.message,
      errorMessage: providerSnapshot.message,
      progress: providerSnapshot.progress,
      lastSyncedAt: providerSnapshot.lastSyncedAt,
      priceCharged: 0,
    });
  } catch (err) {
    const terminalError = videoTerminalErrorResponse(err);
    if (terminalError) {
      return NextResponse.json({
        ...terminalError.body,
        errorCode: terminalError.body.error_code,
        videoUrl: "",
        storageUrl: "",
        priceCharged: 0,
      }, { status: terminalError.status });
    }
    const classifiedError = classifyVideoProviderError(err instanceof Error ? err.message : String(err));
    if (advanceProvider && providerPollFailureContext) {
      const context = providerPollFailureContext;
      await context.supabase.from("video_tasks").update({
        provider_last_polled_at: new Date().toISOString(),
        provider_poll_failures: context.priorFailures + 1,
        provider_status_message: "上游状态回报暂时中断，系统仍在后台跟踪原任务",
      }).eq("id", context.taskIdInternal).in("status", ["pending", "queued", "processing", "generating"])
        .then(() => undefined, () => undefined);
    }
    console.error("[Video/ProviderDiagnostic] status route failed", {
      code: classifiedError.code,
      category: classifiedError.category,
      rawError: classifiedError.operatorMessage,
    });
    return NextResponse.json({
      error: classifiedError.publicMessage,
      errorCode: classifiedError.code,
      retryable: classifiedError.retryable,
    }, { status: 500 });
  }
}

export async function readOwnedVideoTaskStatus(
  payload: { userId: string; role: "admin" | "student" },
  searchParams: URLSearchParams,
) {
  return resolveOwnedVideoTaskStatus(payload, searchParams, false);
}

export async function refreshOwnedVideoTaskStatus(
  payload: { userId: string; role: "admin" | "student" },
  searchParams: URLSearchParams,
) {
  return resolveOwnedVideoTaskStatus(payload, searchParams, true);
}
