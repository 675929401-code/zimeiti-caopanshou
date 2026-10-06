import assert from "node:assert/strict";
import {
  auditStoryboardImagePrompt,
  compileStoryboard,
  composeStoryboardReferenceGenerationPrompt,
  countReadableCharacters,
  createDefaultCanvasPromptPresetStore,
  estimateStoryboardDuration,
  isAiStoryboardPlanUsable,
  normalizeStoryboardCharacterIdentities,
  normalizeStoryboardSegments,
  repairAiStoryboardPlanStaticPrompts,
} from "../src/lib/canvas-prompt-presets";
import { getImageModelCapabilities } from "../src/lib/image-model-capabilities";
import { DOG_SLEEP_WOMAN_INSTRUCTION, DOG_SLEEP_WOMAN_SCRIPT } from "../src/lib/canvas-demo-scripts";

const script = "其实这些看起来很小的动作会让狗狗难过很久。相信很多的主人都做过这样的事。急着出门时怕狗狗跟出来，就掏出一颗小零食往屋里扔进去，再趁他开心的跑过去吃的功夫，迅速关上房门离开。虽然这些举动在我们看来只是一个高效的脱身小技巧。但狗狗会把这理解成交易。它们的逻辑很简单：我吃零食，主人就走了。久而久之，狗狗开始害怕零食了。你会发现，下次你拿零食时，狗狗会犹豫，想要又不敢要。因为在它心里，吃零食就等于失去你。这时候狗狗就开始胡思乱想了。它会想：是不是我不够乖？主人才要把我支开？是不是我做错什么了？这种想法一旦开始，狗狗就变得特别敏感。你收拾包包，它紧张。你换鞋子，它焦虑。甚至你只是起身去厨房，它都要跟着，生怕你又消失。还有个更残酷的事实。狗狗的时间感和我们完全不同。你出门两小时，对它来说可能是一整天。它不知道你什么时候回来，甚至不知道你还会不会回来。所以你回家时，狗狗那种激动不只是开心。更多的是劫后余生的庆幸。如果这时你因为累了就冷淡它，狗狗又开始自我怀疑了。它会想：是不是我太吵了？是不是我不应该这么激动？慢慢地，狗狗就失去了那份纯真的快乐。变得小心翼翼，唯唯诺诺。所以下次出门，试试直接和狗狗告别。给它个拥抱，告诉它你会回来。虽然它听不懂话，但能感受到你的真心。你家狗狗有没有出现过这些“讨好型”行为？评论区聊聊吧！";

const segments = normalizeStoryboardSegments(script);
const compact = (value: string) => value.replace(/\s+/g, "");

assert.equal(compact(segments.map((item) => item.narration).join("")), compact(script), "口播语义段必须完整覆盖原文");
assert.ok(segments.length >= 10, "长文案不应被压缩成少量大段");
assert.ok(segments.every((item) => countReadableCharacters(item.narration) >= 10), "不应保留少于10个有效字的碎片口播段");
assert.ok(segments.every((item) => item.durationSeconds >= 3), "每个口播语义段必须至少3秒");
assert.ok(segments.every((item) => item.durationSeconds === estimateStoryboardDuration(item.narration)), "时长必须由实际口播字数重新计算");

const tinyAiOutput = script.match(/[^。！？!?]+[。！？!?]?/g)?.map((narration) => ({ narration, durationSeconds: 3 })) || [];
const normalizedTinyOutput = normalizeStoryboardSegments(script, tinyAiOutput);
assert.ok(normalizedTinyOutput.every((item) => countReadableCharacters(item.narration) >= 10), "系统必须自动合并大模型返回的碎短句");

