import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PublishingProvider, publishingProviderPayloadHash, projectProviderStatus, validatePublishingProviderOptions, type PublishingProviderGrant, type PublishingProviderScope } from "../src/lib/server/publishing-provider";
const scope = (): PublishingProviderScope => ({ ownerId: "owner", accountIds: new Set(["account-1"]), flowIds: new Set(["flow-1"]), recordIds: new Set(["record-1"]), taskIds: new Set(["task-1"]), authSessionIds: new Set(["session-1"]) });
const reply = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { "Content-Type": "application/json" } });
const capability = { platform: "douyin", displayName: { "zh-CN": "抖音", "en-US": "Douyin" }, authType: "oauth", status: "available", contentLimits: { maxTitleLength: 30 }, mediaRules: { maxImages: 12 }, topic: { maxTopics: 5 }, optionSchema: { type: "object", properties: { privacy: { type: "string", enum: ["public", "private"] } }, additionalProperties: false }, defaultOption: { privacy: "public" }, capabilities: { publish: { supported: true } } };
const flowInput = () => ({ publishAt: "2026-12-01T12:00:00Z", content: { title: "测试", media: [{ url: "https://assets.example.com/owned.jpg", options: { adaptation: { imageFormat: "jpeg" as const } } }] }, items: [{ platform: "douyin", accountId: "account-1", option: { privacy: "public" } }] });

