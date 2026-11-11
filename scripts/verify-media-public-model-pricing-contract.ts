import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  containsForbiddenPublicModelKey,
  publicModelDisplayName,
  publicMediaBillingCapabilities,
  toPublicModelId,
  toPublicModelDto,
} from "@/lib/public-model-dto";
import { correctVideoModelBindingDisplayName, stripVideoModelOperationalAnnotation } from "@/lib/video-model-display-name";
import { compactPublicVideoModelName } from "@/lib/video-history-presentation";
import { videoModelInputHint, videoModelInputLabel } from "@/lib/video-model-selection-state";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const perUse = publicMediaBillingCapabilities("per_use");
const perSecond = publicMediaBillingCapabilities("output_second");

assert.deepEqual(perUse, {
  pricingMode: "fixed_per_use",
  billingUnit: "per_use",
});
assert.deepEqual(perSecond, {
  pricingMode: "output_second",
  billingUnit: "output_second",
});

const imageDto = toPublicModelDto("cover", {
  id: "image-internal-id",
  name: "图片模型",
  selling_price: 1.25,
}, 0, {
  type: "image",
  ...perUse,
});
const videoPerUseDto = toPublicModelDto("video", {
  id: "video-per-use-internal-id",
  name: "按次视频模型",
  price_per_use: 0.8,
}, 0, {
  type: "video",
  ...perUse,
});
const videoPerSecondDto = toPublicModelDto("video", {
  id: "video-per-second-internal-id",
  name: "按秒视频模型",
  price_per_use: 0.08,
}, 1, {
  type: "video",
  ...perSecond,
});

assert.equal(imageDto.publicPrice, 1.25);
assert.equal(imageDto.capabilities.pricingMode, "fixed_per_use");
assert.equal(imageDto.capabilities.billingUnit, "per_use");
assert.equal(videoPerUseDto.publicPrice, 0.8);
assert.equal(videoPerUseDto.capabilities.pricingMode, "fixed_per_use");
assert.equal(videoPerUseDto.capabilities.billingUnit, "per_use");
assert.equal(videoPerSecondDto.publicPrice, 0.08);
assert.equal(videoPerSecondDto.capabilities.pricingMode, "output_second");
assert.equal(videoPerSecondDto.capabilities.billingUnit, "output_second");
assert.equal(containsForbiddenPublicModelKey([imageDto, videoPerUseDto, videoPerSecondDto]), false);
assert.equal(publicModelDisplayName({ name: "MiniMax H3 · 多图参考（AutoDL 在线）" }), "MiniMax H3 · 多图参考");
assert.equal(publicModelDisplayName({ name: "Qwen Image 2512 高清（AutoDL自租）" }), "Qwen Image 2512 高清");
assert.equal(publicModelDisplayName({ name: "GPT Image 中转lconai" }), "GPT Image");
assert.equal(publicModelDisplayName({ name: "Veo 3.1 secure-skill高质量渠道" }), "Veo 3.1");
assert.equal(publicModelDisplayName({ name: "Seedance 2.5 · 旗舰 · 4–30秒 · 1080p待开放" }), "Seedance 2.5 · 旗舰 · 4–30秒 · 1080p");