const fallbackPreset = createDefaultCanvasPromptPresetStore().presets[0];
const fallbackStoryboard = compileStoryboard({
  script: "猫到底是胖点好还是瘦点好？答案是胖猫永远比瘦猫更危险。",
  style: "高品质迪士尼式3D动画",
  ratio: "16:9",
  productionMode: "anime-story",
  assistantInstruction: "保持同一只圆润橘白猫；允许问号和对比图，不要字幕。",
  preset: fallbackPreset,
});
const fallbackShot = fallbackStoryboard.shots[0];
assert.match(fallbackStoryboard.consistencyPrompt, /圆润橘白猫/, "备用拆镜必须锁定用户指定主体");
assert.match(fallbackShot.imagePrompt, /圆润橘白猫/, "备用参考图提示词必须锁定用户指定主体");
assert.doesNotMatch(fallbackShot.imagePrompt, /同一只|同一位|那个角色/, "生图提示词不得使用关系代词代替具体资产");
assert.match(fallbackShot.imagePrompt, /体型对比|健康体型|左右两个悬浮体型剪影/, "备用参考图提示词必须把对比语义变成可见画面");
assert.doesNotMatch(fallbackShot.visualBeat, /围绕本语义段设计|选择.*核心画面/, "备用拆镜不得输出泛化占位句");
assert.ok(countReadableCharacters(fallbackShot.keyframeMoment) >= 50, "备用关键帧描述不得少于50个有效字");
assert.match(fallbackShot.videoPrompt, /从参考图当前姿态(?:直接)?开始/, "视频提示词必须从对应关键帧直接进入动作");
assert.doesNotMatch(fallbackShot.videoPrompt, /系统自动|上游节点|自动开关键/, "视频提示词不得写成系统说明书");
assert.equal(fallbackStoryboard.shots.length, fallbackStoryboard.semanticSegments.length, "一段口播必须只对应一个视频");
assert.match(fallbackStoryboard.postProductionPlan, /一段口播文案、一张意图多格故事板参考图和一个视频/, "后期方案必须明确一一对应关系");

const multiCharacterFallbackStoryboard = compileStoryboard({
  script: "边牧拆家从来不拆明显的地方。女主人翻开沙发底部，才发现它悄悄挖了一个大洞。维修师傅随后上门补好沙发底布。",
  style: "电影级3D卡通动画",
  ratio: "16:9",
  productionMode: "anime-story",
  assistantInstruction: "保持同一只边牧和同一位女主人；角色不说话。",
  preset: fallbackPreset,
});
assert.equal(multiCharacterFallbackStoryboard.characterAssets.length, 2, "AI不可用时也必须为边牧和女主人分别建立唯一角色卡");
assert.ok(multiCharacterFallbackStoryboard.characterAssets.some((character) => /边牧|边境牧羊犬/u.test(character.name)), "兜底角色资产必须包含具体边牧犬种");
assert.ok(multiCharacterFallbackStoryboard.characterAssets.some((character) => /女主人|女性主人/u.test(character.name)), "兜底角色资产必须包含具体中国女性主人");
assert.ok(multiCharacterFallbackStoryboard.characterAssets.every((character) => !/维修师傅/u.test(character.name)), "一次性维修师傅不得占用全片角色卡");
assert.ok(multiCharacterFallbackStoryboard.shots.every((shot) => shot.castIds.every((id) => (
  multiCharacterFallbackStoryboard.characterAssets.some((character) => character.id === id)
))), "兜底分镜只能引用已经建立的唯一角色卡");

const decoratedStoryboard = compileStoryboard({
  script: "小狗一脸懵，心跳突然加速，转身跑得像旋风一样。",
  style: "电影级3D卡通动画，高饱和剧情光影",
  ratio: "16:9",
  productionMode: "anime-story",
  effectsLevel: "rich",
  preset: fallbackPreset,
});
assert.ok(decoratedStoryboard.shots.every((shot) => shot.imagePrompt.length >= 80 && !/(?:选择一种|根据语义|让模型决定)/u.test(shot.imagePrompt)), "每张动漫参考图提示词必须包含可直接执行的具体语义证据");
assert.ok(decoratedStoryboard.shots.every((shot) => ["语义重点", "剧情表演", "叙事道具", "环境反馈", "图形特效"].every((layer) => shot.effectsPrompt.includes(`【${layer}】`))), "语义强化必须完整区分语义、表演、道具、环境反馈和可选特效");
assert.ok(decoratedStoryboard.shots.every((shot) => !/(?:保持干净|可加入|例如|根据语义)/u.test(shot.effectsPrompt)), "剧情强化不得把导演决定再次交给生图模型");
assert.ok(decoratedStoryboard.shots.every((shot) => (
  shot.visibleProposition.trim().length >= 4
  && shot.directorDecision.trim().length >= 8
  && shot.cameraPlan.trim().length >= 4
  && shot.editPrompt.trim().length >= 4
  && shot.qualityCriteria.trim().length >= 6
)), "每个分镜必须给出可见命题、导演决策、机位、剪辑点和验收标准");
assert.ok(decoratedStoryboard.shots.every((shot) => (
  /抬|转|冲|跑|贴|盯|扑|退|摇|颤|停|咬|闻|张|缩|甩|抓|坐|站|趴/u.test(shot.videoPrompt)
  && !/(?:上游节点|自动开关键|系统生成|不得绕过|执行层|生成协议)/u.test(shot.videoPrompt)
)), "视频提示词必须用可见动作告诉模型怎么演，不能混入画布内部说明");
assert.ok(decoratedStoryboard.shots.every((shot) => (
  !/(?:同一只|同一个|同一位)/u.test(`${shot.imagePrompt}\n${shot.videoPrompt}`)
)), "图视频提示词必须复述具体视觉资产，不能用关系代词冒充角色一致性");

