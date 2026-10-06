import assert from "node:assert/strict";
import {
  isDeliverableExtractVideo,
  signedTemporaryExtractVideoExpiry,
  temporaryExtractVideoExpiresAt,
} from "../src/lib/extract-client-result";

const now = Date.now();
const futureExpiry = now + 20 * 60 * 1000;
const expiredAt = now - 1_000;
const signedShape = (expires: number) => `/api/extract/local-video?file=${"a".repeat(24)}&owner=fixture-user&expires=${expires}&sig=${"b".repeat(64)}`;

assert.equal(
  isDeliverableExtractVideo({ success: true, asset_id: "owned-video-asset" }),
  true,
  "an owned video asset must render as a successful extraction without exposing its supplier URL",
);
assert.equal(
  isDeliverableExtractVideo({ success: true, temporary_url: signedShape(futureExpiry), temporary_expires_at: futureExpiry }, now),
  true,
  "a signed 30-minute temporary video must render as successful immediate delivery",
);
assert.equal(temporaryExtractVideoExpiresAt({ temporary_url: signedShape(futureExpiry), temporary_expires_at: futureExpiry }), futureExpiry);
assert.equal(signedTemporaryExtractVideoExpiry(signedShape(futureExpiry)), futureExpiry);
assert.equal(isDeliverableExtractVideo({ success: true, temporary_url: signedShape(expiredAt), temporary_expires_at: expiredAt }, now), false);
assert.equal(isDeliverableExtractVideo({ success: true, temporary_url: "/api/extract/local-video?file=temporary" }, now), false);
assert.equal(isDeliverableExtractVideo({ success: true, temporary_url: `https://media.example${signedShape(futureExpiry)}`, temporary_expires_at: futureExpiry }, now), false);
assert.equal(isDeliverableExtractVideo({ success: true, temporary_url: signedShape(futureExpiry) }, now), false);
assert.equal(isDeliverableExtractVideo({ success: true, download_url: "https://media.example/video.mp4" }, now), false);
assert.equal(isDeliverableExtractVideo({ success: true, url: "https://media.example/video.mp4" }, now), false);
assert.equal(isDeliverableExtractVideo({ success: false, asset_id: "owned-video-asset" }), false);
assert.equal(isDeliverableExtractVideo({ success: true }), false);
assert.equal(isDeliverableExtractVideo(undefined), false);

console.log(JSON.stringify({
  contract: "extract-owned-or-temporary-asset-ui",
  passed: true,
  cases: 13,
}, null, 2));
