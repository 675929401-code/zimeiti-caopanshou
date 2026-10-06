import { NextResponse } from "next/server";
import { authorizeAdminToken } from "@/lib/admin-auth";
import {
  pseudonymousUserRef,
  readFlightRuntimeIdentity,
  redactOperationText,
} from "@/lib/operation-flight-recorder";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";

interface FlightEventRow {
  id: string;
  capture_sequence: number;
  trace_id: string;
  user_id: string | null;
  username: string | null;
  source: string;
  domain: string;
  operation: string;
  phase: string;
  outcome: string;
  duration_ms: number | null;
  http_status: number | null;
  route: string | null;
  error_code: string | null;
  error_fingerprint: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  source_version: string | null;
  build_id: string | null;
  occurred_at: string;
}

interface DiagnosticIncidentRow {
  id: string;
  problem_type: string;
  severity: string;
  description: string | null;
  status: string;
  page_url: string | null;
  created_at: string;
  resolved_at: string | null;
}

function diagnosis(events: FlightEventRow[]) {
  const failed = events.filter((event) => event.outcome === "error");
  const domains = [...new Set(events.map((event) => event.domain))];
  const hasDatabaseFailure = failed.some((event) => event.source === "database");
  const onlyBrowserNetwork = failed.length > 0 && failed.every((event) => event.source === "browser" && (!event.http_status || event.http_status === 499));
  const recommendations = failed.length === 0
    ? ["链路未记录错误；如用户仍感知异常，核对页面截图、任务终态和供应商回执。"]
    : [
        "先按 Trace ID 对齐浏览器与数据库时间线，确认故障发生在提交前、供应商调用中还是终态结算后。",
        ...(hasDatabaseFailure ? ["核对对应耐久任务表的状态、错误码、账务与交付状态；禁止直接重放付费请求。"] : []),
        ...(onlyBrowserNetwork ? ["优先核对网络、会话和反向代理；只允许无副作用的页面重连，不自动重放生成或支付。"] : []),
        "需要改代码、配置或数据时，在 F 盘事实源修复并通过版本化构建、验收和局部更新发布。",
      ];
  return {
    classification: failed.length === 0 ? "no_error_observed" : hasDatabaseFailure ? "durable_business_failure" : "client_or_transport_failure",
    domains,
    failedEventCount: failed.length,
    automaticRepairEligible: false,
    automaticRepairReason: "代码、数据库结构、模型配置、会员资产、账务、供应商重试和部署均不允许线上自动修改。",
    recommendations,
  };
}

async function authorize(request: Request) {
  const header = request.headers.get("authorization");
  return authorizeAdminToken(header?.startsWith("Bearer ") ? header.slice(7) : null);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ traceId: string }> },
) {
  const authorization = await authorize(request);
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });
  }
  const { traceId } = await params;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(traceId)) {
    return NextResponse.json({ error: "Trace ID 无效" }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("operation_flight_events")
    .select("id,capture_sequence,trace_id,user_id,username,source,domain,operation,phase,outcome,duration_ms,http_status,route,error_code,error_fingerprint,summary,metadata,source_version,build_id,occurred_at")
    .eq("trace_id", traceId)
    .order("occurred_at", { ascending: true })
    .order("capture_sequence", { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ error: "运行时间线暂时不可用", code: error.code }, { status: 503 });
  const events = (data || []) as FlightEventRow[];
  if (events.length === 0) return NextResponse.json({ error: "未找到该 Trace" }, { status: 404 });

  const userId = events.find((event) => event.user_id)?.user_id || null;
  let userLabel = events.find((event) => event.username)?.username || userId || "系统";
  if (userId) {
    const { data: user } = await db.from("users").select("username,display_name").eq("id", userId).maybeSingle();
    userLabel = String(user?.display_name || user?.username || userLabel);
  }
  const { data: incidents } = await db
    .from("diagnostic_logs")
    .select("id,problem_type,severity,description,status,page_url,created_at,resolved_at")
    .contains("context", { trace_id: traceId })
    .order("created_at", { ascending: true })
    .limit(100);

  const analysis = diagnosis(events);
  const runtime = readFlightRuntimeIdentity();
  const codexBundle = {
    schemaVersion: 1,
    kind: "zimeiti.codex-diagnostic-bundle",
    generatedAt: new Date().toISOString(),
    traceId,
    userRef: pseudonymousUserRef(userId),
    runtime,
    analysis,
    timeline: events.map((event) => ({
      at: event.occurred_at,
      source: event.source,
      domain: event.domain,
      operation: event.operation,
      phase: event.phase,
      outcome: event.outcome,
      durationMs: event.duration_ms,
      httpStatus: event.http_status,
      route: event.route,
      errorCode: event.error_code,
      errorFingerprint: event.error_fingerprint,
      summary: redactOperationText(event.summary),
      sourceVersion: event.source_version,
      buildId: event.build_id,
      metadata: event.metadata || {},
    })),
    incidents: ((incidents || []) as DiagnosticIncidentRow[]).map((incident) => ({
      id: incident.id,
      type: incident.problem_type,
      severity: incident.severity,
      description: redactOperationText(incident.description),
      status: incident.status,
      pagePath: incident.page_url,
      createdAt: incident.created_at,
      resolvedAt: incident.resolved_at,
    })),
    recoveryPolicy: {
      sourceOfTruth: "F-drive-current-version",
      serverDirectCodeMutation: false,
      productionDatabaseAutoMutation: false,
      paidRequestAutoReplay: false,
      delivery: "reviewed-versioned-patch-or-full-release",
    },
  };

  const responseBody = {
    traceId,
    user: { id: userId, label: userLabel },
    events,
    incidents: incidents || [],
    analysis,
    codexBundle,
  };
  const download = new URL(request.url).searchParams.get("download") === "1";
  return NextResponse.json(download ? codexBundle : responseBody, {
    headers: download
      ? { "Content-Disposition": `attachment; filename="codex-diagnostic-${traceId.slice(0, 48)}.json"` }
      : undefined,
  });
}
