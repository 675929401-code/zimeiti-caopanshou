import assert from "node:assert/strict";
import {
  ANIME_DIRECTOR_CUSTOM_TEMPLATE_VERSION,
  ANIME_DIRECTOR_TEMPLATE_VERSION,
  AiStoryboardPlanSchema,
  auditAiStoryboardPlanUsability,
  compileStoryboard,
  createDefaultCanvasPromptPresetStore,
  estimateStoryboardDuration,
  normalizeStoryboardCharacterIdentities,
  parseCanvasPromptPresetStore,
  type StoryboardCharacterIdentity,
} from "../src/lib/canvas-prompt-presets";

const script = "哈士奇咬坏沙发后听见主人开门，立刻压低耳朵，心虚地把碎布藏到身后。";
const durationSeconds = estimateStoryboardDuration(script);
const rawCharacters: StoryboardCharacterIdentity[] = [
  {
    id: "character-1",
    name: "同一只狗狗",
    aliases: ["狗狗", "它"],
    kind: "animal",
    importance: "primary",
    fixedAppearance: "同一只狗狗，作为全片固定角色保持同一身份、体型、脸型或毛色花纹，以及固定服装和配饰。",
    explicitTraits: ["狗狗"],
    inferredTraits: [],
  },
  {
    id: "character-2",
    name: "同一位主人",
    aliases: ["主人"],
    kind: "person",
    importance: "supporting",
    fixedAppearance: "同一位主人，作为全片固定角色保持同一身份、体型、脸型或毛色花纹，以及固定服装和配饰。",
    explicitTraits: ["主人"],
    inferredTraits: [],
  },
];
const { characters } = normalizeStoryboardCharacterIdentities(rawCharacters, script);
const dog = characters.find((character) => character.kind === "animal");
const owner = characters.find((character) => character.kind === "person");

assert.equal(dog?.name, "哈士奇");
assert.match(dog?.fixedAppearance || "", /天然四足犬科比例/);
assert.match(dog?.fixedAppearance || "", /不穿人类服装/);
assert.match(dog?.fixedAppearance || "", /不直立成人形/);
assert.match(owner?.name || "", /中国.*主人/);
assert.match(owner?.fixedAppearance || "", /自然人类头部与四肢/);
assert.doesNotMatch(characters.map((character) => character.name).join("；"), /同一(?:只|位|个)/u);

const imagePrompt = "16:9横屏电影级3D动画画面。2岁青年哈士奇保持天然四足犬科比例，黑白双层短毛、额头火焰纹和冰蓝眼睛清楚可见；它半蹲在客厅沙发前，耳朵紧贴脑后，前爪把破碎布料压向身后，眼神斜看门口。前景散落棉絮和清楚咬痕，中景是哈士奇与破损沙发，背景门口透入偏冷侧光；低机位中近景，对角线构图，暖色室内光与门外冷光形成压力，毛发、布料和木地板材质细腻，胸前有一组贴合身体透视的低饱和红色紧绷线。";
const videoPrompt = "从@参考图1当前画面开始。哈士奇先屏住身体，耳朵继续向后压，眼睛快速瞟向门口；接着用右前爪把碎布往身后推，动作急促但幅度克制，散落棉絮被爪尖带动。门外脚步声靠近时，它的肩背和尾巴同时轻颤，胸前红色紧绷线随呼吸短促收缩两次。镜头保持低机位中近景，缓慢向前跟半步，最后停在哈士奇僵住装乖的表情上。只保留爪垫摩擦、布料窸窣和门外脚步声。";

