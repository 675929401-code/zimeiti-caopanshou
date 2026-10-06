import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  AUTODL_H3_INSTANCE_STATES,
  getAutodlH3VideoJobForUser,
  type AutodlH3InstanceState,
  type AutodlH3Job,
  type AutodlH3JobState,
} from "@/lib/autodl-h3-lifecycle";

export type AutodlH3LifecycleTone = "muted" | "info" | "active" | "success" | "warning" | "danger";

export interface AutodlH3LifecycleView {
  taskId: string;
  taskState: AutodlH3JobState;
  taskLabel: string;
  instanceState: AutodlH3InstanceState;
  instanceLabel: string;
  headline: string;
  detail: string;
  tone: AutodlH3LifecycleTone;
  progress: number | null;
  idleGraceSeconds: number;
  idleRemainingSeconds: number | null;
  taskTerminal: boolean;
  monitorComplete: boolean;
  observedAt: string;
}

export interface AutodlH3InstanceObservation {
  lifecycleState: AutodlH3InstanceState;
  idleSince: string | null;
  stateChangedAt: string | null;
  updatedAt: string | null;
}

type TaskPresentation = {
  label: string;
  detail: string;
  tone: AutodlH3LifecycleTone;
  terminal: boolean;
};

type InstancePresentation = {
  label: string;
  detail: string;
  tone: AutodlH3LifecycleTone;
};

const POWERING_ON_INSTANCE_STATES = new Set<AutodlH3InstanceState>([
  "START_REQUESTED",
  "STARTING",
]);

const POWERING_OFF_INSTANCE_STATES = new Set<AutodlH3InstanceState>([
  "DRAINING",
  "STOP_REQUESTED",
  "STOPPING",
]);

function taskPresentation(state: AutodlH3JobState): TaskPresentation {
  switch (state) {
    case "ACCEPTED":
    case "WAITING_POWER":
    case "WAITING_READY":
      return { label: "任务已排队", detail: "平台已持久化任务，正在等待自租 H3 调度", tone: "info", terminal: false };
    case "DISPATCHING":
      return { label: "正在提交 H3", detail: "网关已就绪，正使用同一业务编号安全派发", tone: "active", terminal: false };
    case "QUEUED":
      return { label: "H3 已接单排队", detail: "上游任务编号已回写，正在等待 GPU 执行", tone: "info", terminal: false };
    case "RUNNING":
      return { label: "GPU 正在生成", detail: "自租 H3 已进入实际生成阶段", tone: "active", terminal: false };
    case "RESULT_STAGING":
      return { label: "正在接收结果", detail: "H3 生成已结束，正在核验并接收成片", tone: "active", terminal: false };
    case "PERSISTING":
      return { label: "正在转存结果", detail: "成片正在写入稳定对象存储", tone: "active", terminal: false };
    case "FINALIZING":
      return { label: "正在保存历史", detail: "正在完成幂等结算与生成历史入库", tone: "active", terminal: false };
    case "SUCCEEDED":
      return { label: "视频生成成功", detail: "成片已稳定转存并完成入库", tone: "success", terminal: true };
    case "RETRY_WAIT":
      return { label: "安全等待恢复", detail: "调度暂时中断，系统将使用同一任务编号恢复", tone: "warning", terminal: false };
    case "RECOVERY_REQUIRED":
      return { label: "正在恢复任务", detail: "系统正在核对 H3 终态，不会盲目重复提交", tone: "warning", terminal: false };
    case "FAILED_TERMINAL":
      return { label: "视频生成失败", detail: "任务已结束且未产生可用成片", tone: "danger", terminal: true };
    case "CANCELLED":
      return { label: "任务已终止", detail: "该任务已结束，未进入重复提交", tone: "muted", terminal: true };
  }
}

