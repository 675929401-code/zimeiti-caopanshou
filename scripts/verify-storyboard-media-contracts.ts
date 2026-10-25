import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cropDimensionsForAspectRatio,
  imageDimensionsMatchAspectRatio,
  imagePixelSizeFor,
  validateImageOutputContract,
} from "../src/lib/image-output-contract";
import {
  buildSecureSkillImagePayload,
  SECURE_SKILL_GPT25_SYNC_V2_CONTRACT,
} from "../src/lib/secure-skill-image-adapter";
import { extractVideoTaskProgress } from "../src/lib/video-adapter";

assert.equal(imagePixelSizeFor("4K", "16:9"), "4096x2304");
assert.equal(imageDimensionsMatchAspectRatio(1376, 768, "16:9"), true);
assert.equal(imageDimensionsMatchAspectRatio(1024, 1024, "16:9"), false);
assert.deepEqual(cropDimensionsForAspectRatio(512, 512, "16:9"), { width: 512, height: 288 });

assert.equal(validateImageOutputContract({
  width: 4096,
  height: 2304,
  aspectRatio: "16:9",
  resolution: "4K",
}), null);
assert.equal(validateImageOutputContract({
  width: 1024,
  height: 1024,
  aspectRatio: "16:9",
  resolution: "1K",
})?.code, "IMAGE_OUTPUT_ASPECT_RATIO_MISMATCH");
assert.equal(validateImageOutputContract({
  width: 640,
  height: 360,
  aspectRatio: "16:9",
  resolution: "4K",
})?.code, "IMAGE_OUTPUT_RESOLUTION_MISMATCH");

const securePayload = buildSecureSkillImagePayload({
  modelName: "gpt-image-2",
  prompt: "contract verification only",
  resolution: "4K",
  aspectRatio: "16:9",
  referenceImageUrls: ["https://example.com/reference.png"],
});
assert.equal(securePayload.model, "gpt-image-2");
assert.equal(securePayload.image_size, "4K");
assert.equal(securePayload.aspect_ratio, "16:9");
assert.equal("size" in securePayload, false);
assert.deepEqual(securePayload.image, ["https://example.com/reference.png"]);

// GPT Image 2.5 Sunburst/Flare use the explicit v2 provider contract. Keep
// this fixture local and deterministic: it guards the request shape without
// contacting a paid provider. In particular, resolution and aspect_ratio are
// independent fields; the legacy image_size/size fields must not be sent.
const secureGpt25V2Payload = buildSecureSkillImagePayload({
  modelName: "gpt-image-2.5-sunburst",
  prompt: "contract verification only",
  resolution: "2K",
  aspectRatio: "16:9",
  quality: "high",
  providerContract: SECURE_SKILL_GPT25_SYNC_V2_CONTRACT,
  referenceImageUrls: ["https://example.com/reference.png"],
});
assert.equal(secureGpt25V2Payload.model, "gpt-image-2.5-sunburst");
assert.equal(secureGpt25V2Payload.resolution, "2K");
assert.equal(secureGpt25V2Payload.aspect_ratio, "16:9");
assert.equal(secureGpt25V2Payload.quality, "high");
assert.equal(secureGpt25V2Payload.size, undefined);
assert.equal(secureGpt25V2Payload.image_size, undefined);
assert.deepEqual(secureGpt25V2Payload.image, ["https://example.com/reference.png"]);

assert.equal(extractVideoTaskProgress({ progress: 25 }), 25);
assert.equal(extractVideoTaskProgress({ data: { task: { progress: "57%" } } }), 57);
assert.equal(extractVideoTaskProgress({ metadata: { progress: 0.42 } }), 0.42);
assert.equal(extractVideoTaskProgress({ data: { state: "running" } }), null);

const imageRoute = readFileSync("src/app/api/image/generate/route.ts", "utf8");
const historyRoute = readFileSync("src/app/api/video/history/route.ts", "utf8");
const thumbnailRoute = readFileSync("src/app/api/video/thumbnail/[taskId]/route.ts", "utf8");
const videoModelsRoute = readFileSync("src/app/api/video/models/route.ts", "utf8");
const storyboardSource = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
const accountHistorySource = readFileSync("src/components/account-video-history.tsx", "utf8");

