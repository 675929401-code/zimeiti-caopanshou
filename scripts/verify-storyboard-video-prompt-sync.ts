import assert from "node:assert/strict";
// @ts-expect-error Node 24 native TypeScript execution requires the explicit extension; this verifier is not bundled.
import { buildStoryboardVideoPrompt, inferStoryboardNarration, narrationCharacterCount } from "../src/lib/storyboard-single-frame-video-prompt.ts";

const narration = "现在审美都不知道怎么回事，都喜欢胖的。俯视看它是凹凸有致的。";
const prompt = buildStoryboardVideoPrompt({
  prompt: "  一只小狗在跳disco。  ",
  duration: 10,
  narration,
});

assert.equal(prompt, "一只小狗在跳disco。");
assert.ok(!prompt.includes(narration));
assert.doesNotMatch(prompt, /成片固定|兽医|听诊器|健康检查|暖芥末黄|蓝色牛仔裤|故事板格|负向提示/u);
assert.equal(inferStoryboardNarration(`第2段｜${narration}`), narration);
assert.equal(narrationCharacterCount("狗 狗\n瘦"), 3);
assert.equal(narrationCharacterCount("狗？“瘦！”2026"), 6);

console.log(JSON.stringify({
  passed: true,
  providerPrompt: prompt,
  exactUserPromptForwarding: true,
  narrationExcludedFromVideoSubmission: true,
  hiddenProjectPromptRemoved: true,
}, null, 2));
