import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "../运行日志/三视觉资产十秒闭环-20261019/benchmark-research-20261020");
const sourceDir = resolve(root, "prompt-candidates-v1");
const outputDir = resolve(root, "prompt-candidates-v2");
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const highOverride = `

# v2最终硬覆盖：文字、首轮资产与高能路由（优先级高于本文件前文）
1. 画内文字只有一个受控例外：故事板每格可在结构字段中记录英文注释“Frame N: 4-8 words”，但该注释属于工作台/后期 metadata，不进入图片模型画面；生图画面和视频画面不得出现中文、汉字、英文句子、数字、字幕、标题、说明条、品牌、招牌、Logo、水印或伪文字。用户需要重点摘要时，只写入 metadata 或后期排版安全区，不能要求图片模型自行绘字。
2. 首轮视觉资产的 requiredAssetIds 只能包含本项目实际存在的人物 identity reference 和宠物 identity reference；没有人物或宠物时可以为空，不能用环境图替代身份资产。所有 environment/background/scene/prop refs 进入 initialDeferredAssetIds，environmentAnchorPolicy 固定为 deferred_until_scene_need；只有 sceneId、sceneZone、地点结构、时间光线或关键机位证明确有连续空间需要时，才按该场景追加一张环境锚点，室内与户外分开，不能把一张背景图绑定全片。maxInitialImages 必须等于本轮实际 required 数量。
3. 高能版只执行本段有文案依据的 2至3 个强视觉事件和 1至2 次有动机冲击；包装最多一个主包装和一个接力包装，功能色按语义选择。任何前文出现的“每段固定爆点/固定三事件/固定红黑到金绿/必须中文语义牌”均视为失效。
4. 输出前必须逐条回读：directorMode=high_energy；required 角色集合不含 environment；每段有 sceneId/sceneZone、styleLock、sceneLock、生图提示词、视频提示词、八项 qualityChecks；qualityScore>=90 且 qualityVerdict=pass 才允许进入媒体生成。
`;
const narrativeOverride = `

# v2最终硬覆盖：叙事版反高能路由与首轮资产（优先级高于本文件前文）
1. directorMode 固定为 narrative。不得继承高能版的“每段至少3个强视觉事件、2次镜头冲击、25-40%英雄包装、红黑/红橙到金/绿转化、强制表情定格或强制爆点”。10秒通常3个真实镜头，15秒3至5个，允许观察和停留。
2. 先建立同一空间中的视线、距离、触碰、等待、呼吸、耳朵、尾巴和道具状态，再让一个主要行为改变关系；每镜最多一个主动作和一个回应。包装通常为0至1个，必须有语义缺口、现实来源和结束状态；颜色服从场景、时间和情绪，不固定警示色到解决色。结尾优先保护、理解、陪伴、行动或安静余韵。
3. 首轮视觉资产的 requiredAssetIds 只能包含本项目实际存在的人物 identity reference 和宠物 identity reference；没有人物或宠物时可以为空，不能用环境图替代身份资产。所有 environment/background/scene/prop refs 进入 initialDeferredAssetIds，environmentAnchorPolicy 固定为 deferred_until_scene_need；只有 sceneId、sceneZone、地点结构、时间光线或关键机位证明确有连续空间需要时，才按该场景追加一张环境锚点，室内与户外分开，不能把一张背景图绑定全片。maxInitialImages 必须等于本轮实际 required 数量。
4. 纯画面模式下图片和视频都不得出现中文、汉字、英文句子、数字、字幕、标题、说明条、品牌、招牌、Logo、水印或伪文字；Frame 注释只保留在 JSON/工作台 metadata。输出前必须逐条回读：directorMode=narrative；required 角色集合不含 environment；每段有 sceneId/sceneZone、styleLock、sceneLock、生图提示词、视频提示词、八项 qualityChecks；qualityScore>=90 且 qualityVerdict=pass 才允许进入媒体生成。
`;

await mkdir(outputDir, { recursive: true });
const outputs = {};
for (const [name, suffix] of [["high-energy-prompt.txt", highOverride], ["narrative-prompt.txt", narrativeOverride]]) {
  const base = await readFile(resolve(sourceDir, name), "utf8");
  const output = `${base.trimEnd()}${suffix}\n`;
  outputs[name] = { sourceSha256: sha256(base), candidateSha256: sha256(output), sourceLength: base.length, candidateLength: output.length };
  await writeFile(resolve(outputDir, name), output, "utf8");
}
const staticChecks = {
  schemaVersion: "storyboard_prompt_candidates_v2_static_qa.v1",
  generatedAt: new Date().toISOString(),
  source: "prompt-candidates-v1-active-readback",
  hashes: outputs,
  checks: {
    hashesDistinct: outputs["high-energy-prompt.txt"].candidateSha256 !== outputs["narrative-prompt.txt"].candidateSha256,
    highTextOnlyRule: (await readFile(resolve(outputDir, "high-energy-prompt.txt"), "utf8")).includes("画内文字只有一个受控例外") && !(await readFile(resolve(outputDir, "high-energy-prompt.txt"), "utf8")).includes("画内中文语义牌按需要"),
    highDeferredAssets: (await readFile(resolve(outputDir, "high-energy-prompt.txt"), "utf8")).includes("environmentAnchorPolicy 固定为 deferred_until_scene_need"),
    narrativeAntiHighEnergy: (await readFile(resolve(outputDir, "narrative-prompt.txt"), "utf8")).includes("不得继承高能版") && (await readFile(resolve(outputDir, "narrative-prompt.txt"), "utf8")).includes("directorMode 固定为 narrative"),
    narrativeDeferredAssets: (await readFile(resolve(outputDir, "narrative-prompt.txt"), "utf8")).includes("environmentAnchorPolicy 固定为 deferred_until_scene_need"),
    bothQualityGates: (await readFile(resolve(outputDir, "high-energy-prompt.txt"), "utf8")).includes("qualityScore>=90") && (await readFile(resolve(outputDir, "narrative-prompt.txt"), "utf8")).includes("qualityScore>=90"),
  },
};
staticChecks.passed = Object.values(staticChecks.checks).every(Boolean);
await writeFile(resolve(outputDir, "static-qa-v2.json"), `${JSON.stringify(staticChecks, null, 2)}\n`, "utf8");
await writeFile(resolve(outputDir, "manifest-v2.json"), `${JSON.stringify({ schemaVersion: "storyboard_prompt_candidates_v2_manifest.v1", generatedAt: staticChecks.generatedAt, files: outputs, activation: "pending_cas_readback_and_real_text_canary" }, null, 2)}\n`, "utf8");
console.log(JSON.stringify(staticChecks, null, 2));
if (!staticChecks.passed) process.exitCode = 2;
