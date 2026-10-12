#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SignJWT } from "jose";
import { parse as parseDotenv } from "dotenv";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://127.0.0.1:5000";
const FIXED_REAL_IP = "127.0.0.11";
const AGENT_ID = "agent-1786843330392-emdjv2";
const AGENT_NAME = "3D故事导演｜高能版";
const REQUIRED_NAVIGATION_KEY = "task:影像编导";
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const RUNTIME_PATH = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 3) => value == null ? null : Number(Number(value).toFixed(digits));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function llmPayloadFingerprint(body) {
  const payload = Object.fromEntries(Object.entries(body).filter(([key]) => !["client_request_id", "userId"].includes(key)));
  return sha256(JSON.stringify(canonicalize(payload)));
}

function sameRuntimeIdentity(left, right) {
  return Boolean(left && right
    && left.sourceVersion === right.sourceVersion
    && left.buildId === right.buildId
    && left.diskSourceVersion === right.diskSourceVersion
    && left.sourceFingerprint === right.sourceFingerprint
    && left.runningLatest === true && right.runningLatest === true);
}

export function parseSseReadEvidence(value, expectedClientRequestId, atMs) {
  if (!String(value).startsWith("[LLM_SSE_READ] ")) return null;
  try {
    const event = JSON.parse(value.slice("[LLM_SSE_READ] ".length));
    if (event.schemaVersion !== 1 || !expectedClientRequestId || event.clientRequestId !== expectedClientRequestId) return null;
    return { atMs, ordinal: event.ordinal, bytes: event.bytes, gapMs: event.gapMs,
      cumulativeContentChars: event.cumulativeContentChars, terminal: event.terminal, failed: event.failed };
  } catch { return null; }
}

export function auditSseEvidence(samples, minimumContentGrowthSamples = 2) {
  const safeSamples = Array.isArray(samples) ? samples : [];
  const terminalIndices = safeSamples.flatMap((item, index) => item?.terminal === true ? [index] : []);
  const terminalReadAuditable = terminalIndices.length === 1 && terminalIndices[0] === safeSamples.length - 1;
  const preTerminalSamples = safeSamples.slice(0, terminalIndices[0] ?? safeSamples.length);
  const contentBearingSamples = preTerminalSamples.filter((item) => Number(item?.cumulativeContentChars) > 0);
  const distinctContentLengths = new Set(contentBearingSamples.map((item) => Number(item.cumulativeContentChars))).size;
  const rawSamplesAuditable = safeSamples.length > 0 && safeSamples.every((item) =>
    Number.isFinite(item?.atMs) && Number(item.atMs) >= 0
    && Number.isInteger(item?.ordinal) && Number(item.ordinal) > 0
    && Number.isFinite(item?.bytes) && Number(item.bytes) >= 0
    && Number.isFinite(item?.gapMs) && Number(item.gapMs) >= 0
    && Number.isFinite(item?.cumulativeContentChars) && Number(item.cumulativeContentChars) >= 0
    && typeof item?.terminal === "boolean" && typeof item?.failed === "boolean" && !item.failed);
  const orderedSamplesAuditable = safeSamples.every((item, index) => index === 0
    || (Number(item.ordinal) > Number(safeSamples[index - 1].ordinal)
      && Number(item.atMs) >= Number(safeSamples[index - 1].atMs)
      && Number(item.cumulativeContentChars) >= Number(safeSamples[index - 1].cumulativeContentChars)));
  const intervalSamples = safeSamples.slice(1).map((item, index) => ({
    previousReadOrdinal: Number(item.ordinal) - 1,
    readOrdinal: Number(item.ordinal),
    previousSampledOrdinal: Number(safeSamples[index].ordinal),
    gapMs: Number(item.gapMs),
    observedAtMs: Number(item.atMs),
    cumulativeContentChars: Number(item.cumulativeContentChars),
  }));
  const contentBearingSampleExists = contentBearingSamples.length > 0;
  const thresholdAuditable = Number.isSafeInteger(minimumContentGrowthSamples) && minimumContentGrowthSamples >= 1;
  const sampledNetworkHasContent = thresholdAuditable && distinctContentLengths >= minimumContentGrowthSamples;
  const chunkIntervalSamplesAuditable = intervalSamples.length > 0 && rawSamplesAuditable && orderedSamplesAuditable
    && intervalSamples.every((item) => item.readOrdinal > 1 && item.previousReadOrdinal === item.readOrdinal - 1
      && Number.isFinite(item.gapMs) && item.gapMs >= 0
      && Number.isFinite(item.observedAtMs) && item.observedAtMs >= 0);
  return {
    contentBearingSampleExists,
    sampledNetworkHasContent,
    rawSamplesAuditable,
    orderedSamplesAuditable,
    terminalReadAuditable,
    networkIncrementalEvidence: distinctContentLengths >= 2 && terminalReadAuditable && rawSamplesAuditable && orderedSamplesAuditable,
    chunkIntervalSampleCount: intervalSamples.length,
    chunkIntervalSamplesAuditable,
    contentBearingSampleCount: contentBearingSamples.length,
    distinctContentLengths,
    intervalSamples,
    passed: contentBearingSampleExists && sampledNetworkHasContent && chunkIntervalSamplesAuditable && terminalReadAuditable,
  };
}

export function parseArgs(argv) {
  const options = {
    execute: false,
    case: "all",
    quoteReceipt: "",
    quoteReceiptSha256: "",
    expectedSourceVersion: "",
    expectedBuildId: "",
    userId: "",
    actorRole: "student",
    minimumCredits: 300,
  };
  let caseSeen = false;
  let actorRoleSeen = false;
  for (const argument of argv) {
    if (argument.startsWith("--case=")) {
      assert.equal(caseSeen, false, "DUPLICATE_CASE_SELECTOR");
      caseSeen = true; options.case = argument.slice(7); selectCases(options.case);
    }
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--expected-source-version=")) options.expectedSourceVersion = argument.slice(argument.indexOf("=") + 1).trim();
    else if (argument.startsWith("--expected-build-id=")) options.expectedBuildId = argument.slice(argument.indexOf("=") + 1).trim();
    else if (argument.startsWith("--user-id=")) options.userId = argument.slice(argument.indexOf("=") + 1).trim();
    else if (argument.startsWith("--actor-role=")) { assert.equal(actorRoleSeen,false,"DUPLICATE_ACTOR_ROLE"); actorRoleSeen=true; options.actorRole=argument.slice(argument.indexOf("=")+1).trim(); }
    else if (argument.startsWith("--quote-receipt=")) options.quoteReceipt = argument.slice(argument.indexOf("=")+1).trim();
    else if (argument.startsWith("--quote-receipt-sha256=")) options.quoteReceiptSha256 = argument.slice(argument.indexOf("=")+1).trim();
    else if (argument.startsWith("--minimum-credits=")) options.minimumCredits = Number(argument.slice(argument.indexOf("=") + 1));
    else throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
  }
  if (options.quoteReceipt || options.quoteReceiptSha256) {
    assert.ok(options.quoteReceipt && /^[a-f0-9]{64}$/u.test(options.quoteReceiptSha256), "QUOTE_RECEIPT_AND_SHA_REQUIRED");
    assert.notEqual(options.case, "all", "QUOTE_RECEIPT_SINGLE_CASE_REQUIRED");
  }
  assert.ok(["student","admin"].includes(options.actorRole),"UNSUPPORTED_ACTOR_ROLE");
  if (options.actorRole==="admin") assert.ok(options.userId,"ADMIN_EXPLICIT_USER_ID_REQUIRED");
  if (options.execute && !options.help) {
    assert.ok(options.userId, "EXECUTE_EXPLICIT_USER_ID_REQUIRED");
    assert.ok(options.expectedSourceVersion, "EXECUTE_SOURCE_PIN_REQUIRED");
    assert.ok(options.expectedBuildId, "EXECUTE_BUILD_PIN_REQUIRED");
  }
  assert.ok(Number.isFinite(options.minimumCredits) && options.minimumCredits >= 0, "INVALID_MINIMUM_CREDITS");
  return options;
}

export function buildPlanReport(options, now = new Date()) {
  const executeArguments = [
    "node scripts/verify-chat-streaming-experience-live.mjs --execute",
    options.expectedSourceVersion ? `--expected-source-version=${options.expectedSourceVersion}` : "",
    options.expectedBuildId ? `--expected-build-id=${options.expectedBuildId}` : "",
    options.userId ? `--user-id=${options.userId}` : "",
    `--actor-role=${options.actorRole || "student"}`,
    `--case=${options.case || "all"}`,
    options.quoteReceipt ? `--quote-receipt=${options.quoteReceipt}` : "",
    options.quoteReceiptSha256 ? `--quote-receipt-sha256=${options.quoteReceiptSha256}` : "",
    options.minimumCredits !== 300 ? `--minimum-credits=${options.minimumCredits}` : "",
  ].filter(Boolean);
  return {
    schemaVersion: 1,
    mode: "plan",
    status: "planned",
    startedAt: now.toISOString(),
    target: { agentId: AGENT_ID, agentName: AGENT_NAME },
    coverage: caseCoverage(selectCases(options.case)),
    runtimeGate: {
      expectedSourceVersion: options.expectedSourceVersion || null,
      expectedBuildId: options.expectedBuildId || null,
      runningLatestRequiredAtExecution: true,
    },
    constraints: {
      expectedBrowserLlmPosts: selectCases(options.case).length,
      harnessAutomaticResubmissions: 0,
      providerDispatchCeiling: null,
      ordinaryUserUi: options.actorRole !== "admin",
      ordinaryMemberAdmissionVerified: false,
      actorRole: options.actorRole || "student",
      actualLlmPosts: 0,
      providerCalls: 0,
      networkRequests: 0,
      fileWrites: 0,
      databaseWrites: 0,
    },
    plan: {
      paidExecutionRequired: true,
      command: executeArguments.join(" "),
      minimumCredits: options.minimumCredits,
      unmetArgumentPrerequisites: [!options.userId && "explicit_user_id", !options.expectedSourceVersion && "source_version_pin", !options.expectedBuildId && "build_id_pin"].filter(Boolean),
      spendingAuthorized: false,
      minimumCreditsMeaning: "Eligibility floor, never a spending cap; explicit independent finite budget approval is still required.",
      note: "Plan mode is static: no runtime/database preflight, network request, evidence artifact, authentication session, conversation, provider call, billing write, or browser submission is created.",
    },
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/verify-chat-streaming-experience-live.mjs",
    "  node scripts/verify-chat-streaming-experience-live.mjs --execute [options]",
    "",
    "Default mode is a static zero-network, zero-write plan. Only --execute performs runtime preflight and may submit selected paid samples, each in a new independent conversation.",
    "Options:",
    "  --case=all|short-answer|long-list|markdown-code (default all)",
    "  --actor-role=student|admin (default student; admin requires exact --user-id; no ordinary-member admission claim)",
    "  --quote-receipt=<path> --quote-receipt-sha256=<sha256> optional approved single-case drift binding; never spend authorization",
    "  --expected-source-version=<value>  required for execute; lock the current sourceVersion",
    "  --expected-build-id=<value>        required for execute; lock the current Build ID",
    "  --user-id=<uuid>                   require one eligible ordinary local member",
    "  --minimum-credits=<number>         preflight available-credit floor (default 300)",
  ].join("\n");
}

