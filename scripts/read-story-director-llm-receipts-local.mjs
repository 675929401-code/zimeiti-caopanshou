import fs from "node:fs/promises";
import assert from "node:assert/strict";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const supabase = String(runtime.supabaseUrl || "").replace(/\/+$/u, "");
const service = String(runtime.serviceRoleKey || "").trim();
assert.ok(supabase && service, "CONTROLLED_RUNTIME_REQUIRED");
const headers = { apikey: service, Authorization: `Bearer ${service}` };
const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();

async function read(table, select, extra = {}) {
  const url = new URL(`/rest/v1/${table}`, supabase);
  url.searchParams.set("select", select);
  url.searchParams.set("created_at", `gte.${cutoff}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "20");
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => []);
  return { httpStatus: response.status, rows: Array.isArray(body) ? body : [], error: Array.isArray(body) ? null : body?.message || body?.error || "non-array" };
}

const attempts = await read(
  "llm_request_attempts",
  "record_id,client_request_id,state,attempt_no,provider_call_started_at,http_status,error_code,error_message,created_at,updated_at",
  { client_request_id: "like.ab-test-r1*" },
);
const events = await read(
  "operation_flight_events",
  "trace_id,domain,operation,phase,outcome,duration_ms,http_status,error_code,error_fingerprint,summary,occurred_at,created_at",
  { domain: "eq.chat" },
);
const attemptEvents = await read(
  "llm_request_attempt_events",
  "record_id,attempt_no,event_type,from_state,to_state,reason,evidence,created_at",
);
const wallet = await read(
  "wallet_operations",
  "id,user_id,wallet,operation_kind,idempotency_key,amount,delta,status,balance_before,balance_after,description,metadata,created_at,completed_at",
);
const redact = (row) => ({
  ...row,
  record_id: row.record_id ? `${String(row.record_id).slice(0, 8)}…${String(row.record_id).slice(-4)}` : null,
  client_request_id: row.client_request_id ? `${String(row.client_request_id).slice(0, 18)}…` : null,
  trace_id: row.trace_id ? `${String(row.trace_id).slice(0, 18)}…` : null,
  error_message: typeof row.error_message === "string" ? row.error_message.slice(0, 240) : row.error_message,
  summary: typeof row.summary === "string" ? row.summary.slice(0, 240) : row.summary,
  user_id: row.user_id ? `${String(row.user_id).slice(0, 8)}…${String(row.user_id).slice(-4)}` : row.user_id,
  id: row.id ? `${String(row.id).slice(0, 8)}…${String(row.id).slice(-4)}` : row.id,
  operation_id: row.operation_id ? `${String(row.operation_id).slice(0, 8)}…${String(row.operation_id).slice(-4)}` : row.operation_id,
  metadata: undefined,
});
const report = {
  schemaVersion: "storyboard_llm_provider_terminal_readback.v1",
  checkedAt: new Date().toISOString(),
  classification: attempts.rows.some((row) => row.provider_call_started_at)
    ? "provider_started_terminal_unknown"
    : "provider_not_started",
  cutoff,
  attempts: { httpStatus: attempts.httpStatus, rows: attempts.rows.map(redact), error: attempts.error },
  attemptEvents: { httpStatus: attemptEvents.httpStatus, rows: attemptEvents.rows.map(redact), error: attemptEvents.error },
  events: { httpStatus: events.httpStatus, rows: events.rows.map(redact), error: events.error },
  wallet: { httpStatus: wallet.httpStatus, rows: wallet.rows.map(redact), error: wallet.error },
};
const evidenceDir = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/运行日志/三视觉资产十秒闭环-20261019/benchmark-research-20261020/ab-test-r1";
await fs.mkdir(evidenceDir, { recursive: true });
await fs.writeFile(`${evidenceDir}/llm-provider-terminal-readback.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