const speedStoryboard = compileStoryboard({
  script: "小狗突然飞奔起来，跑得像一阵旋风。",
  style: "电影级3D卡通动画，高饱和剧情光影",
  ratio: "16:9",
  productionMode: "anime-story",
  effectsLevel: "rich",
  preset: fallbackPreset,
});
assert.match(speedStoryboard.shots[0].effectsPrompt, /【图形特效】/u, "高速动作也必须经过独立的特效决策，不能靠关键词模板直接拼接");

const plainStoryboard = compileStoryboard({
  script: "小狗安静趴在床边守着熟睡的主人。",
  style: "电影级3D卡通动画",
  ratio: "16:9",
  productionMode: "anime-story",
  effectsLevel: "rich",
  preset: fallbackPreset,
});
assert.match(plainStoryboard.shots[0].effectsPrompt, /【剧情表演】[\s\S]*【叙事道具】[\s\S]*【环境反馈】[\s\S]*【图形特效】/u, "没有图形包装时仍必须保留表演、道具和环境反馈");
assert.match(plainStoryboard.shots[0].imagePrompt, /表演基调：情感抒情/u, "安静守护类文案必须采用克制而连续的情感表演");

const fastPreset = createDefaultCanvasPromptPresetStore().presets.find((preset) => preset.id === "fast_marketing")!;
const fastStoryboard = compileStoryboard({
  script: "第一种表现是每天主动迎接主人，第二种表现是睡觉时完全放松。",
  style: "电影级皮克斯式3D动画",
  ratio: "16:9",
  productionMode: "ten-second",
  preset: fastPreset,
});
assert.equal(fastStoryboard.shots.length, fastStoryboard.semanticSegments.length, "快节奏内容也必须保持一分镜一视频");
assert.ok(fastStoryboard.shots.every((shot) => shot.durationSeconds >= 3 && shot.durationSeconds <= 5), "分镜成片节拍必须在3到5秒之间");
for (const semantic of fastStoryboard.semanticSegments) {
  const shotDuration = fastStoryboard.shots
    .filter((shot) => shot.semanticOrder === semantic.order)
    .reduce((sum, shot) => sum + shot.durationSeconds, 0);
  assert.equal(shotDuration, semantic.durationSeconds, "一个口播段下的视觉镜头总时长必须等于旁白时长");
}

const womanDemoStoryboard = compileStoryboard({
  script: DOG_SLEEP_WOMAN_SCRIPT,
  style: "电影级3D卡通半写实动画",
  ratio: "16:9",
  productionMode: "anime-story",
  assistantInstruction: DOG_SLEEP_WOMAN_INSTRUCTION,
  preset: fallbackPreset,
});
assert.ok(womanDemoStoryboard.shots.every((shot) => Number.isInteger(shot.durationSeconds)), "剧情镜头必须使用整数秒，避免模型向上取整后再裁剪");
assert.ok(womanDemoStoryboard.shots.every((shot) => shot.durationSeconds === 10), "动漫剧情分镜必须保持每语义单元约10秒，内部再按剧情组织3到4个真实镜头");
assert.equal(womanDemoStoryboard.shots.length, womanDemoStoryboard.semanticSegments.length, "女主人复测必须一段文案对应一个参考图和一个视频");
assert.doesNotMatch(womanDemoStoryboard.shots[0]?.imagePrompt || "", /画面：固定为|角色锁定：固定为/u, "补充要求中的操作词不得混入主体名称");
for (const shot of womanDemoStoryboard.shots) {
  assert.deepEqual(
    auditStoryboardImagePrompt(shot.imagePrompt, shot.narration, 780),
    [],
    `镜头${shot.order}的最终生图提示词必须具体、静态、无口播复述且长度可控（当前${shot.imagePrompt.length}字；分段${shot.imagePrompt.split("\n").map((line) => line.length).join("/")}）`,
  );
}
const womanImagePromptCores = womanDemoStoryboard.shots.map((shot) => (
  shot.imagePrompt.match(/静态画面：([\s\S]*?)\n角色连续性：/u)?.[1]?.trim() || shot.imagePrompt
));
assert.ok(new Set(womanImagePromptCores).size >= Math.ceil(womanDemoStoryboard.shots.length / 2), "规则兜底也必须提供足够的静态画面变化；正式生成由AI逐镜导演进一步细化");
for (const semantic of womanDemoStoryboard.semanticSegments) {
  const shotDuration = womanDemoStoryboard.shots
    .filter((shot) => shot.semanticOrder === semantic.order)
    .reduce((sum, shot) => sum + shot.durationSeconds, 0);
  assert.equal(shotDuration, semantic.durationSeconds, "女主人复测中每段镜头总时长必须精确等于口播时长");
}

