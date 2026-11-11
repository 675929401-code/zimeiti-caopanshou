import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { isPublishingAuthorizationUrl, PublishingAuthorizationProvider, PublishingAuthorizationProviderStatusSchema } from "../src/lib/server/publishing-authorization-provider";
import { publishingProviderPayloadHash } from "../src/lib/server/publishing-provider";
import { openPublishingAuthContinuation, sealPublishingAuthContinuation } from "../src/lib/server/publishing-auth-continuation";
import type { PublishingAuthorizationPlatform } from "../src/lib/publishing-authorization-contract";

const state = "fixture-session";
const entrances: Array<[PublishingAuthorizationPlatform, string]> = [["linkedin", "https://www.linkedin.com/oauth/v2/authorization"], ["threads", "https://threads.net/oauth/authorize"], ["instagram", "https://www.instagram.com/oauth/authorize"], ["KWAI", "https://open.kuaishou.com/oauth2/authorize"], ["pinterest", "https://www.pinterest.com/oauth/"], ["wxGzh", "https://open.weixin.qq.com/connect/oauth2/authorize"], ["bilibili", "https://account.bilibili.com/pc/account-pc/auth/oauth"], ["facebook", "https://www.facebook.com/v25.0/dialog/oauth"], ["youtube", "https://accounts.google.com/o/oauth2/v2/auth"], ["tiktok", "https://www.tiktok.com/v2/auth/authorize"], ["twitter", "https://x.com/i/oauth2/authorize"]];
const authUrl = (platform: PublishingAuthorizationPlatform, base: string) => { const url = new URL(base); url.searchParams.set("state", state); if (platform === "wxGzh") url.hash = "wechat_redirect"; return url.toString(); };
const reply = (data: unknown, headers?: HeadersInit) => new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
test("exact official OAuth entrance and state allowlist excludes deceptive and credential URLs", () => {
  for (const [platform, base] of entrances) {
    const value = authUrl(platform, base); assert.ok(isPublishingAuthorizationUrl(value, platform, state), platform);
    assert.equal(isPublishingAuthorizationUrl(value, platform, "different"), false);
    const duplicate = new URL(value); duplicate.searchParams.append("state", state); assert.equal(isPublishingAuthorizationUrl(duplicate.toString(), platform, state), false);
    const deceptive = new URL(value); deceptive.hostname += ".example.com"; assert.equal(isPublishingAuthorizationUrl(deceptive.toString(), platform, state), false);
    const credential = new URL(value); credential.searchParams.set("access_token", "synthetic"); assert.equal(isPublishingAuthorizationUrl(credential.toString(), platform, state), false);
    const verifier = new URL(value); verifier.searchParams.set("code_verifier", "synthetic"); assert.equal(isPublishingAuthorizationUrl(verifier.toString(), platform, state), false);
  }
  const valid = new URL(authUrl("youtube", entrances[8][1])); valid.searchParams.set("redirect_uri", "https://aitoearn.ai/api/callback"); valid.searchParams.set("code_challenge", "public-pkce-challenge"); assert.ok(isPublishingAuthorizationUrl(valid.toString(), "youtube", state));
  const normalizedBypass = `${entrances[10][1].replace("/i/", "/i/../i/")}?state=${state}`;
  assert.equal(isPublishingAuthorizationUrl(normalizedBypass, "twitter", state), false);
});
test("start consumes one exact full-body grant and never retries unknown responses", async () => {
  let calls = 0, grants = 0; const operationId = randomUUID(), local = randomUUID();
  const provider = new PublishingAuthorizationProvider({ environment: "domestic", apiKey: "synthetic-fixture", ownerId: "owner", fetch: async (input, init) => { calls++; assert.equal(String(input), "https://aitoearn.cn/api/v2/channels/accounts/auth/twitter"); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); return reply({ sessionId: state, url: authUrl("twitter", entrances[10][1]), expiresAt: new Date(Date.now() + 240000).toISOString() }); }, consumeGrant: async grant => { grants++; assert.equal(grant.payloadHash, publishingProviderPayloadHash({ type: "twitter", correlationId: local, callbackUrl: null })); return true; } });
  await provider.start("twitter", local, operationId);
  await assert.rejects(() => provider.start("twitter", local, operationId), /AUTH_PROVIDER_GRANT_REJECTED/);
  assert.equal(calls, 1); assert.equal(grants, 1);
  const failing = new PublishingAuthorizationProvider({ environment: "domestic", apiKey: "synthetic-fixture", ownerId: "owner", fetch: async () => { calls++; throw new Error("synthetic lost response"); }, consumeGrant: async () => true });
  await assert.rejects(() => failing.start("twitter", local, randomUUID()), /AUTH_PROVIDER_OUTCOME_UNKNOWN/); assert.equal(calls, 2);
});
test("selection needs scoped continuation, discards remote HTML and performs no automatic status mutation", async () => {
  let calls = 0;
  const provider = new PublishingAuthorizationProvider({ environment: "international", apiKey: "synthetic-fixture", ownerId: "owner", sessionIds: new Set([state]), fetch: async (input, init) => { calls++; assert.equal(String(input), "https://aitoearn.ai/api/v2/channels/accounts/auth/selections"); assert.equal(new Headers(init?.headers).get("cookie"), "_cas=synthetic"); assert.deepEqual(JSON.parse(String(init?.body)), { accounts: [{ platformUid: "choice-one" }] }); return new Response("<html>untrusted ignored</html>"); }, consumeGrant: async () => true });
  await provider.select(state, [{ platformUid: "choice-one" }], randomUUID(), "_cas=synthetic");
  await assert.rejects(() => provider.select("foreign", [{ platformUid: "choice-one" }], randomUUID(), "_cas=synthetic"), /AUTH_PROVIDER_SCOPE_INVALID/);
  await assert.rejects(() => provider.select(state, [{ platformUid: "choice-one" }], randomUUID(), "invalid"), /AUTH_PROVIDER_SCOPE_INVALID/);
  assert.equal(calls, 1);
});
test("cross-platform, oversized status and unowned account reads are rejected", async () => {
  let calls = 0;
  const provider = new PublishingAuthorizationProvider({ environment: "domestic", apiKey: "synthetic-fixture", ownerId: "owner", sessionIds: new Set([state]), accountIds: new Set(), fetch: async () => { calls++; return reply({ sessionId: state, status: "completed", requiresSelection: false, accounts: [{ accountId: "upstream", platform: "facebook", platformUid: "one", displayName: "one" }] }); }, consumeGrant: async () => false });
  await assert.rejects(() => provider.status("twitter", state), /AUTH_PROVIDER_PROTOCOL_INVALID/);
  await assert.rejects(() => provider.readAccount("foreign"), /AUTH_PROVIDER_SCOPE_INVALID/); assert.equal(calls, 1);
  const oversized = new PublishingAuthorizationProvider({ environment: "domestic", apiKey: "synthetic-fixture", ownerId: "owner", sessionIds: new Set([state]), fetch: async () => reply({ sessionId: state, status: "pending", requiresSelection: true, selectableAccounts: Array.from({ length: 101 }, (_, i) => ({ platform: "twitter", platformUid: String(i), displayName: String(i) })) }), consumeGrant: async () => false });
  await assert.rejects(() => oversized.status("twitter", state), /AUTH_PROVIDER_PROTOCOL_INVALID/);
});
test("contradictory upstream account IDs cannot be silently replaced by the profile list", () => {
  const base = { sessionId: state, status: "completed", requiresSelection: false, accounts: [{ accountId: "actual", platform: "twitter", platformUid: "one", displayName: "one" }] };
  assert.equal(PublishingAuthorizationProviderStatusSchema.safeParse({ ...base, accountIds: ["other"] }).success, false);
  assert.equal(PublishingAuthorizationProviderStatusSchema.safeParse({ ...base, accountIds: ["actual"], accountId: "other" }).success, false);
  assert.equal(PublishingAuthorizationProviderStatusSchema.safeParse({ ...base, accountIds: ["actual", "actual"] }).success, false);
  assert.ok(PublishingAuthorizationProviderStatusSchema.safeParse({ ...base, accountIds: ["actual"], accountId: "actual" }).success);
});
test("continuation encryption rejects member, session, environment, key rotation and expiry mismatches", () => {
  const clock = Date.now(), scope = { ownerId: randomUUID(), localSessionId: randomUUID(), providerSessionId: state, environment: "domestic" as const };
  const key = "synthetic-continuation-fixture-key", value = sealPublishingAuthContinuation({ ...scope, expiresAt: new Date(clock + 1000).toISOString(), cookie: "_cas=synthetic" }, key);
  assert.equal(openPublishingAuthContinuation(value, scope, key), "_cas=synthetic");
  for (const different of [{ ...scope, ownerId: randomUUID() }, { ...scope, localSessionId: randomUUID() }, { ...scope, providerSessionId: "different" }, { ...scope, environment: "international" as const }]) assert.throws(() => openPublishingAuthContinuation(value, different, key), /AUTH_RESTART_REQUIRED/);
  assert.throws(() => openPublishingAuthContinuation(value, scope, `${key}-rotated`), /AUTH_RESTART_REQUIRED/);
  const originalNow = Date.now;
  try { Date.now = () => clock + 2000; assert.throws(() => openPublishingAuthContinuation(value, scope, key), /AUTH_RESTART_REQUIRED/); } finally { Date.now = originalNow; }
});
