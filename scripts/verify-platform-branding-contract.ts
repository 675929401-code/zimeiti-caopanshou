import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PLATFORM_BRAND_SCHEMA,
  PlatformBrandValidationError,
  extractPlatformBrandAssetIds,
  legacyPlatformBrandPayload,
  parseBrandRevisionId,
  parseExpectedBrandGeneration,
  parsePlatformBrandPayload,
  stableLegacyBrandImageUrl,
} from "../src/lib/branding/contracts";

const squareId = "e8922822-39f2-4e8a-8d45-e93ba97ff6da";
const faviconId = "42d038d0-f22d-44d8-a2e4-248c1393f8fa";
const contactQrPrimaryId = "8d8d96c1-1f28-44a2-97ab-bf0cf7efc151";
const contactQrSecondaryId = "b7695178-3dc9-4f2b-a688-68a7e07eca5b";
const valid = {
  schema: PLATFORM_BRAND_SCHEMA,
  name: "自媒体操盘手",
  shortName: "操盘手",
  slogan: "让内容经营有据可循",
  welcomeMessage: "欢迎使用",
  description: "面向内容经营者的工作台",
  seo: { title: "自媒体操盘手", description: "AI 内容经营平台" },
  colors: { primary: "#168d7a", accent: "#2f80ff" },
  contact: { name: "平台客服", wechat: "Yuange1991xx", phone: "", email: "" },
  assetIds: {
    favicon: faviconId,
    logo_square: squareId,
    contact_wechat_qr_primary: contactQrPrimaryId,
    contact_wechat_qr_secondary: contactQrSecondaryId,
  },
};

const parsed = parsePlatformBrandPayload(valid);
assert.equal(parsed.colors.primary, "#168D7A");
assert.equal(parsed.contact.wechat, "Yuange1991xx");
assert.deepEqual(extractPlatformBrandAssetIds(parsed), [
  { purpose: "logo_square", assetId: squareId },
  { purpose: "favicon", assetId: faviconId },
  { purpose: "contact_wechat_qr_primary", assetId: contactQrPrimaryId },
  { purpose: "contact_wechat_qr_secondary", assetId: contactQrSecondaryId },
]);
assert.equal(parseExpectedBrandGeneration(0), 0);
assert.equal(parseBrandRevisionId(squareId.toUpperCase()), squareId);

assert.throws(
  () => parsePlatformBrandPayload({ ...valid, logoUrl: "https://cdn.example/logo.png?sig=secret" }),
  (error: unknown) => error instanceof PlatformBrandValidationError && error.code === "BRAND_FIELD_UNKNOWN",
);
assert.throws(
  () => parsePlatformBrandPayload({ ...valid, assetIds: { logo_square: "https://cdn.example/logo.png" } }),
  (error: unknown) => error instanceof PlatformBrandValidationError && error.code === "BRAND_ASSET_ID_INVALID",
);
assert.throws(
  () => parseExpectedBrandGeneration("0"),
  (error: unknown) => error instanceof PlatformBrandValidationError && error.code === "BRAND_GENERATION_INVALID",
);

assert.equal(stableLegacyBrandImageUrl("/uploads/brand/logo.png"), "/uploads/brand/logo.png");
assert.equal(stableLegacyBrandImageUrl("https://cdn.example/logo.png"), "https://cdn.example/logo.png");
assert.equal(stableLegacyBrandImageUrl("https://cdn.example/logo.png?X-Amz-Signature=secret"), undefined);
assert.equal(stableLegacyBrandImageUrl(["https://", "user:pass@cdn.example/logo.png"].join("")), undefined);
assert.equal(stableLegacyBrandImageUrl("javascript:alert(1)"), undefined);
assert.equal(stableLegacyBrandImageUrl("logo.png"), undefined);

const legacy = legacyPlatformBrandPayload({ platform_name: "旧平台", welcome_message: "你好" });
assert.equal(legacy.name, "旧平台");
assert.equal(legacy.welcomeMessage, "你好");
assert.deepEqual(legacy.assetIds, {});
assert.deepEqual(legacy.contact, { name: "", wechat: "", phone: "", email: "" });

const migration = readFileSync("supabase/migrations/20261009053000_platform_brand_contact_qr.sql", "utf8");
const adminPanel = readFileSync("src/components/admin/platform-brand-settings-panel.tsx", "utf8");
const landing = readFileSync("src/components/landing/soft-white-landing.tsx", "utf8");
for (const purpose of ["contact_wechat_qr_primary", "contact_wechat_qr_secondary"]) {
  assert.match(migration, new RegExp(purpose, "u"), `${purpose} migration allowlist missing`);
  assert.match(adminPanel, new RegExp(`renderAssetCard\\(\"${purpose}\"\\)`, "u"), `${purpose} admin upload card missing`);
  assert.match(landing, new RegExp(`platformBrandAssetUrl\\(platformBranding, \"${purpose}\"\\)`, "u"), `${purpose} public landing binding missing`);
}
assert.match(migration, /NOT snapshot \? 'contact'[\s\S]*?jsonb_typeof\(snapshot->'contact'\) = 'object'/u,
  "legacy brand snapshots must remain valid while new contact payloads are validated");
assert.match(adminPanel, /对外联系信息[\s\S]*?联系人或客服名称[\s\S]*?微信号[\s\S]*?联系电话[\s\S]*?联系邮箱/u,
  "brand admin must expose the complete contact draft form");
assert.match(landing, /id="swh-contact"[\s\S]*?复制微信号[\s\S]*?swh-contact-qr-grid/u,
  "published contact information must close the public display and copy flow");

console.log("platform branding contract verification passed");