const qualityScript = "有人说把狗关在楼房里是虐待，但这个说法需要认真讨论。";
const qualityDuration = estimateStoryboardDuration(qualityScript);
const qualityPlan = {
  projectBible: {
    characters: [
      {
        id: "character-1",
        name: "女主人",
        kind: "person" as const,
        importance: "primary" as const,
        fixedAppearance: "成年女主人，鹅蛋脸、棕色杏仁眼、栗色齐肩微卷发，中等身材，固定穿米白色长袖居家服。",
        explicitTraits: ["成年女主人"],
        inferredTraits: ["栗色齐肩微卷发", "米白色长袖居家服"],
      },
      {
        id: "character-2",
        name: "金毛犬",
        kind: "animal" as const,
        importance: "primary" as const,
        fixedAppearance: "同一只成年金毛犬，金黄色蓬松毛发、深棕眼睛、垂耳、宽口鼻和蓝色项圈始终保持一致。",
        explicitTraits: ["成年金毛犬"],
        inferredTraits: ["蓝色项圈"],
      },
    ],
    characterBible: "角色1：成年女主人，鹅蛋脸、棕色杏仁眼、栗色齐肩微卷发，中等身材，固定穿米白色长袖居家服。角色2：同一只成年金毛犬，金黄色蓬松毛发、深棕眼睛、垂耳、宽口鼻和蓝色项圈始终保持一致。",
    environmentBible: "固定为温暖家庭客厅，窗边、沙发、狗窝与木地板的空间关系保持连续。",
    visualBible: "电影级三维卡通半写实动画，温暖体积光、细腻毛发与前中后景层次保持统一。",
    performanceMode: "emotional" as const,
    performanceBible: "情感抒情型；全片以细腻连续反应推进观点，动作克制但不静止，禁止因个别反差词套用喜剧节奏。",
  },
  sourceIssues: [{ quote: "有人说", issue: "表达来源较模糊，需要确认是否保留口语开场", suggestion: "仅在用户确认后再改为更明确的来源", severity: "需确认" as const }],
  segments: [{
    narration: qualityScript,
    durationSeconds: qualityDuration,
    visualShots: [{
      durationSeconds: qualityDuration,
      shotRole: "hook" as const,
      transition: "cut" as const,
      castIds: ["character-2"],
      visualBeat: "金毛犬安稳躺在客厅中央，门外冷色街景形成生存环境反差",
      keyframeMoment: "温暖客厅中同一只金毛犬侧卧在柔软狗窝里，深棕眼睛望向门口，前景散落玩具，中景木地板与沙发清晰，门缝外透入克制冷光。",
      scenePrompt: "固定家庭客厅，木地板、沙发、窗边和狗窝形成清楚空间纵深，室内暖光与门外冷光对比。",
      imagePrompt: "电影级三维卡通半写实静态画面，同一只成年金毛犬侧卧在柔软狗窝里，金黄色蓬松毛发、深棕眼睛和蓝色项圈清晰稳定，前景玩具形成遮挡，中景木地板和沙发建立家庭安全感，门缝外透入冷色街景光，低机位中近景，暖冷对比与浅景深突出安稳神情。",
      effectsPrompt: "【语义重点】居家安全与门外环境形成清楚反差；【剧情表演】金毛侧卧却保持清醒注视，耳朵朝向门外；【叙事道具】柔软狗窝与前景玩具证明居家安全；【环境反馈】门外冷光切入室内暖光并落在木地板上；【图形特效】无",
      motionPrompt: "【入镜】金毛侧卧在狗窝内，门外冷光与室内暖光保持上一镜方向【预备】耳朵先朝门口轻转，眼神抬起【主动作】低机位镜头从门口横移到狗窝，金毛抬头望向门外【反应】窗帘和毛发被微风轻带，前景玩具保持不动【落幅】金毛放松下巴贴回软垫，视线仍朝门口并稳定停住",
      soundPrompt: "室内空调低鸣、窗帘轻响和狗狗呼吸声",
    }],
  }],
};
assert.equal(isAiStoryboardPlanUsable(qualityScript, qualityPlan, { requireMotionChain: true }), true, "结构质检应接受静态生图与五段动作链职责清楚的计划");
const qualityStoryboard = compileStoryboard({ script: qualityScript, style: "电影级三维卡通半写实动画", ratio: "16:9", productionMode: "anime-story", preset: fallbackPreset, plan: qualityPlan });
assert.equal(qualityStoryboard.characterAssets.length, 2, "全文常驻角色必须拆成两个独立角色资产");
assert.deepEqual(qualityStoryboard.shots[0].castIds, ["character-2"], "镜头只能绑定画面中实际出场的角色");
const womanCharacterAsset = qualityStoryboard.characterAssets.find((character) => character.id === "character-1")!;
const dogCharacterAsset = qualityStoryboard.characterAssets.find((character) => character.id === "character-2")!;
assert.match(womanCharacterAsset.referencePrompt, /一张图只出现这一个角色/u, "每张定妆图必须只生成一个角色");
assert.match(womanCharacterAsset.referencePrompt, /鹅蛋脸[\s\S]*栗色齐肩微卷发[\s\S]*米白色长袖居家服/u, "人物定妆提示词必须保留固定脸型、发型和服装");
assert.match(dogCharacterAsset.referencePrompt, /金黄色蓬松毛发[\s\S]*深棕眼睛[\s\S]*蓝色项圈/u, "宠物定妆提示词必须保留毛色、眼睛和配饰");
assert.doesNotMatch(womanCharacterAsset.referencePrompt, /温暖家庭客厅|狗窝|门外冷光/u, "角色定妆提示词不得混入逐镜场景与剧情证据");
assert.match(qualityStoryboard.qualityNotes[0], /表达来源较模糊/, "AI原文质检必须进入画布纠错记录，而不是直接改写原文");
assert.match(qualityStoryboard.shots[0].imagePrompt, /狗窝[\s\S]*门外冷光/u, "动漫参考图必须保留当前口播对应的具体剧情证据");
assert.match(qualityStoryboard.shots[0].effectsPrompt, /【语义重点】[\s\S]*【剧情表演】[\s\S]*【叙事道具】[\s\S]*【环境反馈】[\s\S]*【图形特效】无/u, "无图形特效不等于删除语义重点、剧情表演、道具和环境反馈");
assert.doesNotMatch(qualityStoryboard.shots[0].imagePrompt, /鹅蛋脸|栗色齐肩微卷发|米白色长袖居家服/u, "未出场人物的外观不得污染本镜生图提示词");
assert.match(qualityStoryboard.shots[0].imagePrompt, /金黄色蓬松毛发[\s\S]*深棕眼睛[\s\S]*蓝色项圈/u, "生图提示词必须保留宠物毛色、眼睛和固定配饰");
assert.doesNotMatch(qualityStoryboard.shots[0].imagePrompt, /任务类型|工作流|节点|生成协议/u, "卡片生图提示词不得混入系统说明书");
assert.match(qualityStoryboard.shots[0].imagePrompt, /表演基调：情感抒情/u, "结构化全篇表演类型必须优先于说明文字中的局部‘喜剧’字样");
assert.doesNotMatch(qualityStoryboard.shots[0].imagePrompt, /表演基调：喜剧反差/u, "否定语句中的喜剧字样不得触发喜剧误判");
assert.match(qualityStoryboard.shots[0].videoPrompt, /耳朵先朝门口轻转[\s\S]*抬头望向门外[\s\S]*下巴贴回软垫/u, "视频提示词必须用连续动作和稳定落幅落实情绪节奏");

