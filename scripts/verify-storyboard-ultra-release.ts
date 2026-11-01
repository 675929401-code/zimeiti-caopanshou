import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StoryboardProjectSchema } from "../src/lib/storyboard-workbench";
import { STORYBOARD_HIGH_ENERGY_ULTRA_PROMPT_SHA256 } from "../src/lib/server/storyboard-director-runtime-policy";

const high = readFileSync("prompts/storyboard-high-energy-assets-order-B-ultra-release.md", "utf8");
const compiler = readFileSync("prompts/storyboard-workbench-assets-order-compiler-ultra-release.md", "utf8");
const checks: string[] = [];
function check(name: string, result: boolean) { assert.ok(result, name); checks.push(name); }
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
check("tested high-energy prompt preserved", sha(high.trim()) === STORYBOARD_HIGH_ENERGY_ULTRA_PROMPT_SHA256);
check("compiler save limit", compiler.length >= 100 && compiler.length <= 50000);
check("compiler never emits code fences", !compiler.includes("```"));
for (const text of ["storyboard-director-v2.6.0", "不输出Markdown", "beats与故事板面板一一对应", "8秒3镜", "10秒3至4镜", "15秒4至6镜", "固定时间不可偷换固定地点", "全程不说话", "无声连续说话口型", "visualAssetRefs全部为空", "不裁首格、不拆格", "visual-only", "advanced-text-layout"]) {
  check(`compiler required contract ${text}`, compiler.includes(text));
}
const exampleStart = compiler.indexOf('\n{\n  "version":');
const exampleEnd = compiler.lastIndexOf("\n}");
check("exactly one JSON output example", exampleStart > 0 && exampleEnd > exampleStart);
const example = JSON.parse(compiler.slice(exampleStart + 1, exampleEnd + 2));
const expectedTop = ["version", "title", "styleBible", "characterBible", "environmentBible", "visualAssetPlan", "segments"];
check("compatible top-level keys", JSON.stringify(Object.keys(example)) === JSON.stringify(expectedTop));
check("image field before beats", Object.keys(example.segments[0]).indexOf("storyboardImagePrompt") < Object.keys(example.segments[0]).indexOf("beats"));
for (const duration of [8, 10, 15]) for (const panels of [4, 5]) {
  const fixture = structuredClone(example);
  fixture.styleBible = "统一圆润商业动画三维风格与细腻布料毛发、温暖室内光线。";
  fixture.characterBible = "年轻女主人与三色柯基，衣着毛色身份全篇一致。";
  fixture.environmentBible = "固定家庭客厅，沙发与笼子保持相对位置。";
  const segment = fixture.segments[0];
  segment.durationSeconds = duration;
  segment.storyboardImagePrompt = "统一商业三维风格，一张完整故事板；".repeat(12);
  segment.beats = Array.from({ length: panels }, (_, i) => ({ ...segment.beats[0], order: i + 1,
    visual: "同一女主人与自然四足柯基在客厅的清楚动作峰值。", videoPrompt: "摄像机在场景内部跟随主体自然动作，保持身份、空间与物体状态连续。".repeat(2) }));
  check(`existing schema accepts ${duration}s ${panels}panel adapter structure`, StoryboardProjectSchema.safeParse(fixture).success);
}
console.log(JSON.stringify({ passed: true, checks: checks.length, highEnergyTrimSha256: sha(high.trim()), highEnergyRawSha256: sha(high),
  compilerTrimSha256: sha(compiler.trim()), compilerRawSha256: sha(compiler), compilerCharacters: compiler.length,
  scope: "static adapter contracts and generated schema fixtures only", realCompilerModelTested: false, providerCalls: 0, checksDetail: checks }, null, 2));
