import assert from "node:assert/strict";
import { parseStoryboardIdleDraft, serializeStoryboardIdleDraft } from "../src/lib/storyboard-idle-draft";

const raw = serializeStoryboardIdleDraft({
  id: "storyboard-run-safe-001",
  createdAt: 100,
  title: "未命名分镜项目",
  ratio: "16:9",
  imageResolution: "2K",
  videoResolution: "1080p",
  videoDuration: 10,
  imageModelId: "image-model-a",
  videoModelId: "video-model-a",
  cards: [{
    id: "shot-safe-001", order: 1, label: "镜头 1", narration: "旁白",
    imagePrompt: "生图提示词", imageExactText: "", videoPrompt: "视频提示词", referenceCount: 2,
  }],
}, 200);
assert.ok(raw);
const restored = parseStoryboardIdleDraft(raw);
assert.equal(restored?.cards[0].imagePrompt, "生图提示词");
assert.equal(restored?.cards[0].referenceCount, 2);
assert.equal(JSON.stringify(restored).includes("referenceImageUrls"), false);
assert.equal(JSON.stringify(restored).includes("blob:"), false);
assert.equal(serializeStoryboardIdleDraft({
  id: "storyboard-run-empty", createdAt: 1, title: "未命名分镜项目", ratio: "16:9",
  imageResolution: "", videoResolution: "", videoDuration: 10, imageModelId: "", videoModelId: "",
  cards: [1, 2, 3].map((order) => ({ id: `shot-${order}`, order, label: "", narration: "", imagePrompt: "", imageExactText: "", videoPrompt: "", referenceCount: 0 })),
}), null);
assert.equal(parseStoryboardIdleDraft(JSON.stringify({ ...JSON.parse(raw!), ratio: "4:5" })), null);

console.log(JSON.stringify({ ok: true, promptRestored: true, referenceBodiesPersisted: 0, realNetworkCalls: 0, realDatabaseWrites: 0 }, null, 2));