const displayCases: Array<{ name: string; expected: string; public_name?: string; group?: string }> = [
  { name: "GPT Image 2 · A渠道低成本档（image-2-1k）", expected: "GPT Image 2 · 低成本档", group: "image-2-1k" },
  { name: "GPT Image 2 · A渠道低成本档（adobe-image2-mid）", expected: "GPT Image 2 · 低成本档", group: "adobe-image2-mid" },
  { name: "GPT Image 2 · A渠道官方档（image2-官key）", expected: "GPT Image 2 · 官方档", group: "image2-官key" },
  { name: "GPT Image 2 · A渠道低成本档（image-2-1k）", expected: "GPT Image 2 · 低成本档" },
  { name: "GPT Image 2 · A渠道低成本档（adobe-image2-mid）", expected: "GPT Image 2 · 低成本档" },
  { name: "GPT Image 2 · A渠道官方档（image2-官key）", expected: "GPT Image 2 · 官方档" },
  { name: "GPT-Image-2 · 渠道A pro", expected: "GPT-Image-2 · pro" },
  { name: "GPT Image 2　·　A　渠道低成本档（adobe-image2-mid）", expected: "GPT Image 2　·　低成本档" },
  { name: "图片模型 · A渠道高质量档（private-route-v2）", expected: "图片模型 · 高质量档", group: "private-route-v2" },
  { name: "豆包 Seedream 5.0 Pro（多图参考）", expected: "豆包 Seedream 5.0 Pro（多图参考）" },
  { name: "GPT Image 2（4K）", expected: "GPT Image 2（4K）" },
  { name: "Creative Model (Preview-v2)", expected: "Creative Model (Preview-v2)" },
  { name: "GPT Image 2 · A渠道低成本档（Creative-Pro）", expected: "GPT Image 2 · 低成本档（Creative-Pro）" },
  { name: "GPT Image 2 · A渠道低成本档（adobe-image2-mid）", public_name: "创作专享（Preview-v2）", expected: "创作专享（Preview-v2）", group: "adobe-image2-mid" },
  { name: "后台路由", public_name: "创作专享（Creative-Pro）", expected: "创作专享（Creative-Pro）", group: "Creative-Pro" },
  { name: "后台路由", public_name: "GPT-Image-2 · 渠道A pro", expected: "GPT-Image-2 · pro" },
  { name: "后台路由", public_name: "GPT Image 2 · A渠道低成本档（adobe-image2-mid）", expected: "GPT Image 2 · 低成本档", group: "adobe-image2-mid" },
  { name: "产品（internal-model-route）", expected: "产品" },
  { name: "GPT Image 2 · 渠道A (密钥F)", expected: "GPT Image 2" },
];
for (const [index, fixture] of displayCases.entries()) {
  const row = { id: `internal-display-fixture-${index}`, name: fixture.name, public_name: fixture.public_name,
    model_name: "internal-model-route", selling_price: 0.1, variant_label: "公开变体",
    api_protocol_config: fixture.group ? { provider_group_name: fixture.group } : undefined };
  const capabilities = { available: index % 2 === 0, priceReady: true, supportsImageInput: true, resolutionOptions: ["1K", "2K"] };
  const dto = toPublicModelDto("cover", row, index, capabilities);
  assert.equal(dto.displayName, fixture.expected, `public display boundary: ${fixture.name}`);
  assert.equal(dto.id, toPublicModelId("cover", row.id), "display cleanup must retain the same opaque public ID");
  assert.equal(dto.publicPrice, 0.1, "display cleanup must not change the selling price");
  assert.equal(dto.variantLabel, "公开变体", "configured public variant stays separate from provider routing");
  assert.deepEqual(dto.capabilities, capabilities, "visibility, readiness and capabilities must stay unchanged");
  assert.equal(containsForbiddenPublicModelKey(dto), false);
}
assert.equal(toPublicModelDto("cover", { id: "only-internal-id" }, 0).displayName, "模型", "missing public name must not fall back to an internal ID");

const routingSuffixCases = [
  { name: "Omni Flash · 8秒 · 高端渠道", expected: "Omni Flash · 8秒" },
  { name: "后台路由", public_name: "Omni Flash · 8秒 · 高端渠道", expected: "Omni Flash · 8秒" },
  { name: "Grok Imagine 1.0 Video · 高端渠道", expected: "Grok Imagine 1.0 Video" },
  { name: "Grok Imagine Video 1.5 · 高端渠道", expected: "Grok Imagine Video 1.5" },
  { name: "后台路由", public_name: "Grok Imagine Video 1.5 · 高端渠道", expected: "Grok Imagine Video 1.5" },
  { name: "Omni Flash　｜　高端渠道　", expected: "Omni Flash" },
  { name: "Omni Flash | 高端渠道", expected: "Omni Flash" },
  { name: "Omni Flash / 高端渠道", expected: "Omni Flash" },
  { name: "高端创作 Pro", expected: "高端创作 Pro" },
  { name: "渠道管理教程", expected: "渠道管理教程" },
  { name: "创作模型 (4K)", expected: "创作模型 (4K)" },
  { name: "创作模型 (Preview) pro", expected: "创作模型 (Preview) pro" },
  { name: "Omni Flash · 低成本档", expected: "Omni Flash · 低成本档" },
  { name: "创作模型 · 公开 A/B", expected: "创作模型 · 公开 A/B" },
  { name: "高端渠道教程", expected: "高端渠道教程" },
  { name: "创作模型高端渠道", expected: "创作模型高端渠道" },
  { name: "创作模型 · 高端渠道 · 公开版", expected: "创作模型 · 高端渠道 · 公开版" },
];
for (const [index, fixture] of routingSuffixCases.entries()) {
  const row = { id: `routing-suffix-fixture-${index}`, ...fixture, selling_price: 1.25,
    variant_label: index % 2 === 0 ? "A" : "B" };
  const capabilities = { available: index % 2 === 0, priceReady: true, supportsImageInput: true,
    minDuration: 4, maxDuration: 15, resolutionOptions: ["720p", "1080p"] };
  const dto = toPublicModelDto("video", row, index, capabilities);
  assert.equal(dto.displayName, fixture.expected, "only the evidenced independent routing suffix is removed");
  assert.equal(dto.id, toPublicModelId("video", row.id));
  assert.equal(dto.publicPrice, 1.25);
  assert.equal(dto.variantLabel, row.variant_label, "public A/B variants remain unchanged");
  assert.deepEqual(dto.capabilities, capabilities, "visibility, pricing readiness and video capabilities remain unchanged");
  assert.equal(containsForbiddenPublicModelKey(dto), false);
}

