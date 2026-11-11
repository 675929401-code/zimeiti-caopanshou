import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PublishingAuthorizationActionSchema, PublishingAuthorizationQuerySchema, PUBLISHING_OAUTH_PLATFORMS } from "../src/lib/publishing-authorization-contract";

test("OAuth contract preserves eleven platforms and separates existing transports", () => {
  assert.equal(PUBLISHING_OAUTH_PLATFORMS.length, 11);
  for (const platform of PUBLISHING_OAUTH_PLATFORMS) assert.ok(PublishingAuthorizationActionSchema.safeParse({ action: "start", platform, requestKey: `start:${platform}` }).success);
  for (const platform of ["douyin", "xhs", "wxSph", "arbitrary"]) assert.equal(PublishingAuthorizationActionSchema.safeParse({ action: "start", platform, requestKey: "start:test" }).success, false);
});
test("owner and upstream identity cannot be supplied through public actions", () => {
  const valid = { action: "select", sessionId: randomUUID(), expectedRevision: 1, choiceIds: [randomUUID()], requestKey: "select:one" };
  for (const field of ["ownerId", "providerSessionId", "platformUid", "cookie", "callbackUrl", "providerAccountId"]) assert.equal(PublishingAuthorizationActionSchema.safeParse({ ...valid, [field]: "synthetic" }).success, false);
  assert.equal(PublishingAuthorizationActionSchema.safeParse({ ...valid, choiceIds: [valid.choiceIds[0], valid.choiceIds[0]] }).success, false);
  assert.equal(PublishingAuthorizationActionSchema.safeParse({ ...valid, choiceIds: Array.from({ length: 101 }, () => randomUUID()) }).success, false);
});
test("group ownership requires an explicit matching revision contract", () => {
  const groupId = randomUUID(), bindingId = randomUUID();
  assert.equal(PublishingAuthorizationActionSchema.safeParse({ action: "start", platform: "youtube", requestKey: "group:one", groupId }).success, false);
  assert.ok(PublishingAuthorizationActionSchema.safeParse({ action: "start", platform: "youtube", requestKey: "group:one", groupId, expectedGroupRevision: 2 }).success);
  assert.equal(PublishingAuthorizationActionSchema.safeParse({ action: "move-binding", bindingId, expectedRevision: 1, groupId: null, expectedGroupRevision: 2, requestKey: "move:one" }).success, false);
  assert.ok(PublishingAuthorizationActionSchema.safeParse({ action: "move-binding", bindingId, expectedRevision: 1, groupId: null, requestKey: "move:one" }).success);
});
test("history queries are closed, paged and support exact key recovery", () => {
  assert.ok(PublishingAuthorizationQuerySchema.safeParse({ resource: "operations", requestKey: "lost:response" }).success);
  assert.equal(PublishingAuthorizationQuerySchema.safeParse({ resource: "operations", id: randomUUID(), requestKey: "lost:response" }).success, false);
  assert.equal(PublishingAuthorizationQuerySchema.safeParse({ resource: "bindings", pageSize: 101 }).success, false);
  assert.equal(PublishingAuthorizationQuerySchema.safeParse({ resource: "session", id: randomUUID(), providerSessionId: "foreign" }).success, false);
});
