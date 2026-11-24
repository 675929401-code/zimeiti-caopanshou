import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { computeModelFaults, probeChannelArrears, runChannelPatrol, type ArrearsProbeResult, type ModelFault, type PatrolChannelResult, type PatrolSnapshot } from "@/lib/server/ops-channel-patrol";

type AlertRow = {
  kind: "degraded" | "down" | "recovered" | "info";
  channelHost: string;
  message: string;
  payload: Record<string, unknown>;
};

export type PatrolHistoryEntry = {
  capturedAt: string;
  channelCount: number;
  ok: number;
  degraded: number;
  down: number;
};

export type PatrolAlert = {
  id: number;
  createdAt: string;
  kind: AlertRow["kind"];
  channelHost: string;
  message: string;
};

const HISTORY_LIMIT = 24;
const SNAPSHOT_RETENTION = 500;

let scheduledRun: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function summarize(channels: PatrolChannelResult[]): Omit<PatrolHistoryEntry, "capturedAt"> {
  return {
    channelCount: channels.length,
    ok: channels.filter((item) => item.status === "ok").length,
    degraded: channels.filter((item) => item.status === "degraded").length,
    down: channels.filter((item) => item.status === "down" || item.status === "unknown").length,
  };
}

function statusLabel(status: PatrolChannelResult["status"]): string {
  return status === "ok" ? "正常" : status === "degraded" ? "降级" : status === "down" ? "不可用" : "待验证";
}

function transitions(previous: PatrolChannelResult[], next: PatrolChannelResult[]): AlertRow[] {
  const before = new Map(previous.map((item) => [item.host, item]));
  const alerts: AlertRow[] = [];
  for (const channel of next) {
    const old = before.get(channel.host);
    if (!old) continue;
    if (old.status === channel.status) continue;
    if (channel.status !== "ok") {
      alerts.push({
        kind: channel.status === "down" ? "down" : "degraded",
        channelHost: channel.host,
        message: `${channel.host} 从「${statusLabel(old.status)}」变为「${statusLabel(channel.status)}」${channel.error ? `：${channel.error}` : ""}`,
        payload: { previous: old.status, current: channel.status, httpStatus: channel.httpStatus, latencyMs: channel.latencyMs },
      });
    } else {
      alerts.push({
        kind: "recovered",
        channelHost: channel.host,
        message: `${channel.host} 已恢复为「正常」`,
        payload: { previous: old.status, current: channel.status },
      });
    }
  }
  return alerts;
}

async function previousChannels(): Promise<PatrolChannelResult[]> {
  const { data } = await getSupabaseAdminClient()
    .from("ops_patrol_snapshots")
    .select("channels")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const channels = data?.channels;
  return Array.isArray(channels) ? channels as PatrolChannelResult[] : [];
}

async function persistSnapshot(snapshot: PatrolSnapshot): Promise<void> {
  const db = getSupabaseAdminClient();
  const { error: insertError } = await db.from("ops_patrol_snapshots").insert({
    captured_at: snapshot.checkedAt,
    duration_ms: snapshot.durationMs,
    channels: snapshot.channels,
    faults: snapshot.faults ?? computeModelFaults(snapshot.channels),
  });
  if (insertError) console.warn("[ops-patrol] snapshot persist failed:", insertError.message);
  // Best-effort retention; failure here must not affect patrol results.
  const { data: stale } = await db
    .from("ops_patrol_snapshots")
    .select("id")
    .order("captured_at", { ascending: false })
    .range(SNAPSHOT_RETENTION, SNAPSHOT_RETENTION + 50);
  if (Array.isArray(stale) && stale.length > 0) {
    await db.from("ops_patrol_snapshots").delete().in("id", stale.map((row) => row.id));
  }
}

async function recordAlerts(alerts: AlertRow[]): Promise<void> {
  if (alerts.length === 0) return;
  await getSupabaseAdminClient().from("ops_patrol_alerts").insert(alerts.map((alert) => ({
    kind: alert.kind,
    channel_host: alert.channelHost,
    message: alert.message,
    payload: alert.payload,
  })));
}

function webhookBody(text: string): { url: string; body: string } | null {
  const url = String(process.env.OPS_ALERT_WEBHOOK_URL || "").trim();
  if (!url) return null;
  const format = String(process.env.OPS_ALERT_WEBHOOK_FORMAT || "generic").trim();
  const payload = format === "feishu"
    ? { msg_type: "text", content: { text } }
    : format === "dingtalk"
      ? { msgtype: "text", text: { content: text } }
      : { text, source: "ops-patrol" };
  return { url, body: JSON.stringify(payload) };
}

