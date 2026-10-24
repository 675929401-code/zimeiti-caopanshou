import assert from "node:assert/strict";
import { storyboardVideoPromptViolation } from "../src/lib/storyboard-single-frame-video-prompt";

const negativeLists = [
  "No dialogue, narration, or music.",
  "全程禁止开口说话",
  "人物和宠物不说话",
  "全程禁止对白、旁白和口型说话。只保留脚步与衣物摩擦声。",
  "禁止旁白、对白、字幕、音乐和配音。",
  "无对白、无旁白、无字幕、无音乐。",
  "不得角色说话或配音；保留现场动作声。",
  "没有对白、背景音乐及旁白。",
  "No dialogue, narration or music. Keep footsteps.",
  "without voice-over, dialogue and music; ambient sound only.",
  "No dialogue, no narration, no music.",
  "完整四宫格为唯一参考，不裁切不拆格；全程禁止对白、旁白和口型说话。",
];
const positiveInstructions = [
  "不要禁止旁白。",
  "不得不说话。",
  "并非不说话。",
  "不能不说话。",
  "人物不说话，旁白解释故事。",
  "旁白解释故事。", "角色说话。", "全程禁止对白、旁白和口型说话。最后加入音乐。",
  "禁止旁白，但角色说话。", "无音乐，旁白解释故事。", "No music, narration explains the scene.",
  "No dialogue, then music starts.", "禁止旁白；随后配音解释。", "允许角色说话，不含音乐。",
  "不禁止旁白。", "未禁止音乐。", "No dialogue. Music plays softly.",
  "全程禁止对白、旁白和口型说话；加入字幕。",
];
for (const prompt of negativeLists) assert.equal(storyboardVideoPromptViolation(prompt), null, prompt);
for (const prompt of positiveInstructions) assert.match(storyboardVideoPromptViolation(prompt) || "", /只能使用无对白/u, prompt);
assert.match(storyboardVideoPromptViolation("请从第一格裁切后生成视频") || "", /不能要求裁切/u);
assert.match(storyboardVideoPromptViolation("") || "", /请先粘贴/u);
console.log(JSON.stringify({ passed: true, negativeLists: negativeLists.length, positiveInstructions: positiveInstructions.length, zeroNetwork: true }));
