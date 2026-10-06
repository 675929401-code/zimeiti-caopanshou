import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseDotenv } from "dotenv";

const DEFAULT_RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ENV_PATH = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.env.local";
const TASK_PATTERN = /^vt_[a-f0-9]{40}$/u;

type RecordValue = Record<string, unknown>;

function clean(value: unknown) {
  return String(value || "").replace(/https?:\/\/\S+/giu, "[url]").slice(0, 300);
}

async function main() {
  const execute = process.argv.includes("--execute");
  const confirmed = process.argv.includes("--confirm-existing-task-only");
  const finalizeDiagnosticOnce = process.argv.includes("--finalize-diagnostic-once");
  const taskId = process.argv.find((value) => value.startsWith("--task-id="))?.slice("--task-id=".length) || "";
  if (!execute) {
    console.log(JSON.stringify({ mode: "plan", taskId: taskId || null, providerCalls: 0, databaseWrites: 0 }));
    return;
  }
  assert.equal(confirmed, true, "EXISTING_TASK_CONFIRMATION_REQUIRED");
  assert.match(taskId, TASK_PATTERN, "EXISTING_TASK_ID_REQUIRED");
  const runtimePath = process.argv.find((value) => value.startsWith("--runtime="))?.slice("--runtime=".length) || DEFAULT_RUNTIME_PATH;
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as RecordValue;
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const owner = runtime.ownerConnection as RecordValue;
  assert.equal(owner?.host, "127.0.0.1", "LOCAL_OWNER_HOST_REQUIRED");
  assert.equal(Number(owner?.port), 54322, "LOCAL_OWNER_PORT_REQUIRED");
  assert.equal(owner?.database, "zimeiti_local", "LOCAL_OWNER_DATABASE_REQUIRED");

  const baseEnv = parseDotenv(await readFile(ENV_PATH, "utf8"));
  for (const [key, value] of Object.entries(baseEnv)) process.env[key] = value;
  process.env.COZE_SUPABASE_URL = String(runtime.supabaseUrl || runtime.restUrl || "");
  process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = String(runtime.serviceRoleKey || "");
  process.env.COZE_SUPABASE_ANON_KEY = String(runtime.anonKey || "");
  process.env.DATABASE_URL = String(runtime.databaseUrl || "");
  process.env.DIGITAL_VIDEO_QUEUE_WORKER = "1";
  // Match the local 5000 launcher's SSRF-safe public DNS policy. Windows proxy
  // DNS can resolve provider OSS hosts into reserved test ranges, which makes
  // safeFetch correctly reject them unless development public DNS is enabled.
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.SAFE_FETCH_PUBLIC_DNS = "cloudflare-doh-v1";

  const pgModule = await import("pg");
  const pg = pgModule.default || pgModule;
  const client = new pg.Client({ connectionString: String(runtime.databaseUrl), connectionTimeoutMillis: 10_000, query_timeout: 20_000 });
  await client.connect();
  if (finalizeDiagnosticOnce) {
    try {
      const row = (await client.query(
        "SELECT t.id,t.user_id,t.task_id_external,t.provider_result_url,t.billing_exempt,t.status,q.state FROM public.video_tasks t JOIN public.digital_video_dispatch_jobs q ON q.task_id=t.id WHERE t.id=$1",
        [taskId],
      )).rows[0] as RecordValue | undefined;
      assert.ok(row, "TARGET_DISPATCH_JOB_NOT_FOUND");
      assert.equal(row.state, "finalizing", "TARGET_NOT_FINALIZING");
      assert.equal(row.billing_exempt, true, "TARGET_NOT_ADMIN_EXEMPT");
      assert.ok(row.task_id_external && row.provider_result_url, "TARGET_PROVIDER_RESULT_NOT_RETAINED");
      const { finalizeVideoGenerationSuccess } = await import("../src/lib/video-terminal-finalizer");
      const result = await finalizeVideoGenerationSuccess({
        taskIdInternal: String(row.id),
        userId: String(row.user_id),
        userRole: "admin",
        providerTaskId: String(row.task_id_external),
        providerVideoUrl: String(row.provider_result_url),
      });
      console.log(JSON.stringify({ event: "finalize-diagnostic", taskId, state: result.state, code: result.code || null, message: clean(result.message), providerPostRequests: 0 }));
      return;
    } finally {
      await client.end();
    }
  }
  const { executeDigitalVideoDispatch } = await import("../src/lib/digital-video-queue-worker");
  try {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const snapshot = (await client.query(
        "SELECT q.*,t.task_id_external,t.status AS task_status FROM public.digital_video_dispatch_jobs q JOIN public.video_tasks t ON t.id=q.task_id WHERE q.task_id=$1",
        [taskId],
      )).rows[0] as RecordValue | undefined;
      assert.ok(snapshot, "TARGET_DISPATCH_JOB_NOT_FOUND");
      const state = String(snapshot.state || "");
      console.log(JSON.stringify({ event: "target-state", taskId, state, taskStatus: snapshot.task_status, at: new Date().toISOString() }));
      if (["completed", "failed", "cancelled"].includes(state)) return;
      if (state === "submission_unknown") throw new Error("TARGET_SUBMISSION_UNKNOWN_NO_REPLAY");
      const nextRunAt = Date.parse(String(snapshot.next_run_at || ""));
      if (Number.isFinite(nextRunAt) && nextRunAt > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(nextRunAt - Date.now() + 100, 5_000)));
        continue;
      }
      const worker = randomUUID();
      await client.query("BEGIN");
      let claimed: RecordValue | null = null;
      try {
        const locked = (await client.query(
          "SELECT q.* FROM public.digital_video_dispatch_jobs q WHERE q.task_id=$1 FOR UPDATE",
          [taskId],
        )).rows[0] as RecordValue | undefined;
        assert.ok(locked, "TARGET_DISPATCH_JOB_NOT_FOUND");
        const lockedState = String(locked.state || "");
        if (["completed", "failed", "cancelled"].includes(lockedState)) {
          await client.query("COMMIT");
          return;
        }
        if (lockedState === "submission_unknown") throw new Error("TARGET_SUBMISSION_UNKNOWN_NO_REPLAY");
        assert.ok(["queued", "running", "finalizing"].includes(lockedState), `TARGET_STATE_NOT_CLAIMABLE:${lockedState}`);
        const leaseUntil = locked.lease_until ? Date.parse(String(locked.lease_until)) : 0;
        assert.ok(!leaseUntil || leaseUntil < Date.now(), "TARGET_LEASE_STILL_ACTIVE");
        if (lockedState === "queued") {
          const providerKey = String(locked.provider_key || "");
          const advisory = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('digital-video-channel:'||$1,0)) AS locked", [providerKey]);
          assert.equal(advisory.rows[0]?.locked, true, "TARGET_PROVIDER_SLOT_BUSY");
          const ordinary = await client.query("SELECT count(*)::int AS count FROM public.digital_video_dispatch_jobs WHERE provider_key=$1 AND state IN ('dispatching','running','submission_unknown')", [providerKey]);
          assert.equal(Number(ordinary.rows[0]?.count), 0, "TARGET_PROVIDER_HAS_ACTIVE_ORDINARY_TASK");
          const long = await client.query("SELECT count(*)::int AS count FROM public.digital_human_long_segments s JOIN public.digital_human_long_jobs p ON p.id=s.parent_id WHERE p.provider_key=$1 AND s.state IN ('preparing','dispatching','running','submission_unknown','finalizing')", [providerKey]);
          assert.equal(Number(long.rows[0]?.count), 0, "TARGET_PROVIDER_HAS_ACTIVE_LONG_TASK");
        }
        const updated = await client.query(
          "UPDATE public.digital_video_dispatch_jobs SET state=CASE WHEN state='queued' THEN 'dispatching' ELSE state END,lease_owner=$2,lease_until=now()+interval '5 minutes',updated_at=now() WHERE task_id=$1 RETURNING *",
          [taskId, worker],
        );
        claimed = updated.rows[0] as RecordValue;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      assert.ok(claimed, "TARGET_CLAIM_FAILED");
      await executeDigitalVideoDispatch({
        task_id: String(claimed.task_id),
        user_id: String(claimed.user_id),
        provider_key: String(claimed.provider_key),
        model_hash: String(claimed.model_hash),
        inputs: claimed.inputs as never,
        state: String(claimed.state),
        lease_owner: String(claimed.lease_owner),
        provider_result_url: claimed.provider_result_url ? String(claimed.provider_result_url) : undefined,
        error_code: claimed.error_code ? String(claimed.error_code) : undefined,
        error_message: claimed.error_message ? String(claimed.error_message) : undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("TARGET_DRAIN_TIMEOUT");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: clean(error instanceof Error ? error.message : error), taskReplayed: false, credentialsPrinted: false }));
  process.exitCode = 1;
});