const operationalNameCases = [
  { name: "Seedance 2.0 · 高瑞（能力核对中）", expected: "Seedance 2.0 · 高瑞" },
  { name: "Seedance 2.5 · 高瑞 (能力待核验)", expected: "Seedance 2.5 · 高瑞" },
  { name: "Seedance 2.5 · 高瑞 · 能力待核验", expected: "Seedance 2.5 · 高瑞" },
  { name: "Seedance 2.5 · 高瑞（能力核对中） (配置待验收)", expected: "Seedance 2.5 · 高瑞" },
  { name: "Seedance 2.0 Fast · 720P（多图参考）", expected: "Seedance 2.0 Fast · 720P（多图参考）" },
  { name: "Seedance 2.0 Mini (Preview) · 4K", expected: "Seedance 2.0 Mini (Preview) · 4K" },
  { name: "能力核对中教程 · 公开版", expected: "能力核对中教程 · 公开版" },
];
for (const [index, fixture] of operationalNameCases.entries()) {
  const row = { id: `video-operational-name-${index}`, name: fixture.name,
    selling_price: 1.1, variant_label: "A", avatar_url: "/model-brands/seedance.svg" };
  const capabilities = { available: true, generationReady: true, priceReady: true,
    supportsPrompt: true, supportsImageInput: true, ...perSecond };
  const dto = toPublicModelDto("video", row, index, capabilities);
  assert.equal(stripVideoModelOperationalAnnotation(fixture.name), fixture.expected);
  assert.equal(dto.displayName, fixture.expected);
  assert.equal(compactPublicVideoModelName(fixture.name), fixture.expected);
  assert.equal(dto.id, toPublicModelId("video", row.id));
  assert.equal(dto.publicPrice, 1.1);
  assert.equal(dto.avatarUrl, row.avatar_url);
  assert.equal(dto.variantLabel, "A");
  assert.deepEqual(dto.capabilities, capabilities, "public copy cleanup must not change admission or billing");
}
assert.equal(toPublicModelDto("cover", { id: "image-review-name", name: "图像模型（能力核对中）" }, 0).displayName,
  "图像模型（能力核对中）", "video-only review-note cleanup must not rewrite image names");
assert.equal(toPublicModelDto("chat", { id: "chat-review-name", name: "聊天模型（能力待核验）" }, 0).displayName,
  "聊天模型（能力待核验）", "video-only review-note cleanup must not rewrite chat names");

const legacyVeoName = "Veo 3.1 Fast · 8秒 · 图生视频 · 720P/1080P · 渠道C";
const correctedVeoName = "Veo 3.1 · 8秒 · 图生视频 · 720P/1080P";
const veoBinding = { id: "veo-3-1-fast-chC", protocol_type: "gaorui_video", model_name: "veo_3_1-fl" };
const veoBindingCases = [
  { row: veoBinding, name: legacyVeoName, expected: `${correctedVeoName} · 渠道C` },
  { row: veoBinding, name: "  vEO\t3.1  FaSt · 8秒 · 图生视频  ", expected: "Veo 3.1 · 8秒 · 图生视频" },
  { row: veoBinding, name: "Veo 3.1 Fast", expected: "Veo 3.1" },
  { row: veoBinding, name: "Veo 3.1 · 图生视频", expected: "Veo 3.1 · 图生视频" },
  { row: veoBinding, name: "Veo 3.1 Fastest · 8秒", expected: "Veo 3.1 Fastest · 8秒" },
  { row: veoBinding, name: "Veo 3.1 Fast Pro · 8秒", expected: "Veo 3.1 Fast Pro · 8秒" },
  { row: veoBinding, name: "Veo 3.1 · Fast · 图生视频", expected: "Veo 3.1 · Fast · 图生视频" },
  { row: { ...veoBinding, id: "other-real-fast" }, name: legacyVeoName, expected: legacyVeoName },
  { row: { ...veoBinding, model_name: "veo_3_1-fast" }, name: legacyVeoName, expected: legacyVeoName },
  { row: { ...veoBinding, protocol_type: "openapi_video" }, name: legacyVeoName, expected: legacyVeoName },
  { row: { ...veoBinding, model_name: undefined }, name: legacyVeoName, expected: legacyVeoName },
  { row: { ...veoBinding, protocol_type: undefined }, name: legacyVeoName, expected: legacyVeoName },
  { row: { ...veoBinding, id: undefined }, name: legacyVeoName, expected: legacyVeoName },
  { row: {}, name: legacyVeoName, expected: legacyVeoName },
  { row: { ...veoBinding, id: ` ${veoBinding.id} `, protocol_type: " gaorui_video ", model_name: " veo_3_1-fl " }, name: legacyVeoName, expected: `${correctedVeoName} · 渠道C` },
];
for (const fixture of veoBindingCases) {
  assert.equal(correctVideoModelBindingDisplayName(fixture.name, fixture.row), fixture.expected,
    "only the exact legacy prefix with all three current binding fields may be corrected");
}
const veoCapabilities = { available: true, generationReady: true, priceReady: true,
  supportsImageInput: true, requiresImage: true, minReferenceImages: 1, maxReferenceImages: 1,
  resolutionOptions: ["720p", "1080p"], ...perUse };
