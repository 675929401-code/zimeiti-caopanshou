import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  finalizer,
  proxy,
  proxyDownload,
  storageRoute,
  directDeliveryMigration,
  retentionMigration,
  persistence,
  workerRuntime,
  mediaHistory,
  videoHistory,
  policySource,
] = await Promise.all([
  readFile("src/lib/video-terminal-finalizer.ts", "utf8"),
  readFile("src/app/api/video/proxy/route.ts", "utf8"),
  readFile("src/app/api/video/proxy-download/route.ts", "utf8"),
  readFile("src/app/api/video/storage/[taskId]/route.ts", "utf8"),
  readFile("supabase/migrations/20260926133000_video_upstream_direct_delivery.sql", "utf8"),
  readFile("supabase/migrations/20261009043000_user_content_retention_and_video_direct_delivery.sql", "utf8"),
  readFile("src/lib/video-persistence.ts", "utf8"),
  readFile("src/lib/media-queue-worker-runtime.ts", "utf8"),
  readFile("src/app/api/media-history/route.ts", "utf8"),
  readFile("src/app/api/video/history/route.ts", "utf8"),
  readFile("deploy/policies/media-object-retention.v2.json", "utf8"),
]);

const policy = JSON.parse(policySource);

assert.doesNotMatch(finalizer, /persistStableVideoFromUrl/u, "ordinary terminal delivery must not synchronously copy provider video");
assert.match(finalizer, /stableStorageUrl = providerResultUrl/u, "provider result must become the ordinary delivery source");
assert.match(finalizer, /storage_url: usesPersistentCopy \? stableStorageUrl : null/u, "ordinary provider results must not claim platform storage");
assert.match(finalizer, /delivery_mode: usesPersistentCopy \? "persistent_object" : "provider_proxy"/u, "wallet metadata must record delivery mode without leaking a signed URL");
assert.doesNotMatch(finalizer, /Ordinary video history is retained for three days/u, "ordinary provider URLs must not promise a fixed retention window");
assert.doesNotMatch(finalizer, /视频已生成并永久保存/u, "ordinary provider URLs must not be described as permanently saved");
assert.match(finalizer, /视频已生成且当前播放源可用/u, "billing-pending copy must describe current source availability accurately");

assert.match(proxy, /provider_result_url/u, "authenticated playback must read provider result URLs");
assert.match(proxy, /providerResultUrl \|\| directVideoUrl/u, "provider result must be preferred over legacy direct URL");
assert.match(proxy, /trustedProviderResultHostname = trustedVideoProviderResultHostname\(videoUrl/u, "playback must narrowly trust a protocol-validated host");
assert.match(proxy, /directExpiryStatus = directStatus === 404 \|\| directStatus === 410/u, "playback must classify only definitive source expiry");
assert.match(proxy, /!hasProviderContentFallback \|\| fallbackExpiryStatus/u, "playback must try every supported path before expiring a source");
assert.match(proxy, /await upstreamResp\.body\?\.cancel\(\)/u, "non-media upstream responses must release their body");

assert.match(proxyDownload, /trustedProviderResultHostname = trustedVideoProviderResultHostname\(effectiveUrl/u, "download must narrowly trust a protocol-validated host");
assert.match(proxyDownload, /\[404, 410\]\.includes\(cdnResponse\.status\)/u, "download must distinguish definitive expiry");
assert.match(proxyDownload, /isUpstreamErrorDocument\(contentType\)/u, "download must reject HTML or JSON masquerading as video");
assert.match(storageRoute, /redirectToOriginProxy/u, "legacy local-storage URLs must fall back to the authenticated origin proxy");
assert.doesNotMatch(storageRoute, /createReadStream|uploads\/videos/u, "retired local files must not be served as a new persistence path");

assert.match(directDeliveryMigration, /v_delivery_url !~ '\^https\?:\/\/\[\^\[:space:\]\]\+\$'/u, "atomic finalizer must accept only HTTP(S) provider URLs");
assert.match(directDeliveryMigration, /needs_proxy = NOT v_persistent/u, "ordinary provider URLs must remain behind the authenticated proxy");
assert.match(directDeliveryMigration, /storage_url = CASE WHEN v_persistent THEN v_delivery_url ELSE NULL END/u, "ordinary delivery must not populate platform storage");
assert.match(directDeliveryMigration, /FOR UPDATE/u, "billing and delivery replay must remain row locked");
assert.match(directDeliveryMigration, /wallet_operations/u, "direct delivery must preserve wallet attestation");

assert.match(retentionMigration, /DROP TRIGGER IF EXISTS video_tasks_enqueue_history_archive/u, "global asynchronous archive copies must be retired");
assert.match(retentionMigration, /state = 'dead_letter'[\s\S]*ARCHIVE_POLICY_RETIRED_DIRECT_DELIVERY/u, "old queue work must be retired with an audit reason");
assert.match(retentionMigration, /mark_video_upstream_source_expired/u, "definitive expiry must be a service-only database transition");
assert.match(retentionMigration, /p_http_status NOT IN \(404, 410\)/u, "expiry RPC must reject transient status codes");
assert.match(retentionMigration, /provider_result_url = NULL,[\s\S]*video_url = NULL,[\s\S]*content_url = NULL/u, "confirmed expiry must clear delivery URLs without deleting task evidence");

assert.match(persistence, /storageScope: ManagedVideoStorageScope/u, "persistent copies must require an explicit managed scope");
assert.match(persistence, /`videos\/scoped\/\$\{scope\}\//u, "managed exceptions must use scoped prefixes");
assert.doesNotMatch(persistence, /videos\/generated\//u, "ordinary generated-video prefix must not remain in persistence code");
assert.doesNotMatch(workerRuntime, /VideoHistoryArchive|videoHistoryArchive/u, "dedicated runtime must not start an archive-copy worker");
assert.match(workerRuntime, /startUserContentRetentionWorker\(\)/u, "dedicated runtime must start bounded content cleanup");

for (const historySource of [mediaHistory, videoHistory]) {
  assert.doesNotMatch(historySource, /video_history_archive_jobs/u, "history must not depend on archive-copy state");
  assert.match(historySource, /source_expired_at/u, "history must filter definitively expired sources");
}
assert.equal(policy.version, "media-object-retention.v2");
assert.equal(policy.ordinaryVideoDelivery.copyToPlatformStorage, false);
assert.equal(policy.ordinaryVideoDelivery.fixedRetentionDays, null);
assert.deepEqual(policy.ordinaryVideoDelivery.expiryEvidence, [404, 410]);

console.log("video direct-delivery contract passed; ordinarySecondaryCopies=0; fixedOrdinaryRetentionDays=null; paidRequests=0");