const semanticDecorationPlan = {
  ...qualityPlan,
  sourceIssues: [],
  segments: [{
    ...qualityPlan.segments[0],
    visualShots: [{
      ...qualityPlan.segments[0].visualShots[0],
      castIds: ["character-1", "character-2"],
      visualBeat: "女主人掀开沙发底布发现破洞，边牧贴近沙发边缘露出明确心虚反应",
      keyframeMoment: "女主人单膝跪在翻起的沙发底布旁，手指停在破洞边缘；边牧贴近沙发另一侧压低耳朵，左耳后方一组短促冷汗形状朝破洞方向收束，前景碎布和裸露木架清楚可见。",
      scenePrompt: "固定家庭客厅沙发区域，翻起的沙发底布、破洞、碎布与裸露木架位于前景和中景，暖色侧光强调损坏材质。",
      imagePrompt: "电影级三维卡通半写实静态画面，女主人单膝跪在翻起的沙发底布旁并指向破洞，边牧压低耳朵、身体后缩、眼神避开主人；边牧左耳后方画出一组短促冷汗形状并朝沙发破洞方向收束，前景碎布、中景裸露木架和被扯裂的底布共同证明拆家结果，低机位中近景，夸张表演但身份造型稳定。",
      effectsPrompt: "【语义重点】边牧看见拆家证据暴露后明显心虚；【剧情表演】女主人指向破洞，边牧压低耳朵、身体后缩并移开视线；【叙事道具】翻起的沙发底布、巨大破洞、碎布和裸露木架共同证明损坏；【环境反馈】底布边缘受力卷起，碎屑落在木地板并形成指向破洞的视觉路径；【图形特效】一组短促冷汗形状位于边牧左耳后方，并朝沙发破洞方向收束",
      motionPrompt: "【入镜】女主人手指停在破洞边缘，边牧左耳后方的短促冷汗形状已经可见并朝破洞方向收束【预备】边牧压低耳朵、后移重心并避开主人视线【主动作】女主人掀高底布露出完整破洞，镜头轻微前推【反应】边牧身体再向后缩，冷汗形状短促弹动后减弱，碎布轻落【落幅】女主人保持指向破洞，边牧低头停住并留下完整损坏证据",
    }],
  }],
};
const semanticDecorationStoryboard = compileStoryboard({
  script: qualityScript,
  style: "电影级三维卡通半写实动画",
  ratio: "16:9",
  productionMode: "anime-story",
  effectsLevel: "rich",
  preset: fallbackPreset,
  plan: semanticDecorationPlan,
});
const decoratedShot = semanticDecorationStoryboard.shots[0];
assert.match(decoratedShot.imagePrompt, /短促冷汗形状[\s\S]*左耳后方[\s\S]*沙发破洞方向/u, "生图提示词压缩后仍须保留语义装饰的形态、位置与指向关系");
assert.match(decoratedShot.imagePrompt, /短促冷汗形状[\s\S]*左耳后方/u, "已决定的语义包装必须作为可见画面内容进入参考图提示词");
const decoratedGenerationPrompt = composeStoryboardReferenceGenerationPrompt(decoratedShot.imagePrompt, "@参考图1：角色01 · 边牧定妆图");
assert.match(decoratedGenerationPrompt, /从空白画布生成一张完整分镜关键帧/u, "角色参考图不得把关键帧生成退化为角色定妆图编辑");
assert.match(decoratedGenerationPrompt, /参考图只锁定角色身份和固定外观/u, "角色图只能承担身份锁定，不得替代本镜画面设计");
assert.match(decoratedGenerationPrompt, /短促冷汗形状[\s\S]*沙发破洞方向/u, "最终生成请求必须保留具体语义包装和剧情证据");
assert.ok(decoratedGenerationPrompt.lastIndexOf("短促冷汗形状") > decoratedGenerationPrompt.lastIndexOf("参考图只锁定"), "剧情与包装指令必须晚于角色身份约束出现");

