import "server-only";

import { assertAutodlH3SelfhostModelBinding } from "@/lib/autodl-h3-selfhost";
import {
  buildVideoCancellationTransport,
  confirmedVideoCancellation,
  supportsConfirmedVideoCancellation,
} from "@/lib/video-cancellation";
import { resolveProviderSecret } from "@/lib/provider-secret";
import {
  parseVideoRoutingSnapshot,
  resolveVideoRoutingCredential,
} from "@/lib/video-routing-snapshot";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const TASK_SELECT = "id,status,task_id_external,model_id,routing_snapshot,client_request_id";
const CLIENT_REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/u;

type JsonObject = Record<string, unknown>;

export type VideoCancellationResult = {
  statusCode: number;
  body: JsonObject;
};

/**
 * A cancellation POST can be accepted before the provider reaches its final
 * state.  When a later status poll observes the exact provider task as
 * cancelled, reconcile that evidence against an already-recorded user intent.
 * This function never creates an intent and never contacts a provider.
 */
export async function confirmObservedVideoTaskCancellation(input: {
  userId: string;
  clientRequestId: string;
  taskId: string;
  providerTaskId: string;
}): Promise<VideoCancellationResult | null> {
  const userId = String(input.userId || "").trim();
  const clientRequestId = String(input.clientRequestId || "").trim();
  const taskId = String(input.taskId || "").trim();
  const providerTaskId = String(input.providerTaskId || "").trim();
  if (!userId || !CLIENT_REQUEST_PATTERN.test(clientRequestId) || !taskId || !providerTaskId) return null;

  const db = getSupabaseAdminClient();
  const { data: intent, error: intentError } = await db
    .from("video_task_cancel_intents")
    .select("state")
    .eq("user_id", userId)
    .eq("client_request_id", clientRequestId)
    .eq("video_task_id", taskId)
    .maybeSingle();
  if (intentError) {
    return response(503, {
      success: false,
      taskId,
      status: "processing",
      error: "上游已回报终止，但本地终止意图暂时无法核对；系统不会把任务误记为失败",
      upstreamCancellationRequested: true,
    });
  }
  if (!intent || !["upstream_required", "upstream_confirmed"].includes(String(intent.state || ""))) return null;

  const { data: confirmationData, error: confirmationError } = await db.rpc(
    "confirm_video_task_upstream_cancellation_atomic",
    {
      p_user_id: userId,
      p_client_request_id: clientRequestId,
      p_task_id: taskId,
      p_provider_task_id: providerTaskId,
    },
  );
  if (confirmationError) {
    return response(503, {
      success: false,
      taskId,
      status: "processing",
      error: "上游已确认终止，但本地状态保存尚未完成；系统会继续核对原任务",
      upstreamCancellationRequested: true,
    });
  }
  const confirmation = objectValue(confirmationData);
  const confirmedStatus = String(confirmation.status || "");
  if (confirmedStatus !== "cancelled") {
    return response(409, {
      success: false,
      taskId,
      status: confirmedStatus || "processing",
      message: "任务状态已经变化，请以最新结果为准",
      upstreamCancellationRequested: true,
    });
  }
  return response(200, {
    success: true,
    taskId,
    status: "cancelled",
    message: "上游已确认终止，本地任务与费用预留已同步释放",
    upstreamCancellationRequested: true,
    upstreamDispatchDetected: true,
  });
}

function response(statusCode: number, body: JsonObject): VideoCancellationResult {
  return { statusCode, body };
}

