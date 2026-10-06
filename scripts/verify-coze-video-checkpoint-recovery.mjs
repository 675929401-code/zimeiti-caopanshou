import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const recordId = String(process.argv.find(value => value.startsWith("--record-id="))?.slice(12) || "").trim();
const runId = String(process.argv.find(value => value.startsWith("--run-id="))?.slice(9) || "").trim();
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(origin), "LOCAL_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
assert.match(recordId, /^[a-f0-9]{64}$/u, "RUNNING_ATTEMPT_RECORD_REQUIRED");
assert.match(runId, /^[A-Za-z0-9_-]{6,100}$/u, "SAFE_RUN_ID_REQUIRED");

const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const supabase = new URL(runtime.supabaseUrl);
assert.equal(supabase.origin, "http://127.0.0.1:54321", "LOCAL_DATABASE_REQUIRED");
const databaseHeaders = {
  apikey: runtime.serviceRoleKey,
  Authorization: `Bearer ${runtime.serviceRoleKey}`,
};
const outputDirectory = path.resolve(".codex-evidence/toolbox-real-e2e-20260902", runId);
const reportPath = path.join(outputDirectory, "checkpoint-recovery.json");
const dispatchMarker = path.join(outputDirectory, "checkpoint-recovery-dispatched.json");
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  origin,
  recordId,
  recoveryMode: "checkpoint-only",
  providerPosts: 0,
  recoveryPosts: 0,
  credentialsPersisted: false,
};

const clean = value => String(value || "")
  .split(token).join("[redacted]")
  .replace(/https?:\/\/\S+/gu, "[url]")
  .slice(0, 500);

async function save() {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function rows(table, select, filters = {}) {
  const url = new URL(`/rest/v1/${table}`, supabase);
  url.searchParams.set("select", select);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: databaseHeaders,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  assert.ok(response.ok && Array.isArray(payload), `LOCAL_${table.toUpperCase()}_READ_FAILED_${response.status}`);
  return payload;
}

const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  cache: "no-store",
  signal: AbortSignal.timeout(15_000),
});
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user?.role === "admin", "ACTIVE_LOCAL_ADMIN_REQUIRED");

const attemptSelect = "record_id,user_id,client_request_id,state,http_status,response,request_snapshot,provider_task_id,provider_checkpoint,provider_evidence,billing_evidence,updated_at";
const [before] = await rows("extraction_attempts", attemptSelect, {
  record_id: `eq.${recordId}`,
  user_id: `eq.${identity.user.id}`,
  limit: "1",
});
assert.ok(before, "OWNED_EXTRACTION_ATTEMPT_REQUIRED");
assert.equal(before.state, "running", "ONLY_RUNNING_CHECKPOINT_MAY_BE_RECOVERED");
assert.equal(before.provider_checkpoint?.result?.schema, "coze_video_provider_result.v1", "COZE_VIDEO_CHECKPOINT_REQUIRED");
assert.ok(before.provider_task_id, "PROVIDER_TASK_ID_REQUIRED");
const payload = before.request_snapshot?.payload;
assert.ok(payload && payload.extraction_mode === "video" && Array.isArray(payload.links) && payload.links.length === 1,
  "SINGLE_VIDEO_REQUEST_SNAPSHOT_REQUIRED");
const checkpointVideo = before.provider_checkpoint.result.videos?.find(video => video?.success && video.download_url);
assert.ok(checkpointVideo, "CHECKPOINT_VIDEO_REQUIRED");
const providerMediaHost = new URL(checkpointVideo.download_url).hostname.toLowerCase();
assert.ok(providerMediaHost === "zjcdn.com" || providerMediaHost.endsWith(".zjcdn.com"), "EXPECTED_ZJCDN_CHECKPOINT_REQUIRED");

const clientRequestId = before.client_request_id;
const settlementKey = `extract:${clientRequestId}:coze-video`;
const balance = async () => Number((await rows("users", "cash_balance", { id: `eq.${identity.user.id}`, limit: "1" }))[0]?.cash_balance);
const ledger = async () => rows("wallet_ledger_entries", "idempotency_key,delta,balance_before,balance_after", {
  user_id: `eq.${identity.user.id}`,
  idempotency_key: `eq.${settlementKey}`,
});
const beforeBalance = await balance();
const beforeLedger = await ledger();
assert.ok(Number.isFinite(beforeBalance) && beforeBalance >= 0.02, "SUFFICIENT_LOCAL_BALANCE_REQUIRED");
assert.equal(beforeLedger.length, 0, "RECOVERY_SETTLEMENT_MUST_START_UNCHARGED");

report.before = {
  state: before.state,
  providerTaskPresent: true,
  checkpointSchema: before.provider_checkpoint.result.schema,
  providerMediaHost,
  balance: beforeBalance,
  ledgerCount: beforeLedger.length,
};
await save();

