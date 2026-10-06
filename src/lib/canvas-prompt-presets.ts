import { z } from "zod";
import { buildCanonicalShotTimeline, formatVideoDuration } from "@/lib/video-prompt-timing";
import { ANIME_DIRECTOR_CORE_PROMPT } from "@/lib/anime-director-agent-prompt";
import { extractSegmentedNarrations } from "@/lib/script-planner";
import type {
  StoryboardActualShotCount,
  StoryboardDirectorMode,
  StoryboardLayout,
  StoryboardPacingMode,
  StoryboardShotTimeRange,
  StoryboardTargetDurationSeconds,
} from "@/lib/storyboard-director-protocol";

export const CANVAS_PROMPT_PRESETS_SETTING_KEY = "canvas_prompt_presets_v1";
export const ANIME_DIRECTOR_TEMPLATE_VERSION = "anime-director-v14-storyboard-intent-grid";
export const ANIME_DIRECTOR_CUSTOM_TEMPLATE_VERSION = "anime-director-custom";

export const PromptPresetContentSchema = z.object({
  directorPrompt: z.string().max(50000).default(""),
  segmentationRules: z.string().min(20),
  characterRules: z.string().min(20),
  sceneRules: z.string().min(20),
  imageRules: z.string().min(20),
  motionRules: z.string().min(20),
  videoRules: z.string().min(20),
  negativeRules: z.string().min(10),
  firstLastFrameRules: z.string().min(20),
});

export const PromptPresetHistorySchema = z.object({
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  content: PromptPresetContentSchema,
});

export const CanvasPromptPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(30),
  summary: z.string().min(4).max(100),
  category: z.string().min(2).max(20),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  primaryModel: z.string().default(""),
  fallbackModel: z.string().default(""),
  promptContractVersion: z.string().default("legacy"),
  directorTemplateVersion: z.string().default("legacy"),
  draft: PromptPresetContentSchema,
  published: PromptPresetContentSchema,
  history: z.array(PromptPresetHistorySchema).max(20),
  updatedAt: z.string().datetime(),
  publishedAt: z.string().datetime(),
});

export const CanvasPromptPresetStoreSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  presets: z.array(CanvasPromptPresetSchema).min(1).max(30),
});

export const StoryboardSegmentsSchema = z.object({
  segments: z.array(z.object({
    narration: z.string().trim().min(1).max(500),
    durationSeconds: z.number().int().min(3).max(5),
  })).min(1).max(120),
});

export const VisualEffectsLevelSchema = z.enum(["none", "light", "rich"]);
export const KeyframeStrategySchema = z.enum(["visual-anchor", "action-start"]);
export const VisualShotRoleSchema = z.enum(["hook", "setup", "action", "reaction", "evidence", "metaphor", "payoff", "transition"]);
export const ShotTransitionSchema = z.enum(["cut", "dissolve", "match-cut", "graphic", "hold"]);
export const VisualShotModeSchema = z.enum(["narrative", "hybrid-packaging", "semantic-cutaway"]);
export const VisualEvidenceLevelSchema = z.enum(["physical_action", "body_state", "environment_feedback", "semantic_cutaway"]);
export const StoryFunctionSchema = z.enum(["hook", "setup", "trigger", "escalation", "turn", "reveal", "payoff", "cta"]);

export const StoryboardStoryPlanSchema = z.object({
  premise: z.string().trim().min(10).max(500),
  protagonistGoal: z.string().trim().min(6).max(300),
  incitingIncident: z.string().trim().min(6).max(300),
  escalation: z.string().trim().min(6).max(500),
  turningPoint: z.string().trim().min(6).max(300),
  resolution: z.string().trim().min(6).max(300),
  beats: z.array(z.object({
    order: z.number().int().min(1).max(120),
    storyFunction: StoryFunctionSchema,
    event: z.string().trim().min(6).max(300),
    entryState: z.string().trim().min(4).max(220),
    action: z.string().trim().min(4).max(220),
    resultState: z.string().trim().min(4).max(220),
    handoffToNext: z.string().trim().min(4).max(220),
  })).min(1).max(120),
});

export const CanvasSourceIssueSchema = z.object({
  quote: z.string().trim().min(1).max(120),
  issue: z.string().trim().min(4).max(300),
  suggestion: z.string().trim().max(300).default(""),
  severity: z.enum(["提示", "需确认", "高风险"]).default("需确认"),
});

export const StoryboardCharacterIdentitySchema = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  aliases: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  kind: z.enum(["person", "animal", "product", "object", "other"]),
  importance: z.enum(["primary", "supporting", "background"]).default("supporting"),
  fixedAppearance: z.string().trim().min(20).max(1000),
  explicitTraits: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  inferredTraits: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
});

export const StoryboardCharacterListSchema = z.array(StoryboardCharacterIdentitySchema).min(1).max(8);

export const StoryboardProjectBibleSchema = z.object({
  characters: StoryboardCharacterListSchema,
  characterBible: z.string().trim().min(30).max(1500),
  environmentBible: z.string().trim().min(30).max(1500),
  visualBible: z.string().trim().min(30).max(1500),
  packagingBible: z.string().trim().min(30).max(1500).optional(),
  editorialBible: z.string().trim().min(30).max(1500).optional(),
  performanceMode: z.enum(["emotional", "natural", "dynamic", "comedy", "educational", "dramatic"]).optional(),
  performanceBible: z.string().trim().min(30).max(1500).optional(),
  storyPlan: StoryboardStoryPlanSchema.optional(),
});

export const AiStoryboardPlanSchema = z.object({
  promptContractVersion: z.literal("anime-director-v1").optional(),
  projectBible: StoryboardProjectBibleSchema.optional(),
  sourceIssues: z.array(CanvasSourceIssueSchema).max(20).default([]),
  segments: z.array(z.object({
    narration: z.string().trim().min(1).max(500),
    durationSeconds: z.number().int().min(3).max(5),
    visualShots: z.array(z.object({
      visualMode: VisualShotModeSchema.optional(),
      durationSeconds: z.number().int().min(3).max(5),
      shotRole: VisualShotRoleSchema,
      transition: ShotTransitionSchema,
      visualBeat: z.string().trim().min(10).max(500),
      visibleProposition: z.string().trim().min(10).max(500).optional(),
      evidenceLevel: VisualEvidenceLevelSchema.optional(),
      directorDecision: z.string().trim().min(20).max(1000).optional(),
      cameraPlan: z.string().trim().min(10).max(500).optional(),
      castIds: z.array(z.string().trim().min(1).max(60)).min(1).max(4),
      keyframeMoment: z.string().trim().min(50).max(1500),
      scenePrompt: z.string().trim().min(30).max(1500),
      imagePrompt: z.string().trim().min(80).max(2200).optional(),
      videoPrompt: z.string().trim().min(50).max(800).optional(),
      effectsPrompt: z.string().trim().min(2).max(1000),
      motionPrompt: z.string().trim().min(30).max(1800),
      soundPrompt: z.string().trim().min(1).max(1000).optional(),
      editPrompt: z.string().trim().min(10).max(500).optional(),
      qualityCriteria: z.string().trim().min(10).max(800).optional(),
    })).length(1),
  })).min(1).max(120),
});

export type PromptPresetContent = z.infer<typeof PromptPresetContentSchema>;
export type CanvasPromptPreset = z.infer<typeof CanvasPromptPresetSchema>;
export type CanvasPromptPresetStore = z.infer<typeof CanvasPromptPresetStoreSchema>;
export type AiStoryboardPlan = z.infer<typeof AiStoryboardPlanSchema>;
export type CanvasSourceIssue = z.infer<typeof CanvasSourceIssueSchema>;
export type StoryboardCharacterIdentity = z.infer<typeof StoryboardCharacterIdentitySchema>;
export type StoryboardStoryPlan = z.infer<typeof StoryboardStoryPlanSchema>;
export type VisualEffectsLevel = z.infer<typeof VisualEffectsLevelSchema>;
export type KeyframeStrategy = z.infer<typeof KeyframeStrategySchema>;
export type VisualShotMode = z.infer<typeof VisualShotModeSchema>;
export type VisualEvidenceLevel = z.infer<typeof VisualEvidenceLevelSchema>;

const GENERIC_CHARACTER_NAMES = /^(?:同一(?:只|位|个))?(?:我|本人|他|她|它|主人|女主人|男主人|旁白|叙述者|角色\d*|宠物|狗狗|小狗|猫咪|固定主体|原文中的固定主体)$/u;
const GENERIC_CONTINUITY_PREFIX = /^同一(?:只|位|个)/u;
const MALE_PERSON_HINT = /(?:男主人|男性|男人|男生|男孩|爸爸|父亲|哥哥|弟弟|丈夫|他)/u;
const DOG_HINT = /(?:狗|犬|金毛|哈士奇|泰迪|贵宾|比熊|拉布拉多|边牧|边境牧羊犬)/u;
const DOG_BREEDS = ["三色柯基犬", "柯基犬", "金毛寻回犬", "哈士奇", "泰迪犬", "玩具贵宾犬", "比熊犬", "拉布拉多犬", "边境牧羊犬"] as const;
const GENERIC_ANIMAL_IDENTITY_TOKEN = /^(?:它|宠物|动物|狗|犬|狗狗|小狗|幼犬|猫|猫咪|小猫|柯基|柯基犬|三色柯基犬|金毛|金毛犬|金毛寻回犬|哈士奇|泰迪|泰迪犬|贵宾|贵宾犬|比熊|比熊犬|拉布拉多|拉布拉多犬|边牧|边境牧羊犬)$/u;
const DISTINCT_ANIMAL_NAME_HINT = /(?:幼年|成年|青年|年长|年幼|浅金|深金|奶油|赤金|红棕|黑色|白色|灰色|左侧|右侧|第一只|第二只|大号|小号|雄性|雌性|公犬|母犬|蓝色项圈|红色项圈|绿色项圈)/u;

function normalizeCharacterIdentityToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s·•_\-—–，,。；;：:（）()【】\[\]“”"']/gu, "");
}

