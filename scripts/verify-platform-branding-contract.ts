import assert from "node:assert/strict";
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
const valid = {
  schema: PLATFORM_BRAND_SCHEMA,
  name: "自媒体操盘手",
  shortName: "操盘手",
  slogan: "让内容经营有据可循",
  welcomeMessage: "欢迎使用",
  description: "面向内容经营者的工作台",
  seo: { title: "自媒体操盘手", description: "AI 内容经营平台" },
  colors: { primary: "#168d7a", accent: "#2f80ff" },
  assetIds: { favicon: faviconId, logo_square: squareId },
};

const parsed = parsePlatformBrandPayload(valid);
assert.equal(parsed.colors.primary, "#168D7A");
assert.deepEqual(extractPlatformBrandAssetIds(parsed), [
  { purpose: "logo_square", assetId: squareId },
  { purpose: "favicon", assetId: faviconId },
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

console.log("platform branding contract verification passed");
