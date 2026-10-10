import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseWhiteLabelDraftInput,
  parseWhiteLabelPublicationInput,
} from "../src/lib/white-label-profile-contract";
import {
  WhiteLabelHostError,
  isPlatformDisplayHost,
  normalizeDirectHostHeader,
} from "../src/lib/white-label-host";

assert.equal(normalizeDirectHostHeader("LOCALHOST:5000"), "localhost");
assert.equal(normalizeDirectHostHeader("127.0.0.1:5000"), "127.0.0.1");
assert.equal(normalizeDirectHostHeader("AI.Example.CN."), "ai.example.cn");
assert.throws(() => normalizeDirectHostHeader("https://example.cn"), WhiteLabelHostError);
assert.throws(() => normalizeDirectHostHeader("good.example.cn,evil.example.cn"), WhiteLabelHostError);
assert.throws(() => normalizeDirectHostHeader("good.example.cn/path"), WhiteLabelHostError);
assert.equal(isPlatformDisplayHost("official.example.cn", {
  PLATFORM_CANONICAL_HOSTS: "official.example.cn",
}), true);
assert.equal(isPlatformDisplayHost("zycheni9.com", {}), true);
assert.equal(isPlatformDisplayHost("unknown.example.cn", {
  PLATFORM_CANONICAL_HOSTS: "official.example.cn",
}), false);

const draft = parseWhiteLabelDraftInput({
  profileId: null,
  expectedRevision: 0,
  brandName: "客户品牌",
  brandShortName: "客户",
  brandSlogan: "真实品牌标语",
  brandDescription: "仅作为展示品牌，不参与业务数据授权。",
  hostname: "AI.Customer.Example.CN",
  contact: { name: "联系人", wechat: "customer_wechat", phone: "", email: "" },
  assetIds: {},
});
assert.equal(draft.domain.asciiHostname, "ai.customer.example.cn");
assert.equal(draft.brandSlogan, "真实品牌标语");
assert.equal(draft.contact.wechat, "customer_wechat");
assert.deepEqual(parseWhiteLabelPublicationInput({
  profileId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 3,
}), {
  profileId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 3,
});

const brandingRoute = readFileSync("src/app/api/branding/route.ts", "utf8");
const assetRoute = readFileSync("src/app/api/branding/assets/[id]/route.ts", "utf8");
const adminAssetRoute = readFileSync("src/app/api/admin/branding/assets/[id]/route.ts", "utf8");
const adminRoute = readFileSync("src/app/api/admin/white-label/route.ts", "utf8");
const runtime = readFileSync("src/lib/server/white-label-runtime.ts", "utf8");
const migration = readFileSync("supabase/migrations/20261009054000_white_label_runtime_publish.sql", "utf8");
const rollback = readFileSync("supabase/rollbacks/20261009054000_white_label_runtime_publish.rollback.sql", "utf8");

assert.match(brandingRoute, /request\.headers\.get\("host"\)/u);
assert.doesNotMatch(brandingRoute, /headers\.get\("x-forwarded-host"\)/iu);
assert.match(brandingRoute, /status === 421/u);
assert.match(brandingRoute, /Vary: "Host/u);
assert.match(assetRoute, /BRAND_ASSET_REVISION_MISMATCH/u);
assert.match(assetRoute, /readResolvedPublishedAsset/u);
assert.match(assetRoute, /asset\.storageProvider === "local"\s*\? null\s*:\s*await storageManager\.getSignedUrl/u);
assert.match(assetRoute, /if \(signedUrl &&/u);
assert.doesNotMatch(assetRoute, /headers\.get\("x-forwarded-host"\)/iu);
assert.match(adminAssetRoute, /asset\.storageProvider === "local"\s*\? null\s*:\s*await storageManager\.getSignedUrl/u);
assert.match(adminAssetRoute, /if \(signedUrl &&/u);
assert.match(runtime, /BRAND_HOST_NOT_PUBLISHED", 421/u);
assert.match(runtime, /Host is a display-brand selector only|display-brand selector/u);
assert.match(adminRoute, /action === "publish"/u);
assert.match(adminRoute, /action=upload-asset|upload-asset/u);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.white_label_assets/u);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.white_label_release_assets/u);
assert.match(migration, /publish_white_label_draft_atomic/u);
assert.match(migration, /read_published_white_label_brand/u);
assert.match(migration, /read_published_white_label_asset/u);
assert.match(migration, /WHITE_LABEL_PUBLISHED_RELEASE_IMMUTABLE/u);
assert.match(migration, /Host display-brand lookup only/u);
assert.doesNotMatch(migration, /white_label_assets[\s\S]{0,500}platform_brand_assets/u);
assert.match(rollback, /ROLLBACK_BLOCKED_WHITE_LABEL_RUNTIME_DATA_EXISTS/u);

console.log(JSON.stringify({
  status: "PASS",
  hostSource: "direct Host only",
  unknownHost: 421,
  publication: "draft and immutable published release separated",
  assetBoundary: "profile-owned + host + published revision",
}, null, 2));
