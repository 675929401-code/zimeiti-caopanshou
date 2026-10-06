#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002150000";
const MIGRATION_FILE = `${VERSION}_unified_messaging_control_plane.sql`;
const ROLLBACK_FILE = `${VERSION}_unified_messaging_control_plane.rollback.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_FIXTURE_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-unified-messaging-control-plane"),
  "LOCAL_UNIFIED_MESSAGING_CONFIRMATION_REQUIRED",
);

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const rollbackSource = await fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8");

function transactionBody(source, label) {
  const withoutBegin = source.replace(/^\uFEFF?BEGIN;\s*/u, "");
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/u, "");
  assert.notEqual(withoutBegin, source, `${label}_BEGIN_REQUIRED`);
  assert.notEqual(withoutCommit, withoutBegin, `${label}_COMMIT_REQUIRED`);
  return withoutCommit;
}

const migrationBody = transactionBody(migrationSource, "MIGRATION");
const rollbackBody = transactionBody(rollbackSource, "ROLLBACK");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const rollbackHash = crypto.createHash("sha256").update(rollbackSource).digest("hex");
const suffix = crypto.randomUUID().replace(/-/gu, "").slice(0, 12);
const keys = {
  template: `verify.template.${suffix}`,
  policy: `verify.policy.${suffix}`,
  campaign: `verify.campaign.${suffix}`,
  run: `verify-run-${suffix}`,
  runIdempotency: `verify:run:${suffix}`,
  delivery: `verify:delivery:${suffix}`,
  outbox: `verify:outbox:${suffix}`,
  event: `verify:event:${suffix}`,
};

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-unified-messaging-verification",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});

async function assertLocalIdentity() {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );
}

async function relationCount() {
  return Number((await client.query(
    `SELECT count(*)::integer AS count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public'
       AND c.relname=ANY($1::text[])`,
    [[
      "message_templates",
      "message_surface_policies",
      "message_campaigns",
      "message_campaign_runs",
      "message_deliveries",
      "message_events",
      "message_outbox",
      "message_dead_letters",
    ]],
  )).rows[0]?.count || 0);
}

let began = false;
await client.connect();
try {
  await assertLocalIdentity();
  const ledgerBefore = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledgerBefore.rowCount, 0, "UNIFIED_MESSAGING_MIGRATION_ALREADY_APPLIED");
  assert.equal(await relationCount(), 0, "UNIFIED_MESSAGING_SCHEMA_ALREADY_PRESENT");

  await client.query("BEGIN");
  began = true;
  await client.query(migrationBody);

  const rls = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public'
       AND c.relname=ANY($1::text[])
     ORDER BY c.relname`,
    [[
      "message_templates",
      "message_surface_policies",
      "message_campaigns",
      "message_campaign_runs",
      "message_deliveries",
      "message_events",
      "message_outbox",
      "message_dead_letters",
    ]],
  );
  assert.equal(rls.rowCount, 8, "UNIFIED_MESSAGING_TABLE_COUNT_INVALID");
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}_RLS_REQUIRED`);
    assert.equal(row.relforcerowsecurity, false, `${row.relname}_OWNER_RPC_ACCESS_REQUIRED`);
  }

  const grants = await client.query(
    `SELECT
       bool_or(has_table_privilege('anon', format('public.%I', c.relname), 'SELECT')) AS anon_select,
       bool_or(has_table_privilege('authenticated', format('public.%I', c.relname), 'SELECT')) AS authenticated_select
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname LIKE 'message_%'`,
  );
  assert.equal(grants.rows[0].anon_select, false, "ANON_SELECT_MUST_BE_REVOKED");
  assert.equal(grants.rows[0].authenticated_select, false, "AUTHENTICATED_SELECT_MUST_BE_REVOKED");

  const templateId = (await client.query(
    `INSERT INTO public.message_templates
       (template_key, version, status, title_template, body_template)
     VALUES ($1, 1, 'active', '本地事务探针', '仅用于回滚内验证')
     RETURNING id`,
    [keys.template],
  )).rows[0].id;
  const policyId = (await client.query(
    `INSERT INTO public.message_surface_policies
       (policy_key, version, status, category, priority, surfaces, primary_surface)
     VALUES ($1, 1, 'active', 'system', 'P2', ARRAY['toast','inbox'], 'toast')
     RETURNING id`,
    [keys.policy],
  )).rows[0].id;
  const campaignId = (await client.query(
    `INSERT INTO public.message_campaigns
       (campaign_key, name, status, category, priority, template_id, surface_policy_id, audience_rule)
     VALUES ($1, '本地事务探针', 'active', 'system', 'P2', $2, $3, '{"kind":"selected"}'::jsonb)
     RETURNING id`,
    [keys.campaign, templateId, policyId],
  )).rows[0].id;
  const runId = (await client.query(
    `INSERT INTO public.message_campaign_runs
       (campaign_id, run_key, revision, status, template_snapshot, audience_snapshot,
        surface_policy_snapshot, target_count, queued_count, idempotency_key)
     VALUES ($1, $2, 1, 'queued', '{"title":"本地事务探针"}'::jsonb,
       '{"recipientKeys":["verification-user"]}'::jsonb,
       '{"surfaces":["toast","inbox"]}'::jsonb, 1, 1, $3)
     RETURNING id`,
    [campaignId, keys.run, keys.runIdempotency],
  )).rows[0].id;
  const deliveryId = (await client.query(
    `INSERT INTO public.message_deliveries
       (run_id, recipient_type, recipient_key, channel, surface, idempotency_key)
     VALUES ($1, 'user', 'verification-user', 'in_app', 'toast', $2)
     RETURNING id`,
    [runId, keys.delivery],
  )).rows[0].id;

  const enqueueArgs = [
    keys.outbox,
    "message_delivery",
    deliveryId,
    "message.delivery.requested",
    JSON.stringify({ deliveryId, verification: true }),
    "P2",
    runId,
    deliveryId,
    2,
    `verify-trace-${suffix}`,
  ];
  const enqueueSql = `SELECT public.enqueue_message_outbox_atomic(
    $1, $2, $3, $4, $5::jsonb, $6, $7::uuid, $8::uuid, $9, clock_timestamp(), $10
  ) AS receipt`;
  const firstEnqueue = (await client.query(enqueueSql, enqueueArgs)).rows[0].receipt;
  const duplicateEnqueue = (await client.query(enqueueSql, enqueueArgs)).rows[0].receipt;
  assert.equal(firstEnqueue.alreadyExisted, false);
  assert.equal(duplicateEnqueue.alreadyExisted, true);
  assert.equal(duplicateEnqueue.outboxId, firstEnqueue.outboxId, "IDEMPOTENT_OUTBOX_ID_MUST_BE_STABLE");

  await client.query("SAVEPOINT expected_idempotency_conflict");
  try {
    await client.query(enqueueSql, [
      ...enqueueArgs.slice(0, 4),
      JSON.stringify({ deliveryId, verification: false }),
      ...enqueueArgs.slice(5),
    ]);
    assert.fail("IDEMPOTENCY_CONFLICT_REQUIRED");
  } catch (error) {
    assert.match(String(error.message || ""), /MESSAGE_OUTBOX_IDEMPOTENCY_CONFLICT/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_idempotency_conflict");

  const firstClaim = (await client.query(
    "SELECT * FROM public.claim_message_outbox_batch($1, $2, $3)",
    [`verify-worker-${suffix}`, 10, 30],
  )).rows;
  assert.equal(firstClaim.length, 1, "FIRST_CLAIM_MUST_RETURN_ONE");
  assert.equal(firstClaim[0].status, "processing");
  assert.equal(firstClaim[0].attempt_count, 1);
  assert.ok(firstClaim[0].lease_token);

  const retryReceipt = (await client.query(
    "SELECT public.settle_message_outbox_attempt($1, $2, false, $3, $4, 0) AS receipt",
    [firstClaim[0].id, firstClaim[0].lease_token, "VERIFY_RETRY", "first attempt"],
  )).rows[0].receipt;
  assert.equal(retryReceipt.status, "retry");

  const secondClaim = (await client.query(
    "SELECT * FROM public.claim_message_outbox_batch($1, $2, $3)",
    [`verify-worker-${suffix}`, 10, 30],
  )).rows;
  assert.equal(secondClaim.length, 1, "SECOND_CLAIM_MUST_RETURN_ONE");
  assert.equal(secondClaim[0].attempt_count, 2);

  const deadLetterReceipt = (await client.query(
    "SELECT public.settle_message_outbox_attempt($1, $2, false, $3, $4, 0) AS receipt",
    [secondClaim[0].id, secondClaim[0].lease_token, "VERIFY_DEAD_LETTER", "second attempt"],
  )).rows[0].receipt;
  assert.equal(deadLetterReceipt.status, "dead_letter");
  const deadLetter = await client.query(
    "SELECT status, reason_code, attempt_count FROM public.message_dead_letters WHERE outbox_id=$1",
    [secondClaim[0].id],
  );
  assert.equal(deadLetter.rowCount, 1);
  assert.deepEqual(
    [deadLetter.rows[0].status, deadLetter.rows[0].reason_code, deadLetter.rows[0].attempt_count],
    ["open", "VERIFY_DEAD_LETTER", 2],
  );

  const repeatedSettlement = (await client.query(
    "SELECT public.settle_message_outbox_attempt($1, $2, false, $3, $4, 0) AS receipt",
    [secondClaim[0].id, secondClaim[0].lease_token, "VERIFY_DEAD_LETTER", "duplicate settlement"],
  )).rows[0].receipt;
  assert.equal(repeatedSettlement.alreadySettled, true);
  assert.equal(repeatedSettlement.status, "dead_letter");

  await client.query(
    `INSERT INTO public.message_events
       (delivery_id, run_id, event_type, event_key, actor_type, payload)
     VALUES ($1, $2, 'dead_letter', $3, 'worker', '{"verification":true}'::jsonb)`,
    [deliveryId, runId, keys.event],
  );

  const status = (await client.query("SELECT public.get_unified_messaging_status() AS status")).rows[0].status;
  assert.equal(status.migration, VERSION);
  assert.equal(Number(status.tableCounts.templates), 1);
  assert.equal(Number(status.tableCounts.campaigns), 1);
  assert.equal(Number(status.tableCounts.runs), 1);
  assert.equal(Number(status.tableCounts.deliveries), 1);
  assert.equal(Number(status.tableCounts.events), 1);
  assert.equal(Number(status.outbox.deadLetter), 1);
  assert.equal(Number(status.deadLetters.open), 1);

  await client.query("SAVEPOINT expected_rollback_guard");
  try {
    await client.query(rollbackBody);
    assert.fail("ROLLBACK_EVIDENCE_GUARD_REQUIRED");
  } catch (error) {
    assert.match(String(error.message || ""), /ROLLBACK_BLOCKED_UNIFIED_MESSAGING_EVIDENCE_EXISTS/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_rollback_guard");

  await client.query("DELETE FROM public.message_events");
  await client.query("DELETE FROM public.message_dead_letters");
  await client.query("DELETE FROM public.message_outbox");
  await client.query("DELETE FROM public.message_deliveries");
  await client.query("DELETE FROM public.message_campaign_runs");
  await client.query("DELETE FROM public.message_campaigns");
  await client.query("DELETE FROM public.message_surface_policies");
  await client.query("DELETE FROM public.message_templates");
  await client.query(rollbackBody);
  assert.equal(await relationCount(), 0, "ROLLBACK_MUST_REMOVE_NEW_SCHEMA_INSIDE_PROBE");

  await client.query("ROLLBACK");
  began = false;
  assert.equal(await relationCount(), 0, "OUTER_ROLLBACK_MUST_LEAVE_NO_SCHEMA");
  const ledgerAfter = await client.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledgerAfter.rowCount, 0, "OUTER_ROLLBACK_MUST_LEAVE_LEDGER_UNCHANGED");

  console.log(JSON.stringify({
    passed: true,
    mode: "local-outer-transaction",
    migration: VERSION,
    migrationSha256: migrationHash,
    rollbackSha256: rollbackHash,
    checks: {
      tables: 8,
      rlsEnabled: true,
      clientSelectRevoked: true,
      idempotentEnqueue: true,
      idempotencyConflict: true,
      leasedClaim: true,
      retry: true,
      deadLetter: true,
      repeatedSettlement: true,
      statusRpc: true,
      rollbackEvidenceGuard: true,
      rollbackSql: true,
      outerRollback: true,
    },
    persistentFixtures: 0,
    migrationLedgerWrites: 0,
    productionWrites: 0,
  }, null, 2));
} finally {
  if (began) {
    await client.query("ROLLBACK").catch(() => undefined);
  }
  await client.end();
}