test("provider request fingerprints use locale-independent key ordering", () => {
  const expected = createHash("sha256").update('{"B":2,"_":3,"a":1}').digest("hex");
  assert.equal(publishingProviderPayloadHash({ a: 1, B: 2, _: 3 }), expected);
  assert.equal(publishingProviderPayloadHash({ _: 3, a: 1, B: 2 }), expected);
});
test("missing configuration, unowned IDs and ungranted mutations never make an HTTP call", async () => {
  let calls = 0;
  const client = new PublishingProvider({ environment: "domestic", scope: scope(), fetch: async () => { calls++; return reply([]); } });
  await assert.rejects(client.readCapabilities(), { code: "PROVIDER_NOT_CONFIGURED" });
  await assert.rejects(client.readAccount("another-account"), { code: "PROVIDER_SCOPE_DENIED" });
  const configured = new PublishingProvider({ environment: "domestic", scope: scope(), apiKey: "fixture", fetch: async () => { calls++; return reply([]); } });
  await assert.rejects(configured.changeTask("task-1", "cancel", "operation-1"), { code: "PROVIDER_ACTION_NOT_GRANTED" });
  assert.equal(calls, 0);
});
test("account list filters supplier tenant accounts and totals, dropping private fields", async () => {
  const client = new PublishingProvider({ environment: "domestic", scope: scope(), apiKey: "fixture", fetch: async (url, init) => {
    assert.match(String(url), /^https:\/\/aitoearn.cn\/api\/v2\/channels\/accounts\?/);
    assert.match(String(url), /ids%5B%5D=account-1/);
    assert.equal(new Headers(init?.headers).get("X-Api-Key"), "fixture");
    return reply({ total: 99, list: [{ id: "account-1", type: "douyin", uid: "u", nickname: "作者", loginCookie: "discard" }, { id: "foreign", type: "xhs", nickname: "别人的账号" }] });
  } });
  assert.deepEqual(await client.listAccounts(), { total: 1, list: [{ id: "account-1", type: "douyin", uid: "u", nickname: "作者" }] });
});
test("flow dispatch freezes full body grant, exact target correlation and never repeats unknown POST", async () => {
  let posts = 0; const grants: PublishingProviderGrant[] = [];
  const client = new PublishingProvider({ environment: "international", scope: scope(), apiKey: "fixture", consumeGrant: async grant => { grants.push(grant); return true; }, fetch: async (url, init) => {
    assert.ok(String(url).startsWith("https://aitoearn.ai/"));
    if (String(url).endsWith("/platforms")) return reply([capability]);
    posts++; assert.equal(init?.method, "POST"); assert.deepEqual(JSON.parse(String(init?.body)), flowInput());
    throw new Error("untrusted remote text");
  } });
  await assert.rejects(client.createPublishFlow(flowInput(), "op-1"), { code: "PROVIDER_OUTCOME_UNKNOWN" });
  await assert.rejects(client.createPublishFlow(flowInput(), "op-1"), { code: "PROVIDER_ACTION_NOT_GRANTED" });
  assert.equal(posts, 1); assert.equal(grants.length, 1); assert.equal(grants[0].ownerId, "owner"); assert.match(grants[0].payloadHash, /^[a-f0-9]{64}$/);
});
test("provider accepted or waiting for user action stays separate from published; mismatched record is rejected", async () => {
  const client = new PublishingProvider({ environment: "domestic", scope: scope(), apiKey: "fixture", fetch: async url => String(url).endsWith("/user-action")
    ? reply({ recordId: "record-1", platform: "douyin", shareId: "share", schemeUrl: "snssdk1128://share", shortLink: "https://v.douyin.com/abc" })
    : reply({ id: "record-1", accountId: "account-1", accountType: "douyin", status: 8, publishTime: "2026-11-10T12:00:00Z", rawPrivateData: "discard" }) });
  assert.equal((await client.readUserAction("record-1")).recordId, "record-1");
  assert.equal(projectProviderStatus(8), "awaiting_user_action"); assert.equal(projectProviderStatus(7), "platform_scheduled"); assert.equal(projectProviderStatus(1), "published"); assert.equal(projectProviderStatus(5), "update_failed"); assert.equal(projectProviderStatus(999), "unknown");
  const wrong = new PublishingProvider({ environment: "domestic", scope: scope(), apiKey: "fixture", fetch: async () => reply({ id: "record-1", accountId: "foreign", status: 1 }) });
  await assert.rejects(wrong.readPublishRecord("record-1"), { code: "PROVIDER_SCOPE_DENIED" });
});
test("authorization uses fixed callback allowlist and rejects cross-session responses", async () => {
  let calls = 0;
  const client = new PublishingProvider({ environment: "domestic", scope: scope(), apiKey: "fixture", consumeGrant: async () => true, allowedAuthCallbackOrigins: new Set(["https://our.example.com"]), fetch: async url => {
    calls++;
    return String(url).includes("/status/") ? reply({ sessionId: "foreign-session", status: "completed", requiresSelection: false }) : reply({ url: "https://open.douyin.com/oauth", sessionId: "session-1", expiresAt: "2026-11-10T12:00:00Z", authInstructions: { "zh-CN": "授权", "en-US": "Authorize" } });
  } });
  await assert.rejects(client.startAuthorization("douyin", "correlation", "op-1", "https://evil.example.com/callback"), { code: "PROVIDER_INPUT_INVALID" }); assert.equal(calls, 0);
  assert.equal((await client.startAuthorization("douyin", "correlation", "op-2", "https://our.example.com/callback")).sessionId, "session-1");
  await assert.rejects(client.readAuthorizationStatus("douyin", "session-1"), { code: "PROVIDER_PROTOCOL_ERROR" });
});
test("malformed or oversized mutation responses remain unknown without exposing upstream error details", async () => {
  for (const response of [new Response("bad json"), new Response("{}", { headers: { "Content-Length": "3000000" } }), reply({ taskId: "wrong-task" })]) {
    const client = new PublishingProvider({ environment: "domestic", scope: scope(), apiKey: "fixture", consumeGrant: async () => true, fetch: async () => response });
    await assert.rejects(client.changeTask("task-1", "cancel", "op"), error => (error as { code: string }).code === "PROVIDER_OUTCOME_UNKNOWN" && !String(error).includes("bad json"));
  }
});
test("bounded option validation handles dictionary schemas, forbidden items and native enums", () => {
  assert.equal(validatePublishingProviderOptions({ type: "object", additionalProperties: { type: "integer", minimum: 1 } }, { count: 2 }), true);
  assert.equal(validatePublishingProviderOptions({ type: "object", additionalProperties: { type: "integer" } }, { count: "2" }), false);
  assert.equal(validatePublishingProviderOptions({ type: "array", items: false }, [1]), false);
  assert.equal(validatePublishingProviderOptions({ type: "object", properties: { secret: {} } }, { secret: "value" }), false);
  assert.equal(validatePublishingProviderOptions(capability.optionSchema, { privacy: "public" }), true);
  assert.equal(validatePublishingProviderOptions(capability.optionSchema, { privacy: "other" }), false);
  assert.equal(validatePublishingProviderOptions({ type: "string", pattern: "remote-pattern" }, "value"), false);
});