function timestampForPath() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08-00").replaceAll(":", "-");
}

function safeJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function restUrl(runtime, table, params = {}) {
  const url = new URL(`/rest/v1/${table}`, runtime.supabaseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function serviceHeaders(runtime) {
  return { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };
}

async function restRows(runtime, table, params) {
  const response = await fetch(restUrl(runtime, table, params), {
    headers: serviceHeaders(runtime),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  assert.ok(response.ok && Array.isArray(payload), `REST_READ_FAILED:${table}:${response.status}`);
  return payload;
}

async function apiJson(pathname, token = "", options = {}) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    method: options.method || "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Real-IP": FIXED_REAL_IP,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function runtimeIdentity(options) {
  const response = await fetch(`${ORIGIN}/api/version`, {
    headers: { "X-Real-IP": FIXED_REAL_IP },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const runtimeVersion = await response.json().catch(() => null);
  assert.equal(response.status, 200, "VERSION_READ_FAILED");
  assert.ok(runtimeVersion?.sourceVersion && runtimeVersion?.buildId, "RUNTIME_IDENTITY_INCOMPLETE");
  const [diskVersionText, diskBuildId, receiptText] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public/version.json"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "BUILD_ID"), "utf8").then((value) => value.trim()),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  const diskVersion = JSON.parse(diskVersionText);
  const receipt = JSON.parse(receiptText);
  const fingerprint = computeLocalBuildFingerprint(PROJECT_ROOT);
  const runningLatest = diskVersion.sourceVersion === runtimeVersion.sourceVersion
    && runtimeVersion.buildId === diskBuildId
    && receipt.buildId === diskBuildId
    && receipt.fingerprint === fingerprint.fingerprint
    && receipt.fileCount === fingerprint.fileCount;
  assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");
  if (options.expectedSourceVersion) assert.equal(runtimeVersion.sourceVersion, options.expectedSourceVersion, "EXPECTED_SOURCE_VERSION_MISMATCH");
  if (options.expectedBuildId) assert.equal(runtimeVersion.buildId, options.expectedBuildId, "EXPECTED_BUILD_ID_MISMATCH");
  return {
    origin: ORIGIN,
    sourceVersion: runtimeVersion.sourceVersion,
    buildId: runtimeVersion.buildId,
    diskSourceVersion: diskVersion.sourceVersion,
    sourceFingerprint: fingerprint.fingerprint,
    sourceFingerprintCurrent: true,
    matchingBuildDirectory: ".next",
    runningLatest,
  };
}

export function eligibleAcceptanceActor(user,options,now=Date.now()) {
  const role=options.actorRole || "student";
  if (!user?.id || !user.username || user.role!==role || user.is_active!==true || (user.status!=null && user.status!=="active") || (options.userId && user.id!==options.userId)) return false;
  const available=Number(user.credits || 0)-Number(user.credits_reserved || 0);
  if (!Number.isFinite(available) || available<options.minimumCredits) return false;
  if (role==="admin") return Boolean(options.userId && user.id===options.userId);
  const allowed=Array.isArray(user.allowed_categories)?user.allowed_categories.map(String):[];
  return user.member_status==="active" && (!user.member_expires_at || Date.parse(user.member_expires_at)>now) && allowed.includes(REQUIRED_NAVIGATION_KEY);
}
export function acceptanceActorIdentity(actor,actorRole= "student") {
  assert.ok(["student","admin"].includes(actorRole) && actor.role===actorRole,"ACTOR_ROLE_MISMATCH");
  return {id:actor.id,username:actor.username,displayName:actor.display_name || actor.username,role:actorRole};
}
export function assertAcceptanceAuthIdentity(payload,actor,actorRole="student") {
  assert.equal(payload?.user?.id,actor.id,"AUTH_ACTOR_ID_MISMATCH");
  assert.equal(payload?.user?.role,actorRole,"AUTH_ACTOR_ROLE_MISMATCH");
}
async function readPreflight(runtime, options) {
  const agents = await restRows(runtime, "agents", {
    select: "id,name,category,model_id,model,is_active,user_access,deleted_at,updated_at,system_prompt,config_revision",
    id: `eq.${AGENT_ID}`,
    limit: "1",
  });
  const agent = agents[0];
  assert.equal(agent?.name, AGENT_NAME, "TARGET_AGENT_DB_MISMATCH");
  assert.equal(agent?.is_active, true, "TARGET_AGENT_INACTIVE");
  assert.ok(agent?.model_id, "TARGET_AGENT_PERSISTENT_MODEL_REQUIRED");
  assert.ok(typeof agent.system_prompt === "string" && agent.system_prompt.trim(), "TARGET_AGENT_PUBLISHED_PROMPT_REQUIRED");
  const models = await restRows(runtime, "llm_models", {
    select: "id,name,model_name,provider,api_protocol_config,is_active,is_hidden,user_access,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,token_rounding_unit",
    id: `eq.${agent.model_id}`,
    limit: "1",
  });
  const model = models[0];
  assert.equal(model?.id, agent.model_id, "PERSISTENT_MODEL_ROW_MISSING");
  assert.equal(model?.is_active, true, "PERSISTENT_MODEL_INACTIVE");
  assert.notEqual(model?.is_hidden, true, "PERSISTENT_MODEL_HIDDEN");
  assert.equal(model?.token_billing_enabled, true, "PERSISTENT_MODEL_BILLING_DISABLED");
  for (const key of ["input_cost_per_million", "output_cost_per_million", "cached_cost_per_million", "profit_margin"]) {
    assert.ok(Number.isFinite(Number(model[key])), `PERSISTENT_MODEL_PRICING_INVALID:${key}`);
  }
  const users = await restRows(runtime, "users", {
    select: "id,username,display_name,role,status,is_active,member_status,member_expires_at,allowed_categories,credits,credits_reserved,cash_balance,updated_at",
    role: `eq.${options.actorRole}`,
    ...(options.userId ? {id:`eq.${options.userId}`} : {}),
    is_active: "eq.true",
    order: "credits.desc",
    limit: "100",
  });
  const eligibleUsers = users.filter((user) => eligibleAcceptanceActor(user,options));
  return {
    agent,
    model,
    eligibleUsers,
    public: {
      agent: { id: agent.id, name: agent.name, category: agent.category, persistentModelId: agent.model_id, legacyModelName: agent.model || null,
        publishedBasePrompt: { sha256: sha256(agent.system_prompt),
          revision: Number.isSafeInteger(Number(agent.config_revision)) && Number(agent.config_revision) > 0 ? Number(agent.config_revision) : null,
          compositionVersion: "agent-chat-prompt.v1", evidence: "expected_database_identity_not_provider_dispatch_proof" } },
      persistentModel: {
        id: model.id,
        name: model.name,
        providerModelName: model.model_name,
        provider: model.provider || null,
        protocol: model.api_protocol_config?.protocol || null,
        tokenBillingEnabled: model.token_billing_enabled,
        pricingReady: true,
      },
      ordinaryMember: {
        actorRole: options.actorRole,
        ordinaryMemberAdmissionVerified: false,
        requiredNavigationKey: REQUIRED_NAVIGATION_KEY,
        requestedUserIdProvided: Boolean(options.userId),
        eligibleCount: eligibleUsers.length,
        minimumCredits: options.minimumCredits,
      },
    },
  };
}

async function createOrdinarySession(runtime, localEnv, actor, onAllocated = () => undefined, actorRole = "student") {
  const actorIdentity=acceptanceActorIdentity(actor,actorRole);
  const activeSessions = await restRows(runtime, "user_auth_sessions", {
    select: "session_id,expires_at", user_id: `eq.${actor.id}`, revoked_at: "is.null",
    expires_at: `gt.${new Date().toISOString()}`, order: "created_at.desc", limit: "20",
  });
  const reusableSession = activeSessions.find((row) => Date.parse(String(row.expires_at || "")) > Date.now() + 30 * 60_000) || null;
  assert.ok(reusableSession, "SAFE_REUSABLE_ORDINARY_SESSION_REQUIRED");
  const sessionId = String(reusableSession.session_id || "");
  assert.ok(sessionId, "REUSABLE_ORDINARY_SESSION_ID_REQUIRED");
  onAllocated(sessionId);
  const secrets = [...new Set([runtime.jwtSecret, localEnv.JWT_SECRET]
    .map((value) => String(value || "").trim()).filter((value) => value.length >= 16))];
  let token = "";
  for (const secret of secrets) {
    const candidate = await new SignJWT({
      userId: actor.id,
      username: actor.username,
      role: actorIdentity.role,
      displayName: actor.display_name || actor.username,
      sessionId,
    }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30m")
      .sign(new TextEncoder().encode(secret));
    const identity = await apiJson("/api/auth/me", candidate).catch(() => null);
    if (identity?.response.status === 200) {
      assertAcceptanceAuthIdentity(identity.payload,actor,actorRole);
      token = candidate;
      break;
    }
  }
  assert.ok(token, "ORDINARY_TOKEN_VERIFY_FAILED");
  return { sessionId, token };
}

async function authStateSnapshot(runtime, userId) {
  const [users, sessions] = await Promise.all([
    restRows(runtime, "users", { select: "id,session_id", id: `eq.${userId}`, limit: "1" }),
    restRows(runtime, "user_auth_sessions", {
      select: "session_id,ip_hash,user_agent_hash,created_at,expires_at,revoked_at,revoke_reason",
      user_id: `eq.${userId}`,
      order: "created_at.asc",
      limit: "1000",
    }),
  ]);
  assert.equal(users.length, 1, "AUTH_STATE_USER_REQUIRED");
  return {
    userSessionId: String(users[0].session_id || ""),
    sessions: sessions.map((row) => ({
      sessionId: String(row.session_id || ""),
      ipHash: row.ip_hash == null ? null : String(row.ip_hash),
      userAgentHash: row.user_agent_hash == null ? null : String(row.user_agent_hash),
      createdAt: row.created_at == null ? null : String(row.created_at),
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
      revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
      revokeReason: row.revoke_reason == null ? null : String(row.revoke_reason),
    })).sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
  };
}

function summarizeAuthState(state) {
  return {
    userSessionPointerSha256: state.userSessionId ? sha256(state.userSessionId) : null,
    sessionCount: state.sessions.length,
    sessions: state.sessions.map((row) => ({
      sessionIdSha256: sha256(row.sessionId),
      revokedAt: row.revokedAt,
      revokeReason: row.revokeReason,
      expiresAt: row.expiresAt,
    })),
  };
}

function sameAuthState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function creditSnapshot(token, userId) {
  const { response, payload } = await apiJson(`/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=1`, token);
  assert.equal(response.status, 200, `CREDITS_READ_FAILED:${response.status}`);
  return { credits: Number(payload.credits || 0), reserved: Number(payload.reservedCredits || 0), cash: Number(payload.cashBalance || 0),
    transactions: Array.isArray(payload.transactions) ? payload.transactions : [] };
}

async function attemptSnapshot(runtime, userId, clientRequestId) {
  const deadline = Date.now() + 320_000;
  let latestRow = null;
  while (Date.now() <= deadline) {
    const rows = await restRows(runtime, "llm_request_attempts", {
      select: "record_id,user_id,client_request_id,payload_fingerprint,state,attempt_no,http_status,error_code,result_reference,response_fingerprint,provider_call_started_at,created_at,updated_at",
      user_id: `eq.${userId}`,
      client_request_id: `eq.${clientRequestId}`,
      limit: "2",
    });
    const row = rows[0] || null;
    latestRow = row || latestRow;
    if (rows.length === 1 && row && ["succeeded", "failed", "failed_unknown", "reconciliation_required"].includes(String(row.state))) {
      const events = await restRows(runtime, "llm_request_attempt_events", {
        select: "id,record_id,attempt_no,event_type,from_state,to_state,reason,evidence,created_at",
        record_id: `eq.${row.record_id}`,
        order: "id.asc",
        limit: "30",
      });
      return { row, events };
    }
    await sleep(500);
  }
  const events = latestRow?.record_id ? await restRows(runtime, "llm_request_attempt_events", {
    select: "id,record_id,attempt_no,event_type,from_state,to_state,reason,evidence,created_at",
    record_id: `eq.${latestRow.record_id}`,
    order: "id.asc",
    limit: "30",
  }) : [];
  return { row: latestRow, events };
}

async function waitForKnownAttemptsToSettle(runtime, userId, clientRequestIds, timeoutMs = 320_000) {
  const ids = [...clientRequestIds];
  if (ids.length === 0) return { settled: true, rows: [], waitedMs: 0 };
  const terminalStates = new Set(["succeeded", "failed", "failed_unknown", "reconciliation_required"]);
  const startedAt = Date.now();
  let rows = [];
  while (Date.now() - startedAt <= timeoutMs) {
    rows = await restRows(runtime, "llm_request_attempts", {
      select: "record_id,user_id,client_request_id,state,attempt_no,provider_call_started_at,http_status,error_code,updated_at",
      user_id: `eq.${userId}`,
      client_request_id: `in.(${ids.join(",")})`,
      limit: String(ids.length + 2),
    });
    const byRequest = new Map(rows.map((row) => [String(row.client_request_id), row]));
    if (ids.every((id) => terminalStates.has(String(byRequest.get(id)?.state || "")))) {
      return { settled: true, rows, waitedMs: Date.now() - startedAt };
    }
    await sleep(500);
  }
  return { settled: false, rows, waitedMs: Date.now() - startedAt };
}

async function deleteConversation(runtime, token, conversationId) {
  const attempts = [];
  let consecutiveEmptyReadbacks = 0;
  for (let index = 0; index < 4; index += 1) {
    const deletion = await apiJson(`/api/conversations/history?id=${encodeURIComponent(conversationId)}`, token, { method: "DELETE" });
    const readback = await apiJson(`/api/conversations/history?id=${encodeURIComponent(conversationId)}`, token);
    const rows = await restRows(runtime, "conversations", { select: "id", id: `eq.${conversationId}`, limit: "1" });
    const messages = await restRows(runtime, "conversation_messages", { select: "id", conversation_id: `eq.${conversationId}`, limit: "5" });
    const empty = readback.response.status === 404 && rows.length === 0 && messages.length === 0;
    consecutiveEmptyReadbacks = empty ? consecutiveEmptyReadbacks + 1 : 0;
    attempts.push({ ordinal: index + 1, deleteStatus: deletion.response.status, readbackStatus: readback.response.status,
      conversationRows: rows.length, messageRows: messages.length, empty });
    if (consecutiveEmptyReadbacks >= 2) {
      return { conversationId, attempts, conversationRows: 0, messageRows: 0, removed: true };
    }
    await sleep(250 * (index + 1));
  }
  const last = attempts.at(-1) || {};
  return { conversationId, attempts, conversationRows: last.conversationRows ?? null,
    messageRows: last.messageRows ?? null, removed: false };
}

function compactStatsFromTimes(times) {
  const gaps = times.slice(1).map((value, index) => round(value - times[index]));
  const sorted = [...gaps].sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: times.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null,
    stallsOver1000Ms: gaps.filter((value) => value > 1000).length, firstGaps: gaps.slice(0, 80) };
}

function compactStatsFromGaps(values) {
  const numeric = values.filter(Number.isFinite);
  const sorted = [...numeric].sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: numeric.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null,
    stallsOver1000Ms: numeric.filter((value) => value > 1000).length, firstGaps: numeric.slice(0, 80) };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("");
}

function quality(caseId, text, dom) {
  const mentions3D = /3D|三维/iu.test(text);
  const mentionsDirector = /故事导演|导演|动画|分镜|镜头/iu.test(text);
  const professionalIdentity = mentions3D && mentionsDirector;
  const noProgrammingDrift = !/代码助手|软件工程师|programming assistant/iu.test(text);
  if (caseId === "short-answer") {
    const concise = text.length > 10 && text.length <= 80;
    const passed = professionalIdentity && noProgrammingDrift && concise;
    return { mentions3D, mentionsDirector, professionalIdentity, noProgrammingDrift, concise, passed };
  }
  if (caseId === "long-list") {
    const tenItems = dom.orderedItems.length === 10;
    const detailedItems = dom.orderedItems.filter((item) => new Set(item.match(/镜头|动作|道具|声音|音效|运镜|表情|环境/gu) || []).size >= 2).length;
    const lengthOk = text.length >= 700 && text.length <= 1000;
    const hasTitle = dom.headings >= 1;
    return { mentions3D, mentionsDirector, professionalIdentity, noProgrammingDrift, hasTitle, tenItems, detailedItems, lengthOk,
      passed: professionalIdentity && noProgrammingDrift && hasTitle && tenItems && detailedItems === 10 && lengthOk };
  }
  let parsedCode = null;
  try { parsedCode = JSON.parse(dom.codeText); } catch { /* verified below */ }
  const codeJsonLanguage = /(?:^|\s)language-json(?:\s|$)/u.test(dom.codeLanguage);
  const codeJsonFields = Boolean(parsedCode && typeof parsedCode === "object" && !Array.isArray(parsedCode)
    && typeof parsedCode.title === "string" && parsedCode.title.trim()
    && (Number(parsedCode.duration) === 15 || /^15\s*秒?$/u.test(String(parsedCode.duration || "").trim()))
    && Array.isArray(parsedCode.shots) && parsedCode.shots.length > 0
    && parsedCode.shots.every((shot) => shot && typeof shot === "object" && !Array.isArray(shot)));
  const domOk = dom.h2Count >= 1 && dom.listItems >= 4 && dom.tables >= 1 && dom.tableColumns === 3 && dom.codeBlocks >= 1;
  const lengthOk = text.length > 0 && text.length <= 650;
  return { mentions3D, mentionsDirector, professionalIdentity, noProgrammingDrift, domOk,
    codeJsonLanguage, codeJsonParsed: parsedCode !== null, codeJsonFields, lengthOk,
    passed: professionalIdentity && noProgrammingDrift && domOk && codeJsonLanguage && parsedCode !== null && codeJsonFields && lengthOk };
}

export const CASES = Object.freeze([
  { id: "short-answer", prompt: "请用最终可见文本不超过80个字符说明你是谁、最擅长把什么内容转成什么交付；汉字、英文、数字、标点、空格和换行都计入。保持当前3D故事导演身份，直接回答。" },
  { id: "long-list", prompt: "请为‘柯基误被主人责怪拆家，最后发现它是在寻找遗失钥匙’设计一份3D反转短片执行清单。必须先输出Markdown二级标题，并用Markdown有序列表输出恰好编号1到10的十条完整要点；每条包含镜头、动作、道具或声音中的至少两项；最终可见文本总长度控制在700到1000个字符，汉字、英文、数字、标点、空格和换行都计入。" },
  { id: "markdown-code", prompt: "请用Markdown输出一个15秒3D反转短片方案：必须包含二级标题、至少4条项目符号、一个3列Markdown表格，并给出一个标注为json的代码块。代码块中 title 必须为非空字符串，duration 必须为数字15，shots 必须为至少一个对象组成的数组。保持3D故事导演身份；最终可见文本不超过650个字符，汉字、英文、数字、标点、空格、换行和代码内容都计入。" },
]);

export function selectCases(selector = "all") {
  assert.ok(selector === "all" || CASES.some((item) => item.id === selector), "UNKNOWN_CASE_SELECTOR");
  return selector === "all" ? [...CASES] : CASES.filter((item) => item.id === selector);
}
export function caseCoverage(selectedCases) {
  return { selectedCaseIds: selectedCases.map((item) => item.id),
    omittedCaseIds: CASES.filter((item) => !selectedCases.some((chosen) => chosen.id === item.id)).map((item) => item.id),
    independentConversations: true, sameConversationMultiTurn: "NOT_TESTED", reloadHistoryRecovery: "NOT_TESTED",
    shortAnswerNetworkLimitation: "One preterminal content read can pass short-answer; it does not prove multi-read transport.",
    latencyMeaning: "App submit-to-visible latency; parsed network reads differ from DOM typing and are not provider-internal TTFT or upstream SSE event counts.",
    semanticPromptAdherence: "MANUAL_REVIEW_REQUIRED", dispatchPromptAuthority: "REQUEST_JOIN_REQUIRED" };
}
export async function runSelectedCases(selectedCases, visit) {
  for (let index = 0; index < selectedCases.length; index += 1) {
    const result = await visit(selectedCases[index], index);
    assert.notEqual(result?.passed, false, `SELECTED_CASE_FAILED_STOP:${selectedCases[index].id}`);
  }
}
export function selectedExecutionPassed(selectedCases, turns, audit) {
  return turns.length === selectedCases.length && turns.every((turn, index) => turn.caseId === selectedCases[index].id && turn.passed === true)
    && audit.actualLlmPosts === selectedCases.length && audit.knownClientRequestIds === selectedCases.length
    && audit.attemptRows === selectedCases.length && audit.providerStartedEvents === selectedCases.length
    && audit.billingTransactions === selectedCases.length;
}
export function comparePublishedPromptBinding(initial, finalAgent) {
  const final = { sha256: typeof finalAgent?.system_prompt === "string" && finalAgent.system_prompt.trim() ? sha256(finalAgent.system_prompt) : null,
    revision: Number.isSafeInteger(Number(finalAgent?.config_revision)) && Number(finalAgent.config_revision) > 0 ? Number(finalAgent.config_revision) : null };
  return { initial: { sha256: initial?.sha256 || null, revision: initial?.revision ?? null }, final,
    passed: Boolean(initial?.sha256 && initial?.revision && final.sha256 === initial.sha256 && final.revision === initial.revision),
    dispatchEvidence: "NOT_COLLECTED_BY_THIS_BROWSER_HARNESS", semanticAdherence: "MANUAL_REVIEW_REQUIRED" };
}

export function assertPublishedPromptPreflight(preflight) {
  assert.equal(comparePublishedPromptBinding(preflight?.public?.agent?.publishedBasePrompt, preflight?.agent).passed, true, "PUBLISHED_PROMPT_PREFLIGHT_INVALID");
}

export async function admitLlmRoute(route, { selectedCases, activeTurn, llmPosts, conversationIds, clientRequestIds, quoteExpectation }) {
  if (llmPosts > selectedCases.length || !activeTurn || !selectedCases.some((item) => item.id === activeTurn.caseId) || activeTurn.request) return route.abort("blockedbyclient");
  const originalBody = route.request().postDataJSON();
  assert.ok(!Object.prototype.hasOwnProperty.call(originalBody, "quote_expectation"), "BROWSER_EXPECTATION_ALREADY_PRESENT");
  const body = quoteExpectation ? { ...originalBody, quote_expectation: quoteExpectation } : originalBody;
  const nonEmptyOverrideFields = ["overrideModelId", "modelId", "model"].filter((key) => typeof body[key] === "string" && body[key].trim());
  assert.deepEqual(nonEmptyOverrideFields, [], `MODEL_OVERRIDE_FIELD_PRESENT:${nonEmptyOverrideFields.join(",")}`);
  assert.notEqual(body.model_overridden, true, "MODEL_OVERRIDE_FLAG_TRUE");
  assert.equal(body.agentId, AGENT_ID, "REQUEST_AGENT_ID_MISMATCH");
  assert.equal(body.agentName, AGENT_NAME, "REQUEST_AGENT_NAME_MISMATCH");
  const headers = route.request().headers();
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.client_request_id || "").trim();
  const idempotencyKey = String(headers["idempotency-key"] || "").trim();
  assert.match(conversationId, /^[A-Za-z0-9_-]{8,128}$/u, "CONVERSATION_ID_INVALID");
  assert.match(clientRequestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u, "CLIENT_REQUEST_ID_INVALID");
  assert.equal(clientRequestId, idempotencyKey, "IDEMPOTENCY_HEADER_BODY_MISMATCH");
  assert.ok(!conversationIds.has(conversationId), "CONVERSATION_ID_REUSED");
  assert.ok(!clientRequestIds.has(clientRequestId), "CLIENT_REQUEST_ID_REUSED");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMessages = messages.filter((message) => message?.role === "user");
  const assistantMessages = messages.filter((message) => message?.role === "assistant");
  const unsupportedMessages = messages.filter((message) => !["system", "user"].includes(String(message?.role || "")));
  assert.equal(userMessages.length, 1, "NEW_CONVERSATION_MUST_CONTAIN_EXACTLY_ONE_USER_MESSAGE");
  assert.equal(assistantMessages.length, 0, "NEW_CONVERSATION_ASSISTANT_HISTORY_FORBIDDEN");
  assert.equal(unsupportedMessages.length, 0, "NEW_CONVERSATION_UNSUPPORTED_HISTORY_FORBIDDEN");
  assert.equal(messages.at(-1), userMessages[0], "CURRENT_USER_MESSAGE_MUST_BE_LAST");
  const submittedPrompt = messageText(userMessages[0]?.content).trim();
  assert.equal(submittedPrompt, activeTurn.prompt.trim(), "REQUEST_PROMPT_MISMATCH");
  activeTurn.request = { ordinal: llmPosts, agentId: body.agentId, agentName: body.agentName,
    conversationId, clientRequestId, idempotencyKey, modelFields: {
      overrideModelId: body.overrideModelId ?? null, modelId: body.modelId ?? null, model: body.model ?? null,
      modelOverridden: body.model_overridden ?? null }, promptSha256: sha256(submittedPrompt),
    requestBodySha256: sha256(JSON.stringify(canonicalize(body))), payloadFingerprint: llmPayloadFingerprint(body),
    messageCount: messages.length, systemMessageCount: messages.filter((message) => message?.role === "system").length,
    userMessageCount: userMessages.length, assistantMessageCount: assistantMessages.length };
  conversationIds.add(conversationId);
  clientRequestIds.add(clientRequestId);
  return quoteExpectation ? route.continue({postData:JSON.stringify(body)}) : route.continue();
}

export function validateHarnessQuoteReceipt(bytes, options) {
  assert.ok(Buffer.byteLength(bytes)<=131072, "QUOTE_RECEIPT_TOO_LARGE");
  assert.equal(sha256(bytes), options.quoteReceiptSha256, "QUOTE_RECEIPT_SHA_MISMATCH");
  const receipt=JSON.parse(String(bytes));
  assert.equal(receipt.schemaVersion,"llm_platform_reservation_receipt.v1","QUOTE_RECEIPT_SCHEMA");
  assert.equal(receipt.kind,"readonly_platform_reservation","QUOTE_RECEIPT_KIND");
  assert.equal(receipt.caseId,options.case,"QUOTE_RECEIPT_CASE");
  const expected=receipt.quoteExpectation;
  assert.ok(expected && expected.schemaVersion==="llm_platform_reservation_expectation.v1","QUOTE_EXPECTATION_SCHEMA");
  assert.equal(expected.actorSha256,sha256(options.userId),"QUOTE_RECEIPT_ACTOR");
  assert.equal(expected.sourceVersion,options.expectedSourceVersion,"QUOTE_RECEIPT_SOURCE");
  assert.equal(expected.buildId,options.expectedBuildId,"QUOTE_RECEIPT_BUILD");
  assert.equal(expected.agentId,AGENT_ID,"QUOTE_RECEIPT_AGENT");
  assert.ok(Number.isFinite(expected.platformReservationCredits) && expected.platformReservationCredits>=0,"QUOTE_RECEIPT_AMOUNT");
  return expected;
}

async function writeArtifacts(outputDir, report) {
  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "report.json");
  await fs.writeFile(reportPath, safeJson(report), { flag: "wx" });
  const names = ["report.json", ...(report.artifacts || []).map((item) => item.file)];
  const lines = [];
  for (const name of [...new Set(names)]) {
    const bytes = await fs.readFile(path.join(outputDir, name));
    lines.push(`${sha256(bytes)}  ${name}`);
  }
  const shaPath = path.join(outputDir, "SHA256SUMS.txt");
  await fs.writeFile(shaPath, lines.join("\n") + "\n", { flag: "wx" });
  return { reportPath, shaPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selectedCases = selectCases(options.case);
  if (options.help) { console.log(usage()); return; }
  if (!options.execute) {
    process.stdout.write(safeJson(buildPlanReport(options)));
    return;
  }
  const outputDir = path.join(PROJECT_ROOT, ".codex-evidence", "chat-agent-real-acceptance", `final-persistent-stream-${timestampForPath()}`);
  await fs.mkdir(outputDir, { recursive: false });
  const report = {
    schemaVersion: 1,
    mode: options.execute ? "execute" : "plan",
    startedAt: new Date().toISOString(),
    status: "running",
    target: { agentId: AGENT_ID, agentName: AGENT_NAME },
    coverage: caseCoverage(selectedCases),
    constraints: { expectedBrowserLlmPosts: selectedCases.length, harnessAutomaticResubmissions: 0, providerDispatchCeiling: null, viewport: VIEWPORT, ordinaryUserUi: options.actorRole !== "admin", ordinaryMemberAdmissionVerified: false, actorRole:options.actorRole,
      persistentBindingModified: false, sourceModified: false, buildModified: false, portModified: false,
      taskListModified: false, deploymentModified: false, actualLlmPosts: 0, providerCalls: null,
      announcementEventWrites: 0, announcementEventIntercepts: 0,
      productUsageEventWrites: 0, productUsageEventIntercepts: 0,
      productUsageAnalyticsIsolatedFromChatAcceptance: true },
    runtime: null,
    runtimeChecks: [],
    preflight: null,
    turns: [],
    cleanup: { conversations: [], authSession: null, authState: null, finalReadback: null },
    diagnostics: { consoleErrors: [], pageErrors: [], failedResponses: [] },
    artifacts: [],
    errors: [],
  };
  let runtime;
  let preflight;
  let actor = null;
  let token = "";
  let sessionId = "";
  let browser = null;
  const conversationIds = new Set();
  const clientRequestIds = new Set();
  let llmPosts = 0;
  let initialBalance = null;
  let initialAuthState = null;
  let quoteExpectation;
  try {
    if (options.quoteReceipt) {
      const stat = await fs.stat(options.quoteReceipt);
      assert.ok(stat.isFile() && stat.size<=131072,"QUOTE_RECEIPT_FILE_INVALID");
      quoteExpectation=validateHarnessQuoteReceipt(await fs.readFile(options.quoteReceipt),options);
      report.constraints.quoteReceiptSha256=options.quoteReceiptSha256;
      report.constraints.platformReservationCredits=quoteExpectation.platformReservationCredits;
    }
    runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
    assert.equal(new URL(runtime.supabaseUrl).origin, "http://127.0.0.1:54321", "LOCAL_ACCEPTANCE_DATABASE_REQUIRED");
    report.runtime = await runtimeIdentity(options);
    report.runtimeChecks.push({ phase: "initial", ...report.runtime, matchedInitial: true });
    preflight = await readPreflight(runtime, options);
    assertPublishedPromptPreflight(preflight);
    report.preflight = preflight.public;
    assert.ok(preflight.eligibleUsers.length > 0, "ELIGIBLE_ORDINARY_MEMBER_REQUIRED");
    if (!options.execute) {
      report.status = "planned";
      report.constraints.actualLlmPosts = 0;
      report.constraints.providerCalls = 0;
      report.plan = { paidExecutionRequired: true, command: "node scripts/verify-chat-streaming-experience-live.mjs --execute",
        note: "No authentication session, conversation, provider call, billing write, or browser submission was created in plan mode." };
    } else {
      const localEnv = parseDotenv(await fs.readFile(path.join(PROJECT_ROOT, ".env.local"), "utf8"));
      for (const candidate of preflight.eligibleUsers) {
        const candidateAuthState = await authStateSnapshot(runtime, candidate.id);
        const hasReusableSession = candidateAuthState.sessions.some((row) => row.revokedAt === null
          && Date.parse(String(row.expiresAt || "")) > Date.now() + 30 * 60_000);
        if (!hasReusableSession) continue;
        actor = candidate;
        initialAuthState = candidateAuthState;
        break;
      }
      assert.ok(actor && initialAuthState, "SAFE_REUSABLE_ORDINARY_SESSION_REQUIRED");
      ({ sessionId, token } = await createOrdinarySession(runtime, localEnv, actor, (allocatedSessionId) => {
        sessionId = allocatedSessionId;
      }, options.actorRole));
      report.actor = { role: options.actorRole, ordinaryMemberAdmissionVerified:false, userIdSha256: sha256(String(actor.id)), navigationKey: REQUIRED_NAVIGATION_KEY,
        originalAuthState: summarizeAuthState(initialAuthState) };
      const postCreateAuthState = await authStateSnapshot(runtime, actor.id);
      const originalAuthPreserved = sameAuthState(initialAuthState, postCreateAuthState);
      report.actor.postCreateAuthState = summarizeAuthState(postCreateAuthState);
      report.actor.originalAuthPreservedAfterCredentialSetup = originalAuthPreserved;
      report.actor.authenticationMode = "reused-existing-active-session-readonly";
      if (!originalAuthPreserved) {
        throw new Error("AUTH_STATE_CHANGED_DURING_PREFLIGHT_PAID_EXECUTION_BLOCKED");
      }
      initialBalance = await creditSnapshot(token, actor.id);
      assert.ok(initialBalance.credits >= options.minimumCredits && initialBalance.reserved === 0, "BALANCE_OR_RESERVATION_GATE");

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block", extraHTTPHeaders: { "X-Real-IP": FIXED_REAL_IP } });
      await context.addInitScript(({ sessionToken, user }) => {
        localStorage.setItem("auth_token", sessionToken);
        localStorage.setItem("auth_user", JSON.stringify(user));
        localStorage.setItem("active_view", "marketplace");
        localStorage.setItem("debug_stream", "1");
        sessionStorage.setItem("entered_app", "1");
      }, { sessionToken: token, user: acceptanceActorIdentity(actor,options.actorRole) });
      await context.addCookies([{ name: "auth_token", value: token, url: ORIGIN, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      let activeTurn = null;
      page.on("console", (message) => {
        const value = message.text();
        const at = Date.now();
        if (message.type() === "error" && !/favicon|ResizeObserver/iu.test(value)) report.diagnostics.consoleErrors.push({ at, text: value.slice(0, 700) });
        if (!activeTurn) return;
        const sample = parseSseReadEvidence(value, activeTurn.request?.clientRequestId, at - activeTurn.submitEpoch);
        if (sample) {
          if (activeTurn.sse.length >= 4096) activeTurn.sseEvidenceOverflow = true;
          else activeTurn.sse.push(sample);
        }
      });
      page.on("pageerror", (error) => report.diagnostics.pageErrors.push({ at: Date.now(), message: error.message.slice(0, 700) }));
      page.on("response", (response) => {
        const responseUrl = new URL(response.url());
        const method = response.request().method();
        const isLlmPost = method === "POST" && responseUrl.pathname === "/api/llm";
        if (responseUrl.origin === ORIGIN && (response.status() >= 500 || (isLlmPost && response.status() >= 400))) {
          report.diagnostics.failedResponses.push({ status: response.status(), method, pathname: responseUrl.pathname });
        }
        if (!isLlmPost) return;
        const headers = response.headers();
        if (activeTurn) activeTurn.response = { status: response.status(), headersMs: Date.now() - activeTurn.submitEpoch,
          headers: { contentType: headers["content-type"] || null, cacheControl: headers["cache-control"] || null,
            delivery: headers["x-stream-delivery"] || null, deliveryReason: headers["x-stream-delivery-reason"] || null,
            attemptId: headers["x-llm-attempt-id"] || null, replayed: headers["x-llm-replayed"] || null,
            guarded: headers["x-llm-guarded"] || null, continueAfterDisconnect: headers["x-llm-continue-after-disconnect"] || null } };
      });
      await page.route("**/api/announcements/events", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        report.constraints.announcementEventIntercepts += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store", "X-Codex-Announcement-Event-Intercepted": "true" },
          body: JSON.stringify({ success: true, recorded: false, alreadyRecorded: true }),
        });
      });
      await page.route("**/api/product-usage/events", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        report.constraints.productUsageEventIntercepts += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store", "X-Codex-Product-Usage-Isolated": "true" },
          body: JSON.stringify({ code: "PRODUCT_USAGE_CHAT_ACCEPTANCE_ISOLATED", receivedCount: 0 }),
        });
      });
      await page.route("**/api/llm", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        llmPosts += 1;
        report.constraints.actualLlmPosts = llmPosts;
        return admitLlmRoute(route, { selectedCases, activeTurn, llmPosts, conversationIds, clientRequestIds, quoteExpectation });
      });

      async function openTargetChat() {
        await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const announcementReader = page.getByTestId("announcement-reader");
        const announcementAppeared = await announcementReader
          .waitFor({ state: "visible", timeout: 6_000 })
          .then(() => true)
          .catch(() => false);
        if (announcementAppeared) {
          await announcementReader
            .getByRole("button", { name: "关闭系统公告", exact: true })
            .click({ timeout: 5_000 });
          await announcementReader.waitFor({ state: "hidden", timeout: 10_000 });
        }
        await page.addStyleTag({
          content: '[data-platform-popup="announcement-toast"],[data-platform-popup="account-toast"]{display:none!important;pointer-events:none!important}',
        });
        const closeButtons = page.getByRole("button", { name: "关闭", exact: true });
        for (let position = (await closeButtons.count()) - 1; position >= 0; position -= 1) {
          const candidate = closeButtons.nth(position);
          if (await candidate.isVisible().catch(() => false)) {
            await candidate.click({ timeout: 2_000 }).catch(() => undefined);
            break;
          }
        }
        const card = page.locator(`[data-agent-card-id="${AGENT_ID}"]`);
        await card.waitFor({ state: "visible", timeout: 45_000 });
        await card.getByText(AGENT_NAME, { exact: true }).click();
        const dialog = page.getByTestId("agent-preset-intake").filter({ hasText: AGENT_NAME });
        await dialog.waitFor({ state: "visible", timeout: 15_000 });
        const skip = dialog.getByRole("button", { name: "跳过", exact: true });
        if (await skip.count()) await skip.click();
        const textbox = page.getByRole("textbox", { name: `向 ${AGENT_NAME} 发送消息`, exact: true });
        await textbox.waitFor({ state: "visible", timeout: 20_000 });
        return textbox;
      }

      await runSelectedCases(selectedCases, async (testCase, index) => {
        const turnRuntime = await runtimeIdentity(options);
        const runtimeMatched = sameRuntimeIdentity(report.runtime, turnRuntime);
        report.runtimeChecks.push({ phase: `before-${testCase.id}`, ...turnRuntime, matchedInitial: runtimeMatched });
        assert.equal(runtimeMatched, true, `${testCase.id}:RUNTIME_IDENTITY_DRIFT_BEFORE_SUBMIT`);
        const balanceBefore = await creditSnapshot(token, actor.id);
        assert.equal(balanceBefore.reserved, 0, `PER_TURN_RESERVATION_GATE:${testCase.id}`);
        const knownTransactions = new Set(balanceBefore.transactions.map((item) => String(item.id)));
        const textbox = await openTargetChat();
        const assistantCountBefore = await page.locator('[data-message-role="assistant"]').count();
        const diagnosticBaseline = { consoleErrors: report.diagnostics.consoleErrors.length,
          pageErrors: report.diagnostics.pageErrors.length, failedResponses: report.diagnostics.failedResponses.length };
        const turn = { caseId: testCase.id, prompt: testCase.prompt, submitEpoch: 0, sse: [], request: null,
          response: null, error: null, diagnosticBaseline };
        const prefix = `${index + 1}-${testCase.id}`;
        let resultRecorded = false;
        try {
          activeTurn = turn;
        await textbox.fill(testCase.prompt);
        await page.evaluate(() => {
          window.__finalStreamProbe = null;
          window.__startFinalStreamProbe = (assistantCountBefore) => {
            const probe = { startedAt: performance.now(), active: true, frameTimes: [], visible: [], statusEvents: [], rowChanges: 0,
              bubbleChanges: 0, opacityViolations: 0, blurViolations: 0, assistantCountBefore, lastRow: null, lastBubble: null,
              lastLength: -1, lastText: "", lastStatus: "" };
            window.__finalStreamProbe = probe;
            const visibleText = (bubble) => { if (!bubble) return ""; const clone = bubble.cloneNode(true);
              clone.querySelectorAll('[data-testid="chat-output-status"], .code-block-actions').forEach((node) => node.remove());
              return (clone.innerText || clone.textContent || "").trim(); };
            const frame = (now) => {
              if (!probe.active) return;
               probe.frameTimes.push(now - probe.startedAt);
               const rows = [...document.querySelectorAll('[data-message-role="assistant"]')];
               const row = rows[assistantCountBefore] || null;
              const bubble = row?.querySelector('.chat-message-bubble-assistant') || null;
              if (probe.lastRow && row && row !== probe.lastRow) probe.rowChanges += 1;
              if (probe.lastBubble && bubble && bubble !== probe.lastBubble) probe.bubbleChanges += 1;
              if (row) probe.lastRow = row;
              if (bubble) probe.lastBubble = bubble;
              const status = bubble?.querySelector('[data-testid="chat-output-status"]')?.textContent?.trim() || "";
              if (status && status !== probe.lastStatus) { probe.statusEvents.push({ atMs: now - probe.startedAt, text: status }); probe.lastStatus = status; }
              const text = visibleText(bubble);
              if (text.length !== probe.lastLength || text !== probe.lastText) {
                probe.visible.push({ atMs: now - probe.startedAt, length: text.length, text });
                probe.lastLength = text.length;
                probe.lastText = text;
              }
              if (row) for (const node of [row, bubble].filter(Boolean)) { const style = getComputedStyle(node);
                if (Number(style.opacity || 1) < 0.99) probe.opacityViolations += 1;
                if (/blur\s*\(/iu.test(`${style.filter} ${style.backdropFilter}`)) probe.blurViolations += 1; }
              requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          };
        });
        await page.evaluate((count) => window.__startFinalStreamProbe(count), assistantCountBefore);
        turn.submitEpoch = Date.now();
        try {
          await page.getByRole("button", { name: "发送消息", exact: true }).click();
          const submittedFile = `${prefix}-submitted.png`;
          await page.screenshot({ path: path.join(outputDir, submittedFile), fullPage: true });
          report.artifacts.push({ caseId: testCase.id, kind: "submitted", file: submittedFile });
          await page.waitForFunction((count) => {
            const rows = [...document.querySelectorAll('[data-message-role="assistant"]')];
            if (rows.length !== count + 1) return false;
            const row = rows[count];
            const state = row?.querySelector('[data-testid="chat-output-status"]')?.getAttribute("data-state");
            return ["completed", "failed", "unknown"].includes(state || "");
          }, assistantCountBefore, { timeout: 300_000 });
        } catch (error) { turn.error = error instanceof Error ? error.message : String(error); }
        await page.evaluate(() => { if (window.__finalStreamProbe) window.__finalStreamProbe.active = false; });
        const probe = await page.evaluate(() => window.__finalStreamProbe);
        const finalFile = `${prefix}-final.png`;
        const finalScreenshotSaved = await page.screenshot({ path: path.join(outputDir, finalFile), fullPage: true })
          .then(() => true).catch(() => false);
        if (finalScreenshotSaved) report.artifacts.push({ caseId: testCase.id, kind: "final", file: finalFile });
        const assistantRows = page.locator('[data-message-role="assistant"]');
        assert.equal(await assistantRows.count(), assistantCountBefore + 1, `${testCase.id}:EXACTLY_ONE_NEW_ASSISTANT_ROW_REQUIRED`);
        const assistant = assistantRows.nth(assistantCountBefore);
        const bubble = assistant.locator(".chat-message-bubble-assistant");
        const output = await bubble.evaluate((node) => { const clone = node.cloneNode(true);
          clone.querySelectorAll('[data-testid="chat-output-status"], .code-block-actions').forEach((child) => child.remove());
          return (clone.innerText || clone.textContent || "").trim(); }).catch(() => "");
        const finalState = await bubble.locator('[data-testid="chat-output-status"]').getAttribute("data-state").catch(() => null);
        const dom = { headings: await bubble.locator("h1,h2,h3,h4,h5,h6").count().catch(() => 0),
          h2Count: await bubble.locator("h2").count().catch(() => 0),
          listItems: await bubble.locator("li").count().catch(() => 0),
          orderedItems: await bubble.locator("ol > li").allInnerTexts().catch(() => []),
          tables: await bubble.locator("table").count().catch(() => 0),
          tableColumns: await bubble.locator("table tr").first().locator("th,td").count().catch(() => 0),
          codeBlocks: await bubble.locator("pre code, pre").count().catch(() => 0),
          codeText: await bubble.locator("pre code").first().textContent().then((value) => String(value || "").trim()).catch(() => ""),
          codeLanguage: await bubble.locator("pre code").first().getAttribute("class").then((value) => String(value || "")).catch(() => ""),
          rowChanges: probe?.rowChanges ?? null,
          bubbleChanges: probe?.bubbleChanges ?? null, opacityViolations: probe?.opacityViolations ?? null, blurViolations: probe?.blurViolations ?? null };
        const attempt = turn.request?.clientRequestId ? await attemptSnapshot(runtime, actor.id, turn.request.clientRequestId) : { row: null, events: [] };
        await sleep(500);
        const balanceAfter = await creditSnapshot(token, actor.id);
        const transactions = balanceAfter.transactions.filter((item) => !knownTransactions.has(String(item.id)));
        const positiveGrowth = (probe?.visible || []).filter((item) => item.length > 0);
        const visibleStats = compactStatsFromTimes(positiveGrowth.map((item) => item.atMs));
        const frameStats = compactStatsFromTimes(probe?.frameTimes || []);
        const contentSseSamples = turn.sse.filter((item) => item.cumulativeContentChars > 0);
        const firstSse = contentSseSamples[0] || null;
        const persistentModelId = preflight.model.id;
        const persistentProviderModel = preflight.model.model_name;
        const creditDelta = round(balanceBefore.credits - balanceAfter.credits, 6);
        const cashDelta = round(balanceBefore.cash - balanceAfter.cash, 6);
        const expectedBillingKey = `llm:${turn.request?.clientRequestId}:response`;
        const transactionBindingOk = transactions.length === 1 && transactions.every((item) => {
          const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
          return String(item.description || "").includes(AGENT_NAME)
            && String(item.description || "").includes(String(persistentProviderModel))
            && ["consume", "consumption"].includes(String(item.type || ""))
            && String(metadata.idempotency_key || "") === expectedBillingKey
            && String(metadata.phase || "") === "response"
            && String(metadata.internalModelId || metadata.internal_model_id || "") === String(persistentModelId)
            && Number(item.amount) < 0
            && Math.abs(round(-Number(item.amount), 6) - creditDelta) <= 0.000001
            && Math.abs(round(Number(item.balance_after), 6) - round(balanceAfter.credits, 6)) <= 0.000001
            && creditDelta > 0
            && cashDelta === 0;
        });
        const providerStartedEvents = attempt.events.filter((event) => event.event_type === "provider_started");
        const minimumVisibleGrowthSamples = testCase.id === "short-answer" ? 3 : testCase.id === "long-list" ? 12 : 8;
        // A short answer can fit in one content read. Longer cases must prove
        // multiple content lengths before the terminal read; DOM animation alone
        // and repeated heartbeats do not establish incremental network delivery.
        const minimumNetworkGrowthSamples = testCase.id === "short-answer" ? 1 : 2;
        const sseEvidence = auditSseEvidence(turn.sse, minimumNetworkGrowthSamples);
        const sseStats = compactStatsFromGaps(sseEvidence.intervalSamples.map((item) => item.gapMs));
        const growthIncrements = positiveGrowth.map((item, position) => item.length - (positiveGrowth[position - 1]?.length || 0));
        const largestGrowthShare = output.length > 0 ? Math.max(0, ...growthIncrements) / output.length : 1;
        const largestGrowthShareLimit = testCase.id === "short-answer" ? 0.5 : testCase.id === "long-list" ? 0.25 : 0.35;
        const contentContinuity = positiveGrowth.every((item, position) => {
          if (position === 0) return true;
          const previous = positiveGrowth[position - 1];
          if (previous.text.length < 32) return true;
          let prefixLength = 0;
          const maximum = Math.min(previous.text.length, item.text.length);
          while (prefixLength < maximum && previous.text[prefixLength] === item.text[prefixLength]) prefixLength += 1;
          return prefixLength / previous.text.length >= 0.8;
        });
        const smoothness = {
          firstVisibleWithin15s: positiveGrowth[0]?.atMs != null && positiveGrowth[0].atMs <= 15_000,
          minimumVisibleGrowthSamples,
          minimumNetworkGrowthSamples,
          incrementalEnough: visibleStats.count >= minimumVisibleGrowthSamples,
          sampledNetworkHasContent: sseEvidence.sampledNetworkHasContent,
          contentBearingSseSampleExists: sseEvidence.contentBearingSampleExists,
          chunkIntervalSampleCount: sseEvidence.chunkIntervalSampleCount,
          chunkIntervalSamplesAuditable: sseEvidence.chunkIntervalSamplesAuditable,
          sseEvidencePassed: sseEvidence.passed,
          terminalReadAuditable: sseEvidence.terminalReadAuditable,
          networkIncrementalEvidence: sseEvidence.networkIncrementalEvidence,
          sseEvidenceOverflow: Boolean(turn.sseEvidenceOverflow),
          largestGrowthShare: round(largestGrowthShare, 6),
          largestGrowthShareWithinLimit: largestGrowthShare <= largestGrowthShareLimit,
          noDomGrowthGapOver1s: visibleStats.maxMs == null || visibleStats.maxMs <= 1000,
          rafP95Within100ms: frameStats.p95Ms != null && frameStats.p95Ms <= 100,
          noRafGapOver1s: frameStats.maxMs != null && frameStats.maxMs <= 1000,
          monotonicGrowth: positiveGrowth.every((item, position) => position === 0 || item.length >= positiveGrowth[position - 1].length),
          contentContinuity,
          noRebuildOrFlicker: dom.rowChanges === 0 && dom.bubbleChanges === 0 && dom.opacityViolations === 0 && dom.blurViolations === 0
            && contentContinuity,
        };
        smoothness.passed = smoothness.firstVisibleWithin15s && smoothness.incrementalEnough
          && smoothness.sampledNetworkHasContent && smoothness.contentBearingSseSampleExists
          && smoothness.chunkIntervalSamplesAuditable && smoothness.sseEvidencePassed && !smoothness.sseEvidenceOverflow
          && smoothness.largestGrowthShareWithinLimit
          && smoothness.noDomGrowthGapOver1s && smoothness.rafP95Within100ms && smoothness.noRafGapOver1s
          && smoothness.monotonicGrowth && smoothness.noRebuildOrFlicker;
        const outputQuality = quality(testCase.id, output, dom);
        const turnDiagnostics = {
          consoleErrors: report.diagnostics.consoleErrors.slice(turn.diagnosticBaseline.consoleErrors),
          pageErrors: report.diagnostics.pageErrors.slice(turn.diagnosticBaseline.pageErrors),
          failedResponses: report.diagnostics.failedResponses.slice(turn.diagnosticBaseline.failedResponses),
        };
        turnDiagnostics.clean = turnDiagnostics.consoleErrors.length === 0
          && turnDiagnostics.pageErrors.length === 0 && turnDiagnostics.failedResponses.length === 0;
        const attemptHeaderMatched = Boolean(turn.response?.headers?.attemptId)
          && String(turn.response.headers.attemptId) === String(attempt.row?.record_id || "");
        const result = {
          caseId: testCase.id,
          promptSha256: sha256(testCase.prompt),
          request: turn.request,
          http: turn.response,
          timings: { submitToHeadersMs: turn.response?.headersMs ?? null, submitToFirstDebugReadSampleMs: firstSse?.atMs ?? null,
            submitToFirstVisibleTextMs: positiveGrowth[0]?.atMs ?? null, submitToCompleteMs: round(Date.now() - turn.submitEpoch) },
          sse: { evidenceKind: "debug_parsed_network_reads_not_provider_sse_event_boundaries",
            sampleCount: turn.sse.length, contentBearingSampleCount: sseEvidence.contentBearingSampleCount,
            contentBearingSampleExists: sseEvidence.contentBearingSampleExists,
            sampledNetworkHasContent: sseEvidence.sampledNetworkHasContent,
            rawSamplesAuditable: sseEvidence.rawSamplesAuditable,
            orderedSamplesAuditable: sseEvidence.orderedSamplesAuditable,
            terminalReadAuditable: sseEvidence.terminalReadAuditable,
            networkIncrementalEvidence: sseEvidence.networkIncrementalEvidence,
            overflow: Boolean(turn.sseEvidenceOverflow),
            chunkIntervalSampleCount: sseEvidence.chunkIntervalSampleCount,
            chunkIntervalSamplesAuditable: sseEvidence.chunkIntervalSamplesAuditable,
            passed: sseEvidence.passed,
            intervalStats: sseStats, intervalSamples: sseEvidence.intervalSamples.slice(0, 120),
            samples: turn.sse.slice(0, 120) },
          visibleGrowth: { ...visibleStats, firstVisibleChars: positiveGrowth[0]?.length || 0, finalVisibleChars: output.length,
            samples: positiveGrowth.slice(0, 160) },
          frameCadence: frameStats,
          dom,
          finalState,
          attempt: attempt.row,
          attemptEvents: attempt.events,
          diagnostics: turnDiagnostics,
          billing: { before: { credits: balanceBefore.credits, reserved: balanceBefore.reserved, cash: balanceBefore.cash },
            after: { credits: balanceAfter.credits, reserved: balanceAfter.reserved, cash: balanceAfter.cash },
            creditDelta, cashDelta, expectedBillingKey,
            transactions: transactions.map((item) => ({ id: item.id, type: item.type, amount: Number(item.amount),
              balanceAfter: Number(item.balance_after), idempotencyKey: item.metadata?.idempotency_key || null,
              description: item.description, metadata: item.metadata, createdAt: item.created_at })),
            uniqueCharge: transactions.length === 1, boundCharge: transactionBindingOk,
            persistentModelBindingMatched: transactionBindingOk },
          persistentBindingEvidence: { modelId: persistentModelId, providerModelName: persistentProviderModel,
            browserModelOverrideAbsent: !turn.request?.modelFields?.overrideModelId && !turn.request?.modelFields?.modelId
              && !turn.request?.modelFields?.model && turn.request?.modelFields?.modelOverridden !== true,
            attemptExactlyOnce: attempt.row?.attempt_no === 1 && providerStartedEvents.length === 1,
            attemptHeaderMatched,
            requestPayloadFingerprintMatched: Boolean(turn.request?.payloadFingerprint)
              && turn.request.payloadFingerprint === attempt.row?.payload_fingerprint,
            transactionDescriptionMatched: transactionBindingOk },
          smoothness,
          quality: outputQuality,
          promptAuthority: { expectedPublishedBase: preflight.public.agent.publishedBasePrompt,
            actualDispatchAudit: "NOT_COLLECTED_BY_THIS_BROWSER_HARNESS",
            note: "Match the content-free LLM_PROMPT_AUTHORITY server event by request ID before claiming published prompt dispatch. This stream/model test does not certify prompt adherence." },
          output: { characters: output.length, sha256: sha256(output), excerpt: output.slice(0, 900) },
          error: turn.error,
          harnessAutomaticResubmissions: 0,
        };
        result.passed = !turn.error && result.http?.status === 200 && /^text\/event-stream/iu.test(result.http?.headers?.contentType || "")
          && finalState === "completed" && attempt.row?.state === "succeeded" && result.persistentBindingEvidence.browserModelOverrideAbsent
          && result.persistentBindingEvidence.attemptExactlyOnce && result.persistentBindingEvidence.attemptHeaderMatched
          && result.persistentBindingEvidence.requestPayloadFingerprintMatched
          && result.billing.uniqueCharge && result.billing.boundCharge
          && smoothness.passed && outputQuality.passed && turnDiagnostics.clean;
        report.turns.push(result);
        resultRecorded = true;
        const turnFile = `${prefix}.json`;
        await fs.writeFile(path.join(outputDir, turnFile), safeJson(result), { flag: "wx" });
        report.artifacts.push({ caseId: testCase.id, kind: "turn-report", file: turnFile });
        activeTurn = null;
        return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          turn.error ||= message;
          if (!resultRecorded) {
            const partialSseEvidence = auditSseEvidence(turn.sse, testCase.id === "short-answer" ? 1 : 2);
            const partial = {
              caseId: testCase.id,
              promptSha256: sha256(testCase.prompt),
              request: turn.request,
              http: turn.response,
              timings: { submitToHeadersMs: turn.response?.headersMs ?? null,
                submitToFirstDebugReadSampleMs: turn.sse.find((item) => item.cumulativeContentChars > 0)?.atMs ?? null,
                submitToFirstVisibleTextMs: null, submitToCompleteMs: turn.submitEpoch ? round(Date.now() - turn.submitEpoch) : null },
              sse: { evidenceKind: "debug_parsed_network_reads_not_provider_sse_event_boundaries", sampleCount: turn.sse.length,
                contentBearingSampleCount: partialSseEvidence.contentBearingSampleCount,
                contentBearingSampleExists: partialSseEvidence.contentBearingSampleExists,
                sampledNetworkHasContent: partialSseEvidence.sampledNetworkHasContent,
                rawSamplesAuditable: partialSseEvidence.rawSamplesAuditable,
                orderedSamplesAuditable: partialSseEvidence.orderedSamplesAuditable,
                terminalReadAuditable: partialSseEvidence.terminalReadAuditable,
                networkIncrementalEvidence: partialSseEvidence.networkIncrementalEvidence,
                overflow: Boolean(turn.sseEvidenceOverflow),
                chunkIntervalSampleCount: partialSseEvidence.chunkIntervalSampleCount,
                chunkIntervalSamplesAuditable: partialSseEvidence.chunkIntervalSamplesAuditable,
                passed: partialSseEvidence.passed,
                intervalStats: compactStatsFromGaps(partialSseEvidence.intervalSamples.map((item) => item.gapMs)),
                intervalSamples: partialSseEvidence.intervalSamples.slice(0, 120), samples: turn.sse.slice(0, 120) },
              diagnostics: {
                consoleErrors: report.diagnostics.consoleErrors.slice(turn.diagnosticBaseline.consoleErrors),
                pageErrors: report.diagnostics.pageErrors.slice(turn.diagnosticBaseline.pageErrors),
                failedResponses: report.diagnostics.failedResponses.slice(turn.diagnosticBaseline.failedResponses),
              },
              error: message,
              partial: true,
              passed: false,
              harnessAutomaticResubmissions: 0,
            };
            report.turns.push(partial);
            resultRecorded = true;
            const turnFile = `${prefix}.json`;
            await fs.writeFile(path.join(outputDir, turnFile), safeJson(partial), { flag: "wx" }).then(() => {
              report.artifacts.push({ caseId: testCase.id, kind: "partial-turn-report", file: turnFile });
            }).catch((writeError) => {
              report.errors.push(`PARTIAL_TURN_ARTIFACT_WRITE_FAILED:${writeError instanceof Error ? writeError.message : String(writeError)}`);
            });
          }
          activeTurn = null;
          throw error;
        }
      });

      assert.equal(llmPosts, selectedCases.length, `EXPECTED_SELECTED_LLM_POSTS:${llmPosts}`);
      report.constraints.actualLlmPosts = llmPosts;
      report.constraints.providerAttemptRows = report.turns.filter((turn) => Boolean(turn.attempt?.provider_call_started_at)).length;
      const finalAgent = (await restRows(runtime, "agents", { select: "id,name,model_id,model,updated_at,system_prompt,config_revision", id: `eq.${AGENT_ID}`, limit: "1" }))[0];
      report.target.initialPersistentBinding = { modelId: preflight.agent.model_id, modelName: preflight.agent.model, updatedAt: preflight.agent.updated_at };
      report.target.finalPersistentBinding = { modelId: finalAgent?.model_id, modelName: finalAgent?.model, updatedAt: finalAgent?.updated_at };
      report.target.persistentBindingUnchanged = JSON.stringify(report.target.initialPersistentBinding) === JSON.stringify(report.target.finalPersistentBinding);
      assert.equal(report.target.persistentBindingUnchanged, true, "PERSISTENT_BINDING_CHANGED");
      report.promptAuthority = comparePublishedPromptBinding(preflight.public.agent.publishedBasePrompt, finalAgent);
      assert.equal(report.promptAuthority.passed, true, "PUBLISHED_PROMPT_BINDING_DRIFT");
      const finalBalance = await creditSnapshot(token, actor.id);
      report.billing = { before: { credits: initialBalance.credits, reserved: initialBalance.reserved, cash: initialBalance.cash },
        after: { credits: finalBalance.credits, reserved: finalBalance.reserved, cash: finalBalance.cash },
        totalCreditDelta: round(initialBalance.credits - finalBalance.credits, 6), totalCashDelta: round(initialBalance.cash - finalBalance.cash, 6),
        sumTurnCreditDelta: round(report.turns.reduce((sum, turn) => sum + Number(turn.billing.creditDelta || 0), 0), 6),
        uniqueChargePerTurn: report.turns.every((turn) => turn.billing.uniqueCharge),
        boundChargePerTurn: report.turns.every((turn) => turn.billing.boundCharge),
        noResidualReservation: finalBalance.reserved === 0 };
      report.billing.passed = report.billing.totalCreditDelta > 0 && report.billing.totalCashDelta === 0
        && Math.abs(report.billing.totalCreditDelta - report.billing.sumTurnCreditDelta) <= 0.000001
        && report.billing.uniqueChargePerTurn && report.billing.boundChargePerTurn && report.billing.noResidualReservation;
      const diagnosticsClean = report.diagnostics.consoleErrors.length === 0 && report.diagnostics.pageErrors.length === 0
        && report.diagnostics.failedResponses.length === 0;
      report.status = report.turns.length === selectedCases.length && report.turns.every((turn) => turn.passed) && report.billing.passed && diagnosticsClean
        ? "passed" : "completed_with_failures";
    }
  } catch (error) {
    report.status = options.execute ? "failed_or_partial" : "plan_failed";
    report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => undefined), sleep(5_000)]);
    report.constraints.actualLlmPosts = llmPosts;
    if (runtime && actor && clientRequestIds.size > 0) {
      try {
        const settlement = await waitForKnownAttemptsToSettle(runtime, actor.id, clientRequestIds);
        report.cleanup.attemptSettlement = {
          settled: settlement.settled,
          waitedMs: settlement.waitedMs,
          rows: settlement.rows.map((row) => ({ clientRequestId: row.client_request_id, state: row.state,
            attemptNo: row.attempt_no, providerCallStarted: Boolean(row.provider_call_started_at),
            httpStatus: row.http_status, errorCode: row.error_code })),
        };
        report.constraints.providerAttemptRows = settlement.rows.filter((row) => Boolean(row.provider_call_started_at)).length;
        if (!settlement.settled) report.errors.push("ATTEMPT_SETTLEMENT_TIMEOUT_RECONCILIATION_REQUIRED");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.constraints.providerAttemptRows = null;
        report.cleanup.attemptSettlement = { settled: false, waitedMs: null, rows: null, error: message };
        report.errors.push(`ATTEMPT_SETTLEMENT_READBACK_FAILED:${message}`);
      }
    } else if (options.execute) {
      report.constraints.providerAttemptRows = 0;
      report.cleanup.attemptSettlement = { settled: true, waitedMs: 0, rows: [] };
    }
    if (runtime && token) {
      await sleep(750);
      for (const conversationId of conversationIds) {
        try { report.cleanup.conversations.push(await deleteConversation(runtime, token, conversationId)); }
        catch (error) { report.cleanup.conversations.push({ conversationId, removed: false, error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    if (sessionId) {
      report.cleanup.authSession = { removed: true, reusedExistingSessionUnmodified: true, rows: 0 };
    }
    if (runtime && actor) {
      const ids = [...conversationIds];
      const requests = [...clientRequestIds];
      try {
        const conversationRows = ids.length ? await restRows(runtime, "conversations", { select: "id", id: `in.(${ids.join(",")})` }) : [];
        const messageRows = ids.length ? await restRows(runtime, "conversation_messages", { select: "id", conversation_id: `in.(${ids.join(",")})` }) : [];
        const attempts = requests.length ? await restRows(runtime, "llm_request_attempts", {
          select: "record_id,client_request_id,state,attempt_no,provider_call_started_at,http_status,error_code",
          user_id: `eq.${actor.id}`, client_request_id: `in.(${requests.join(",")})`, limit: String(requests.length + 2),
        }) : [];
        const attemptRecordIds = attempts.map((row) => String(row.record_id || "").trim()).filter(Boolean);
        const providerStartedEvents = attemptRecordIds.length ? await restRows(runtime, "llm_request_attempt_events", {
          select: "id,record_id,attempt_no,event_type,created_at",
          record_id: `in.(${attemptRecordIds.join(",")})`, event_type: "eq.provider_started",
          limit: String(Math.max(20, attemptRecordIds.length * 4)),
        }) : [];
        const recentTransactions = requests.length ? await restRows(runtime, "credit_transactions", {
          select: "id,type,amount,balance_after,description,metadata,created_at",
          user_id: `eq.${actor.id}`, order: "created_at.desc", limit: "100",
        }) : [];
        const expectedBillingKeys = new Set(requests.map((requestId) => `llm:${requestId}:response`));
        const matchedTransactions = recentTransactions.filter((row) => expectedBillingKeys.has(String(row.metadata?.idempotency_key || "")));
        const finalAuthState = await authStateSnapshot(runtime, actor.id);
        const userRows = await restRows(runtime, "users", { select: "credits_reserved,session_id", id: `eq.${actor.id}`, limit: "1" });
        assert.equal(userRows.length, 1, "CLEANUP_USER_READBACK_MISSING");
        const authStateRestored = Boolean(initialAuthState && sameAuthState(initialAuthState, finalAuthState));
        report.cleanup.authState = {
          restored: authStateRestored,
          before: initialAuthState ? summarizeAuthState(initialAuthState) : null,
          after: summarizeAuthState(finalAuthState),
        };
        report.constraints.providerAttemptRows = attempts.filter((row) => Boolean(row.provider_call_started_at)).length;
        report.constraints.providerStartedEvents = providerStartedEvents.length;
        report.constraints.providerCalls = null;
        report.executionAudit = {
          actualLlmPosts: llmPosts,
          knownClientRequestIds: requests.length,
          attemptRows: attempts.length,
          providerAttemptRows: report.constraints.providerAttemptRows,
          providerStartedEvents: providerStartedEvents.length,
          providerDispatchCeiling: null,
          billingTransactions: matchedTransactions.length,
          chargedCredits: round(matchedTransactions.reduce((sum, row) => sum + Math.max(0, -Number(row.amount || 0)), 0), 6),
          billingKeys: matchedTransactions.map((row) => String(row.metadata?.idempotency_key || "")),
        };
        report.cleanup.finalReadback = { cleanupReadbackOk: true,
          temporaryConversationRows: conversationRows.length, temporaryMessageRows: messageRows.length,
          temporaryAuthSessionRows: report.cleanup.authSession?.rows ?? null,
          temporaryUserSessionPointer: 0,
          originalAuthStateRestored: authStateRestored,
          nonTerminalAttemptRows: attempts.filter((row) => !["succeeded", "failed", "failed_unknown", "reconciliation_required"].includes(String(row.state))).length,
          terminalAttemptAuditRowsRetained: attempts.filter((row) => ["succeeded", "failed", "failed_unknown", "reconciliation_required"].includes(String(row.state))).length,
          reservedCredits: Number(userRows[0].credits_reserved) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.cleanup.finalReadback = { cleanupReadbackOk: false, temporaryConversationRows: null,
          temporaryMessageRows: null, temporaryAuthSessionRows: report.cleanup.authSession?.rows ?? null,
          temporaryUserSessionPointer: null, originalAuthStateRestored: false, nonTerminalAttemptRows: null,
          terminalAttemptAuditRowsRetained: null, reservedCredits: null, error: message };
        report.errors.push(`CLEANUP_READBACK_FAILED:${message}`);
      }
    }
    report.cleanup.allTemporaryConversationsRemoved = report.cleanup.conversations.length === conversationIds.size
      && report.cleanup.conversations.every((item) => item.removed === true);
    if (options.execute) {
      const cleanupOk = report.cleanup.allTemporaryConversationsRemoved && report.cleanup.authSession?.removed === true
        && report.cleanup.finalReadback?.cleanupReadbackOk === true
        && report.cleanup.finalReadback?.temporaryConversationRows === 0 && report.cleanup.finalReadback?.temporaryMessageRows === 0
        && report.cleanup.finalReadback?.temporaryUserSessionPointer === 0
        && report.cleanup.finalReadback?.originalAuthStateRestored === true
        && report.cleanup.finalReadback?.nonTerminalAttemptRows === 0 && report.cleanup.finalReadback?.reservedCredits === 0
        && report.cleanup.attemptSettlement?.settled === true;
      const executionAuditOk = Boolean(report.executionAudit) && selectedExecutionPassed(selectedCases, report.turns, report.executionAudit);
      report.cleanup.passed = cleanupOk;
      if (report.executionAudit) report.executionAudit.passed = executionAuditOk;
      if (report.status === "passed" && !executionAuditOk) report.status = "completed_with_execution_audit_failure";
      if (!cleanupOk) report.status = report.status === "passed"
        ? "completed_with_cleanup_failure"
        : `${report.status}_with_cleanup_failure`;
    }
    try {
      const finalRuntime = await runtimeIdentity(options);
      const matchedInitial = sameRuntimeIdentity(report.runtime, finalRuntime);
      report.runtimeChecks.push({ phase: "final", ...finalRuntime, matchedInitial });
      report.runtimeStable = matchedInitial;
      if (!matchedInitial) {
        report.errors.push("RUNTIME_IDENTITY_DRIFT_DURING_ACCEPTANCE");
        report.status = `${report.status}_with_runtime_drift`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.runtimeStable = false;
      report.errors.push(`FINAL_RUNTIME_IDENTITY_READBACK_FAILED:${message}`);
      report.status = `${report.status}_with_runtime_identity_failure`;
    }
    const paths = await writeArtifacts(outputDir, report);
    console.log(JSON.stringify({ status: report.status, mode: report.mode, sourceVersion: report.runtime?.sourceVersion || null,
      buildId: report.runtime?.buildId || null, actualLlmPosts: report.constraints.actualLlmPosts,
      providerCalls: report.constraints.providerCalls, executionAudit: report.executionAudit || null,
      turns: report.turns.map((turn) => ({ id: turn.caseId, passed: turn.passed,
        ttftMs: turn.timings?.submitToFirstVisibleTextMs ?? null, creditDelta: turn.billing?.creditDelta ?? null })),
      cleanup: report.cleanup.finalReadback, reportPath: paths.reportPath, shaPath: paths.shaPath }, null, 2));
    if (!['planned', 'passed'].includes(report.status)) process.exitCode = 1;
  }
}

const directExecutionPath = process.argv[1] ? path.resolve(process.argv[1]).toLocaleLowerCase("en-US") : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url)).toLocaleLowerCase("en-US");
if (directExecutionPath === modulePath) await main();