const veoRow = Object.freeze({ ...veoBinding, name: legacyVeoName, price_per_use: 0.36, variant_label: "C",
  api_protocol_config: Object.freeze({ inputs: Object.freeze({}) }) });
const veoBefore = JSON.stringify(veoRow);
const veoDto = toPublicModelDto("video", veoRow, 26, veoCapabilities);
assert.equal(publicModelDisplayName(veoRow), correctedVeoName);
assert.equal(veoDto.displayName, correctedVeoName);
assert.equal(veoDto.id, toPublicModelId("video", veoRow.id));
assert.equal(veoDto.publicPrice, 0.36);
assert.equal(veoDto.variantLabel, "C");
assert.deepEqual(veoDto.capabilities, veoCapabilities, "display correction must preserve input, admission and billing capabilities");
assert.equal(containsForbiddenPublicModelKey(veoDto), false, "correction must not expose its internal binding");
assert.equal(JSON.stringify(veoRow), veoBefore, "raw management data and input configuration must remain unchanged");
assert.equal(publicModelDisplayName({ ...veoRow, public_name: "专享创作（Preview-v2）" }), "专享创作（Preview-v2）",
  "an explicit public name must keep priority over the raw management name");
assert.equal(publicModelDisplayName({ ...veoRow, name: "旧管理名称", public_name: legacyVeoName }), correctedVeoName);
assert.equal(publicModelDisplayName({ ...veoRow, public_name: "  " }), correctedVeoName);
assert.equal(publicModelDisplayName({ ...veoRow, id: "veo-3-1-fl-gaorui", name: "Veo 3.1 · 8秒 · 首帧，尾帧可选" }),
  "Veo 3.1 · 8秒 · 首帧，尾帧可选", "the separately configured optional-tail model must keep its input wording");
assert.equal(publicModelDisplayName({ id: veoBinding.id, name: "所选视频模型" }), "所选视频模型",
  "a missing/deleted model join must retain the existing history fallback");
assert.equal(compactPublicVideoModelName(legacyVeoName), legacyVeoName,
  "an unbound historical name must not be relabeled by the string-only presentation helper");
