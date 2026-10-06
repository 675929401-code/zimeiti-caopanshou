import assert from "node:assert/strict";
import { countReadableCharacters } from "../src/lib/canvas-prompt-presets";
import {
  extractPromptDurationSeconds,
  extractVideoPromptTimeRanges,
} from "../src/lib/video-prompt-timing";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const phone = process.env.CANVAS_TEST_PHONE;
const password = process.env.CANVAS_TEST_PASSWORD;

assert.ok(phone && password, "请通过 CANVAS_TEST_PHONE 和 CANVAS_TEST_PASSWORD 提供测试账号");

const script = "其实这些看起来很小的动作会让狗狗难过很久。相信很多的主人都做过这样的事。急着出门时怕狗狗跟出来，就掏出一颗小零食往屋里扔进去，再趁他开心的跑过去吃的功夫，迅速关上房门离开。虽然这些举动在我们看来只是一个高效的脱身小技巧。但狗狗会把这理解成交易。它们的逻辑很简单：我吃零食，主人就走了。久而久之，狗狗开始害怕零食了。你会发现，下次你拿零食时，狗狗会犹豫，想要又不敢要。因为在它心里，吃零食就等于失去你。这时候狗狗就开始胡思乱想了。它会想：是不是我不够乖？主人才要把我支开？是不是我做错什么了？这种想法一旦开始，狗狗就变得特别敏感。你收拾包包，它紧张。你换鞋子，它焦虑。甚至你只是起身去厨房，它都要跟着，生怕你又消失。还有个更残酷的事实。狗狗的时间感和我们完全不同。你出门两小时，对它来说可能是一整天。它不知道你什么时候回来，甚至不知道你还会不会回来。所以你回家时，狗狗那种激动不只是开心。更多的是劫后余生的庆幸。如果这时你因为累了就冷淡它，狗狗又开始自我怀疑了。它会想：是不是我太吵了？是不是我不应该这么激动？慢慢地，狗狗就失去了那份纯真的快乐。变得小心翼翼，唯唯诺诺。所以下次出门，试试直接和狗狗告别。给它个拥抱，告诉它你会回来。虽然它听不懂话，但能感受到你的真心。你家狗狗有没有出现过这些“讨好型”行为？评论区聊聊吧！";

async function main() {
const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 Canvas verification" },
  body: JSON.stringify({ phone, password }),
});
const login = await loginResponse.json() as { token?: string; error?: string };
assert.ok(loginResponse.ok && login.token, login.error || "测试账号登录失败");

