import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cropDimensionsForAspectRatio,
  imageDimensionsMatchAspectRatio,
  imagePixelSizeFor,
  validateImageOutputContract,
} from "../src/lib/image-output-contract";
import { buildSecureSkillImagePayload } from "../src/lib/secure-skill-image-adapter";
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
assert.match(imageRoute, /expectedPixelSize: expectedImagePixelSize/u);
assert.match(imageRoute, /coverText: exactCoverText/u);
assert.match(imageRoute, /billed:\s*false/u);

assert.match(historyRoute, /WORKBENCH_VIDEO_HISTORY_RETENTION_DAYS\s*=\s*3/u);
assert.match(historyRoute, /\.eq\("user_id", userId\)/u);
assert.match(historyRoute, /task_label\.like\.分镜工作台%/u);
assert.match(historyRoute, /\.gte\("created_at", historyCutoff\)/u);
assert.match(historyRoute, /const terminalStatuses = \["completed", "failed", "cancelled", "expired"\]/u);
assert.match(historyRoute, /\.in\("status", \["pending", "queued", "processing", "generating", "finalizing", "billing_pending"\]\)/u);
assert.match(historyRoute, /createVideoAccessUrl/u);
assert.match(historyRoute, /scope:\s*"thumbnail"/u);
assert.match(thumbnailRoute, /authorizeVideoMediaRequest\(request, taskId, "thumbnail"\)/u);
assert.match(thumbnailRoute, /task\.user_id !== user\.userId && user\.role !== "admin"/u);
assert.match(thumbnailRoute, /extractVideoThumbnail/u);
assert.match(thumbnailRoute, /status[^\n]*completed/u);
assert.match(accountHistorySource, /const visibleTasks = tasks/u);
assert.match(accountHistorySource, /retentionDays=\{retainedWorkbenchHistory \? 3 : undefined\}/u);

assert.match(videoModelsRoute, /secure_skill_doubao_seedance"\) return new Set\(\["720p"\]\)/u);
assert.match(videoModelsRoute, /secure_skill_enterprise_video" && modelName === "seedance-2\.5"\) return new Set\(\["720p"\]\)/u);
assert.match(videoModelsRoute, /secure_skill_seedance_video"\) return new Set\(\["480p", "720p"\]\)/u);
assert.match(storyboardSource, /imageExactText/u);
assert.match(storyboardSource, /sbw-progress-track/u);
assert.match(storyboardSource, /实际图片[^`]+与 \$\{requestSnapshot\.aspectRatio\} 不一致/u);

console.log(JSON.stringify({
  result: "PASS",
  paidGenerationRequests: 0,
  imageOutputContract: true,
  secureSkillResolutionTier: true,
  nestedVideoProgress: true,
  storyboardHistoryRetentionDays: 3,
  storyboardHistoryUserIsolation: true,
  storyboardVideoThumbnail: "owner-scoped frame extraction",
  adapterResolutionAllowlist: true,
  exactTextComposition: true,
}, null, 2));
