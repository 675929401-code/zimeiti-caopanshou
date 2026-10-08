import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  finalizer,
  proxy,
  proxyDownload,
  storageRoute,
  directDeliveryMigration,
  archiveMigration,
  persistence,
  archiveWorker,
  workerRuntime,
  mediaHistory,
] = await Promise.all([
  readFile("src/lib/video-terminal-finalizer.ts", "utf8"),
  readFile("src/app/api/video/proxy/route.ts", "utf8"),
  readFile("src/app/api/video/proxy-download/route.ts", "utf8"),
  readFile("src/app/api/video/storage/[taskId]/route.ts", "utf8"),
  readFile("supabase/migrations/20260926133000_video_upstream_direct_delivery.sql", "utf8"),
  readFile("supabase/migrations/20261009040000_video_history_archive_queue.sql", "utf8"),
  readFile("src/lib/video-persistence.ts", "utf8"),
  readFile("src/lib/video-history-archive-worker.ts", "utf8"),
  readFile("src/lib/media-queue-worker-runtime.ts", "utf8"),
  readFile("src/app/api/media-history/route.ts", "utf8"),
]);

assert.doesNotMatch(finalizer, /persistStableVideoFromUrl/u, "terminal delivery must not synchronously copy provider video");
assert.match(finalizer, /stableStorageUrl = providerResultUrl/u, "provider result must become the delivery source");
assert.match(finalizer, /storage_url: usesPersistentCopy \? stableStorageUrl : null/u, "new provider results must not claim secondary storage");
assert.match(finalizer, /delivery_mode: usesPersistentCopy \? "persistent_object" : "provider_proxy"/u, "wallet metadata must record delivery mode without leaking a signed URL");
assert.match(proxy, /provider_result_url/u, "authenticated proxy must read provider result URLs");
assert.match(proxy, /providerResultUrl \|\| directVideoUrl/u, "provider result must be preferred over legacy direct video URL");
assert.match(proxy, /trustedProviderResultHostname = trustedVideoProviderResultHostname\(videoUrl/u, "playback proxy must narrowly trust protocol-validated provider result URLs");
assert.match(proxyDownload, /trustedProviderResultHostname = trustedVideoProviderResultHostname\(effectiveUrl/u, "download proxy must narrowly trust protocol-validated provider result URLs");
assert.match(proxyDownload, /\[404, 410\]\.includes\(cdnResponse\.status\)/u, "download proxy must distinguish expired provider media");
assert.match(proxyDownload, /isUpstreamErrorDocument\(contentType\)/u, "download proxy must reject HTML or JSON masquerading as video");
assert.match(persistence, /const AUTODL_HOSTED_RESULT_HOSTS = new Set<string>/u, "hosted result trust must remain an exact hostname set");
assert.match(persistence, /if \(!\/\\\.mp4\$\/iu\.test\(parsed\.pathname\)\)/u, "hosted result trust must require an MP4 path");
assert.match(storageRoute, /redirectToOriginProxy/u, "legacy storage access route must fall back to authenticated origin proxy");
assert.match(directDeliveryMigration, /v_delivery_url !~ '\^https\?:\/\/\[\^\[:space:\]\]\+\$'/u, "atomic finalizer must accept only HTTP(S) provider delivery URLs");
assert.match(directDeliveryMigration, /needs_proxy = NOT v_persistent/u, "provider URLs must remain behind the authenticated proxy");
assert.match(directDeliveryMigration, /storage_url = CASE WHEN v_persistent THEN v_delivery_url ELSE NULL END/u, "provider delivery must not populate platform storage");
assert.match(directDeliveryMigration, /FOR UPDATE/u, "billing and delivery replay must remain row-locked");
assert.match(directDeliveryMigration, /wallet_operations/u, "direct delivery must preserve wallet attestation");

assert.match(archiveMigration, /CREATE TABLE IF NOT EXISTS public\.video_history_archive_jobs/u, "history archive work must be durable database state");
assert.match(archiveMigration, /FOR UPDATE OF job SKIP LOCKED/u, "archive claims must be safe across worker processes");
assert.match(archiveMigration, /coalesce\(task\.completed_at, task\.created_at\) > now\(\) - interval '3 days'/u, "archive claims must stay inside the advertised retention window");
assert.match(archiveMigration, /asset\.user_id::text = v_task\.user_id::text/u, "archive commit must prove asset ownership");
assert.match(archiveMigration, /asset\.meta->>'taskId' = v_task\.id::text/u, "archive commit must bind the object to its task");
assert.match(archiveMigration, /REVOKE ALL ON TABLE public\.video_history_archive_jobs FROM PUBLIC, anon, authenticated/u, "archive internals must not be client writable");
assert.doesNotMatch(
  archiveMigration,
  /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.(?:wallet\w*|billing\w*|payment\w*)|\bbalance\s*=/iu,
  "history archival must not mutate charging state",
);

assert.match(archiveWorker, /claim_video_history_archive_batch/u, "worker must atomically claim archive work");
assert.match(archiveWorker, /persistVideoFromUrl\(\s*claim\.providerResultUrl/u, "worker must copy the already-generated result without resubmission");
assert.match(archiveWorker, /refreshedHostedResultUrl/u, "worker must refresh an expired hosted result without resubmitting generation");
assert.match(archiveWorker, /pollVideoTask/u, "worker may only poll the existing hosted task when refreshing its result URL");
assert.match(archiveWorker, /complete_video_history_archive_job/u, "worker must commit archive ownership through the database contract");
assert.match(archiveWorker, /fail_video_history_archive_attempt/u, "worker must durably classify retry and source expiry");
assert.doesNotMatch(archiveWorker, /fetch\([^)]*(?:generate|submit)|wallet|billing|deduct/iu, "archive worker must not generate again or charge again");
assert.match(workerRuntime, /startVideoHistoryArchiveWorker\(\)/u, "dedicated media worker must start the archive loop");
assert.match(workerRuntime, /stopVideoHistoryArchiveWorker\(drainTimeoutMs\(\)\)/u, "dedicated media worker must drain the archive loop on shutdown");
assert.match(workerRuntime, /videoHistoryArchive: videoHistoryArchiveWorkerStatus\(\)/u, "archive loop status must be observable");
assert.match(mediaHistory, /video_history_archive_jobs\(state,attempt_count,last_error_code,source_expired_at\)/u, "history API must read explicit archive delivery state");
assert.match(mediaHistory, /archiveDeliveryPending/u, "history API must not advertise a failed archive attempt as playable completion");
assert.match(mediaHistory, /archiveDeliveryFailed/u, "history API must present dead-letter archive work as failed instead of broken playback");

console.log("video delivery contract passed; immediateSecondaryCopies=0; asyncHistoryArchive=1; paidRequests=0");