const duplicateOwnerPlan = {
  ...qualityPlan,
  projectBible: {
    ...qualityPlan.projectBible,
    characters: [
      ...qualityPlan.projectBible.characters,
      {
        id: "character-owner-alias",
        name: "我",
        aliases: ["女主人", "主人"],
        kind: "person" as const,
        importance: "primary" as const,
        fixedAppearance: "同一位成年女主人，鹅蛋脸、栗色齐肩微卷发，固定穿米白色长袖居家服。",
        explicitTraits: ["女主人"],
        inferredTraits: ["鹅蛋脸"],
      },
    ],
  },
  segments: [{
    ...qualityPlan.segments[0],
    visualShots: [{
      ...qualityPlan.segments[0].visualShots[0],
      castIds: ["character-owner-alias", "character-2"],
    }],
  }],
};
const normalizedOwnerCharacters = normalizeStoryboardCharacterIdentities(duplicateOwnerPlan.projectBible.characters);
assert.equal(normalizedOwnerCharacters.characters.length, 2, "我、主人和女主人指向同一实体时必须只保留一张角色卡");
assert.equal(normalizedOwnerCharacters.idMap["character-owner-alias"], "character-1", "被合并的角色ID必须映射到唯一女主人ID");
assert.equal(isAiStoryboardPlanUsable(qualityScript, duplicateOwnerPlan), false, "AI把同一身份拆成多个角色条目时必须被结构质检识别");
const normalizedOwnerStoryboard = compileStoryboard({
  script: qualityScript,
  style: "电影级三维卡通半写实动画",
  ratio: "16:9",
  productionMode: "anime-story",
  preset: fallbackPreset,
  plan: duplicateOwnerPlan,
});
assert.equal(normalizedOwnerStoryboard.characterAssets.length, 2, "编译阶段必须兜底合并重复身份角色卡");
assert.deepEqual(normalizedOwnerStoryboard.shots[0].castIds, ["character-1", "character-2"], "旧角色ID必须重映射到唯一角色卡后再绑定分镜");

