import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { SignJWT } from "jose";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ENV_PATH = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.env.local";
const ORIGIN = "http://127.0.0.1:5000";
const LOCAL_HEADER = { "x-local-workbench": "ai-creation-studio-local" };
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type Json = Record<string, unknown>;
type Runtime = Json & { supabaseUrl?: string; restUrl?: string; serviceRoleKey?: string };

function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function clean(value: unknown, max = 500) {
  return String(value || "").replace(/https?:\/\/\S+/giu, "[url]").replace(/\bBearer\s+\S+/giu, "Bearer [redacted]").slice(0, max);
}
async function json(response: Response) {
  const body = await response.text();
  try { return body ? JSON.parse(body) as Json : {}; } catch { return { error: clean(body) }; }
}
async function api(token: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(new URL(pathname, ORIGIN), { ...init, headers, signal: init.signal || AbortSignal.timeout(180_000) });
  return { response, body: await json(response) };
}
async function alternateLocalAccountToken(runtime: Runtime, ownerUserId: string) {
  const candidates = await rest(runtime, "users", { select: "id,email,role,display_name,status,is_active", id: `neq.${ownerUserId}`, limit: "100" });
  const account = candidates.find((row) => row.is_active === true && (!row.status || row.status === "active"));
  assert.ok(account?.id && account.email, "ALTERNATE_ACTIVE_LOCAL_ACCOUNT_REQUIRED");
  const environment = parseDotenv(await readFile(ENV_PATH, "utf8"));
  const secret = String(environment.JWT_SECRET || "");
  assert.ok(secret.length >= 16, "LOCAL_JWT_SECRET_REQUIRED");
  return new SignJWT({
    userId: String(account.id), username: String(account.email), role: account.role === "admin" ? "admin" : "student",
    displayName: String(account.display_name || "验收用户"),
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(new TextEncoder().encode(secret));
}
async function rest(runtime: Runtime, table: string, query: Record<string, string>) {
  const key = String(runtime.serviceRoleKey || ""); assert.ok(key, "LOCAL_SERVICE_ROLE_KEY_MISSING");
  const url = new URL(`/rest/v1/${table}`, String(runtime.supabaseUrl || runtime.restUrl));
  Object.entries(query).forEach(([name, value]) => url.searchParams.set(name, value));
  const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, `LOCAL_REST_READ_FAILED:${table}:${response.status}`);
  return await response.json() as Json[];
}
async function videoProbe(rawUrl: string) {
  const url = new URL(rawUrl);
  assert.equal(url.protocol, "https:", "LONG_RESULT_MUST_USE_SIGNED_HTTPS");
  assert.ok(url.hostname.endsWith(".myqcloud.com"), "LONG_RESULT_HOST_NOT_OWNED_STORAGE");
  const response = await fetch(url, { headers: { Range: "bytes=0-65535" }, signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `LONG_RESULT_READ_FAILED:${response.status}`);
  const reader = response.body?.getReader();
  const first = reader ? await reader.read() : { value: new Uint8Array(), done: true };
  await reader?.cancel();
  const bytes = first.value || new Uint8Array();
  assert.ok(bytes.byteLength > 0, "LONG_RESULT_EMPTY");
  assert.ok(String(response.headers.get("content-type") || "").startsWith("video/"), "LONG_RESULT_NOT_VIDEO");
  return { status: response.status, contentType: response.headers.get("content-type"), firstChunkBytes: bytes.byteLength, mp4HeaderDetected: Buffer.from(bytes.slice(0, 32)).includes(Buffer.from("ftyp")) };
}

async function main() {
  const execute = process.argv.includes("--execute");
  const confirmed = process.argv.includes("--confirm-one-paid-long-provider-test");
  if (!execute) {
    console.log(JSON.stringify({ mode: "plan", providerRequests: 0, databaseWrites: 0, command: "--execute --confirm-one-paid-long-provider-test" }, null, 2));
    return;
  }
  assert.equal(confirmed, true, "ONE_LONG_PROVIDER_TEST_CONFIRMATION_REQUIRED");
  const runtime = JSON.parse((await readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, "")) as Runtime;
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(new URL(String(runtime.supabaseUrl || runtime.restUrl)).origin, "http://127.0.0.1:54321", "LOCAL_REST_REQUIRED");
  const sessionResponse = await fetch(`${ORIGIN}/api/auth/dev-session`, { headers: LOCAL_HEADER, signal: AbortSignal.timeout(20_000) });
  const session = await json(sessionResponse);
  const user = object(session.user);
  assert.ok(sessionResponse.ok && session.token && user.role === "admin", "LOCAL_ADMIN_DEV_SESSION_REQUIRED");
  const token = String(session.token); const userId = String(user.id || user.userId || "");

  const models = await rest(runtime, "video_models", { select: "id,name,protocol_type,is_active,is_hidden", protocol_type: "eq.dashscope_video_retalk", is_active: "eq.true", is_hidden: "eq.false", limit: "1" });
  assert.equal(models.length, 1, "ALI_VIDEO_RETALK_MODEL_REQUIRED");
  const publicResponse = await fetch(`${ORIGIN}/api/video/models?surface=digital-human`, { signal: AbortSignal.timeout(20_000) });
  const publicBody = await json(publicResponse);
  const publicModel = (Array.isArray(publicBody.models) ? publicBody.models as Json[] : []).find((row) => String(row.displayName) === String(models[0].name));
  assert.ok(publicResponse.ok && publicModel?.id, "ALI_VIDEO_RETALK_PUBLIC_MODEL_REQUIRED");

  const assets = await rest(runtime, "user_files", { select: "id,file_category,source,meta,created_at", user_id: `eq.${userId}`, source: "eq.digital-human-input", order: "created_at.desc", limit: "100" });
  const audio = assets.find((row) => row.file_category === "audio" && Math.abs(Number(object(row.meta).duration) - 120) < 0.01);
  const video = assets.find((row) => row.file_category === "video" && Number(object(row.meta).duration) >= 4 && Number(object(row.meta).duration) <= 6);
  assert.ok(audio && video, "OWNED_120_SECOND_AUDIO_AND_FACE_VIDEO_REQUIRED");

  const balanceBefore = Number((await api(token, "/api/cash/balance", { cache: "no-store" })).body.balance);
  const requestId = `digital-long-${randomUUID()}`;
  const runId = `digital-human-long-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const evidenceDir = path.resolve("artifacts", runId); await mkdir(evidenceDir, { recursive: true });
  const evidence = path.join(evidenceDir, "summary.json");
  console.log(JSON.stringify({ event: "submit-long", requestId, durationSeconds: 120, expectedSegments: 2, at: new Date().toISOString() }));
  let submission;
  try {
    submission = await api(token, "/api/digital-human/long-generate", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId },
      body: JSON.stringify({ modelId: String(publicModel.id), clientRequestId: requestId, personAssetId: String(video.id), audioAssetId: String(audio.id), durationChoice: "preserve_audio", resolution: "720p" }),
    });
  } catch {
    await writeFile(evidence, JSON.stringify({ requestId, state: "submission_unknown", replayed: false, credentialsPrinted: false }, null, 2));
    throw new Error(`LONG_SUBMISSION_RESPONSE_UNAVAILABLE:${requestId}`);
  }
  const taskId = String(submission.body.taskId || "");
  assert.ok(submission.response.ok && /^dhl_[a-f0-9]{40}$/u.test(taskId), `LONG_SUBMISSION_REJECTED:${submission.response.status}:${clean(submission.body.error || submission.body.error_code)}`);
  console.log(JSON.stringify({ event: "long-registered", requestId, taskId, status: submission.body.status, segmentCount: submission.body.segmentCount, at: new Date().toISOString() }));
  const trace: Json[] = [{ phase: "submit", at: new Date().toISOString(), httpStatus: submission.response.status, taskId, segmentCount: submission.body.segmentCount }];
  let terminal: Json = {};
  const deadline = Date.now() + 70 * 60_000;
  let lastPrint = 0;
  while (Date.now() < deadline) {
    const statusResult = await api(token, `/api/digital-human/long-status?${new URLSearchParams({ taskId })}`, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
    const status = String(statusResult.body.status || "unknown");
    const point = { phase: "poll", at: new Date().toISOString(), httpStatus: statusResult.response.status, status, progress: statusResult.body.progress, completedSegments: statusResult.body.completedSegments, message: clean(statusResult.body.message) };
    trace.push(point); await writeFile(evidence, JSON.stringify({ requestId, taskId, state: status, trace, replayed: false, credentialsPrinted: false }, null, 2));
    if (Date.now() - lastPrint > 30_000 || TERMINAL.has(status)) { console.log(JSON.stringify({ event: "poll-long", taskId, status, completedSegments: point.completedSegments, at: point.at })); lastPrint = Date.now(); }
    if (TERMINAL.has(status)) { terminal = statusResult.body; break; }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  assert.equal(terminal.status, "completed", `LONG_TASK_NOT_COMPLETED:${clean(terminal.message || terminal.error)}`);

  const parents = await rest(runtime, "digital_human_long_jobs", { select: "*", id: `eq.${taskId}`, user_id: `eq.${userId}`, limit: "1" });
  assert.equal(parents.length, 1, "LONG_PARENT_MISSING"); const parent = parents[0];
  const segments = await rest(runtime, "digital_human_long_segments", { select: "id,ordinal,start_seconds,end_seconds,duration_seconds,state,provider_task_id,result_asset_id,result_storage_url,result_sha256,attempt_count", parent_id: `eq.${taskId}`, user_id: `eq.${userId}`, order: "ordinal" });
  assert.equal(segments.length, 2, "LONG_SEGMENT_COUNT_INVALID");
  assert.ok(segments.every((row) => row.state === "completed" && row.provider_task_id && row.result_asset_id && String(row.result_storage_url).startsWith("object://tencent_cos/") && /^[a-f0-9]{64}$/u.test(String(row.result_sha256))), "LONG_SEGMENT_RECEIPT_INCOMPLETE");
  assert.equal(parent.state, "completed", "LONG_PARENT_STATE_INVALID");
  assert.equal(parent.billing_exempt, true, "LONG_ADMIN_EXEMPTION_MISSING");
  assert.equal(Number(parent.locked_price_yuan), 0, "LONG_ADMIN_PRICE_NOT_ZERO");
  assert.equal(Number(parent.charged_yuan), 0, "LONG_ADMIN_WALLET_CHARGED");
  assert.equal(parent.billing_state, "settled", "LONG_BILLING_NOT_SETTLED");
  assert.equal(parent.billing_operation_id, null, "LONG_ADMIN_OPERATION_CREATED");
  assert.ok(parent.merged_asset_id && String(parent.merged_storage_url).startsWith("object://tencent_cos/") && /^[a-f0-9]{64}$/u.test(String(parent.merged_sha256)), "LONG_MERGED_RECEIPT_INCOMPLETE");
  const mergedAssets = await rest(runtime, "user_files", { select: "id,user_id,file_category,storage_provider,file_size,content_type,source,meta", id: `eq.${String(parent.merged_asset_id)}`, user_id: `eq.${userId}`, limit: "1" });
  assert.equal(mergedAssets.length, 1, "LONG_MERGED_OWNED_ASSET_MISSING");
  assert.equal(mergedAssets[0].source, "video-generation", "LONG_MERGED_ASSET_SOURCE_INVALID");
  const operations = await rest(runtime, "wallet_operations", { select: "id", user_id: `eq.${userId}`, idempotency_key: `eq.${String(parent.billing_idempotency_key)}` });
  const ledger = await rest(runtime, "wallet_ledger_entries", { select: "id", user_id: `eq.${userId}`, idempotency_key: `eq.${String(parent.billing_idempotency_key)}` });
  assert.equal(operations.length, 0, "LONG_ADMIN_WALLET_OPERATION_CREATED"); assert.equal(ledger.length, 0, "LONG_ADMIN_LEDGER_CREATED");
  const historyResult = await api(token, "/api/digital-human/long-history?limit=30", { cache: "no-store" });
  const historyRow = (Array.isArray(historyResult.body.tasks) ? historyResult.body.tasks as Json[] : []).find((row) => row.id === taskId);
  assert.ok(historyResult.response.ok && historyRow, "LONG_HISTORY_MISSING");
  const alternateToken = await alternateLocalAccountToken(runtime, userId);
  const alternateStatus = await api(alternateToken, `/api/digital-human/long-status?${new URLSearchParams({ taskId })}`, { cache: "no-store" });
  assert.equal(alternateStatus.response.status, 404, "LONG_TASK_VISIBLE_TO_ANOTHER_ACCOUNT");
  const alternateHistory = await api(alternateToken, "/api/digital-human/long-history?limit=100", { cache: "no-store" });
  assert.ok(alternateHistory.response.ok && !(Array.isArray(alternateHistory.body.tasks) ? alternateHistory.body.tasks as Json[] : []).some((row) => row.id === taskId), "LONG_HISTORY_VISIBLE_TO_ANOTHER_ACCOUNT");
  const unauthenticatedStatus = await fetch(`${ORIGIN}/api/digital-human/long-status?${new URLSearchParams({ taskId })}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  assert.equal(unauthenticatedStatus.status, 401, "LONG_STATUS_ALLOWS_UNAUTHENTICATED_READ");
  const playback = await videoProbe(String(historyRow.resultUrl || terminal.resultUrl || ""));
  const balanceAfter = Number((await api(token, "/api/cash/balance", { cache: "no-store" })).body.balance);
  assert.equal(balanceAfter, balanceBefore, "LONG_ADMIN_BALANCE_CHANGED");
  const report = {
    runId, observedAt: new Date().toISOString(), localRuntimeOnly: true, requestId, taskId, state: "completed",
    providerSubmissionCount: 2, requestReplayCount: 0, totalDurationSeconds: Number(parent.total_duration_seconds), segmentCount: segments.length,
    segments, parent: { state: parent.state, billingState: parent.billing_state, billingExempt: parent.billing_exempt, lockedPriceYuan: Number(parent.locked_price_yuan), chargedYuan: Number(parent.charged_yuan), mergedAssetId: parent.merged_asset_id },
    mergedAsset: mergedAssets[0], historyPresent: true, accountIsolation: { alternateStatus: alternateStatus.response.status, alternateHistoryHidden: true, unauthenticatedStatus: unauthenticatedStatus.status }, playback, balanceBefore, balanceAfter, balanceUnchanged: true,
    walletOperationCount: operations.length, walletLedgerCount: ledger.length, credentialsPrinted: false, trace,
  };
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, taskId, evidence, segmentCount: segments.length, balanceUnchanged: true, providerSubmissionCount: 2, requestReplayCount: 0, credentialsPrinted: false }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: clean(error instanceof Error ? error.message : error), replayed: false, credentialsPrinted: false }));
  process.exitCode = 1;
});