function objectValue(value: unknown): JsonObject {
  if (Array.isArray(value)) return objectValue(value[0]);
  return value && typeof value === "object" ? value as JsonObject : {};
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Owner-scoped termination entry point shared by the browser route and the
 * submission path. The database first decides whether dispatch ever started;
 * a dispatched task can reach local `cancelled` only after the exact upstream
 * task id is returned in a terminal cancellation acknowledgement.
 */
export async function requestVideoTaskCancellation(input: {
  userId: string;
  taskId?: string;
  clientRequestId?: string;
}): Promise<VideoCancellationResult> {
  const userId = String(input.userId || "").trim();
  const requestedTaskId = String(input.taskId || "").trim();
  let clientRequestId = String(input.clientRequestId || "").trim();

  if (!userId) return response(401, { error: "登录状态无效" });
  if (requestedTaskId && !TASK_ID_PATTERN.test(requestedTaskId)) {
    return response(400, { error: "视频任务编号无效" });
  }
  if (clientRequestId && !CLIENT_REQUEST_PATTERN.test(clientRequestId)) {
    return response(400, { error: "视频请求编号无效" });
  }
  if (!requestedTaskId && !clientRequestId) {
    return response(400, { error: "缺少视频任务或请求编号" });
  }

  const supabase = getSupabaseAdminClient();
  let task: JsonObject | null = null;

  // Older cards may only know an internal/provider task id. Resolve the
  // immutable client request before creating the cancellation fence.
  if (!clientRequestId && requestedTaskId) {
    const { data: externalTasks, error: externalError } = await supabase
      .from("video_tasks")
      .select(TASK_SELECT)
      .eq("task_id_external", requestedTaskId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (externalError) return response(503, { error: "任务状态暂不可用，请稍后查询" });
    task = externalTasks?.[0] || null;
    if (!task) {
      const { data: internalTasks, error: internalError } = await supabase
        .from("video_tasks")
        .select(TASK_SELECT)
        .eq("id", requestedTaskId)
        .eq("user_id", userId)
        .limit(1);
      if (internalError) return response(503, { error: "任务状态暂不可用，请稍后查询" });
      task = internalTasks?.[0] || null;
    }
    if (!task) return response(404, { error: "未找到该任务" });
    clientRequestId = String(task.client_request_id || "").trim();
    if (!CLIENT_REQUEST_PATTERN.test(clientRequestId)) {
      return response(409, {
        success: false,
        taskId: requestedTaskId,
        status: String(task.status || ""),
        error: "旧任务缺少可核验的原请求编号，系统不会冒充终止；任务会继续追踪",
        upstreamCancellationRequested: false,
      });
    }
  }

  const { data: intentData, error: intentError } = await supabase.rpc(
    "request_video_task_cancellation_atomic",
    { p_user_id: userId, p_client_request_id: clientRequestId },
  );
  if (intentError) {
    return response(503, {
      success: false,
      taskId: requestedTaskId || null,
      status: "unknown",
      error: "暂时无法锁定原视频请求，系统不会冒充终止；请稍后重试",
      upstreamCancellationRequested: false,
    });
  }

  const intent = objectValue(intentData);
  const intentStatus = String(intent.status || "");
  const cancellationState = String(intent.cancellation_state || "");
  const upstreamRequired = intent.upstream_required === true;
  if (intentStatus === "cancelled" && cancellationState === "terminal_conflict") {
    return response(409, {
      success: false,
      taskId: String(intent.task_id || requestedTaskId || "") || null,
      status: "cancelled",
      message: "该历史任务只有本地取消状态，缺少上游终止回执；系统不会把它冒充为上游已取消",
      upstreamCancellationRequested: false,
    });
  }
  if (intentStatus === "cancelled" && !upstreamRequired) {
    return response(200, {
      success: true,
      taskId: String(intent.task_id || requestedTaskId || "") || null,
      status: "cancelled",
      message: cancellationState === "upstream_confirmed"
        ? "上游已确认终止，本地任务与费用预留已同步释放"
        : "任务已在上游投递前终止，本次未扣费",
      upstreamCancellationRequested: cancellationState === "upstream_confirmed",
      upstreamDispatchDetected: cancellationState === "upstream_confirmed",
    });
  }
  if (["completed", "failed", "expired", "finalizing"].includes(intentStatus)) {
    return response(409, {
      success: false,
      taskId: String(intent.task_id || requestedTaskId || "") || null,
      status: intentStatus,
      message: "任务正在完成结果保存或已经结束，请查看最新状态",
      upstreamCancellationRequested: false,
    });
  }

  const internalTaskId = String(intent.task_id || "").trim();
  if (!task || String(task.id || "") !== internalTaskId) {
    const { data: ownedTask, error: taskError } = await supabase
      .from("video_tasks")
      .select(TASK_SELECT)
      .eq("id", internalTaskId)
      .eq("user_id", userId)
      .maybeSingle();
    if (taskError) return response(503, { error: "任务状态暂不可用，请稍后查询" });
    task = ownedTask || null;
  }
  if (!task) {
    return response(202, {
      success: false,
      taskId: requestedTaskId || null,
      status: "unknown",
      error: "终止意图已登记，但原任务状态暂不可用，请稍后重试",
      upstreamCancellationRequested: false,
    });
  }

  const effectiveModelId = String(task.model_id || "");
  let routingSnapshot: ReturnType<typeof parseVideoRoutingSnapshot>;
  try {
    if (!effectiveModelId) throw new Error("VIDEO_ROUTING_MODEL_ID_MISSING");
    routingSnapshot = parseVideoRoutingSnapshot(task.routing_snapshot, effectiveModelId);
    assertAutodlH3SelfhostModelBinding({
      kind: "video",
      provider: routingSnapshot.provider,
      protocolType: routingSnapshot.protocolType,
      modelName: routingSnapshot.modelName,
      apiEndpoint: routingSnapshot.apiEndpoint,
      apiKey: routingSnapshot.credentialRef,
    });
  } catch {
    return response(409, {
      success: false,
      taskId: internalTaskId,
      status: String(task.status || ""),
      error: "原任务缺少可信的提交路由快照，系统不会切换通道取消；任务会继续追踪",
      upstreamCancellationRequested: false,
    });
  }

  if (!supportsConfirmedVideoCancellation(routingSnapshot.protocolType, routingSnapshot.apiProtocolConfig)) {
    return response(409, {
      success: false,
      taskId: internalTaskId,
      status: String(task.status || ""),
      error: "该视频渠道未提供可核验的上游终止接口；系统不会只改本地状态，原任务会继续追踪",
      upstreamCancellationRequested: false,
    });
  }

  const effectiveExternalId = String(intent.provider_task_id || task.task_id_external || "").trim();
  if (!effectiveExternalId) {
    return response(202, {
      success: false,
      taskId: internalTaskId,
      status: String(task.status || ""),
      message: "终止意图已登记，正在等待上游任务编号；系统仍会追踪原任务",
      upstreamCancellationRequested: false,
    });
  }

  let providerApiKey: string;
  try {
    providerApiKey = await resolveVideoRoutingCredential({
      snapshot: routingSnapshot,
      resolveSecret: resolveProviderSecret,
      lookupModelCredential: async (snapshotModelId) => {
        const { data: credentialRow, error: credentialError } = await supabase
          .from("video_models")
          .select("api_key")
          .eq("id", snapshotModelId)
          .maybeSingle();
        if (credentialError) throw credentialError;
        return credentialRow?.api_key;
      },
    });
  } catch {
    return response(503, {
      success: false,
      taskId: internalTaskId,
      status: String(task.status || ""),
      error: "原任务的渠道密钥引用暂不可用，系统不会切换通道取消；任务会继续追踪",
      upstreamCancellationRequested: false,
    });
  }

  let confirmed = false;
  try {
    const transport = buildVideoCancellationTransport({
      protocolType: routingSnapshot.protocolType,
      apiEndpoint: routingSnapshot.apiEndpoint,
      protocolConfig: routingSnapshot.apiProtocolConfig,
      taskId: effectiveExternalId,
    });
    const upstreamResponse = await fetch(transport.url, {
      method: transport.method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${providerApiKey}`,
        ...(transport.body ? { "Content-Type": "application/json" } : {}),
      },
      body: transport.body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!upstreamResponse.ok) {
      return response(502, {
        success: false,
        taskId: internalTaskId,
        status: String(task.status || ""),
        error: "上游拒绝终止请求，系统会继续追踪原任务",
        upstreamCancellationRequested: true,
      });
    }
    const acknowledgement = await upstreamResponse.json().catch(() => null);
    confirmed = confirmedVideoCancellation(acknowledgement, effectiveExternalId);
    if (!confirmed && transport.confirmationUrl) {
      for (let attempt = 0; attempt < 3 && !confirmed; attempt += 1) {
        if (attempt > 0) await wait(200);
        const confirmation = await fetch(transport.confirmationUrl, {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${providerApiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!confirmation.ok) continue;
        const state = await confirmation.json().catch(() => null);
        confirmed = confirmedVideoCancellation(state, effectiveExternalId);
      }
    }
  } catch {
    return response(202, {
      success: false,
      taskId: internalTaskId,
      status: String(task.status || ""),
      message: "终止结果暂未确认，系统会继续追踪原任务",
      upstreamCancellationRequested: true,
    });
  }

  if (!confirmed) {
    return response(202, {
      success: false,
      taskId: internalTaskId,
      status: String(task.status || ""),
      message: "终止请求已发送，但上游尚未返回该任务的终止状态；系统会继续追踪",
      upstreamCancellationRequested: true,
    });
  }

  const { data: confirmationData, error: confirmationError } = await supabase.rpc(
    "confirm_video_task_upstream_cancellation_atomic",
    {
      p_user_id: userId,
      p_client_request_id: clientRequestId,
      p_task_id: internalTaskId,
      p_provider_task_id: effectiveExternalId,
    },
  );
  if (confirmationError) {
    return response(503, {
      success: false,
      taskId: internalTaskId,
      status: String(task.status || ""),
      error: "上游已确认终止，但本地状态保存尚未完成，请继续查询原任务",
      upstreamCancellationRequested: true,
    });
  }
  const confirmation = objectValue(confirmationData);
  const confirmedStatus = String(confirmation.status || "");
  if (confirmedStatus !== "cancelled") {
    return response(409, {
      success: false,
      taskId: internalTaskId,
      status: confirmedStatus || String(task.status || ""),
      message: "任务状态已经变化，请以最新结果为准",
      upstreamCancellationRequested: true,
    });
  }
  return response(200, {
    success: true,
    taskId: internalTaskId,
    status: "cancelled",
    message: "上游已确认终止，本地任务与费用预留已同步释放",
    upstreamCancellationRequested: true,
    upstreamDispatchDetected: true,
  });
}

/** Continue a user-requested termination once an in-flight submission binds
 * its upstream task id. Merely checking this function never creates intent. */
export async function resumeRequestedVideoCancellation(input: {
  userId: string;
  clientRequestId: string;
  taskId?: string;
}): Promise<VideoCancellationResult | null> {
  const clientRequestId = String(input.clientRequestId || "").trim();
  if (!CLIENT_REQUEST_PATTERN.test(clientRequestId)) return null;
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("video_task_cancel_intents")
    .select("state")
    .eq("user_id", input.userId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (error || data?.state !== "upstream_required") return null;
  return requestVideoTaskCancellation({
    userId: input.userId,
    clientRequestId,
    taskId: input.taskId,
  });
}
