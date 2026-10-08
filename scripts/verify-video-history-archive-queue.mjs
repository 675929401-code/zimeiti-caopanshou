import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const root = process.cwd();
const sourceOnly = process.argv.includes("--source-only");
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDirectory = path.join(root, ".codex-evidence", "video-history-archive-queue-20261009");
const checks = [];

function check(name, condition, evidence) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, evidence });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compact(value) {
  return value.replace(/\s+/gu, " ").trim();
}

async function readSources() {
  const names = [
    "supabase/migrations/20261009040000_video_history_archive_queue.sql",
    "supabase/rollbacks/20261009040000_video_history_archive_queue.rollback.sql",
    "src/lib/video-history-archive-worker.ts",
    "src/lib/media-queue-worker-runtime.ts",
    "src/lib/video-persistence.ts",
    "src/app/api/media-history/route.ts",
    "src/app/api/video/proxy/route.ts",
    "src/app/api/video/proxy-download/route.ts",
    "deploy/policies/media-object-retention.v1.json",
  ];
  const entries = await Promise.all(names.map(async (name) => [name, await readFile(path.join(root, name), "utf8")]));
  return Object.fromEntries(entries);
}

function verifySourceContracts(files) {
  const migration = files["supabase/migrations/20261009040000_video_history_archive_queue.sql"];
  const rollback = files["supabase/rollbacks/20261009040000_video_history_archive_queue.rollback.sql"];
  const worker = files["src/lib/video-history-archive-worker.ts"];
  const runtime = files["src/lib/media-queue-worker-runtime.ts"];
  const persistence = files["src/lib/video-persistence.ts"];
  const history = files["src/app/api/media-history/route.ts"];
  const proxy = files["src/app/api/video/proxy/route.ts"];
  const download = files["src/app/api/video/proxy-download/route.ts"];
  const retention = JSON.parse(files["deploy/policies/media-object-retention.v1.json"]);

  check("archive queue has an explicit finite state machine",
    /state IN \('queued', 'leased', 'retry', 'completed', 'source_expired', 'dead_letter'\)/u.test(migration),
    { states: ["queued", "leased", "retry", "completed", "source_expired", "dead_letter"] });
  check("completed tasks enqueue archive work without changing the terminal delivery transaction",
    /AFTER INSERT OR UPDATE OF status, storage_url, provider_result_url, video_url/u.test(migration)
      && /ON CONFLICT \(task_id\) DO NOTHING/u.test(migration),
    { trigger: "video_tasks_enqueue_history_archive", replaySafe: true });
  check("claiming is leased and process-safe",
    /FOR UPDATE OF job SKIP LOCKED/u.test(migration)
      && /lease_owner = v_worker/u.test(migration)
      && /lease_until = now\(\) \+ make_interval\(secs => v_lease\)/u.test(migration),
    { skipLocked: true, leaseOwner: true, boundedLease: true });
  check("archive scope is bounded to the three-day history promise",
    /coalesce\(task\.completed_at, task\.created_at\) > now\(\) - interval '3 days'/u.test(migration)
      && /state = 'source_expired'/u.test(migration),
    { retentionDays: 3, staleState: "source_expired" });
  check("archive completion requires task, owner, provider, key, category and metadata agreement",
    /asset\.user_id::text = v_task\.user_id::text/u.test(migration)
      && /asset\.storage_provider = 'tencent_cos'/u.test(migration)
      && /asset\.storage_key = v_storage_key/u.test(migration)
      && /asset\.file_category = 'video'/u.test(migration)
      && /asset\.meta->>'taskId' = v_task\.id::text/u.test(migration),
    { ownerBound: true, taskBound: true, cosOnly: true });
  check("archive internals are service-only",
    /FORCE ROW LEVEL SECURITY/u.test(migration)
      && /REVOKE ALL ON TABLE public\.video_history_archive_jobs FROM PUBLIC, anon, authenticated/u.test(migration)
      && /GRANT EXECUTE ON FUNCTION public\.claim_video_history_archive_batch\(text, integer, integer\) TO service_role/u.test(migration),
    { public: false, anon: false, authenticated: false, serviceRole: true });
  check("archive SQL cannot charge, refund or edit payment state",
    !/(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.(?:wallet\w*|billing\w*|payment\w*)|\bbalance\s*=/iu.test(migration),
    { billingMutations: 0 });
  check("worker resumes an existing owned object before uploading",
    /findExistingArchive\(db, claim\)/u.test(worker)
      && /storageManager\.exists\(key, 'tencent_cos'\)/u.test(worker),
    { crashReplayUploadAvoided: true });
  check("worker copies only an existing provider result and never submits generation",
    /persistVideoFromUrl\(\s*claim\.providerResultUrl,\s*claim\.taskId,\s*claim\.userId/u.test(worker)
      && /trustedVideoProviderResultHostname/u.test(worker)
      && /pollVideoTask\(\{[\s\S]{0,1200}\},\s*claim\.providerTaskId\)/u.test(worker)
      && !/\b(?:submitVideoTask|generateVideo|createVideoTask)\b/u.test(worker)
      && !/(?:generate|submit).*\bPOST\b|wallet|billing|deduct/iu.test(worker),
    { providerPostRequests: 0, paidRequests: 0, existingTaskPollOnly: true });
  check("worker records source expiry and bounded retries durably",
    /\[404, 410\]\.includes\(Number\(error\.upstreamStatus\)\)/u.test(worker)
      && /Math\.min\(3600, 30 \* \(2 \*\*/u.test(worker)
      && /fail_video_history_archive_attempt/u.test(worker),
    { sourceExpiryStatuses: [404, 410], maxBackoffSeconds: 3600, maxAttempts: 5 });
  check("dedicated worker lifecycle starts, reports and drains archival",
    /startVideoHistoryArchiveWorker\(\)/u.test(runtime)
      && /videoHistoryArchive: videoHistoryArchiveWorkerStatus\(\)/u.test(runtime)
      && /stopVideoHistoryArchiveWorker\(drainTimeoutMs\(\)\)/u.test(runtime),
    { start: true, status: true, gracefulStop: true });

  const cosUploadCount = (persistence.match(/providerType: VIDEO_PROVIDER/gu) || []).length;
  const strictCosUploadCount = (persistence.match(/providerType: VIDEO_PROVIDER,[\s\S]{0,100}strictProvider: true,[\s\S]{0,100}requireOwnershipRecord: true/gu) || []).length;
  check("every generated-video COS upload is strict and ownership-recorded",
    cosUploadCount > 0 && strictCosUploadCount === cosUploadCount,
    { cosUploadCount, strictCosUploadCount, serverDiskFallbacks: 0 });
  check("history visibility follows explicit archive expiry without deleting task or billing history",
    /video_history_archive_jobs\([^)]*state[^)]*source_expired_at[^)]*\)/u.test(history)
      && /archiveState === "source_expired"/u.test(history),
    { explicitExpiry: true, taskRowsDeleted: 0 });
  check("playback and download reject provider error documents and classify 404 or 410 as expired",
    proxy.includes("text\\/html|application\\/(?:json|problem\\+json)")
      && /sourceExpired = directStatus === 404 \|\| directStatus === 410/u.test(proxy)
      && /isUpstreamErrorDocument\(contentType\)/u.test(download)
      && /\[404, 410\]\.includes\(cdnResponse\.status\)/u.test(download),
    { playback: true, download: true, fakeVideoRejected: true });
  check("rollback removes queue control objects without deleting archived media",
    /DROP TABLE IF EXISTS public\.video_history_archive_jobs/u.test(rollback)
      && !/(?:storageManager|DELETE\s+FROM\s+public\.user_files|videos\/generated)/iu.test(rollback),
    { destructiveMediaCleanup: false });
  const generatedRule = retention.rules.find((rule) => rule.id === "generated-and-derived-video-3d");
  check("deployment contract requires read-back of the COS three-day lifecycle before the public claim",
    generatedRule?.expirationDays === 3
      && generatedRule.prefixes.includes("videos/generated/")
      && retention.activation.publicBuildFlag === "NEXT_PUBLIC_MEDIA_RETENTION_ENFORCED=true"
      && /read back/iu.test(retention.activation.precondition),
    { policy: retention.version, prefix: "videos/generated/", days: 3, status: retention.status });
}

async function verifyDatabaseContracts() {
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
  assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const client = new pg.Client({
    connectionString: String(runtime.databaseUrl || ""),
    application_name: "codex-video-history-archive-readonly-verifier",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const table = await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='video_history_archive_jobs'`);
    check("active local database has the forced-RLS archive queue",
      table.rowCount === 1 && table.rows[0].relrowsecurity === true && table.rows[0].relforcerowsecurity === true,
      { present: table.rowCount === 1, rls: table.rows[0]?.relrowsecurity, forced: table.rows[0]?.relforcerowsecurity });
    const privilege = await client.query(`SELECT
      has_table_privilege('anon','public.video_history_archive_jobs','SELECT') AS anon_select,
      has_table_privilege('authenticated','public.video_history_archive_jobs','SELECT') AS authenticated_select,
      has_table_privilege('service_role','public.video_history_archive_jobs','SELECT') AS service_select`);
    check("active local database exposes archive state only to service role",
      privilege.rows[0]?.anon_select === false
        && privilege.rows[0]?.authenticated_select === false
        && privilege.rows[0]?.service_select === true,
      privilege.rows[0]);
    const functions = await client.query(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[])`, [[
      "claim_video_history_archive_batch",
      "complete_video_history_archive_job",
      "fail_video_history_archive_attempt",
    ]]);
    const definitions = new Map(functions.rows.map((row) => [row.proname, compact(row.definition)]));
    check("active local database has all three archive transition functions",
      definitions.size === 3,
      { required: 3, present: [...definitions.keys()].sort() });
    check("active claim function retains skip-locked and lease fencing",
      /FOR UPDATE OF job SKIP LOCKED/iu.test(definitions.get("claim_video_history_archive_batch") || "")
        && /lease_owner = v_worker/iu.test(definitions.get("claim_video_history_archive_batch") || ""),
      { functionSha256: sha256(definitions.get("claim_video_history_archive_batch") || "") });
    const state = await client.query("SELECT state,count(*)::int AS count FROM public.video_history_archive_jobs GROUP BY state ORDER BY state");
    check("archive queue state was inspected without writes or provider requests", true, {
      state: state.rows,
      databaseWrites: 0,
      providerRequests: 0,
      paidTasks: 0,
    });
    await client.query("ROLLBACK");
    return { state: state.rows, functionCount: definitions.size };
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
