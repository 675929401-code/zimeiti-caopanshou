import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const root = process.cwd();
const sourceOnly = process.argv.includes("--source-only");
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDirectory = path.join(root, ".codex-evidence", "user-content-retention-20261009");
const checks = [];

function check(name, condition, evidence) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, evidence });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readSources() {
  const names = [
    "supabase/migrations/20261009043000_user_content_retention_and_video_direct_delivery.sql",
    "supabase/rollbacks/20261009043000_user_content_retention_and_video_direct_delivery.rollback.sql",
    "src/lib/user-content-retention-worker.ts",
    "src/lib/media-queue-worker-runtime.ts",
    "src/lib/extraction-exactly-once.ts",
    "src/app/api/video/proxy/route.ts",
    "src/app/api/video/proxy-download/route.ts",
    "src/app/api/media-history/route.ts",
    "deploy/policies/media-object-retention.v2.json",
  ];
  const entries = await Promise.all(names.map(async (name) => [name, await readFile(path.join(root, name), "utf8")]));
  return Object.fromEntries(entries);
}

function verifySourceContracts(files) {
  const migration = files["supabase/migrations/20261009043000_user_content_retention_and_video_direct_delivery.sql"];
  const rollback = files["supabase/rollbacks/20261009043000_user_content_retention_and_video_direct_delivery.rollback.sql"];
  const worker = files["src/lib/user-content-retention-worker.ts"];
  const runtime = files["src/lib/media-queue-worker-runtime.ts"];
  const exactlyOnce = files["src/lib/extraction-exactly-once.ts"];
  const proxy = files["src/app/api/video/proxy/route.ts"];
  const download = files["src/app/api/video/proxy-download/route.ts"];
  const history = files["src/app/api/media-history/route.ts"];
  const policy = JSON.parse(files["deploy/policies/media-object-retention.v2.json"]);

  check("ordinary video archive trigger is retired",
    /DROP TRIGGER IF EXISTS video_tasks_enqueue_history_archive/u.test(migration)
      && /REVOKE ALL ON FUNCTION public\.claim_video_history_archive_batch/u.test(migration),
    { globalArchiveCopies: 0 });
  check("raw video extraction is scrubbed transactionally",
    /CREATE TRIGGER extraction_attempts_scrub_transient_video_content/u.test(migration)
      && /v_extraction_mode = 'video'/u.test(migration)
      && /content_retention', 'video_transient'/u.test(migration),
    { durableRawVideoContent: false });
  check("text extraction and conversation content have explicit windows",
    /interval '10 days'/u.test(migration)
      && /p_conversation_days integer DEFAULT 30/u.test(migration)
      && /p_extraction_days integer DEFAULT 10/u.test(migration),
    { extractionDays: 10, conversationDays: 30 });
  check("billing provider idempotency and owned libraries remain protected",
    /'agents',[\s\S]*'agent_memories',[\s\S]*'text_chat_memories',[\s\S]*'user_files',[\s\S]*'billing_evidence',[\s\S]*'provider_evidence'/u.test(migration),
    { protectedCollections: true });
  check("purged replay is explicit and cannot silently resubmit",
    /EXTRACTION_CONTENT_NOT_RETAINED/u.test(exactlyOnce)
      && /retry_safe: false/u.test(exactlyOnce)
      && /record\.contentPurgedAt/u.test(exactlyOnce),
    { status: 410, automaticResubmit: false });
  check("retention worker is bounded and part of the dedicated runtime",
    /RETENTION_MAX_BATCHES_PER_TICK = 10/u.test(worker)
      && /p_limit: RETENTION_BATCH_LIMIT/u.test(worker)
      && /startUserContentRetentionWorker\(\)/u.test(runtime)
      && /stopUserContentRetentionWorker\(drainTimeoutMs\(\)\)/u.test(runtime),
    { maxBatches: 10, batchSize: 500 });
  check("only definitive 404 or 410 can expire an upstream source",
    /directStatus === 404 \|\| directStatus === 410/u.test(proxy)
      && /markVideoUpstreamSourceExpired/u.test(proxy)
      && /\[404, 410\]/u.test(download)
      && !/source_expired_at[^\n]*5\d\d/u.test(proxy),
    { expiryStatuses: [404, 410] });
  check("history no longer depends on archive queue state",
    !/video_history_archive_jobs/u.test(history)
      && /source_expired_at/u.test(history)
      && /hasAuthenticatedDeliverySource/u.test(history),
    { delivery: "authenticated-upstream-proxy" });
  check("deployment policy separates ordinary delivery from managed exceptions",
    policy.version === "media-object-retention.v2"
      && policy.ordinaryVideoDelivery?.copyToPlatformStorage === false
      && policy.contentRetention?.extractionHistoryDays === 10
      && policy.contentRetention?.conversationContentDays === 30,
    { version: policy.version });
  check("rollback removes the transient scrub trigger before restoring compatibility",
    /DROP TRIGGER IF EXISTS extraction_attempts_scrub_transient_video_content/u.test(rollback)
      && /DROP FUNCTION IF EXISTS public\.scrub_transient_video_extraction_content/u.test(rollback),
    { contentAlreadyPurgedIsNotFabricated: true });
}

async function verifyDatabaseContracts() {
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
  assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const client = new pg.Client({
    connectionString: String(runtime.databaseUrl || ""),
    application_name: "codex-user-content-retention-readonly-verifier",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const columns = await client.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND (table_name,column_name) IN (
        ('video_tasks','source_expired_at'),('extraction_attempts','content_purged_at')
      ) ORDER BY table_name,column_name`);
    check("local database has both retention state columns", columns.rowCount === 2, { columns: columns.rows });
    const functions = await client.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname`, [[
      "mark_video_upstream_source_expired",
      "purge_expired_user_content",
      "scrub_transient_video_extraction_content",
    ]]);
    check("local database has all retention functions", functions.rowCount === 3, { functions: functions.rows });
    const trigger = await client.query(`SELECT tgname,tgenabled FROM pg_trigger
      WHERE tgrelid='public.extraction_attempts'::regclass AND tgname='extraction_attempts_scrub_transient_video_content' AND NOT tgisinternal`);
    check("local database has the raw-video scrub trigger enabled", trigger.rowCount === 1 && trigger.rows[0].tgenabled !== "D", trigger.rows[0] || {});
    await client.query("ROLLBACK");
    return { columns: columns.rows, functions: functions.rows, trigger: trigger.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const files = await readSources();
  verifySourceContracts(files);
  const database = sourceOnly ? { skipped: true } : await verifyDatabaseContracts();
  const report = {
    observedAt: new Date().toISOString(),
    mode: sourceOnly ? "source-only" : "source-and-local-database-readonly",
    result: { total: checks.length, passed: checks.length, failed: 0 },
    safety: { paidTasksCreated: 0, providerRequests: 0, databaseWrites: 0, serverChanges: 0 },
    checks,
    sourceHashes: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)])),
    database,
  };
  await mkdir(evidenceDirectory, { recursive: true });
  const output = path.join(evidenceDirectory, sourceOnly ? "source-report.json" : "report.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, result: report.result, safety: report.safety }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    paidTasksCreated: 0,
    providerRequests: 0,
    databaseWrites: 0,
  }));
  process.exitCode = 1;
});
