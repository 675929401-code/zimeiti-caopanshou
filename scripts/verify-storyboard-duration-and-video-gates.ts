import assert from "node:assert/strict";
import {
  parseExplicitStoryboardSegments,
  validateStoryboardNarrationCapacity,
} from "../src/lib/storyboard-duration-contract";
import { storyboardVideoPromptViolation } from "../src/lib/storyboard-single-frame-video-prompt";

const explicit = parseExplicitStoryboardSegments(
  "1.【幼犬刚到家，先观察环境。】\n2、第二段保留原有标点，不能被重新拼接。",
);
assert.deepEqual(explicit, [
  "幼犬刚到家，先观察环境。",
  "第二段保留原有标点，不能被重新拼接。",
]);
assert.equal(parseExplicitStoryboardSegments("没有编号的连续口播"), null);
assert.equal(validateStoryboardNarrationCapacity("一".repeat(48), 8).ok, true);
assert.equal(validateStoryboardNarrationCapacity("一".repeat(49), 8).ok, false);

assert.match(
  storyboardVideoPromptViolation("请从故事板第一格裁切后生成视频" ) || "",
  /完整四宫格或五宫格/u,
);
assert.match(
  storyboardVideoPromptViolation("人物说话并加入字幕和音乐") || "",
  /无对白/u,
);
assert.equal(
  storyboardVideoPromptViolation("完整五宫格单图作为唯一参考，不裁切不拆格；只保留环境声和动作音。"),
  null,
);

console.log(JSON.stringify({
  ok: true,
  tests: 7,
  contract: "explicit-numbered-segment-preservation; pre-submit-single-board-audio-gate",
}, null, 2));