function instancePresentation(state: AutodlH3InstanceState, idleRemainingSeconds: number | null): InstancePresentation {
  switch (state) {
    case "OFF":
      return { label: "实例已关机", detail: "AutoDL 已确认实例处于关机状态", tone: "muted" };
    case "START_REQUESTED":
      return { label: "已发送开机指令", detail: "AutoDL 已接收开机请求，正在等待状态确认", tone: "info" };
    case "STARTING":
      return { label: "正在开机", detail: "AutoDL 实例正在启动，尚未宣称网关已就绪", tone: "active" };
    case "BOOTSTRAPPING":
      return { label: "实例已 running", detail: "正在建立 SSH 隧道并预热 H3 网关", tone: "active" };
    case "READY":
      return { label: "网关已就绪", detail: "实例、隧道与 H3 健康检查均已通过", tone: "success" };
    case "BUSY":
      return { label: "实例运行中", detail: "自租 H3 正在处理队列或结果收尾", tone: "active" };
    case "IDLE_GRACE":
      return {
        label: idleRemainingSeconds === null ? "等待空闲关机" : `空闲倒计时 ${formatCountdown(idleRemainingSeconds)}`,
        detail: "当前无排队、生成或转存任务，倒计时结束后执行原子关机检查",
        tone: "warning",
      };
    case "DRAINING":
    case "STOP_REQUESTED":
      return { label: "已进入关机门禁", detail: "系统已二次确认无活动任务，正在请求关机", tone: "warning" };
    case "STOPPING":
      return { label: "正在关机", detail: "AutoDL 已接受关机请求，正在等待 OFF 终态", tone: "warning" };
    case "FAULTED":
      return { label: "实例状态异常", detail: "生命周期控制已关闭危险电源动作，需等待管理员核对", tone: "danger" };
    case "UNKNOWN":
      return { label: "实例状态待确认", detail: "尚未取得可信的 AutoDL 实例状态，不会执行盲目电源动作", tone: "warning" };
  }
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function idleGraceSecondsFromEnvironment(): number {
  const parsed = Number.parseInt(process.env.AUTODL_H3_IDLE_SECONDS || "", 10);
  return Number.isFinite(parsed) ? Math.max(300, Math.min(86_400, parsed)) : 300;
}

function validInstanceState(value: unknown): AutodlH3InstanceState {
  return AUTODL_H3_INSTANCE_STATES.includes(value as AutodlH3InstanceState)
    ? value as AutodlH3InstanceState
    : "UNKNOWN";
}

function combineHeadline(
  task: TaskPresentation,
  instance: InstancePresentation,
  instanceState: AutodlH3InstanceState,
): { headline: string; detail: string; tone: AutodlH3LifecycleTone } {
  if (!task.terminal) {
    if (instanceState === "OFF") {
      return { headline: "任务已排队，等待自动开机", detail: `${task.detail}；${instance.detail}`, tone: "info" };
    }
    if (POWERING_ON_INSTANCE_STATES.has(instanceState)) {
      return { headline: instance.label, detail: `${task.label}；${instance.detail}`, tone: instance.tone };
    }
    if (instanceState === "BOOTSTRAPPING") {
      return { headline: "实例已 running，正在建隧道/预热网关", detail: `${task.label}；${instance.detail}`, tone: "active" };
    }
    if (instanceState === "FAULTED" || instanceState === "UNKNOWN") {
      return { headline: instance.label, detail: `${task.label}；${instance.detail}`, tone: instance.tone };
    }
    return { headline: task.label, detail: `${task.detail}；${instance.label}`, tone: task.tone };
  }

  if (instanceState === "IDLE_GRACE" || POWERING_OFF_INSTANCE_STATES.has(instanceState) || instanceState === "OFF") {
    return { headline: `${task.label} · ${instance.label}`, detail: instance.detail, tone: task.tone === "danger" ? "danger" : instance.tone };
  }
  if (instanceState === "BUSY") {
    return { headline: `${task.label}，实例仍有任务`, detail: "本任务已结束；主机仍在处理其他排队或收尾工作，暂不进入关机倒计时", tone: task.tone };
  }
  return { headline: task.label, detail: `${task.detail}；${instance.label}`, tone: task.tone };
}

export function buildAutodlH3LifecycleView(input: {
  job: AutodlH3Job;
  instance: AutodlH3InstanceObservation | null;
  nowMs?: number;
  idleGraceSeconds?: number;
}): AutodlH3LifecycleView {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const idleGraceSeconds = Math.max(300, Math.floor(input.idleGraceSeconds ?? 300));
  const instanceState = validInstanceState(input.instance?.lifecycleState);
  const idleSinceMs = input.instance?.idleSince ? Date.parse(input.instance.idleSince) : Number.NaN;
  const idleRemainingSeconds = instanceState === "IDLE_GRACE" && Number.isFinite(idleSinceMs)
    ? Math.max(0, idleGraceSeconds - Math.floor((nowMs - idleSinceMs) / 1000))
    : null;
  const task = taskPresentation(input.job.state);
  const instance = instancePresentation(instanceState, idleRemainingSeconds);
  const combined = combineHeadline(task, instance, instanceState);
  const rawProgress = Number(input.job.progress);
  const progress = input.job.state === "RUNNING" && Number.isFinite(rawProgress) && rawProgress > 0
    ? Math.max(1, Math.min(99, Math.round(rawProgress)))
    : null;

  return {
    taskId: input.job.publicTaskId,
    taskState: input.job.state,
    taskLabel: task.label,
    instanceState,
    instanceLabel: instance.label,
    headline: combined.headline,
    detail: combined.detail,
    tone: combined.tone,
    progress,
    idleGraceSeconds,
    idleRemainingSeconds,
    taskTerminal: task.terminal,
    monitorComplete: task.terminal && instanceState === "OFF",
    observedAt: new Date(nowMs).toISOString(),
  };
}

export async function getAutodlH3LifecycleViewForUser(input: {
  publicTaskId: string;
  userId: string;
}): Promise<AutodlH3LifecycleView | null> {
  const job = await getAutodlH3VideoJobForUser(input);
  if (!job) return null;

  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("autodl_h3_instance_state")
    .select("lifecycle_state, idle_since, state_changed_at, updated_at")
    .eq("instance_uuid", job.instanceUuid)
    .maybeSingle();
  if (error) throw new Error("AUTODL_H3_LIFECYCLE_VIEW_UNAVAILABLE");

  const instance = data ? {
    lifecycleState: validInstanceState(data.lifecycle_state),
    idleSince: data.idle_since ? String(data.idle_since) : null,
    stateChangedAt: data.state_changed_at ? String(data.state_changed_at) : null,
    updatedAt: data.updated_at ? String(data.updated_at) : null,
  } satisfies AutodlH3InstanceObservation : null;

  return buildAutodlH3LifecycleView({
    job,
    instance,
    idleGraceSeconds: idleGraceSecondsFromEnvironment(),
  });
}