const directContractFields = {
  visibleProposition: "\u54c8\u58eb\u5947\u7528\u540e\u538b\u8033\u6735\u3001\u659c\u89c6\u95e8\u53e3\u548c\u524d\u722a\u85cf\u5e03\u8bc1\u660e\u5fc3\u865a\u3002",
  directorDecision: "\u3010\u53ef\u89c1\u547d\u9898\u3011\u54c8\u58eb\u5947\u60f3\u85cf\u8d77\u95ef\u7978\u8bc1\u636e\uff1b\u3010\u89d2\u8272\u76ee\u6807\u3011\u5728\u4e3b\u4eba\u8fdb\u95e8\u524d\u628a\u788e\u5e03\u85cf\u5230\u8eab\u540e\uff1b\u3010\u963b\u788d\u6216\u5f02\u5e38\u3011\u7834\u635f\u6c99\u53d1\u548c\u68c9\u7d6e\u65e0\u6cd5\u5b8c\u5168\u63a9\u9970\uff1b\u3010\u6838\u5fc3\u52a8\u4f5c\u3011\u538b\u8033\u3001\u659c\u770b\u5e76\u7528\u524d\u722a\u6025\u4fc3\u85cf\u5e03\uff1b\u3010\u53ef\u89c1\u7ed3\u679c\u3011\u54c8\u58eb\u5947\u50f5\u4f4f\u88c5\u4e56\u4f46\u8bc1\u636e\u4ecd\u5728\uff1b\u3010\u955c\u5934\u6293\u624b\u3011\u4f4e\u673a\u4f4d\u8ddf\u8fdb\u524d\u722a\u85cf\u5e03\u540e\u505c\u5728\u5fc3\u865a\u8868\u60c5\u3002",
  effectsPrompt: "\u3010\u8bed\u4e49\u7f3a\u53e3\u3011\u5fc3\u865a\u548c\u5bb3\u6015\u65e0\u6cd5\u76f4\u63a5\u88ab\u770b\u89c1\uff1b\u3010\u5305\u88c5\u51b3\u7b56\u3011\u7528\u8d34\u5408\u8eab\u4f53\u900f\u89c6\u7684\u4f4e\u9971\u548c\u52a8\u6001\u7ebf\u628a\u538b\u529b\u53d8\u6210\u53ef\u89c1\u8bc1\u636e\uff1b\u3010\u5305\u88c5\u7c7b\u578b\u3011environment-feedback\uff1b\u3010\u5305\u88c5\u951a\u70b9\u3011\u7ea2\u8272\u7d27\u7ef7\u7ebf\uff1b\u3010\u7ed1\u5b9a\u4e0e\u4f4d\u7f6e\u3011\u8d34\u5408\u54c8\u58eb\u5947\u80f8\u524d\u8eab\u4f53\u900f\u89c6\uff1b\u3010\u9759\u6001\u521d\u6001\u3011\u4e00\u7ec4\u4f4e\u9971\u548c\u7ea2\u8272\u7d27\u7ef7\u7ebf\u6536\u7d27\u5728\u80f8\u524d\uff1b\u3010\u52a8\u6001\u5ef6\u7eed\u3011\u7ea2\u8272\u7d27\u7ef7\u7ebf\u968f\u77ed\u4fc3\u547c\u5438\u6536\u7f29\u4e24\u6b21\u540e\u7a33\u5b9a\u3002",
  qualityCriteria: "\u54c8\u58eb\u5947\u5916\u89c2\u548c\u56db\u8db3\u6bd4\u4f8b\u4e0d\u6f02\u79fb\uff0c\u788e\u5e03\u85cf\u533f\u52a8\u4f5c\u3001\u7ea2\u8272\u7d27\u7ef7\u7ebf\u548c\u7a33\u5b9a\u843d\u5e45\u5fc5\u987b\u540c\u65f6\u53ef\u89c1\u3002",
} as const;

