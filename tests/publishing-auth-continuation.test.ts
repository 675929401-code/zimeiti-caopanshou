import assert from "node:assert/strict";
import { test } from "node:test";
import { sealPublishingAuthContinuation, openPublishingAuthContinuation } from "../src/lib/server/publishing-auth-continuation";
const scope = { ownerId: "owner-a", localSessionId: "session-a", providerSessionId: "provider-a" };
test("authorization continuation binds owner, both session IDs, key and expiration without exposing raw cookie", () => {
  const key = "synthetic-test-credential", cookie = "_cas=synthetic-continuation";
  const value = sealPublishingAuthContinuation({ ...scope, cookie, expiresAt: new Date(Date.now()+60000).toISOString() }, key);
  assert.ok(!value.includes("synthetic-continuation"));
  assert.equal(openPublishingAuthContinuation(value, scope, key), cookie);
  for (const changed of [{ ...scope, ownerId: "owner-b" }, { ...scope, localSessionId: "session-b" }, { ...scope, providerSessionId: "provider-b" }]) assert.throws(() => openPublishingAuthContinuation(value, changed, key), /AUTH_RESTART_REQUIRED/);
  assert.throws(() => openPublishingAuthContinuation(value, scope, "rotated-test-credential"), /AUTH_RESTART_REQUIRED/);
  assert.throws(() => openPublishingAuthContinuation(value, { ...scope, environment: "international" }, key), /AUTH_RESTART_REQUIRED/);
  assert.throws(() => openPublishingAuthContinuation(value.slice(0,-8), scope, key), /AUTH_RESTART_REQUIRED/);
  assert.throws(() => sealPublishingAuthContinuation({ ...scope, cookie, expiresAt: new Date(Date.now()-1).toISOString() }, key), /AUTH_RESTART_REQUIRED/);
});

test("an expired previously valid authorization continuation cannot be reopened", async () => {
  const value = sealPublishingAuthContinuation({ ...scope, cookie: "_cas=synthetic", expiresAt: new Date(Date.now()+30).toISOString() }, "synthetic-test-credential");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.throws(() => openPublishingAuthContinuation(value, scope, "synthetic-test-credential"), /AUTH_RESTART_REQUIRED/);
});
