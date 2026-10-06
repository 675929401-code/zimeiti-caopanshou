#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffprobeStatic from "ffprobe-static";
import { SignJWT } from "jose";
import pg from "pg";
import { verifyLocalBuildFingerprintReceipt } from "./local-build-fingerprint.mjs";
import { currentSourceVersion } from "./local-revision.mjs";

const execFileAsync = promisify(execFile);
const REQUEST_ID = "extract-video-e2e-20260927-a2ae2e46-a911-4484-a57e-558dfd554c56";
const ATTEMPT_ID = "61de6d4447c99c32ae9b947962443e6b4a75f984841b76881fdd7b81885393c9";
const USER_ID = "b5cccb94-1d77-4e14-9391-fb3e6f823486";
const PAYLOAD_FINGERPRINT = "5a5af932eedb54506874f5c3391f33fcbc0392de32c71a2fa098c0e6285d5d8a";
const SAMPLE_URL = "https://v.douyin.com/h1wY2hTAbmM/";
const WALLET_KEY = `extract:${REQUEST_ID}:ppt6-video`;
const origin = "http://127.0.0.1:5000";
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const outputDir = path.resolve(".codex-evidence", "extract-checkpoint-recovery");
const markerPath = path.join(outputDir, "checkpoint-recovery-dispatched.json");
const reportPath = path.join(outputDir, "report.json");
const downloadPath = path.join(outputDir, "delivered-video.tmp.mp4");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const jsonHash = (value) => hash(JSON.stringify(canonical(value)));
const ffprobePath = typeof ffprobeStatic === "string" ? ffprobeStatic : ffprobeStatic.path;
const collectAbsoluteHttpValues = (value, location = "$", found = []) => {
  if (typeof value === "string") {
    if (/^https?:\/\//iu.test(value.trim())) found.push(location);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAbsoluteHttpValues(item, `${location}[${index}]`, found));
    return found;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nested]) => collectAbsoluteHttpValues(nested, `${location}.${key}`, found));
  }
  return found;
};

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-existing-checkpoint-only"), "CHECKPOINT_ONLY_CONFIRMATION_REQUIRED");
await fs.mkdir(outputDir, { recursive: true });
try {
  await fs.access(markerPath);
  throw new Error("CHECKPOINT_RECOVERY_ALREADY_DISPATCHED_DO_NOT_REPEAT");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.ok(typeof runtime.jwtSecret === "string" && runtime.jwtSecret.length >= 32, "LOCAL_JWT_SECRET_REQUIRED");
assert.ok(ffprobePath, "FFPROBE_REQUIRED");

const db = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-extraction-checkpoint-recovery-once",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
const report = {
  schemaVersion: 1,
  passed: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  phase: "database-connect",
  origin,
  target: "127.0.0.1:54322/zimeiti_local",
  requestId: REQUEST_ID,
  attemptId: ATTEMPT_ID,
  postAttemptsThisRecovery: 0,
  providerHandlerReached: null,
  retryCount: 0,
  rawProviderUrlsExposedToClient: null,
  assertions: {},
};

const attemptRow = async () => (await db.query(
  `SELECT record_id,user_id,client_request_id,request_kind,payload_fingerprint,state,http_status,response,
          request_snapshot,provider_checkpoint,provider_evidence,billing_evidence,error_code,error_message,updated_at
     FROM public.extraction_attempts WHERE record_id=$1`,
  [ATTEMPT_ID],
)).rows[0];
const accounting = async () => {
  const [wallet, revenue, user] = await Promise.all([
    db.query(
      "SELECT operation_id,delta,balance_before,balance_after FROM public.wallet_ledger_entries WHERE user_id=$1 AND idempotency_key=$2 ORDER BY created_at,id",
      [USER_ID, WALLET_KEY],
    ),
    db.query(
      `SELECT model_id,task_id,cost_price,selling_price,profit,billing_exempt,is_admin,record_type,cash_charged,credits_charged
         FROM public.revenue_records WHERE user_id=$1 AND task_id=$2 AND record_type='extract' ORDER BY created_at,id`,
      [USER_ID, WALLET_KEY],
    ),
    db.query("SELECT cash_balance,credits FROM public.users WHERE id=$1", [USER_ID]),
  ]);
  return { wallet: wallet.rows, revenue: revenue.rows, balance: user.rows[0] };
};
const fetchJson = async (url, init = {}) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs || 30_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { invalidJson: true }; }
  return { response, body };
};