const compileResponse = await fetch(`${baseUrl}/api/canvas/compile-script`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "Mozilla/5.0 Canvas verification",
    Authorization: `Bearer ${login.token}`,
  },
  body: JSON.stringify({
    script,
    presetId: "anime_story",
    style: "皮克斯3D动画，金毛，柔和电影光影",
    ratio: "16:9",
    referenceMode: "single",
    keyframeStrategy: "visual-anchor",
    effectsLevel: "rich",
    productionMode: "anime-story",
    assistantInstruction: "先分析全篇情绪与演绎方式；视觉强化只根据当前镜头语义决定，不为了装饰而装饰；角色不说话。",
  }),
});
const result = await compileResponse.json() as {
  error?: string;
  compiler: "ai" | "deterministic-fallback";
  consistencyPrompt: string;
  postProductionPlan: string;
  characterAssets: Array<{
    id: string;
    name: string;
    fixedAppearance: string;
    referencePrompt: string;
  }>;
  semanticSegments: Array<{ order: number; narration: string; durationSeconds: number; visualShotCount: number }>;
  shots: Array<{
    order: number;
    semanticOrder: number;
    semanticDurationSeconds: number;
    narration: string;
    durationSeconds: number;
    shotRole: string;
    transition: string;
    castIds: string[];
    visualBeat: string;
    keyframeMoment: string;
    effectsPrompt: string;
    imagePrompt: string;
    videoPrompt: string;
  }>;
};
assert.ok(compileResponse.ok, result.error || "画布拆镜接口失败");
assert.equal(result.semanticSegments.map((segment) => segment.narration).join(""), script, "接口返回的语义段必须逐字覆盖原文");
assert.ok(result.semanticSegments.every((segment) => countReadableCharacters(segment.narration) >= 12), "接口不应返回少于12字的碎片语义段");
assert.equal(result.shots.length, result.semanticSegments.length, "一段口播必须严格对应一个关键帧和一个视频");
assert.ok(result.shots.every((shot) => shot.durationSeconds >= 3 && shot.durationSeconds <= 5), "分镜必须保持3到5秒并保留剪辑冗余");
assert.ok(result.shots.every((shot) => shot.visualBeat.length >= 10 && shot.keyframeMoment.length >= 10), "每个视觉镜头必须有核心任务和关键帧判断");
assert.ok(result.consistencyPrompt.includes("角色锁定：") && result.consistencyPrompt.includes("环境锁定：") && result.consistencyPrompt.includes("视觉锁定："), "全片必须生成统一角色、环境和视觉设定");
assert.ok(result.characterAssets.length >= 1, "全文分析必须先生成至少一个结构化角色资产");
assert.equal(new Set(result.characterAssets.map((character) => character.id)).size, result.characterAssets.length, "角色ID必须唯一");
assert.ok(result.characterAssets.every((character) => (
  character.fixedAppearance.trim().length > 0
  && character.referencePrompt.includes("一张图只出现这一个角色")
  && character.referencePrompt.includes("不放入剧情场景")
)), "每张角色定妆图必须纯角色、单主体且不混入逐镜剧情");
const knownCharacterIds = new Set(result.characterAssets.map((character) => character.id));
assert.ok(result.shots.every((shot) => (
  shot.castIds.length >= 1
  && shot.castIds.length <= 4
  && new Set(shot.castIds).size === shot.castIds.length
  && shot.castIds.every((id) => knownCharacterIds.has(id))
)), "每镜只能绑定本镜实际出场且已存在的角色ID");
for (const segment of result.semanticSegments) {
  const segmentShots = result.shots.filter((shot) => shot.semanticOrder === segment.order);
  assert.equal(segmentShots.length, segment.visualShotCount, "口播段声明的视觉镜头数必须与镜头表一致");
  assert.equal(segmentShots.length, 1, "每个语义段只能生成一个视觉镜头");
  assert.equal(segmentShots[0].durationSeconds, segment.durationSeconds, "视频时长必须与对应口播分镜一致");
}
assert.match(result.postProductionPlan, /每个分镜只包含一段口播文案、一张自动关键帧和一个视频/, "后期方案必须写明一一对应关系");
assert.match(result.postProductionPlan, /分镜口播文案对照\.txt/, "批量下载必须附带后期配音对照文档");
assert.ok(result.shots.every((shot) => shot.imagePrompt.includes("必画语义证据（优先执行）：")), "每张动漫参考图必须先落实语义证据");
assert.ok(result.shots.every((shot) => shot.imagePrompt.includes(shot.effectsPrompt)), "生图提示词必须落实对应镜头的具体装饰方案");
assert.ok(result.shots.every((shot) => /【语义重点】[\s\S]*【剧情表演】[\s\S]*【叙事道具】[\s\S]*【环境反馈】[\s\S]*【图形特效】/u.test(shot.effectsPrompt)), "每镜必须完整保留五层语义证据，图形特效可以明确为无");
assert.ok(result.shots.every((shot) => !/(?:可加入|例如|自行选择|根据语义选择)/u.test(shot.effectsPrompt)), "语义强化不得返回候选清单或再次委托模型决定");
assert.ok(result.shots.every((shot) => shot.videoPrompt.includes("不说话、不做对白口型") && shot.videoPrompt.includes("没有背景音乐")), "视频提示词必须关闭口型、对白、字幕和背景音乐，只保留场景音");
assert.ok(result.shots.every((shot) => extractPromptDurationSeconds(shot.videoPrompt) === shot.durationSeconds), "视频提示词目标总时长必须与任务时长一致");
assert.ok(result.shots.every((shot) => {
  const ranges = extractVideoPromptTimeRanges(shot.videoPrompt);
  return ranges.length >= 3
    && ranges[0].start === 0
    && ranges.at(-1)?.end === shot.durationSeconds
    && ranges.every((range, index) => index === 0 || ranges[index - 1].end === range.start);
}), "视频提示词时间轴必须从0秒开始、连续且精确结束于目标时长");
assert.ok(result.shots.every((shot) => !shot.imagePrompt.includes("文案未提及的新事件")), "旧版过强负面约束必须自动升级");
assert.ok(result.shots.every((shot) => !shot.videoPrompt.includes("给剪辑和字幕留出")), "提示词不应再要求字幕区域");

console.table(result.shots.map((shot) => ({
  shot: shot.order,
  segment: shot.semanticOrder,
  seconds: shot.durationSeconds,
  keyframe: shot.keyframeMoment,
})));
console.log(`Canvas API verification passed: compiler=${result.compiler}, semanticSegments=${result.semanticSegments.length}, visualShots=${result.shots.length}.`);
}

void main();
