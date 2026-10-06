import assert from "node:assert/strict";
import { compileStoryboard, createDefaultCanvasPromptPresetStore } from "../src/lib/canvas-prompt-presets";

const testScript = "一只圆滚滚的橘猫站在软垫旁，大家都觉得它胖得可爱，可它刚伸懒腰，背就弓得很紧，肚子旁像压着一团沉沉的负担。它看着只剩一半的食盆，鼻尖靠近又停住，眼神从馋变成迟疑。下一秒，手机镜头把它拍得像表情包，爱心和笑脸都围着它转，可腹部那圈淡淡的警示光越来越明显。夜里它开始拒食和呕吐，蜷在宠物医院的诊疗垫上，旁边未动的食盆和抽象生命曲线一起亮起。最后画面停在它疲惫却信任的眼神上，所谓可爱，可能正在透支它的健康。";

const preset = createDefaultCanvasPromptPresetStore().presets.find((item) => item.id === "anime_story");
assert.ok(preset, "缺少 anime_story preset");

const compiled = compileStoryboard({
  script: testScript,
  style: "皮克斯质感3D动漫，柔和电影光，角色表演夸张但可爱，非文字语义包装清楚",
  ratio: "16:9",
  productionMode: "anime-story",
  keyframeStrategy: "visual-anchor",
  effectsLevel: "rich",
  preset,
});

const decoratedShots = compiled.shots.filter((shot) => (
  shot.visualMode !== "narrative"
  && /【图形特效】(?!无)/u.test(shot.effectsPrompt)
));
const disconnectedShots = compiled.shots.filter((shot) => (
  /【语义重点】|【剧情表演】|【图形特效】|视频仅做|优先执行/u.test(shot.imagePrompt)
  || /上游|节点|系统生成|不得绕过|执行层|生成协议|【入镜】|【主动作】/u.test(shot.videoPrompt)
  || !/随后/u.test(shot.videoPrompt)
  || !/镜头/u.test(shot.videoPrompt)
  || !/最后/u.test(shot.videoPrompt)
));
const missingDecorationShots = decoratedShots.filter((shot) => {
  const effect = shot.effectsPrompt.match(/【图形特效】([^【\r\n]+)/u)?.[1]?.trim() || "";
  return !effect || !shot.imagePrompt.includes(effect) || !shot.videoPrompt.includes(effect);
});

assert.ok(compiled.shots.length >= 4, `镜头数不足：${compiled.shots.length}`);
assert.ok(decoratedShots.length >= 3, `语义包装镜头不足：${decoratedShots.length}`);
assert.equal(disconnectedShots.length, 0, `存在未完整接入语义包装链路的镜头：${disconnectedShots.map((shot) => shot.order).join(", ")}`);
assert.equal(missingDecorationShots.length, 0, `图视频未共享同一语义包装：${missingDecorationShots.map((shot) => shot.order).join(", ")}`);

console.log(JSON.stringify({
  shots: compiled.shots.length,
  decorated: decoratedShots.length,
  modes: compiled.shots.map((shot) => ({
    order: shot.order,
    mode: shot.visualMode,
    graphicEffect: shot.effectsPrompt.match(/【图形特效】([^【\r\n]+)/u)?.[1]?.trim() || "",
  })),
}, null, 2));
