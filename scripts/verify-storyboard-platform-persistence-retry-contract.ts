import assert from "node:assert/strict";

import { sanitizeStoryboardPersistenceValue, createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { resolveStoryboardVideoSameKeyRetryAttempt } from "../src/lib/storyboard-video-retry";

const snapshot = createStoryboardPersistenceSnapshot({
  id: "platform-chain-run-01",
  title: "平台功能链路合同",
  createdAt: 1,
  updatedAt: 2,
  ratio: "16:9",
  imageResolution: "1K",
  videoResolution: "720p",
  videoDuration: 5,
  imageModelId: "image-model",
  videoModelId: "video-model",
  cards: [{
    id: "platform-chain-card-01",
    order: 1,
    imagePrompt: "image prompt",
    videoPrompt: "video prompt",
    referenceImageUrls: [],
    imageStatus: "done",
    imageReferenceState: "stale",
    videoStatus: "failed",
    videoClientRequestId: "sbw-video-original-request-01",
    videoClientRequestFingerprint: "original-payload-fingerprint",
    videoSameRequestKeyRequired: true,
    extraMustNotPersist: "unreviewed field",
  }],
});

const validated = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(snapshot)));
const readBack = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(
  sanitizeStoryboardPersistenceValue(validated),
)));
assert.equal(readBack.cards[0].imageReferenceState, "stale", "stale image-reference state must survive save/readback");
assert.equal(readBack.cards[0].videoSameRequestKeyRequired, true, "same-key protection must survive save/readback");
assert.equal(readBack.cards[0].videoClientRequestId, "sbw-video-original-request-01");
assert.equal(readBack.cards[0].videoClientRequestFingerprint, "original-payload-fingerprint");
assert.equal("extraMustNotPersist" in readBack.cards[0], false, "unreviewed card fields must remain excluded");

assert.throws(() => StoryboardProjectDocument.parse({
  ...validated,
  cards: [{ ...validated.cards[0], imageReferenceState: "current" }],
}), "image reference state must accept only the formal stale value");
assert.throws(() => StoryboardProjectDocument.parse({
  ...validated,
  cards: [{ ...validated.cards[0], videoSameRequestKeyRequired: "true" }],
}), "same-key protection must be a boolean");

const sameKeyRetry = resolveStoryboardVideoSameKeyRetryAttempt({
  currentFingerprint: "original-payload-fingerprint",
  previousRequestId: "sbw-video-original-request-01",
  previousFingerprint: "original-payload-fingerprint",
  sameRequestKeyRequired: true,
});
assert.deepEqual(sameKeyRetry, {
  clientRequestId: "sbw-video-original-request-01",
  clientRequestFingerprint: "original-payload-fingerprint",
  reused: true,
});
assert.equal(resolveStoryboardVideoSameKeyRetryAttempt({
  currentFingerprint: "new-payload-fingerprint",
  previousRequestId: "sbw-video-original-request-01",
  previousFingerprint: "original-payload-fingerprint",
  sameRequestKeyRequired: false,
}), null, "the helper must only protect retries explicitly marked same-key-required");
assert.throws(() => resolveStoryboardVideoSameKeyRetryAttempt({
  currentFingerprint: "changed-payload-fingerprint",
  previousRequestId: "sbw-video-original-request-01",
  previousFingerprint: "original-payload-fingerprint",
  sameRequestKeyRequired: true,
}), /VIDEO_RETRY_FINGERPRINT_MISMATCH_NOT_DISPATCHED/u);
assert.throws(() => resolveStoryboardVideoSameKeyRetryAttempt({
  currentFingerprint: "original-payload-fingerprint",
  previousFingerprint: "original-payload-fingerprint",
  sameRequestKeyRequired: true,
}), /VIDEO_RETRY_ORIGINAL_REQUEST_ID_REQUIRED_NOT_DISPATCHED/u);

console.log(JSON.stringify({
  passed: true,
  networkCalls: 0,
  providerCalls: 0,
  databaseCalls: 0,
  persistedFields: ["imageReferenceState", "videoSameRequestKeyRequired", "videoClientRequestId", "videoClientRequestFingerprint"],
  retryCases: ["same fingerprint preserves original id", "changed fingerprint throws before dispatch", "missing original id throws before dispatch"],
}, null, 2));
