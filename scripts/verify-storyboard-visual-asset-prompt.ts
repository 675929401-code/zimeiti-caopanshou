import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildVisualAssetPrompt } from "../src/lib/storyboard-visual-asset-prompt";

const cases = [
  { role: "character" as const, body: "单人全身三分之四正面，自然站姿；海军蓝开衫、奶油白衬衫、卡其长裤。" },
  { role: "pet" as const, body: "单犬四足自然站立，三分之四侧面；深绿色胸背，不增加项圈。" },
  { role: "character" as const, body: "正面、左侧面、背面三视图同图；同一人物同一套服装。" },
  { role: "pet" as const, body: "近景侧脸，保留左耳缺口；不画全身。" },
  { role: "character" as const, body: "  Character sheet with two views: front and profile.\nKeep the seated pose.  " },
  { role: "pet" as const, body: "蜂蜜金长毛成年犬，深绿胸背。" },
];
for (const { role, body } of cases) {
  const prompt = buildVisualAssetPrompt(role, body);
  const [wrapper, ...description] = prompt.split("\n用户补充的固定资产描述：");
  assert.equal(description.join("\n用户补充的固定资产描述："), body, "view, pose and outfit instructions must survive verbatim");
  assert.ok(wrapper.includes("以以下资产描述的明确要求为准"), "explicit composition has precedence");
  assert.ok(wrapper.includes("指定单视角时只生成该单视角"), "single-view requests must not receive mandatory turnaround");
  assert.ok(wrapper.includes("只有未指定视角或排版时"), "multi-view fallback must be conditional");
  assert.ok(wrapper.includes("每次生成一张参考图"), "a turnaround is still one asset image");
  assert.ok(!wrapper.includes("无动作剧情"), "the wrapper must not negate requested reference poses");
}

for (const role of ["environment", "prop"] as const) {
  const prompt = buildVisualAssetPrompt(role, "保留用户的空间或物体描述。");
  assert.ok(prompt.endsWith("用户补充的固定资产描述：保留用户的空间或物体描述。"));
  assert.ok(!prompt.includes("只有未指定视角或排版时"), "identity-only fallback must not change environment/prop rules");
}
assert.ok(buildVisualAssetPrompt("environment", "").includes("不把多角度拼在同一张图里"));
assert.ok(buildVisualAssetPrompt("prop", "").includes("关键细节多角度展示"));

const workbench = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
assert.ok(workbench.includes('import { buildVisualAssetPrompt } from "@/lib/storyboard-visual-asset-prompt"'));
assert.ok(workbench.includes("buildVisualAssetPrompt(input.role, input.prompt.trim())"), "real generation must consume the shared compiler");
assert.ok(!workbench.includes("function buildVisualAssetPrompt("), "the UI must not retain a conflicting local compiler");
assert.equal(workbench.match(/subtitle="身份参考生成 · 分类角色库"/gu)?.length, 2);
assert.ok(!workbench.includes('subtitle="三视图生成 · 分类角色库"'));
console.log("PASS: identity composition precedence, untouched user descriptions, one-image semantics, environment/prop regression and real UI compiler wiring.");
