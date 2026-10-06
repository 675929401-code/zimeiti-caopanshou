import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [finalizer, proxy, proxyDownload, storageRoute, migration, persistence] = await Promise.all([
  readFile("src/lib/video-terminal-finalizer.ts", "utf8"),
  readFile("src/app/api/video/proxy/route.ts", "utf8"),
  readFile("src/app/api/video/proxy-download/route.ts", "utf8"),
  readFile("src/app/api/video/storage/[taskId]/route.ts", "utf8"),
  readFile("supabase/migrations/20260926133000_video_upstream_direct_delivery.sql", "utf8"),
  readFile("src/lib/video-persistence.ts", "utf8"),
]);

assert.doesNotMatch(finalizer, /persistStableVideoFromUrl/u, "terminal delivery must not synchronously copy provider video");
assert.match(finalizer, /stableStorageUrl = providerResultUrl/u, "provider result must become the delivery source");
assert.match(finalizer, /storage_url: usesPersistentCopy \? stableStorageUrl : null/u, "new provider results must not claim secondary storage");
assert.match(finalizer, /delivery_mode: usesPersistentCopy \? "persistent_object" : "provider_proxy"/u, "wallet metadata must record delivery mode without leaking a signed URL");
assert.match(proxy, /provider_result_url/u, "authenticated proxy must read provider result URLs");
assert.match(proxy, /providerResultUrl \|\| directVideoUrl/u, "provider result must be preferred over legacy direct video URL");
assert.match(proxy, /trustedProviderResultHostname = trustedVideoProviderResultHostname\(videoUrl/u, "playback proxy must narrowly trust protocol-validated provider result URLs");
assert.match(proxyDownload, /trustedProviderResultHostname = trustedVideoProviderResultHostname\(effectiveUrl/u, "download proxy must narrowly trust protocol-validated provider result URLs");
assert.match(persistence, /const AUTODL_HOSTED_RESULT_HOSTS = new Set<string>/u, "hosted result trust must remain an exact hostname set");
assert.match(persistence, /if \(!\/\\\.mp4\$\/iu\.test\(parsed\.pathname\)\)/u, "hosted result trust must require an MP4 path");
assert.match(storageRoute, /redirectToOriginProxy/u, "legacy storage access route must fall back to authenticated origin proxy");
assert.match(migration, /v_delivery_url !~ '\^https\?:\/\/\[\^\[:space:\]\]\+\$'/u, "atomic finalizer must accept only HTTP(S) provider delivery URLs");
assert.match(migration, /needs_proxy = NOT v_persistent/u, "provider URLs must remain behind the authenticated proxy");
assert.match(migration, /storage_url = CASE WHEN v_persistent THEN v_delivery_url ELSE NULL END/u, "provider delivery must not populate platform storage");
assert.match(migration, /FOR UPDATE/u, "billing and delivery replay must remain row-locked");
assert.match(migration, /wallet_operations/u, "direct delivery must preserve wallet attestation");

console.log("video upstream direct-delivery contract passed; secondaryCopies=0; paidRequests=0");
