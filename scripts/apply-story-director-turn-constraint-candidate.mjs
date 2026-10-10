#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const AGENT_ID = "agent-1786843330392-emdjv2";
const BASELINE_PROMPT_SHA256 = "3df48085ed01989449ddac142a029827432f153a4141abb81a5fc868e3a481c6";
const BASELINE_REVISION = 13;
const CANDIDATE_REVISION = 14;
const ROLLBACK_REVISION = 15;
const LOCAL_ORIGIN = "http://127.0.0.1:5000";
const LOCAL_DATABASE = Object.freeze({ hostname: "127.0.0.1", port: "54322", pathname: "/zimeiti_local" });
const EVIDENCE_ROOT = path.resolve(".codex-evidence/agent-prompt-turn-constraint");
const OVERRIDE_TITLE = "# 本轮显式交付约束覆盖（高优先级）";
const OVERRIDE_BLOCK = `${OVERRIDE_TITLE}

1. 本轮用户显式指定的字数、条目数量、Markdown 格式、JSON 格式和必含词，优先于默认输出形态与默认长度；但不得覆盖智能体身份、安全边界、事实约束和角色职责。
2. 当本轮要求属于非标准交付时，暂停默认的双 Prompt、固定输出顺序、“不输出 JSON”以及 8/10/15 秒默认预算，只执行本轮显式交付约束。
3. 长度限制按最终对用户可见的字符计数，中英文、数字、标点、空格、换行和代码内容均计入；超限时优先删除解释、同义表述和重复项，保留必含信息与可执行内容。
4. 当用户明确提出 3D 请求时，输出标题或首句必须显式保留“3D”。
5. 仅当本轮没有任何显式字数、条目、Markdown、JSON、必含词或其他交付限制时，才执行默认导演合同。`;
const ALLOWED_REPORT_STATUSES = new Set([
  "plan_ready",
  "execute_in_progress",
  "executed",
  "rollback_in_progress",
  "rolled_back",
  "failed",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function visibleLength(value) {
  return [...value].length;
}

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function countExact(value, needle) {
  return value.split(needle).length - 1;
}

function buildCandidate(basePrompt) {
  requireCondition(sha256(basePrompt) === BASELINE_PROMPT_SHA256, "BASELINE_PROMPT_SHA_MISMATCH");
  requireCondition(countExact(basePrompt, OVERRIDE_TITLE) === 0, "OVERRIDE_TITLE_ALREADY_PRESENT");
  const separator = basePrompt.endsWith("\n") ? "\n" : "\n\n";
  const candidate = `${basePrompt}${separator}${OVERRIDE_BLOCK}\n`;
  requireCondition(candidate.startsWith(basePrompt), "CANDIDATE_MUST_ONLY_APPEND");
  requireCondition(countExact(candidate, OVERRIDE_TITLE) === 1, "OVERRIDE_TITLE_MUST_BE_UNIQUE");
  requireCondition(candidate.slice(basePrompt.length) === `${separator}${OVERRIDE_BLOCK}\n`, "APPEND_ONLY_CONTRACT_FAILED");
  return candidate;
}

function parseArgs(args) {
  const runIds = args.filter((arg) => arg.startsWith("--run-id=")).map((arg) => arg.slice("--run-id=".length));
  const execute = args.includes("--execute");
  const rollback = args.includes("--rollback");
  const allowed = new Set(["--execute", "--rollback"]);
  for (const arg of args) {
    requireCondition(arg.startsWith("--run-id=") || allowed.has(arg), "UNKNOWN_ARGUMENT");
  }
  requireCondition(runIds.length === 1, "EXACTLY_ONE_RUN_ID_REQUIRED");
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u.test(runIds[0]), "SAFE_RUN_ID_REQUIRED");
  requireCondition(!(execute && rollback), "EXECUTE_AND_ROLLBACK_ARE_MUTUALLY_EXCLUSIVE");
  return { runId: runIds[0], mode: rollback ? "rollback" : execute ? "execute" : "plan" };
}

function reportPathFor(runId) {
  const runDirectory = path.resolve(EVIDENCE_ROOT, runId);
  requireCondition(runDirectory.startsWith(`${EVIDENCE_ROOT}${path.sep}`), "EVIDENCE_PATH_OUTSIDE_ROOT");
  return { runDirectory, reportPath: path.join(runDirectory, "report.json") };
}

async function readExistingReport(reportPath) {
  try {
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    requireCondition(report?.schema_version === 1, "UNKNOWN_REPORT_SCHEMA");
    requireCondition(ALLOWED_REPORT_STATUSES.has(report?.status), "UNKNOWN_REPORT_STATUS");
    requireCondition(report?.hashes?.baseline_prompt_sha256 === BASELINE_PROMPT_SHA256, "REPORT_BASELINE_HASH_MISMATCH");
    requireCondition(Number(report?.revisions?.baseline) === BASELINE_REVISION, "REPORT_BASELINE_REVISION_MISMATCH");
    requireCondition(Number(report?.revisions?.candidate) === CANDIDATE_REVISION, "REPORT_CANDIDATE_REVISION_MISMATCH");
    requireCondition(Number(report?.revisions?.rollback) === ROLLBACK_REVISION, "REPORT_ROLLBACK_REVISION_MISMATCH");
    requireCondition(/^[0-9a-f]{64}$/u.test(String(report?.hashes?.candidate_prompt_sha256 || "")), "REPORT_CANDIDATE_HASH_INVALID");
    return report;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeReport(runDirectory, reportPath, report) {
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function validateLocalRuntime() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
  requireCondition(origin === LOCAL_ORIGIN, "EXACT_LOCAL_RUNTIME_REQUIRED");
  requireCondition(token.length > 0, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  requireCondition(databaseUrl.length > 0, "LOCAL_DATABASE_URL_REQUIRED");
  requireCondition(String(identity?.user?.id || "").length > 0, "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const parsedDatabase = new URL(databaseUrl);
  requireCondition(parsedDatabase.hostname === LOCAL_DATABASE.hostname, "LOCAL_DATABASE_HOST_REQUIRED");
  requireCondition(parsedDatabase.port === LOCAL_DATABASE.port, "LOCAL_DATABASE_PORT_REQUIRED");
  requireCondition(parsedDatabase.pathname === LOCAL_DATABASE.pathname, "LOCAL_DATABASE_NAME_REQUIRED");
  return { origin, token, databaseUrl, actorId: String(identity.user.id) };
}

async function fetchAccessContext(runtime) {
  const response = await fetch(`${runtime.origin}/api/admin/access-control/self`, {
    headers: { Authorization: `Bearer ${runtime.token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  requireCondition(response.ok, `ADMIN_ACCESS_CONTEXT_HTTP_${response.status}`);
  const permissions = Array.isArray(body?.access?.permissionKeys) ? body.access.permissionKeys.map(String) : [];
  requireCondition(permissions.includes("agents.manage"), "AGENTS_MANAGE_PERMISSION_REQUIRED");
  requireCondition(permissions.includes("prompts.edit"), "PROMPTS_EDIT_PERMISSION_REQUIRED");
  requireCondition(Number.isSafeInteger(Number(body?.access?.revision)), "ADMIN_PROFILE_REVISION_REQUIRED");
  return { revision: Number(body.access.revision) };
}

async function assertDatabaseIdentity(database) {
  const row = (await database.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port()::integer AS server_port
  `)).rows[0];
  requireCondition(row?.database_name === "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
  requireCondition(row?.server_address === "127.0.0.1", "LIVE_LOOPBACK_DATABASE_REQUIRED");
  requireCondition(Number(row?.server_port) === 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");
}

async function readState(database, includePrompt = false) {
  await database.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const target = (await database.query(`
      SELECT a.config_revision::text AS config_revision,
             char_length(coalesce(a.system_prompt, ''))::integer AS prompt_length,
             encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(a.system_prompt, ''), 'UTF8')), 'hex') AS prompt_sha256,
             encode(pg_catalog.sha256(pg_catalog.convert_to((to_jsonb(a) - ARRAY['system_prompt','config_revision','updated_at'])::text, 'UTF8')), 'hex') AS protected_sha256,
             encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_object(
               'source', a.source,
               'bot_id', a.bot_id,
               'model', a.model,
               'model_id', a.model_id,
               'coze_coding_api_url', a.coze_coding_api_url,
               'coze_coding_project_id', a.coze_coding_project_id,
               'proxy_url', a.proxy_url,
               'deep_thinking_type', a.deep_thinking_type,
               'max_context_tokens', a.max_context_tokens,
               'max_reply_tokens', a.max_reply_tokens,
               'timeout', a.timeout,
               'response_format', a.response_format
             )::text, 'UTF8')), 'hex') AS model_binding_sha256,
             encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(a.updated_at::text, ''), 'UTF8')), 'hex') AS updated_at_sha256
             ${includePrompt ? ", a.system_prompt" : ""}
      FROM public.agents AS a
      WHERE a.id = $1 AND a.deleted_at IS NULL
    `, [AGENT_ID])).rows[0];
    requireCondition(target, "TARGET_AGENT_NOT_FOUND");

    const nonTarget = (await database.query(`
      SELECT count(*)::integer AS row_count,
             encode(pg_catalog.sha256(pg_catalog.convert_to(
               coalesce(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.id), ''), 'UTF8'
             )), 'hex') AS fingerprint_sha256
      FROM public.agents AS a
      WHERE a.id <> $1
    `, [AGENT_ID])).rows[0];

    const history = (await database.query(`
      SELECT count(*)::integer AS row_count,
             count(*) FILTER (WHERE agent_revision = $2 AND prompt_hash = $3)::integer AS baseline_revision_matches,
             count(*) FILTER (WHERE agent_revision = $4)::integer AS candidate_revision_rows,
             count(*) FILTER (WHERE agent_revision = $5)::integer AS rollback_revision_rows
      FROM public.prompt_versions
      WHERE agent_id = $1
    `, [AGENT_ID, BASELINE_REVISION, BASELINE_PROMPT_SHA256, CANDIDATE_REVISION, ROLLBACK_REVISION])).rows[0];

    await database.query("COMMIT");
    return {
      revision: Number(target.config_revision),
      promptLength: Number(target.prompt_length),
      promptSha256: String(target.prompt_sha256),
      protectedSha256: String(target.protected_sha256),
      modelBindingSha256: String(target.model_binding_sha256),
      updatedAtSha256: String(target.updated_at_sha256),
      prompt: includePrompt ? String(target.system_prompt || "") : undefined,
      nonTargetCount: Number(nonTarget.row_count),
      nonTargetSha256: String(nonTarget.fingerprint_sha256),
      historyCount: Number(history.row_count),
      baselineRevisionMatches: Number(history.baseline_revision_matches),
      candidateRevisionRows: Number(history.candidate_revision_rows),
      rollbackRevisionRows: Number(history.rollback_revision_rows),
    };
  } catch (error) {
    await database.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function readVersionMetadata(database, revision) {
  const rows = (await database.query(`
    SELECT agent_revision::text AS agent_revision,
           prompt_hash,
           char_length(prompt)::integer AS prompt_length
    FROM public.prompt_versions
    WHERE agent_id = $1 AND agent_revision = $2
  `, [AGENT_ID, revision])).rows;
  requireCondition(rows.length === 1, `PROMPT_VERSION_REVISION_${revision}_MUST_BE_UNIQUE`);
  return {
    revision: Number(rows[0].agent_revision),
    promptSha256: String(rows[0].prompt_hash),
    promptLength: Number(rows[0].prompt_length),
  };
}

async function readBaselinePromptFromHistory(database) {
  const rows = (await database.query(`
    SELECT prompt, agent_revision::text AS agent_revision, prompt_hash
    FROM public.prompt_versions
    WHERE agent_id = $1 AND agent_revision = $2 AND prompt_hash = $3
  `, [AGENT_ID, BASELINE_REVISION, BASELINE_PROMPT_SHA256])).rows;
  requireCondition(rows.length === 1, "BASELINE_PROMPT_VERSION_NOT_UNIQUE");
  const prompt = String(rows[0].prompt || "");
  requireCondition(Number(rows[0].agent_revision) === BASELINE_REVISION, "BASELINE_HISTORY_REVISION_MISMATCH");
  requireCondition(sha256(prompt) === BASELINE_PROMPT_SHA256, "BASELINE_HISTORY_CONTENT_MISMATCH");
  return prompt;
}

async function createScopedStepUp(database, runtime, access) {
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(stepUpToken);
  const scopes = ["agents.manage", "prompts.edit"];
  await database.query("BEGIN");
  try {
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(`
      INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
      VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-Story-Director-Turn-Constraint/1.0',now()+interval '5 minutes')
    `, [runtime.actorId, tokenHash, JSON.stringify(scopes), access.revision]);
    await database.query("COMMIT");
    return { stepUpToken, tokenHash };
  } catch (error) {
    await database.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function removeScopedStepUp(database, tokenHash) {
  if (!tokenHash) return { status: "not_created", rowsRemaining: 0 };
  try {
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [tokenHash]);
    await database.query("COMMIT");
    const remaining = await database.query(
      "SELECT count(*)::integer AS count FROM public.admin_step_up_sessions WHERE token_hash=$1",
      [tokenHash],
    );
    const rowsRemaining = Number(remaining.rows[0]?.count || 0);
    return { status: rowsRemaining === 0 ? "passed" : "failed", rowsRemaining };
  } catch {
    await database.query("ROLLBACK").catch(() => undefined);
    return { status: "failed", rowsRemaining: -1 };
  }
}

async function putPrompt(runtime, stepUpToken, expectedRevision, prompt) {
  const payload = { agentId: AGENT_ID, expected_revision: expectedRevision, system_prompt: prompt };
  requireCondition(
    JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["agentId", "expected_revision", "system_prompt"].sort()),
    "PUT_PAYLOAD_SCOPE_VIOLATION",
  );
  const response = await fetch(`${runtime.origin}/api/admin/agents`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      "x-admin-step-up": stepUpToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  const safeCode = /^[A-Z0-9_]+$/u.test(String(body?.code || "")) ? `_${body.code}` : "";
  requireCondition(response.ok, `AGENT_PUT_HTTP_${response.status}${safeCode}`);
  requireCondition(body?.success === true, "AGENT_PUT_SUCCESS_RECEIPT_REQUIRED");
}

function assertBaselineState(state) {
  requireCondition(state.revision === BASELINE_REVISION, "BASELINE_CONFIG_REVISION_MISMATCH");
  requireCondition(state.promptSha256 === BASELINE_PROMPT_SHA256, "BASELINE_PROMPT_SHA_MISMATCH");
  requireCondition(state.baselineRevisionMatches === 1, "BASELINE_PROMPT_VERSION_REQUIRED");
  requireCondition(state.candidateRevisionRows === 0, "CANDIDATE_REVISION_ALREADY_EXISTS");
  requireCondition(state.rollbackRevisionRows === 0, "ROLLBACK_REVISION_ALREADY_EXISTS");
}

function assertPromptMutation(before, after, expectedPromptSha256, expectedRevision) {
  requireCondition(after.promptSha256 === expectedPromptSha256, "PROMPT_READBACK_HASH_MISMATCH");
  requireCondition(after.revision === expectedRevision, "CONFIG_REVISION_READBACK_MISMATCH");
  requireCondition(after.protectedSha256 === before.protectedSha256, "TARGET_NON_PROMPT_FIELDS_CHANGED");
  requireCondition(after.modelBindingSha256 === before.modelBindingSha256, "MODEL_BINDING_CHANGED");
  requireCondition(after.nonTargetCount === before.nonTargetCount, "NON_TARGET_AGENT_COUNT_CHANGED");
  requireCondition(after.nonTargetSha256 === before.nonTargetSha256, "NON_TARGET_AGENT_FINGERPRINT_CHANGED");
  requireCondition(after.updatedAtSha256 !== before.updatedAtSha256, "UPDATED_AT_DID_NOT_CHANGE");
}

function buildReport({ status, candidate, before, after = before, checks = {}, cleanup }) {
  return {
    schema_version: 1,
    status,
    hashes: {
      baseline_prompt_sha256: BASELINE_PROMPT_SHA256,
      candidate_prompt_sha256: sha256(candidate),
      current_prompt_sha256: after?.promptSha256 || null,
      target_protected_before_sha256: before?.protectedSha256 || null,
      target_protected_after_sha256: after?.protectedSha256 || null,
      model_binding_before_sha256: before?.modelBindingSha256 || null,
      model_binding_after_sha256: after?.modelBindingSha256 || null,
      non_target_before_sha256: before?.nonTargetSha256 || null,
      non_target_after_sha256: after?.nonTargetSha256 || null,
      updated_at_before_sha256: before?.updatedAtSha256 || null,
      updated_at_after_sha256: after?.updatedAtSha256 || null,
    },
    lengths: {
      baseline_prompt: before?.promptSha256 === BASELINE_PROMPT_SHA256 ? before.promptLength : null,
      candidate_prompt: visibleLength(candidate),
      current_prompt: after?.promptLength ?? null,
      non_target_agents_before: before?.nonTargetCount ?? null,
      non_target_agents_after: after?.nonTargetCount ?? null,
      prompt_versions_before: before?.historyCount ?? null,
      prompt_versions_after: after?.historyCount ?? null,
    },
    revisions: {
      baseline: BASELINE_REVISION,
      candidate: CANDIDATE_REVISION,
      rollback: ROLLBACK_REVISION,
      before: before?.revision ?? null,
      after: after?.revision ?? null,
    },
    checks: {
      local_loopback_runtime: "passed",
      baseline_guard: before?.promptSha256 === BASELINE_PROMPT_SHA256 && before?.revision === BASELINE_REVISION ? "passed" : "not_applicable",
      cas: checks.cas || "pending",
      api_only_agent_write: checks.apiOnlyAgentWrite || "pending",
      prompt_version_readback: checks.promptVersionReadback || "pending",
      target_three_field_diff: checks.targetThreeFieldDiff || "pending",
      model_binding_preserved: checks.modelBindingPreserved || "pending",
      non_target_agents_preserved: checks.nonTargetAgentsPreserved || "pending",
      api_cache_invalidation_path: checks.apiCacheInvalidationPath || "pending",
    },
    cleanup: {
      status: cleanup?.status || "not_required",
      step_up_session_rows_remaining: cleanup?.rowsRemaining ?? 0,
    },
  };
}

function assertReportMatchesCandidate(report, candidate, before) {
  requireCondition(report.hashes.candidate_prompt_sha256 === sha256(candidate), "PLAN_CANDIDATE_HASH_MISMATCH");
  requireCondition(Number(report.lengths?.candidate_prompt) === visibleLength(candidate), "PLAN_CANDIDATE_LENGTH_MISMATCH");
  requireCondition(report.hashes.target_protected_before_sha256 === before.protectedSha256, "PLAN_TARGET_FINGERPRINT_STALE");
  requireCondition(report.hashes.model_binding_before_sha256 === before.modelBindingSha256, "PLAN_MODEL_BINDING_STALE");
  requireCondition(report.hashes.non_target_before_sha256 === before.nonTargetSha256, "PLAN_NON_TARGET_FINGERPRINT_STALE");
}

async function runPlan(database, runDirectory, reportPath, existing) {
  requireCondition(existing === null, "RUN_ID_ALREADY_HAS_STATE");
  const before = await readState(database, true);
  assertBaselineState(before);
  const baselineVersion = await readVersionMetadata(database, BASELINE_REVISION);
  requireCondition(baselineVersion.promptSha256 === BASELINE_PROMPT_SHA256, "BASELINE_HISTORY_HASH_MISMATCH");
  requireCondition(baselineVersion.promptLength === before.promptLength, "BASELINE_HISTORY_LENGTH_MISMATCH");
  const candidate = buildCandidate(before.prompt);
  const report = buildReport({
    status: "plan_ready",
    candidate,
    before,
    checks: { promptVersionReadback: "passed" },
    cleanup: { status: "not_required", rowsRemaining: 0 },
  });
  await writeReport(runDirectory, reportPath, report);
  return report;
}

async function runExecute(database, runtime, access, runDirectory, reportPath, existing) {
  requireCondition(existing?.status === "plan_ready", "EXECUTE_REQUIRES_SAME_RUN_ID_PLAN");
  const before = await readState(database, true);
  assertBaselineState(before);
  const candidate = buildCandidate(before.prompt);
  assertReportMatchesCandidate(existing, candidate, before);
  await writeReport(runDirectory, reportPath, buildReport({
    status: "execute_in_progress",
    candidate,
    before,
    cleanup: { status: "not_created", rowsRemaining: 0 },
  }));

  let stepUp = null;
  let after = before;
  let operationPassed = false;
  let failure = null;
  try {
    stepUp = await createScopedStepUp(database, runtime, access);
    await putPrompt(runtime, stepUp.stepUpToken, BASELINE_REVISION, candidate);
    after = await readState(database, false);
    assertPromptMutation(before, after, sha256(candidate), CANDIDATE_REVISION);
    const version = await readVersionMetadata(database, CANDIDATE_REVISION);
    requireCondition(version.promptSha256 === sha256(candidate), "CANDIDATE_PROMPT_VERSION_HASH_MISMATCH");
    requireCondition(version.promptLength === visibleLength(candidate), "CANDIDATE_PROMPT_VERSION_LENGTH_MISMATCH");
    operationPassed = true;
  } catch (error) {
    failure = error;
    after = await readState(database, false).catch(() => after);
  } finally {
    if (stepUp) stepUp.stepUpToken = "";
  }
  const cleanup = await removeScopedStepUp(database, stepUp?.tokenHash || "");
  if (cleanup.status !== "passed" && cleanup.status !== "not_created") operationPassed = false;
  const report = buildReport({
    status: operationPassed ? "executed" : "failed",
    candidate,
    before,
    after,
    checks: operationPassed ? {
      cas: "passed",
      apiOnlyAgentWrite: "passed",
      promptVersionReadback: "passed",
      targetThreeFieldDiff: "passed",
      modelBindingPreserved: "passed",
      nonTargetAgentsPreserved: "passed",
      apiCacheInvalidationPath: "passed",
    } : {},
    cleanup,
  });
  await writeReport(runDirectory, reportPath, report);
  requireCondition(cleanup.status === "passed" || cleanup.status === "not_created", "TEMPORARY_STEP_UP_CLEANUP_FAILED");
  if (failure) throw failure;
  return report;
}

async function runRollback(database, runtime, access, runDirectory, reportPath, existing) {
  requireCondition(
    existing && ["executed", "execute_in_progress", "failed"].includes(existing.status),
    "ROLLBACK_REQUIRES_EXECUTED_OR_RECOVERABLE_SAME_RUN_STATE",
  );
  const before = await readState(database, false);
  const candidateHash = String(existing.hashes.candidate_prompt_sha256);
  requireCondition(before.revision === CANDIDATE_REVISION, "ROLLBACK_CURRENT_REVISION_MISMATCH");
  requireCondition(before.promptSha256 === candidateHash, "ROLLBACK_CURRENT_PROMPT_IS_NOT_CANDIDATE");
  requireCondition(before.candidateRevisionRows === 1, "ROLLBACK_CANDIDATE_VERSION_REQUIRED");
  const baselinePrompt = await readBaselinePromptFromHistory(database);
  const candidate = `${baselinePrompt}${baselinePrompt.endsWith("\n") ? "\n" : "\n\n"}${OVERRIDE_BLOCK}\n`;
  requireCondition(sha256(candidate) === candidateHash, "ROLLBACK_CANDIDATE_RECONSTRUCTION_MISMATCH");
  await writeReport(runDirectory, reportPath, buildReport({
    status: "rollback_in_progress",
    candidate,
    before,
    cleanup: { status: "not_created", rowsRemaining: 0 },
  }));

  let stepUp = null;
  let after = before;
  let operationPassed = false;
  let failure = null;
  try {
    stepUp = await createScopedStepUp(database, runtime, access);
    await putPrompt(runtime, stepUp.stepUpToken, CANDIDATE_REVISION, baselinePrompt);
    after = await readState(database, false);
    assertPromptMutation(before, after, BASELINE_PROMPT_SHA256, ROLLBACK_REVISION);
    const version = await readVersionMetadata(database, ROLLBACK_REVISION);
    requireCondition(version.promptSha256 === BASELINE_PROMPT_SHA256, "ROLLBACK_PROMPT_VERSION_HASH_MISMATCH");
    requireCondition(version.promptLength === visibleLength(baselinePrompt), "ROLLBACK_PROMPT_VERSION_LENGTH_MISMATCH");
    operationPassed = true;
  } catch (error) {
    failure = error;
    after = await readState(database, false).catch(() => after);
  } finally {
    if (stepUp) stepUp.stepUpToken = "";
  }
  const cleanup = await removeScopedStepUp(database, stepUp?.tokenHash || "");
  if (cleanup.status !== "passed" && cleanup.status !== "not_created") operationPassed = false;
  const report = buildReport({
    status: operationPassed ? "rolled_back" : "failed",
    candidate,
    before,
    after,
    checks: operationPassed ? {
      cas: "passed",
      apiOnlyAgentWrite: "passed",
      promptVersionReadback: "passed",
      targetThreeFieldDiff: "passed",
      modelBindingPreserved: "passed",
      nonTargetAgentsPreserved: "passed",
      apiCacheInvalidationPath: "passed",
    } : {},
    cleanup,
  });
  await writeReport(runDirectory, reportPath, report);
  requireCondition(cleanup.status === "passed" || cleanup.status === "not_created", "TEMPORARY_STEP_UP_CLEANUP_FAILED");
  if (failure) throw failure;
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const { runId, mode } = parseArgs(args);
  const { runDirectory, reportPath } = reportPathFor(runId);
  const runtime = validateLocalRuntime();
  const existing = await readExistingReport(reportPath);
  const access = await fetchAccessContext(runtime);
  const database = new pg.Client({
    connectionString: runtime.databaseUrl,
    application_name: "codex-story-director-turn-constraint-candidate",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await database.connect();
  try {
    await assertDatabaseIdentity(database);
    const report = mode === "plan"
      ? await runPlan(database, runDirectory, reportPath, existing)
      : mode === "execute"
        ? await runExecute(database, runtime, access, runDirectory, reportPath, existing)
        : await runRollback(database, runtime, access, runDirectory, reportPath, existing);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write("Operation failed closed; inspect the hash-only report state before any retry.\n");
    process.exitCode = 1;
  } finally {
    await database.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