async function notifyWebhook(alerts: AlertRow[]): Promise<void> {
  if (alerts.length === 0) return;
  const target = webhookBody(`${alerts.length} 条渠道异常：\n${alerts.map((alert) => `- ${alert.message}`).join("\n")}`);
  if (!target) return;
  try {
    await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: target.body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Alert delivery is best effort; the alert stays in the local table.
  }
}

/** Run one patrol, persist it, and emit only status transitions as alerts. */
export async function runAndPersistPatrol(withArrears = false): Promise<PatrolSnapshot & { arrears?: { checkedAt: string; results: ArrearsProbeResult[] } }> {
  const previous = await previousChannels();
  const snapshot: PatrolSnapshot & { arrears?: { checkedAt: string; results: ArrearsProbeResult[] } } = await runChannelPatrol(true);
  if (withArrears) {
    const arrears = await probeChannelArrears();
    snapshot.arrears = arrears;
    const extra: ModelFault[] = [];
    for (const result of arrears.results) {
      if (result.status !== "insufficient") continue;
      const channel = snapshot.channels.find((item) => item.host === result.host);
      for (const item of channel?.modelItems ?? []) {
        extra.push({ model: item.name, host: result.host, kind: "arrears", detail: "欠费/余额不足（1-token 探测）", checkedAt: snapshot.checkedAt });
      }
    }
    snapshot.faults = [...(snapshot.faults ?? []), ...extra];
  }
  await persistSnapshot(snapshot);
  const alerts = transitions(previous, snapshot.channels);
  await recordAlerts(alerts);
  await notifyWebhook(alerts);
  return snapshot;
}

export function startOpsPatrolScheduler(intervalMinutes: number): void {
  if (timer) return;
  if (process.env.OPS_PATROL_SCHEDULER === "0") return;
  const minutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 30;
  const kickoff = setTimeout(() => { void runSafely(true); }, 45_000);
  kickoff.unref?.();
  timer = setInterval(() => { void runSafely(); }, minutes * 60_000);
  timer.unref?.();
}

let schedulerStarted = false;

/** Idempotent start used by both boot instrumentation and the first admin read. */
export function ensureOpsPatrolScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const status = opsPatrolSchedulerStatus();
  if (status.enabled) startOpsPatrolScheduler(status.intervalMinutes);
}

const SCHEDULER_LOCK_KEY = 918273645;

async function trySchedulerLock(): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("ops_patrol_try_lock", { p_key: SCHEDULER_LOCK_KEY });
    return error ? true : data === true;
  } catch {
    // Fail open: a missing lock function must not stop scheduled patrols.
    return true;
  }
}

async function releaseSchedulerLock(): Promise<void> {
  try {
    await getSupabaseAdminClient().rpc("ops_patrol_release_lock", { p_key: SCHEDULER_LOCK_KEY });
  } catch {
    // The advisory lock is released automatically when the session ends.
  }
}

async function runSafely(withArrears = false): Promise<void> {
  if (scheduledRun) return;
  const locked = await trySchedulerLock();
  if (!locked) return;
  scheduledRun = runAndPersistPatrol(withArrears)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(async () => { await releaseSchedulerLock(); scheduledRun = null; });
}

export function opsPatrolSchedulerStatus(): { enabled: boolean; intervalMinutes: number; webhookConfigured: boolean } {
  const interval = Number(process.env.OPS_PATROL_INTERVAL_MINUTES || "30");
  return {
    enabled: process.env.OPS_PATROL_SCHEDULER !== "0" && Number.isFinite(interval) && interval > 0,
    intervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : 30,
    webhookConfigured: Boolean(String(process.env.OPS_ALERT_WEBHOOK_URL || "").trim()),
  };
}

export async function readPatrolHistory(): Promise<{ history: PatrolHistoryEntry[]; alerts: PatrolAlert[]; faults: ModelFault[] }> {
  const db = getSupabaseAdminClient();
  const { data: rows } = await db
    .from("ops_patrol_snapshots")
    .select("captured_at, channels, faults")
    .order("captured_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const history: PatrolHistoryEntry[] = Array.isArray(rows) ? rows.map((row) => {
    const channels = Array.isArray(row.channels) ? row.channels as PatrolChannelResult[] : [];
    return {
      capturedAt: String(row.captured_at),
      ...summarize(channels),
    };
  }) : [];
  const latestFaults = Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0].faults)
    ? rows[0].faults as ModelFault[]
    : [];
  const { data: alertRows } = await db
    .from("ops_patrol_alerts")
    .select("id, created_at, kind, channel_host, message")
    .order("created_at", { ascending: false })
    .limit(20);
  const alerts: PatrolAlert[] = Array.isArray(alertRows) ? alertRows.map((row) => ({
    id: Number(row.id),
    createdAt: String(row.created_at),
    kind: row.kind as AlertRow["kind"],
    channelHost: String(row.channel_host),
    message: String(row.message),
  })) : [];
  return { history, alerts, faults: latestFaults };
}