try {
  await writeFile(dispatchMarker, `${JSON.stringify({
    at: new Date().toISOString(),
    recordId,
    clientRequestId,
    recoveryMode: "checkpoint-only",
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  report.recoveryPosts = 1;
  await save();

  const response = await fetch(`${origin}/api/extract`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": clientRequestId,
      "X-Extraction-Recovery-Mode": "checkpoint-only",
    },
    body: JSON.stringify({ ...payload, client_request_id: clientRequestId }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  report.response = {
    status: response.status,
    success: body?.success === true,
    source: body?.source || null,
    replayed: response.headers.get("x-extraction-replayed"),
    recoveryMode: response.headers.get("x-extraction-recovery-mode"),
    providerHandler: response.headers.get("x-extraction-provider-handler"),
    charged: body?.charged,
    price: body?.price,
    videoCount: Array.isArray(body?.videos) ? body.videos.length : 0,
    errorCode: body?.error_code || body?.code || null,
    error: clean(body?.error || body?.message || ""),
  };
  assert.equal(response.status, 200, "CHECKPOINT_RECOVERY_HTTP_200_REQUIRED");
  assert.equal(body?.success, true, "CHECKPOINT_RECOVERY_SUCCESS_REQUIRED");
  assert.equal(body?.source, "coze_workflow", "COZE_SOURCE_REQUIRED");
  assert.equal(response.headers.get("x-extraction-replayed"), "true", "RECOVERY_REPLAY_HEADER_REQUIRED");
  assert.equal(response.headers.get("x-extraction-recovery-mode"), "checkpoint-only", "CHECKPOINT_MODE_PROOF_REQUIRED");
  assert.equal(response.headers.get("x-extraction-provider-handler"), "skipped", "PROVIDER_HANDLER_MUST_BE_SKIPPED");
  assert.equal(body?.charged, true, "SUCCESSFUL_RECOVERY_MUST_SETTLE_ONCE");
  assert.equal(Number(body?.price), 0.02, "PUBLIC_PRICE_MUST_BE_0_02");

  const delivered = body.videos?.find(video => video?.success && video.temporary_url);
  assert.ok(delivered, "SIGNED_TEMPORARY_VIDEO_REQUIRED");
  assert.match(delivered.temporary_url, /^\/api\/extract\/local-video\?/u);
  assert.ok(Number(delivered.temporary_expires_at) > Date.now(), "TEMPORARY_EXPIRY_REQUIRED");
  assert.doesNotMatch(JSON.stringify(body), /https?:\/\/(?:[^/]+\.)?zjcdn\.com/iu, "PROVIDER_URL_MUST_NOT_LEAK");

  const mediaResponse = await fetch(new URL(delivered.temporary_url, origin), {
    headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-1023" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const mediaBytes = Buffer.from(await mediaResponse.arrayBuffer());
  report.media = {
    status: mediaResponse.status,
    contentType: mediaResponse.headers.get("content-type"),
    contentRangePresent: Boolean(mediaResponse.headers.get("content-range")),
    bytes: mediaBytes.byteLength,
  };
  assert.equal(mediaResponse.status, 206, "TEMPORARY_VIDEO_RANGE_206_REQUIRED");
  assert.match(mediaResponse.headers.get("content-type") || "", /^video\//u, "VIDEO_CONTENT_TYPE_REQUIRED");
  assert.ok(mediaBytes.byteLength > 0 && mediaBytes.byteLength <= 1024, "BOUNDED_RANGE_BYTES_REQUIRED");

  const historyResponse = await fetch(`${origin}/api/extract/history`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const history = await historyResponse.json();
  const historyRecord = history?.records?.find(item => item?.id === recordId);
  assert.ok(historyResponse.ok && historyRecord?.status === "success", "ACCOUNT_HISTORY_SUCCESS_REQUIRED");
  assert.ok(historyRecord.result?.videos?.some(video => video?.temporary_url && video.success), "ACCOUNT_HISTORY_DELIVERY_REQUIRED");
  assert.doesNotMatch(JSON.stringify(historyRecord), /https?:\/\/(?:[^/]+\.)?zjcdn\.com/iu, "HISTORY_PROVIDER_URL_MUST_NOT_LEAK");

  const [after] = await rows("extraction_attempts", attemptSelect, {
    record_id: `eq.${recordId}`,
    user_id: `eq.${identity.user.id}`,
    limit: "1",
  });
  const afterBalance = await balance();
  const afterLedger = await ledger();
  assert.equal(after.state, "succeeded", "ATTEMPT_MUST_BECOME_SUCCEEDED");
  assert.equal(after.http_status, 200, "ATTEMPT_HTTP_200_REQUIRED");
  assert.equal(after.provider_task_id, before.provider_task_id, "PROVIDER_TASK_MUST_NOT_CHANGE");
  assert.equal(after.provider_checkpoint?.result?.schema, "coze_video_provider_result.v1", "CHECKPOINT_MUST_REMAIN_AVAILABLE");
  assert.equal(afterLedger.length, 1, "EXACTLY_ONE_WALLET_LEDGER_REQUIRED");
  assert.equal(Number(afterLedger[0].delta), -0.02, "EXACT_PRICE_DEDUCTION_REQUIRED");
  assert.ok(Math.abs((beforeBalance - afterBalance) - 0.02) < 0.000001, "BALANCE_DELTA_MUST_BE_0_02");
  assert.equal(after.billing_evidence?.charged, true, "BILLING_EVIDENCE_REQUIRED");

  report.after = {
    state: after.state,
    httpStatus: after.http_status,
    providerTaskUnchanged: after.provider_task_id === before.provider_task_id,
    checkpointPreserved: after.provider_checkpoint?.result?.schema === "coze_video_provider_result.v1",
    balance: afterBalance,
    balanceDelta: Number((beforeBalance - afterBalance).toFixed(2)),
    ledgerCount: afterLedger.length,
    ledgerDelta: Number(afterLedger[0].delta),
    historyMatched: true,
    providerUrlAbsentFromPublicResponseAndHistory: true,
  };
  report.providerPosts = 0;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error instanceof Error ? error.name : "Error", message: clean(error instanceof Error ? error.message : error) };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
}

console.log(JSON.stringify({
  report: path.relative(process.cwd(), reportPath),
  passed: report.passed,
  recoveryPosts: report.recoveryPosts,
  providerPosts: report.providerPosts,
  response: report.response ? { status: report.response.status, success: report.response.success } : null,
  failure: report.failure || null,
}));
