#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));

assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.ok(String(runtime.postgresPassword || "").length >= 8, "LOCAL_POSTGRES_CREDENTIAL_REQUIRED");

const client = new pg.Client({
  host: "127.0.0.1",
  port: 54322,
  database: "zimeiti_local",
  user: "postgres",
  password: String(runtime.postgresPassword),
  application_name: "codex-user-content-retention-transaction-verifier",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

const checks = [];
function check(name, condition, evidence = undefined) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, ...(evidence === undefined ? {} : { evidence }) });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function protectedCounts() {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::bigint FROM public.agents)::text AS agents,
      (SELECT count(*)::bigint FROM public.agent_memories)::text AS agent_memories,
      (SELECT count(*)::bigint FROM public.text_chat_memories)::text AS text_chat_memories,
      (SELECT count(*)::bigint FROM public.user_files)::text AS user_files
  `);
  return result.rows[0];
}

async function insertRunningExtraction({ recordId, userId, clientRequestId, fingerprint, mode, createdAt }) {
  await client.query(`
    INSERT INTO public.extraction_attempts (
      record_id,user_id,client_request_id,request_kind,payload_fingerprint,state,
      provider_evidence,billing_evidence,provider_checkpoint,request_snapshot,
      created_at,updated_at
    ) VALUES ($1,$2,$3,'single',$4,'running',$5::jsonb,$6::jsonb,'{}'::jsonb,$7::jsonb,$8,$8)
  `, [
    recordId,
    userId,
    clientRequestId,
    fingerprint,
    JSON.stringify({ provider: "local-fixture", request: clientRequestId }),
    JSON.stringify({ charged: true, operation: `local-${clientRequestId}` }),
    JSON.stringify({ payload: { extraction_mode: mode, url: "https://fixture.invalid/source" } }),
    createdAt,
  ]);
}

await client.connect();
let transactionOpen = false;
const fixturePrefix = `retention-${randomUUID()}`;
const oldConversationId = `${fixturePrefix}-old-conversation`;
const freshConversationId = `${fixturePrefix}-fresh-conversation`;
const oldMessageId = `${fixturePrefix}-old-message`;
const freshMessageId = `${fixturePrefix}-fresh-message`;
const rawVideoRecordId = sha256(`${fixturePrefix}:raw-video`);
const oldTextRecordId = sha256(`${fixturePrefix}:old-text`);
const freshTextRecordId = sha256(`${fixturePrefix}:fresh-text`);
const videoTaskId = `${fixturePrefix}-video-task`;

try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `)).rows[0];
  check("live target is the isolated local database",
    identity.database_name === "zimeiti_local"
      && identity.server_address === "127.0.0.1"
      && Number(identity.server_port) === 54322,
    { target: "127.0.0.1:54322/zimeiti_local" });

  const privilege = (await client.query(`
    SELECT
      has_function_privilege('service_role', 'public.purge_expired_user_content(integer,integer,integer)', 'EXECUTE') AS service_purge,
      has_function_privilege('service_role', 'public.mark_video_upstream_source_expired(text,text,integer)', 'EXECUTE') AS service_expiry,
      has_function_privilege('anon', 'public.purge_expired_user_content(integer,integer,integer)', 'EXECUTE') AS anon_purge,
      has_function_privilege('authenticated', 'public.mark_video_upstream_source_expired(text,text,integer)', 'EXECUTE') AS authenticated_expiry
  `)).rows[0];
  check("retention mutation functions are service-only",
    privilege.service_purge === true
      && privilege.service_expiry === true
      && privilege.anon_purge === false
      && privilege.authenticated_expiry === false,
    privilege);

  const user = (await client.query("SELECT id::text AS id FROM public.users ORDER BY created_at ASC LIMIT 1")).rows[0];
  const model = (await client.query("SELECT id::text AS id FROM public.video_models ORDER BY created_at ASC LIMIT 1")).rows[0];
  check("local fixtures have an existing user and video model", Boolean(user?.id) && Boolean(model?.id));

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='120s'");

  const protectedBefore = await protectedCounts();

  await client.query(`
    INSERT INTO public.conversations (id,user_id,agent_id,title,source,created_at,updated_at)
    VALUES
      ($1,$3,'retention-fixture-agent','expired conversation','local-fixture','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z'),
      ($2,$3,'retention-fixture-agent','fresh conversation','local-fixture',now(),now())
  `, [oldConversationId, freshConversationId, user.id]);
  await client.query(`
    INSERT INTO public.conversation_messages (id,conversation_id,user_id,agent_id,role,content,created_at,updated_at)
    VALUES
      ($1,$3,$5,'retention-fixture-agent','user','expired message','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z'),
      ($2,$4,$5,'retention-fixture-agent','user','fresh message',now(),now())
  `, [oldMessageId, freshMessageId, oldConversationId, freshConversationId, user.id]);

  await insertRunningExtraction({
    recordId: rawVideoRecordId,
    userId: user.id,
    clientRequestId: `${fixturePrefix}-raw-video`,
    fingerprint: sha256(`${fixturePrefix}:raw-video-payload`),
    mode: "video",
    createdAt: new Date(),
  });
  await client.query(`
    UPDATE public.extraction_attempts
       SET state='succeeded',http_status=200,response=$2::jsonb,error_message='must be scrubbed',updated_at=now()
     WHERE record_id=$1
  `, [rawVideoRecordId, JSON.stringify({ downloadUrl: "https://fixture.invalid/video.mp4" })]);
  const rawVideo = (await client.query(`
    SELECT response,request_snapshot,error_message,content_purged_at,provider_evidence,billing_evidence
      FROM public.extraction_attempts WHERE record_id=$1
  `, [rawVideoRecordId])).rows[0];
  check("terminal raw-video content is scrubbed in the finalize transaction",
    rawVideo.response === null
      && rawVideo.request_snapshot === null
      && rawVideo.error_message === null
      && Boolean(rawVideo.content_purged_at)
      && rawVideo.provider_evidence?.content_retention === "video_transient",
    { contentRetained: false, providerEvidenceRetained: true });
  check("raw-video billing evidence remains durable", rawVideo.billing_evidence?.charged === true);

  await insertRunningExtraction({
    recordId: oldTextRecordId,
    userId: user.id,
    clientRequestId: `${fixturePrefix}-old-text`,
    fingerprint: sha256(`${fixturePrefix}:old-text-payload`),
    mode: "text",
    createdAt: new Date("2000-01-01T00:00:00Z"),
  });
  await insertRunningExtraction({
    recordId: freshTextRecordId,
    userId: user.id,
    clientRequestId: `${fixturePrefix}-fresh-text`,
    fingerprint: sha256(`${fixturePrefix}:fresh-text-payload`),
    mode: "text",
    createdAt: new Date(),
  });
  await client.query(`
    UPDATE public.extraction_attempts
       SET state='succeeded',http_status=200,response=jsonb_build_object('text','retained until expiry'),updated_at=created_at
     WHERE record_id=ANY($1::text[])
  `, [[oldTextRecordId, freshTextRecordId]]);

  await client.query(`
    INSERT INTO public.video_tasks (
      id,user_id,model_id,prompt,status,video_url,content_url,provider_result_url,
      thumbnail_url,storage_url,needs_proxy,explicitly_free,billing_exempt,completed_at
    ) VALUES ($1,$2,$3,'local expiry fixture','completed',$4,$4,$4,$5,NULL,true,true,true,now())
  `, [videoTaskId, user.id, model.id, "https://fixture.invalid/video.mp4", "https://fixture.invalid/thumb.jpg"]);

  await client.query("SAVEPOINT transient_upstream_failure");
  let transientRejected = false;
  try {
    await client.query(
      "SELECT public.mark_video_upstream_source_expired($1,$2,500)",
      [videoTaskId, user.id],
    );
  } catch (error) {
    transientRejected = String(error?.code || "") === "22023"
      && String(error?.message || "").includes("VIDEO_SOURCE_EXPIRY_INPUT_INVALID");
    await client.query("ROLLBACK TO SAVEPOINT transient_upstream_failure");
  }
  await client.query("RELEASE SAVEPOINT transient_upstream_failure");
  const afterTransient = (await client.query(`
    SELECT source_expired_at,history_hidden_at,provider_result_url FROM public.video_tasks WHERE id=$1
  `, [videoTaskId])).rows[0];
  check("timeouts and upstream 5xx cannot hide a completed video",
    transientRejected
      && afterTransient.source_expired_at === null
      && afterTransient.history_hidden_at === null
      && Boolean(afterTransient.provider_result_url));

  const expiryResult = (await client.query(
    "SELECT public.mark_video_upstream_source_expired($1,$2,404) AS result",
    [videoTaskId, user.id],
  )).rows[0]?.result;
  const afterDefinitiveExpiry = (await client.query(`
    SELECT source_expired_at,history_hidden_at,provider_result_url,video_url,content_url,thumbnail_url,needs_proxy
      FROM public.video_tasks WHERE id=$1
  `, [videoTaskId])).rows[0];
  check("only a definitive upstream 404 marks and hides the source",
    expiryResult?.marked === true
      && Boolean(afterDefinitiveExpiry.source_expired_at)
      && Boolean(afterDefinitiveExpiry.history_hidden_at)
      && afterDefinitiveExpiry.provider_result_url === null
      && afterDefinitiveExpiry.video_url === null
      && afterDefinitiveExpiry.content_url === null
      && afterDefinitiveExpiry.thumbnail_url === null
      && afterDefinitiveExpiry.needs_proxy === false,
    { definitiveStatuses: [404, 410] });

  const purge = (await client.query(
    "SELECT public.purge_expired_user_content(30,10,2000) AS result",
  )).rows[0]?.result;
  const contentRows = await client.query(`
    SELECT
      EXISTS(SELECT 1 FROM public.conversations WHERE id=$1) AS old_conversation,
      EXISTS(SELECT 1 FROM public.conversations WHERE id=$2) AS fresh_conversation,
      EXISTS(SELECT 1 FROM public.conversation_messages WHERE id=$3) AS old_message,
      EXISTS(SELECT 1 FROM public.conversation_messages WHERE id=$4) AS fresh_message,
      (SELECT content_purged_at IS NOT NULL AND response IS NULL AND request_snapshot IS NULL
         FROM public.extraction_attempts WHERE record_id=$5) AS old_text_purged,
      (SELECT content_purged_at IS NULL AND response IS NOT NULL AND request_snapshot IS NOT NULL
         FROM public.extraction_attempts WHERE record_id=$6) AS fresh_text_retained
  `, [oldConversationId, freshConversationId, oldMessageId, freshMessageId, oldTextRecordId, freshTextRecordId]);
  const content = contentRows.rows[0];
  check("30-day conversation retention removes expired content and keeps fresh content",
    content.old_conversation === false
      && content.old_message === false
      && content.fresh_conversation === true
      && content.fresh_message === true,
    { conversationDays: 30 });
  check("10-day text extraction retention scrubs expired content and keeps fresh content",
    content.old_text_purged === true && content.fresh_text_retained === true,
    { extractionDays: 10 });
  check("purge reports protected durable collections",
    Array.isArray(purge?.protected_collections)
      && ["agents", "agent_memories", "text_chat_memories", "user_files", "billing_evidence", "provider_evidence"]
        .every((name) => purge.protected_collections.includes(name)));

  const oldTextEvidence = (await client.query(`
    SELECT provider_evidence,billing_evidence FROM public.extraction_attempts WHERE record_id=$1
  `, [oldTextRecordId])).rows[0];
  check("expired extraction keeps provider and billing evidence",
    oldTextEvidence.provider_evidence?.provider === "local-fixture"
      && oldTextEvidence.provider_evidence?.content_retention === "expired_after_10_days"
      && oldTextEvidence.billing_evidence?.charged === true);

  const protectedAfter = await protectedCounts();
  check("retention purge does not alter agents memories or user files",
    JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore),
    { protectedCollections: Object.keys(protectedBefore) });

  await client.query("ROLLBACK");
  transactionOpen = false;

  const noFixtureResidue = (await client.query(`
    SELECT
      NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=ANY($1::text[])) AS conversations_clean,
      NOT EXISTS(SELECT 1 FROM public.extraction_attempts WHERE record_id=ANY($2::text[])) AS extractions_clean,
      NOT EXISTS(SELECT 1 FROM public.video_tasks WHERE id=$3) AS videos_clean
  `, [[oldConversationId, freshConversationId], [rawVideoRecordId, oldTextRecordId, freshTextRecordId], videoTaskId])).rows[0];
  check("all transactional fixtures are rolled back",
    noFixtureResidue.conversations_clean === true
      && noFixtureResidue.extractions_clean === true
      && noFixtureResidue.videos_clean === true,
    { persistentDatabaseWrites: 0 });

  const report = {
    observedAt: new Date().toISOString(),
    result: { total: checks.length, passed: checks.length, failed: 0 },
    target: "127.0.0.1:54322/zimeiti_local",
    scenarios: {
      rawVideoImmediateScrub: true,
      textExtractionDays: 10,
      conversationDays: 30,
      upstreamExpiryStatuses: [404, 410],
      protectedCollectionsUnchanged: true,
    },
    safety: {
      providerRequests: 0,
      paidTasksCreated: 0,
      persistentDatabaseWrites: 0,
      productionChanges: 0,
      credentialsPrinted: false,
    },
    checks,
  };
  const evidenceDirectory = path.resolve(".codex-evidence", "user-content-retention-20261009");
  await mkdir(evidenceDirectory, { recursive: true });
  const output = path.join(evidenceDirectory, "transaction-report.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, ...report.result, scenarios: report.scenarios, safety: report.safety }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    providerRequests: 0,
    paidTasksCreated: 0,
    persistentDatabaseWrites: 0,
    credentialsPrinted: false,
  }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