const approachScript = "所以你一睁眼，它立刻凑过来，不是因为刚醒，而是一直在等。";
const approachDuration = estimateStoryboardDuration(approachScript);
const approachStoryboard = compileStoryboard({
  script: approachScript,
  style: "电影级三维卡通半写实动画",
  ratio: "16:9",
  productionMode: "anime-story",
  effectsLevel: "rich",
  preset: fallbackPreset,
  plan: {
    ...qualityPlan,
    sourceIssues: [],
    segments: [{
      narration: approachScript,
      durationSeconds: approachDuration,
      visualShots: [{
        ...qualityPlan.segments[0].visualShots[0],
        durationSeconds: approachDuration,
        castIds: ["character-1", "character-2"],
        visualBeat: "女主人刚睁眼，小狗立刻从床边起身靠近并在鼻尖相距很近时停住",
        keyframeMoment: "床侧近景，小狗身体前倾准备靠近，女主人刚睁眼望向它，双方视线清楚相接。",
        imagePrompt: "电影级三维卡通半写实静态画面，同一只成年金毛犬在床边身体前倾，前爪刚刚抬起，深棕眼睛望向刚睁眼的成年女主人；低机位中近景，前景浅色被褥、中景角色和背景半开房门形成空间层次，清晨暖光勾勒金黄色毛发与自然表情。",
        effectsPrompt: "【剧情表演】小狗前爪抬起、身体明显前倾，女主人刚睁眼并与它对视；【叙事道具】被褥压痕与床沿形成靠近路径；【环境反馈】前爪落点带动被角和毛发产生方向一致的反馈；【图形特效】无",
        motionPrompt: "【入镜】小狗位于床边画面右侧，女主人刚睁眼与它对视【预备】小狗竖起耳朵、抬起前爪并前压重心【主动作】低机位侧跟小狗起身靠近床沿【反应】被角被前爪带动，女主人微微睁大眼后放松【落幅】小狗在女主人面前减速停住，双方保持眼神交流",
      }],
    }],
  },
});
assert.match(approachStoryboard.shots[0].effectsPrompt, /【图形特效】无/u, "通用规则不得仅因动作词就机械补入固定图形模板");
assert.match(approachStoryboard.shots[0].videoPrompt, /竖起耳朵[\s\S]*起身靠近床沿[\s\S]*女主人微微睁大眼[\s\S]*减速停住/u, "不使用图形特效时仍需保留完整动作链和可见反应");
const dynamicStaticPlan = {
  ...qualityPlan,
  segments: [{ ...qualityPlan.segments[0], visualShots: [{ ...qualityPlan.segments[0].visualShots[0], imagePrompt: `${qualityPlan.segments[0].visualShots[0].imagePrompt}，随后镜头逐渐推近` }] }],
};
assert.equal(isAiStoryboardPlanUsable(qualityScript, dynamicStaticPlan), false, "静态生图提示词混入时间过程或运镜时必须被结构质检拒绝");
const repairedDynamicStaticPlan = repairAiStoryboardPlanStaticPrompts(dynamicStaticPlan);
assert.equal(repairedDynamicStaticPlan.repairs.length, 1, "可修复的静态提示词问题必须留下明确修复记录");
assert.equal(isAiStoryboardPlanUsable(qualityScript, repairedDynamicStaticPlan.plan), true, "单镜可清洗的动态措辞不得导致整片降级");
assert.equal(isAiStoryboardPlanUsable(qualityScript, {
  ...qualityPlan,
  segments: [{
    ...qualityPlan.segments[0],
    visualShots: [{
      ...qualityPlan.segments[0].visualShots[0],
      imagePrompt: "电影级三维卡通半写实画面，依据原文选择一个生活化场景，根据语义安排主体动作和光线，选择一种合适机位；前景、中景和背景需要有层次，主体外观、表情、视线和材质保持稳定，画面使用暖光、浅景深与整洁室内道具。",
    }],
  }],
}), false, "包含抽象导演委托的生图提示词必须被结构质检拒绝");
assert.equal(isAiStoryboardPlanUsable(qualityScript, {
  ...qualityPlan,
  segments: [{
    ...qualityPlan.segments[0],
    visualShots: [{
      ...qualityPlan.segments[0].visualShots[0],
      motionPrompt: "根据语义选择一种主要运镜，让主体完成动作并表现情绪，最后稳定收尾，环境保持轻微动态。",
    }],
  }],
}), false, "包含候选运镜菜单的动态提示词必须被结构质检拒绝");
assert.equal(isAiStoryboardPlanUsable(qualityScript, {
  ...qualityPlan,
  segments: [{
    ...qualityPlan.segments[0],
    visualShots: [qualityPlan.segments[0].visualShots[0], qualityPlan.segments[0].visualShots[0]],
  }],
}), false, "同一口播段返回两个视频时必须被结构质检拒绝");
assert.equal(isAiStoryboardPlanUsable(qualityScript, {
  ...qualityPlan,
  segments: [{
    ...qualityPlan.segments[0],
    visualShots: [{ ...qualityPlan.segments[0].visualShots[0], soundPrompt: "温柔背景音乐配合狗狗呼吸声" }],
  }],
}), false, "场景音设计混入背景音乐时必须被质检拒绝");
assert.equal(isAiStoryboardPlanUsable(qualityScript, {
  ...qualityPlan,
  segments: [{
    ...qualityPlan.segments[0],
    visualShots: [{ ...qualityPlan.segments[0].visualShots[0], castIds: ["character-missing"] }],
  }],
}), false, "镜头引用不存在的角色资产时必须被结构质检拒绝");