const basePlan = AiStoryboardPlanSchema.parse({
  promptContractVersion: "anime-director-v1",
  projectBible: {
    characters,
    characterBible: "哈士奇与中国女性主人是全片固定角色，身份、物种、体型、面孔、毛色和固定造型不得漂移。",
    environmentBible: "全片发生在同一家庭客厅，沙发位于中景左侧，门口位于背景右侧，碎布和棉絮状态随剧情连续。",
    visualBible: "电影级3D动画，角色比例自然，毛发与布料材质细腻，暖色室内光和冷色门外光保持统一方向。",
    packagingBible: "包装只使用贴合主体透视的半透明体积线，颜色克制，绑定动作后自然收缩或消退，不使用文字。",
    performanceMode: "comedy",
    performanceBible: "以心虚反差作为笑点，先停顿制造期待，再做短促藏匿动作，反应清楚但不把动物改成人形。",
    storyPlan: {
      premise: "哈士奇刚咬坏沙发就听见主人回家，必须在被发现前藏起碎布。",
      protagonistGoal: "哈士奇想藏起咬坏沙发的证据。",
      incitingIncident: "门外传来主人开门的声音。",
      escalation: "散落的碎布和棉絮来不及完全清理，哈士奇越来越紧张。",
      turningPoint: "哈士奇立刻压低耳朵，用前爪把碎布推到身后。",
      resolution: "哈士奇僵住装乖，但破损沙发和棉絮仍清楚可见。",
      beats: [{
        order: 1,
        storyFunction: "payoff",
        event: "哈士奇听见开门声后心虚地藏起碎布。",
        entryState: "哈士奇半蹲在破损沙发前，棉絮和碎布散落。",
        action: "它压低耳朵，用右前爪急促地把碎布推到身后。",
        resultState: "它肩背和尾巴轻颤，最后僵住装乖。",
        handoffToNext: "破损沙发、棉絮和门口冷光作为收束证据。",
      }],
    },
  },
  sourceIssues: [],
  segments: [{
    narration: script,
    durationSeconds,
    visualShots: [{
      visualMode: "hybrid-packaging",
      durationSeconds,
      shotRole: "reaction",
      transition: "cut",
      castIds: ["character-1"],
      visualBeat: "哈士奇听见主人开门后心虚藏起被咬坏的碎布",
      visibleProposition: "哈士奇用后压耳朵、旜视门口和前爪藏布证明心虚。",
      evidenceLevel: "environment_feedback",
      directorDecision: "【可见命题】哈士奇想藏起闯祸证据；【角色目标】在主人进门前把碎布藏到身后；【阻碍或异常】破损沙发和棉絮无法完全掩饰；【核心动作】压耳、旜看并用前爪急促藏布；【可见结果】哈士奇僵住装乖但证据仍在；【镜头抓手】低机位跟进前爪藏布后停在心虚表情。",
      cameraPlan: "低机位中近景沿前爪藏布方向缓慢跟进半步，最后稳定落幅。",
      keyframeMoment: imagePrompt,
      scenePrompt: "同一家庭客厅，破损沙发位于中景左侧，门口位于背景右侧，前景散落棉絮，冷暖侧光方向稳定。",
      imagePrompt,
      videoPrompt,
      effectsPrompt: "【语义重点】心虚怕被发现；【剧情表演】耳朵后压并藏碎布；【叙事道具】破损沙发、碎布和棉絮；【环境反馈】门外冷光与脚步压力；【图形特效】胸前低饱和红色紧绷线随呼吸收缩",
      motionPrompt: "【入镜】哈士奇半蹲在破损沙发前斜看门口；【预备】耳朵后压并屏住身体；【主动作】右前爪急促把碎布推向身后，镜头低机位缓慢跟进；【反应】肩背尾巴轻颤，棉絮被带动；【落幅】僵住装乖并稳定停留",
      soundPrompt: "爪垫摩擦、布料窸窣和门外脚步声",
    }],
  }],
});

const plan = AiStoryboardPlanSchema.parse({
  ...basePlan,
  segments: basePlan.segments.map((segment) => ({
    ...segment,
    visualShots: segment.visualShots.map((shot) => ({
      ...shot,
      ...directContractFields,
    })),
  })),
});

assert.deepEqual(
  auditAiStoryboardPlanUsability(script, plan, { requireFinalPrompts: true }),
  [],
  "The fixture must satisfy the complete direct-prompt contract before compilation.",
);

