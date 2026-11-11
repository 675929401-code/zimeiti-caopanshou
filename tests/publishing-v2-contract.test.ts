import test from "node:test";
import assert from "node:assert/strict";
import { PublishingV2ActionSchema, PublishingV2DraftInputSchema, PublishingV2MediaSchema, PublishingV2QuerySchema, PublishingV2TargetSchema } from "../src/lib/publishing-v2-contract";
const id = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const media = { id, role: "image", fileName: "image.png", size: 10, type: "image/png", lastModified: 1, source: "local_file", requiresReselection: true };
const target = { id, accountId: id, platform: "xhs", options: { declaration: 3 }, scheduledAt: null };
const draft = { schemaVersion: 2, collectionId: null, contentType: "image", title: "图文", body: "正文", topics: ["日常"], media: [media], targets: [target] };
test("V2 persists schema identity, ordered media and native target options", () => {
  const parsed = PublishingV2DraftInputSchema.parse({ ...draft, media: [media, { ...media, id: second, fileName: "second.png" }] });
  assert.equal(parsed.schemaVersion, 2); assert.deepEqual(parsed.media.map((item) => item.id), [id, second]);
  assert.deepEqual(parsed.targets[0].options, { declaration: 3 });
});
test("media IDs and platform account targets cannot repeat", () => {
  assert.equal(PublishingV2DraftInputSchema.safeParse({ ...draft, media: [media, media] }).success, false);
  assert.equal(PublishingV2DraftInputSchema.safeParse({ ...draft, targets: [target, { ...target, id: second }] }).success, false);
});
test("main-site references never accept arbitrary remote addresses or credentials", () => {
  const asset = { ...media, source: "main_asset", requiresReselection: false, reference: { kind: "image_asset", id } };
  assert.equal(PublishingV2MediaSchema.safeParse(asset).success, true);
  for (const extra of [{ url: "https://example.com/asset" }, { cookie: "synthetic-fixture" }, { storageKey: "arbitrary" }]) assert.equal(PublishingV2MediaSchema.safeParse({ ...asset, ...extra }).success, false);
  assert.equal(PublishingV2MediaSchema.safeParse({ ...asset, reference: { kind: "image_gallery", id: "message-id", index: 2 } }).success, true);
  assert.equal(PublishingV2MediaSchema.safeParse({ ...asset, reference: { kind: "image_gallery", id: "message-id", index: -1 } }).success, false);
});
test("browser-local files always declare reselection after refresh", () => {
  assert.equal(PublishingV2MediaSchema.safeParse({ ...media, requiresReselection: false }).success, false);
  assert.equal(PublishingV2MediaSchema.safeParse({ ...media, file: {} }).success, false);
});
test("native wx options preserve audited provider property names only", () => {
  const wx = { ...target, platform: "wxSph", options: { poiInfo: { poiId: "poi", poiName: "地点", poiAddress: "地址" }, event: { eventTopicId: "event", eventName: "活动" }, postFlag: 1 } };
  assert.equal(PublishingV2TargetSchema.safeParse(wx).success, true);
  assert.equal(PublishingV2TargetSchema.safeParse({ ...wx, options: { event: { id: "event", name: "wrong" } } }).success, false);
  assert.equal(PublishingV2TargetSchema.safeParse({ ...wx, options: { cookie: "synthetic-fixture" } }).success, false);
});
test("unsafe outbound option links are rejected before saving", () => {
  const address = new URL("https://example.com/path"); address.searchParams.set("access_token", "synthetic-fixture");
  assert.equal(PublishingV2TargetSchema.safeParse({ ...target, platform: "wxSph", options: { extLink: address.href } }).success, false);
});
test("incomplete drafts are savable but wrong media composition is rejected", () => {
  assert.equal(PublishingV2DraftInputSchema.safeParse({ ...draft, media: [], targets: [] }).success, true);
  assert.equal(PublishingV2DraftInputSchema.safeParse({ ...draft, media: [{ ...media, role: "video" }] }).success, false);
});
test("claim accepts only frozen batch target and entitlement references", () => {
  const claim = { action: "claim", batchId: id, targetId: id, entitlementId: id, idempotencyKey: "v2-claim-key" };
  assert.equal(PublishingV2ActionSchema.safeParse(claim).success, true);
  assert.equal(PublishingV2ActionSchema.safeParse({ ...claim, scheduleId: second }).success, true);
  for (const extra of [{ userId: id }, { cost: 0 }, { snapshot: draft }, { shouldExecute: true }]) assert.equal(PublishingV2ActionSchema.safeParse({ ...claim, ...extra }).success, false);
});
test("local schedule changes require explicit revision and remain separate from native schedule", () => {
  assert.equal(PublishingV2ActionSchema.safeParse({ action: "reschedule", id, expectedRevision: 1, scheduledAt: "2030-01-01T08:00:00+08:00" }).success, true);
  assert.equal(PublishingV2ActionSchema.safeParse({ action: "reschedule", id, scheduledAt: "2030-01-01T08:00:00+08:00" }).success, false);
});
test("pagination is bounded explicitly and unknown query fields cannot select another owner", () => {
  const query = PublishingV2QuerySchema.parse({ resource: "attempts", page: "2", pageSize: "10", requestKey: "v2-claim-key" });
  assert.equal(query.page, 2); assert.equal(query.pageSize, 10);
  assert.equal(PublishingV2QuerySchema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(PublishingV2QuerySchema.safeParse({ resource: "drafts", userId: id }).success, false);
  assert.equal(PublishingV2QuerySchema.safeParse({ resource: "versions", draftId: id, version: "150" }).success, true);
  assert.equal(PublishingV2QuerySchema.safeParse({ resource: "versions", version: "150" }).success, false);
  assert.equal(PublishingV2QuerySchema.safeParse({ resource: "events", attemptId: id, eventKind: "browser_report", pageSize: 1 }).success, true);
  assert.equal(PublishingV2QuerySchema.safeParse({ resource: "drafts", eventKind: "browser_report" }).success, false);
});
test("video pool preserves different ordered clips and covers for different targets", () => {
  const clipA = { ...media, id, role: "video", type: "video/mp4" }, clipB = { ...clipA, id: second };
  const coverA = { ...media, id: "00000000-0000-4000-8000-000000000003", role: "cover" }, coverB = { ...coverA, id: "00000000-0000-4000-8000-000000000004" };
  const parsed = PublishingV2DraftInputSchema.parse({ ...draft, contentType: "video", media: [clipA, clipB, coverA, coverB], targets: [{ ...target, mediaIds: [id], coverMediaId: coverA.id, topicsOverride: ["甲"] }, { ...target, id: second, accountId: second, mediaIds: [second], coverMediaId: coverB.id, topicsOverride: ["乙"] }] });
  assert.equal(parsed.media.length, 4); assert.deepEqual(parsed.targets.map((item) => item.mediaIds), [[id], [second]]);
  assert.equal(PublishingV2DraftInputSchema.safeParse({ ...parsed, targets: [{ ...parsed.targets[0], mediaIds: ["00000000-0000-4000-8000-000000000005"] }] }).success, false);
});
test("native receipt anchors are closed and manual links remain separate", () => {
  const receipt = { action: "report", attemptId: id, idempotencyKey: "v2-native-receipt", success: true, mediaMd5sum: "a".repeat(32), videoClipTaskId: "clip-native-1", scheduledTime: 1800000000000, publishTime: "2030-01-01T00:00:00Z", errorCode: "NETWORK_ERROR" };
  assert.equal(PublishingV2ActionSchema.safeParse(receipt).success, true);
  for (const extra of [{ errorCode: "arbitrary provider body" }, { scheduledTime: 0 }, { videoClipTaskId: "private/raw response" }, { raw: {} }]) assert.equal(PublishingV2ActionSchema.safeParse({ ...receipt, ...extra }).success, false);
});