const bananaCapabilities = getImageModelCapabilities({
  name: "Nano Banana 2",
  model_name: "gemini-3.1-flash-image",
  provider: "secure_skill_chat",
  supports_image_input: true,
});
assert.equal(bananaCapabilities.referenceInputMode, "multi", "Nano Banana 2 必须按多参考图模型识别");
assert.equal(bananaCapabilities.maxReferenceImages, 9, "Nano Banana 2 应与主站网关的 9 图输入上限一致");
assert.equal(bananaCapabilities.maxCharacterReferences, 4, "Nano Banana 2 单镜最多绑定4个角色参考");
const textOnlyCapabilities = getImageModelCapabilities({ name: "GPT-Image-2", model_name: "gpt-image-2", supports_image_input: false });
assert.equal(textOnlyCapabilities.maxReferenceImages, 0, "文本生图模型不得伪装成角色参考模型");
const genericEditCapabilities = getImageModelCapabilities({ name: "Generic Edit", model_name: "generic-edit", supports_image_input: true });
assert.equal(genericEditCapabilities.maxReferenceImages, 1, "未知图生图接口必须按单参考图保守门禁");

console.table(segments.map((item, index) => ({
  segment: index + 1,
  chars: countReadableCharacters(item.narration),
  seconds: item.durationSeconds,
  narration: item.narration,
})));
console.log(`Storyboard verification passed: ${segments.length} semantic segments.`);