const preset = createDefaultCanvasPromptPresetStore().presets.find((item) => item.id === "anime_story");
assert.ok(preset);
const compiled = compileStoryboard({
  script,
  style: "电影级3D卡通半写实动画",
  ratio: "16:9",
  productionMode: "anime-story",
  referenceMode: "single",
  effectsLevel: "light",
  preset,
  plan,
});

assert.equal(compiled.promptContractVersion, "anime-director-v1");
assert.equal(compiled.shots.length, 1);
assert.ok(compiled.shots[0].imagePrompt.includes(imagePrompt));
assert.equal(compiled.shots[0].imagePrompt.split(imagePrompt).length, 2);
assert.ok(compiled.shots[0].videoPrompt.includes(videoPrompt));
assert.equal(compiled.shots[0].videoPrompt.split(videoPrompt).length, 2);
assert.doesNotMatch(compiled.shots[0].videoPrompt, /上游|节点|系统生成|不得绕过|执行层|生成协议/u);

const legacyStore = createDefaultCanvasPromptPresetStore();
const legacyAnimePreset = legacyStore.presets.find((item) => item.id === "anime_story");
assert.ok(legacyAnimePreset);
legacyAnimePreset.promptContractVersion = "legacy";
legacyAnimePreset.directorTemplateVersion = "legacy";
legacyAnimePreset.draft.directorPrompt = "旧版分散提示词";
legacyAnimePreset.published.directorPrompt = "旧版分散提示词";
const migratedStore = parseCanvasPromptPresetStore(JSON.stringify(legacyStore));
const migratedAnimePreset = migratedStore.presets.find((item) => item.id === "anime_story");
assert.equal(migratedAnimePreset?.promptContractVersion, "anime-director-v1");
assert.equal(migratedAnimePreset?.directorTemplateVersion, ANIME_DIRECTOR_TEMPLATE_VERSION);
const migratedDirectorPrompt = migratedAnimePreset?.draft.directorPrompt || "";
assert.ok(migratedDirectorPrompt.includes("\u6700\u7ec8\u8f93\u51fa\u56db\u7c7b\u6210\u54c1"));
assert.ok(migratedDirectorPrompt.includes("\u753b\u9762\u63d0\u793a\u8bcd"));
assert.ok(migratedDirectorPrompt.includes("\u52a8\u6001\u8fd0\u955c\u63d0\u793a\u8bcd"));
assert.ok(migratedDirectorPrompt.includes("JSON"));

const customMarker = "后台自定义导演规则：动作必须有明确方向。";
if (!migratedAnimePreset) throw new Error("动漫剧情预设迁移失败");
migratedAnimePreset.draft.directorPrompt += `\n${customMarker}`;
migratedAnimePreset.directorTemplateVersion = ANIME_DIRECTOR_CUSTOM_TEMPLATE_VERSION;
const reparsedStore = parseCanvasPromptPresetStore(JSON.stringify(migratedStore));
const reparsedAnimePreset = reparsedStore.presets.find((item) => item.id === "anime_story");
assert.match(reparsedAnimePreset?.draft.directorPrompt || "", new RegExp(customMarker));
assert.equal(reparsedAnimePreset?.directorTemplateVersion, ANIME_DIRECTOR_CUSTOM_TEMPLATE_VERSION);

console.log(JSON.stringify({
  contract: compiled.promptContractVersion,
  characterNames: characters.map((character) => character.name),
  imagePromptPreservedVerbatimOnce: compiled.shots[0].imagePrompt.split(imagePrompt).length === 2,
  videoPromptPreservedVerbatimOnce: compiled.shots[0].videoPrompt.split(videoPrompt).length === 2,
  oneTimeMigrationPreservesAdminEdits: Boolean(reparsedAnimePreset?.draft.directorPrompt.includes(customMarker)),
}, null, 2));
