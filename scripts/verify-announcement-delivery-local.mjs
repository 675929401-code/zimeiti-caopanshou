#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260929093000";
const MIGRATION_FILE = `${VERSION}_announcement_account_delivery.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_FIXTURE_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-announcement-delivery-verification"),
  "LOCAL_ANNOUNCEMENT_VERIFICATION_CONFIRMATION_REQUIRED",
);

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const suffix = crypto.randomUUID().replace(/-/gu, "").slice(0, 12);
const fixtures = {
  actor: crypto.randomUUID(),
  userA: crypto.randomUUID(),
  userB: crypto.randomUUID(),
  announcement: crypto.randomUUID(),
};
const clients = [0, 1, 2].map((index) => new pg.Client({
  ...runtime.ownerConnection,
  application_name: `codex-local-announcement-verification-${index}`,
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
}));

async function assertLocalIdentity(client) {
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

async function cleanup(client) {
  await client.query("DELETE FROM public.announcements WHERE id=$1", [fixtures.announcement]);
  await client.query("DELETE FROM public.users WHERE id=ANY($1::varchar[])", [
    [fixtures.actor, fixtures.userA, fixtures.userB],
  ]);
}

for (const client of clients) {
  await client.connect();
  await assertLocalIdentity(client);
}

const [control, pushA, pushB] = clients;
let setupCommitted = false;
try {
  const ledger = await control.query(
    "SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledger.rowCount, 1, "ANNOUNCEMENT_MIGRATION_NOT_APPLIED");
  assert.equal(String(ledger.rows[0].hash || ""), migrationHash, "ANNOUNCEMENT_MIGRATION_HASH_DRIFT");

  await control.query("BEGIN");
  await control.query(
    `INSERT INTO public.users
      (id,username,password_hash,display_name,role,credits,is_active,status,email)
     VALUES
      ($1,$4,'verification-only','公告验收管理员','admin',0,true,'active',$7),
      ($2,$5,'verification-only','公告验收甲','student',0,true,'active',$8),
      ($3,$6,'verification-only','公告验收乙','student',0,true,'active',$9)`,
    [
      fixtures.actor,
      fixtures.userA,
      fixtures.userB,
      `announcement-admin-${suffix}`,
      `announcement-a-${suffix}`,
      `announcement-b-${suffix}`,
      `announcement-admin-${suffix}@example.invalid`,
      `announcement-a-${suffix}@example.invalid`,
      `announcement-b-${suffix}@example.invalid`,
    ],
  );
  await control.query(
    `INSERT INTO public.announcements
      (id,title,content,is_pinned,is_active,priority,status,summary,target_audience,target_user_ids,
       frequency_hours,max_impressions,require_ack)
     VALUES($1,'公告投递验收','初始内容',false,true,'important','published','验收摘要','selected',$2::jsonb,24,3,true)`,
    [fixtures.announcement, JSON.stringify([fixtures.userA, fixtures.userB])],
  );
  await control.query("COMMIT");
  setupCommitted = true;

  const initial = (await control.query(
    "SELECT push_revision,first_published_at,last_pushed_at FROM public.announcements WHERE id=$1",
    [fixtures.announcement],
  )).rows[0];
  assert.equal(initial.push_revision, 1, "FIRST_PUBLICATION_REVISION_MUST_BE_ONE");
  assert.ok(initial.first_published_at && initial.last_pushed_at, "FIRST_PUBLICATION_TIMESTAMPS_REQUIRED");
  const initialRun = await control.query(
    "SELECT revision,push_kind,target_count FROM public.announcement_push_runs WHERE announcement_id=$1",
    [fixtures.announcement],
  );
  assert.equal(initialRun.rowCount, 1);
  assert.deepEqual(
    [initialRun.rows[0].revision, initialRun.rows[0].push_kind, initialRun.rows[0].target_count],
    [1, "initial", 2],
  );

  await control.query(
    "UPDATE public.announcements SET content='普通编辑后的内容',updated_at=clock_timestamp() WHERE id=$1",
    [fixtures.announcement],
  );
  const afterEdit = (await control.query(
    "SELECT push_revision FROM public.announcements WHERE id=$1",
    [fixtures.announcement],
  )).rows[0];
  assert.equal(afterEdit.push_revision, 1, "ORDINARY_EDIT_MUST_NOT_REPUSH");

  const firstRead = (await control.query(
    "SELECT public.mark_announcement_read($1,$2,$3) AS value",
    [fixtures.announcement, fixtures.userA, 1],
  )).rows[0].value;
  const duplicateRead = (await control.query(
    "SELECT public.mark_announcement_read($1,$2,$3) AS value",
    [fixtures.announcement, fixtures.userA, 1],
  )).rows[0].value;
  assert.equal(firstRead.alreadyRead, false);
  assert.equal(duplicateRead.alreadyRead, true);
  assert.equal(duplicateRead.readAt, firstRead.readAt, "IDEMPOTENT_READ_TIMESTAMP_MUST_BE_STABLE");
  const userBRevisionOne = await control.query(
    `SELECT 1 FROM public.announcement_user_reads
     WHERE announcement_id=$1 AND revision=1 AND user_id=$2`,
    [fixtures.announcement, fixtures.userB],
  );
  assert.equal(userBRevisionOne.rowCount, 0, "ACCOUNT_READ_STATE_MUST_BE_ISOLATED");

  const race = await Promise.allSettled([
    pushA.query(
      "SELECT public.repush_announcement_atomic($1,$2,$3,$4) AS value",
      [fixtures.announcement, fixtures.actor, 1, "concurrency-a"],
    ),
    pushB.query(
      "SELECT public.repush_announcement_atomic($1,$2,$3,$4) AS value",
      [fixtures.announcement, fixtures.actor, 1, "concurrency-b"],
    ),
  ]);
  const winners = race.filter((result) => result.status === "fulfilled");
  const losers = race.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1, "CAS_CONCURRENCY_MUST_HAVE_ONE_WINNER");
  assert.equal(losers.length, 1, "CAS_CONCURRENCY_MUST_REJECT_ONE_STALE_WRITER");
  assert.match(String(losers[0].reason?.message || ""), /ANNOUNCEMENT_REVISION_CONFLICT/u);
  const winner = winners[0].value.rows[0].value;
  assert.equal(winner.previousRevision, 1);
  assert.equal(winner.revision, 2);

  const afterRace = (await control.query(
    "SELECT push_revision FROM public.announcements WHERE id=$1",
    [fixtures.announcement],
  )).rows[0];
  assert.equal(afterRace.push_revision, 2);
  const revisionTwoRuns = await control.query(
    `SELECT id FROM public.announcement_push_runs
     WHERE announcement_id=$1 AND revision=2 AND push_kind='repush'`,
    [fixtures.announcement],
  );
  assert.equal(revisionTwoRuns.rowCount, 1, "REPUSH_RUN_MUST_BE_EXACTLY_ONCE");

  const beforeRevisionTwoRead = (await control.query(
    "SELECT public.get_announcement_delivery_status($1,$2,$3,$4,$5) AS value",
    [fixtures.announcement, 2, 1, 20, "all"],
  )).rows[0].value;
  assert.deepEqual(
    [beforeRevisionTwoRead.summary.targetCount, beforeRevisionTwoRead.summary.readCount, beforeRevisionTwoRead.summary.unreadCount],
    [2, 0, 2],
    "NEW_REVISION_MUST_RESET_CURRENT_READ_STATUS",
  );

  const userBRead = (await control.query(
    "SELECT public.mark_announcement_read($1,$2,$3) AS value",
    [fixtures.announcement, fixtures.userB, 2],
  )).rows[0].value;
  const userBReadAgain = (await control.query(
    "SELECT public.mark_announcement_read($1,$2,$3) AS value",
    [fixtures.announcement, fixtures.userB, 2],
  )).rows[0].value;
  assert.equal(userBReadAgain.alreadyRead, true);
  assert.equal(userBReadAgain.readAt, userBRead.readAt);

  const finalStatus = (await control.query(
    "SELECT public.get_announcement_delivery_status($1,$2,$3,$4,$5) AS value",
    [fixtures.announcement, 2, 1, 1, "unread"],
  )).rows[0].value;
  assert.deepEqual(
    [finalStatus.summary.targetCount, finalStatus.summary.readCount, finalStatus.summary.unreadCount],
    [2, 1, 1],
  );
  assert.equal(finalStatus.pagination.total, 1);
  assert.equal(finalStatus.recipients.length, 1);
  assert.equal(finalStatus.recipients[0].userId, fixtures.userA, "UNREAD_PAGE_MUST_PRESERVE_ACCOUNT_ISOLATION");

  await control.query(
    "UPDATE public.announcements SET title='强推后的普通编辑',updated_at=clock_timestamp() WHERE id=$1",
    [fixtures.announcement],
  );
  const finalRevision = (await control.query(
    "SELECT push_revision FROM public.announcements WHERE id=$1",
    [fixtures.announcement],
  )).rows[0].push_revision;
  assert.equal(finalRevision, 2, "POST_PUSH_ORDINARY_EDIT_MUST_NOT_REPUSH");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    migration: MIGRATION_FILE,
    migrationHash,
    assertions: {
      firstPublicationRevision: true,
      ordinaryEditNoRepush: true,
      readIdempotency: true,
      accountIsolation: true,
      expectedRevisionCasConcurrency: true,
      deliveryPagination: true,
    },
    fixturesRemoved: true,
    productionWrites: 0,
    providerRequests: 0,
    credentialsPrinted: false,
  };
  await cleanup(control);
  setupCommitted = false;
  const evidenceDir = path.resolve(".codex-evidence", "announcement-account-delivery");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "database-verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (setupCommitted) await cleanup(control).catch(() => undefined);
  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
}
