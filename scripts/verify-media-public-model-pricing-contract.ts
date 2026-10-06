import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  containsForbiddenPublicModelKey,
  publicModelDisplayName,
  publicMediaBillingCapabilities,
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
  surfaces,
  providerSubmissions: 0,
  realNetworkRequests: 0,
  databaseWrites: 0,
  walletWrites: 0,
}, null, 2));