const videoHistoryRoute = read("src/app/api/video/history/route.ts");
const mediaHistoryRoute = read("src/app/api/media-history/route.ts");
assert.match(videoHistoryRoute, /publicModelDisplayName\(\{ \.\.\.model, id: t\.model_id,/u);
assert.match(mediaHistoryRoute, /video_models\(name,model_name,protocol_type\)/u);
assert.match(mediaHistoryRoute, /correctVideoModelBindingDisplayName\(configuredModelName, \{ \.\.\.configuredModel, id: row\.model_id \}\)/u);

for (const [modelName, price] of [["seedance-2.0", 1.1], ["seedance-2.5", 1.6]] as const) {
  const row = { id: `plain-gated-${modelName}`, name: `${modelName} · 高瑞（能力核对中）`,
    protocol_type: "gaorui_video", model_name: modelName, selling_price: price };
  const dto = toPublicModelDto("video", row, 0, { capabilitiesVerified: true,
    available: true, generationReady: true, priceReady: true, ...perSecond });
  assert.equal(dto.displayName, `${modelName} · 高瑞`);
  assert.equal(dto.publicPrice, price);
  assert.equal(dto.capabilities.billingUnit, "output_second");
  assert.equal(dto.capabilities.capabilitiesVerified, true);
  assert.equal(dto.capabilities.generationReady, false, "missing structured binding must keep creation closed");
  const bound = toPublicModelDto("video", { ...row, api_endpoint: "https://gaorui.cc/v1", api_protocol_config: { protocol_family: "seedance_native_content", duration_behavior: "requested_target" } }, 0,
    { capabilitiesVerified: false, available: true, generationReady: true, priceReady: true, maxReferenceImages: 1, supportsImageInput: true,
      ...(modelName === "seedance-2.5" ? { firstFrameRatioPolicy: "adaptive" } : {}), ...perSecond });
  assert.equal(bound.capabilities.capabilitiesVerified, false, "acceptance diagnostic must remain honest");
  assert.equal(bound.capabilities.generationReady, true); assert.equal(bound.capabilities.maxReferenceImages, 1);
  assert.equal(bound.capabilities.durationBehavior, "requested_target", "acceptance diagnostic must not erase timing semantics");
  assert.equal(bound.capabilities.firstFrameRatioPolicy, modelName === "seedance-2.5" ? "adaptive" : undefined);
}
const unknownInput = { id: "unknown-input", capabilitiesVerified: false, requiresImage: true, supportsPrompt: true };
assert.equal(videoModelInputLabel(unknownInput), "图生视频");
assert.equal(videoModelInputHint(unknownInput), "需参考图");
assert.equal(videoModelInputLabel({ id: "no-contract" }), "");
assert.equal(videoModelInputHint({ id: "no-contract" }), "");
assert.equal(videoModelInputLabel({ id: "text", supportsPrompt: true }), "文生视频");
assert.equal(videoModelInputHint({ id: "text", supportsPrompt: true }), "支持文生视频");
assert.equal(videoModelInputLabel({ id: "text-image", supportsPrompt: true, supportsImageInput: true }), "文生 / 图生视频");
assert.equal(videoModelInputHint({ id: "text-image", supportsPrompt: true, supportsImageInput: true }), "支持文生和图生视频");
assert.equal(videoModelInputLabel({ id: "first-last", requiresFirstFrame: true, requiresLastFrame: true }), "首尾帧");
assert.equal(videoModelInputLabel({ id: "source", requiresSourceVideo: true }), "视频编辑");

const videoRoute = read("src/app/api/video/models/route.ts");
const imageRoute = read("src/app/api/cover-models/route.ts");
const storyboardWorkbench = read("src/components/storyboard-workbench.tsx");
assert.match(videoRoute, /\.\.\.publicMediaBillingCapabilities\(model\.billingUnit\)/u);
assert.match(imageRoute, /\.\.\.publicMediaBillingCapabilities\("per_use"\)/u);
assert.match(imageRoute, /function disabledImageModelMessage/u);
assert.match(imageRoute, /model\.is_active !== true\s*\? disabledImageModelMessage\(model\)/u);
assert.doesNotMatch(imageRoute, /成本价或销售价缺失/u);
assert.match(storyboardWorkbench, /!model\.available \|\| !model\.priceReady/u);

const surfaces = [
  "/api/video/models?surface=video-page",
  "/api/video/models?surface=storyboard-workbench",
  "/api/video/models?surface=digital-human",
  "/api/cover-models?surface=image-workbench",
  "/api/cover-models?surface=storyboard-workbench",
  "/api/cover-models",
];
assert.equal(surfaces.length, 6);
const consumers = [
  ["src/app/video/page.tsx", surfaces[0]],
  ["src/components/storyboard-workbench.tsx", surfaces[1]],
  ["src/app/digital-human/page.tsx", surfaces[2]],
  ["src/components/storyboard-workbench.tsx", surfaces[4]],
  ["src/components/cover-studio.tsx", surfaces[5]],
] as const;
for (const [consumer, endpoint] of consumers) {
  assert.ok(read(consumer).includes(endpoint), `${consumer} must keep using ${endpoint}`);
}

console.log(JSON.stringify({
  passed: true,
  checks: 30,
  publicDisplayCases: displayCases.length + 1,
  routingSuffixCases: routingSuffixCases.length,
  operationalNameCases: operationalNameCases.length,
  veoBindingCases: veoBindingCases.length,
  veoPublicDisplayAndHistoryContract: true,
  unboundPlainConfigurationsGated: 2,
  surfaces,
  providerSubmissions: 0,
  realNetworkRequests: 0,
  databaseWrites: 0,
  walletWrites: 0,
}, null, 2));
