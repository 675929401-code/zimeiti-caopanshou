import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const generate = read("src/app/api/video/generate/route.ts");
const status = read("src/lib/video-task-status.ts");
const stream = read("src/app/api/video/stream/route.ts");
const finalizer = read("src/lib/video-terminal-finalizer.ts");
const migration = read("supabase/migrations/20260825180000_video_terminal_billing_p0.sql");
const directDeliveryMigration = read("supabase/migrations/20260926133000_video_upstream_direct_delivery.sql");
const rollback = read("supabase/rollbacks/20260825180000_video_terminal_billing_p0.rollback.sql");

const checks: Array<[string, boolean]> = [
  ["paid submit requires client request id", generate.includes("normalizeVideoClientRequestId")],
  ["request fingerprint is stable", generate.includes("buildVideoRequestFingerprint")],
  ["deterministic task identity exists", generate.includes("buildVideoTaskIdentity")],
  ["reservation happens before provider submit", generate.indexOf("const reservation = await reserveVideoGenerationTask") < generate.indexOf("result = await submitVideoTask")],
  ["same reservation can replay", generate.includes("reservation.created") && generate.includes("providerTaskId")],
  ["provider task binding is atomic", generate.includes("bindVideoProviderTask")],
  ["missing paid price fails closed", finalizer.includes("VIDEO_PRICE_CONFIGURATION_INVALID")],
  ["explicit free is explicit", finalizer.includes("protocol.explicitly_free === true") && finalizer.includes('toLowerCase() === "free"')],
  ["status uses shared finalizer", status.includes("finalizeVideoGenerationSuccess")],
  ["stream is a passive owner-scoped snapshot observer", stream.includes("readOwnedVideoTaskStatus") && !stream.includes("pollVideoTask") && !stream.includes("finalizeVideoGenerationSuccess")],
  ["routes contain no direct cash deduction", ![generate, status, stream].some((source) => /\bdeductCash\b/u.test(source))],
  ["routes contain no debt fallback", ![generate, status, stream].some((source) => /\b(recordDebt|checkAndCollectDebt)\b/u.test(source))],
  ["stream has no temporary playback fallback", !/downloadAndFaststart|persistVideoFromUrl|createVideoAccessUrl/u.test(stream)],
  ["provider result is recorded before wallet deduction", finalizer.indexOf("provider_result_url: providerResultUrl || null") < finalizer.indexOf("executeCashDeduction({")],
  ["provider result is not synchronously copied", !finalizer.includes("persistStableVideoFromUrl")],
  ["billing failure never completes", finalizer.includes("BILLING_DEDUCTION_FAILED") && finalizer.includes('state: "billing_pending"')],
  ["playback ticket follows atomic finalization", finalizer.indexOf('db.rpc("finalize_video_generation_task_atomic"') < finalizer.indexOf("const playbackUrl = await createVideoAccessUrl")],
  ["reservation unique key exists", migration.includes("video_tasks_user_client_request_once_idx")],
  ["same key different payload conflicts", migration.includes("VIDEO_REQUEST_IDEMPOTENCY_CONFLICT")],
  ["finalization locks task", migration.includes("FOR UPDATE")],
  ["finalization attests wallet operation", migration.includes("wallet_operations") && migration.includes("billing_idempotency_key")],
  ["direct delivery keeps provider URL and clears secondary storage", directDeliveryMigration.includes("provider_result_url = CASE") && directDeliveryMigration.includes("storage_url = CASE WHEN v_persistent THEN v_delivery_url ELSE NULL END")],
  ["RPCs are service-role only", migration.includes("REVOKE ALL") && migration.includes("GRANT EXECUTE")],
  ["rollback is separate and explicit", rollback.includes("DROP FUNCTION IF EXISTS") && !migration.includes("rollback.sql")],
];

for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(`${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`${checks.length}/${checks.length} checks passed`);