function uniqueCharacterLabels(values: Array<string | undefined>) {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    if (!value?.trim()) return false;
    const token = normalizeCharacterIdentityToken(value);
    if (!token || seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

const FEMALE_PERSON_HINT = /(?:女主人|女性|女人|女生|女孩|妈妈|母亲|姐姐|妹妹|妻子|她)/u;
const EXPLICIT_ORIGIN_HINT = /(?:中国|华人|东亚|亚洲|日本|韩国|东南亚|欧美|欧洲|美国|白人|黑人|非洲|拉丁|中东|印度)/u;
const DEFAULT_CHINESE_WOMAN_APPEARANCE = "成年中国女性，清秀自然且精致耐看的东亚面孔，面部比例协调，深色中长发，眼神明亮亲和，健康自然气色，不过度网红化";
const DEFAULT_CHINESE_MAN_APPEARANCE = "成年中国男性，自然耐看的东亚面孔，面部比例协调，黑色短发，眉眼清晰，健康自然气色，体态匀称";

function stripGenericContinuity(value: string) {
  return value
    .replace(GENERIC_CONTINUITY_PREFIX, "")
    .replace(/作为全片固定角色保持同一身份、体型、脸型或毛色花纹，以及固定服装和配饰[。；]?/gu, "")
    .replace(/保持同一身份、体型、脸型或毛色花纹[。；]?/gu, "")
    .trim();
}

function inferDogBreed(script: string, descriptor: string) {
  const source = `${descriptor}；${script}`;
  const explicitBreed = DOG_BREEDS.find((breed) => source.includes(breed))
    || (/(?:三色柯基|柯基)/u.test(source) ? "三色柯基犬" : "")
    || (/金毛/u.test(source) ? "金毛寻回犬" : "")
    || (/哈士奇/u.test(source) ? "哈士奇" : "")
    || (/(?:泰迪|贵宾)/u.test(source) ? "泰迪犬" : "")
    || (/比熊/u.test(source) ? "比熊犬" : "")
    || (/拉布拉多/u.test(source) ? "拉布拉多犬" : "")
    || (/(?:边牧|边境牧羊犬)/u.test(source) ? "边境牧羊犬" : "");
  if (explicitBreed) return explicitBreed;
  return "三色柯基犬";
}

function concreteDogAppearance(breed: string) {
  if (breed === "三色柯基犬" || breed === "柯基犬") return "2岁青年三色柯基犬，小中型短腿长身，天然四足犬科比例，橙棕、白色与黑色马鞍纹被毛，三角大立耳，圆润深棕大眼，黑色鼻头，短自然口吻，蓝色项圈，尾部短而自然；不穿人类服装，不直立成人形";
  if (breed === "哈士奇") return "2岁青年哈士奇，中等体型，天然四足犬科比例，黑白双层短毛，额头清晰火焰纹，冰蓝眼睛，三角立耳，黑色鼻头，口吻长度自然，蓬松卷尾；不穿人类服装，不直立成人形";
  if (breed === "泰迪犬" || breed === "玩具贵宾犬") return "2岁小型泰迪犬，天然四足犬科比例，焦糖棕色卷毛，圆润深棕眼睛，垂耳，黑色小鼻头，短口吻，尾巴自然上扬；不穿人类服装，不直立成人形";
  if (breed === "比熊犬") return "2岁小型比熊犬，天然四足犬科比例，蓬松纯白卷毛，圆润深棕眼睛，垂耳藏于毛发中，黑色鼻头，短口吻，蓬松卷尾；不穿人类服装，不直立成人形";
  if (breed === "拉布拉多犬") return "2岁青年拉布拉多犬，中大型匀称体型，天然四足犬科比例，短而有光泽的浅金色被毛，深棕眼睛，柔软垂耳，黑色鼻头，宽阔口吻，粗壮直尾；不穿人类服装，不直立成人形";
  if (breed === "边境牧羊犬") return "2岁青年边境牧羊犬，中等敏捷体型，天然四足犬科比例，黑白中长毛，面部白色中线，深棕眼睛，半立耳，黑色鼻头，修长口吻，蓬松长尾；不穿人类服装，不直立成人形";
  return "2岁青年三色柯基犬，小中型短腿长身，天然四足犬科比例，橙棕、白色与黑色马鞍纹被毛，三角大立耳，圆润深棕大眼，黑色鼻头，短自然口吻，蓝色项圈，尾部短而自然；不穿人类服装，不直立成人形";
}

function concretizeStoryboardCharacter(character: StoryboardCharacterIdentity, script: string) {
  const descriptor = [character.name, ...(character.aliases || []), character.fixedAppearance, ...character.explicitTraits, ...character.inferredTraits].join("；");
  const baseName = stripGenericContinuity(character.name);
  if (character.kind === "animal" && DOG_HINT.test(descriptor)) {
    const breed = inferDogBreed(script, descriptor);
    const existingAppearance = stripGenericContinuity(character.fixedAppearance);
    const concreteName = DISTINCT_ANIMAL_NAME_HINT.test(baseName) ? baseName : breed;
    return {
      ...character,
      name: concreteName,
      aliases: uniqueCharacterLabels([baseName, ...(character.aliases || []), "狗狗", "小狗", "它"])
        .filter((alias) => normalizeCharacterIdentityToken(alias) !== normalizeCharacterIdentityToken(concreteName)),
      fixedAppearance: mergeCharacterText(concreteDogAppearance(breed), existingAppearance, 1000),
      inferredTraits: mergeCharacterTraits(character.inferredTraits, [breed, "天然四足犬科比例", "禁止拟人身体和人类服装"]),
    };
  }
  if (character.kind === "person") {
    const isFemale = FEMALE_PERSON_HINT.test(descriptor) || !MALE_PERSON_HINT.test(descriptor);
    const concreteName = isFemale ? "30岁中国女性主人" : "32岁中国男性主人";
    const appearance = isFemale
      ? `${DEFAULT_CHINESE_WOMAN_APPEARANCE}，身材匀称，穿浅蓝色针织上衣和深色长裤，佩戴一枚银色圆形吊坠；自然人类头部与四肢，禁止动物头、毛脸或兽化`
      : `${DEFAULT_CHINESE_MAN_APPEARANCE}，穿灰绿色休闲衬衫和深色长裤，佩戴黑色腕表；自然人类头部与四肢，禁止动物头、毛脸或兽化`;
    return {
      ...character,
      name: GENERIC_CHARACTER_NAMES.test(character.name.trim()) ? concreteName : baseName,
      aliases: uniqueCharacterLabels([baseName, ...(character.aliases || []), isFemale ? "女主人" : "男主人", "主人"])
        .filter((alias) => normalizeCharacterIdentityToken(alias) !== normalizeCharacterIdentityToken(concreteName)),
      fixedAppearance: mergeCharacterText(appearance, stripGenericContinuity(character.fixedAppearance), 1000),
      inferredTraits: mergeCharacterTraits(character.inferredTraits, [isFemale ? "中国成年女性，东亚面孔" : "中国成年男性，东亚面孔", "自然人类解剖，禁止兽化"]),
    };
  }
  return { ...character, name: baseName || character.name };
}

function applyChineseProjectCharacterDefaults(character: StoryboardCharacterIdentity, script: string) {
  const descriptor = [character.name, ...(character.aliases || []), character.fixedAppearance, ...character.explicitTraits, ...character.inferredTraits].join("；");
  const explicitOriginDescriptor = [character.name, ...(character.aliases || []), ...character.explicitTraits].join("；");
  const isChineseProject = /[\u4e00-\u9fff]/u.test(script);
  const isGenericFemale = character.kind === "person" && FEMALE_PERSON_HINT.test(descriptor);
  if (!isChineseProject || !isGenericFemale || EXPLICIT_ORIGIN_HINT.test(explicitOriginDescriptor)) return character;
  return {
    ...character,
    fixedAppearance: mergeCharacterText(DEFAULT_CHINESE_WOMAN_APPEARANCE, character.fixedAppearance, 1000),
    inferredTraits: mergeCharacterTraits(character.inferredTraits, [
      "中国女性，东亚面孔",
      "深色中长发",
      "自然清秀、明亮亲和、精致耐看的五官",
    ]),
  };
}

function canonicalCharacterName(values: string[]) {
  return [...values].sort((left, right) => {
    const leftScore = (GENERIC_CHARACTER_NAMES.test(left.trim()) ? 0 : 100) + normalizeCharacterIdentityToken(left).length;
    const rightScore = (GENERIC_CHARACTER_NAMES.test(right.trim()) ? 0 : 100) + normalizeCharacterIdentityToken(right).length;
    return rightScore - leftScore;
  })[0];
}

function mergeCharacterText(left: string, right: string, maxLength: number) {
  return uniqueCharacterLabels([left, right]).join("；").slice(0, maxLength);
}

function mergeCharacterTraits(left: string[], right: string[]) {
  return uniqueCharacterLabels([...left, ...right]).slice(0, 12);
}

export function normalizeStoryboardCharacterIdentities(characters: StoryboardCharacterIdentity[], script = "") {
  const normalized: StoryboardCharacterIdentity[] = [];
  const idMap: Record<string, string> = {};
  const importanceRank = { primary: 3, supporting: 2, background: 1 } as const;

  characters.forEach((source) => {
    const character: StoryboardCharacterIdentity = {
      ...source,
      aliases: uniqueCharacterLabels(source.aliases || []).filter((alias) => (
        normalizeCharacterIdentityToken(alias) !== normalizeCharacterIdentityToken(source.name)
      )),
    };
    const tokens = new Set(
      uniqueCharacterLabels([character.name, ...(character.aliases || [])]).map(normalizeCharacterIdentityToken),
    );
    const match = normalized.find((candidate) => {
      const compatibleKind = candidate.kind === character.kind || candidate.kind === "other" || character.kind === "other";
      if (!compatibleKind) return false;
      if (candidate.id === character.id) return true;
      const preserveDistinctAnimals = candidate.kind === "animal" && character.kind === "animal" && (
        /(?:两|2|二)(?:只|条|头)|双方|彼此|一对/u.test(script)
        || DISTINCT_ANIMAL_NAME_HINT.test(candidate.name)
        || DISTINCT_ANIMAL_NAME_HINT.test(character.name)
      );
      if (preserveDistinctAnimals) return false;
      return uniqueCharacterLabels([candidate.name, ...(candidate.aliases || [])])
        .map(normalizeCharacterIdentityToken)
        .some((token) => tokens.has(token) && !(
          candidate.kind === "animal"
          && character.kind === "animal"
          && GENERIC_ANIMAL_IDENTITY_TOKEN.test(token)
        ));
    });

    if (!match) {
      normalized.push(character);
      idMap[character.id] = character.id;
      return;
    }

    idMap[character.id] = match.id;
    const labels = uniqueCharacterLabels([
      match.name,
      ...(match.aliases || []),
      character.name,
      ...(character.aliases || []),
    ]);
    const name = canonicalCharacterName(labels);
    match.name = name;
    match.aliases = labels.filter((label) => (
      normalizeCharacterIdentityToken(label) !== normalizeCharacterIdentityToken(name)
    ));
    match.kind = match.kind === "other" ? character.kind : match.kind;
    match.importance = importanceRank[character.importance] > importanceRank[match.importance]
      ? character.importance
      : match.importance;
    match.fixedAppearance = mergeCharacterText(match.fixedAppearance, character.fixedAppearance, 1000);
    match.explicitTraits = mergeCharacterTraits(match.explicitTraits, character.explicitTraits);
    match.inferredTraits = mergeCharacterTraits(match.inferredTraits, character.inferredTraits);
  });

  return {
    characters: script ? normalized.map((character) => concretizeStoryboardCharacter(character, script)) : normalized,
    idMap,
  };
}

export function normalizeStoryboardPlanCharacterIdentities(plan: AiStoryboardPlan, script = ""): AiStoryboardPlan {
  if (!plan.projectBible?.characters.length) return plan;
  const { characters, idMap } = normalizeStoryboardCharacterIdentities(plan.projectBible.characters, script);
  return {
    ...plan,
    projectBible: {
      ...plan.projectBible,
      characters,
    },
    segments: plan.segments.map((segment) => ({
      ...segment,
      visualShots: segment.visualShots.map((shot) => ({
        ...shot,
        castIds: [...new Set(shot.castIds.map((id) => idMap[id] || id))],
      })),
    })),
  };
}

export type PublicCanvasPromptPreset = Pick<
  CanvasPromptPreset,
  "id" | "name" | "summary" | "category" | "accent" | "version"
>;

export type CompiledCharacterAsset = StoryboardCharacterIdentity & {
  order: number;
  referencePrompt: string;
};

export type CompiledStoryboardShot = {
  id: string;
  order: number;
  semanticOrder: number;
  visualOrder: number;
  narration: string;
  semanticNarration: string;
  semanticDurationSeconds: number;
  durationSeconds: number;
  targetDurationSeconds?: StoryboardTargetDurationSeconds;
  storyboardPanelCount?: 4 | 5;
  storyboardLayout?: StoryboardLayout;
  actualShotCount?: CanvasActualShotCount;
  shotTimeRanges?: StoryboardShotTimeRange[];
  pacingMode?: StoryboardPacingMode;
  panoramicAnchorRole?: string | null;
  visualMode: VisualShotMode;
  shotRole: z.infer<typeof VisualShotRoleSchema>;
  transition: z.infer<typeof ShotTransitionSchema>;
  castIds: string[];
  visualBeat: string;
  visibleProposition: string;
  evidenceLevel: VisualEvidenceLevel;
  directorDecision: string;
  cameraPlan: string;
  keyframeMoment: string;
  effectsPrompt: string;
  scenePrompt: string;
  imagePrompt: string;
  motionPrompt: string;
  soundPrompt: string;
  videoPrompt: string;
  editPrompt: string;
  qualityCriteria: string;
  endFramePrompt: string;
  referenceMode: "single" | "first-last";
};

const sharedCharacterRules = "先从全文提取全部常驻角色并分别编号，锁定每个角色的物种或年龄感、脸型、五官比例、发型发色、体型、固定服装款式与颜色、配饰、主色和辨识标记；宠物同时锁定毛色花纹、眼睛、耳形、口鼻、尾巴和项圈。没有明确换装剧情时全片沿用同一造型，后续镜头只能改变表情、姿态、机位和光影，不得把同一角色重新设计成另一张脸、另一发型或另一套衣服。";
const sharedSceneRules = "一个镜头只呈现一个连续时空中的可见场景，明确主体、状态、环境、前中后景、光线方向、色彩氛围和景别，不拼贴、不分屏、不把多个时间点塞进同一画面。";
const legacySharedNegativeRules = "禁止角色变脸、肢体变形、多余手指、主体漂移、突然换装、空间跳变、无关文字、水印、标志、拼贴、分屏和文案未提及的新事件。";
const sharedNegativeRules = "只保留必要底线：避免角色变脸、肢体变形、主体漂移、突然换装、无理由空间跳变、字幕、对话框、水印和无关可读文字；不要用过多禁止项限制构图、表演和动画创意。";

function cleanLegacyCreativeRestrictions(text: string) {
  return text
    .replace(/动物行为必须符合真实习性，不做过度拟人化的复杂表演。?/g, "")
    .replace(/动物行为必须符合真实习性。?/g, "")
    .replace(/不做过度拟人化的复杂表演。?/g, "")
    .replace(/禁止违背(?:真实)?动物习性的表情和动作。?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
const sharedFirstLastRules = "首帧描述动作开始前的稳定状态，尾帧描述同一场景内动作完成后的稳定状态；角色、镜位、光线和空间必须连续，中间只发生一个可解释的动作变化。";
const sharedCreativeExpressionRules = "旁白由后期画外音承担，角色必须依据本镜情绪强度进行有剧情目的的动画化表演，但不说话、不做对白口型。每镜先确定唯一语义或笑点节拍，再设计动作前势、表情转折、身体轮廓、反应停顿、叙事道具和环境反馈。逐镜必须明确一种表达模式：narrative只靠物理场景讲清具体动作；hybrid-packaging在完整物理场景中加入一组与内在状态、感知、速度、力量或认知转折直接绑定的非文字包装；semantic-cutaway只把记忆、时间、关系、认知或统计等非身体信息转为完整语义空间。身体机理必须使用完整正常主体旁的局部抽象放大窗。后两种模式的语义图形必须在关键帧里已经清楚可见，视频只动画化这组既有图形；角色参考图只能锁身份，不能携带情绪符号、剧情背景或特效覆盖本镜设计。";
const richCreativeExpressionRules = "画面丰富度来自剧情表演、构图变化、关键道具、环境反应、光影、材质与语义可视化共同作用。先选择narrative、hybrid-packaging或semantic-cutaway，再直接完成唯一方案。具体事件已由表演和道具讲清时使用narrative；物理场景成立但不可见状态仍需强调时使用hybrid-packaging；抽象知识、记忆、时间、关系、认知或统计本身就是核心信息时使用semantic-cutaway。包装只服务当前语义，写清绑定对象、空间位置、静态初始形态和运动落点；相邻镜头可以连续有包装，但不得连续复用同一种图形语法。";
const EMOTIONAL_SIGNAL_PATTERN = /(?:情感|抒情|温情|治愈|守护|守着|陪着|照顾|等待|思念|难过|失去|告别|父母|感动|安心|幸福|悲伤|依偎|陪伴)/gu;
const COMEDY_SIGNAL_COUNT_PATTERN = /(?:喜剧|搞笑|幽默|反差|吐槽|心机|拆家|翻车|社死|尴尬|心虚|万万没想到|老天|解释一下|下辈子|劝退|气笑|无奈|离谱|傻眼|懵|装傻|偷看|闯祸|咬坏|咬出|抱枕|棉絮|推到身后|钻进|探出)/gu;

function inferPerformancePlan(script: string, instruction = "") {
  const source = `${script}\n${instruction}`;
  const emotionalSignals = source.match(EMOTIONAL_SIGNAL_PATTERN)?.length || 0;
  const comedySignals = source.match(COMEDY_SIGNAL_COUNT_PATTERN)?.length || 0;
  if (emotionalSignals > comedySignals) {
    return { mode: "emotional" as const, bible: "情感抒情型；动作幅度克制而连续，重视视线、呼吸、重心、触碰和回应，镜头稳定流畅，装饰只在语义必要时轻量使用。" };
  }
  if (comedySignals > 0) {
    return { mode: "comedy" as const, bible: "喜剧反差型；动作响应快速、幅度较大但保持因果和连续，每镜只设计一个由情节或道具支撑的笑点，避免无关鬼脸和装饰。" };
  }
  if (/(?:第[一二三四五六七八九十0-9]+(?:种|个|条|点|项)|首先|其次|最后|清单|表现|迹象|信号)/u.test(source)) {
    return { mode: "dynamic" as const, bible: "轻快高动态型；动作响应和镜头跟随更快，信息落点清楚，保持预备、主动作、反应与落幅连贯，高动态不等同于喜剧。" };
  }
  return { mode: "natural" as const, bible: "叙事自然型；动作幅度、响应速度和镜头节奏随各段语义自适应，保持连续表演和可读反应，不强制喜剧或抒情。" };
}

const GRAPHIC_DECORATION_PATTERN = /(?:图形特效|图形装饰|图标|符号|问号|爱心|笑脸|速度线|轨迹|尾迹|弧线|弯线|曲线|生命曲线|放射线|震颤线|紧绷线|压力线|试探线|声波|粒子|气泡|旋涡|漩涡|光环|光点|光晕|警示光|提示光|星芒|卡通线条)/u;
const EXPLICIT_NO_GRAPHIC_DECORATION_PATTERN = /(?:【包装决策】\s*(?:不需要|无需|否|none)|【图形特效】\s*(?:无|不使用)|无额外图形装饰|无图形装饰|不(?:使用|添加|加入|生成|需要)(?:任何)?(?:额外)?(?:图形)?(?:装饰|特效)|不使用任何图标)/iu;
const NO_GRAPHIC_DECORATION_PROMPT = "【图形特效】无；本镜由剧情表演、叙事道具、环境反馈和光影完成表达，不额外添加图标或包装";

function cleanAnimeEffectsSourcePrompt(value: string) {
  return promptClause(value)
    .replace(/[，,；;][^，,；;。]{0,24}(?:避免|不(?:使用|加|加入|出现|展示|生成)?)[^，,；;。]*(?:文字|字幕|对话框|水印|夸张图标|卡通图标)[^，,；;。]*/gu, "")
    .replace(/[，,；;]?(?:避免|不(?:使用|加|加入|出现|展示|生成)?)[^，,；;。]*(?:文字|字幕|对话框|水印|夸张图标|卡通图标)[^，,；;。]*/gu, "")
    .replace(/[，,；;]?(?:画面|角色面部|面部区域|床边区域|其余区域)?保持(?:电影)?画面?干净(?:无文字)?/gu, "")
    .replace(/[，,；;]{2,}/g, "；")
    .replace(/^[，,；;\s]+|[，,；;\s]+$/g, "")
    .trim();
}

function compactSemanticLayerContent(value: string, maxLength: number) {
  return compactPromptContext(value, maxLength);
}

function compactAnimeSemanticLayers(source: string, _narrationContext: string) {
  const limits: Record<string, number> = {
    语义重点: 34,
    剧情表演: 46,
    叙事道具: 52,
    环境反馈: 46,
    图形特效: 52,
    语义缺口: 48,
    包装决策: 12,
    包装类型: 28,
    包装锚点: 28,
    绑定与位置: 60,
    静态初态: 60,
    动态延续: 60,
  };
  return Object.entries(limits).flatMap(([layer, limit]) => {
    const content = source.match(new RegExp(`【${layer}】([\\s\\S]*?)(?=【|$)`, "u"))?.[1]
      ?.replace(/^[，,；;。\s]+|[，,；;。\s]+$/g, "")
      .trim() || (layer === "语义重点" ? "当前事件、因果或情绪落点必须一眼可读" : layer === "图形特效" ? "无" : "");
    if (!content && !["语义重点", "剧情表演", "叙事道具", "环境反馈", "图形特效"].includes(layer)) return [];
    return [`【${layer}】${compactSemanticLayerContent(content, limit)}`];
  }).join("；");
}

function normalizeNoGraphicEvidence(value: string) {
  const graphicSection = value.match(/【图形特效】([\s\S]*)$/u)?.[1]?.trim() || "";
  const reason = graphicSection
    .replace(/^(?:无|不使用|不添加|不需要)(?:图形装饰|图形特效)?[，,；;。：:\s]*/u, "")
    .trim();
  const base = value
    .replace(/[；;]?【图形特效】[\s\S]*$/u, "")
    .replace(/[，,；;。\s]+$/g, "")
    .trim();
  const compactReason = compactSemanticLayerContent(reason, 48);
  return `${base}；【图形特效】无${compactReason ? `；${compactReason}` : "；表演、道具与环境证据已经足够"}`;
}

function resolveAnimeEffectsPrompt(
  primaryContext: string,
  narrationContext: string,
  sourcePrompt: string,
  level: VisualEffectsLevel,
  _respectExplicitNoGraphic: boolean,
) {
  const source = cleanAnimeEffectsSourcePrompt(sourcePrompt);
  const hasStructuredEvidence = ["剧情表演", "叙事道具", "环境反馈", "图形特效"]
    .every((layer) => source.includes(`【${layer}】`));
  const fallbackEvidence = [
    `【语义重点】${compactPromptContext(primaryContext, 34)}`,
    "【剧情表演】主体采用清楚、有张力的动作前势和可读表情，身体轮廓明确",
    `【叙事道具】${compactPromptContext(primaryContext, 50)}`,
    "【环境反馈】道具、衣料、毛发、光影或空间状态对主体动作产生可见且符合因果的反馈",
  ].join("；");
  const evidence = hasStructuredEvidence ? compactAnimeSemanticLayers(source, narrationContext) : fallbackEvidence;
  const explicitlyRejectsGraphics = EXPLICIT_NO_GRAPHIC_DECORATION_PATTERN.test(evidence);
  const sourceRejectsGraphics = EXPLICIT_NO_GRAPHIC_DECORATION_PATTERN.test(source);
  const sourceHasGraphicDirection = GRAPHIC_DECORATION_PATTERN.test(source)
    && !sourceRejectsGraphics
    && !hasStructuredEvidence;
  const hasGraphicDirection = (GRAPHIC_DECORATION_PATTERN.test(evidence) && !explicitlyRejectsGraphics)
    || sourceHasGraphicDirection;

  if (level === "none" || !hasGraphicDirection) {
    return normalizeNoGraphicEvidence(evidence);
  }

  if (sourceHasGraphicDirection) {
    return `${fallbackEvidence}；【图形特效】${compactPromptContext(source, 70)}`;
  }
  return evidence;
}

function usesAnimeGraphicDecoration(value: string) {
  const decision = value.match(/【包装决策】([\s\S]*?)(?=【|$)/u)?.[1]?.trim();
  if (decision && /^(?:不需要|无需|否|none)/iu.test(decision)) return false;
  const anchor = value.match(/【包装锚点】([\s\S]*?)(?=【|$)/u)?.[1]?.trim();
  if (anchor && !/^(?:无|none|不需要)/iu.test(anchor)) return true;
  const graphicSection = value.match(/【图形特效】([^【\r\n]+)/u)?.[1]?.trim();
  if (graphicSection) return !/^(?:无|不使用|不添加|不需要)/u.test(graphicSection);
  return GRAPHIC_DECORATION_PATTERN.test(value) && !EXPLICIT_NO_GRAPHIC_DECORATION_PATTERN.test(value);
}

function extractAnimePackagingAnchor(value: string) {
  const anchor = value.match(/【包装锚点】([\s\S]*?)(?=【|$)/u)?.[1]
    ?.replace(/^[，,；;。\s]+|[，,；;。\s]+$/g, "")
    .trim() || "";
  return /^(?:无|none|不需要)$/iu.test(anchor) ? "" : anchor;
}

function visualShotModeLabel(mode: VisualShotMode) {
  if (mode === "hybrid-packaging") return "剧情场景＋语义包装";
  if (mode === "semantic-cutaway") return "完整语义可视化";
  return "物理剧情场景";
}

function inferFallbackVisualMode(narration: string, effectsPrompt: string): VisualShotMode {
  const source = narration + " " + effectsPrompt;
  const hasGraphic = usesAnimeGraphicDecoration(effectsPrompt);
  if (
    hasGraphic
    && /(?:记忆|时间|关系|认知|意识|感知|神经|身体机理|寿命|概率|数据|统计|对比|因果|梦境|想象|内心世界)/u.test(source)
  ) {
    return "semantic-cutaway";
  }
  if (
    hasGraphic
    || /(?:疑惑|紧张|害怕|惊讶|震惊|速度|力量|冲击|心跳|预感|气味|视线|动作轨迹|心虚|发抖|僵住|藏|躲|逃|飞快|旋风|探头|试探|责备)/u.test(source)
  ) {
    return "hybrid-packaging";
  }
  return "narrative";
}

function promptClause(value: string) {
  return value.trim().replace(/[\s，,；;。.]+$/u, "");
}

function visualStyleClause(value: string) {
  return promptClause(value)
    .replace(/[；。]\s*视频只生成画面[\s\S]*$/u, "")
    .replace(/[；。]\s*旁白配音与字幕[\s\S]*$/u, "")
    .trim();
}

function appendFixedImageStyleSuffix(prompt: string, visualStyle: string) {
  const suffix = visualStyle.trim().replace(/[；;。\s]+$/u, "");
  const base = prompt.trim().split(suffix).join("").replace(/[；;。\s]+$/u, "");
  if (!suffix) return base;
  return `${base}${/[。！？!?]$/u.test(base) ? "" : "。"}${suffix}。`;
}

function motionActionClause(value: string) {
  return promptClause(value)
    .replace(/^目标\d+(?:\.\d+)?秒[，,:：]?\s*/u, "")
    .trim();
}

const MOTION_CHAIN_TAGS = ["入镜", "预备", "主动作", "反应", "落幅"] as const;
type MotionChainTag = typeof MOTION_CHAIN_TAGS[number];
type MotionChain = Record<MotionChainTag, string>;

const ANIMATION_PREPARATION_PATTERN = /(?:压低|下沉|后坐|收腹|缩肩|屈膝|蓄势|绷紧|抬爪|悬爪|重心.{0,8}(?:移|压|降|后撤)|身体.{0,8}(?:压缩|收紧|弓起))/u;
const ANIMATION_IMPACT_PATTERN = /(?:猛地|骤然|快速|急速|弹起|扑向|冲向|甩向|跳起|缩回|过冲|顿挫|急停|撞停|回弹|连锁|大幅|半个身长|明显后撤|明显前倾)/u;
const ANIMATION_BODY_CHANNEL_PATTERN = /(?:耳朵|双耳|眼神|视线|眼睛|眉眼|嘴角|嘴筒|颈背毛|毛发|重心|肩背|身体轮廓|尾巴|前爪|后爪|爪垫|手臂|双手|膝盖|道具|环境)/gu;

function extractTaggedMotionBeat(value: string, tag: MotionChainTag) {
  const tags = MOTION_CHAIN_TAGS.join("|");
  return value.match(new RegExp(`【${tag}】([\\s\\S]*?)(?=【(?:${tags})】|$)`, "u"))?.[1]
    ?.replace(/^[，,；;。\s]+|[，,；;。\s]+$/g, "")
    .trim() || "";
}

function hasCompleteMotionChain(value: string) {
  return MOTION_CHAIN_TAGS.every((tag) => extractTaggedMotionBeat(value, tag).length >= 4);
}

function auditAnimeMotionPerformance(value: string) {
  if (!hasCompleteMotionChain(value)) return [];
  const chain = Object.fromEntries(MOTION_CHAIN_TAGS.map((tag) => [tag, extractTaggedMotionBeat(value, tag)])) as MotionChain;
  const issues: string[] = [];
  if (!ANIMATION_PREPARATION_PATTERN.test(chain.预备)) issues.push("预备段没有改变重心、身体压缩或蓄势轮廓");
  if (!ANIMATION_IMPACT_PATTERN.test(chain.主动作)) issues.push("主动作没有明确速度/幅度与顿挫、过冲、回弹或连锁反应");
  const reactionChannels = new Set((`${chain.反应} ${chain.落幅}`.match(ANIMATION_BODY_CHANNEL_PATTERN) || []));
  if (reactionChannels.size < 2) issues.push("反应段没有联动至少两处身体、道具或环境反馈");
  return issues;
}

function resolveMotionChain(value: string): MotionChain {
  const normalized = motionActionClause(value);
  if (hasCompleteMotionChain(normalized)) {
    return Object.fromEntries(MOTION_CHAIN_TAGS.map((tag) => [tag, extractTaggedMotionBeat(normalized, tag)])) as MotionChain;
  }
  return {
    入镜: "沿用参考图中的角色位置、视线、道具状态、光线方向和空间关系稳定开演",
    预备: "主体先以清楚的视线、重心和身体轮廓形成动作前势",
    主动作: normalized,
    反应: "角色表情、叙事道具和环境状态对核心动作产生同步可见反馈",
    落幅: "动作减速并停在表情清楚、姿态稳定且可继续衔接的画面",
  };
}

function formatMotionChain(chain: MotionChain) {
  return MOTION_CHAIN_TAGS.map((tag) => `【${tag}】${chain[tag]}`).join("");
}

function extractAnimeSemanticLayer(value: string, layer: string) {
  return value.match(new RegExp(`【${layer}】([\\s\\S]*?)(?=【|$)`, "u"))?.[1]
    ?.replace(/^[，,；;。\s]+|[，,；;。\s]+$/g, "")
    .trim() || "";
}

export function composeStoryboardReferenceGenerationPrompt(prompt: string, referenceGuide: string) {
  return [
    "从空白画布生成一张完整分镜关键帧。参考图只锁定角色身份和固定外观，不继承参考图的背景、站姿、构图或排版。",
    referenceGuide,
    prompt,
    "完整保留上面描述的剧情动作、道具、场景和非文字视觉包装，不要退化成角色定妆照。",
  ].join("\n");
}

function buildImageCharacterLock(characterBible: string | undefined, fallbackSubject: string) {
  const cleaned = promptClause(characterBible || fallbackSubject)
    .replace(/^(?:剧情|内容|题材|作品)方向[：:][^。；]{2,80}[。；]\s*/u, "")
    .trim();
  const labeledCharacters = cleaned.match(/(?:主角|角色)\s*\d+[^。]*(?:。|$)/gu) || [];
  if (labeledCharacters.length > 0) {
    const roleLocks = labeledCharacters.slice(0, 6)
      .map((item) => compactPromptContext(item, 150))
      .filter(Boolean)
      .join("；");
    return compactPromptContext(roleLocks, 320);
  }
  const identityClauses = (cleaned.match(/[^。；]+[。；]?/gu) || [cleaned])
    .filter((item) => /(?:主角|角色|人物|主人|女孩|男孩|女性|男性|宠物|小狗|狗狗|猫咪|体型|毛色|发型|服装)/u.test(item));
  return compactPromptContext((identityClauses.slice(0, 6).join("") || cleaned || fallbackSubject), 320);
}

const STABLE_CHARACTER_TRAIT_PATTERN = /(?:中国|华人|东亚|亚洲|面孔|年龄|成年|幼年|发型|头发|毛色|毛发|花纹|五官|眼睛|瞳色|肤色|体型|身高|比例|服装|上衣|裤|裙|鞋|配饰|鼻|耳朵|尾巴|四肢)/u;

function characterReferenceIdentityText(character: StoryboardCharacterIdentity) {
  const explicitAppearance = character.explicitTraits.filter((trait) => STABLE_CHARACTER_TRAIT_PATTERN.test(trait));
  const inferredAppearance = character.inferredTraits.filter((trait) => STABLE_CHARACTER_TRAIT_PATTERN.test(trait));
  return [
    `${character.name}（${character.id}）`,
    character.fixedAppearance,
    explicitAppearance.length > 0 ? `原文明示外观：${explicitAppearance.join("、")}` : "",
    inferredAppearance.length > 0 ? `连续性外观：${inferredAppearance.join("、")}` : "",
  ].filter(Boolean).join("；");
}

function characterIdentityText(character: StoryboardCharacterIdentity) {
  return [
    `${character.name}（${character.id}）`,
    character.fixedAppearance,
    character.explicitTraits.length > 0 ? `原文明示：${character.explicitTraits.join("、")}` : "",
    character.inferredTraits.length > 0 ? `为连续制作补齐：${character.inferredTraits.join("、")}` : "",
  ].filter(Boolean).join("；");
}

function buildCharacterReferencePrompt(
  character: StoryboardCharacterIdentity,
  order: number,
  style: string,
  ratio: string,
) {
  const layoutRule = ratio === "16:9"
    ? "构图硬约束：输出16:9横屏纯角色图，画面宽度约为高度的1.78倍；角色按横向画布重新排布，禁止竖版人物页、方图、旋转画布或用留白伪装横屏。"
    : `构图硬约束：输出${ratio}纯角色图，不得改成其他画幅。`;
  const anatomyRule = character.kind === "person"
    ? "物种与解剖硬约束：画面中只允许1名自然人类，必须是正常人类头部、脸、双手和双脚；禁止动物头、犬科口吻、全身毛发、兽爪、尾巴、兽化或人兽混合。"
    : character.kind === "animal"
      ? "物种与解剖硬约束：画面中只允许1只上述具体品种动物，保持天然四足结构和真实犬科/猫科比例；禁止人类躯干、直立双足、人手人脚、人类服装、拟人职业造型或人兽混合。"
      : "主体硬约束：画面中只允许1个上述具体资产，不复制、不成组、不生成多视图。";
  return [
    `角色定妆图：角色${String(order).padStart(2, "0")}｜${character.name}｜${ratio}`,
    `身份锁定：${characterReferenceIdentityText(character)}`,
    `统一动画风格：${style}`,
    layoutRule,
    anatomyRule,
    "制作规范：一张图只出现这一个角色；整张图严格只出现一个身体、一个头，不得复制第二个同款角色；采用正面略带四分之三角度的三分之二全身定妆姿态，脸部、眼睛、发型或毛色花纹、体型、固定服装配饰和辨识标记清楚可见。",
    "背景与表演：干净中性棚拍背景、均匀柔光、准确色彩、自然放松表情；这是纯角色图，不是角色设定说明页、海报或信息卡；画面内不得出现中文、英文、数字、标题、标签、说明、序号、水印或任何可读文字；不放入剧情场景、叙事道具、环境反应、动作特效、问号、爱心或速度线；不拼贴、不分屏、不生成同一角色的多视图。",
    "用途：本图只作为后续关键帧的身份参考；后续镜头必须重新构图，不复制本图背景、站姿或机位。",
  ].join("\n");
}

function compactShotCharacterAppearance(value: string) {
  return value
    .replace(/，?作为全片固定角色保持同一身份、体型、脸型或毛色花纹[。；]?/gu, "，固定身份、体型与外观")
    .trim();
}

function buildShotCharacterLock(
  characters: CompiledCharacterAsset[],
  castIds: string[],
  characterBible: string | undefined,
  fallbackSubject: string,
) {
  const cast = castIds
    .map((id) => characters.find((character) => character.id === id))
    .filter((character): character is CompiledCharacterAsset => Boolean(character));
  if (cast.length > 0) {
    const multipleCharacters = cast.length > 1;
    const maxLockLength = multipleCharacters ? 120 : 160;
    const appearanceLength = multipleCharacters ? 42 : 125;
    return compactPromptContext(
      cast.map((character) => (
        `${character.name}（${character.id}）：${compactPromptContext(compactShotCharacterAppearance(character.fixedAppearance), appearanceLength)}`
      )).join("；"),
      maxLockLength,
    );
  }
  return buildImageCharacterLock(characterBible, fallbackSubject);
}

const FORBIDDEN_GENERATED_AUDIO_PATTERN = /(?:背景音乐|配乐|BGM|伴奏|歌曲|歌声|口播|旁白|配音|对白|说话声|人物说话|字幕)/iu;

function soundClause(value: string, narration: string) {
  const positiveClauses = promptClause(value)
    .replace(/^(?:仅|只)保留/u, "")
    .split(/[；。\n]/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => !FORBIDDEN_GENERATED_AUDIO_PATTERN.test(clause));
  return compactPromptContext(
    positiveClauses.join("、") || createFallbackSoundPrompt(narration),
    120,
  );
}

const DANGLING_PROMPT_TAIL_PATTERN = /(?:但|并|且|和|与|或|把|被|由|将|仅用于)$/u;

function stripDanglingPromptTail(value: string) {
  let cleaned = value.replace(/[，,、：:；。！？!?\s]+$/u, "").trim();
  if (!DANGLING_PROMPT_TAIL_PATTERN.test(cleaned)) return cleaned;
  cleaned = cleaned.replace(DANGLING_PROMPT_TAIL_PATTERN, "").trim();
  return cleaned.replace(/[，,、：:；。！？!?\s]+$/u, "").trim();
}

function compactPromptContext(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  const clauses = normalized.match(/[^。；！？!?]+[。；！？!?]?/gu) || [normalized];
  let result = "";
  for (const clause of clauses) {
    if (`${result}${clause}`.length > maxLength) break;
    result += clause;
  }
  if (result) return stripDanglingPromptTail(result);

  const withinBudget = normalized.slice(0, maxLength);
  const secondaryBoundaries = [...withinBudget.matchAll(/[，,、：:]/gu)];
  const preferredBoundary = secondaryBoundaries
    .map((match) => (match.index || 0) + match[0].length)
    .filter((index) => index >= Math.floor(maxLength * 0.55))
    .at(-1);
  if (preferredBoundary) {
    return stripDanglingPromptTail(withinBudget.slice(0, preferredBoundary));
  }

  const nextBoundaryOffset = normalized.slice(maxLength).search(/[，,、：:。；！？!?]/u);
  const allowedOverflow = Math.min(36, Math.max(12, Math.ceil(maxLength * 0.3)));
  if (maxLength <= 120 && normalized.length <= maxLength + allowedOverflow) {
    return normalized;
  }
  if (nextBoundaryOffset >= 0 && nextBoundaryOffset <= allowedOverflow) {
    return stripDanglingPromptTail(normalized.slice(0, maxLength + nextBoundaryOffset + 1));
  }

  const clipped = stripDanglingPromptTail(normalized.slice(0, Math.max(1, maxLength - 1)));
  return clipped ? `${clipped}…` : normalized.slice(0, maxLength);
}

function getEffectsRule(level: VisualEffectsLevel) {
  if (level === "none") return "不使用图形特效，但剧情表演、叙事道具、环境反馈、构图和光影仍必须完整且有张力。";
  return level === "rich" ? richCreativeExpressionRules : sharedCreativeExpressionRules;
}

function buildStyleContinuityRule(style: string) {
  const isRealisticStyle = /(真人|真实风|写实|摄影|实拍|live[-\s]?action|realistic|photographic)/iu.test(style);
  if (isRealisticStyle) {
    return `视觉风格与影像质感必须保持：${style}；延续系统自动关键帧中的主体身份、材质质感、灯光方向、色彩层次和镜头语言，不因为进入视频阶段而改成3D动画、平面插画或其他风格。`;
  }
  return `动画风格与渲染必须保持：${style}；延续系统自动关键帧中的角色设计、材质质感、灯光方向、色彩层次、镜头语言和整体动画观感，不因为进入视频阶段而改成写实摄影、平面插画或其他风格。`;
}

const presetContents: Record<string, PromptPresetContent> = {
  anime_story: {
    directorPrompt: ANIME_DIRECTOR_CORE_PROMPT,
    segmentationRules: "按正常口播速度拆成语义完整的短句，目标每镜3到5秒。每段口播只对应一张参考图和一个视频。",
    characterRules: "先把常驻人物和宠物写成具体视觉资产，明确品种或地域外观、年龄、体型、毛色或五官、固定服装和识别点。不得用“同一个人、同一只狗、那个角色”代替具体描述。角色定妆图只锁身份，不带剧情、道具和装饰。",
    sceneRules: "每镜只演当前口播的一件事。相邻镜头通过事件、动作、道具状态或视线自然衔接，并改变景别、机位或构图，避免重复摆拍。",
    imageRules: "把动作将要发生、表情和剧情证据最清楚的一刻写成可直接生图的静态画面。具体写角色、姿态、道具、场景、构图、光影和材质；若本句存在肉眼看不见但值得强化的情绪、感知、因果或知识点，自然设计一组非文字视觉包装，并写清位置和静态形态。不要解释设计目的，不写动态时间线。",
    motionRules: "从参考图当前姿态开始，每镜只安排一个核心动作和一种主要运镜，动作有预备、发生、反应和停稳。道具、环境与参考图中已有装饰随表演响应。",
    videoRules: "用大白话直接命令角色怎么演、道具和已有装饰怎么动、镜头怎么跟、最后停在哪里。不要重述整张静态图，不要解释系统和工作流。只保留现场动作音和环境音。",
    negativeRules: "避免角色变脸、变形、换装、无因换场、重复摆拍、字幕、对话框、水印和无关文字。",
    firstLastFrameRules: sharedFirstLastRules,
  },
  warm_story: {
    directorPrompt: "",
    segmentationRules: "先分析完整事件链，再按场景、核心行动、观点和情绪转折划分分镜。每段必须可直接配音，按每秒约6个有效汉字估算，目标18到30字、3到5秒；语义完整优先，允许少量超字。每个分镜只对应一个视频方案、一张自动关键帧和一个视频。",
    characterRules: sharedCharacterRules,
    sceneRules: `${sharedSceneRules} 优先使用中近景、特写、低机位、反应镜头和生活化环境细节承载情绪，避免所有镜头都像同一张居中插画。`,
    imageRules: "画面要有商业动画电影质感，表情和眼神清晰，主体状态具体，环境细节服务情绪；构图温暖、层次明确，自动关键帧必须是可直接作为视频首帧的单一静态瞬间。每张图至少包含主体动作前势、视线方向、前中后景层次或关键道具线索中的两项。图形包装不是必选项，只有能准确强化当前动作或情绪时才使用。",
    motionRules: "每个镜头围绕一个连续动作选择合适运镜；不要默认只用稳定中景推近，应根据语义选择贴近特写、低机位跟拍、轻微横移、主观视角、反应切入或缓慢后拉。用表情、呼吸、耳朵、手部、姿态和光影变化表现情绪，并允许按语义加入轻弹、闪亮、情绪线等动画包装。",
    videoRules: "保持角色、场景和道具连续，动作自然完整，镜头结尾停在清晰可剪辑的稳定画面；不得为了热闹增加原文没有的行为。",
    negativeRules: sharedNegativeRules,
    firstLastFrameRules: sharedFirstLastRules,
  },
  pet_knowledge: {
    directorPrompt: "",
    segmentationRules: "宠物故事板按用户固定分段执行，不重分段、不改写原文。支持8秒每段3镜头、10秒每段3至4镜头、15秒每段4至6镜头；8秒保留钩子、冲突和结论，10秒增加机制或判断揭示，15秒增加升级爆点、二次反转或情绪停留。每个分镜只对应一段口播、一张故事板参考图、一条视频提示词和一个视频。",
    characterRules: "默认年轻亚洲女主人，黄色时尚短款连帽卫衣或轻运动休闲上衣、蓝色牛仔裤或休闲裤、白色运动鞋，商业3D动画角色气质；同一条视频内服装稳定，可按主人性别或场景只做克制微调。原文只写狗狗、小狗或狗时，默认三色柯基犬；只有原文、用户选择或特殊备注明确犬种时才改为金毛、哈士奇、泰迪、比熊、中华田园犬等其他品种。狗狗保持自然四足犬类结构，可拟人化情绪但不过度拟人化：允许瞪眼、耳朵变化、尾巴反馈、后缩、靠近主人、惊恐、委屈、好奇表情；禁止狗狗长手、站着走路、招手、拿工具、穿成人服装或变成人形。",
    sceneRules: "场景必须根据文案语义推断，不默认室外大马路；可在家里、客厅、小区、公园、宠物店、室内护理、宠物健康中心等空间之间合理变化。每镜只演当前口播的一件事，环境要帮助观众识别触发、误解、危险、检查、护理、保护或结论；涉及健康、医院、伤口、私密部位时使用外部中景、图标、贴纸、示意面板和抽象符号安全表达。",
    imageRules: "自由画布输出必须区分生图提示词和视频提示词。生图提示词只写画面中能看见的角色、姿态、道具、场景、构图、光影、材质和语义包装。图文注释版用于校准，一图多格可带很短中文镜头说明；纯画面参考版用于图生视频，必须把说明条、小字、字幕和导演注释改成图标、无字牌面、箭头、颜色区或空间锚点。高能包装按语义触发：疑问用问号/放大镜，误解用错接线/错位标签，危险用警示牌/警戒线，结论用金色结论牌/绿色勾选章，反转用红黑爆裂牌/裂片翻转，情绪压力用光晕/压迫阴影/震动线，知识重点用安全示意面板/图标/箭头；包装必须绑定角色动作、道具接触、视线、脚步、牵引绳、食盆、放大镜、称重盘或环境反馈。",
    motionRules: "运镜以观察感、亲近感和高能因果为主。每段按目标时长组织真实镜头：8秒钩子建立、冲突爆点、结论落幅；10秒钩子、冲突升级、机制/判断揭示、结论落幅；15秒钩子、冲突、升级爆点或二次反转、机制/正确动作、关系/结论落幅。动作从触发到反应要完整，道具按来源可见、取出或拾起、持有移动、接触或接触前停住、释放或放回的路径调度，包装按出现、增强、接触或改变、收束的生命周期运动。",
    videoRules: "视频提示词必须是执行口令，只写参考图怎样动起来：秒级动作链、实际镜头数、运镜、道具路径、包装生命周期、现场声和落幅；不得出现配音语义、口播、旁白、智能体思考、语义判断过程或解释性文字。用户后期配音，视频不得出现人物开口说话、旁白、字幕朗读、对白或配乐；只允许场景音、动作音、道具音、环境音。保持角色、场景、道具和参考图包装连续，不新增参考图没有的主体或无因特效。",
    negativeRules: "避免角色变脸、肢体变形、主体漂移、突然换装、无理由换场、狗狗人形化、人物或宠物说话口型、字幕朗读、旁白、配音、背景音乐、水印、无关可读文字、血腥伤口、私密部位和令人不适的身体局部特写。",
    firstLastFrameRules: sharedFirstLastRules,
  },
  cinematic_realism: {
    directorPrompt: "",
    segmentationRules: "按照场景、人物目标、行动、视线关系和叙事转折划分分镜。每段只处理一个完整叙事目标，按每秒约6个有效汉字估算，目标18到30字、3到5秒；语义完整优先，允许少量超字。每个分镜只对应一张关键帧和一个连续视频。",
    characterRules: `${sharedCharacterRules} 按用户选择的视觉风格保持角色身份、比例、材质和年龄或物种特征一致。`,
    sceneRules: `${sharedSceneRules} 明确镜头焦段感、景深、主光方向和空间方向。`,
    imageRules: "采用电影级镜头语言，主体状态、动作前势、环境材质、光源、色温、景别和构图必须具体；最终画面质感以用户选择的视觉风格为准，避免摆拍感。",
    motionRules: "根据情绪选择固定、推拉、摇移或跟拍中的一种主要运动，速度和人物动作匹配；镜头有起幅、运动和落幅。",
    videoRules: "维持清晰运动逻辑、动作惯性和光影连续，避免镜头无目的漂移；成片应具有可剪辑的动作衔接点。",
    negativeRules: `${sharedNegativeRules} 禁止不合理材质、过度磨皮、悬浮物体和不合理景深。`,
    firstLastFrameRules: sharedFirstLastRules,
  },
  fast_marketing: {
    directorPrompt: "",
    segmentationRules: "按卖点、证据、使用动作、结果和行动号召划分分镜。每段只表达一个完整卖点或动作链，按每秒约6个有效汉字估算，目标18到30字、3到5秒；语义完整优先，允许少量超字。每个分镜只对应一个产品画面、一张关键帧和一个视频，快节奏通过分镜间剪辑实现。",
    characterRules: `${sharedCharacterRules} 产品外观、包装、品牌色和关键结构必须全片一致。`,
    sceneRules: `${sharedSceneRules} 背景简洁，产品和使用动作拥有最高视觉优先级。`,
    imageRules: "采用高完成度商业广告画面，产品轮廓、材质、高光和使用场景清楚；构图直接，视觉焦点唯一，并保留适度版式留白。",
    motionRules: "动作简洁有力，优先产品推进、快速跟随、受控环绕或细节特写；每个镜头只使用一种主要运镜，结尾形成明确卖点定格。",
    videoRules: "节奏明快但主体稳定，产品外观不得改变；动作必须服务卖点，镜头首尾均保留可剪辑的稳定帧。",
    negativeRules: `${sharedNegativeRules} 禁止产品结构改变、包装文字乱码、无关装饰抢占主体。`,
    firstLastFrameRules: sharedFirstLastRules,
  },
};

const presetMeta = [
  ["anime_story", "动漫剧情专用", "动漫剧情智能体专用的文案拆镜、视频方案与自动关键帧规则", "动漫", "#7c5ce7"],
  ["warm_story", "通用叙事", "按事件、观点和情绪转折拆文案，适合故事、科普和生活内容", "叙事", "#d66a45"],
  ["pet_knowledge", "萌宠科普", "按宠物行为因果拆文案，适合宠物知识和行为解说", "宠物", "#1b9b8a"],
  ["cinematic_realism", "人物剧情", "按人物目标、冲突和行动拆文案，适合短剧和品牌故事", "剧情", "#3e72b8"],
  ["fast_marketing", "产品营销", "按卖点、证据和转化动作拆文案，适合产品和带货短片", "营销", "#b64d7c"],
] as const;

function createBuiltInCanvasPromptPreset(
  [id, name, summary, category, accent]: (typeof presetMeta)[number],
  now: string,
): CanvasPromptPreset {
  return CanvasPromptPresetSchema.parse({
    id,
    name,
    summary,
    category,
    accent,
    enabled: true,
    version: 1,
    primaryModel: id === "anime_story" ? "gpt-5.6-sol" : "gpt-5.4",
    fallbackModel: id === "anime_story" ? "gpt-5.4" : "gpt-5.6-sol",
    promptContractVersion: id === "anime_story" ? "anime-director-v1" : "legacy",
    directorTemplateVersion: id === "anime_story" ? ANIME_DIRECTOR_TEMPLATE_VERSION : "legacy",
    draft: presetContents[id],
    published: presetContents[id],
    history: [],
    updatedAt: now,
    publishedAt: now,
  });
}

export function createDefaultCanvasPromptPresetStore(now = new Date().toISOString()): CanvasPromptPresetStore {
  return CanvasPromptPresetStoreSchema.parse({
    schemaVersion: 1,
    updatedAt: now,
    presets: presetMeta.map((meta) => createBuiltInCanvasPromptPreset(meta, now)),
  });
}

export function parseCanvasPromptPresetStore(value: unknown): CanvasPromptPresetStore {
  const upgradeLegacyRules = (store: CanvasPromptPresetStore) => {
    const migrationTime = new Date().toISOString();
    for (const meta of presetMeta) {
      if (!store.presets.some((preset) => preset.id === meta[0])) {
        store.presets.push(createBuiltInCanvasPromptPreset(meta, migrationTime));
      }
    }
    for (const preset of store.presets) {
      const builtIn = presetContents[preset.id];
      const builtInMeta = presetMeta.find(([id]) => id === preset.id);
      if (builtInMeta) {
        const [, name, summary, category] = builtInMeta;
        preset.name = name;
        preset.summary = summary;
        preset.category = category;
      }
      if (
        !preset.primaryModel
        || (preset.primaryModel === "gpt-5.6-terra" && preset.fallbackModel === "gpt-5.4")
        || (preset.primaryModel === "gpt-5.6-sol" && preset.fallbackModel === "gpt-5.6-terra")
        || (preset.primaryModel === "gpt-5.6-sol" && preset.fallbackModel === "gpt-5.4")
      ) {
        preset.primaryModel = "gpt-5.4";
        preset.fallbackModel = "gpt-5.6-sol";
      }
      if (preset.id === "anime_story") {
        preset.primaryModel = "gpt-5.6-sol";
        preset.fallbackModel = "gpt-5.4";
      }
      if (preset.id === "cinematic_realism") {
        if (preset.name === "电影写实分镜" || preset.name === "电影镜头分镜" || preset.name === "剧情品牌分镜") preset.name = "人物剧情";
        if (preset.category === "写实" || preset.category === "镜头") preset.category = "剧情";
      }
      const migrateAnimeDirectPromptContract = preset.id === "anime_story"
        && preset.promptContractVersion !== "anime-director-v1";
      const migrateAnimeDirectorTemplate = preset.id === "anime_story"
        && preset.directorTemplateVersion !== ANIME_DIRECTOR_CUSTOM_TEMPLATE_VERSION
        && preset.directorTemplateVersion !== ANIME_DIRECTOR_TEMPLATE_VERSION;
      for (const content of [preset.draft, preset.published]) {
        if (
          migrateAnimeDirectPromptContract
          || migrateAnimeDirectorTemplate
          || (preset.id === "anime_story" && !content.directorPrompt?.trim())
        ) {
          content.directorPrompt = ANIME_DIRECTOR_CORE_PROMPT;
        }
        (Object.keys(content) as Array<keyof PromptPresetContent>).forEach((key) => {
          content[key] = cleanLegacyCreativeRestrictions(content[key]);
        });
        if (content.negativeRules.includes(legacySharedNegativeRules)) {
          content.negativeRules = content.negativeRules.replace(legacySharedNegativeRules, sharedNegativeRules);
        }
        if (builtIn && /每秒4到6|优先2到5秒|18到3[268]|多10到20字|不少于3秒|旁白时长与动作时长|只由一个连续画面承载|每个分镜只处理一个叙事目标|每个分镜只表达一个完整卖点|(?:1到3|1至3|2到4|2至4)个(?:连续)?视觉镜头|展开1到3个|同一口播段可用/.test(content.segmentationRules)) {
          content.segmentationRules = builtIn.segmentationRules;
        }
        if (preset.id === "cinematic_realism" && builtIn && /(真实人体比例|写实摄影语言|塑料皮肤|真实物理)/.test([
          content.characterRules,
          content.imageRules,
          content.videoRules,
          content.negativeRules,
        ].join("\n"))) {
          content.characterRules = builtIn.characterRules;
          content.sceneRules = builtIn.sceneRules;
          content.imageRules = builtIn.imageRules;
          content.motionRules = builtIn.motionRules;
          content.videoRules = builtIn.videoRules;
          content.negativeRules = builtIn.negativeRules;
          content.firstLastFrameRules = builtIn.firstLastFrameRules;
        }
        if (preset.id === "warm_story" && builtIn && !content.motionRules.includes("不要默认只用稳定中景推近")) {
          content.sceneRules = builtIn.sceneRules;
          content.imageRules = builtIn.imageRules;
          content.motionRules = builtIn.motionRules;
          content.videoRules = builtIn.videoRules;
          content.negativeRules = builtIn.negativeRules;
        }
        if (preset.id === "pet_knowledge" && builtIn && (
          !content.segmentationRules.includes("8秒每段3镜头")
          || !content.videoRules.includes("执行口令")
          || !content.characterRules.includes("黄色时尚短款连帽卫衣")
          || !content.imageRules.includes("图文注释版")
        )) {
          content.segmentationRules = builtIn.segmentationRules;
          content.characterRules = builtIn.characterRules;
          content.sceneRules = builtIn.sceneRules;
          content.imageRules = builtIn.imageRules;
          content.motionRules = builtIn.motionRules;
          content.videoRules = builtIn.videoRules;
          content.negativeRules = builtIn.negativeRules;
          content.firstLastFrameRules = builtIn.firstLastFrameRules;
        }
        content.videoRules = content.videoRules.replace("给剪辑和字幕留出稳定画面", "给剪辑留出稳定画面");
        content.imageRules = content.imageRules.replace("为字幕和卖点文案预留安全区域", "并保留适度版式留白");
      }
      if (migrateAnimeDirectPromptContract) preset.promptContractVersion = "anime-director-v1";
      if (migrateAnimeDirectorTemplate) preset.directorTemplateVersion = ANIME_DIRECTOR_TEMPLATE_VERSION;
    }
    return store;
  };

  if (typeof value === "string") {
    try {
      return upgradeLegacyRules(CanvasPromptPresetStoreSchema.parse(JSON.parse(value)));
    } catch {
      return createDefaultCanvasPromptPresetStore();
    }
  }
  const parsed = CanvasPromptPresetStoreSchema.safeParse(value);
  return parsed.success ? upgradeLegacyRules(parsed.data) : createDefaultCanvasPromptPresetStore();
}

const MIN_PREFERRED_SHOT_CHARS = 10;
const TARGET_SHOT_CHARS = 24;
const MAX_PREFERRED_SHOT_CHARS = 32;
const MAX_ACCEPTED_SEGMENT_CHARS = 36;

export function countReadableCharacters(text: string) {
  return text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").length;
}

function compactScript(script: string) {
  return script.trim().replace(/\s+/g, "");
}

function splitByReadableLength(text: string, targetChars = TARGET_SHOT_CHARS) {
  const chunks: string[] = [];
  let current = "";
  let readableCount = 0;
  for (const char of Array.from(text)) {
    current += char;
    if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(char)) readableCount += 1;
    const reachedNaturalBoundary = readableCount >= targetChars && /[。！？!?，,；;：:]$/.test(current);
    const reachedHardLimit = readableCount >= MAX_ACCEPTED_SEGMENT_CHARS;
    if (reachedNaturalBoundary || reachedHardLimit) {
      chunks.push(current);
      current = "";
      readableCount = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

function endsWithDanglingLeadIn(text: string) {
  const lastSentencePart = text.split(/[。！？!?]/).at(-1) || "";
  return countReadableCharacters(lastSentencePart) <= 12
    && /^(但|但是|不过|而|而是|所以|因为|如果|当|这时|这时候|久而久之|慢慢地|再|甚至|虽然|为了|于是|然后|同时|是一个|就是|也就是|原因是|关键是|比如|例如)[^。！？!?]*[，,；;：:]$/.test(lastSentencePart);
}

function startsWithContinuation(text: string) {
  return /^(但|但是|不过|而|而是|所以|因为|如果|这时|这时候|于是|然后|同时|就是|也就是|原因是|关键是|比如|例如|结果|往往)/.test(text);
}

function endsWithSoftPunctuation(text: string) {
  return /[，,；;：:]$/.test(text);
}

export function splitScriptSemantically(
  script: string,
  targetChars = TARGET_SHOT_CHARS,
  tolerance = MAX_PREFERRED_SHOT_CHARS - TARGET_SHOT_CHARS,
): string[] {
  const compacted = compactScript(script);
  if (!compacted) return [];
  const clauses = compacted.match(/[^。！？!?，,；;：:]+[。！？!?，,；;：:]?/g) || [compacted];
  const segments: string[] = [];
  let current = "";
  for (const clause of clauses) {
    if (countReadableCharacters(clause) > targetChars + tolerance) {
      if (current) {
        segments.push(current);
        current = "";
      }
      segments.push(...splitByReadableLength(clause, targetChars));
      continue;
    }

    const next = `${current}${clause}`;
    const currentChars = countReadableCharacters(current);
    const nextChars = countReadableCharacters(next);
    const currentIsCloserToTarget = Math.abs(currentChars - targetChars) <= Math.abs(nextChars - targetChars);
    const shouldKeepSemanticPair = endsWithDanglingLeadIn(current)
      || (endsWithSoftPunctuation(current) && startsWithContinuation(clause) && nextChars <= MAX_PREFERRED_SHOT_CHARS);
    const shouldSplit = current
      && currentChars >= MIN_PREFERRED_SHOT_CHARS
      && !shouldKeepSemanticPair
      && nextChars > targetChars
      && (currentIsCloserToTarget || nextChars > targetChars + tolerance);
    if (shouldSplit) {
      segments.push(current);
      current = clause;
    } else {
      current = next;
    }
  }
  if (current) segments.push(current);

  if (segments.length > 1 && countReadableCharacters(segments.at(-1) || "") < MIN_PREFERRED_SHOT_CHARS) {
    const tail = segments.pop() || "";
    const previous = segments.pop() || "";
    if (countReadableCharacters(`${previous}${tail}`) <= MAX_ACCEPTED_SEGMENT_CHARS) {
      segments.push(`${previous}${tail}`);
    } else {
      const previousClauses = previous.match(/[^。！？!?，,；;：:]+[。！？!?，,；;：:]?/g) || [previous];
      let balancedTail = tail;
      while (previousClauses.length > 1 && countReadableCharacters(balancedTail) < MIN_PREFERRED_SHOT_CHARS) {
        balancedTail = `${previousClauses.pop() || ""}${balancedTail}`;
      }
      const balancedPrevious = previousClauses.join("");
      if (balancedPrevious && countReadableCharacters(balancedPrevious) >= MIN_PREFERRED_SHOT_CHARS) {
        segments.push(balancedPrevious, balancedTail);
      } else {
        segments.push(previous, tail);
      }
    }
  }
  return (segments.length > 0 ? segments : [compacted]).filter(Boolean);
}

export function estimateStoryboardDuration(text: string) {
  const readableChars = countReadableCharacters(text);
  return Math.max(3, Math.min(5, Math.round(readableChars / 6)));
}

function hasExactCoverage(script: string, segments: Array<{ narration: string }>) {
  const explicitNarrations = extractSegmentedNarrations(script);
  const sourceText = explicitNarrations.length >= 2 ? explicitNarrations.join("") : script;
  return compactScript(segments.map((segment) => segment.narration).join("")) === compactScript(sourceText);
}

function mergeShortSegments(segments: string[]) {
  const merged = [...segments];
  let index = 0;
  while (merged.length > 1 && index < merged.length) {
    const danglingLeadIn = endsWithDanglingLeadIn(merged[index]);
    if (danglingLeadIn && index + 1 < merged.length) {
      merged[index] = `${merged[index]}${merged[index + 1]}`;
      merged.splice(index + 1, 1);
      continue;
    }

    if (countReadableCharacters(merged[index]) >= MIN_PREFERRED_SHOT_CHARS && !danglingLeadIn) {
      index += 1;
      continue;
    }

    if (index === 0) {
      if (countReadableCharacters(`${merged[0]}${merged[1]}`) <= MAX_ACCEPTED_SEGMENT_CHARS) {
        merged[1] = `${merged[0]}${merged[1]}`;
        merged.splice(0, 1);
      } else {
        index += 1;
      }
      continue;
    }

    const previousLength = countReadableCharacters(merged[index - 1]);
    const nextLength = index + 1 < merged.length ? countReadableCharacters(merged[index + 1]) : Number.POSITIVE_INFINITY;
    const canMergePrevious = previousLength + countReadableCharacters(merged[index]) <= MAX_ACCEPTED_SEGMENT_CHARS;
    const canMergeNext = nextLength + countReadableCharacters(merged[index]) <= MAX_ACCEPTED_SEGMENT_CHARS;
    if (canMergePrevious && (!canMergeNext || previousLength <= nextLength)) {
      merged[index - 1] = `${merged[index - 1]}${merged[index]}`;
      merged.splice(index, 1);
      index = Math.max(0, index - 1);
    } else if (canMergeNext) {
      merged[index + 1] = `${merged[index]}${merged[index + 1]}`;
      merged.splice(index, 1);
    } else {
      index += 1;
    }
  }
  return merged;
}

export function normalizeStoryboardSegments(
  script: string,
  proposed?: Array<{ narration: string; durationSeconds: number }>,
) {
  const explicitSegments = extractSegmentedNarrations(script);
  if (explicitSegments.length >= 2) {
    return explicitSegments.map((narration) => ({
      narration,
      durationSeconds: estimateStoryboardDuration(narration),
    }));
  }
  const proposedNarrations = proposed?.map((segment) => segment.narration.trim()).filter(Boolean) || [];
  const sourceSegments = proposedNarrations.length > 0 && hasExactCoverage(script, proposed || [])
    ? proposedNarrations
    : splitScriptSemantically(script);
  const compacted = compactScript(script);
  const safeSegments = sourceSegments.length > 0 ? sourceSegments : compacted ? [compacted] : [];
  return mergeShortSegments(safeSegments).flatMap((segment) => (
    countReadableCharacters(segment) > MAX_PREFERRED_SHOT_CHARS
      ? splitScriptSemantically(segment)
      : [segment]
  )).map((narration) => ({
    narration,
    durationSeconds: estimateStoryboardDuration(narration),
  }));
}

const ABSTRACT_PROMPT_DELEGATION_PATTERN = /(?:依据|根据)(?:原文|文案|语义|内容)(?:进行)?(?:选择|决定|安排|匹配|设计|生成)?|承接(?:原文|文案|语义|核心信息)|与[“"]?[^。；\r\n”"]{4,24}[”"]?(?:直接)?对应|选择(?:一个|一种)(?:生活化|合适|主要|对应)?(?:场景|镜头|机位|运镜|构图|光线)|自行(?:决定|选择|补充)|由模型(?:决定|选择)|让模型(?:决定|选择)/u;
const DYNAMIC_STATIC_PROMPT_PATTERN = /(?:随后|逐渐|最后|前半段|后半段|时间轴|\d+(?:\.\d+)?\s*[-—至到]\s*\d+(?:\.\d+)?\s*秒|镜头[^。；\r\n]{0,10}(?:推|拉|摇|移|环绕)|(?:用于|供|作为)(?:后续)?视频|视频(?:运动|动画|只做)|画入关键帧)/u;
const VIDEO_ACTION_PATTERN = /(?:抬|低|压|转|扑|冲|跑|走|退|停|躲|看|盯|眨|闻|嗅|咬|叼|推|拉|掩|藏|踩|抓|拍|甩|摇|抖|颤|缩|伸|探|跳|落|撞|碰|翻|滚|滑|张开|闭上|收紧|松开|回头|起身|趴下|蹲下|站起|挥动|抛出|接住|擦拭|吞咽|吐出|弹开|倒下)/gu;
const VIDEO_CAMERA_PATTERN = /(?:镜头|机位|跟拍|跟随|推进|推近|拉远|平移|摇摄|环绕|俯拍|仰拍|低机位|主观视角|固定景别)/u;
const VIDEO_ENDING_PATTERN = /(?:最后|结尾|落幅|停在|停住|停稳|稳定停留|收住动作|定格|收束)/u;
const POSITIVE_SPEECH_PERFORMANCE_PATTERN = /(?:开口|张嘴|嘴唇|唇形|口型|嘴巴)[^。；，,]{0,10}(?:说|讲|念|朗读|同步|开合|一张一合)|(?:对着镜头|面对镜头|转向镜头)[^。；，,]{0,10}(?:说|讲|念)|(?:说出|讲出|念出|开口讲话|张嘴说话|对白口型|对口型)/u;
const NEGATED_SPEECH_PERFORMANCE_PATTERN = /(?:不|无|禁止|避免|不得|不能|切勿)[^。；，,]{0,12}(?:说话|讲话|对白|念词|口型|嘴唇同步|嘴巴开合)/u;
const DIRECTOR_DECISION_LABELS = ["可见命题", "角色目标", "阻碍或异常", "核心动作", "可见结果", "镜头抓手"] as const;
const PACKAGING_DECISION_LABELS = ["语义缺口", "包装决策", "包装类型", "包装锚点", "绑定与位置", "静态初态", "动态延续"] as const;
const HIDDEN_SEMANTIC_PATTERN = /(?:害怕|恐惧|紧张|心虚|发懵|懵住|疑惑|困惑|犹豫|试探|心跳|怦怦|心动|爱慕|好感|恋爱|相爱|爱上|喜欢上|信任|敌意|嫉妒|依恋|疏远|关系(?:变化|转折|升温|破裂)?|嗅觉|气味|感知|预感|压力|焦虑)/u;
const RELATIONSHIP_SEMANTIC_PATTERN = /(?:心动|爱慕|好感|恋爱|相爱|爱上|喜欢上|信任|敌意|嫉妒|依恋|疏远|关系(?:变化|转折|升温|破裂)?)/u;
const ROMANTIC_SEMANTIC_PATTERN = /(?:心动|爱慕|恋爱|相爱|爱上|喜欢上|关系升温)/u;
const CONFUSION_SEMANTIC_PATTERN = /(?:发懵|懵住|懵逼|疑惑|困惑|不明白|不理解|搞不懂)/u;
const BODY_MECHANISM_PATTERN = /(?:肠道|肠胃|胃部|消化|内脏|器官|肾脏|肾功能|肝脏|血管|神经|呼吸系统|泌尿系统|身体机理)/u;

function containsPositiveSpeechPerformance(value: string) {
  return value.split(/[。；\n]/u).some((clause) => (
    POSITIVE_SPEECH_PERFORMANCE_PATTERN.test(clause)
    && !NEGATED_SPEECH_PERFORMANCE_PATTERN.test(clause)
  ));
}

function missingStructuredLabels(value: string, labels: readonly string[]) {
  return labels.filter((label) => !new RegExp(`【${label}】[^【\\r\\n]+`, "u").test(value));
}
const CONCRETE_IMAGE_PROMPT_PATTERNS = [
  /(?:姿态|表情|视线|眼神|眼睛|重心|耳朵|尾巴|手部|前爪|后爪|轮廓|外观|材质|毛发|侧卧|站立|坐姿|伏在|躺在|抬头|低头|动作前势)/u,
  /(?:特写|近景|中景|全景|低机位|高机位|俯拍|仰拍|平视|侧面|广角|长焦|焦段)/u,
  /(?:晨光|窗光|侧光|逆光|轮廓光|体积光|暖光|冷光|柔光|顶光|光线|光影|照亮|透入|色温|色彩|高光)/u,
  /(?:前景|中景|背景|景深|空间纵深|遮挡|层次)/u,
  /(?:卧室|客厅|门口|走廊|床|窗|沙发|地板|街道|食盆|玩具|包装|产品|道具|环境)/u,
];

function normalizedReadableText(value: string) {
  return value.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/gu, "");
}

const NARRATION_EVIDENCE_GROUPS = [
  { label: "检查动作", source: /(?:检查|查看|观察|确认)/u, target: /(?:检查|查看|观察|确认|掰开|翻看|照亮)/u },
  { label: "口鼻证据", source: /(?:嘴巴|口腔|牙齿|口鼻)/u, target: /(?:嘴巴|口腔|牙齿|口鼻|嘴角|犬嘴)/u },
  { label: "地面证据", source: /(?:地面|地板|地毯)/u, target: /(?:地面|地板|地毯)/u },
  { label: "碎片证据", source: /(?:碎片|碎屑|棉花|棉絮|残渣)/u, target: /(?:碎片|碎屑|棉花|棉絮|残渣|破损|破洞)/u },
  { label: "收纳处理", source: /(?:装袋|袋子|收起|清理)/u, target: /(?:装袋|袋子|收起|清理|拾起|收纳)/u },
  { label: "兽医联系", source: /(?:宠物医生|兽医|医院|就医)/u, target: /(?:宠物医生|兽医|医院|就医|电话|手机)/u },
  { label: "玩具证据", source: /(?:玩具|抱枕|毛绒玩偶)/u, target: /(?:玩具|抱枕|毛绒玩偶|咬胶)/u },
  { label: "耐咬橡胶", source: /(?:耐咬|橡胶|咬胶)/u, target: /(?:耐咬|橡胶|咬胶|硬质玩具)/u },
  { label: "吞食风险", source: /(?:误吞|吞下|吞食|吃进)/u, target: /(?:误吞|吞下|吞食|吃进|嘴边|口鼻|吞咽)/u },
  { label: "消化机理", source: /(?:胃部|肠道|消化|内脏)/u, target: /(?:胃部|肠道|消化|腹部|局部放大窗|教学窗)/u },
  { label: "堵塞后果", source: /(?:堵塞|阻塞|越积越紧)/u, target: /(?:堵塞|阻塞|堆积|挤压|减速|短直通道)/u },
  { label: "水果食物", source: /(?:水果|葡萄|苹果|桃|李子|牛油果|巧克力|食物)/u, target: /(?:水果|葡萄|苹果|桃|李子|牛油果|巧克力|食物|果肉|果核)/u },
  { label: "害怕紧张", source: /(?:害怕|紧张|心慌|发抖|恐惧)/u, target: /(?:害怕|紧张|心慌|发抖|恐惧|耳朵压低|尾巴僵|颤线|心跳)/u },
  { label: "疑惑茫然", source: /(?:疑惑|懵|茫然|不明白)/u, target: /(?:疑惑|懵|茫然|歪头|问号|视线游移)/u },
  { label: "隐藏掩饰", source: /(?:躲|藏|掩饰|心虚|装作)/u, target: /(?:躲|藏|掩饰|心虚|装乖|斜瞟|压在身后)/u },
] as const;

function missingNarrationEvidence(narration: string, prompt: string) {
  const required = NARRATION_EVIDENCE_GROUPS.filter((group) => group.source.test(narration));
  if (required.length < 2) return [];
  const missing = required.filter((group) => !group.target.test(prompt));
  return missing.length / required.length >= 0.6 ? missing.map((group) => group.label) : [];
}

function readableNgrams(value: string, size = 4) {
  const normalized = normalizedReadableText(value);
  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function promptSimilarity(left: string, right: string) {
  const leftGrams = readableNgrams(left);
  const rightGrams = readableNgrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let overlap = 0;
  leftGrams.forEach((gram) => {
    if (rightGrams.has(gram)) overlap += 1;
  });
  return (2 * overlap) / (leftGrams.size + rightGrams.size);
}

function containsNarrationExcerpt(prompt: string, narration: string) {
  const promptText = normalizedReadableText(prompt);
  const narrationText = normalizedReadableText(narration);
  if (!narrationText) return false;
  if (narrationText.length < 18) return narrationText.length >= 10 && promptText.includes(narrationText);
  const windowSize = 18;
  for (let index = 0; index <= narrationText.length - windowSize; index += 6) {
    if (promptText.includes(narrationText.slice(index, index + windowSize))) return true;
  }
  return false;
}

export function auditStoryboardImagePrompt(prompt: string, narration = "", maxLength = 500) {
  const issues: string[] = [];
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length < 80) issues.push("少于80字，关键帧信息不足");
  if (normalized.length > maxLength) issues.push(`超过${maxLength}字，执行重点容易被稀释`);
  if (ABSTRACT_PROMPT_DELEGATION_PATTERN.test(normalized)) issues.push("包含把导演决定再次交给模型的抽象委托");
  if (DYNAMIC_STATIC_PROMPT_PATTERN.test(normalized)) issues.push("静态生图提示词混入时间过程或运镜");
  if (narration && containsNarrationExcerpt(normalized, narration)) issues.push("直接复制口播原句，没有转成可见画面");
  const concreteDimensions = CONCRETE_IMAGE_PROMPT_PATTERNS.filter((pattern) => pattern.test(normalized)).length;
  if (concreteDimensions < 4) issues.push("主体状态、机位、光线、空间层次或场景道具不够具体");
  return issues;
}

function sanitizeStoryboardStaticPrompt(value: string) {
  return value
    .replace(/\d+(?:\.\d+)?\s*[-—至到]\s*\d+(?:\.\d+)?\s*秒[^，,。；;\r\n]*/gu, "")
    .replace(/(?:随后|逐渐|最后|前半段|后半段)/gu, "")
    .replace(/[，,；;]?\s*镜头(?:开始)?(?:缓慢|快速|轻微|平稳)?(?:推|拉|摇|移|环绕)[^，,。；;\r\n]*/gu, "")
    .replace(/[，,；;]{2,}/gu, "；")
    .replace(/\s+/gu, " ")
    .replace(/^[，,；;。\s]+|[，,；;\s]+$/gu, "")
    .trim();
}

export function repairAiStoryboardPlanStaticPrompts(plan: AiStoryboardPlan) {
  const repairs: string[] = [];
  const repaired = {
    ...plan,
    segments: plan.segments.map((segment, segmentIndex) => ({
      ...segment,
      visualShots: segment.visualShots.map((shot, shotIndex) => {
        const cleanedKeyframe = sanitizeStoryboardStaticPrompt(shot.keyframeMoment);
        const cleanedImagePrompt = shot.imagePrompt
          ? sanitizeStoryboardStaticPrompt(shot.imagePrompt)
          : undefined;
        const keyframeMoment = cleanedKeyframe.length >= 50 ? cleanedKeyframe : shot.keyframeMoment;
        let imagePrompt = cleanedImagePrompt && cleanedImagePrompt.length >= 80
          ? cleanedImagePrompt
          : shot.imagePrompt;
        if (imagePrompt) {
          const currentImagePrompt = imagePrompt;
          const concreteDimensions = CONCRETE_IMAGE_PROMPT_PATTERNS.filter((pattern) => pattern.test(currentImagePrompt)).length;
          if (concreteDimensions < 4) {
            imagePrompt = `${imagePrompt}；静态摄影补全：主体保持当前动作前势、表情与视线，采用平视中近景和柔和侧光，前景道具、中景主体、背景环境形成清楚景深层次。`;
          }
        }
        let videoPrompt = shot.videoPrompt;
        if (videoPrompt && !VIDEO_ENDING_PATTERN.test(videoPrompt)) {
          const settle = extractTaggedMotionBeat(shot.motionPrompt, "落幅") || "动作减速并稳定停在表情与姿态清楚的可剪辑画面";
          videoPrompt = `${videoPrompt}；最后${settle}。`;
        }
        if (keyframeMoment !== shot.keyframeMoment || imagePrompt !== shot.imagePrompt || videoPrompt !== shot.videoPrompt) {
          repairs.push(`口播段${segmentIndex + 1}镜头${shotIndex + 1}已清除静态关键帧中的时间过程或运镜描述`);
        }
        return { ...shot, keyframeMoment, imagePrompt, videoPrompt };
      }),
    })),
  };
  return { plan: AiStoryboardPlanSchema.parse(repaired), repairs };
}

export function auditAiStoryboardPlanUsability(
  script: string,
  plan: AiStoryboardPlan,
  options: {
    requireMotionChain?: boolean;
    requireFinalPrompts?: boolean;
    targetDurationSeconds?: StoryboardTargetDurationSeconds;
  } = {},
) {
  const issues: string[] = [];
  const totalChars = countReadableCharacters(script);
  const storyTargetDurationSeconds = options.targetDurationSeconds
    ? normalizeCanvasStoryTargetDuration(options.targetDurationSeconds)
    : undefined;
  const characters = plan.projectBible?.characters || [];
  const characterIds = new Set(characters.map((character) => character.id));
  if (characters.length === 0) issues.push("全片没有结构化角色资产");
  if (characterIds.size !== characters.length) issues.push("结构化角色ID存在重复");
  if (normalizeStoryboardCharacterIdentities(characters, script).characters.length !== characters.length) {
    issues.push("同一角色被别名或关系称呼拆成多个角色资产");
  }
  if (!hasExactCoverage(script, plan.segments)) issues.push("口播分段没有逐字连续覆盖原文");
  if (plan.promptContractVersion === "anime-director-v1") {
    const storyPlan = plan.projectBible?.storyPlan;
    if (!storyPlan) {
      issues.push("动漫导演没有先把口播转换成全片无对白故事");
    } else {
      if (storyPlan.beats.length !== plan.segments.length) issues.push("故事节拍数量与口播分镜数量不一致");
      if (storyPlan.beats.some((beat, index) => beat.order !== index + 1)) issues.push("故事节拍顺序不连续");
      const normalizedEvents = storyPlan.beats.map((beat) => beat.event.replace(/[\s，,。；;：:]/gu, ""));
      if (new Set(normalizedEvents).size !== normalizedEvents.length) issues.push("多个口播分镜重复使用同一个故事事件");
      storyPlan.beats.forEach((beat, index) => {
        const prefix = `故事节拍${index + 1}`;
        if (beat.entryState.length < 4) issues.push(`${prefix}缺少可执行入场状态`);
        if (beat.resultState.length < 4) issues.push(`${prefix}缺少动作造成的结果状态`);
        if (beat.handoffToNext.length < 4) issues.push(`${prefix}缺少交给下一镜的连续性锚点`);
      });
    }
  }
  plan.segments.forEach((segment, segmentIndex) => {
    const prefix = `口播段${segmentIndex + 1}`;
    const chars = countReadableCharacters(segment.narration);
    const calculatedDuration = estimateStoryboardDuration(segment.narration);
    const visualDuration = segment.visualShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
    if (chars < MIN_PREFERRED_SHOT_CHARS && totalChars >= MIN_PREFERRED_SHOT_CHARS) issues.push(`${prefix}少于${MIN_PREFERRED_SHOT_CHARS}个有效字`);
    if (!storyTargetDurationSeconds && chars > MAX_ACCEPTED_SEGMENT_CHARS) issues.push(`${prefix}超过${MAX_ACCEPTED_SEGMENT_CHARS}个有效字`);
    if (!storyTargetDurationSeconds && segment.durationSeconds !== calculatedDuration) issues.push(`${prefix}标注时长与每秒6字的计算结果不一致`);
    if (segment.visualShots.length !== 1) issues.push(`${prefix}必须严格对应1个视觉镜头`);
    if (!storyTargetDurationSeconds && calculatedDuration > 5) issues.push(`${prefix}口播时长超过5秒`);
    if (!storyTargetDurationSeconds && Math.abs(visualDuration - calculatedDuration) > 0.75) issues.push(`${prefix}镜头总时长${visualDuration}秒与口播${calculatedDuration}秒不闭合`);
    if (new Set(segment.visualShots.map((shot) => shot.visualBeat.trim())).size !== segment.visualShots.length) issues.push(`${prefix}存在重复视觉任务`);
    segment.visualShots.forEach((shot, shotIndex) => {
      const shotPrefix = `${prefix}镜头${shotIndex + 1}`;
      if (shot.castIds.length === 0) issues.push(`${shotPrefix}没有声明出场角色`);
      const unknownCastIds = shot.castIds.filter((id) => !characterIds.has(id));
      if (unknownCastIds.length > 0) issues.push(`${shotPrefix}引用未知角色：${unknownCastIds.join("、")}`);
      if (new Set(shot.castIds).size !== shot.castIds.length) issues.push(`${shotPrefix}重复引用同一角色`);
      const staticPrompt = shot.imagePrompt || shot.keyframeMoment;
      const complexStaticPrompt = shot.castIds.length > 1 || BODY_MECHANISM_PATTERN.test(segment.narration);
      const imageIssues = auditStoryboardImagePrompt(staticPrompt, segment.narration, complexStaticPrompt ? 760 : 600);
      if (imageIssues.length > 0) issues.push(`${shotPrefix}生图提示词：${imageIssues.join("、")}`);
      const missingEvidence = missingNarrationEvidence(
        segment.narration,
        [shot.visualBeat, shot.visibleProposition, shot.keyframeMoment, shot.scenePrompt, shot.effectsPrompt, staticPrompt].filter(Boolean).join(" "),
      );
      if (missingEvidence.length > 0) {
        issues.push(`${shotPrefix}最终图片提示词：没有落实本段口播中的具体语义证据（${missingEvidence.join("、")}）`);
      }
      if (options.requireFinalPrompts && !shot.imagePrompt?.trim()) issues.push(`${shotPrefix}缺少最终imagePrompt`);
      if (options.requireFinalPrompts && !shot.videoPrompt?.trim()) issues.push(`${shotPrefix}缺少最终videoPrompt`);
      if (options.requireFinalPrompts && plan.promptContractVersion === "anime-director-v1") {
        const missingDirectorLabels = missingStructuredLabels(shot.directorDecision || "", DIRECTOR_DECISION_LABELS);
        if (missingDirectorLabels.length > 0) issues.push(`${shotPrefix}导演决策卡缺少${missingDirectorLabels.join("、")}`);
        const missingPackagingLabels = missingStructuredLabels(shot.effectsPrompt, PACKAGING_DECISION_LABELS);
        if (missingPackagingLabels.length > 0) issues.push(`${shotPrefix}语义包装决策缺少${missingPackagingLabels.join("、")}`);
        if (!shot.qualityCriteria?.trim()) issues.push(`${shotPrefix}缺少可执行的失败重生成标准`);
      }
      if (shot.videoPrompt) {
        if (shot.videoPrompt.length > 800) issues.push(`${shotPrefix}视频提示词超过800字`);
        if (containsNarrationExcerpt(shot.videoPrompt, segment.narration)) issues.push(`${shotPrefix}最终视频提示词复制口播原文`);
        if (/(?:上游|节点|自动开关键|系统(?:自动)?生成|不得绕过|执行层|生成协议|本节点|无需用户|画布解析器)/u.test(shot.videoPrompt)) {
          issues.push(`${shotPrefix}最终视频提示词混入系统或画布说明`);
        }
        if (ABSTRACT_PROMPT_DELEGATION_PATTERN.test(shot.videoPrompt)) issues.push(`${shotPrefix}最终视频提示词仍把导演决定交给模型`);
        const actionCount = shot.videoPrompt.match(VIDEO_ACTION_PATTERN)?.length || 0;
        if (actionCount < 2) issues.push(`${shotPrefix}最终视频提示词缺少有先后关系的具体动作`);
        if (!VIDEO_CAMERA_PATTERN.test(shot.videoPrompt)) issues.push(`${shotPrefix}最终视频提示词缺少明确运镜`);
        if (!VIDEO_ENDING_PATTERN.test(shot.videoPrompt)) issues.push(`${shotPrefix}最终视频提示词缺少稳定落幅`);
        if (/(?:视频提示词[：:]\s*分镜|(?:上游|自动)参考图|角色锁定|首帧与风格|完整风格设定)/u.test(shot.videoPrompt)) {
          issues.push(`${shotPrefix}最终视频提示词仍像系统说明书`);
        }
        if (containsPositiveSpeechPerformance(shot.videoPrompt)) issues.push(`${shotPrefix}角色出现讲话、念词或对白口型`);
      }
      const packagingAnchor = extractAnimePackagingAnchor(shot.effectsPrompt);
      if (packagingAnchor && (!staticPrompt.includes(packagingAnchor) || !shot.videoPrompt?.includes(packagingAnchor))) {
        issues.push(`${shotPrefix}包装锚点“${packagingAnchor}”没有逐字同时进入参考图和视频提示词`);
      }
      if (HIDDEN_SEMANTIC_PATTERN.test(segment.narration) && !usesAnimeGraphicDecoration(shot.effectsPrompt)) {
        issues.push(`${shotPrefix}口播包含不可直接看见的心理、感知或关系语义，但没有给出可执行包装证据`);
      }
      if (RELATIONSHIP_SEMANTIC_PATTERN.test(segment.narration) && shot.visualMode === "narrative") {
        issues.push(`${shotPrefix}关系语义不能只拍普通剧情，必须把双方之间的变化转成可见包装`);
      }
      const finalPromptBundle = `${shot.effectsPrompt} ${staticPrompt} ${shot.videoPrompt || ""}`;
      if (ROMANTIC_SEMANTIC_PATTERN.test(segment.narration) && !/(?:桃心|爱心|心形)/u.test(finalPromptBundle)) {
        issues.push(`${shotPrefix}恋爱或心动语义缺少观众可瞬间识别的桃心/心形母符号`);
      }
      if (CONFUSION_SEMANTIC_PATTERN.test(segment.narration) && !/(?:问号|疑问符号)/u.test(finalPromptBundle)) {
        issues.push(`${shotPrefix}疑惑语义缺少观众可瞬间识别的问号母符号`);
      }
      if (BODY_MECHANISM_PATTERN.test(segment.narration)) {
        const packagingType = extractAnimeSemanticLayer(shot.effectsPrompt, "包装类型");
        if (packagingType !== "local-inset") issues.push(`${shotPrefix}身体机理必须使用安全的局部教学放大窗（local-inset）`);
      }
      if (shot.visualMode && shot.visualMode !== "narrative" && !usesAnimeGraphicDecoration(shot.effectsPrompt)) {
        issues.push(`${shotPrefix}已声明${visualShotModeLabel(shot.visualMode)}，但没有可执行的语义包装方案`);
      }
      if (shot.motionPrompt.includes(segment.narration)) issues.push(`${shotPrefix}视频提示词复制口播原文`);
      if (ABSTRACT_PROMPT_DELEGATION_PATTERN.test(shot.motionPrompt)) issues.push(`${shotPrefix}视频提示词仍把导演决定交给模型`);
      if (/(?:选择一种(?:主要)?运镜|低机位跟拍、[^。；]+(?:或|、)[^。；]+(?:或|、))/u.test(shot.motionPrompt)) issues.push(`${shotPrefix}视频提示词包含未决定的运镜菜单`);
      if (/(旁白|配音|字幕)/u.test(shot.motionPrompt)) issues.push(`${shotPrefix}视频动作混入旁白、配音或字幕`);
      if (options.requireMotionChain && !hasCompleteMotionChain(shot.motionPrompt)) issues.push(`${shotPrefix}缺少入镜、预备、主动作、反应、落幅五段动作链`);
      if (options.requireMotionChain && plan.promptContractVersion === "anime-director-v1") {
        const performanceIssues = auditAnimeMotionPerformance(shot.motionPrompt);
        if (performanceIssues.length > 0) issues.push(`${shotPrefix}动画表演强度不足：${performanceIssues.join("、")}`);
      }
      if (/(?:旁白|配音|对白|说话声|字幕|背景音乐|配乐|BGM)/iu.test(shot.soundPrompt || "")) issues.push(`${shotPrefix}声音设计混入后期配音、对白、字幕或音乐`);
    });
  });
  if (options.requireFinalPrompts) {
    const shotRows = plan.segments.map((segment, index) => ({
      order: index + 1,
      narration: segment.narration,
      shot: segment.visualShots[0],
    })).filter((row) => Boolean(row.shot?.imagePrompt));
    for (let index = 0; index < shotRows.length; index += 1) {
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
        const current = shotRows[index];
        const previous = shotRows[previousIndex];
        if (current.narration === previous.narration) continue;
        const currentSignature = [
          current.shot.visualBeat,
          current.shot.visibleProposition,
          current.shot.keyframeMoment,
          current.shot.scenePrompt,
          current.shot.imagePrompt,
        ].filter(Boolean).join(" ");
        const previousSignature = [
          previous.shot.visualBeat,
          previous.shot.visibleProposition,
          previous.shot.keyframeMoment,
          previous.shot.scenePrompt,
          previous.shot.imagePrompt,
        ].filter(Boolean).join(" ");
        const similarity = promptSimilarity(currentSignature, previousSignature);
        if (similarity >= 0.86) {
          issues.push(`口播段${current.order}镜头1最终图片提示词：与口播段${previous.order}高度重复（相似度${Math.round(similarity * 100)}%），没有形成独立可见事件`);
          break;
        }
      }
    }
  }
  return [...new Set(issues)];
}

export function isAiStoryboardPlanUsable(
  script: string,
  plan: AiStoryboardPlan,
  options: {
    requireMotionChain?: boolean;
    requireFinalPrompts?: boolean;
    targetDurationSeconds?: StoryboardTargetDurationSeconds;
  } = {},
) {
  return auditAiStoryboardPlanUsability(script, plan, options).length === 0;
}

function fallbackShotRole(index: number, shotCount: number) {
  if (index === 0) return shotCount > 1 ? "setup" as const : "evidence" as const;
  if (index === shotCount - 1) return "payoff" as const;
  return "reaction" as const;
}

function fallbackCharacterKind(name: string): StoryboardCharacterIdentity["kind"] {
  if (/(?:猫|狗|犬|边牧|金毛|宠物|动物)/u.test(name)) return "animal";
  if (/(?:主人|人物|女人|男人|女士|先生|女孩|男孩|妈妈|爸爸|师傅)/u.test(name)) return "person";
  if (/(?:产品|商品|包装|设备)/u.test(name)) return "product";
  return "other";
}

function fallbackCharacterAliases(name: string, kind: StoryboardCharacterIdentity["kind"]) {
  const base = name.replace(/^同一(?:只|位|个)/u, "").trim();
  if (kind === "animal") {
    const dogAliases = /(?:狗|犬|边牧|金毛)/u.test(base) ? ["狗狗", "小狗", "它"] : [];
    const catAliases = /猫/u.test(base) ? ["猫咪", "小猫", "它"] : [];
    return uniqueCharacterLabels([base, ...dogAliases, ...catAliases]);
  }
  if (kind === "person") {
    const genderAliases = /女/u.test(base) ? ["女主人", "主人", "她", "我"]
      : /男/u.test(base) ? ["男主人", "主人", "他", "我"]
        : /主人/u.test(base) ? ["主人", "我"] : [];
    return uniqueCharacterLabels([base, ...genderAliases]);
  }
  return uniqueCharacterLabels([base]);
}

function createFallbackCharacter(name: string, index: number, narration: string): StoryboardCharacterIdentity {
  const kind = fallbackCharacterKind(name);
  const normalizedName = name.replace(GENERIC_CONTINUITY_PREFIX, "").trim();
  return concretizeStoryboardCharacter({
    id: `character-${index + 1}`,
    name: normalizedName,
    aliases: fallbackCharacterAliases(normalizedName, kind),
    kind,
    importance: index === 0 ? "primary" : "supporting",
    fixedAppearance: `${normalizedName}的具体外观尚未由原文明示，需要根据剧情语义补齐可重复生成的品种、年龄、体型、五官、毛发或服装识别点。`,
    explicitTraits: [normalizedName],
    inferredTraits: [],
  }, narration);
}

function extractFallbackCharacters(narration: string, assistantInstruction?: string) {
  const explicitLabels = [...(assistantInstruction || "").matchAll(/同一(?:只|位|个)[^和与；。，,\n]{1,30}/gu)]
    .map((match) => match[0].trim());
  const mentionedLabels = [...narration.matchAll(/(?:圆润|肥胖|圆滚滚|修长|年幼|成年)?(?:边境牧羊犬|边牧|橘白猫|橘猫|胖猫|猫咪|金毛犬|金毛|狗狗|小狗|女主人|男主人|主人|女孩|男孩|维修师傅)/gu)]
    .map((match) => match[0].trim());
  const labels = uniqueCharacterLabels(explicitLabels.length > 0 ? explicitLabels : mentionedLabels).slice(0, 4);
  return (labels.length > 0 ? labels : ["原文中的固定主体"])
    .map((name, index) => createFallbackCharacter(name, index, narration));
}

function extractFallbackSubject(narration: string, assistantInstruction?: string) {
  return extractFallbackCharacters(narration, assistantInstruction)[0]?.name || "原文中的固定主体";
}

type FallbackShotDirection = {
  visualBeat: string;
  keyframe?: string;
  scene: string;
  effects: string;
  motion: string;
};

type FallbackDirection = FallbackShotDirection & {
  followUps?: FallbackShotDirection[];
};

function createFallbackDirection(narration: string, subject: string): FallbackDirection {
  const isDogStory = /(?:狗|犬)/u.test(`${narration}${subject}`);
  const dog = /(?:金黄|金毛)/u.test(subject)
    ? "2岁中型金毛寻回犬，天然四足比例、金黄色中长毛、深棕眼睛、黑色鼻头和下垂耳"
    : /(?:哈士奇|柯基|泰迪|贵宾|比熊|拉布拉多|边牧|边境牧羊犬)/u.test(subject)
      ? subject.replace(/^同一(?:只|位|个)/u, "").trim()
      : "2岁黄白柯基犬，天然四足比例、短腿长身、竖耳、深棕眼睛和黑色鼻头";
  const owner = /女主人/u.test(subject)
    ? "成年中国女性主人，东亚面孔、深棕长发、浅色居家睡衣"
    : "成年中国主人，东亚面孔、深色短发、简洁居家服";

  if (
    isDogStory
    && /(?:咬坏|咬出|咬破|抱枕|玩具|棉花|棉絮|碎棉|破洞)/u.test(narration)
    && !/(?:开门|脚步|听见|推到身后|贴平|尾巴僵住|飞快|冲|钻进|旋风|小旋风|逃|探出|探头|鼻尖|确认|心软|消气)/u.test(narration)
  ) {
    return {
      visualBeat: `${dog}守在被咬坏的抱枕或玩具旁，破损棉絮成为第一叙事证据，身体却正在装作若无其事`,
      keyframe: `低机位中近景，${dog}停在被咬坏的抱枕旁，一只前爪压住外翻布边，嘴角闭紧，眼神斜瞟门口方向，耳朵一高一低，尾巴僵住；前景散落棉絮和咬痕清晰，中景狗狗身体有明显动作前势`,
      scene: "同一温暖客厅，沙发、地毯、门口和被咬坏的抱枕形成清楚空间关系，暖色侧光照亮棉絮、布料纤维和狗狗毛发，背景保持浅景深",
      effects: "狗狗头侧和前爪旁加入两道暖黄橙半透明狡黠弯线，破损抱枕边缘保留极淡冷白提示光，绑定心虚掩饰和物理证据，不出现文字",
      motion: "镜头从散落棉絮轻推到狗狗前爪和表情，狗狗悄悄把破布往身后拨半寸，耳朵快速压低又抬起，狡黠弯线短促上挑后变淡，最终停在装乖僵持画面",
    };
  }

  if (isDogStory && /(?:开门|脚步|主人.*来|听见|贴平|耳朵|尾巴僵住|发抖|僵住|心虚)/u.test(narration)) {
    return {
      visualBeat: `${dog}听见${owner}靠近后瞬间僵住，心虚和害怕必须通过耳朵、尾巴、身体重心和胸前紧绷线同时可见`,
      keyframe: `门口方向带来轻微压迫感的客厅中近景，${dog}半蹲在破损道具旁，耳朵贴平，尾巴僵直贴腿，胸口前倾却不敢动，眼神斜看门口；前景保留棉絮或破布作为罪证`,
      scene: "同一客厅门口与沙发之间的连续空间，门外冷光和室内暖光形成压力方向，地毯上棉絮、爪印和布料碎片清楚可见",
      effects: "狗狗胸口前方加入低饱和红橙半透明紧绷线，沿呼吸方向向内收缩；门口方向加入两道很淡声波弧线，绑定脚步声和被发现的紧张，不出现文字",
      motion: "镜头先停在门口声波方向，再轻推到狗狗胸口和眼神；狗狗身体细颤、耳朵后压、尾巴僵住，胸前紧绷线随呼吸短促回弹，最后停在不敢动的僵住姿态",
    };
  }

  if (
    isDogStory
    && /(?:藏|躲|推到身后|沙发底|门后|钻进|躲开|回避)/u.test(narration)
    && !/(?:飞快|冲|旋风|小旋风|逃|探出|探头|鼻尖|确认|心软|消气)/u.test(narration)
  ) {
    return {
      visualBeat: `${dog}试图把破损证据藏到身后或沙发底下，观众必须同时看见证据、藏匿动作和心虚视线`,
      keyframe: `低机位侧向中景，${dog}身体斜挡在破损抱枕或布料前，一只前爪正把棉絮往沙发底下推，头却扭向${owner}所在方向，耳朵后贴，眼白微露；前景棉絮半露不露`,
      scene: "同一客厅沙发底边区域，沙发下沿、地毯、散落棉絮和门口方向保持连续，暖光照亮外露证据，沙发底形成可藏匿的阴影空间",
      effects: "破损证据到狗狗前爪之间使用一条贴地暖橙遮掩弧线，狗狗视线方向保留短促冷白压力线，绑定藏匿意图和被看见的风险",
      motion: "固定低机位轻微横移，狗狗用前爪把棉絮和破布推向沙发底，动作突然停住并抬眼偷看主人，遮掩弧线随前爪移动后贴地消退",
    };
  }

  if (
    isDogStory
    && /(?:飞快|冲|跑|钻进|一阵|旋风|小旋风|逃|门后|沙发底下)/u.test(narration)
    && !/(?:探出|探头|鼻尖|确认|心软|消气)/u.test(narration)
  ) {
    return {
      visualBeat: `${dog}抓住空隙突然冲向可躲藏位置，速度感来自身体前倾、爪垫抓地和贴地旋流尾迹`,
      keyframe: `低机位广角中景，${dog}后腿深压、前爪外张抓地，身体重心已经朝沙发底下或门后方向弹出，嘴里或身后带着半截破损道具；${owner}在一侧刚要反应但还没追上`,
      scene: "同一客厅，茶几、沙发底、门后或地毯边缘构成明确逃跑路径，前景有棉絮和被带起的布角，背景保持温暖居家空间",
      effects: "狗狗脚边到躲藏目标之间画一条贴地暖黄橙旋流尾迹，混入少量尘粒和短速度线，绑定逃跑路径与小旋风比喻，不出现文字",
      motion: "镜头低位侧跟，狗狗突然蹬地冲出，沿既有旋流尾迹绕过前景障碍钻向躲藏位置，棉絮和布角被带起，尾迹快速卷动后在落幅处变淡",
    };
  }

  if (isDogStory && /(?:探出|探头|鼻尖|确认|有没有|心软|消气|责备|原谅)/u.test(narration)) {
    return {
      visualBeat: `${dog}从躲藏处只探出鼻尖或半个脑袋，试探${owner}是否心软，情绪落点必须克制又有喜剧感`,
      keyframe: `客厅安静后的低机位近景，${dog}从沙发底或门后只探出鼻尖、半张脸和一只前爪，耳朵微压，眼睛向${owner}方向上瞟；破损道具仍在前景一角作为前因`,
      scene: "同一客厅，躲藏处形成暗部遮挡，前景破损证据、地毯和维修工具保持连续，远处主人轮廓或脚边停在柔焦背景",
      effects: "从狗狗视线前端伸出一条短而轻颤的白青色试探线，方向指向主人，线端很软并快速回缩，绑定确认心软的心理动作，不出现文字",
      motion: "镜头保持低位静中带动，狗狗先露出鼻尖，再慢慢探出半个脑袋，试探线向主人方向伸出又回缩，狗狗眨眼并随主人的微小动静迅速缩回半寸，落幅停在小心观察",
    };
  }

  if (isDogStory && /(?:评论区|什么感觉)/u.test(narration)) {
    return {
      visualBeat: `${dog}安静伏在床沿，与刚睁眼的${owner}保持近距离眼神交流，亲密感来自等待后的确认而不是说话表演`,
      keyframe: `女主人第一视角近景，${dog}的湿润鼻尖位于画面下方前景，琥珀色眼睛清晰望向镜头，耳朵放松，床沿与浅色被褥形成中景，清晨卧室和半开的门位于柔焦背景`,
      scene: "同一间清晨卧室，浅色床品、木质床头、半开房门与细窄窗光保持固定空间关系，暖金晨光从画面左侧照入，冷色走廊留在远景",
      effects: "只在眼神周围保留极淡的暖金柔光和两三个微小光点，不出现爱心文字、字幕或对话框",
      motion: "从女主人刚睁眼的主观视角开始轻微对焦，小狗先保持凝视，再缓慢歪头并向前半步，鼻尖接近镜头后停住，尾巴在背景轻摆，画面稳定收尾",
      followUps: [{
        visualBeat: `${owner}从被褥中伸出一只手轻触${dog}的脸侧，小狗眯眼放松并把下巴轻贴床沿，形成温暖互动落点`,
        keyframe: `侧面中近景，女主人的手停在${dog}脸侧，狗狗微微眯眼、耳朵自然下垂、下巴贴近床沿，前景是柔焦被角，中景角色互动清楚，背景门口和窗光保持连续`,
        scene: "同一间清晨卧室，床沿、浅色被褥和半开房门位置不变，左侧暖晨光勾勒手指与狗狗毛发轮廓，背景保持浅景深",
        effects: "手与脸侧接触处加入一圈很淡的暖光，不出现可读文字或夸张符号",
        motion: "固定侧面中近景，女主人的手缓慢落在狗狗脸侧，狗狗眯眼并把重心靠近床沿，耳朵轻落，动作完成后保持安静定格",
      }],
    };
  }

  if (isDogStory && /(?:守着你|等你回来|不是在等你陪它玩)/u.test(narration)) {
    return {
      visualBeat: `${dog}坐在床与门口之间守着熟睡的${owner}，身体朝向走廊，视线却回望床上，明确表现守护与等待的双重关系`,
      keyframe: `低机位中景，${dog}坐在画面右侧的床与门口之间，前爪稳稳落在木地板，身体朝向冷色走廊，头部回望左后方熟睡的女主人，前景门框形成遮挡，中景狗狗轮廓清晰，背景床铺沐浴暖光`,
      scene: "清晨卧室与门口形成同一连续空间，走廊保持克制冷色，床边保持柔暖色温，门框、床沿与地板透视线把视线引向守候中的小狗",
      effects: "用门口冷光与床边暖光的交界强调守护位置，仅保留轻微漂浮尘埃，不使用文字或卡通对话符号",
      motion: "镜头沿门框低位缓慢横移，小狗先注视走廊，再回头确认床上的女主人，尾巴轻贴地板，呼吸放松，镜头停在它回望的眼神上",
      followUps: [{
        visualBeat: `${dog}在床边伏下但仍睁着眼，鼻尖朝向女主人，耳朵保持对门口声音的感知，安静等待成为画面唯一动作`,
        keyframe: `床沿高度近景，${dog}伏在浅色地毯上，前爪交叠、下巴微抬、眼睛没有闭合，一只耳朵朝门口转动；前景被角柔焦，中景眼神锐利，背景门缝冷光形成细线`,
        scene: "同一卧室床侧，浅色地毯、床沿、被褥和门缝位置连续，暖晨光柔和照亮毛发，背景走廊压暗并保持浅景深",
        effects: "耳朵附近仅加入一条极淡的声波弧线，画面其余部分保持干净",
        motion: "贴近狗狗眼睛与耳朵的侧面近景，耳朵先向门口轻转，眼神随后回到女主人，鼻翼轻动，镜头保持稳定并落在清醒注视上",
      }],
    };
  }

  if (isDogStory && /(?:睡着的你没有防备|不是在休息，它是在等)/u.test(narration)) {
    return {
      visualBeat: `${dog}横卧在床外侧与房间入口之间，身体贴近地面却没有闭眼，用自己的位置替熟睡的${owner}补上警戒空缺`,
      keyframe: `卧室上方斜俯全景，熟睡女主人位于画面左上方的浅色床铺，${dog}横卧在右下方床外侧，头朝门口、眼睛睁开，身体与床沿形成保护性的平行线；前景一角窗帘柔焦，中景床与狗狗关系完整，背景门口压暗`,
      scene: "同一清晨卧室的斜俯构图，床铺、浅色地毯、门口和窗帘形成清楚四点空间关系，床侧暖光柔和，入口区域保留冷色阴影与纵深",
      effects: "床铺周围只有一圈极淡暖光，狗狗与门口之间保留干净冷色通道，不加入盾牌图标、文字或对话框",
      motion: "镜头从床上熟睡的女主人缓慢斜移到床外侧的小狗，小狗身体保持伏低，眼睛转向门口、耳朵抬起半拍，再回望床沿，稳定停在保护位置",
      followUps: [{
        visualBeat: `${dog}用身体挡在床沿外侧，前爪靠近女主人垂下的手，视线越过镜头看向房门，守护关系通过距离和方向被看清`,
        keyframe: `贴近地面的广角近景，女主人放松垂下的手位于左侧前景，${dog}的交叠前爪与胸口占据中景，头部抬起越过镜头看向右后方房门；床沿暖光勾勒毛发，背景门口保持冷色浅景深`,
        scene: "同一床外侧低机位，前景手部、中景狗狗胸口与前爪、背景门口形成强烈纵深，左暖右冷的光线方向与上一镜一致",
        effects: "手指与前爪之间保留细窄暖色光带，其他区域保持克制无图标",
        motion: "低机位从女主人垂下的手轻移到狗狗前爪和面部，小狗把一只前爪靠近床沿，目光仍锁定门口，耳朵轻转后稳定不动",
      }],
    };
  }

  if (isDogStory && /(?:守护者|门口|动静|安不安全|警戒|没有防备)/u.test(narration)) {
    return {
      visualBeat: `${dog}守在半开卧室门口，身体形成一道安静屏障，竖起的耳朵监听走廊，熟睡的${owner}仍在背景安全区域内`,
      keyframe: `走廊低机位全景，半开门框占据前景两侧，${dog}端坐在门槛中央，背部朝向床铺、头和耳朵转向走廊深处，前爪受力稳定；中景狗狗被冷暖交界光勾边，背景可见熟睡女主人和浅色床品`,
      scene: "卧室门口与短走廊构成清楚纵深，门内暖晨光、门外蓝灰环境光方向固定，地板反光克制，床、门框和走廊位置保持连续",
      effects: "走廊远处加入两道很淡的声波弧线，狗狗轮廓使用细薄暖色边光，不出现警报文字或夸张图标",
      motion: "镜头贴近地板从卧室内缓慢移向门口，小狗耳朵先向走廊转动，身体保持不动，确认没有危险后回头看床一眼，稳定停在守门姿态",
      followUps: [{
        visualBeat: `${dog}耳朵与眼睛的反应细节成为守护证据，走廊门影映在瞳孔里，身体仍稳稳挡在卧室入口`,
        keyframe: `三分之二侧脸特写，${dog}一只耳朵竖起朝向走廊，琥珀色眼睛里映出门框冷光，鼻翼轻张，前景是柔焦门框，中景面部与毛发细节清晰，背景床头暖光形成圆润层次`,
        scene: "同一门口位置，冷色走廊与暖色卧室保持反差，浅景深集中在眼睛、耳朵和鼻尖，门框形成自然前景遮挡",
        effects: "只在瞳孔高光和耳朵外缘加入克制亮点，保持电影画面干净",
        motion: "从耳朵特写轻微下移到眼睛，耳朵快速转向一声远处轻响，眼神确认走廊后缓慢回望床铺，镜头停止漂移",
      }],
    };
  }

  if (isDogStory && /(?:一醒来|醒来|睁眼|大嘴筒子|凑过来)/u.test(narration)) {
    const isPayoff = /(?:不是因为|一直在等|这一刻|所以)/u.test(narration);
    if (isPayoff) {
      return {
        visualBeat: `${owner}刚睁开眼，守候已久的${dog}在门边捕捉到这个信号，身体从静止切换为起跑前势，准备奔向床边`,
        keyframe: `床头方向的长焦中景，女主人刚睁开的眼睛和一缕深棕长发位于右侧前景，${dog}在左后方门边刚抬起前爪、耳朵骤然向前、身体重心压向床铺，琥珀色眼睛与女主人形成清楚视线连线；中景床沿横向切分画面，背景走廊冷光与卧室暖光形成明确分区`,
        scene: "同一清晨卧室从床头望向门口，女主人、床沿、小狗和走廊沿景深方向排列，门边冷色轮廓光与床侧暖色晨光保持连续，长焦压缩空间并突出等待后的瞬间反应",
        effects: "小狗抬起的前爪后方预留两条短促暖色启动线，视线连线上只有一个微小高光点，不出现文字或夸张图标",
        motion: "先对焦女主人睁开的眼睛，再快速拉焦到门边小狗；小狗耳朵抬起、前爪落地并沿床侧向前两步，镜头平稳侧跟，接近床沿前减速",
        followUps: [{
          visualBeat: `${dog}从门边奔到床沿后把头轻贴女主人伸出的手掌，等待终于获得回应，动感在亲密接触处收住`,
          keyframe: `床尾斜侧中近景，${dog}前半身靠近床沿、头部低下轻贴女主人伸出的手掌，后腿仍保持刚停下的支撑姿态，尾巴在画面后侧扬起；前景手掌与狗狗额头清晰，中景床沿和身体完整，背景门口留有来路纵深与晨光亮带`,
          scene: "同一卧室床尾位置，地板上的晨光亮带从门口延伸到床沿，前景手掌、中景狗狗与背景门口形成动作路径，暖光照亮接触处并保留浅景深",
          effects: "接触处加入一圈极淡暖光，尾巴后侧预留一条短弧形速度线，面部区域保持干净",
          motion: "侧跟小狗完成最后两步并在床沿刹停，女主人伸手，小狗低头把额头贴入掌心，尾巴快速摆动后减慢，镜头轻推到接触处稳定落幅",
        }],
      };
    }
    return {
      visualBeat: `${dog}原本安静守在床边，察觉${owner}睁眼后立即把鼻尖凑近，形成有冲击力又亲密的开场反差`,
      keyframe: `女主人枕边主观视角近景，${dog}的鼻尖和嘴筒位于下方前景，琥珀色眼睛完整清晰、耳朵向前、前爪搭在床沿，女主人刚睁开的眼睛与一缕深棕长发位于画面边缘，背景是清晨窗光和半开房门`,
      scene: "同一间清晨卧室，浅色被褥、木质床沿、半开房门与左侧窗光位置固定，前景鼻尖夸张但不变形，中景眼神清楚，背景保持柔和景深",
      effects: "鼻尖周围加入极轻的空气挤压弧线，眼睛高光略增强，避免爱心堆叠、文字和对话框",
      motion: "从床边中景开始，小狗捕捉到女主人睁眼后立即竖起耳朵、前爪搭上床沿并向镜头靠近，鼻尖接近画面时减速，眼神保持温柔，最后稳定停住",
      followUps: [{
        visualBeat: `${dog}的靠近动作在女主人侧脸旁落下，女主人露出刚睡醒的轻微笑意，小狗尾巴在床边快速摆动`,
        keyframe: `床侧三分之二中近景，${dog}前爪搭在床沿、脸贴近女主人侧脸，女主人眼睛刚睁开并露出轻微笑意；前景被角柔焦，中景两者关系清晰，背景尾巴和门口形成空间层次`,
        scene: "同一卧室和床侧机位，晨光从左后方形成柔和轮廓光，浅色床品反射暖色填光，门口仍保留冷色背景",
        effects: "尾巴运动区域预留轻微速度线位置，角色面部保持干净无文字",
        motion: "侧面镜头轻跟小狗向床沿靠近，女主人转眼看向它并微笑，小狗尾巴快速摆动两次，脸侧轻触后停止，镜头稳定落幅",
      }],
    };
  }

  if (isDogStory && /(?:感知|呼吸|肌肉|体温|信号)/u.test(narration)) {
    const focusesOnBreathing = /(?:呼吸|睡着)/u.test(narration) && !/(?:肌肉|体温)/u.test(narration);
    return focusesOnBreathing ? {
      visualBeat: `${dog}伏在床边观察熟睡${owner}平缓起伏的呼吸，鼻翼、耳朵和专注眼神共同呈现它正在读取细微信号`,
      keyframe: `床侧平视近景，前景浅色被褥随呼吸形成柔和弧面，中景${dog}伏低身体、鼻尖靠近床沿、琥珀色眼睛专注看向女主人肩颈，耳朵一前一后；背景晨光穿过窗帘，毛发边缘与床单纹理清晰`,
      scene: "安静清晨卧室，床沿与狗狗位于同一水平线，窗帘、床头和门口保持固定，左侧柔暖窗光照亮毛发，背景以浅景深压低干扰",
      effects: "在被褥上方加入两道极淡、均匀的半透明呼吸弧线，狗狗鼻尖附近保留微小高光，不出现文字说明",
      motion: "固定床侧近景，女主人被褥保持缓慢均匀起伏，小狗鼻翼轻动、耳朵微调并把头靠近一点，镜头只做极轻推近，停在专注眼神",
      followUps: [{
        visualBeat: `${dog}眼睛与鼻尖的微观反应构成感知证据，女主人平稳呼吸仍在背景连续发生`,
        keyframe: `狗狗三分之二面部特写，焦点落在湿润鼻尖、琥珀色眼睛和细密胡须，背景柔焦可见女主人放松的手与浅色被褥，窗光形成细腻毛发轮廓和明确冷暖层次`,
        scene: "同一床侧位置，前景一角被褥形成柔焦遮挡，中景狗狗面部锐利，背景女主人手部和枕头保持可辨认，晨光方向不变",
        effects: "鼻尖旁加入一缕极淡空气流线，眼睛高光保持自然，不使用图表或文字",
        motion: "从鼻尖特写轻移到眼睛，鼻翼随呼吸轻动，耳朵向女主人方向转半拍，眼神保持专注后稳定收尾",
      }],
    } : {
      visualBeat: `${dog}同时观察${owner}放松的手臂、肩颈与被褥温度变化，身体微微前倾，呈现接收多重睡眠信号的专注状态`,
      keyframe: `俯侧近景，女主人放松的手掌与肩颈位于前景，被褥形成平缓曲线，${dog}的鼻尖、眼睛和一只前爪位于中景并朝向这些细节；背景窗帘透入柔暖晨光，皮肤、布料和毛发材质层次清晰`,
      scene: "同一清晨卧室，床面成为主要构图平面，女主人手部、狗狗面部和窗光依次形成前中后景，暖色体表光与冷色阴影保持克制对比",
      effects: "在手臂与被褥边缘加入极淡暖色渐变光晕表示温度变化，在狗狗眼前加入三个微小无文字光点",
      motion: "镜头从女主人放松的手掌缓慢横移到狗狗鼻尖与眼睛，狗狗轻嗅后把身体重心前移，耳朵安静落下，稳定停在理解信号的专注表情",
      followUps: [{
        visualBeat: `${dog}在接收完睡眠信号后把下巴轻轻放回前爪，眼睛仍保持清醒，动作从判断转入安静守候`,
        keyframe: `床边低机位近景，${dog}下巴悬在交叠前爪上方、眼睛仍睁开，前景床单纹理清晰，中景面部与爪垫受柔光照亮，背景女主人手臂放松垂在被侧，门口留有冷色纵深`,
        scene: "同一床边位置，柔暖窗光保持从左侧进入，木地板与浅色床品形成安静色彩层次，门口背景浅景深",
        effects: "去除图标，只保留毛发轮廓光和轻微漂浮尘埃",
        motion: "小狗轻嗅一次后慢慢把下巴落到前爪上，眼睛始终没有闭合，镜头微微后拉露出床边守候关系并稳定停止",
      }],
    };
  }

  if (isDogStory && /(?:需要安静|冲动按下去|收敛|一声不吭|守在旁边)/u.test(narration)) {
    return {
      visualBeat: `${dog}看向前景的玩具球又回头看熟睡的${owner}，主动收住抬起的前爪，转而安静伏在床边`,
      keyframe: `低机位中近景，彩色玩具球位于左侧前景，${dog}在床边抬起一只前爪却停在半空，头部回望右后方熟睡的女主人，耳朵收敛、尾巴贴地；中景床沿清楚，背景晨光和半开门柔焦`,
      scene: "同一清晨卧室，玩具球、床沿、浅色地毯和半开门形成清楚空间关系，左侧晨光温暖柔和，地面阴影方向固定",
      effects: "抬起前爪旁使用一条很淡的制动弧线，玩具球周围不加文字或夸张图标，画面重点仍是角色选择",
      motion: "镜头从前景玩具球沿地面轻移到小狗，小狗刚要迈步便回头确认女主人仍在睡，缓慢收回前爪并在床边伏下，尾巴停止摆动，稳定收尾",
      followUps: [{
        visualBeat: `${dog}把玩具轻轻推远后伏在床边，侧脸和压低的耳朵表现它主动保持安静`,
        keyframe: `侧面特写，${dog}一只前爪刚把玩具球推离床边，另一只前爪支撑身体，耳朵压低、眼神看向床上；前景玩具球轻微虚化，中景爪部和侧脸清晰，背景被褥与女主人轮廓柔焦`,
        scene: "同一床侧地毯区域，玩具球、床脚与门口方向连续，柔暖晨光勾勒爪部和脸侧，浅景深突出克制动作",
        effects: "只在玩具移动方向留一条短促柔和速度线，床边区域保持干净",
        motion: "固定低位特写，小狗用前爪轻轻把玩具推远，立即收爪并伏下，耳朵放松，眼神回到女主人，动作结束后保持安静",
      }],
    };
  }

  if (isDogStory && /(?:根本就没睡|不是在休息|它是在等|一直在等)/u.test(narration)) {
    return {
      visualBeat: `${dog}看似伏在床边休息，眼睛却始终睁着并注视熟睡的${owner}，用清醒细节推翻“刚好醒来”的误解`,
      keyframe: `床脚低机位近景，${dog}身体伏低、下巴贴在交叠前爪上，琥珀色眼睛完全睁开并斜望床上，耳朵朝门口保持感知；前景床脚形成遮挡，中景面部锐利，背景女主人与清晨窗光柔焦`,
      scene: "同一清晨卧室，床脚、浅色地毯、半开房门与窗光位置固定，狗狗面部处于暖光与冷影交界，背景保持安静浅景深",
      effects: "眼睛高光略微增强，门口保留一道极淡冷光，不使用时钟文字、问号或对话框",
      motion: "镜头从看似熟睡的全身姿态轻推到眼睛，小狗身体保持不动，只有耳朵向门口轻转、眼神回到女主人，最后停在清醒注视上",
      followUps: [{
        visualBeat: `${dog}在床边保持清醒等待，门口与女主人同时处于它的视野范围，时间感通过晨光移动而非文字表达`,
        keyframe: `卧室侧面中景，${dog}伏在床与门口之间，头部微抬、眼睛看向床沿；前景窗帘边缘形成遮挡，中景狗狗轮廓清楚，背景门口冷光和床上暖光构成双向视线，木地板具有柔和反射`,
        scene: "同一卧室侧面机位，窗帘、床沿、狗狗和门口沿对角线排列，晨光在地板上形成细长亮带，空间纵深明确",
        effects: "只保留晨光中的细小尘埃和眼睛自然高光，画面无文字",
        motion: "侧面镜头缓慢横移露出床与门口的完整关系，小狗先看门口再回望女主人，身体始终伏低，镜头在双向守候构图中停止",
      }],
    };
  }

  if (/(胖点|瘦点|胖猫|瘦猫|对比|更危险)/u.test(narration)) {
    return {
      visualBeat: `${subject}位于画面中心，以疑惑眼神观察左右两个无文字体型对比想象画面，健康体型使用柔和绿光，过胖体型使用克制红色警示图标`,
      keyframe: `${subject}位于温暖客厅中景，头部转向左右两个悬浮体型剪影，耳朵微抬、眼神疑惑；前景软垫形成遮挡，中景主体清晰，背景窗光与家具柔焦`,
      scene: "温暖整洁的居家休息区，固定软垫、食盆和窗边暖光，前景主体清晰，背景家具柔焦并留出动画包装空间",
      effects: "主体上方使用轻盈问号，左右体型对比画面分别配绿色健康符号与红色警示符号，不出现可读文字",
      motion: "镜头从居家中景缓慢推近，主体先看向健康体型对比，再看向过胖体型对比，眼神和姿态自然变化，最后稳定停在困惑表情",
    };
  }
  if (/(伸懒腰|撅着屁股|弓着后背|弓背)/u.test(narration)) {
    return {
      visualBeat: `${subject}在软垫旁呈现身体前伸、背部拱起的伸展姿态，眼神、姿态和身体重心透露轻微不适，动作清楚自然`,
      keyframe: `${subject}在软垫旁以低机位侧面呈现前爪前伸、背部拱起的静态动作前势，眼神略紧、腹部轮廓清楚，前景地毯和背景窗光形成空间层次`,
      scene: "安静的居家休息区，软垫、食盆和浅色地毯构成明确生活线索，侧窗柔光勾勒背部与腹部轮廓",
      effects: "背部与腹部附近使用克制的暖橙色紧绷线和轻微警示光晕，不使用文字，不遮挡主体",
      motion: "低机位侧面缓慢跟随完整伸展动作，轻推至眼神、姿态和紧绷腹部，动作结束后保持短暂稳定画面",
    };
  }
  if (/(吃|饭|食物|食盆|消化)/u.test(narration)) {
    return {
      visualBeat: `${subject}停在只吃了一部分的食盆前，身体靠近食物但神情迟疑，食盆余量和腹部状态同时清楚可见`,
      keyframe: `${subject}停在陶瓷食盆前的三分之二侧面中近景，鼻尖靠近食物却没有进食，眼神迟疑、腹部轮廓可见，前景食盆、中景主体和背景窗光层次明确`,
      scene: "家庭进食区，陶瓷食盆、水碗、整洁食垫与暖木地板形成前中后景，窗边自然光保持温暖但不过曝",
      effects: "腹部附近使用非写实的柔和消化旋涡或紧绷线表达负担，不展示器官，不出现文字",
      motion: "镜头从食盆近景平稳后拉至主体全身，再轻推向迟疑眼神与腹部，保留自然呼吸、表情和身体重心的小幅变化",
    };
  }
  if (/(朋友圈|拍个视频|评论区|手机)/u.test(narration)) {
    return {
      visualBeat: `${subject}位于客厅软垫旁，主人仅以手和手机入画记录它的日常动作，主体的可爱外形与轻微不适信号同时可见`,
      keyframe: `主人手持手机位于前景一侧，${subject}停在客厅软垫旁并以三分之二侧身回望，眼神可爱却略显不适，中景主体清楚，背景沙发与窗光柔焦`,
      scene: "日间家庭客厅，手机位于前景一侧，主体处于清晰中景，沙发与窗光构成柔和背景，画面不显示品牌界面",
      effects: "手机周围漂浮无文字爱心和笑脸符号，主体腹部保留一圈很淡的警示光，避免任何可读评论文字",
      motion: "先以手机取景角度稳定拍摄，再平滑拉出主人手、手机与主体的空间关系，最后轻移至被忽略的不适表情",
    };
  }
  if (/(医院|呕吐|拉稀|拒食|不吃饭|严重)/u.test(narration)) {
    return {
      visualBeat: `${subject}安静蜷在宠物医院诊疗垫上，未动的食盆放在近处，兽医正在温和检查，主人在旁表现担忧`,
      keyframe: `宠物医院中景，${subject}蜷在浅蓝诊疗垫中央，兽医一只手停在检查位置，主人位于侧后方担忧注视，前景未动食盆、中景主体与背景医疗柜层次清晰`,
      scene: "干净明亮的现代宠物医院诊室，浅蓝诊疗垫、基础医疗柜和柔和顶灯构成专业环境，不展示血腥或排泄物",
      effects: "仅用未动食盆、克制红色警示光和抽象生命曲线表达病情严重，不出现诊断文字",
      motion: "镜头从未动食盆缓慢横移到主体，再推近兽医检查动作与主人担忧姿态，结尾稳定拉回三者关系全景",
    };
  }
  const isOutdoor = /(?:街|户外|森林|雨|车底|门外|旷野|草地)/u.test(narration);
  return {
    visualBeat: `${subject}在画面三分线位置停下脚步，身体保持三分之二侧身，回头看向前景道具并露出明确的迟疑眼神，动作前势和情绪焦点集中在同一瞬间`,
    keyframe: `${subject}以三分之二侧身停在画面右侧，一只脚或前爪刚离地、身体重心前倾、视线落向左下方前景道具；中景主体轮廓与表情清晰，背景空间沿对角线延伸`,
    scene: isOutdoor
      ? "傍晚户外街道，前景栏杆或路边物体形成自然遮挡，中景主体位于暖色侧光中，背景街灯与远处建筑保持冷暖层次和浅景深"
      : "带侧窗的整洁生活空间，前景桌角或门框形成自然遮挡，中景主体位于柔和窗光中，背景家具和入口沿对角线建立清楚空间纵深",
    effects: NO_GRAPHIC_DECORATION_PROMPT,
    motion: "镜头以侧面中近景轻微横移，主体先迈出一步再停住，回头看向前景道具并改变眼神，环境只保留窗帘或远景灯光的小幅动态，稳定停在反应表情",
  };
}

function createFallbackSoundPrompt(narration: string) {
  const sounds: string[] = [];
  if (/(?:睡|卧室|床|被子|被褥|醒来|睁眼)/u.test(narration)) sounds.push("安静卧室底噪、平稳呼吸和动作发生时的被褥轻摩擦");
  if (/(?:走|跑|冲|跟着|门口)/u.test(narration)) sounds.push("爪垫或脚步落地声");
  if (/(?:尾巴|摇尾)/u.test(narration)) sounds.push("尾巴快速扫过布料或地面的轻响");
  if (/(?:嗅|闻|鼻子|鼻尖)/u.test(narration)) sounds.push("贴近主体的短促嗅闻声");
  if (/(?:哼唧|呜咽)/u.test(narration)) sounds.push("克制且与动作同步的狗狗哼唧声");
  if (/(?:门|走廊|动静|警戒|守护)/u.test(narration)) sounds.push("远处走廊的轻微环境响动");
  const concreteSounds = [...new Set(sounds)].slice(0, 3);
  return concreteSounds.length > 0
    ? concreteSounds.join("、")
    : "与地点、动作和道具接触严格同步的现场原声";
}

function resolveFallbackCastIds(narration: string, characters: StoryboardCharacterIdentity[]) {
  const matched = characters.filter((character) => (
    uniqueCharacterLabels([character.name, ...(character.aliases || [])])
      .map((label) => label.replace(/^同一(?:只|位|个)/u, "").trim())
      .filter(Boolean)
      .some((label) => narration.includes(label))
  ));
  const cast = matched.length > 0 ? matched : characters.slice(0, 1);
  return [...new Set(cast.map((character) => character.id))].slice(0, 4);
}

export function createFallbackVisualShots(
  narration: string,
  durationSeconds: number,
  _presetId: string,
  assistantInstruction?: string,
  fallbackCharacters?: StoryboardCharacterIdentity[],
) {
  const characters = fallbackCharacters?.length
    ? fallbackCharacters
    : extractFallbackCharacters(narration, assistantInstruction);
  const castIds = resolveFallbackCastIds(narration, characters);
  const subject = castIds
    .map((id) => characters.find((character) => character.id === id)?.name)
    .filter(Boolean)
    .join("与") || extractFallbackSubject(narration, assistantInstruction);
  const direction = createFallbackDirection(narration, subject);
  const duration = Math.max(3, Math.min(5, Math.round(durationSeconds)));
  const keyframe = direction.keyframe || `${direction.visualBeat}；主体表情、视线、身体重心和动作前势清楚。`;
  const castAppearance = castIds
    .map((id) => characters.find((character) => character.id === id))
    .filter((character): character is StoryboardCharacterIdentity => Boolean(character))
    .map((character) => `${character.name}：${character.fixedAppearance}`)
    .join("；");
  const fallbackImagePrompt = [
    keyframe,
    direction.scene,
    castAppearance ? `角色文字资产锁定：${castAppearance}` : `主体锁定：${subject}保持具体外观和天然身体结构`,
    "电影级高品质3D动画，单一连续场景的静态首帧，主体轮廓、表情、视线、叙事道具和前中后景关系清楚，16:9横向构图，光线方向和材质统一，不出现字幕、水印或无关可读文字。",
  ].join("；");
  return [{
    visualMode: inferFallbackVisualMode(narration, direction.effects),
    durationSeconds: duration,
    shotRole: fallbackShotRole(0, 1),
    transition: "cut" as z.infer<typeof ShotTransitionSchema>,
    visualBeat: direction.visualBeat,
    visibleProposition: direction.visualBeat,
    evidenceLevel: inferFallbackVisualMode(narration, direction.effects) === "semantic-cutaway"
      ? "semantic_cutaway" as const
      : usesAnimeGraphicDecoration(direction.effects)
        ? "environment_feedback" as const
        : "physical_action" as const,
    directorDecision: `用角色表演、叙事道具和环境反馈把“${direction.visualBeat}”变成可见事件，包装只强化本段因果。`,
    cameraPlan: "沿主体核心动作方向使用一种主要运镜，保持空间连续，并在动作结果处稳定落幅。",
    castIds,
    keyframeMoment: `${keyframe}；${direction.scene}；材质、光线、色彩和空间方向与全片设定一致。`,
    scenePrompt: direction.scene,
    imagePrompt: fallbackImagePrompt,
    effectsPrompt: direction.effects,
    motionPrompt: [
      `【入镜】${keyframe}`,
      "【预备】主体保持清楚的动作前势，视线、重心与关键道具关系稳定",
      `【主动作】${direction.motion}`,
      "【反应】主体表情、叙事道具与环境状态对主动作产生同步可见反馈",
      "【落幅】核心动作完整收住，保留稳定画面和下一镜可衔接的视线或道具锚点",
    ].join("；"),
    soundPrompt: createFallbackSoundPrompt(narration),
    videoPrompt: `从参考图当前姿态直接开始，${direction.motion}。主体、道具和环境对动作产生同步可见反馈；镜头保持当前景别，沿主体动作方向连续跟拍，不切换机位。最后完整收住动作并稳定停留，只保留与动作同步的现场声音。`,
    editPrompt: "保留动作起势、核心反馈和稳定落幅；字幕、编号和可读文字统一在后期添加。",
    qualityCriteria: "角色外观、场景、道具、光色和包装与参考图一致；动作主体明确，最后一秒稳定，无换脸、换场或新增主体。",
  }];
}

type CanvasStoryTargetDuration = Extract<StoryboardTargetDurationSeconds, 8 | 10 | 15>;
type CanvasActualShotCount = StoryboardActualShotCount | 6;

function normalizeCanvasStoryDirectorMode(value: unknown): StoryboardDirectorMode {
  return value === "cinematic" || value === "lyrical" ? value : "high_energy";
}

function normalizeCanvasStoryTargetDuration(value: unknown): CanvasStoryTargetDuration {
  const duration = Number(value);
  return duration === 8 || duration === 15 ? duration : 10;
}

export function shouldUseStoryboardPanoramicAnchor(
  value: string,
  visualMode: VisualShotMode,
  targetDurationSeconds: CanvasStoryTargetDuration,
) {
  const explicitAnchor = /(?:远景|全景|全貌|总览|高潮|结论|最终结果|揭示全貌|情绪收束|关系落点|反转落点|证据汇总)/u.test(value);
  if (!explicitAnchor) return false;
  const independentValue = /(?:承担|落点|锚点|完整展示|一眼看清|汇总|揭示|收束|定论|前后对比|空间关系)/u.test(value);
  if (targetDurationSeconds !== 15) return independentValue && visualMode !== "narrative";
  return independentValue || visualMode !== "narrative";
}

function buildStoryboardShotTimeRanges(
  durationSeconds: CanvasStoryTargetDuration,
  actualShotCount: CanvasActualShotCount,
  visualBeat: string,
): StoryboardShotTimeRange[] {
  const beatRoles = actualShotCount === 6
    ? ["建立人物、环境与目标", "触发当前文案事件", "冲突或误解升级", "主动作与证据碰撞", "角色与道具反应", "高潮、反转或结论落点"]
    : actualShotCount === 5
      ? ["建立人物、环境与目标", "触发当前文案事件", "主动作升级", "角色与道具反应", "高潮、远景或结论落点"]
      : actualShotCount === 4
      ? ["建立人物、环境与目标", "触发当前文案事件", "主动作与可见反馈", "结果或情绪落点"]
      : ["建立人物、环境与目标", "触发并完成主动作", "反应与结果落点"];
  return beatRoles.map((role, index) => ({
    shot_id: `shot_${String(index + 1).padStart(2, "0")}`,
    start_seconds: Math.round(index * durationSeconds / actualShotCount * 10) / 10,
    end_seconds: Math.round((index + 1) * durationSeconds / actualShotCount * 10) / 10,
    action_beat: `${role}：${visualBeat}`,
  }));
}

function resolveCanvasStoryUnitPlan(input: {
  targetDurationSeconds: CanvasStoryTargetDuration;
  directorMode: StoryboardDirectorMode;
  narration: string;
  visualBeat: string;
  visualMode: VisualShotMode;
  effectsPrompt: string;
}): {
  panelCount: 4 | 5;
  layout: StoryboardLayout;
  actualShotCount: CanvasActualShotCount;
  pacingMode: StoryboardPacingMode;
  panoramicAnchorRole: string | null;
  layoutInstruction: string;
  videoRhythmInstruction: string;
} {
  const anchorText = `${input.narration} ${input.visualBeat} ${input.effectsPrompt}`;
  const usePanorama = shouldUseStoryboardPanoramicAnchor(anchorText, input.visualMode, input.targetDurationSeconds);
  const actualShotCount = (
    input.targetDurationSeconds === 15
      ? input.directorMode === "high_energy" ? 6 : input.directorMode === "cinematic" ? 5 : 4
      : input.targetDurationSeconds === 8
        ? 3
      : input.directorMode === "high_energy" ? 4 : 3
  ) as CanvasActualShotCount;
  const pacingMode: StoryboardPacingMode = input.directorMode === "lyrical"
    ? "slow"
    : input.directorMode === "cinematic"
      ? "medium"
      : "fast";
  const layout = usePanorama ? "four_plus_panorama" : "two_by_two";
  const panelCount = usePanorama ? 5 : 4;
  const panoramicAnchorRole = usePanorama
    ? input.targetDurationSeconds === 15
      ? "底部全宽格承担空间全貌、高潮揭示或情绪收束，不参与机械切镜。"
      : "底部全宽格承担结论、警示或情绪锚点，不参与机械切镜。"
    : null;
  const layoutInstruction = usePanorama
    ? "生成一张完整连续故事板参考图，top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel；上方四格依次承担准备、触发、反应、转折，底部全宽格只承担具有独立价值的远景全貌、高潮揭示或结论锚点；格间使用细白边或浅灰分隔，画面内不要字幕、编号、水印、说明条或对话框。"
    : "生成一张完整连续故事板参考图，四个面板严格排成2x2网格；四格依次承担准备、触发、反应、转折，每格景别、机位和动作阶段必须变化；格间使用细白边或浅灰分隔，画面内不要字幕、编号、水印、说明条或对话框。";
  const videoRhythmInstruction = input.targetDurationSeconds === 15
    ? `${input.targetDurationSeconds}秒视频用${actualShotCount}个真实镜头完成，实际范围4至6镜；增加升级爆点、二次反转、机制证据或情绪停留，最后0.8至1.2秒稳定落幅。`
    : input.targetDurationSeconds === 8
      ? `${input.targetDurationSeconds}秒视频用3个真实镜头完成，平均每镜约2到3秒；保留钩子、冲突和结论三段因果，少解释、多表演。`
    : `${input.targetDurationSeconds}秒视频用${actualShotCount}个真实镜头完成，平均每镜约2到3秒；节奏紧凑但不要按参考图每格机械强切。`;
  return {
    panelCount,
    layout,
    actualShotCount,
    pacingMode,
    panoramicAnchorRole,
    layoutInstruction,
    videoRhythmInstruction,
  };
}

export function compileStoryboard(input: {
  script: string;
  style: string;
  ratio: string;
  productionMode?: "anime-story" | "real-story" | "ten-second" | "product-video";
  storyDirectorMode?: StoryboardDirectorMode;
  targetDurationSeconds?: StoryboardTargetDurationSeconds;
  referenceMode?: "single" | "first-last";
  keyframeStrategy?: KeyframeStrategy;
  effectsLevel?: VisualEffectsLevel;
  consistencyMode?: "text-lock" | "reference";
  assistantInstruction?: string;
  segments?: Array<{ narration: string; durationSeconds: number }>;
  plan?: AiStoryboardPlan;
  preset: CanvasPromptPreset;
  useDraft?: boolean;
}) {
  const content = input.useDraft ? input.preset.draft : input.preset.published;
  const isAnimeProduction = input.productionMode === "anime-story"
    || (!input.productionMode && input.preset.id === "anime_story");
  const storyDirectorMode = normalizeCanvasStoryDirectorMode(input.storyDirectorMode);
  const storyTargetDurationSeconds = isAnimeProduction
    ? normalizeCanvasStoryTargetDuration(input.targetDurationSeconds)
    : undefined;
  const normalizedInputPlan = input.plan ? normalizeStoryboardPlanCharacterIdentities(input.plan, input.script) : null;
  const requiresDirectPrompts = normalizedInputPlan?.promptContractVersion === "anime-director-v1";
  const aiPlan = normalizedInputPlan
    && isAiStoryboardPlanUsable(input.script, normalizedInputPlan, {
      requireMotionChain: isAnimeProduction && !requiresDirectPrompts,
      requireFinalPrompts: requiresDirectPrompts,
      targetDurationSeconds: storyTargetDurationSeconds,
    })
    && normalizedInputPlan.segments.every((segment) => segment.visualShots.length === 1)
    ? normalizedInputPlan
    : null;
  const usesDirectPromptContract = aiPlan?.promptContractVersion === "anime-director-v1";
  const qualityNotes = (aiPlan?.sourceIssues || []).map((item) => (
    `【${item.severity}】“${item.quote}”：${item.issue}${item.suggestion ? `；建议：${item.suggestion}` : ""}`
  ));
  const extra = input.assistantInstruction?.trim();
  const fallbackCharacters = extractFallbackCharacters(input.script, extra);
  const fallbackSubject = fallbackCharacters[0]?.name || "原文中的固定主体";
  const fallbackSegments = normalizeStoryboardSegments(input.script, input.segments);
  let semanticSegments = aiPlan?.segments.map((segment) => {
    const durationSeconds = estimateStoryboardDuration(segment.narration);
    return {
      narration: segment.narration,
      durationSeconds,
      visualShots: segment.visualShots.map((shot) => ({
        ...shot,
        durationSeconds,
      })),
    };
  }) || fallbackSegments.map((segment) => ({
    ...segment,
    visualShots: createFallbackVisualShots(segment.narration, segment.durationSeconds, input.preset.id, input.assistantInstruction, fallbackCharacters),
  }));
  if (storyTargetDurationSeconds) {
    semanticSegments = semanticSegments.map((segment) => ({
      ...segment,
      durationSeconds: storyTargetDurationSeconds,
      visualShots: segment.visualShots.map((shot) => ({
        ...shot,
        durationSeconds: storyTargetDurationSeconds,
      })),
    }));
  }
  const referenceMode = input.referenceMode || "single";
  const keyframeStrategy = referenceMode === "first-last" ? "action-start" : input.keyframeStrategy || "visual-anchor";
  const effectsLevel = input.effectsLevel || "light";
  const effectsRule = getEffectsRule(effectsLevel);
  const inferredPerformance = inferPerformancePlan(input.script, input.assistantInstruction);
  const performanceMode = aiPlan?.projectBible?.performanceMode || inferredPerformance.mode;
  const performanceBible = aiPlan?.projectBible?.performanceBible?.trim() || inferredPerformance.bible;
  const comedyPacing = isAnimeProduction && performanceMode === "comedy";
  const emotionalPacing = isAnimeProduction && performanceMode === "emotional";
  const highDynamicPacing = isAnimeProduction && (performanceMode === "dynamic" || performanceMode === "educational");
  const performanceImageRule = comedyPacing
    ? "表演基调：喜剧反差；一镜一个有情节因果的笑点，不乱做鬼脸或堆装饰。"
    : emotionalPacing
      ? "表演基调：情感抒情；动作克制连续，重视眼神、重心、触碰和回应，不强套笑点。"
      : highDynamicPacing
        ? "表演基调：轻快高动态；动作和响应更快更大但保持连贯，不等同喜剧。"
        : "表演基调：叙事自然；动作幅度和响应速度随本段语义调整。";
  const style = input.style.trim() || "高质量商业影像";
  const visualStyle = visualStyleClause(style);
  const rawSourceCharacters: StoryboardCharacterIdentity[] = aiPlan?.projectBible?.characters?.length
    ? aiPlan.projectBible.characters
    : fallbackCharacters;
  const { characters: normalizedSourceCharacters, idMap: characterIdMap } = normalizeStoryboardCharacterIdentities(rawSourceCharacters, input.script);
  const sourceCharacters = normalizedSourceCharacters.map((character) => (
    applyChineseProjectCharacterDefaults(character, input.script)
  ));
  const characterAssets: CompiledCharacterAsset[] = sourceCharacters.map((character, index) => ({
    ...character,
    order: index + 1,
    referencePrompt: buildCharacterReferencePrompt(character, index + 1, visualStyle, input.ratio),
  }));
  const fallbackCharacterBible = `${sourceCharacters.map(characterIdentityText).join("；")}；${content.characterRules}`;
  const packagingBible = aiPlan?.projectBible?.packagingBible?.trim()
    || "统一线条、材质、色彩、辉光、透视和动效节奏；逐镜图形只由当前语义决定，不使用文字。";
  const editorialBible = aiPlan?.projectBible?.editorialBible?.trim()
    || "生成镜头保持单一连续动作；剪辑优先截取动作最稳定的0.8至2.5秒，标题、编号、字幕、HUD和关注提示统一在后期层完成。";
  const storyPlan = aiPlan?.projectBible?.storyPlan;
  const storyPlanText = storyPlan
    ? [
        `【故事前提】${storyPlan.premise}`,
        `【主角目标】${storyPlan.protagonistGoal}`,
        `【触发事件】${storyPlan.incitingIncident}`,
        `【升级】${storyPlan.escalation}`,
        `【转折】${storyPlan.turningPoint}`,
        `【收束】${storyPlan.resolution}`,
        "【逐镜故事接力】",
        ...storyPlan.beats.map((beat) => (
          `${String(beat.order).padStart(2, "0")}｜${beat.storyFunction}｜入场：${beat.entryState}｜事件：${beat.event}｜动作：${beat.action}｜结果：${beat.resultState}｜交接：${beat.handoffToNext}`
        )),
      ].join("\n")
    : "本轮未生成可验收的故事接力表。";
  const consistencyPrompt = [
    `统一方案：${input.preset.name} v${input.preset.version}`,
    `统一风格：${style}；画面比例：${input.ratio}。`,
    input.consistencyMode === "reference"
      ? `角色资产：${characterAssets.map((character) => `${character.id}=${character.name}`).join("；")}。用户已选择参考图模式，每个角色独立确认定妆图，镜头只引用本镜castIds对应的角色图。`
      : `角色资产：${characterAssets.map((character) => `${character.id}=${character.name}`).join("；")}。默认使用文字资产锁定，不生成角色定妆图；每镜必须完整复述实际出场角色的具体视觉指纹。`,
    `角色锁定：${aiPlan?.projectBible?.characterBible || fallbackCharacterBible}`,
    `环境锁定：${aiPlan?.projectBible?.environmentBible || content.sceneRules}`,
    `视觉锁定：${aiPlan?.projectBible?.visualBible || `${style}，${content.imageRules}`}`,
    `语义包装锁定：${packagingBible}`,
    `剪辑包装锁定：${editorialBible}`,
    `表演锁定：${performanceMode}｜${performanceBible}`,
    `动画包装强度：${effectsLevel === "none" ? "无包装" : effectsLevel === "rich" ? "丰富包装" : "轻量包装"}。${effectsRule}`,
    extra ? `本次补充要求：${extra}` : "",
  ].filter(Boolean).join("\n");

  const shots: CompiledStoryboardShot[] = [];
  semanticSegments.forEach((segment, semanticIndex) => {
    segment.visualShots.forEach((visualShot, visualIndex) => {
      const order = shots.length + 1;
      const shotLabel = `分镜${String(order).padStart(2, "0")}`;
      const durationSeconds = visualShot.durationSeconds;
      const declaredCastIds = visualShot.castIds || [];
      const castIds = [...new Set(declaredCastIds
        .map((id) => characterIdMap[id] || id)
        .filter((id) => characterAssets.some((character) => character.id === id)))];
      const resolvedCastIds = castIds.length > 0 ? castIds : characterAssets.length === 1 ? [characterAssets[0].id] : [];
      const keyframeRule = keyframeStrategy === "action-start"
        ? "关键帧选择动作开始前或刚要发生的稳定状态，给后续动作保留足够空间。"
        : "关键帧选择本镜头信息最完整、构图最漂亮、角色最稳定、情绪最准确的视觉锚点；只能描述一个确定瞬间。";
      const scenePrompt = `场景提示词：${visualShot.scenePrompt} ${content.sceneRules} 统一风格：${style}，比例${input.ratio}。`;
      const resolvedEffectsPrompt = isAnimeProduction
        ? resolveAnimeEffectsPrompt([
            visualShot.visualBeat,
            visualShot.keyframeMoment,
            visualShot.scenePrompt,
            visualShot.imagePrompt || "",
          ].join("；"), segment.narration, visualShot.effectsPrompt, effectsLevel, Boolean(aiPlan))
        : promptClause(visualShot.effectsPrompt);
      const inferredVisualMode = inferFallbackVisualMode(segment.narration, resolvedEffectsPrompt);
      const declaredVisualMode = visualShot.visualMode || inferredVisualMode;
      const hasGraphicDecoration = usesAnimeGraphicDecoration(resolvedEffectsPrompt);
      const visualMode: VisualShotMode = effectsLevel === "none"
        ? "narrative"
        : declaredVisualMode === "semantic-cutaway" && hasGraphicDecoration
          ? "semantic-cutaway"
          : hasGraphicDecoration ? "hybrid-packaging" : "narrative";
      const evidenceLevel: VisualEvidenceLevel = visualShot.evidenceLevel
        || (visualMode === "semantic-cutaway"
          ? "semantic_cutaway"
          : visualMode === "hybrid-packaging"
            ? "environment_feedback"
            : "physical_action");
      const usesGraphicDecoration = effectsLevel !== "none"
        && visualMode !== "narrative"
        && hasGraphicDecoration;
      const storyUnitPlan = storyTargetDurationSeconds
        ? resolveCanvasStoryUnitPlan({
            targetDurationSeconds: storyTargetDurationSeconds,
            directorMode: storyDirectorMode,
            narration: segment.narration,
            visualBeat: visualShot.visualBeat,
            visualMode,
            effectsPrompt: resolvedEffectsPrompt,
          })
        : null;
      const storyShotTimeRanges = storyUnitPlan
        ? buildStoryboardShotTimeRanges(storyTargetDurationSeconds!, storyUnitPlan.actualShotCount, visualShot.visualBeat)
        : undefined;
      const storyShotTimelineInstruction = storyShotTimeRanges
        ? storyShotTimeRanges.map((range, rangeIndex) => (
            `镜头${rangeIndex + 1} ${range.start_seconds}-${range.end_seconds}秒：${range.action_beat}`
          )).join("；")
        : "";
      const effectsPromptBlock = effectsLevel === "none"
        ? "语义强化：不使用图形特效，但必须用有张力的剧情表演、叙事道具、环境反馈、构图和光影完整表达。"
        : `语义强化：${resolvedEffectsPrompt} ${effectsRule}`;
      const motionChain = resolveMotionChain(visualShot.motionPrompt);
      const graphicEffect = extractAnimeSemanticLayer(resolvedEffectsPrompt, "图形特效");
      const motionAction = [
        `【预备】${motionChain.预备}`,
        `【主动作】${motionChain.主动作}`,
        `【反应】${motionChain.反应}`,
        usesGraphicDecoration
          ? `参考图中“${graphicEffect}”只随对应动作启动、运动并自然消退，不新增其他装饰`
          : "不新增图形包装，叙事道具、衣料、毛发、光影和环境状态必须随动作产生可见反馈",
      ].join("；");
      const aiImagePrompt = compactPromptContext(
        promptClause(visualShot.imagePrompt || `${visualShot.keyframeMoment}；${visualShot.scenePrompt}`),
        isAnimeProduction ? 200 : 280,
      );
      const imageCharacterLock = isAnimeProduction
        ? buildShotCharacterLock(characterAssets, resolvedCastIds, aiPlan?.projectBible?.characterBible, fallbackSubject)
        : compactPromptContext(aiPlan?.projectBible?.characterBible || fallbackSubject, 110);
      const imageStyle = isAnimeProduction ? compactPromptContext(visualStyle, 60) : visualStyle;
      const imagePrompt = usesDirectPromptContract && visualShot.imagePrompt?.trim()
        ? appendFixedImageStyleSuffix([
            storyUnitPlan?.layoutInstruction,
            visualShot.imagePrompt,
            storyUnitPlan ? "面板只记录意图和关键状态，不添加字幕、编号、说明条或对话框，也不代表视频逐格切换。" : "",
          ].filter(Boolean).join("\n"), visualStyle)
        : isAnimeProduction
          ? [
            `${input.ratio}画幅，${imageStyle}。${storyUnitPlan ? storyUnitPlan.layoutInstruction : ""}`,
            `${imageCharacterLock}。`,
            `${aiImagePrompt}；${visualShot.scenePrompt}。`,
            usesGraphicDecoration
              ? `${graphicEffect}，贴合绑定对象与场景透视，受现场光线照亮，不遮挡表情和关键道具。`
              : "画面只呈现角色表演、叙事道具和环境反馈。",
            storyUnitPlan
              ? `${performanceImageRule} 这是同一段口播的连续故事板，每格只画一个动作阶段；全景锚点只服务情绪、空间或结论，不等于视频必须多切一次。`
              : `${performanceImageRule} 单一静态瞬间，前中后景清楚，无字幕、对话框、水印或可读文字。`,
          ].join("\n")
        : `${input.ratio}画幅，${style}。${aiPlan?.projectBible?.characterBible || fallbackCharacterBible}。${visualShot.visualBeat}；${aiImagePrompt}。${visualShot.scenePrompt}。${keyframeRule}${effectsPromptBlock} 单一静态瞬间，无字幕、对话框、水印或可读文字。`;
      const timeline = buildCanonicalShotTimeline(durationSeconds, {
        opening: `【入镜】@参考图1即本镜入镜关键帧；${motionChain.入镜}`,
        action: motionAction,
        ending: `【落幅】${motionChain.落幅}；保留短暂稳定冗余，便于后期微调裁剪`,
      });
      const styleContinuityRule = buildStyleContinuityRule(style);
      const soundPrompt = soundClause(visualShot.soundPrompt || createFallbackSoundPrompt(segment.narration), segment.narration);
      const motionPrompt = isAnimeProduction
        ? `视频动作方案：${shotLabel}，目标${formatVideoDuration(durationSeconds)}秒。${storyUnitPlan ? `${storyUnitPlan.videoRhythmInstruction}【实际镜头时间轴】${storyShotTimelineInstruction}。` : ""}${formatMotionChain(motionChain)}【转场】${visualShot.transition}，落幅锚点必须自然接入下一镜。${usesGraphicDecoration ? `【语义特效】${graphicEffect}，只动画化参考图已画出的部分。` : "【语义特效】无新增图形包装。"}`
        : `动态运镜提示词：目标总时长：${formatVideoDuration(durationSeconds)}秒。${styleContinuityRule}【时间轴】${timeline}。【运镜与连续性】${content.motionRules} ${effectsRule}`;
      const videoPrompt = usesDirectPromptContract && visualShot.videoPrompt?.trim()
        ? [
            storyUnitPlan ? `${storyUnitPlan.videoRhythmInstruction}【实际镜头时间轴】${storyShotTimelineInstruction}。面板数与切镜数解耦，不按故事板格子机械强切。` : "",
            visualShot.videoPrompt.trim(),
          ].filter(Boolean).join("\n")
        : isAnimeProduction
        ? [
            storyUnitPlan
              ? `把参考图中的${storyUnitPlan.panelCount}格故事板当作连续片场规划，生成约${durationSeconds}秒，用${storyUnitPlan.actualShotCount}个真实镜头演完；不要按格机械硬切，底部全景格只作为空间、高潮或结论锚点。`
              : "",
            `从参考图当前姿态开始，${motionChain.预备}；随后${motionChain.主动作}；${motionChain.反应}。`,
            `镜头保持当前景别，沿核心动作方向连续跟随，不切换机位；最后${motionChain.落幅}，稳定停留片刻。`,
            usesGraphicDecoration
              ? `${graphicEffect}随主动作产生一次清楚的运动反馈，并在动作结束时自然减弱。`
              : "道具、衣料或毛发、环境和光影随动作产生自然反馈。",
            `只保留${soundPrompt}。保持参考图角色结构、场景和道具连续，无对白口型、字幕、水印或可读文字。`,
          ].join("\n")
        : `从@参考图1当前画面直接开始。${motionChain.预备}；紧接着${motionChain.主动作}；${motionChain.反应}；最后${motionChain.落幅}并稳定停留。镜头保持当前景别，以一种连续运动跟随主体。道具和环境随动作产生自然反馈，现场只保留${soundPrompt}。保持参考图中的角色、场景、材质、光影与色彩，不换脸、换装、换场，不生成说话口型、字幕、对话框或水印。`;
      const endFramePrompt = referenceMode === "first-last"
        ? `尾帧提示词：${shotLabel}，${style}，${input.ratio}。${content.firstLastFrameRules} 根据视觉任务“${visualShot.visualBeat}”呈现动作完成后的稳定状态。`
        : "";
      shots.push({
        id: `${input.preset.id}-segment-${semanticIndex + 1}-shot-${visualIndex + 1}`,
        order,
        semanticOrder: semanticIndex + 1,
        visualOrder: order,
        narration: segment.narration,
        semanticNarration: segment.narration,
        semanticDurationSeconds: segment.durationSeconds,
        durationSeconds,
        targetDurationSeconds: storyTargetDurationSeconds,
        storyboardPanelCount: storyUnitPlan?.panelCount,
        storyboardLayout: storyUnitPlan?.layout,
        actualShotCount: storyUnitPlan?.actualShotCount,
        shotTimeRanges: storyShotTimeRanges,
        pacingMode: storyUnitPlan?.pacingMode,
        panoramicAnchorRole: storyUnitPlan?.panoramicAnchorRole,
        visualMode,
        shotRole: visualShot.shotRole,
        transition: visualShot.transition,
        castIds: resolvedCastIds,
        visualBeat: visualShot.visualBeat,
        visibleProposition: visualShot.visibleProposition?.trim() || visualShot.visualBeat,
        evidenceLevel,
        directorDecision: visualShot.directorDecision?.trim()
          || `用${visualShot.shotRole}镜头把“${visualShot.visualBeat}”变成可见动作；先由角色表演和叙事道具证明信息，再按${visualMode}模式加入必要语义证据。`,
        cameraPlan: visualShot.cameraPlan?.trim()
          || `沿核心动作方向使用一种主要运镜，保持空间连续，并在${visualShot.transition}转场前形成稳定落幅。`,
        keyframeMoment: visualShot.keyframeMoment,
        effectsPrompt: resolvedEffectsPrompt,
        scenePrompt,
        imagePrompt,
        motionPrompt,
        soundPrompt,
        videoPrompt,
        editPrompt: visualShot.editPrompt?.trim()
          || `优先保留核心动作、明确反应和稳定落幅；${visualShot.transition}衔接下一镜，字幕、编号与可读文字后期添加。`,
        qualityCriteria: visualShot.qualityCriteria?.trim()
          || "参考图必须是视频首动作的前势；角色、场景、道具、光色和语义证据一致，视频不得换脸换场或新增参考图不存在的主体。",
        endFramePrompt,
        referenceMode,
      });
    });
  });

  let editCursor = 0;
  const editRows = shots.map((shot) => {
    const start = editCursor;
    editCursor += shot.durationSeconds;
    return `分镜${String(shot.order).padStart(2, "0")}｜${formatVideoDuration(start, true)}-${formatVideoDuration(editCursor, true)}秒｜${shot.shotRole}｜${shot.transition}｜${shot.visibleProposition}｜剪辑：${shot.editPrompt}｜场景音：${shot.soundPrompt}`;
  });
  const storyShotRangeLabel = storyTargetDurationSeconds === 15
    ? "4到6"
    : storyTargetDurationSeconds === 8 ? "3" : "3到4";
  const storyPanelLabel = storyTargetDurationSeconds === 15 ? "4或5格" : "4格为主、必要时5格";
  const storyUnitSummary = storyTargetDurationSeconds
    ? `故事版单元：每段口播生成1张${storyPanelLabel}故事板参考图和1条约${storyTargetDurationSeconds}秒视频；视频内部使用${storyShotRangeLabel}个真实镜头，面板数不等于机械切镜数。`
    : "";
  const postProductionPlan = [
    storyTargetDurationSeconds
      ? "【一一对应】每个分镜只包含一段口播文案、一张意图多格故事板参考图和一个视频，编号完全一致。"
      : "【一一对应】每个分镜只包含一段口播文案、一张自动关键帧和一个视频，编号完全一致。",
    storyUnitSummary,
    "【视频轨】生成阶段不含口播、配音、对白、说话口型、字幕或背景音乐；模型支持原生音频时也只保留与动作同步的场景音。",
    "【后期对齐】批量下载视频时同步导出《分镜口播文案对照.txt》，按分镜编号完成配音和字幕对齐。",
    storyTargetDurationSeconds
      ? "【包装分工】角色表演、道具、环境反馈及非文字语义包装先画进故事板参考图，再由视频模型按真实镜头节奏延续；精确可读文字、数字、固定HUD或字幕只在后期叠加。"
      : "【包装分工】角色表演、道具、环境反馈及非文字语义包装在自动关键帧中完成，并由视频模型动画化；精确可读文字、数字、固定HUD或字幕只在后期叠加。",
    `【全片剪辑语法】${editorialBible}`,
    storyTargetDurationSeconds
      ? `【剪辑总长】约${formatVideoDuration(editCursor)}秒；共${shots.length}个分镜，每镜约${storyTargetDurationSeconds}秒，内部镜头按剧情节奏松紧变化。`
      : `【剪辑总长】约${formatVideoDuration(editCursor)}秒；共${shots.length}个分镜，每镜3到5秒并保留短暂首尾冗余。`,
    "【分镜表】",
    ...editRows,
  ].filter(Boolean).join("\n");

  return {
    promptContractVersion: aiPlan?.promptContractVersion || "legacy-fallback-v1",
    preset: {
      id: input.preset.id,
      name: input.preset.name,
      version: input.preset.version,
    },
    analysis: [
      `原文长度：约${input.script.length}字。`,
      `采用方案：${input.preset.name} v${input.preset.version}。`,
      `角色资产：从全文提取${characterAssets.length}个常驻角色，每个角色独立生成并确认定妆图；逐镜只绑定本镜出场角色。`,
      storyPlan ? "故事化步骤：原口播保持不变，已先转换为一条无对白微故事，再按故事状态拆成逐镜动作。" : "故事化步骤：未建立故事接力表。",
      storyTargetDurationSeconds
        ? `成片结构：一段口播文案对应一个故事版分镜、一个视频方案、一张意图多格故事板参考图和一个约${storyTargetDurationSeconds}秒视频；参考图4/5格用于规划，不机械等于切镜数。`
        : "成片结构：一段口播文案对应一个分镜、一个视频方案、一张自动关键帧和一个视频，四者编号完全一致。",
      `拆镜规则：${content.segmentationRules}`,
      storyTargetDurationSeconds
        ? `识别到${semanticSegments.length}个故事版分镜；每镜约${storyTargetDurationSeconds}秒，视频内部${storyShotRangeLabel}个真实镜头，图片为4/5格故事板。`
        : `识别到${semanticSegments.length}个分镜；每镜3到5秒，并由系统生成独立关键帧和视频。`,
      `视频驱动方式：${referenceMode === "first-last" ? "系统自动首尾帧" : "系统自动单关键帧"}。`,
    ].join("\n"),
    characterAssets,
    storyPlan: storyPlanText,
    consistencyPrompt,
    qualityNotes,
    postProductionPlan,
    semanticSegments: semanticSegments.map(({ narration, durationSeconds, visualShots }, index) => ({ order: index + 1, narration, durationSeconds, visualShotCount: visualShots.length })),
    shots,
  };
}
