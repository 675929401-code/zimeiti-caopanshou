import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLISHING_DEFAULT_PUBLIC_CONFIG, PUBLISHING_DEFAULT_OPERATOR_LINKS, PublishingActionSchema,
  PublishingAdminActionSchema, PublishingCenterSchema, PublishingConfigInputSchema,
  PublishingCommercialPlatformSchema, PublishingEntitlementSchema, PUBLISHING_COMMERCIAL_PLATFORMS,
  isPublishingSafeHttps, isPublishingShareLink,
} from "../src/lib/publishing-contract";

const draft = { title: "成片标题", body: "视频正文", topics: ["日常记录"], platforms: ["xhs"], assets: [{ fileName: "成片.mp4", size: 12345, type: "video/mp4", lastModified: 1000 }] };
const account = { platform: "xhs", platformAccountId: "browser-account", displayName: "当前浏览器账号" };
const id = "00000000-0000-4000-8000-000000000001";
test("unconfigured product is safe by default and public snapshot has no operator-only fields", () => {
  assert.equal(PUBLISHING_DEFAULT_PUBLIC_CONFIG.executionEnabled, false);
  assert.equal(PUBLISHING_DEFAULT_PUBLIC_CONFIG.salesEnabled, false);
  assert.equal(PUBLISHING_DEFAULT_PUBLIC_CONFIG.cloudEnabled, false);
  const snapshot = { config: PUBLISHING_DEFAULT_PUBLIC_CONFIG, plans: [], entitlements: [], purchases: [], accounts: [], drafts: [], tasks: [], walletCash: 0, schemaReady: false, access: { allowed: false, code: "PUBLISH_ACCESS_DENIED", message: "尚未授权" } };
  assert.equal(PublishingCenterSchema.safeParse(snapshot).success, true);
  assert.equal(PublishingCenterSchema.safeParse({ ...snapshot, config: { ...snapshot.config, operatorLinks: PUBLISHING_DEFAULT_OPERATOR_LINKS } }).success, false);
});
test("only official plugin platform keys are accepted", () => {
  for (const platform of ["xhs", "douyin", "wxSph"]) assert.equal(PublishingActionSchema.safeParse({ action: "save-account", account: { ...account, platform } }).success, true);
  for (const platform of ["xiaohongshu", "shipinhao", "bilibili"]) assert.equal(PublishingActionSchema.safeParse({ action: "save-account", account: { ...account, platform } }).success, false);
});
test("commercial platform eligibility covers the native catalog without widening legacy account or draft execution", () => {
  assert.equal(PUBLISHING_COMMERCIAL_PLATFORMS.length, 14);
  for (const { key } of PUBLISHING_COMMERCIAL_PLATFORMS) assert.equal(PublishingCommercialPlatformSchema.parse(key), key);
  const config = { expectedVersion: 1, executionEnabled: false, salesEnabled: false, enabledPlatforms: PUBLISHING_COMMERCIAL_PLATFORMS.map(item => item.key), announcement: "", operatorLinks: PUBLISHING_DEFAULT_OPERATOR_LINKS, procurementNotes: "", procurementVerifiedAt: null };
  assert.equal(PublishingConfigInputSchema.safeParse(config).success, true);
  const plan = { id, expectedVersion: 0, name: "渠道范围由站方配置", description: "", priceCents: 1, quota: 1, validDays: 1, platforms: config.enabledPlatforms, enabled: false };
  assert.equal(PublishingAdminActionSchema.safeParse({ action: "save-plan", plan }).success, true);
  assert.equal(PublishingCommercialPlatformSchema.safeParse("unregistered-platform").success, false);
  for (const platform of ["youtube", "bilibili", "KWAI"]) {
    assert.equal(PublishingActionSchema.safeParse({ action: "save-account", account: { ...account, platform } }).success, false);
    assert.equal(PublishingActionSchema.safeParse({ action: "save-draft", expectedRevision: 0, draft: { ...draft, platforms: [platform] } }).success, false);
  }
});
test("reading existing purchased rights preserves their exact platform scope", () => {
  const entitlement = { id, purchaseId: id, planId: id, planVersion: 1, planName: "原套餐", quota: 10, used: 2, expiresAt: "2026-12-01T00:00:00Z", platforms: ["xhs"] };
  assert.deepEqual(PublishingEntitlementSchema.parse(entitlement), entitlement);
  const snapshot = PublishingCenterSchema.parse({ config: PUBLISHING_DEFAULT_PUBLIC_CONFIG, plans: [], entitlements: [entitlement], purchases: [], accounts: [], drafts: [], tasks: [], walletCash: 0, schemaReady: true, access: { allowed: true, code: "PUBLISH_ACCESS_READY", message: "" } });
  assert.deepEqual(snapshot.entitlements[0].platforms, ["xhs"]);
  assert.equal(snapshot.config.executionEnabled, false);
  assert.equal(snapshot.config.salesEnabled, false);
});
test("plugin account cannot persist Cookie, token, raw payload or client owner", () => {
  for (const field of ["cookie", "token", "raw", "authorization", "userId", "ownerId"]) {
    assert.equal(PublishingActionSchema.safeParse({ action: "save-account", account: { ...account, [field]: "must-not-store" } }).success, false);
    assert.equal(PublishingActionSchema.safeParse({ action: "save-account", account, [field]: "must-not-store" }).success, false);
  }
});
test("draft stores local file metadata and topics, rejects File bodies and remote URLs", () => {
  const parsed = PublishingActionSchema.parse({ action: "save-draft", expectedRevision: 0, draft });
  assert.equal(parsed.action, "save-draft");
  if (parsed.action === "save-draft") assert.deepEqual(parsed.draft.topics, ["日常记录"]);
  for (const forbidden of [{ url: "https://example.com/movie.mp4" }, { data: "base64-file-body" }, { file: {} }]) {
    assert.equal(PublishingActionSchema.safeParse({ action: "save-draft", expectedRevision: 0, draft: { ...draft, assets: [{ ...draft.assets[0], ...forbidden }] } }).success, false);
  }
});
test("claim quota and authenticated owner cannot be supplied by caller", () => {
  const claim = { action: "claim", draftId: id, draftRevision: 1, accountId: id, entitlementId: id, idempotencyKey: "local-key-001" };
  assert.equal(PublishingActionSchema.safeParse(claim).success, true);
  for (const field of ["userId", "ownerId", "quantity", "cost", "quota", "shouldExecute"]) assert.equal(PublishingActionSchema.safeParse({ ...claim, [field]: 1 }).success, false);
});
test("purchase cannot supply prices or substitute wallet", () => {
  const purchase = { action: "purchase", planId: id, planVersion: 1, idempotencyKey: "local-key-002" };
  assert.equal(PublishingActionSchema.safeParse(purchase).success, true);
  for (const field of ["amount", "priceCents", "wallet", "userId"]) assert.equal(PublishingActionSchema.safeParse({ ...purchase, [field]: 0 }).success, false);
});
test("procurement links reject credentials, non-HTTPS, local addresses and numeric IP forms", () => {
  for (const address of ["javascript:alert(1)", "http://aitoearn.cn/", "https://127.0.0.1/", "https://2130706433/", "https://0x7f000001/", "https://[::1]/", "https://localhost/", "https://metadata.google.internal/", "https://admin.local/", "https://aitoearn.cn:8443/"]) assert.equal(isPublishingSafeHttps(address), false, address);
  for (const address of Object.values(PUBLISHING_DEFAULT_OPERATOR_LINKS)) assert.equal(isPublishingSafeHttps(address), true);
  // Build synthetic rejection fixtures with URL APIs so source release scanning
  // never encounters a literal URL containing even a fake credential value.
  const userInfo = new URL("https://public.example/path");
  userInfo.username = "synthetic-fixture";
  userInfo.password = "synthetic-fixture";
  assert.equal(isPublishingSafeHttps(userInfo.href), false);
  for (const field of ["token", "api_key", "auth_token", "session_token", "loginCookie"]) {
    const address = new URL("https://public.example/path");
    address.searchParams.set(field, "synthetic-fixture");
    assert.equal(isPublishingSafeHttps(address.href), false, field);
    if (field === "api_key") {
      address.search = address.search.replace("api_key", "api%5Fkey");
      assert.equal(isPublishingSafeHttps(address.href), false, "encoded query field");
    }
  }
  for (const [prefix, field] of [["", "secret"], ["/callback?", "access_token"], ["/callback?", "access%5Ftoken"]]) {
    const address = new URL("https://public.example/path");
    const fragment = new URLSearchParams();
    fragment.set(field, "synthetic-fixture");
    address.hash = prefix + fragment.toString();
    assert.equal(isPublishingSafeHttps(address.href), false, field);
  }
});
test("receipt share URLs are platform-specific and never imply trusted delivery", () => {
  assert.equal(isPublishingShareLink("xhs", "https://www.xiaohongshu.com/explore/abc"), true);
  assert.equal(isPublishingShareLink("douyin", "https://www.xiaohongshu.com/explore/abc"), false);
  assert.equal(isPublishingShareLink("xhs", "https://xiaohongshu.com.attacker.example/abc"), false);
  assert.equal(PublishingActionSchema.safeParse({ action: "report", taskId: id, success: true, trusted: true }).success, false);
});
test("admin cannot store secrets or create a free/invalid plan", () => {
  const config = { expectedVersion: 1, executionEnabled: false, salesEnabled: false, enabledPlatforms: ["xhs"], announcement: "", operatorLinks: PUBLISHING_DEFAULT_OPERATOR_LINKS, procurementNotes: "仅保存联系记录", procurementVerifiedAt: null };
  assert.equal(PublishingConfigInputSchema.safeParse(config).success, true);
  for (const procurementNotes of ["api_key=secret-value-123456", "Cookie: session-secret", "Bearer token-value-123456", "sk-1234567890123456789"]) assert.equal(PublishingConfigInputSchema.safeParse({ ...config, procurementNotes }).success, false);
  const plan = { id, expectedVersion: 0, name: "管理员决定名称", description: "", priceCents: 1, quota: 1, validDays: 1, platforms: ["xhs"], enabled: false };
  assert.equal(PublishingAdminActionSchema.safeParse({ action: "save-plan", plan }).success, true);
  for (const priceCents of [0, -1, 0.1]) assert.equal(PublishingAdminActionSchema.safeParse({ action: "save-plan", plan: { ...plan, priceCents } }).success, false);
});
