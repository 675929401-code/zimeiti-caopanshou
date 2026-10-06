import { NextResponse } from "next/server";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { operationDomains, operationOutcomes } from "@/lib/operation-flight-recorder";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";

const allowedSources = new Set(["browser", "database", "server", "worker", "system", "admin"]);

function boundedInteger(raw: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

async function authorize(request: Request) {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  return authorizeAdminToken(token);
}

export async function GET(request: Request) {
  const authorization = await authorize(request);
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });
  }

  const url = new URL(request.url);
  const page = boundedInteger(url.searchParams.get("page"), 1, 1, 100_000);
  const pageSize = boundedInteger(url.searchParams.get("pageSize"), 30, 10, 100);
  const hours = boundedInteger(url.searchParams.get("hours"), 24, 1, 24 * 30);
  const domain = url.searchParams.get("domain") || "";
  const outcome = url.searchParams.get("outcome") || "";
  const source = url.searchParams.get("source") || "";
  const traceId = url.searchParams.get("traceId")?.trim() || "";

  if (domain && !operationDomains.includes(domain as (typeof operationDomains)[number])) {
    return NextResponse.json({ error: "业务类型无效" }, { status: 400 });
  }
  if (outcome && !operationOutcomes.includes(outcome as (typeof operationOutcomes)[number])) {
    return NextResponse.json({ error: "结果类型无效" }, { status: 400 });
  }
  if (source && !allowedSources.has(source)) return NextResponse.json({ error: "来源类型无效" }, { status: 400 });
  if (traceId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(traceId)) {
    return NextResponse.json({ error: "Trace ID 无效" }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  let query = db
    .from("operation_flight_events")
    .select("id,capture_sequence,trace_id,user_id,username,source,domain,operation,phase,outcome,duration_ms,http_status,route,error_code,error_fingerprint,summary,metadata,source_version,build_id,occurred_at,created_at", { count: "exact" })
    .order("occurred_at", { ascending: false })
    .order("capture_sequence", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (domain) query = query.eq("domain", domain);
  if (outcome) query = query.eq("outcome", outcome);
  if (source) query = query.eq("source", source);
  if (traceId) query = query.eq("trace_id", traceId);

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
  const [eventsResult, summaryResult] = await Promise.all([
    query,
    db
      .from("operation_flight_events")
      .select("domain,outcome,duration_ms,source,error_fingerprint")
      .gte("occurred_at", cutoff)
      .order("occurred_at", { ascending: false })
      .order("capture_sequence", { ascending: false })
      .limit(10_000),
  ]);
  if (eventsResult.error) {
    return NextResponse.json({ error: "运行日志暂时不可用", code: eventsResult.error.code }, { status: 503 });
  }
  if (summaryResult.error) {
    return NextResponse.json({ error: "运行摘要暂时不可用", code: summaryResult.error.code }, { status: 503 });
  }

  const events = eventsResult.data || [];
  const userIds = [...new Set(events.map((event: { user_id?: string | null }) => event.user_id).filter(Boolean))] as string[];
  const userLabels = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await db.from("users").select("id,username,display_name").in("id", userIds.slice(0, 100));
    for (const user of users || []) userLabels.set(String(user.id), String(user.display_name || user.username || user.id));
  }

  const summaryRows = summaryResult.data || [];
  const durations = summaryRows
    .map((row: { duration_ms?: number | string | null }) => Number(row.duration_ms))
    .filter((value: number) => Number.isFinite(value) && value >= 0);
  const byDomain: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const fingerprints = new Set<string>();
  let errors = 0;
  for (const row of summaryRows) {
    byDomain[row.domain] = (byDomain[row.domain] || 0) + 1;
    bySource[row.source] = (bySource[row.source] || 0) + 1;
    if (row.outcome === "error") errors += 1;
    if (row.error_fingerprint) fingerprints.add(row.error_fingerprint);
  }

  return NextResponse.json({
    data: events.map((event: { user_id?: string | null; username?: string | null }) => ({
      ...event,
      user_label: (event.user_id && userLabels.get(event.user_id)) || event.username || event.user_id || "系统",
    })),
    page,
    pageSize,
    total: eventsResult.count || 0,
    summary: {
      windowHours: hours,
      events: summaryRows.length,
      errors,
      uniqueErrorFingerprints: fingerprints.size,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      byDomain,
      bySource,
      capped: summaryRows.length >= 10_000,
    },
    policy: {
      retentionDays: 90,
      automaticCodeRepair: false,
      automaticPaidRetry: false,
      safeMaintenanceOnly: true,
    },
  });
}