assert.match(imageRoute, /validateImageOutputContract/u);
assert.match(imageRoute, /const deliveryOutputContract = \(selectedModelId: string\) =>/u);
assert.match(imageRoute, /expectedPixelSize:\s*frozenTarget \|\| outputPixelSize/u);
assert.match(imageRoute, /prepareGeneratedImageBytes\([\s\S]{0,260}deliveryOutputContract\(result\.selectedModelId\)/u);
assert.match(imageRoute, /coverText: exactCoverText/u);
assert.match(imageRoute, /billed:\s*false/u);

assert.match(historyRoute, /\.eq\("user_id", userId\)/u);
assert.match(historyRoute, /task_label\.like\.分镜工作台%/u);
assert.match(historyRoute, /\.is\("source_expired_at", null\)/u);
assert.match(historyRoute, /const terminalStatuses = \["completed", "failed", "cancelled", "expired"\]/u);
assert.match(historyRoute, /\.in\("status", \["pending", "queued", "processing", "generating", "finalizing", "billing_pending"\]\)/u);
assert.match(historyRoute, /createVideoAccessUrl/u);
assert.match(historyRoute, /scope:\s*"thumbnail"/u);
assert.match(thumbnailRoute, /authorizeVideoMediaRequest\(request, taskId, "thumbnail"\)/u);
assert.match(thumbnailRoute, /authorizeMemberContentAccess/u);
assert.match(thumbnailRoute, /authorizeMemberContentDiscovery/u);
assert.match(thumbnailRoute, /task = await findTask\(false\)/u);
assert.match(thumbnailRoute, /extractVideoThumbnail/u);
assert.match(thumbnailRoute, /status[^\n]*completed/u);
assert.match(accountHistorySource, /const visibleTasks = tasks/u);
assert.doesNotMatch(accountHistorySource, /retentionDays/u);

assert.match(videoModelsRoute, /secure_skill_doubao_seedance"\) return new Set\(\["720p"\]\)/u);
assert.match(videoModelsRoute, /secure_skill_enterprise_video" && modelName === "seedance-2\.5"\) return new Set\(\["720p"\]\)/u);
assert.match(videoModelsRoute, /secure_skill_seedance_video"\) return new Set\(\["480p", "720p"\]\)/u);
assert.match(storyboardSource, /imageExactText/u);
assert.match(storyboardSource, /imageTextLayoutEnabled/u);
assert.match(storyboardSource, /function hasValidatedImage\(card: WorkbenchCard\) \{[\s\S]{0,220}card\.imageStatus === "done"[\s\S]{0,220}card\.imageValidatedAt/u);
assert.match(storyboardSource, /if \(!card \|\| !hasValidatedImage\(card\)\) \{ setNotice\("故事板图片尚未真实加载，视频仍处于锁定状态"\); return null; \}/u);
assert.match(storyboardSource, /if \(card\.imageReferenceState === "stale" \|\| !hasValidatedImage\(card\)\) \{ setNotice\("请先生成并加载当前参考对应的分镜图；本次未提交。"\); return null; \}/u);
assert.match(storyboardSource, /imageDimensionsMatchAspectRatio\(card\.imageWidth, card\.imageHeight, generatedRatio\)/u);
assert.ok(/function createCard[\s\S]{0,2000}imageTextLayoutEnabled:\s*false/u.test(storyboardSource), "New storyboard cards must opt out of exact-text composition by default");
assert.match(storyboardSource, /\.\.\.\(requestSnapshot\.exactText \? \{ coverText: requestSnapshot\.exactText \} : \{\}\)/u);
assert.doesNotMatch(storyboardSource, /coverText:\s*requestSnapshot\.exactText\s*\|\|\s*""/u);
assert.match(storyboardSource, /实际图片[^`]+与 \$\{requestSnapshot\.aspectRatio\} 不一致/u);

console.log(JSON.stringify({
  result: "PASS",
  paidGenerationRequests: 0,
  imageOutputContract: true,
  secureSkillResolutionTier: true,
  storyboardHistoryRetention: "upstream-source-validity",
  storyboardHistoryUserIsolation: true,
  storyboardVideoThumbnail: "owner-scoped frame extraction",
  adapterResolutionAllowlist: true,
  secureSkillGpt25V2Transport: true,
  squareOutputToWideRequest: "rejected-before-delivery-and-not-billed",
  storyboardVideoSubmitRequiresValidatedImage: true,
  exactTextComposition: "explicit-opt-in",
}, null, 2));
