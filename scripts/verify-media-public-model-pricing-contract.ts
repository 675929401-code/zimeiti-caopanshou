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

const videoRoute = read("src/app/api/video/models/route.ts");
const imageRoute = read("src/app/api/cover-models/route.ts");
const storyboardWorkbench = read("src/components/storyboard-workbench.tsx");
assert.match(videoRoute, /\.\.\.publicMediaBillingCapabilities\(model\.billingUnit\)/u);
assert.match(imageRoute, /\.\.\.publicMediaBillingCapabilities\("per_use"\)/u);
assert.match(imageRoute, /当前未开放/u);
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
  ["src/components/image-workbench.tsx", surfaces[3]],
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
  surfaces,
  providerSubmissions: 0,
  realNetworkRequests: 0,
  databaseWrites: 0,
  walletWrites: 0,
}, null, 2));
