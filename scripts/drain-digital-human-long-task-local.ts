import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseDotenv } from "dotenv";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ENV_PATH = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.env.local";
const APP_RUNTIME_DIR = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/preview-runtime";
const PARENT_PATTERN = /^dhl_[a-f0-9]{40}$/u;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
type Json = Record<string, unknown>;

function clean(value: unknown) { return String(value || "").replace(/https?:\/\/\S+/giu, "[url]").slice(0, 400); }
async function main() {
  const execute = process.argv.includes("--execute");
  const confirmed = process.argv.includes("--confirm-existing-parent-only");
  const parentId = process.argv.find((value) => value.startsWith("--parent-id="))?.slice("--parent-id=".length) || "";
  if (!execute) { console.log(JSON.stringify({ mode: "plan", parentId: parentId || null, createsBusinessRequests: 0, providerReplays: 0 })); return; }
  assert.equal(confirmed, true, "EXISTING_LONG_PARENT_CONFIRMATION_REQUIRED");
  assert.match(parentId, PARENT_PATTERN, "EXISTING_LONG_PARENT_ID_REQUIRED");
  const runtime = JSON.parse((await readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, "")) as Json;
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const owner = runtime.ownerConnection as Json;
  assert.equal(owner.host, "127.0.0.1", "LOCAL_OWNER_HOST_REQUIRED");
  assert.equal(Number(owner.port), 54322, "LOCAL_OWNER_PORT_REQUIRED");
  assert.equal(owner.database, "zimeiti_local", "LOCAL_OWNER_DATABASE_REQUIRED");
  const baseEnv = parseDotenv(await readFile(ENV_PATH, "utf8"));
  for (const [key, value] of Object.entries(baseEnv)) process.env[key] = value;
  process.env.COZE_SUPABASE_URL = String(runtime.supabaseUrl || runtime.restUrl || "");
  process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = String(runtime.serviceRoleKey || "");
  process.env.COZE_SUPABASE_ANON_KEY = String(runtime.anonKey || "");
  process.env.DATABASE_URL = String(runtime.databaseUrl || "");
  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.SAFE_FETCH_PUBLIC_DNS = "cloudflare-doh-v1";
  process.env.DIGITAL_HUMAN_LONG_WORKER = "1";
  process.env.APP_RUNTIME_DIR = APP_RUNTIME_DIR;

  const pgModule = await import("pg"); const pg = pgModule.default || pgModule;
  const client = new pg.Client({ connectionString: String(runtime.databaseUrl), connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await client.connect();
  const { executeDigitalHumanLongSegment, executeDigitalHumanLongFinalization } = await import("../src/lib/digital-human-long-worker");
  try {
    const deadline = Date.now() + 90 * 60_000;
    while (Date.now() < deadline) {
      const parent = (await client.query("SELECT * FROM public.digital_human_long_jobs WHERE id=$1", [parentId])).rows[0] as Json | undefined;
      assert.ok(parent, "TARGET_LONG_PARENT_NOT_FOUND");
      const segmentRows = (await client.query("SELECT id,ordinal,state,provider_task_id,provider_result_url,next_run_at,lease_owner,lease_until,attempt_count FROM public.digital_human_long_segments WHERE parent_id=$1 ORDER BY ordinal", [parentId])).rows as Json[];
      assert.ok(segmentRows.length >= 2, "TARGET_LONG_SEGMENTS_MISSING");
      const parentState = String(parent.state || "");
      console.log(JSON.stringify({ event: "long-target-state", parentId, state: parentState, segments: segmentRows.map((row) => ({ ordinal: row.ordinal, state: row.state, providerBound: Boolean(row.provider_task_id), attempt: row.attempt_count })), at: new Date().toISOString() }));
      if (TERMINAL.has(parentState)) return;
      if (segmentRows.some((row) => row.state === "submission_unknown")) throw new Error("TARGET_LONG_SUBMISSION_UNKNOWN_NO_REPLAY");

      const workerId = randomUUID(); let claimed: Json | null = null;
      await client.query("BEGIN");
      try {
        await client.query("UPDATE public.digital_human_long_segments SET state='queued',lease_owner=NULL,lease_until=NULL,next_run_at=now(),updated_at=now() WHERE parent_id=$1 AND state='preparing' AND lease_until<now()", [parentId]);
        await client.query("UPDATE public.digital_human_long_segments SET state=CASE WHEN provider_task_id IS NULL THEN 'submission_unknown' ELSE 'running' END,lease_owner=NULL,lease_until=NULL,next_run_at=now(),updated_at=now() WHERE parent_id=$1 AND state='dispatching' AND lease_until<now()", [parentId]);
        await client.query("UPDATE public.digital_human_long_segments SET lease_owner=NULL,lease_until=NULL,next_run_at=now(),updated_at=now() WHERE parent_id=$1 AND state IN ('running','finalizing') AND lease_until<now()", [parentId]);
        const candidate = (await client.query(
          "SELECT s.*,p.provider_key FROM public.digital_human_long_segments s JOIN public.digital_human_long_jobs p ON p.id=s.parent_id WHERE s.parent_id=$1 AND p.state IN ('queued','processing','confirming') AND s.state IN ('queued','running','finalizing') AND s.next_run_at<=now() AND (s.lease_until IS NULL OR s.lease_until<now()) AND NOT EXISTS (SELECT 1 FROM public.digital_human_long_segments prior WHERE prior.parent_id=s.parent_id AND prior.ordinal<s.ordinal AND prior.state<>'completed') ORDER BY CASE s.state WHEN 'running' THEN 0 WHEN 'finalizing' THEN 1 ELSE 2 END,s.ordinal LIMIT 1 FOR UPDATE OF s SKIP LOCKED",
          [parentId],
        )).rows[0] as Json | undefined;
        if (candidate) {
          const providerKey = String(candidate.provider_key || "");
          const advisory = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('digital-video-channel:'||$1,0)) AS locked", [providerKey]);
          assert.equal(advisory.rows[0]?.locked, true, "TARGET_LONG_PROVIDER_SLOT_BUSY");
          const ordinary = await client.query("SELECT count(*)::int AS count FROM public.digital_video_dispatch_jobs WHERE provider_key=$1 AND state IN ('dispatching','running','submission_unknown','finalizing')", [providerKey]);
          assert.equal(Number(ordinary.rows[0]?.count), 0, "TARGET_LONG_PROVIDER_HAS_ACTIVE_ORDINARY_TASK");
          if (candidate.state === "queued") {
            const other = await client.query("SELECT count(*)::int AS count FROM public.digital_human_long_segments s JOIN public.digital_human_long_jobs p ON p.id=s.parent_id WHERE p.provider_key=$1 AND s.id<>$2 AND s.state IN ('preparing','dispatching','running','submission_unknown','finalizing')", [providerKey, candidate.id]);
            assert.equal(Number(other.rows[0]?.count), 0, "TARGET_LONG_PROVIDER_HAS_OTHER_ACTIVE_SEGMENT");
          }
          const updated = await client.query("UPDATE public.digital_human_long_segments SET state=CASE WHEN state='queued' THEN 'preparing' ELSE state END,lease_owner=$2,lease_until=now()+interval '10 minutes',attempt_count=attempt_count+CASE WHEN state='queued' THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 RETURNING *", [candidate.id, workerId]);
          claimed = updated.rows[0] as Json;
          await client.query("UPDATE public.digital_human_long_jobs SET state='processing',updated_at=now() WHERE id=$1 AND state IN ('queued','processing','confirming')", [parentId]);
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      if (claimed) {
        try {
          await executeDigitalHumanLongSegment({ ...claimed, parent, lease_owner: workerId } as never);
        } catch (error) {
          const receipt = (await client.query("SELECT state,result_asset_id,result_storage_url,result_sha256 FROM public.digital_human_long_segments WHERE id=$1", [claimed.id])).rows[0] as Json | undefined;
          const completionCommitted = claimed.state === "finalizing" && receipt?.state === "completed" && receipt.result_asset_id
            && String(receipt.result_storage_url || "").startsWith("object://tencent_cos/") && /^[a-f0-9]{64}$/u.test(String(receipt.result_sha256 || ""));
          if (!completionCommitted) throw error;
          console.log(JSON.stringify({ event: "segment-completion-response-recovered", parentId, segmentId: claimed.id, providerReplays: 0, at: new Date().toISOString() }));
        }
        continue;
      }

      const finalizerId = randomUUID(); let finalizingParent: Json | null = null;
      await client.query("BEGIN");
      try {
        const locked = (await client.query("SELECT * FROM public.digital_human_long_jobs WHERE id=$1 FOR UPDATE", [parentId])).rows[0] as Json;
        const incomplete = Number((await client.query("SELECT count(*)::int AS count FROM public.digital_human_long_segments WHERE parent_id=$1 AND state<>'completed'", [parentId])).rows[0]?.count);
        const leaseUntil = locked.merge_lease_until ? Date.parse(String(locked.merge_lease_until)) : 0;
        if (["processing", "merging", "ready_to_settle"].includes(String(locked.state)) && Number(locked.next_run_at ? Date.parse(String(locked.next_run_at)) : 0) <= Date.now() && (!leaseUntil || leaseUntil < Date.now()) && (locked.state === "ready_to_settle" || incomplete === 0)) {
          const updated = await client.query("UPDATE public.digital_human_long_jobs SET state=CASE WHEN state='ready_to_settle' THEN state ELSE 'merging' END,merge_lease_owner=$2,merge_lease_until=now()+interval '15 minutes',updated_at=now() WHERE id=$1 RETURNING *", [parentId, finalizerId]);
          finalizingParent = updated.rows[0] as Json;
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      if (finalizingParent) {
        try { await executeDigitalHumanLongFinalization(finalizingParent as never, finalizerId); }
        catch (error) {
          const receipt = (await client.query("SELECT state,merged_asset_id,merged_storage_url,merged_sha256 FROM public.digital_human_long_jobs WHERE id=$1", [parentId])).rows[0] as Json | undefined;
          const mergeCommitted = ["ready_to_settle", "completed"].includes(String(receipt?.state || "")) && receipt?.merged_asset_id
            && String(receipt.merged_storage_url || "").startsWith("object://tencent_cos/") && /^[a-f0-9]{64}$/u.test(String(receipt.merged_sha256 || ""));
          if (!mergeCommitted) throw error;
          console.log(JSON.stringify({ event: "parent-finalization-response-recovered", parentId, state: receipt?.state, providerReplays: 0, at: new Date().toISOString() }));
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    throw new Error("TARGET_LONG_DRAIN_TIMEOUT");
  } finally { await client.end(); }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: clean(error instanceof Error ? error.message : error), createsBusinessRequests: 0, providerReplays: 0, credentialsPrinted: false }));
  process.exitCode = 1;
});