try {
  await db.connect();
  report.phase = "runtime-identity";
  const sourceIdentity = verifyLocalBuildFingerprintReceipt(process.cwd(), ".next/local-source-fingerprint.v1.json");
  const sourceVersion = currentSourceVersion(process.cwd());
  const diskBuildId = (await fs.readFile(path.resolve(".next", "BUILD_ID"), "utf8")).trim();
  assert.ok(/^[A-Za-z0-9_-]{8,128}$/u.test(diskBuildId), "LOCAL_BUILD_ID_INVALID");
  assert.equal(sourceIdentity.buildId, diskBuildId, "LOCAL_BUILD_RECEIPT_ID_MISMATCH");
  assert.match(sourceIdentity.fingerprint, /^[a-f0-9]{64}$/u, "LOCAL_SOURCE_FINGERPRINT_INVALID");
  assert.ok(Number.isInteger(sourceIdentity.fileCount) && sourceIdentity.fileCount > 0, "LOCAL_SOURCE_FILE_COUNT_INVALID");
  const version = await fetchJson(`${origin}/api/version`);
  assert.equal(version.response.status, 200, "LOCAL_PREVIEW_UNAVAILABLE");
  assert.equal(version.body?.buildId, diskBuildId, "SERVED_BUILD_ID_DOES_NOT_MATCH_CURRENT_SOURCE");
  assert.equal(version.body?.version, diskBuildId, "SERVED_RUNTIME_VERSION_DOES_NOT_MATCH_BUILD_ID");
  assert.equal(version.body?.env, "PROD", "SERVED_RUNTIME_MUST_BE_PRODUCTION_BUILD");
  assert.equal(version.body?.sourceVersion, sourceVersion.sourceVersion, "SERVED_SOURCE_VERSION_MISMATCH");
  assert.equal(version.body?.revision, sourceVersion.revision, "SERVED_SOURCE_REVISION_MISMATCH");
  assert.equal(version.body?.sourceDigest, sourceVersion.sourceDigest, "SERVED_SOURCE_DIGEST_MISMATCH");
  const versionCacheControl = version.response.headers.get("cache-control") || "";
  for (const directive of ["no-store", "no-cache", "must-revalidate", "proxy-revalidate"]) {
    assert.ok(versionCacheControl.toLowerCase().includes(directive), `VERSION_CACHE_CONTROL_MISSING:${directive}`);
  }
  assert.equal(version.response.headers.get("pragma")?.toLowerCase(), "no-cache", "VERSION_PRAGMA_INVALID");
  assert.equal(version.response.headers.get("expires"), "0", "VERSION_EXPIRES_INVALID");
  report.servedVersion = {
    sourceVersion: sourceVersion.sourceVersion,
    revision: sourceVersion.revision,
    sourceDigest: sourceVersion.sourceDigest,
    buildId: diskBuildId,
  };
  report.runtimeIdentity = {
    buildId: diskBuildId,
    sourceFingerprint: sourceIdentity.fingerprint,
    sourceFileCount: sourceIdentity.fileCount,
    runningLatest: true,
  };
  report.assertions.currentSourceBuildAndServedRuntimeMatched = true;

  report.phase = "checkpoint-preflight";
  const before = await attemptRow();
  assert.ok(before, "EXTRACTION_ATTEMPT_MISSING");
  assert.equal(before.record_id, ATTEMPT_ID);
  assert.equal(before.user_id, USER_ID);
  assert.equal(before.client_request_id, REQUEST_ID);
  assert.equal(before.request_kind, "single");
  assert.equal(before.payload_fingerprint, PAYLOAD_FINGERPRINT);
  assert.equal(before.state, "running");
  assert.equal(before.http_status, null);
  assert.equal(before.response, null);
  assert.equal(before.request_snapshot?.schema, "extraction_request_snapshot.v1");
  assert.equal(before.request_snapshot?.payload?.extraction_mode, "video");
  assert.deepEqual(before.request_snapshot?.payload?.links, [SAMPLE_URL]);
  const checkpointResult = before.provider_checkpoint?.result;
  assert.equal(checkpointResult?.schema, "extract_video_ppt6_result.v1");
  assert.ok(typeof before.provider_checkpoint?.result_saved_at === "string");
  assert.equal(checkpointResult.videos?.length, 1);
  assert.equal(checkpointResult.videos.filter((video) => video?.success === true).length, 1);
  assert.equal(checkpointResult.unitPrice, 0, "CHECKPOINT_UNIT_PRICE_MUST_BE_ZERO");
  assert.equal(checkpointResult.costPrice, 0, "CHECKPOINT_COST_PRICE_MUST_BE_ZERO");
  assert.equal(checkpointResult.billingExempt, false, "CHECKPOINT_MUST_USE_ORDINARY_ZERO_PRICE_ACCOUNTING");
  assert.equal(checkpointResult.userRole, "admin", "CHECKPOINT_OWNER_ROLE_MISMATCH");
  const checkpointHashBefore = jsonHash(checkpointResult);
  const checkpointSavedAtBefore = before.provider_checkpoint.result_saved_at;
  const beforeAccounting = await accounting();
  assert.equal(beforeAccounting.wallet.length, 0, "WALLET_ENTRY_EXISTS_BEFORE_RECOVERY");
  assert.equal(beforeAccounting.revenue.length, 0, "REVENUE_ENTRY_EXISTS_BEFORE_RECOVERY");
  report.assertions.exactRunningCheckpointMatched = true;
  report.assertions.zeroPriceAdminCheckpointVerifiedBeforeDispatch = true;
  report.checkpoint = { resultHash: checkpointHashBefore, resultSavedAt: checkpointSavedAtBefore };
  assert.notEqual(beforeAccounting.balance?.cash_balance, null, "BALANCE_CASH_MISSING_BEFORE_RECOVERY");
  assert.notEqual(beforeAccounting.balance?.cash_balance, undefined, "BALANCE_CASH_MISSING_BEFORE_RECOVERY");
  assert.notEqual(beforeAccounting.balance?.credits, null, "BALANCE_CREDITS_MISSING_BEFORE_RECOVERY");
  assert.notEqual(beforeAccounting.balance?.credits, undefined, "BALANCE_CREDITS_MISSING_BEFORE_RECOVERY");
  report.balanceBefore = {
    cash: String(beforeAccounting.balance.cash_balance),
    credits: String(beforeAccounting.balance.credits),
  };

  const identity = (await db.query(
    "SELECT id,username,display_name,role,is_active,status FROM public.users WHERE id=$1",
    [USER_ID],
  )).rows[0];
  assert.ok(identity && identity.role === "admin" && identity.is_active === true && identity.status === "active", "TARGET_ACCOUNT_NOT_ACTIVE_ADMIN");
  const session = (await db.query(
    `SELECT session_id FROM public.user_auth_sessions
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [USER_ID],
  )).rows[0];
  assert.ok(session?.session_id, "TARGET_ACCOUNT_HAS_NO_ACTIVE_SESSION");
  const token = await new SignJWT({
    userId: identity.id,
    username: identity.username,
    role: identity.role,
    displayName: identity.display_name || identity.username,
    sessionId: session.session_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("20m")
    .sign(new TextEncoder().encode(runtime.jwtSecret));
  const me = await fetchJson(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.response.status, 200, "TARGET_SESSION_NOT_ACCEPTED_BY_APP");
  assert.equal(me.body?.user?.id, USER_ID, "TARGET_SESSION_USER_MISMATCH");
  report.assertions.sameOwnerSessionVerified = true;

  report.phase = "checkpoint-recovery-post";
  await fs.writeFile(markerPath, `${JSON.stringify({
    requestId: REQUEST_ID,
    attemptId: ATTEMPT_ID,
    buildId: diskBuildId,
    sourceFingerprint: sourceIdentity.fingerprint,
    recoveryMode: "checkpoint-only",
    dispatchedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: "wx" });
  report.postAttemptsThisRecovery = 1;
  const recovered = await fetchJson(`${origin}/api/extract`, {
    method: "POST",
    timeoutMs: 240_000,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": REQUEST_ID,
      "X-Extraction-Recovery-Mode": "checkpoint-only",
    },
    body: JSON.stringify({
      links: [SAMPLE_URL],
      extraction_mode: "video",
      client_request_id: REQUEST_ID,
    }),
  });
  report.api = {
    status: recovered.response.status,
    success: recovered.body?.success === true,
    source: recovered.body?.source || null,
    charged: recovered.body?.charged,
    price: recovered.body?.price,
    replayed: recovered.response.headers.get("x-extraction-replayed"),
    recoveryMode: recovered.response.headers.get("x-extraction-recovery-mode"),
    providerHandler: recovered.response.headers.get("x-extraction-provider-handler"),
    attemptHeaderMatched: recovered.response.headers.get("x-extraction-attempt-id") === ATTEMPT_ID,
    errorCode: recovered.body?.error_code || recovered.body?.code || null,
  };
  assert.equal(report.api.recoveryMode, "checkpoint-only", "CHECKPOINT_ONLY_RESPONSE_PROOF_MISSING");
  assert.equal(report.api.providerHandler, "skipped", "PROVIDER_HANDLER_SKIP_PROOF_MISSING");
  report.providerHandlerReached = false;
  assert.match(recovered.response.headers.get("cache-control") || "", /no-store/iu, "RECOVERY_RESPONSE_CACHE_CONTROL_INVALID");
  assert.equal(recovered.response.status, 200, `CHECKPOINT_RECOVERY_HTTP_${recovered.response.status}:${report.api.errorCode || "UNKNOWN"}`);
  assert.equal(recovered.body?.success, true, "CHECKPOINT_RECOVERY_NOT_SUCCESSFUL");
  assert.equal(recovered.body?.source, "ppt6");
  assert.equal(recovered.body?.charged, false);
  assert.equal(recovered.body?.price, 0);
  assert.equal(recovered.body?.billing_replayed, false);
  assert.equal(report.api.replayed, "true");
  assert.equal(report.api.attemptHeaderMatched, true);
  assert.equal(recovered.body?.videos?.length, 1);
  const delivered = recovered.body.videos[0];
  assert.equal(delivered.success, true);
  assert.ok(typeof delivered.temporary_url === "string" && delivered.temporary_url.startsWith("/api/extract/local-video?"));
  for (const privateField of ["url", "download_url", "cover", "asset_id"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(delivered, privateField), false, `PRIVATE_MEDIA_FIELD_EXPOSED:${privateField}`);
  }
  report.assertions.replayedCheckpointWithoutProviderSubmission = true;
  report.assertions.onlySignedLocalDeliveryExposed = true;

  const range = await fetch(`${origin}${delivered.temporary_url}`, {
    headers: { Range: "bytes=0-1023" },
    signal: AbortSignal.timeout(30_000),
  });
  const rangeBytes = Buffer.from(await range.arrayBuffer());
  assert.equal(range.status, 206);
  assert.equal(rangeBytes.length, 1024);
  assert.match(range.headers.get("content-type") || "", /^video\/mp4/iu);
  assert.match(range.headers.get("content-range") || "", /^bytes 0-1023\/\d+$/u);
  assert.equal(range.headers.get("content-length"), "1024");
  assert.equal(range.headers.get("accept-ranges")?.toLowerCase(), "bytes");
  assert.match(range.headers.get("cache-control") || "", /private\s*,\s*no-store/iu);
  assert.equal(range.headers.get("x-content-type-options")?.toLowerCase(), "nosniff");
  report.rangeDelivery = {
    status: range.status,
    bytes: rangeBytes.length,
    contentType: range.headers.get("content-type"),
    contentRange: range.headers.get("content-range"),
  };

  const downloadUrl = new URL(delivered.temporary_url, origin);
  downloadUrl.searchParams.set("mode", "download");
  const download = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type") || "", /^video\/mp4/iu);
  assert.match(download.headers.get("content-disposition") || "", /^attachment/iu);
  assert.equal(download.headers.get("accept-ranges")?.toLowerCase(), "bytes");
  assert.match(download.headers.get("cache-control") || "", /private\s*,\s*no-store/iu);
  assert.equal(download.headers.get("x-content-type-options")?.toLowerCase(), "nosniff");
  const contentLength = Number(download.headers.get("content-length"));
  assert.ok(Number.isSafeInteger(contentLength) && contentLength >= 1_000 && contentLength <= 300 * 1024 * 1024);
  const videoBytes = Buffer.from(await download.arrayBuffer());
  assert.equal(videoBytes.length, contentLength);
  await fs.writeFile(downloadPath, videoBytes);
  const probe = await execFileAsync(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height",
    "-of", "json",
    downloadPath,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const probeJson = JSON.parse(probe.stdout);
  const videoStream = probeJson.streams?.find((stream) => stream.codec_type === "video");
  assert.ok(videoStream?.codec_name, "VIDEO_STREAM_NOT_DECODABLE");
  assert.ok(Number(probeJson.format?.duration) > 0, "VIDEO_DURATION_INVALID");
  report.fullDelivery = {
    status: download.status,
    bytes: videoBytes.length,
    sha256: hash(videoBytes),
    codec: videoStream.codec_name,
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    durationSeconds: Number(probeJson.format.duration),
  };
  report.assertions.rangePlaybackAndFullDownloadVerified = true;

  const history = await fetchJson(`${origin}/api/extract/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(history.response.status, 200, "EXTRACTION_HISTORY_UNAVAILABLE");
  const historyRecord = history.body?.records?.find((record) => record.id === ATTEMPT_ID);
  assert.ok(historyRecord, "RECOVERED_ATTEMPT_MISSING_FROM_HISTORY");
  assert.equal(historyRecord.clientRequestId, REQUEST_ID);
  assert.equal(historyRecord.status, "success");
  assert.equal(historyRecord.mode, "video");
  assert.equal(historyRecord.result?.videos?.length, 1);
  const exposedAbsoluteHttpValues = collectAbsoluteHttpValues({ api: recovered.body, historyResult: historyRecord.result });
  assert.deepEqual(exposedAbsoluteHttpValues, [], `RAW_PROVIDER_URL_EXPOSED:${exposedAbsoluteHttpValues.join(",")}`);
  report.rawProviderUrlsExposedToClient = false;
  report.assertions.noRawProviderUrlsExposedToClient = true;
  report.assertions.historyReadbackVerified = true;

  const after = await attemptRow();
  const afterAccounting = await accounting();
  assert.equal(after.state, "succeeded");
  assert.equal(after.http_status, 200);
  assert.equal(after.billing_evidence?.charged, false);
  assert.equal(after.billing_evidence?.price, 0);
  assert.equal(jsonHash(after.response), jsonHash(recovered.body));
  assert.equal(jsonHash(after.provider_checkpoint.result), checkpointHashBefore);
  assert.equal(after.provider_checkpoint.result_saved_at, checkpointSavedAtBefore);
  assert.equal(afterAccounting.wallet.length, 0, "ZERO_PRICE_RECOVERY_CREATED_WALLET_ENTRY");
  assert.equal(afterAccounting.revenue.length, 1, "ZERO_PRICE_RECOVERY_REVENUE_COUNT_MISMATCH");
  const revenue = afterAccounting.revenue[0];
  assert.equal(revenue.model_id, "extract_video");
  assert.equal(revenue.task_id, WALLET_KEY);
  assert.equal(revenue.record_type, "extract");
  assert.equal(revenue.billing_exempt, false, "ZERO_PRICE_RECOVERY_MUST_NOT_USE_BILLING_EXEMPTION");
  assert.equal(revenue.is_admin, true, "ZERO_PRICE_RECOVERY_OWNER_ROLE_AUDIT_MISMATCH");
  for (const field of ["cost_price", "selling_price", "profit", "cash_charged", "credits_charged"]) {
    assert.notEqual(revenue[field], null, `MISSING_REVENUE_FIELD:${field}`);
    assert.notEqual(revenue[field], undefined, `MISSING_REVENUE_FIELD:${field}`);
    const numericValue = Number(revenue[field]);
    assert.ok(Number.isFinite(numericValue), `INVALID_REVENUE_FIELD:${field}`);
    assert.equal(numericValue, 0, `NON_ZERO_REVENUE_FIELD:${field}`);
  }
  assert.notEqual(afterAccounting.balance?.cash_balance, null, "BALANCE_CASH_MISSING_AFTER_RECOVERY");
  assert.notEqual(afterAccounting.balance?.cash_balance, undefined, "BALANCE_CASH_MISSING_AFTER_RECOVERY");
  assert.notEqual(afterAccounting.balance?.credits, null, "BALANCE_CREDITS_MISSING_AFTER_RECOVERY");
  assert.notEqual(afterAccounting.balance?.credits, undefined, "BALANCE_CREDITS_MISSING_AFTER_RECOVERY");
  const balanceAfter = {
    cash: String(afterAccounting.balance.cash_balance),
    credits: String(afterAccounting.balance.credits),
  };
  assert.deepEqual(balanceAfter, report.balanceBefore, "ZERO_PRICE_RECOVERY_CHANGED_BALANCE");
  report.balanceAfter = balanceAfter;
  report.accounting = { walletEntries: 0, revenueRecords: 1, allAmountsZero: true };
  report.assertions.checkpointImmutableAndAttemptFinalized = true;
  report.assertions.zeroPriceAccountingVerified = true;
  report.phase = "complete";
  report.passed = true;
} catch (error) {
  report.failure = {
    phase: report.phase,
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/gu, "[url]").slice(0, 500),
  };
  process.exitCode = 2;
} finally {
  await fs.rm(downloadPath, { force: true }).catch(() => undefined);
  await db.end().catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({
  passed: report.passed,
  requestId: report.requestId,
  attemptId: report.attemptId,
  postAttemptsThisRecovery: report.postAttemptsThisRecovery,
  providerHandlerReached: report.providerHandlerReached,
  rawProviderUrlsExposedToClient: report.rawProviderUrlsExposedToClient,
  assertions: report.assertions,
  failure: report.failure || null,
  reportPath,
}, null, 2));