test("asset upload grants bind exact filename and size, reject unowned confirmation and never persist PUT credentials", async () => {
  const grants: PublishingProviderGrant[] = []; const calls: string[] = [];
  const client = new PublishingProvider({ environment: "domestic", apiKey: "fixture", scope: { ...scope(), assetIds: new Set(["asset-1"]) }, consumeGrant: async grant => { grants.push(grant); return true; }, fetch: async (url, init) => {
    calls.push(String(url)); assert.equal(new Headers(init?.headers).get("X-Api-Key"), "fixture");
    if (String(url).endsWith("/uploadSign")) { assert.deepEqual(JSON.parse(String(init?.body)), { filename: "clip.mp4", size: 1024, type: "publishMedia" }); return reply({ id: "asset-1", url: "https://assets.aitoearn.cn/owned.mp4", uploadUrl: "https://bucket.oss-cn-beijing.aliyuncs.com/owned.mp4?Signature=synthetic", raw: "discard" }); }
    return reply({ id: "asset-1", url: "https://assets.aitoearn.cn/owned.mp4", status: "confirmed", size: 1024, mimeType: "video/mp4", metadata: { width: 1080, height: 1920, duration: 4 }, userId: "discard" });
  } });
  await assert.rejects(client.confirmAssetUpload("foreign", "confirm-foreign"), { code: "PROVIDER_SCOPE_DENIED" });
  assert.equal(calls.length, 0);
  const signed = await client.startAssetUpload({ filename: "clip.mp4", size: 1024 }, "sign-1"); assert.match(signed.uploadUrl, /Signature=/);
  const confirmed = await client.confirmAssetUpload("asset-1", "confirm-1"); assert.equal(confirmed.status, "confirmed"); assert.ok(!("userId" in confirmed));
  assert.deepEqual(grants.map(g => g.kind), ["asset_sign", "asset_confirm"]);
  assert.equal(grants[0].payloadHash, publishingProviderPayloadHash({ type: "publishMedia", size: 1024, filename: "clip.mp4" }));
  assert.ok(calls.every(url => url.startsWith("https://aitoearn.cn/api/assets/")));
});

test("authorization selection sends only the source _cas continuation and discards vendor HTML", async () => {
  const client = new PublishingProvider({ environment: "domestic", apiKey: "fixture", scope: scope(), consumeGrant: async () => true, fetch: async (url, init) => {
    if (String(url).endsWith("/selections")) { assert.equal(new Headers(init?.headers).get("Cookie"), "_cas=synthetic"); return new Response("<html>untrusted provider callback</html>"); }
    const response = reply({ url: "https://open.douyin.com/auth", sessionId: "session-1", expiresAt: new Date(Date.now()+60000).toISOString() });
    response.headers.append("Set-Cookie", "unrelated=discard; HttpOnly"); response.headers.append("Set-Cookie", "_cas=synthetic; HttpOnly"); return response;
  } });
  await client.startAuthorization("douyin", "correlation", "auth-op");
  assert.equal(client.takeAuthorizationCookie("session-1"), "_cas=synthetic");
  assert.equal(client.takeAuthorizationCookie("session-1"), undefined);
  client.restoreAuthorizationCookie("session-1", "_cas=synthetic");
  await client.selectAuthorizationAccounts("session-1", [{ platformUid: "uid-1" }], "selection-op");
});

test("a different Flow ID after dispatch is unknown and never accepted as this submission", async () => {
  const client = new PublishingProvider({ environment: "domestic", apiKey: "fixture", scope: scope(), consumeGrant: async () => true, fetch: async url => String(url).endsWith("/platforms") ? reply([capability]) : reply({ flowId: "foreign-flow", tasks: [{ id: "record-1", accountId: "account-1", platform: "douyin" }] }) });
  await assert.rejects(client.createPublishFlow({ ...flowInput(), flowId: "flow-1" }, "flow-operation"), { code: "PROVIDER_OUTCOME_UNKNOWN" });
});

test("untrusted upload hosts and nonconfirmed or mismatched asset responses remain unknown", async () => {
  const make = (data: unknown) => new PublishingProvider({ environment: "domestic", apiKey: "fixture", scope: { ...scope(), assetIds: new Set(["asset-1"]) }, consumeGrant: async () => true, fetch: async () => reply(data) });
  await assert.rejects(make({ id: "asset-1", url: "https://assets.aitoearn.cn/owned.mp4", uploadUrl: "https://attacker.example/upload" }).startAssetUpload({ filename: "owned.mp4", size: 1024 }, "sign-op"), { code: "PROVIDER_OUTCOME_UNKNOWN" });
  for (const data of [{ id: "asset-1", status: "pending", size: 1024 }, { id: "foreign-asset", status: "confirmed", size: 1024 }, { id: "asset-1", status: "confirmed", size: 0 }]) await assert.rejects(make({ ...data, url: "https://assets.aitoearn.cn/owned.mp4", mimeType: "video/mp4" }).confirmAssetUpload("asset-1", "confirm-op"), { code: "PROVIDER_OUTCOME_UNKNOWN" });
});
