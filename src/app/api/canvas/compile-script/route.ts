import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  AiStoryboardPlanSchema,
  KeyframeStrategySchema,
  ShotTransitionSchema,
  StoryboardCharacterListSchema,
  StoryboardStoryPlanSchema,
  VisualShotModeSchema,
  VisualEffectsLevelSchema,
  auditAiStoryboardPlanUsability,
  compileStoryboard,
  isAiStoryboardPlanUsable,
  normalizeStoryboardCharacterIdentities,
  normalizeStoryboardSegments,
  repairAiStoryboardPlanStaticPrompts,
  type AiStoryboardPlan,
  type CanvasPromptPreset,
} from "@/lib/canvas-prompt-presets";
import {
  ANIME_DIRECTOR_AGENT_PROMPT_VERSION,
  buildAnimeDirectorCanvasPrompt,
} from "@/lib/anime-director-agent-prompt";
import { loadCanvasPromptPresetStore } from "@/lib/server/canvas-prompt-store";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";

const RequestSchema = z.object({
  script: z.string().trim().min(10).max(30000),
  presetId: z.string().min(1),
  style: z.string().trim().max(500).default(""),
  ratio: z.enum(["16:9", "9:16", "4:3", "3:4", "1:1"]),
  referenceMode: z.enum(["single", "first-last"]).default("single"),
  keyframeStrategy: KeyframeStrategySchema.default("visual-anchor"),
  effectsLevel: VisualEffectsLevelSchema.default("light"),
  productionMode: z.enum(["anime-story", "real-story", "ten-second", "product-video"]).optional(),
  storyDirectorMode: z.enum(["high_energy", "cinematic", "lyrical"]).default("high_energy"),
  targetDurationSeconds: z.union([z.literal(8), z.literal(10), z.literal(15)]).default(10),
  imageModelName: z.string().trim().max(200).default(""),
  videoModelName: z.string().trim().max(200).default(""),
  videoModelDurationMode: z.enum(["fixed", "discrete", "range"]).optional(),
  videoModelDurationSeconds: z.number().positive().max(60).optional(),
  allowDurationTrim: z.boolean().default(true),
  consistencyMode: z.enum(["text-lock", "reference"]).default("text-lock"),
  assistantInstruction: z.string().trim().max(1000).default(""),
});

const AiSemanticEffectsReviewSchema = z.object({
  keepOrders: z.array(z.number().int().min(1).max(120)).max(120).default([]),
  repairs: z.array(z.object({
    order: z.number().int().min(1).max(120),
    visualMode: VisualShotModeSchema,
    reason: z.string().trim().min(10).max(360),
    transition: ShotTransitionSchema,
    cameraPlan: z.string().trim().min(10).max(500),
    editPrompt: z.string().trim().min(10).max(500),
    graphicDirection: z.string().trim().max(360).default(""),
    effectsPrompt: z.string().trim().min(50).max(1500),
    imagePrompt: z.string().trim().min(80).max(1800),
    videoPrompt: z.string().trim().min(50).max(1200),
  })).max(120).default([]),
});

const AiFinalPromptRepairSchema = z.object({
  repairs: z.array(z.object({
    order: z.number().int().min(1).max(120),
    reason: z.string().trim().min(6).max(300),
    imagePrompt: z.string().trim().min(80).max(1800),
    videoPrompt: z.string().trim().min(50).max(1200),
  })).min(1).max(6),
});

const AiShotDirectiveSchema = z.object({
  order: z.number().int().min(1).max(120),
  semanticTask: z.string().trim().min(2).max(180),
  subject: z.string().trim().max(120).default(""),
  location: z.string().trim().max(120).default(""),
  propState: z.string().trim().max(220).default(""),
  visualEvidence: z.string().trim().max(260).default(""),
  continuity: z.string().trim().max(200).default(""),
  visualMode: VisualShotModeSchema.default("narrative"),
  packagingIntent: z.string().trim().max(220).default(""),
});

const CANVAS_LLM_TIMEOUT_MS = 90_000;
const CANVAS_PROJECT_TIMEOUT_MS = 130_000;
const CANVAS_VISUAL_TIMEOUT_MS = 105_000;
const CANVAS_RECOVERY_TIMEOUT_MS = 80_000;
const CANVAS_EFFECTS_REVIEW_TIMEOUT_MS = 90_000;
const VISUAL_BATCH_SIZE = 1;
const VISUAL_BATCH_CONCURRENCY = 3;
const VISUAL_RECOVERY_CONCURRENCY = 2;
const VISUAL_RECOVERY_BATCH_CONCURRENCY = 2;
const VISUAL_MODEL_ATTEMPTS = 1;
const CANVAS_COMPILER_REVISION = `anime-story-adaptation-v56-free-canvas-pet-storyboard-${ANIME_DIRECTOR_AGENT_PROMPT_VERSION}`;
const CANVAS_PLAN_CACHE_TTL_MS = 30 * 60 * 1000;
const canvasPlanCache = new Map<string, { expiresAt: number; plan: AiStoryboardPlan }>();

function buildCanvasPlanCacheKey(
  input: z.infer<typeof RequestSchema>,
  preset: CanvasPromptPreset,
  userId: string,
) {
  return JSON.stringify({ revision: CANVAS_COMPILER_REVISION, presetId: preset.id, presetVersion: preset.version, userId, input });
}

function buildPresetAnimeDirectorCanvasPrompt(preset: CanvasPromptPreset, extraRules: string[] = []) {
  return buildAnimeDirectorCanvasPrompt(extraRules, preset.published.directorPrompt);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

type CanvasProductionMode = NonNullable<z.infer<typeof RequestSchema>["productionMode"]>;

type CanvasAgentProfile = {
  agentId: string;
  agentName: string;
  segmentRole: string;
  segmentRules: string[];
  visualRole: string;
  visualRules: string[];
  soundRule: string;
  effectsRule: string;
};

type CanvasCompilerDiagnostic = {
  model: string;
  stage: string;
  status: "accepted" | "rejected" | "failed";
  durationMs: number;
  detail?: string;
};

function formatCompilerError(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；");
  }
  if (error instanceof Error) {
    const cause = error.cause instanceof Error
      ? `；cause: ${error.cause.name}: ${error.cause.message}`
      : error.cause ? `；cause: ${String(error.cause)}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

const CANVAS_AGENT_PROFILES: Record<CanvasProductionMode, CanvasAgentProfile> = {
  "anime-story": {
    agentId: "__canvas_anime_storyboard__",
    agentName: "动漫剧情分镜助手",
    segmentRole: "你是动漫剧情智能体中的口播语义分段器和全片动画设定师，只服务动漫剧情工作流。",
    segmentRules: [
      "自动识别文案属于情感、知识、观点、冒险、喜剧或其他剧情方向，不要求用户先选择温情、萌宠等题材标签。",
      "projectBible必须建立可持续复用的动画角色、环境和渲染设定，并让后续所有镜头保持同一动画世界。characterBible要把全文反复出现的每个角色分别编号，写成可直接生成角色设定板的身份规范。",
      "如果文案是宠物科普或宠物关系内容，默认主场景从语义推断，可在家里、客厅、小区、公园、宠物店、室内护理、宠物健康中心之间切换；不要机械默认室外大马路。",
      "宠物故事默认角色为年轻亚洲女主人和自然四足狗狗。女主人穿黄色时尚短款连帽卫衣或轻运动休闲上衣、蓝色牛仔裤或休闲裤、白色运动鞋，商业3D动画角色气质；同一条视频内服装稳定，特殊文案可按主人性别或场景微调。",
    ],
    visualRole: "你是动漫剧情智能体中的动画导演、视频提示词设计师和自动关键帧设计师，只服务动漫剧情工作流。",
    visualRules: [
      "采用高互动3D萌宠短片的可迁移导演法，而不是复制案例：先把每段信息压缩成观众必须亲眼看懂的可见命题，再为它设计一个微剧情冲突、一个可执行主动作、一个清楚物理证据和一个结果反应。知识科普也必须让角色与道具发生动作，禁止静态站桩、产品陈列或把口播改写成说明画面。",
      "连续剧情锁定同一主角和状态线；知识清单可以采用独立单元微剧情，但每镜对象必须具体，不能用‘同一只狗/同一个人’代替犬种、年龄、外观和身份。若各条使用不同客串角色，必须明确它们是不同实体，不能伪装成同一角色。",
      "每镜先列出摄像机已经能看到的行为、道具和环境证据，再识别观众仍看不见却必须理解的语义缺口。没有缺口就不加装饰；存在缺口时，自主选择符号贴纸、动态线条、粒子、材质色彩变化、道具夸张、环境反馈、局部透视、非身体类完整演示空间或其他最准确的视觉载体。身体机理只能使用完整正常主体旁的局部放大窗。这里没有固定关键词映射，同一种情绪或知识在不同剧情中也必须重新设计。",
      "高能包装按语义触发，不乱加特效：疑问用问号、放大镜或疑问贴纸；误解用错接线、错位标签或摇摆牌；危险用红橙警示牌、警戒线、压近阴影或尖角图标；结论用金色结论牌、绿色勾选章或爪印盾牌；反转用红黑爆裂牌、裂片翻转或方向急转；情绪压力用角色外侧光晕、压迫阴影或细密震动线；知识重点用安全示意面板、图标贴纸、箭头和颜色区。所有包装必须从角色动作、道具接触、视线、脚步、牵引绳、食盆、放大镜、称重盘或环境反馈触发，按出现、增强、接触或改变、收束的生命周期写入imagePrompt和videoPrompt。",
      "钩子优先选异常道具特写、极端但有因果的反应、动作即将失控的前一刻、巨大尺度反差或强烈危险光。相邻镜头在近景表演、道具特写、低机位动作、俯视证据和语义切片之间变化，禁止连续重复居中中景。字幕、标题、排行数字、价格牌和关注按钮属于后期信息层，不写进生图或视频提示词。",
      "每镜先从对应口播分镜提炼唯一【语义重点】，明确观众这一帧必须看懂什么；再写本镜在几秒内如何表演和拍摄，最后综合语义重点与视频方案反推唯一静态关键帧。不能只从摄影动作推图片，也不能把口播原文直接画成说明图。",
      "motionPrompt必须严格使用【入镜】【预备】【主动作】【反应】【落幅】五个标签，各写一个能被视频模型直接执行的连续动作节拍。【入镜】继承上一镜的角色屏幕位置、视线、道具状态、光线方向或可解释的转场桥梁；【预备】写重心、视线、耳朵、手部或道具的蓄势；【主动作】只完成一个核心动作；【反应】写角色、道具和环境的同步反馈；【落幅】形成稳定姿态，并为下一镜留下方向、视线、道具或前景遮挡锚点。即使安静段落也必须有一眼可读的微表演，不能退化为静态摆拍。建议90到260字，不复制口播原文，不堆叠角色设定、静态构图清单、模型参数或负面词。",
      "imagePrompt必须同时依据对应口播的语义重点与motionPrompt，写成一个单一静态瞬间；它必须与【入镜】处于同一姿态和空间关系，优先选择核心动作即将发生前、张力最大且仍有后续动作空间的关键帧，而不是动作已经结束的结果帧。每条必须逐项明确：主体姿态与表情、唯一机位与景别、光线方向或色温、前中后景空间层次、至少一个场景或叙事道具；缺少任意一项即为不合格。若本镜决定使用图形特效，必须把它的静态初始形态、语义对象、空间位置与方向直接画进这个关键帧。角色不能只是无目的站立、坐着或趴着，建议120到280字，完整语义切片可到380字；不复制动态时间轴，不出现随后、逐渐、最后等动态过程词。",
      "自由画布同时服务图文注释版和纯画面参考版：图文注释版用于用户校准，一图多格可带每格很短的中文镜头说明；纯画面版用于图生视频参考，必须把说明条、小字、字幕和导演注释转成图标、无字牌面、箭头、颜色区或空间锚点，避免文字污染视频。",
      "面向Veo等对人物肖像敏感的图生视频模型时，如果人的面部不是本镜唯一核心反应，imagePrompt只能让固定服装的手、前臂、肩背、背影或画外动作入镜，并逐字写明‘头部和面部完全在画框外，不出现正脸、侧脸或可识别五官’；禁止只写背身却仍生成完整人物正脸。只有人物面部表演不可替代时才保留完整卡通脸。",
      "把会影响剧情因果的道具当作有状态的视觉资产。imagePrompt必须写清关键道具的具体品种或类型、数量、尺寸、颜色材质、完整或切分状态、是否去核/开封/密封以及位置；不能用水果、食物、那个东西等泛称代替。容易混淆时只增加针对性的禁止替代物，例如去核苹果丁不得变成整颗苹果、梨、土豆或斑点圆果。videoPrompt还要锁定关键道具在运动中的尺寸、数量和形状，小块食物必须写明始终小于犬鼻或手指宽度、不放大、不增殖、不变成整颗水果。qualityCriteria要把关键道具状态错误列为重生成条件。",
      "videoPrompt必须把同一核心动作写成三段可见变化：先给清楚的预备基线，再发生一个方向、速度和幅度明确的核心变化，最后让身体、道具或环境留下结果并稳定落幅。情绪不能只靠发光、雾气或运镜表达；恐惧、惊喜、心虚、疼痛等至少要让耳朵、视线、毛发、重心、尾巴、爪垫、手部或道具中的两项同步变化。镜头和包装只能放大表演，不能代替表演。",
      "动漫角色必须进行有剧情目的、与当前语境强度匹配的动画化夸张表演；通过姿态、视线、身体重心、动作节奏、道具和环境反馈讲故事，不得用写实克制作为省略表演设计的理由。唯一与口播有关的硬限制是角色不说话、不做对白口型，旁白和字幕全部留给后期。",
      "狗狗只做中度犬类动画化表情：允许瞪眼、眼白扩大、瞳孔扫视、耳朵压低或竖起、尾巴反馈、缩脖、后缩、靠近主人、惊恐、委屈或好奇表情；禁止狗狗长人手、站着走路、招手、拿工具、穿成人服装或变成人形。",
      "健康、医院、伤口、私密部位和身体不适内容必须安全表达：用兽医十字图标、听诊器贴纸、爪印盾牌、检查勾选章、健康记录卡、外部中景检查动作、侧腰外轮廓、抽象颜色区和安全示意面板；不要直给血腥伤口、私密部位、解剖或令人不适的身体局部特写。",
      "effectsPrompt必须完成五层导演决定：【语义重点】本镜必须看懂什么；【剧情表演】主体怎么演；【叙事道具】什么物件证明因果；【环境反馈】场景如何响应；【装饰内容】针对尚未被前四层说清的语义缺口，自主设计唯一可见方案及其绑定对象、空间位置、初始形态和运动落点，没有缺口则明确写无。装饰内容不受固定符号清单限制，但必须来自当前文案和上下文。",
      "当包装强度为丰富时，每镜至少要有一个与语义绑定的视觉强调点，但强调点可以来自叙事道具、环境响应、前景遮挡、构图光影或非文字图形特效，不能把丰富包装误解为每镜都画光弧和波纹。同批镜头若全部使用图形特效，必须重新判断其中物理证据已经清楚的镜头并改为无。",
      "全片避免无因复用同一种视觉语法。画面丰富度首先来自表演、道具、环境、构图、光影和材质；装饰不能为了热闹而出现，也不能替代剧情证据。一旦决定使用，必须同时进入effectsPrompt、imagePrompt和videoPrompt：参考图画出静态初始形态，视频只让同一组内容随剧情启动、运动和消退。三者不一致必须直接重写最终提示词。",
      "情绪线、速度线、声波和脉冲线必须放在角色身体轮廓外的留白区或场景表面，并与毛发、躯干和四肢保留明显间隔；禁止穿过、贴附、缠绕或捆绑身体，禁止画成绳索、电线、束缚带或管线。危险物、棉球、食物和药物不得从现实道具向动物口鼻或身体排成路径；若没有真实吞食动作，现实场景只留落地证据，机理运动只发生在局部教学窗内部。",
    ],
    soundRule: "soundPrompt只写本镜真实发生且与画面逐拍同步的场景音、环境声、动作音和道具音，建议10到80字；用户后期配音，生成视频不得出现人物开口说话、旁白、字幕朗读、背景音乐、配乐、BGM、口播、配音、对白或说话声。",
    effectsRule: "动漫剧情先靠剧情道具、角色表演和环境反应传达语义，再逐镜识别仍不可见的语义缺口，并自主设计最合适的装饰内容或非身体类完整演示。身体机理只能放进完整正常主体旁的局部放大窗。没有固定符号映射；所有修饰必须与当前口播、上下文和镜头动作直接对应，并同步写入最终生图与视频提示词。",
  },
  "real-story": {
    agentId: "__canvas_real_storyboard__",
    agentName: "真人剧情分镜助手",
    segmentRole: "你是真人剧情工作流中的口播语义分段器和全片人物、场景设定师。",
    segmentRules: ["按人物目标、行动、冲突、视线关系和情绪转折建立连续设定，不套用动漫角色或宠物行为模板。"],
    visualRole: "你是真人剧情工作流中的影视分镜导演和关键帧设计师。",
    visualRules: [
      "motionPrompt只写真人可执行的动作、表演、调度、焦段感、主要运镜和落幅；遵守真实物理、空间与光影连续。",
      "imagePrompt从视频方案反推单一电影关键帧，写清人物状态、场面调度、焦段景深和真实材质，不套用动漫包装。",
    ],
    soundRule: "soundPrompt只写环境底声和动作音；禁止背景音乐、配乐、旁白和配音。除非文案明确包含角色对白，否则不设计说话口型，字幕后期添加。",
    effectsRule: "默认不使用卡通图标、气泡、速度线或动画符号，只通过表演、调度、镜头和光影表达。",
  },
  "ten-second": {
    agentId: "__canvas_ten_second_video__",
    agentName: "10秒视频分镜助手",
    segmentRole: "你是10秒短视频工作流中的精简文案分段器和统一视觉设定师。",
    segmentRules: ["优先保留一个钩子、一个核心动作和一个清晰落点，避免把10秒内容拆得过碎。"],
    visualRole: "你是10秒短视频工作流中的精简镜头导演和关键帧设计师。",
    visualRules: ["通常只设计1到4个必要镜头；motionPrompt保持短而可执行，imagePrompt只服务对应镜头首帧。"],
    soundRule: "soundPrompt只写必要环境音或动作音；禁止背景音乐、配乐、旁白和配音，字幕后期添加。",
    effectsRule: "只使用能在10秒内看懂的单一视觉强化手段，不堆叠效果。",
  },
  "product-video": {
    agentId: "__canvas_product_video__",
    agentName: "产品视频分镜助手",
    segmentRole: "你是产品视频工作流中的卖点分段器和产品视觉设定师。",
    segmentRules: ["按卖点、证据、使用动作和结果划分，始终保持真实产品结构、包装和品牌信息。"],
    visualRole: "你是产品视频工作流中的广告镜头导演和产品关键帧设计师。",
    visualRules: ["动作与运镜必须服务卖点，禁止重构产品外形、颜色、包装、Logo和关键文字。"],
    soundRule: "soundPrompt只写产品交互音、环境音和必要转场音；禁止背景音乐、配乐、旁白和配音，字幕后期添加。",
    effectsRule: "广告动效只能强化产品和卖点，不得遮挡产品或改变真实结构。",
  },
};

function resolveCanvasAgentProfile(productionMode?: CanvasProductionMode) {
  return CANVAS_AGENT_PROFILES[productionMode || "anime-story"];
}

const AiProjectPlanSchema = z.object({
  projectBible: z.object({
    characters: StoryboardCharacterListSchema,
    characterBible: z.string().trim().min(30).max(1500),
    environmentBible: z.string().trim().min(30).max(1500),
    visualBible: z.string().trim().min(30).max(1500),
    packagingBible: z.string().trim().min(30).max(1500).default("全片语义包装统一使用同一套线条粗细、材质、色彩、辉光、透视和动效节奏；具体图形只由逐镜语义决定，不使用可读文字。"),
    editorialBible: z.string().trim().min(30).max(1500).default("生成镜头保持单一连续动作；后期从每条素材中选取稳定动作区间，以道具特写、反应近景、身体证据和语义切片形成节奏；标题、编号、字幕和HUD统一后期添加。"),
    performanceMode: z.enum(["emotional", "natural", "dynamic", "comedy", "educational", "dramatic"]).default("natural"),
    performanceBible: z.string().trim().min(30).max(1500).default("叙事自然型；动作幅度与响应速度根据各段语义自适应，保持连续表演，不强制喜剧或抒情。"),
    storyPlan: StoryboardStoryPlanSchema,
    storylineBible: z.string().trim().max(2000).default(""),
    shotDirectives: z.array(AiShotDirectiveSchema).max(120).default([]),
  }),
  sourceIssues: AiStoryboardPlanSchema.shape.sourceIssues,
});

const AiShotDirectivePlanSchema = z.object({
  storyPlan: StoryboardStoryPlanSchema,
  storylineBible: z.string().trim().min(20).max(2000),
  shotDirectives: z.array(AiShotDirectiveSchema).min(1).max(120),
});
type AiShotDirectivePlan = z.infer<typeof AiShotDirectivePlanSchema>;
const AiSimpleVisualBatchSchema = z.object({
  segments: z.array(z.object({
    narration: z.string().trim().min(1).max(500),
    durationSeconds: z.number().int().min(3).max(5),
    castIds: z.array(z.string().trim().min(1).max(60)).min(1).max(4),
    visualMode: VisualShotModeSchema,
    directorDecision: z.string().trim().min(30).max(1000),
    motionPrompt: z.string().trim().min(50).max(1000),
    imagePrompt: z.string().trim().min(80).max(1200),
    videoPrompt: z.string().trim().min(40).max(800),
    scenePrompt: z.string().trim().min(30).max(600),
    packagingPrompt: z.string().trim().min(30).max(800),
    qualityCriteria: z.string().trim().min(20).max(600),
  })).min(1).max(VISUAL_BATCH_SIZE),
});
const shotDirectiveCache = new Map<string, { expiresAt: number; plan: AiShotDirectivePlan }>();

function waitFor(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientCanvasModelError(error: unknown) {
  return /(?:429|502|503|504|temporarily unavailable|timeout|timed out|fetch failed|connection)/iu.test(formatCompilerError(error));
}

function extractMessageContent(payload: Record<string, unknown>) {
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content || "";
}

function parseJsonContent(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as unknown;
  } catch (directError) {
    const firstObject = cleaned.indexOf("{");
    const firstArray = cleaned.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;
    if (start < 0) throw directError;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
      else if (character === "}" || character === "]") {
        if (stack.pop() !== character) throw directError;
        if (stack.length === 0) return JSON.parse(cleaned.slice(start, index + 1)) as unknown;
      }
    }
    throw directError;
  }
}

function parseAiPayload<T>(schema: z.ZodType<T>, payload: unknown, stage: string) {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;

  const shape = payload && typeof payload === "object"
    ? Object.keys(payload as Record<string, unknown>).join(", ") || "empty object"
    : typeof payload;
  const issues = parsed.error.issues.slice(0, 10).map((issue) => (
    `${issue.path.join(".") || "root"}: ${issue.message}`
  )).join(" | ");
  const sample = JSON.stringify(payload).slice(0, 800);
  throw new Error(`${stage} JSON shape invalid; issues: ${issues}; keys: ${shape}; sample: ${sample}`);
}

function normalizeAiProjectPlanPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.sourceIssues)) return payload;

  const sourceIssues = record.sourceIssues.flatMap((entry) => {
    if (typeof entry === "string") {
      const value = entry.trim();
      return value ? [{ quote: value.slice(0, 120), issue: value.slice(0, 300) }] : [];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const issue = entry as Record<string, unknown>;
    const pickString = (...keys: string[]) => keys
      .map((key) => issue[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim() || "";
    const issueText = pickString("issue", "problem", "description", "reason", "message");
    const quote = pickString("quote", "original", "text", "source", "excerpt") || issueText;
    if (!issueText && !quote) return [];
    const suggestion = pickString("suggestion", "recommended", "fix", "correction");
    return [{
      quote: (quote || issueText).slice(0, 120),
      issue: (issueText || quote).slice(0, 300),
      ...(suggestion ? { suggestion: suggestion.slice(0, 300) } : {}),
    }];
  });

  return { ...record, sourceIssues };
}

async function callCanvasLlm(
  request: Request,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxReplyTokens: number,
  timeoutMs = CANVAS_LLM_TIMEOUT_MS,
) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const body = JSON.stringify({
    messages: [{ role: "user", content: userPrompt }],
    agentId: "__canvas_storyboard_compiler__",
    agentName: "画布分镜编译器",
    internal_workflow: "canvas-compiler",
    model: model || undefined,
    model_overridden: Boolean(model),
    stream: false,
    system_prompt: systemPrompt,
    response_format: "json_object",
    deep_thinking_type: 0,
    deep_thinking_overridden: true,
    temperature: 0.2,
    max_reply_tokens: maxReplyTokens,
    timeout: Math.max(10, Math.floor(timeoutMs / 1000) - 5),
  });
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(new URL("/api/llm", request.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
        body,
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.error || `AI拆镜失败（HTTP ${response.status}）`));
      return parseJsonContent(extractMessageContent(payload));
    } catch (error) {
      lastError = error;
      const isTimeoutOrAbort = error instanceof Error
        && (error.name === "TimeoutError" || error.name === "AbortError");
      const canRetry = attempt < 2
        && !request.signal.aborted
        && !isTimeoutOrAbort
        && isTransientCanvasModelError(error);
      if (!canRetry) throw error;
      await waitFor(800 * (attempt + 1));
    }
  }
  throw lastError;
}

const FORBIDDEN_FINAL_SOUND_PATTERN = /(?:旁白|配音|对白|说话声|字幕|背景音乐|配乐|BGM)/iu;

function sanitizeFinalSoundPrompts(plan: AiStoryboardPlan): AiStoryboardPlan {
  return {
    ...plan,
    segments: plan.segments.map((segment) => ({
      ...segment,
      visualShots: segment.visualShots.map((shot) => {
        const graphicSection = shot.effectsPrompt.match(/【图形特效】([^【\r\n]+)/u)?.[1]?.trim() || "";
        const lacksExecutableGraphic = !graphicSection || /^(?:无|不使用|不添加|不需要)/u.test(graphicSection);
        return {
          ...shot,
          visualMode: shot.visualMode !== "narrative" && lacksExecutableGraphic
            ? "narrative"
            : shot.visualMode,
          soundPrompt: FORBIDDEN_FINAL_SOUND_PATTERN.test(shot.soundPrompt || "")
            ? "与画面逐拍同步的现场环境底声、脚步声、衣料摩擦声和道具接触声。"
            : shot.soundPrompt,
        };
      }),
    })),
  };
}

async function requestAiSegments(
  request: Request,
  input: z.infer<typeof RequestSchema>,
  preset: CanvasPromptPreset,
  model: string,
) {
  const agentProfile = resolveCanvasAgentProfile(input.productionMode);
  const semanticSegments = normalizeStoryboardSegments(input.script);
  const conciseAnimeSystemPrompt = [
    buildPresetAnimeDirectorCanvasPrompt(preset),
    "固定口播分段已经完成。本阶段先把整篇口播转换成一条无对白微故事，再建立角色、风格和逐段画面任务。不改口播，不重分段，不写生图或视频提示词。只返回JSON。",
    "storyPlan先确定主角目标、触发事件、升级、转折和收束，再让每段口播对应一个连续事件。beats必须与口播段等长；上一beat的resultState必须能成为下一beat的entryState，handoffToNext要点名可交接的动作方向、视线、道具或空间状态。清单类也要变成同一主角连续经历的一组测试，不能每条重新开场。",
    "格式：{\"projectBible\":{\"characters\":[{\"id\":\"character-1\",\"name\":\"具体角色名\",\"aliases\":[],\"kind\":\"person/animal/product/object/other\",\"importance\":\"primary/supporting/background\",\"fixedAppearance\":\"具体固定外观\",\"explicitTraits\":[],\"inferredTraits\":[]}],\"characterBible\":\"角色关系\",\"environmentBible\":\"常驻空间和道具\",\"visualBible\":\"统一风格\",\"packagingBible\":\"全片包装质感\",\"editorialBible\":\"剪辑节奏\",\"performanceMode\":\"emotional/natural/dynamic/comedy/educational/dramatic\",\"performanceBible\":\"表演基调\",\"storyPlan\":{\"premise\":\"无对白故事前提\",\"protagonistGoal\":\"主角目标\",\"incitingIncident\":\"触发事件\",\"escalation\":\"逐步升级\",\"turningPoint\":\"转折\",\"resolution\":\"收束\",\"beats\":[{\"order\":1,\"storyFunction\":\"hook/setup/trigger/escalation/turn/reveal/payoff/cta\",\"event\":\"本句在故事中发生的事件\",\"entryState\":\"入镜状态\",\"action\":\"可执行动作\",\"resultState\":\"动作造成的新状态\",\"handoffToNext\":\"交给下一镜的锚点\"}]},\"storylineBible\":\"事件和道具状态线\",\"shotDirectives\":[{\"order\":1,\"semanticTask\":\"当前句画面任务\",\"subject\":\"主体\",\"location\":\"空间\",\"propState\":\"道具状态\",\"visualEvidence\":\"不可替换的可见证据\",\"continuity\":\"前后承接\",\"visualMode\":\"narrative/hybrid-packaging/semantic-cutaway\",\"packagingIntent\":\"包装内容和位置；不需要时留空\"}]},\"sourceIssues\":[]}。",
    "shotDirectives必须与口播段等长并逐项对应。每项直接点名当前句不可替换的对象或动作；相邻项不能是换个说法的同一画面。只有情绪、感知、因果或知识点需要额外可视化时才设计非文字包装，形式由当前语义自由决定。",
    "角色必须具体。人物写地域外观、年龄、发型和固定服装；宠物写明确品种、体型、毛色和五官。禁止用“同一个人、同一只狗、那个角色”命名，宠物保持天然四足结构。",
    "动漫剧情的characters只收录承担表演的人物和动物。异物、碎片、食物、药品、玩具、家具、器官、产品和其他无生命物件必须写入environmentBible、storylineBible或shotDirectives.propState，禁止建立角色id或角色定妆图。",
    "原文出现两个或更多同品种角色时，必须按真实实体数量分别建立不同id和不同name，并用年龄感、毛色深浅、体型、眼睛、项圈或其他稳定识别点区分；不得把“两只金毛、两只狗、双方”合并成一个角色，也不得给两个实体完全相同的名称和外观。",
    "保持精炼：全局设定各不超过180字，单个角色外观不超过120字，逐段任务各不超过60字。sourceIssues只记录原文确有的问题，没有则返回空数组。",
  ].join("\n");
  const legacySystemPrompt = [
    input.productionMode === "anime-story"
      ? buildPresetAnimeDirectorCanvasPrompt(preset, [
          "当前阶段只输出 projectBible 和 sourceIssues，不输出 segments。分镜文案已经由本地规则固定，必须围绕固定口播分段建立导演表。",
        ])
      : "",
    agentProfile.segmentRole,
    "本阶段只检查原文并建立全片统一设定。口播分段已由本地语义规则完成，不得重分段；不写逐镜提示词。只返回JSON。",
    "格式：{\"projectBible\":{\"characters\":[{\"id\":\"character-1\",\"name\":\"唯一角色名\",\"aliases\":[\"原文别名\"],\"kind\":\"person/animal/product/object/other之一\",\"importance\":\"primary/supporting/background之一\",\"fixedAppearance\":\"唯一固定身份外观\",\"explicitTraits\":[\"明确特征\"],\"inferredTraits\":[\"连续性补充\"]}],\"characterBible\":\"角色关系与比例\",\"environmentBible\":\"连续场景与固定道具\",\"visualBible\":\"统一风格材质光影\",\"packagingBible\":\"非文字包装统一视觉语法\",\"editorialBible\":\"平均镜长、微镜头变化、声音和后期文字规则\",\"performanceMode\":\"emotional/natural/dynamic/comedy/educational/dramatic之一\",\"performanceBible\":\"全片演绎规划\",\"storylineBible\":\"事件、空间和道具状态主线\",\"shotDirectives\":[{\"order\":1,\"semanticTask\":\"本段唯一可见意思\",\"subject\":\"本镜核心主体\",\"location\":\"本镜固定空间\",\"propState\":\"关键道具当前状态\",\"visualEvidence\":\"必须可见的因果证据\",\"continuity\":\"入镜承接：具体锚点；落幅交接：具体锚点\",\"visualMode\":\"narrative/hybrid-packaging/semantic-cutaway之一\",\"packagingIntent\":\"必要的非文字包装及绑定位置；narrative时留空\"}]},\"sourceIssues\":[]}。",
    "shotDirectives必须与固定口播分段等长且order逐项对应。先把所有镜头作为一条完整Beat Board规划，再逐镜填写；semanticTask不超过30字，subject和location不超过25字，propState、visualEvidence和continuity各不超过60字，packagingIntent不超过50字。continuity必须同时写出当前入镜如何承接上一镜，以及当前落幅给下一镜留下什么，至少点名视线、方向、屏幕侧别、道具状态、光线、前景形状或声音桥中的一个，禁止只写‘自然衔接’。",
    "物理表演、道具和环境足够一眼说清时选narrative；内在状态、感知、速度力量、因果或认知转折确需一组非文字强化时选hybrid-packaging；记忆、时间、关系、统计或身体机理更适合完整可视化时才选semantic-cutaway。丰富包装不等于每镜都选后两种；narrative的packagingIntent留空。",
    "同一口播段若同时包含可见动作与无法直接看见的明确语义，不得只保留动作而丢掉内在状态、感知方向、拟声、速度力量比喻或认知转折。纯表演、道具和环境不能完整传达该明确语义时，禁止选narrative；选择hybrid-packaging或semantic-cutaway，并在packagingIntent直接写出由本段语义推导的可见形态、绑定对象、画面位置和方向。不要套固定图标。",
    "保持全局设定精炼：characterBible、environmentBible、visualBible、packagingBible、performanceBible和storylineBible各不超过180字；单个角色fixedAppearance不超过120字。不要输出解释、分析过程或逐镜生图/视频提示词。",
    "projectBible必须根据原文、用户风格和补充要求建立可重复使用的明确设定；用户已经指定的物种、毛色、花纹、体型、眼睛和配饰必须逐项写入characterBible并保持原样，不得用‘无任何花纹描述’等模糊说法覆盖明确设定。只有确实未提及的外观细节才不要擅自添加。后续所有镜头必须复用同一设定。",
    "characters只登记需要跨镜头保持身份一致的常驻人物、动物、产品或关键主体，每个真实实体只能使用一个稳定且唯一的id。fixedAppearance只写单个实体的身份与外观；原文或用户明确提供的细节写进explicitTraits，系统为连续性合理补齐的细节写进inferredTraits，绝不能把推断伪装成原文事实。",
    "角色资产必须是可直接生成的具体对象，name和fixedAppearance严禁使用‘同一个人、同一位主人、同一只狗、那个角色、原文中的主体’作为身份定义。人物至少明确地域/族裔外观、性别表达、年龄段、体型、脸型五官、发型、固定服装和两个识别点；狗至少明确具体品种、年龄段、体型、天然四足比例、毛色花纹、眼睛、耳朵、口吻、鼻头和尾巴。原文只写‘狗狗’时必须结合剧情选择一个具体品种，并将选择写入inferredTraits。",
    "每张角色定妆图只对应一个实体：人物保持自然人类头部与四肢，禁止动物头、毛脸和兽化；宠物保持天然四足犬科或猫科结构，禁止人类躯干、直立双足、人手人脚和人类服装，除非原文明确要求拟人设定。",
    "必须先做全文指代消解：同一实体的姓名、代词、关系称呼和口语称呼合并到同一个characters条目，name使用最明确的唯一名称，其他称呼全部写进aliases。例如‘我、主人、女主人’确指同一人时只能建一个角色，禁止为每种称呼分别建卡。",
    "先判断第一人称叙事者或主人是否会在多个镜头承担翻找、触碰、观察、训斥、安抚、反应或与主体同框等可见行动；若会，即使原文只写‘我’，也必须把它合并为一个常驻人物角色并建立唯一角色卡。只有全程纯画外旁白、视觉上完全不需要出现身体或可识别外观时才不建角色。",
    "原文未指定人物年龄、发型或服装时，可以为制作连续性在inferredTraits中补齐一套克制且固定的外观，但不得冒充原文事实；用户指定女主人、男主人或具体服装时必须优先原样锁定。只出现一次且不需要身份连续性的路人、维修师傅等临时人物不建全局角色卡，直接在对应镜头场景中描述。",
    "中文项目中，原文没有明确地域或族裔时，常驻人物默认使用中国人/东亚面孔；女主人默认成年中国女性，五官自然清秀、深色头发、亲和耐看，不做欧美面孔或夸张网红脸。原文或用户明确指定的地域、族裔与外观必须优先覆盖该默认值，并把默认项记入inferredTraits而非explicitTraits。",
    "动漫剧情中的沙发、房门、玩具等普通家具和叙事道具写入environmentBible或逐镜scenePrompt，不得冒充角色；只有产品制作模式中的核心产品或确需跨镜保持唯一外观的关键物件才可登记为product/object。",
    "每个characters条目以后只生成一张独立角色定妆图：中性背景、单角色、无遮挡、无剧情场景、无叙事道具、无图形特效、无文字、无多宫格和多视图。characterBible只补充角色之间的身高比例、关系和全片一致性规则；没有明确换装剧情时，全片沿用同一套服装。",
    "environmentBible要列出会重复出现的固定空间、关键家具和道具及其相对位置；visualBible要写清全片统一的角色比例、渲染材质、镜头质感、主色和光影规则。三项设定共同用于先生成角色设定板，再约束逐镜关键帧。",
    "projectBible还必须返回packagingBible：只定义全片统一的语义包装视觉语法，包括线条粗细、材质、色彩、辉光、透视、空间融合方式和运动节奏；不得预设每镜都出现同一种图标，具体包装由逐镜语义决定。",
    "projectBible还必须返回editorialBible：明确全片平均镜长、道具特写/反应近景/身体证据/语义切片的变化节奏、字幕标题编号的后期分工、声音落点和统一调色原则；不得把可读文字交给图片或视频模型生成。",
    "全文中的‘它、这个、这些东西、那里、表面看上去没事’等代词或泛称，必须结合前后相邻句指向已经出现或即将明确出现的具体主体和道具。后文给出沙发、玩具、门、产品等明确对象时，前面的泛称沿用该对象及其状态线，不得为了丰富画面擅自另造遥控器、手机或其他无关物品。只有原文明示多个对象或明确进入比喻镜头时才允许新增。",
    "projectBible还必须返回performanceMode和performanceBible。先完整阅读全文，再只选一个主型：情感抒情=emotional、叙事自然=natural、轻快高动态=dynamic、喜剧反差=comedy、知识演示=educational、紧张戏剧=dramatic；performanceBible写清整体动作幅度、角色响应速度、镜头节奏、情绪曲线和装饰边界。不要因一两个词误判整片：情感类以细腻连续反应和克制动作服务情绪；轻快高动态可以动作更快更大但不等同于搞笑；只有反差或笑点是主要吸引力时才定义为comedy。禁止用模糊的二选一表述代替明确分类。",
    "sourceIssues只记录确有依据的疑似错字、语音识别错误、异常断句、前后矛盾、指代混乱或明显事实风险；没有问题时返回空数组。绝不擅自改写原文，建议必须交给用户确认。",
    ...agentProfile.segmentRules,
  ].join("\n");
  const systemPrompt = input.productionMode === "anime-story" ? conciseAnimeSystemPrompt : legacySystemPrompt;
  const payload = await callCanvasLlm(
    request,
    model,
    systemPrompt,
    `制作方向：${input.productionMode || "自动"}\n故事版导演：${input.storyDirectorMode}\n目标视频时长：${input.targetDurationSeconds}秒\n风格：${input.style || "未指定"}\n比例：${input.ratio}\n补充要求：${input.assistantInstruction || "无"}\n固定口播分段：${JSON.stringify(semanticSegments)}\n原始文案：\n${input.script}`,
    Math.min(6400, Math.max(3200, 2400 + semanticSegments.length * 120)),
    CANVAS_PROJECT_TIMEOUT_MS,
  );
  if (!payload) return null;
  const parsed = parseAiPayload(AiProjectPlanSchema, normalizeAiProjectPlanPayload(payload), "project bible");
  const normalizedCharacters = normalizeStoryboardCharacterIdentities(parsed.projectBible.characters, input.script);
  return {
    projectBible: {
      ...parsed.projectBible,
      characters: normalizedCharacters.characters,
    },
    sourceIssues: parsed.sourceIssues,
    segments: semanticSegments,
  };
}

async function requestAiShotDirectives(
  request: Request,
  input: z.infer<typeof RequestSchema>,
  preset: CanvasPromptPreset,
  segments: Array<{ narration: string; durationSeconds: number }>,
  model: string,
) {
  const cacheKey = JSON.stringify({
    revision: CANVAS_COMPILER_REVISION,
    model,
    productionMode: input.productionMode,
    script: input.script,
    segments,
  });
  const cached = shotDirectiveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.plan;
  if (cached) shotDirectiveCache.delete(cacheKey);
  const conciseAnimeSystemPrompt = [
    buildPresetAnimeDirectorCanvasPrompt(preset),
    "只补全无对白故事接力和逐段画面任务，不写生图和视频提示词。任务必须与固定口播段等长、顺序一致，只返回JSON。",
    "先把口播变成一条完整微故事：主角有目标，事件有触发、升级、转折和结果；每个beat都必须改变角色、道具或环境状态，并把结果交给下一镜。不得把各句做成互不相关的站桩插画。",
    "每段点名当前句独有的主体、空间、道具状态和可见证据；相邻段不能用重复动作或空泛人物反应代替。需要视觉包装时直接写包装内容、位置和静态形态，不需要时留空。",
    "心动、爱慕、信任、敌意、嫉妒、依恋、疏远等关系状态属于不可直接看见的语义，不能仅靠靠近、摇尾、对视等普通动作判为已经讲清；必须选择hybrid-packaging或semantic-cutaway，并设计一组绑定双方互动空间的可见关系证据。具体载体由剧情重新推导，不固定套桃心。",
    "格式：{\"storyPlan\":{\"premise\":\"无对白故事前提\",\"protagonistGoal\":\"主角目标\",\"incitingIncident\":\"触发事件\",\"escalation\":\"升级\",\"turningPoint\":\"转折\",\"resolution\":\"收束\",\"beats\":[{\"order\":1,\"storyFunction\":\"hook/setup/trigger/escalation/turn/reveal/payoff/cta\",\"event\":\"事件\",\"entryState\":\"入镜状态\",\"action\":\"动作\",\"resultState\":\"结果状态\",\"handoffToNext\":\"下一镜交接\"}]},\"storylineBible\":\"全片事件和道具状态线\",\"shotDirectives\":[{\"order\":1,\"semanticTask\":\"当前句画面任务\",\"subject\":\"主体\",\"location\":\"空间\",\"propState\":\"道具状态\",\"visualEvidence\":\"不可替换的可见证据\",\"continuity\":\"前后承接\",\"visualMode\":\"narrative/hybrid-packaging/semantic-cutaway\",\"packagingIntent\":\"包装内容和位置或留空\"}]}。",
  ].join("\n");
  const payload = await callCanvasLlm(
    request,
    model || "gpt-5.4",
    input.productionMode === "anime-story" ? conciseAnimeSystemPrompt : [
      "你是影视项目的全片语义连续性导演，只做逐段语义消解和主体、场景、道具状态规划，不写生图或视频提示词。",
      "用户输入默认是短视频口播文案，不是要求原样演出的文学剧本。每段画面必须服务对应口播信息：把句中的具体动作、对象、风险、情绪或处理方法变成一个可见事件，不能擅自续写人物剧情，也不能用人物走路、停步、回头、弯腰等通用动作替代本段事实。",
      "先阅读全文，写清唯一事件主线以及核心主体和道具从开始到结束的状态变化；不得把泛称、代词或抽象句另做成无关示例。后文已经明确具体对象时，前面的泛称必须沿用该对象，不得另造遥控器、手机或其他文案没有支持的新物件。",
      "shotDirectives必须与固定口播分段等长、order逐项对应。先规划完整Beat Board，再为每项填写本段唯一可见意思、主体、固定空间、核心道具当前状态、观众必须看见的因果证据，以及前后镜头的交接锚点。视觉变化来自机位、表演和状态推进，不来自随意换道具。",
      "visualEvidence必须直接点名本段至少一个不可替换的动作或名词，例如嘴巴检查、地面碎片、装袋、联系宠物医生、耐咬橡胶玩具；禁止写‘前景道具、人物反应、改变眼神、生活空间’等脱离原文也成立的占位语。相邻两项的semanticTask、propState和visualEvidence不得近义重复。",
      "保持极简：storylineBible不超过300字；semanticTask不超过30字，subject和location不超过25字，propState、visualEvidence和continuity各不超过60字。continuity固定写成‘入镜承接：具体锚点；落幅交接：具体锚点’，不能只写自然衔接。不要输出解释或逐镜提示词。",
      "只返回JSON：{\"storylineBible\":\"全片事件与道具状态主线\",\"shotDirectives\":[{\"order\":1,\"semanticTask\":\"本段唯一可见意思\",\"subject\":\"本段主体\",\"location\":\"本镜固定空间\",\"propState\":\"核心道具当前状态\",\"visualEvidence\":\"必须可见的因果证据\",\"continuity\":\"入镜承接：具体锚点；落幅交接：具体锚点\",\"visualMode\":\"narrative/hybrid-packaging/semantic-cutaway之一\",\"packagingIntent\":\"装饰决定或留空\"}]}。",
    ].join("\n"),
    `固定口播分段已覆盖完整原文：${JSON.stringify(segments)}`,
    Math.min(6400, Math.max(3200, 2200 + segments.length * 120)),
    65_000,
  );
  if (!payload) return null;
  const parsed = parseAiPayload(AiShotDirectivePlanSchema, payload, "shot directives");
  if (parsed.shotDirectives.length !== segments.length) return null;
  if (parsed.shotDirectives.some((directive, index) => directive.order !== index + 1)) return null;
  if (parsed.storyPlan.beats.length !== segments.length) return null;
  if (parsed.storyPlan.beats.some((beat, index) => beat.order !== index + 1)) return null;
  shotDirectiveCache.set(cacheKey, {
    expiresAt: Date.now() + CANVAS_PLAN_CACHE_TTL_MS,
    plan: parsed,
  });
  return parsed;
}

async function requestAiVisualBatch(
  request: Request,
  input: z.infer<typeof RequestSchema>,
  preset: CanvasPromptPreset,
  model: string,
  segments: Array<{ narration: string; durationSeconds: number }>,
  projectBible: z.infer<typeof AiProjectPlanSchema>["projectBible"],
  allSegments: Array<{ narration: string; durationSeconds: number }>,
  batchStart: number,
  timeoutMs = CANVAS_VISUAL_TIMEOUT_MS,
) {
  const rules = preset.published;
  const agentProfile = resolveCanvasAgentProfile(input.productionMode);
  const fastPacing = preset.id === "fast_marketing"
    || input.productionMode === "ten-second"
    || /(?:第[一二三四五六七八九十0-9]+(?:种|个|条|点|项|步|招|类|表现|迹象|信号)|\d+[种个条项步类]|首先|其次|最后|卖点|表现|迹象|信号|清单)/u.test(input.script);
  const pacingRule = input.productionMode === "anime-story"
    ? `故事版成片单元固定为${input.targetDurationSeconds}秒：导演必须在该时长内设计连续故事节拍；8秒使用3个实际视频镜头，10秒使用3至4个实际视频镜头，15秒使用4至6个实际视频镜头。意图多格面板只负责锁定关键视觉状态，不等于切镜点，禁止按格机械强切。`
    : fastPacing
      ? "快节奏信息型：每个分镜仍只使用一个3到5秒连续视频；节奏变化由相邻分镜的景别、机位、动作落点与硬切完成，绝不在同一口播段下新增第二个视频。"
      : "剧情叙事型：每个分镜只使用一个3到5秒连续视频，在一个时空内完成起势、核心动作、情绪落点和可剪辑收尾。";
  const performanceMode = projectBible.performanceMode;
  const batchDirectives = projectBible.shotDirectives.filter((directive) => (
    directive.order >= batchStart + 1 && directive.order <= batchStart + segments.length
  ));
  const continuityDirectives = projectBible.shotDirectives.filter((directive) => (
    directive.order >= Math.max(1, batchStart)
    && directive.order <= Math.min(allSegments.length, batchStart + segments.length + 1)
  ));
  const comedyPacing = input.productionMode === "anime-story" && performanceMode === "comedy";
  const emotionalPacing = input.productionMode === "anime-story" && performanceMode === "emotional";
  const highDynamicPacing = input.productionMode === "anime-story" && (performanceMode === "dynamic" || performanceMode === "educational");
  const performanceRule = comedyPacing
    ? "本片具有明显喜剧、吐槽或反差语气，逐镜按‘铺垫/隐藏或升级/揭示/反应/反转收口’判断当前镜头承担的唯一笑点节拍。每镜只强化一个笑点：先用0.3到0.8秒的预备动作制造期待，主动作允许动画化拉伸、顿挫、过冲或道具连锁反应，随后保留0.3到0.6秒清楚反应与落幅。笑点必须来自本段事件、人物关系或道具因果，禁止随机做鬼脸、乱加图标或每镜同一种夸张。"
    : emotionalPacing
      ? "本片以情感表达为主：动作幅度克制但不能静止，重点表现视线、呼吸、重心、触碰、犹豫和回应的连续变化；运镜稳定流畅，反应停顿服务情绪积累。禁止强套笑点、夸张形变、快速乱切或无关卡通装饰。"
      : highDynamicPacing
        ? "本片采用轻快高动态演绎：提高动作幅度、响应速度和镜头跟随效率，保持预备、主动作、反应和落幅连贯清楚；高动态不等于喜剧，不做无因果鬼脸或反转，装饰只强化速度、力量、感知或信息重点。"
        : "按全片叙事基调自然演绎：动作幅度、响应速度和镜头节奏随各段语义调整，保持连续表演和可读反应；不强套喜剧或抒情，也不退化为静态摆拍。";
  const usesFixedDurationTrim = input.allowDurationTrim && input.videoModelDurationMode !== "range";
  const videoModelTimingRule = input.productionMode === "anime-story"
    ? `目标视频模型：${input.videoModelName || "平台默认"}。按${input.targetDurationSeconds}秒成片单元统筹动作、运镜和剪辑节奏，并为每个实际视频镜头给出明确时间范围；面板数量与切镜数量解耦。`
    : usesFixedDurationTrim
      ? `目标视频模型：${input.videoModelName || "平台默认"}，原生生成时长约 ${input.videoModelDurationSeconds || "固定"} 秒。系统会在生成后自动裁到每个镜头给定的目标秒数；motionPrompt仍必须让关键动作、情绪变化和镜头落点在目标时长内完成，裁剪点之后只能自然延续，不能放置必要剧情。`
      : `目标视频模型：${input.videoModelName || "平台默认"}。按每个分镜给定的3到5秒整数目标时长直接设计动作，动作密度必须适合给定秒数。`;
  const verboseSystemPrompt = [
    input.productionMode === "anime-story"
      ? buildPresetAnimeDirectorCanvasPrompt(preset, [
          "当前阶段只输出当前批次 segments。不要输出 projectBible；不要输出 sourceIssues；不要输出 Markdown。必须服从下方当前批次 JSON 格式。",
        ])
      : "",
    agentProfile.visualRole,
    `只为当前批次的${segments.length}个固定口播段各写1个最终镜头；segments数组必须严格返回${segments.length}项，顺序、narration和durationSeconds原样保留。只返回JSON，不写解释。`,
    "JSON格式：{\"segments\":[{\"narration\":\"原样\",\"durationSeconds\":3,\"visualShots\":[{\"visualMode\":\"narrative/hybrid-packaging/semantic-cutaway之一\",\"durationSeconds\":3,\"shotRole\":\"hook/setup/action/reaction/evidence/metaphor/payoff/transition之一\",\"transition\":\"cut/dissolve/match-cut/graphic/hold之一\",\"castIds\":[\"本镜出场角色id\"],\"visualBeat\":\"10至40字的唯一可见任务\",\"visibleProposition\":\"观众必须亲眼看懂的可见命题\",\"evidenceLevel\":\"physical_action/body_state/environment_feedback/semantic_cutaway之一\",\"directorDecision\":\"为什么这样演和这样包装\",\"cameraPlan\":\"机位、景别、唯一主运镜与落幅\",\"motionPrompt\":\"内部动作计划：【入镜】...【预备】...【主动作】...【反应】...【落幅】...\",\"soundPrompt\":\"现场环境音与动作音\",\"keyframeMoment\":\"60至160字的单一静态瞬间\",\"scenePrompt\":\"40至120字的唯一场景与叙事道具\",\"imagePrompt\":\"80至420字、可直接提交图片模型的最终自然语言提示词\",\"videoPrompt\":\"50至400字、可直接提交图生视频模型的最终自然语言提示词\",\"effectsPrompt\":\"【语义重点】...【剧情表演】...【叙事道具】...【环境反馈】...【图形特效】...\",\"editPrompt\":\"成片保留区间、切点、字幕标题与声音落点\",\"qualityCriteria\":\"本镜图视频一致性和失败重生成标准\"}]}]}。",
    "visibleProposition必须能被画面直接证明；evidenceLevel按行为实物、身体状态、环境反馈、完整语义切片四级选择能讲清信息的最低级别。directorDecision只解释本镜的导演取舍，不得复制提示词；cameraPlan只保留一种主运镜，最多两个摄影机运动轴。editPrompt和qualityCriteria必须可供后期与质检节点直接执行。",
    "这是口播文案的视觉导演任务，不是续写文学剧本。每镜必须优先落实当前口播段里的具体名词、动作、风险或处理方法；全局导演表只负责约束，若其中出现‘前景道具、人物反应、改变眼神’等空泛说法，必须回到当前narration用具体对象纠正。禁止连续镜头复用人物走路、停步、回头、弯腰或看向道具的通用模板。",
    "执行顺序：先根据本段语义和全局导演表确定唯一画面任务；再写3至5秒的【入镜→预备→主动作→反应→落幅】连续动作；最后从【入镜】反推一张动作将发未发、张力最大且仍可继续运动的独立关键帧。一个镜头只含一个时空、一个核心动作和一种主要运镜。",
    "全局导演表的semanticTask、visualMode、packagingIntent是硬约束。narrative用表演、叙事道具和环境反馈讲清语义，【图形特效】写无及理由；hybrid-packaging保留完整物理场景，并把packagingIntent变成一组与主体绑定的非文字语义图形；semantic-cutaway把packagingIntent做成完整语义可视化。不得自行换模式或套用通用爱心、问号、光弧、辉点。",
    "本段若包含无法直接看见但必须传达的明确内在状态、感知、拟声、速度力量比喻或认知变化，必须落实全局导演表给出的非文字可见证据，不能只画同段中的可见动作。包装形式服从本段含义；不得为了方便改成通用符号，也不得遗漏。",
    "imagePrompt是最终生图指令，不是创作说明：直接写主体固定身份、一个姿态、可读表情、身体重心、清楚可见的剧情证据和道具、环境反馈、前中后景、唯一机位景别、构图、光线、材质和色彩。若有语义包装，必须写清绑定对象、画面位置、当前静态形态和方向，让它真实出现在画面中。禁止‘表达、体现、根据文案、选择一种、让模型决定、用于后续视频、作为视频初始形态、视频运动和消退、画入关键帧’等解释语。",
    "motionPrompt只写视频模型可执行的动作和单一运镜；【入镜】必须与imagePrompt同一姿态和空间关系。已有包装只随对应事件启动、运动和消退，不得新增参考图没有的装饰。结尾形成稳定落幅并保留少量可剪冗余。",
    "videoPrompt是最终图生视频指令，必须直接用大白话告诉模型怎么演：从参考图当前姿态开始，主体先做什么、朝哪个方向、速度和幅度如何，道具与环境怎样响应，镜头用哪一种方式跟随，最后停在哪里。它必须与imagePrompt同一首帧，只允许动画化参考图已经存在的角色、场景、道具、材质、光影、色彩和包装。禁止写上游、节点、系统生成、自动开关键、不得绕过、执行层、生成协议、根据文案或让模型选择；禁止解释工作流。",
    "videoPrompt必须是执行口令，只写参考图怎样动起来、秒级动作链、运镜、道具路径、包装生命周期、现场声和落幅；不得出现配音语义、口播、旁白、智能体思考、语义判断过程、导演分析、模型会理解等解释性文字。",
    "videoPrompt正文优先80至220个汉字，复杂镜头也不超过360字；第一句就出现可执行动词，至少写两个有先后关系的具体动词、一个可见反应、一种主要运镜和一个稳定落幅。把参考图视为已经布置完成的片场，只补充动作变化、反应、运镜、落幅和现场音，不重新描述整张静态图，不重复分镜编号、画幅、模型名称、完整角色设定、全片风格说明或大段通用负面词。像导演给演员、摄影和道具组下现场指令，不像产品说明书。",
    "imagePrompt与videoPrompt都是最终成品。后端和画布只校验并原样搬运，不会再补写或组装；因此不得把完成决定留给后续程序。",
    "角色只从结构化角色资产选择；castIds只填本镜真正可见的角色。若使用角色参考图，每个角色最多一张纯净背景、自然站姿、无剧情道具、无情绪符号、无特效的中性身份锚点，只锁身份、脸、发型或毛色花纹、体型、服装和配饰；当前imagePrompt独立决定剧情场景、表演、道具和语义包装。禁止按情绪匹配带装饰的定妆图。",
    "角色身份、服装、宠物花纹、场景布局、道具状态和屏幕方向须与全片连续；可以改变表情、姿势、景别和光影。禁止无因换装、换脸、换地点、另造无关道具或把一张图写成多个时间点。",
    performanceRule,
    pacingRule,
    videoModelTimingRule,
    "soundPrompt只写与画面逐拍同步的现场环境音、材质音、动作音和道具音；用户后期配音，人物和宠物都不说话，不做对白口型，不出现旁白、字幕朗读、背景音乐、配乐、BGM、口播、配音、对白或说话声。",
    `结构化角色资产：${JSON.stringify(projectBible.characters)}`,
    `角色锁定：${projectBible.characterBible}`,
    `环境锁定：${projectBible.environmentBible}`,
    `视觉锁定：${projectBible.visualBible}`,
    `语义包装视觉语法：${projectBible.packagingBible}`,
    `剪辑包装视觉语法：${projectBible.editorialBible}`,
    `表演锁定：${projectBible.performanceMode}｜${projectBible.performanceBible}`,
    `事件与道具状态主线：${projectBible.storylineBible || projectBible.environmentBible}`,
    `画幅与风格：${input.ratio}｜${input.style || "未指定"}`,
  ].join("\n");
  const conciseAnimeSystemPrompt = [
    buildPresetAnimeDirectorCanvasPrompt(preset),
    `当前批次有${segments.length}个固定口播段，每段只写一个镜头，narration和durationSeconds原样返回。只返回JSON。`,
    `当前自由画布故事版目标时长为${input.targetDurationSeconds}秒：8秒必须3个真实镜头，10秒必须3至4个真实镜头，15秒必须4至6个真实镜头；面板数和实际切镜数解耦。`,
    "格式：{\"segments\":[{\"narration\":\"原样\",\"durationSeconds\":3,\"castIds\":[\"character-1\"],\"visualMode\":\"narrative/hybrid-packaging/semantic-cutaway之一\",\"directorDecision\":\"【可见命题】...【角色目标】...【阻碍或异常】...【核心动作】...【可见结果】...【镜头抓手】...\",\"motionPrompt\":\"【入镜】...【预备】...【主动作】...【反应】...【落幅】...\",\"imagePrompt\":\"画面提示词\",\"videoPrompt\":\"动态运镜提示词\",\"scenePrompt\":\"场景提示词\",\"packagingPrompt\":\"【语义缺口】...【包装决策】需要/不需要【包装类型】physical-prop/body-bound/environment-feedback/local-inset/semantic-space/none之一【包装锚点】4至24字唯一名或无【绑定与位置】...【静态初态】...【动态延续】...\",\"qualityCriteria\":\"本镜必须通过和必须重生成的条件\"}]}。",
    "先完成导演决策卡，再写提示词。角色目标、阻碍或异常、核心动作和可见结果必须形成一个微剧情；不能用走路、看向、停住等通用动作糊弄。动作采用经典卡通表演节拍：预备段必须改变重心、身体压缩或蓄势轮廓；主动作必须写清方向、速度和幅度，并按剧情至少出现一次顿挫、过冲、回弹或道具连锁；反应段至少联动两处身体部位、道具或环境；落幅轮廓必须与入镜明显不同。夸张服务因果，不随机做鬼脸。",
    "本镜不是独立插画：必须直接执行下方storyPlan中同order的beat。directorDecision写清该beat如何把entryState演成resultState；imagePrompt取action即将发生的张力瞬间；videoPrompt完成action并停在resultState；handoffToNext必须落实到落幅的视线、方向、道具或空间状态。",
    "逐镜先问：物理表演、道具和环境能否让观众一眼看懂全部语义。能则包装决策写不需要；不能则只选一种载体。视觉语法分两级：先识别语义类别，再设计材质、数量、位置、绑定与运动。观众已有稳定共识的母符号必须保留：心动、恋爱、相爱使用桃心/爱心/心形；发懵、疑惑、不明白使用问号；肠道、消化、器官机理使用完整正常角色旁的安全local-inset局部教学窗。母符号之外的具体样式必须根据当前剧情重新设计；其他语义不得随机套用桃心、问号或心跳线。",
    "当narration明确出现心动、爱慕、信任、敌意、嫉妒、依恋、疏远或其他关系变化时，包装决策不得写不需要，visualMode不得为narrative；必须把关系变成绑定双方互动空间的可见证据，并完整写入包装锚点、参考图和视频。",
    "决定需要包装时，先给它一个4至24字、可逐字复用的【包装锚点】名。这个锚点必须原样出现在imagePrompt和videoPrompt中：imagePrompt画出其静态初态、绑定对象、位置、形状、材质和颜色；videoPrompt只让同一锚点随本镜动作变化。不得只写‘语义包装、环境反馈、适当特效’等概念。",
    "imagePrompt写一张独立图片中的代表性瞬间，具体、直接、80至350字。必须呈现动作前势、夸张但可信的表情和身体轮廓、不可替换的剧情证据；不得写成方法说明，也不得把多个时间点塞进一张图。",
    "motionPrompt必须完整包含【入镜】【预备】【主动作】【反应】【落幅】。videoPrompt用大白话写动作和运镜，40至220字，第一句立即开演；人物和宠物不承担口播，不出现讲话、对白、念词、嘴唇同步、反复开合口型、旁白或字幕朗读，只用表情、身体、道具、场景音和环境反应。不要重述整张图片，不提系统、节点、工作流、智能体思考或语义判断过程。",
    "qualityCriteria必须把以下任一情况写为重生成：角色出现说话口型；动作没有预备、主动作、反应或落幅；画面缺少本句独有证据；包装锚点未同时出现在参考图和视频；相邻镜头重复同一姿态、构图和动作。",
    "角色外观必须使用下方具体资产描述，不使用“同一个人、同一只狗、保持一致”等代词。相邻镜头不要重复同一姿态和构图。",
    "本镜同时出现两个已锁定实体时，castIds必须分别列出两个id，imagePrompt必须分别描述双方的固定识别点、屏幕位置、动作和反应，不能把双方缩成一个泛称主体。",
    `角色资产：${JSON.stringify(projectBible.characters)}`,
    `角色连续性：${projectBible.characterBible}`,
    `场景连续性：${projectBible.environmentBible}`,
    `统一风格：${projectBible.visualBible}`,
    `画幅与风格：${input.ratio}｜${input.style || "未指定"}`,
    `图片规则：${rules.imageRules}`,
    `视频规则：${rules.videoRules}`,
  ].join("\n");
  const systemPrompt = input.productionMode === "anime-story" ? conciseAnimeSystemPrompt : verboseSystemPrompt;
  const userPrompt = [
    `比例：${input.ratio}`,
    `风格：${input.style || "未指定"}`,
    `制作方向：${input.productionMode || "自动"}`,
    `成片节奏：${fastPacing ? "快节奏信息型" : "剧情叙事型"}`,
    `全片表演基调：${projectBible.performanceMode}｜${projectBible.performanceBible}`,
    `全片无对白故事：${JSON.stringify(projectBible.storyPlan)}`,
    `本批次故事接力：${JSON.stringify(projectBible.storyPlan.beats.slice(batchStart, batchStart + segments.length))}`,
    `取帧：${input.referenceMode === "first-last" || input.keyframeStrategy === "action-start" ? "动作首帧" : "最佳关键帧"}`,
    `包装：${input.effectsLevel === "none" ? "无" : input.effectsLevel === "rich" ? "丰富" : "轻量"}`,
    `补充：${input.assistantInstruction || "无"}`,
    `本批次逐段导演硬约束：${JSON.stringify(batchDirectives)}`,
    `相邻镜头交接上下文：${JSON.stringify(continuityDirectives)}。只用于核对上一镜落幅和下一镜入镜的角色视线、屏幕方向、动作方向、道具状态、光线或前景形状，不得输出相邻镜头。`,
    `本批次在全片中的位置：口播段${batchStart + 1}至${batchStart + segments.length}，全片共${allSegments.length}段。`,
    `全片顺序已由全局导演表锁定；当前批次只输出指定口播段，不得输出相邻镜头。`,
    `相邻口播上下文：上一段${batchStart > 0 ? `“${allSegments[batchStart - 1]?.narration || "无"}”` : "无"}；下一段${batchStart + segments.length < allSegments.length ? `“${allSegments[batchStart + segments.length]?.narration || "无"}”` : "无"}。只用于动作、视线与空间衔接，不得为相邻段输出镜头。`,
    `待规划分镜口播JSON：${JSON.stringify(segments)}`,
  ].join("\n");
  const payload = await callCanvasLlm(request, model, systemPrompt, userPrompt, 3200, timeoutMs);
  if (!payload) return null;
  const parsedSegments = input.productionMode === "anime-story"
    ? parseAiPayload(AiSimpleVisualBatchSchema, payload, "simple visual batch").segments.map((segment, index) => {
        const original = segments[index];
        const directive = batchDirectives[index];
        const packagingPrompt = segment.packagingPrompt.trim();
        const graphicDirection = extractStoryboardGraphicDirection(packagingPrompt);
        const directiveVisualMode = directive?.visualMode;
        const visualMode = directiveVisualMode && directiveVisualMode !== "narrative"
          ? directiveVisualMode
          : segment.visualMode;
        const effectsPrompt = [
          `【语义重点】${directive?.semanticTask || original?.narration || segment.narration}`,
          `【剧情表演】${segment.directorDecision}`,
          `【叙事道具】${directive?.propState || segment.scenePrompt}`,
          `【环境反馈】${directive?.visualEvidence || "道具、毛发、衣料、光影和空间对核心动作产生符合因果的可见反馈"}`,
          `【图形特效】${graphicDirection || "无；物理表演、道具与环境证据已经足够"}`,
          packagingPrompt,
        ].join("；");
        return {
          narration: original?.narration || segment.narration,
          durationSeconds: original?.durationSeconds || segment.durationSeconds,
          visualShots: [{
            visualMode,
            durationSeconds: original?.durationSeconds || segment.durationSeconds,
            shotRole: "action" as const,
            transition: "cut" as const,
            castIds: segment.castIds,
            visualBeat: directive?.semanticTask || original?.narration || segment.narration,
            visibleProposition: directive?.visualEvidence || directive?.semanticTask || original?.narration || segment.narration,
            evidenceLevel: graphicDirection
              ? visualMode === "semantic-cutaway" ? "semantic_cutaway" as const : "environment_feedback" as const
              : "physical_action" as const,
            directorDecision: segment.directorDecision,
            keyframeMoment: segment.imagePrompt,
            scenePrompt: segment.scenePrompt,
            imagePrompt: segment.imagePrompt,
            videoPrompt: segment.videoPrompt,
            effectsPrompt,
            motionPrompt: segment.motionPrompt,
            soundPrompt: "与画面动作同步的现场环境音",
            qualityCriteria: segment.qualityCriteria,
          }],
        };
      })
    : parseAiPayload(AiStoryboardPlanSchema, payload, "visual batch").segments;
  if (parsedSegments.length !== segments.length) throw new Error(`visual batch returned ${parsedSegments.length} segments; expected ${segments.length}`);
  return parsedSegments.map((segment, index) => ({
    ...segment,
    narration: segments[index].narration,
    durationSeconds: segments[index].durationSeconds,
    visualShots: segment.visualShots.map((shot) => ({
      ...shot,
      durationSeconds: segments[index].durationSeconds,
    })),
  }));
}

function extractStoryboardGraphicDirection(effectsPrompt: string) {
  const decision = effectsPrompt.match(/【包装决策】([\s\S]*?)(?=【|$)/u)?.[1]?.trim() || "";
  if (/^(?:不需要|无需|否|none)/iu.test(decision)) return "";
  const anchor = effectsPrompt.match(/【包装锚点】([\s\S]*?)(?=【|$)/u)?.[1]?.trim() || "";
  if (anchor && !/^(?:无|none|不需要)/iu.test(anchor)) return anchor;
  const graphic = effectsPrompt.match(/【(?:装饰内容|图形特效)】([\s\S]*)$/u)?.[1]?.trim() || "";
  return /^(?:无|不使用|不添加|不需要)/u.test(graphic) ? "" : graphic;
}

function extractStoryboardEffectLayer(effectsPrompt: string, label: string) {
  return effectsPrompt.match(new RegExp(`【${label}】([\\s\\S]*?)(?=【|$)`, "u"))?.[1]?.trim() || "";
}

function classifyStoryboardGraphicFamily(graphic: string) {
  if (/(?:气味|嗅觉|视线|听觉|声波|感知|雷达|轨迹)/u.test(graphic)) return "sensory";
  if (/(?:速度|旋风|冲击|爆发|力量|加速|运动线|速度线)/u.test(graphic)) return "motion";
  if (/(?:紧张|害怕|惊讶|疑惑|问号|感叹号|心跳|情绪|关系)/u.test(graphic)) return "emotion";
  if (/(?:记忆|时间|梦境|想象|回忆|意识|认知)/u.test(graphic)) return "memory";
  if (/(?:数据|统计|概率|寿命|因果|机理|神经|身体)/u.test(graphic)) return "information";
  return "generic";
}

function normalizeStoryboardGraphicCadence(plan: AiStoryboardPlan) {
  const candidates = plan.segments.map((segment, index) => {
    const shot = segment.visualShots[0];
    const graphic = extractStoryboardGraphicDirection(shot?.effectsPrompt || "");
    const semantic = `${segment.narration} ${shot?.visualBeat || ""} ${graphic}`;
    let score = 0;
    if (/(?:内心|意识|判断|感知|视线|疑惑|紧张|害怕|不敢|预感|错觉|惊讶|震惊|心机|认知|情绪|记忆|时间|关系|数据|统计|机理)/u.test(semantic)) score += 3;
    if (/(?:速度|力量|冲击|爆点|反差|转折|揭示|高潮|因果)/u.test(semantic)) score += 2;
    if (/(?:随机|装饰性|点缀|气氛光点|无关)/u.test(graphic)) score -= 4;
    return {
      order: index + 1,
      graphic,
      score,
      family: classifyStoryboardGraphicFamily(graphic),
      protectedMode: shot?.visualMode === "hybrid-packaging" || shot?.visualMode === "semantic-cutaway",
    };
  }).filter((candidate) => candidate.graphic);

  const keepOrders = new Set<number>();
  let previousNarrative: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (candidate.protectedMode) {
      keepOrders.add(candidate.order);
      previousNarrative = null;
      continue;
    }
    if (candidate.score < 0) continue;
    if (previousNarrative
      && candidate.order === previousNarrative.order + 1
      && candidate.family === previousNarrative.family) {
      if (candidate.score > previousNarrative.score) {
        keepOrders.delete(previousNarrative.order);
        keepOrders.add(candidate.order);
        previousNarrative = candidate;
      }
      continue;
    }
    keepOrders.add(candidate.order);
    previousNarrative = candidate;
  }

  return {
    ...plan,
    segments: plan.segments.map((segment, index) => ({
      ...segment,
      visualShots: segment.visualShots.map((shot) => {
        const keepGraphic = keepOrders.has(index + 1);
        return {
          ...shot,
          visualMode: keepGraphic ? shot.visualMode || "hybrid-packaging" : "narrative",
          effectsPrompt: keepGraphic
            ? shot.effectsPrompt
            : [
                shot.effectsPrompt.replace(/[；;]?【图形特效】[\s\S]*$/u, "").trim(),
                "【图形特效】无；本镜由剧情表演、叙事道具和环境反馈完成表达",
              ].join("；"),
        };
      }),
    })),
  } satisfies AiStoryboardPlan;
}

async function reviewStoryboardSemanticEffects(
  request: Request,
  input: z.infer<typeof RequestSchema>,
  plan: AiStoryboardPlan,
  model: string,
  diagnostics: CanvasCompilerDiagnostic[],
  shotDirectives: z.infer<typeof AiShotDirectiveSchema>[] = [],
) {
  if (
    input.productionMode !== "anime-story"
    || input.effectsLevel !== "rich"
  ) return plan;

  const startedAt = Date.now();
  try {
    const shots = plan.segments.map((segment, index) => ({
      order: index + 1,
      narration: segment.narration,
      visualMode: segment.visualShots[0]?.visualMode || "narrative",
      transition: segment.visualShots[0]?.transition || "cut",
      visualBeat: segment.visualShots[0]?.visualBeat || "",
      cameraPlan: segment.visualShots[0]?.cameraPlan || "",
      editPrompt: segment.visualShots[0]?.editPrompt || "",
      performance: extractStoryboardEffectLayer(segment.visualShots[0]?.effectsPrompt || "", "剧情表演").slice(0, 180),
      props: extractStoryboardEffectLayer(segment.visualShots[0]?.effectsPrompt || "", "叙事道具").slice(0, 180),
      environment: extractStoryboardEffectLayer(segment.visualShots[0]?.effectsPrompt || "", "环境反馈").slice(0, 160),
      graphicDirection: extractStoryboardGraphicDirection(segment.visualShots[0]?.effectsPrompt || ""),
      effectsPrompt: (segment.visualShots[0]?.effectsPrompt || "").slice(0, 520),
      imagePrompt: (segment.visualShots[0]?.imagePrompt || "").slice(0, 720),
      videoPrompt: (segment.visualShots[0]?.videoPrompt || "").slice(0, 520),
      directive: shotDirectives[index] || null,
    }));
    const payload = await callCanvasLlm(
      request,
      model,
      [
        "你是动漫短视频的全片终审导演，同时负责语义包装与相邻镜头连续性。逐镜先判断行为、道具和环境已经讲清了什么，再识别观众仍看不见却必须理解的语义缺口；随后逐对比较上一镜的videoPrompt落幅与下一镜imagePrompt入镜。不要查固定贴纸表，也不要机械复用问号、紧张线或器官切片。",
        "现有imagePrompt与videoPrompt都已列出。若语义证据、装饰图视频协同以及相邻镜头交接都合理，把序号放入keepOrders，不要为了变化而改写。交接必须能点名至少一个锚点：视线、动作方向、屏幕侧别、道具状态、光线、前景形状或有因果的声音桥。",
        "以下任一情况必须放入repairs：语义缺口未表达；装饰没有同时落实到图片静态初态和视频运动；当前入镜与上一镜落幅无因冲突；相邻镜头重复同一居中构图和缓慢推近；视频重新描述整张图却没有清楚动作；结尾没有可剪辑落幅。直接重写当前镜的effectsPrompt、imagePrompt、videoPrompt、cameraPlan、transition和editPrompt，不能只给建议。",
        "逐镜把narration、directive.visualEvidence与imagePrompt进行事实对账。口播里的具体动作和对象必须在参考图中看得见；例如检查嘴巴、拾取地面碎片、装袋、联系兽医、换耐咬橡胶玩具，不能被替换成女性走路、停步、回头、弯腰或泛称前景道具。任意两镜的主体姿态、道具证据和构图高度近似时，后镜必须repair成服务本段口播的独立可见事件。",
        "装饰内容可以是实体道具强化、身体外状态效果、环境反馈、局部教学放大窗或完整语义演示空间。先写语义缺口，再只选最清楚、最有故事性、最能和前后镜衔接的一种；没有语义缺口的narrative镜头无需repair。若核心信息依赖心理、感知、关系、危险机理或认知变化，不得仅以表演足够为由删除全部包装。hybrid-packaging通常占画面12%到22%，禁止极淡、微光、若隐若现；非身体类semantic-cutaway可占画面45%到100%。",
        "每个需要包装的镜头必须给装饰一个4至24字的唯一【包装锚点】名，并在effectsPrompt、imagePrompt和videoPrompt中逐字复用。effectsPrompt固定写成【语义重点】...【剧情表演】...【叙事道具】...【环境反馈】...【图形特效】锚点名【语义缺口】...【包装决策】需要【包装类型】...【包装锚点】...【绑定与位置】...【静态初态】...【动态延续】...；不需要时明确写【包装决策】不需要【包装类型】none【包装锚点】无。",
        "人物和宠物只用表情、身体、道具和环境反应演绎，不承担口播。任何讲话、对白、念词、嘴唇同步或反复开合口型都必须返修。动作必须有预备蓄势、主动作的拉伸/过冲/顿挫或道具连锁反馈之一、第二反应和稳定收势；夸张必须服务本段因果。",
        "身体机理镜头必须改成完整正常主体旁20%到30%的局部圆角放大窗，只用短小三角指针标记身体位置，窗口与主体分离。窗口必须像平视的冷色机械教学剖面：蓝灰纯色底、上下两个浅紫或蓝色几何挡块形成短直通道、离散白色圆形棉球堆在入口、哑光黏土或软塑料材质，只展示本段唯一关系。禁止纵深隧道、腔体内部透视、弯曲通道、分叉管线和有机曲线；白色材料必须是一颗颗棉球或短绒团，禁止虫状、面条状、绳状、管状或盘绕形态。禁止粉红、肉色、红色有机配色、皮肤褶皱、肉壁、血管、内窥镜视角、真实腔体和写实生理结构，禁止管线、绳子或器官从嘴巴、腹部或身体伸入窗口。videoPrompt必须让窗口持续到稳定落幅，窗口边界、几何挡块、短直通道和指针位置全程固定完整，只允许离散棉球挤压、堆积、减速或缓慢平移，禁止拉开、断裂、解体、翻转、增殖、器官变形或提前淡出。禁止全屏或占据主体画面的消化通道、器官空间、口腔/食道/肠道隧道，也禁止整身透明、全身X光、开腔剖面、完整器官系统、真实器官、湿润组织、体液、伤口、血腥、肉壁隧道和医学摄影质感。",
        "repair中的imagePrompt必须是单一静态首帧，包含具体角色文字资产、剧情证据及已经清楚可见的装饰，并以全片同一visualBible固定风格后缀收尾；videoPrompt把参考图当作已经布置好的片场，第一句出现动作，只补动作变化、反应、既有装饰运动、唯一主运镜、落幅和现场音，不重述整张图、不新增图片里没有的效果。禁止字幕、对白框、水印和无关可读文字。",
        "修复当前镜时必须保留上一阶段已经成立的角色、剧情、关键道具和正当语义包装，只调整构图、入镜状态、动作落幅或交接方式。narrative镜头允许因连续性问题被修复，graphicDirection可为空。",
        "只返回JSON：{\"keepOrders\":[镜头序号],\"repairs\":[{\"order\":镜头序号,\"visualMode\":\"narrative/hybrid-packaging/semantic-cutaway之一\",\"reason\":\"本镜为何需要修复\",\"transition\":\"cut/dissolve/match-cut/graphic/hold之一\",\"cameraPlan\":\"唯一机位运镜和落幅\",\"editPrompt\":\"切点与相邻镜头交接\",\"graphicDirection\":\"包装锚点；narrative可为空\",\"effectsPrompt\":\"含语义缺口、包装决策、包装类型、包装锚点、绑定位置、静态初态、动态延续的完整导演决定\",\"imagePrompt\":\"可直接生图且逐字包含包装锚点的最终提示词\",\"videoPrompt\":\"可直接图生视频且逐字包含包装锚点的最终提示词\"}]}。",
      ].join("\n"),
      `全片角色资产：${JSON.stringify(plan.projectBible?.characters || [])}\n全片表演基调：${plan.projectBible?.performanceMode || "natural"}\n逐镜语义、物理证据、最终提示词摘要与交接：${JSON.stringify(shots)}`,
      5200,
      CANVAS_EFFECTS_REVIEW_TIMEOUT_MS,
    );
    if (!payload) return plan;
    const reviewed = parseAiPayload(AiSemanticEffectsReviewSchema, payload, "semantic effects review");
    const repairs = reviewed.repairs;
    const repairByOrder = new Map(repairs.map((repair) => [repair.order, repair]));
    const protectedOrders = new Set(plan.segments.flatMap((segment, index) => {
      const shot = segment.visualShots[0];
      const protectedMode = shot?.visualMode === "hybrid-packaging" || shot?.visualMode === "semantic-cutaway";
      return protectedMode && extractStoryboardGraphicDirection(shot.effectsPrompt) ? [index + 1] : [];
    }));
    const keepOrders = new Set(reviewed.keepOrders.filter((order) => (
      order <= plan.segments.length
      && Boolean(extractStoryboardGraphicDirection(plan.segments[order - 1]?.visualShots[0]?.effectsPrompt || ""))
    )));
    const selectedOrders = new Set([...protectedOrders, ...keepOrders, ...repairByOrder.keys()]);
    if (selectedOrders.size === 0) {
      diagnostics.push({
        model: model || "platform-default",
        stage: "semantic-effects-review",
        status: "rejected",
        durationMs: Date.now() - startedAt,
        detail: "Full-film review selected no justified graphic reinforcement",
      });
      return plan;
    }
    const initialGraphicCount = plan.segments.filter((segment) => (
      Boolean(extractStoryboardGraphicDirection(segment.visualShots[0]?.effectsPrompt || ""))
    )).length;
    const reviewedPlan: AiStoryboardPlan = {
      ...plan,
      segments: plan.segments.map((segment, index) => {
        const order = index + 1;
        const repair = repairByOrder.get(index + 1);
        return {
          ...segment,
          visualShots: segment.visualShots.map((shot) => {
            const keepGraphic = selectedOrders.has(order);
            if (repair) {
              return {
                ...shot,
                visualMode: repair.visualMode,
                transition: repair.transition,
                cameraPlan: repair.cameraPlan,
                editPrompt: repair.editPrompt,
                effectsPrompt: repair.effectsPrompt,
                imagePrompt: repair.imagePrompt,
                videoPrompt: repair.videoPrompt,
              };
            }
            return {
              ...shot,
              visualMode: keepGraphic ? shot.visualMode || "hybrid-packaging" : shot.visualMode,
            };
          }),
        };
      }),
    };
    const normalizedGraphicCount = reviewedPlan.segments.filter((segment) => (
      Boolean(extractStoryboardGraphicDirection(segment.visualShots[0]?.effectsPrompt || ""))
    )).length;
    diagnostics.push({
      model: model || "platform-default",
      stage: "semantic-effects-review",
      status: "accepted",
      durationMs: Date.now() - startedAt,
      detail: `Full-film review protected ${protectedOrders.size} semantic packaging decisions, selected ${selectedOrders.size} of ${initialGraphicCount} directions, and kept ${normalizedGraphicCount}; ${repairs.length} final image/video prompt pairs were rewritten for semantic evidence or adjacent-shot continuity`,
    });
    return reviewedPlan;
  } catch (error) {
    diagnostics.push({
      model: model || "platform-default",
      stage: "semantic-effects-review",
      status: "failed",
      durationMs: Date.now() - startedAt,
      detail: formatCompilerError(error).slice(0, 900),
    });
    return plan;
  }
}

async function repairRejectedFinalPrompts(
  request: Request,
  input: z.infer<typeof RequestSchema>,
  plan: AiStoryboardPlan,
  model: string,
  diagnostics: CanvasCompilerDiagnostic[],
  shotDirectives: z.infer<typeof AiShotDirectiveSchema>[] = [],
) {
  const requireMotionChain = (input.productionMode || "anime-story") === "anime-story";
  const issues = auditAiStoryboardPlanUsability(input.script, plan, {
    requireMotionChain,
    requireFinalPrompts: true,
    targetDurationSeconds: input.targetDurationSeconds,
  });
  const projectHasAnimal = (plan.projectBible?.characters || []).some((character) => character.kind === "animal");
  const providerSafetyIssues = (input.productionMode || "anime-story") === "anime-story" && projectHasAnimal
    ? plan.segments.flatMap((segment, segmentIndex) => segment.visualShots.flatMap((shot, shotIndex) => {
        const shotPrefix = `口播段${segmentIndex + 1}镜头${shotIndex + 1}`;
        const imagePrompt = shot.imagePrompt || "";
        const videoPrompt = shot.videoPrompt || "";
        const shotHasPerson = shot.castIds.some((id) => plan.projectBible?.characters
          .some((character) => character.id === id && character.kind === "person"));
        const promptHasVisiblePerson = /(?:中国|亚洲|女性|男性|主人|女士|苏晴|马尾|T恤|牛仔裤|手臂|前臂)/u.test(imagePrompt);
        const faceIsExplicitlyOut = /(?:头部和面部|头脸).{0,12}(?:画框外|不入镜)|不出现(?:正脸|侧脸|可识别五官)/u.test(imagePrompt);
        const graphicTouchesBody = /(?:线|波纹|光轨|弧线|脉冲).{0,18}(?:缠绕|捆绑|贴合|贴附|穿过|沿着).{0,18}(?:身体|躯干|四肢|后腿|尾巴|毛发)|(?:缠绕|捆绑|贴合|贴附|穿过).{0,18}(?:身体|躯干|四肢|后腿|尾巴|毛发)/u.test(`${imagePrompt} ${videoPrompt}`);
        const dangerPathToMouth = /(?:棉球|棉花|食物|药物|碎屑).{0,30}(?:向|朝|通往|排列|移动).{0,18}(?:口鼻|嘴|口腔|身体)|(?:口鼻|嘴|口腔).{0,18}(?:路径|排列|移动|飞入)/u.test(`${imagePrompt} ${videoPrompt}`)
          && !/(?:不接触|不飞向|不得飞向|始终静止).{0,12}(?:口鼻|嘴)/u.test(`${imagePrompt} ${videoPrompt}`);
        return [
          ...(shotHasPerson && promptHasVisiblePerson && !faceIsExplicitlyOut
            ? [`${shotPrefix}最终图片提示词：宠物科普非核心人物面部未明确完全出框，可能触发视频模型肖像拒绝`]
            : []),
          ...(graphicTouchesBody
            ? [`${shotPrefix}最终图片提示词：语义装饰线接触或缠绕角色身体，必须移到轮廓外留白区`]
            : []),
          ...(dangerPathToMouth
            ? [`${shotPrefix}最终图片提示词：危险物向动物口鼻或身体形成现实路径，必须改为地面静止证据并只在教学窗内部运动`]
            : []),
        ];
      }))
    : [];
  const repairableIssues = [...issues, ...providerSafetyIssues]
    .filter((issue) => /最终(?:图片|视频)提示词/u.test(issue));
  const repairOrders = [...new Set(repairableIssues.flatMap((issue) => {
    const order = Number(issue.match(/口播段(\d+)/u)?.[1]);
    return Number.isInteger(order) && order >= 1 && order <= plan.segments.length ? [order] : [];
  }))].slice(0, 6);
  if (repairOrders.length === 0) return plan;

  const startedAt = Date.now();
  try {
    const repairContext = repairOrders.map((order) => {
      const previous = plan.segments[order - 2];
      const current = plan.segments[order - 1];
      const next = plan.segments[order];
      const shot = current?.visualShots[0];
      return {
        order,
        issues: repairableIssues.filter((issue) => issue.includes(`口播段${order}`)),
        previous: previous ? {
          narration: previous.narration,
          videoPrompt: previous.visualShots[0]?.videoPrompt || "",
        } : null,
        current: current ? {
          narration: current.narration,
          directive: shotDirectives[order - 1] || null,
          visualBeat: shot?.visualBeat || "",
          effectsPrompt: shot?.effectsPrompt || "",
          imagePrompt: shot?.imagePrompt || "",
          videoPrompt: shot?.videoPrompt || "",
        } : null,
        next: next ? {
          narration: next.narration,
          imagePrompt: next.visualShots[0]?.imagePrompt || "",
        } : null,
      };
    });
    const payload = await callCanvasLlm(
      request,
      model,
      [
        "你是动漫短视频的定点返修导演。只返修列出的不合格镜头，不改剧情、不换角色、不换场景、不删除已经成立的语义包装。每个镜头必须成对返回最终生图提示词和最终图生视频提示词，供画布原样加载。",
        "先按current.narration和current.directive做语义事实对账：参考图必须明确画出本段独有的动作、对象、道具状态或知识证据。禁止用人物走路、停步、回头、弯腰、看向前景道具等通用模板代替具体口播事实；若问题指出与其他镜头重复，必须更换本镜主体动作、证据道具和构图，使其成为独立事件。",
        "imagePrompt只描述一个可直接生成的静态关键帧：写明具体角色资产、单一姿态、表情和身体重心、剧情道具及状态、环境反馈、前中后景、唯一机位景别、光线、材质和色彩。若effectsPrompt已有语义装饰，必须保留其静态初始形态、绑定对象、位置和方向。不得写创作说明、步骤或动态时间线。",
        "videoPrompt把参考图当作已经布置好的首帧，第一句立即下动作指令；只写主体先做什么、再做什么，道具和环境怎样同步反应，镜头只采用一种主要运镜，最后明确写主体停在哪里、道具停在哪里、镜头停止运动并稳定停留至少一秒。最后一镜尤其必须有可剪辑的稳定落幅。不得复述角色设定、场景清单、系统流程或模型参数。",
        "平台安全返修是硬门禁：宠物科普里人的脸若不是唯一核心反应，只保留固定服装对应的手、前臂、肩背或背影，并在imagePrompt明确写‘头部和面部完全在画框外，不出现正脸、侧脸或可识别五官’。情绪线、声波、速度线和脉冲线只能位于身体轮廓外留白区，与毛发和四肢保持间隔，不得贴附、穿过、缠绕或捆绑身体。危险物、棉球、食物或药物不得从现实道具向动物口鼻或身体排列成路径；没有真实吞食时，现实证据保持落地静止，因果运动只发生在局部教学窗内部。",
        "只返回JSON：{\"repairs\":[{\"order\":镜头序号,\"reason\":\"修复了什么\",\"imagePrompt\":\"最终生图提示词\",\"videoPrompt\":\"最终图生视频提示词\"}]}。不得返回未列出的镜头。",
      ].join("\n"),
      `全片角色资产：${JSON.stringify(plan.projectBible?.characters || [])}\n需要定点返修的镜头：${JSON.stringify(repairContext)}`,
      4200,
      CANVAS_RECOVERY_TIMEOUT_MS,
    );
    if (!payload) return plan;
    const parsed = parseAiPayload(AiFinalPromptRepairSchema, payload, "final prompt repair");
    const requestedOrders = new Set(repairOrders);
    const repairByOrder = new Map(parsed.repairs
      .filter((repair) => requestedOrders.has(repair.order))
      .map((repair) => [repair.order, repair]));
    if (repairByOrder.size === 0) return plan;

    const repairedPlan: AiStoryboardPlan = {
      ...plan,
      segments: plan.segments.map((segment, index) => {
        const repair = repairByOrder.get(index + 1);
        if (!repair) return segment;
        return {
          ...segment,
          visualShots: segment.visualShots.map((shot) => ({
            ...shot,
            imagePrompt: repair.imagePrompt,
            videoPrompt: repair.videoPrompt,
          })),
        };
      }),
    };
    const remainingIssues = auditAiStoryboardPlanUsability(input.script, repairedPlan, {
      requireMotionChain,
      requireFinalPrompts: true,
      targetDurationSeconds: input.targetDurationSeconds,
    });
    diagnostics.push({
      model: model || "platform-default",
      stage: "selective-final-prompt-repair",
      status: remainingIssues.length < issues.length ? "accepted" : "rejected",
      durationMs: Date.now() - startedAt,
      detail: `Repaired ${repairByOrder.size} rejected prompt pair(s); validation issues ${issues.length} -> ${remainingIssues.length}`,
    });
    return repairedPlan;
  } catch (error) {
    diagnostics.push({
      model: model || "platform-default",
      stage: "selective-final-prompt-repair",
      status: "failed",
      durationMs: Date.now() - startedAt,
      detail: formatCompilerError(error).slice(0, 900),
    });
    return plan;
  }
}

async function requestAiStoryboardPlan(
  request: Request,
  input: z.infer<typeof RequestSchema>,
  preset: CanvasPromptPreset,
  models: string[],
  diagnostics: CanvasCompilerDiagnostic[],
) {
  const semanticSegments = normalizeStoryboardSegments(input.script);
  let narrationPlan: Awaited<ReturnType<typeof requestAiSegments>> = null;
  const availableSegmentationModels = models.length > 0 ? models.slice(0, 2) : ["gpt-5.4"];
  const segmentationModels = [...new Set([
    ...availableSegmentationModels.filter((model) => /gpt-5\.6/i.test(model)),
    ...availableSegmentationModels,
  ])];
  for (const model of segmentationModels) {
    const startedAt = Date.now();
    try {
      const result = await requestAiSegments(request, input, preset, model);
      if (result?.segments.length) {
        narrationPlan = result;
        diagnostics.push({
          model: model || "platform-default",
          stage: "project-bible",
          status: "accepted",
          durationMs: Date.now() - startedAt,
        });
        break;
      }
      diagnostics.push({
        model: model || "platform-default",
        stage: "project-bible",
        status: "rejected",
        durationMs: Date.now() - startedAt,
        detail: "Model returned no usable narration segments",
      });
    } catch (error) {
      diagnostics.push({
        model: model || "platform-default",
        stage: "project-bible",
        status: "failed",
        durationMs: Date.now() - startedAt,
        detail: formatCompilerError(error).slice(0, 900),
      });
    }
  }
  if (!narrationPlan?.segments.length) return null;
  const livingCharacters = narrationPlan.projectBible.characters.filter((character) => (
    character.kind === "person" || character.kind === "animal"
  ));
  if ((input.productionMode || "anime-story") === "anime-story") {
    if (livingCharacters.length === 0) {
      diagnostics.push({
        model: "asset-classification-gate",
        stage: "project-bible",
        status: "rejected",
        durationMs: 0,
        detail: "Anime project bible contains no performing person or animal; props cannot substitute for cast assets",
      });
      return null;
    }
    if (livingCharacters.length !== narrationPlan.projectBible.characters.length) {
      diagnostics.push({
        model: "asset-classification-gate",
        stage: "project-bible",
        status: "accepted",
        durationMs: 0,
        detail: `Moved ${narrationPlan.projectBible.characters.length - livingCharacters.length} non-performing object assets back to the prop layer`,
      });
      narrationPlan = {
        ...narrationPlan,
        projectBible: { ...narrationPlan.projectBible, characters: livingCharacters },
      };
    }
  }
  let directedProjectBible = narrationPlan.projectBible;
  let globalDirectivesComplete = directedProjectBible.shotDirectives.length === narrationPlan.segments.length
    && directedProjectBible.shotDirectives.every((directive, index) => directive.order === index + 1)
    && directedProjectBible.storyPlan.beats.length === narrationPlan.segments.length
    && directedProjectBible.storyPlan.beats.every((beat, index) => beat.order === index + 1);

  if (!globalDirectivesComplete) {
    for (const model of segmentationModels) {
      const startedAt = Date.now();
      try {
        const directivePlan = await requestAiShotDirectives(request, input, preset, narrationPlan.segments, model);
        if (!directivePlan) continue;
        directedProjectBible = {
          ...directedProjectBible,
          storyPlan: directivePlan.storyPlan,
          storylineBible: directivePlan.storylineBible || directedProjectBible.storylineBible,
          shotDirectives: directivePlan.shotDirectives,
        };
        globalDirectivesComplete = true;
        diagnostics.push({
          model: model || "platform-default",
          stage: "global-shot-plan-recovery",
          status: "accepted",
          durationMs: Date.now() - startedAt,
          detail: `Recovered ${directivePlan.shotDirectives.length} shot directives without discarding the accepted project bible`,
        });
        break;
      } catch (error) {
        diagnostics.push({
          model: model || "platform-default",
          stage: "global-shot-plan-recovery",
          status: "failed",
          durationMs: Date.now() - startedAt,
          detail: formatCompilerError(error).slice(0, 900),
        });
      }
    }
  }
  if (!globalDirectivesComplete) return null;

  diagnostics.push({
    model: "single-pass-project-plan",
    stage: "global-shot-plan",
    status: "accepted",
    durationMs: 0,
    detail: `Global analysis fixed ${narrationPlan.segments.length} shot directives before prompt generation`,
  });
  const visualModels = [...new Set([
    ...models.filter((model) => /gpt-5\.6/i.test(model)),
    ...models,
    "gpt-5.4",
  ])];
  const primaryVisualModels = visualModels.slice(0, 1);
  // A failed batch deserves one strict per-shot retry on the best model too.
  // Falling straight to a weaker model was producing structurally valid but generic cards.
  const recoveryVisualModels = visualModels;
  const batches: Array<{ start: number; segments: typeof narrationPlan.segments }> = [];
  for (let index = 0; index < narrationPlan.segments.length; index += VISUAL_BATCH_SIZE) {
    batches.push({ start: index, segments: narrationPlan.segments.slice(index, index + VISUAL_BATCH_SIZE) });
  }

  const attemptVisualBatch = async (
    batch: { start: number; segments: typeof narrationPlan.segments },
    stagePrefix: string,
    candidateModels: string[],
    timeoutMs: number,
  ) => {
    for (const [modelIndex, model] of candidateModels.entries()) {
      for (let attempt = 1; attempt <= VISUAL_MODEL_ATTEMPTS; attempt += 1) {
        if (attempt > 1) await waitFor(2_500 * attempt);
        const startedAt = Date.now();
        const stage = `${stagePrefix}${modelIndex > 0 ? "-model-fallback" : ""}${attempt > 1 ? `-retry-${attempt}` : ""}`;
        try {
          const result = await requestAiVisualBatch(
            request,
            input,
            preset,
            model,
            batch.segments,
            directedProjectBible,
            narrationPlan.segments,
            batch.start,
            timeoutMs,
          );
          if (result?.length) {
            const batchProjectBible = {
              ...directedProjectBible,
              storyPlan: {
                ...directedProjectBible.storyPlan,
                beats: directedProjectBible.storyPlan.beats.slice(batch.start, batch.start + batch.segments.length)
                  .map((beat, index) => ({ ...beat, order: index + 1 })),
              },
            };
            const normalizedResult = repairAiStoryboardPlanStaticPrompts(AiStoryboardPlanSchema.parse({
              promptContractVersion: "anime-director-v1",
              projectBible: batchProjectBible,
              sourceIssues: narrationPlan.sourceIssues,
              segments: result,
            })).plan.segments;
            const promptIssues = auditAiStoryboardPlanUsability(
              batch.segments.map((segment) => segment.narration).join(""),
              AiStoryboardPlanSchema.parse({
                promptContractVersion: "anime-director-v1",
                projectBible: batchProjectBible,
                sourceIssues: [],
                segments: normalizedResult,
              }),
              { requireMotionChain: true, requireFinalPrompts: true, targetDurationSeconds: input.targetDurationSeconds },
            );
            if (promptIssues.length > 0) {
              diagnostics.push({
                model: model || "platform-default",
                stage,
                status: "rejected",
                durationMs: Date.now() - startedAt,
                detail: promptIssues.slice(0, 4).join("；").slice(0, 900),
              });
              continue;
            }
            diagnostics.push({
              model: model || "platform-default",
              stage,
              status: "accepted",
              durationMs: Date.now() - startedAt,
            });
            return normalizedResult;
          }
          diagnostics.push({
            model: model || "platform-default",
            stage,
            status: "rejected",
            durationMs: Date.now() - startedAt,
            detail: "Model returned no usable visual shots",
          });
        } catch (error) {
          diagnostics.push({
            model: model || "platform-default",
            stage,
            status: "failed",
            durationMs: Date.now() - startedAt,
            detail: formatCompilerError(error).slice(0, 900),
          });
          if (!isTransientCanvasModelError(error)) break;
        }
      }
    }
    return null;
  };

  const plannedBatches = await mapWithConcurrency(
    batches,
    VISUAL_BATCH_CONCURRENCY,
    async (batch, batchIndex) => {
      await waitFor((batchIndex % VISUAL_BATCH_CONCURRENCY) * 1_200);
      return attemptVisualBatch(
        batch,
        `visual-batch-${batchIndex + 1}`,
        primaryVisualModels,
        CANVAS_VISUAL_TIMEOUT_MS,
      );
    },
  );
  const recoveredBatches = [...plannedBatches];
  const failedBatchIndexes = plannedBatches
    .map((batch, index) => batch ? -1 : index)
    .filter((index) => index >= 0);
  const recoveredFailures = await mapWithConcurrency(
    failedBatchIndexes,
    VISUAL_RECOVERY_BATCH_CONCURRENCY,
    async (batchIndex) => {
      const batch = batches[batchIndex];
      const recoveredSegments = await mapWithConcurrency(
        batch.segments,
        VISUAL_RECOVERY_CONCURRENCY,
        async (segment, segmentIndex) => {
          const recovered = await attemptVisualBatch(
            { start: batch.start + segmentIndex, segments: [segment] },
            `visual-batch-${batchIndex + 1}-recovery-${segmentIndex + 1}`,
            recoveryVisualModels,
            CANVAS_RECOVERY_TIMEOUT_MS,
          );
          if (recovered?.[0]) return recovered[0];
          diagnostics.push({
            model: "strict-quality-gate",
            stage: `visual-batch-${batchIndex + 1}-recovery-${segmentIndex + 1}`,
            status: "rejected",
            durationMs: 0,
            detail: "This narration segment has no validated director card; old generic fallback was intentionally blocked",
          });
          return null;
        },
      );
      if (recoveredSegments.some((segment) => !segment)) return { batchIndex, recoveredSegments: null };
      return { batchIndex, recoveredSegments: recoveredSegments as AiStoryboardPlan["segments"] };
    },
  );
  recoveredFailures.forEach(({ batchIndex, recoveredSegments }) => {
    recoveredBatches[batchIndex] = recoveredSegments;
  });

  if (recoveredBatches.some((batch) => !batch)) return null;

  const plannedSegments: AiStoryboardPlan["segments"] = [];
  recoveredBatches.forEach((batch) => plannedSegments.push(...(batch || [])));
  const assembledPlan = AiStoryboardPlanSchema.parse({
    promptContractVersion: "anime-director-v1",
    projectBible: directedProjectBible,
    sourceIssues: narrationPlan.sourceIssues,
    segments: plannedSegments,
  });
  diagnostics.push({
    model: "direct-card-mapper",
    stage: "prompt-finalization",
    status: "accepted",
    durationMs: 0,
    detail: "The concise director output was mapped directly to canvas cards without a second AI rewrite",
  });
  return AiStoryboardPlanSchema.parse(sanitizeFinalSoundPrompts(assembledPlan));
}

export async function POST(request: Request) {
  try {
    const input = RequestSchema.parse(await request.json());
    const store = await loadCanvasPromptPresetStore(getSupabaseAdminClient());
    const preset = store.presets.find((item) => item.id === input.presetId && item.enabled);
    if (!preset) return NextResponse.json({ error: "所选提示词方案不可用" }, { status: 404 });

    const token = getTokenFromHeaders(request.headers);
    const authPayload = token ? await verifyToken(token) : null;
    const authorized = Boolean(authPayload?.userId);
    const llmRequest = authorized && token
      ? new Request(request.url, {
        headers: new Headers({ ...Object.fromEntries(request.headers), Authorization: `Bearer ${token}` }),
        signal: request.signal,
      })
      : request;

    let plan: AiStoryboardPlan | undefined;
    let compiler: "ai" | "deterministic-fallback" = "deterministic-fallback";
    const compilerDiagnostics: CanvasCompilerDiagnostic[] = [];
    const models = [...new Set([preset.primaryModel, preset.fallbackModel].filter(Boolean))];
    const cacheKey = buildCanvasPlanCacheKey(input, preset, authPayload?.userId || "anonymous");
    const cachedPlan = canvasPlanCache.get(cacheKey);
    if (authorized && cachedPlan && cachedPlan.expiresAt > Date.now()) {
      plan = cachedPlan.plan;
      compiler = "ai";
      compilerDiagnostics.push({
        model: "memory-cache",
        stage: "cache-hit",
        status: "accepted",
        durationMs: 0,
      });
    } else if (authorized) {
      if (cachedPlan) canvasPlanCache.delete(cacheKey);
      const attempts = models.length > 0 ? models : [""];
      const attemptStartedMs = Date.now();
      try {
        const result = await requestAiStoryboardPlan(llmRequest, input, preset, attempts, compilerDiagnostics);
        const requireMotionChain = (input.productionMode || "anime-story") === "anime-story";
        if (result && isAiStoryboardPlanUsable(input.script, result, {
          requireMotionChain,
          requireFinalPrompts: true,
          targetDurationSeconds: input.targetDurationSeconds,
        })) {
          plan = result;
          const hasLocalVisualFallback = compilerDiagnostics.some((diagnostic) => (
            diagnostic.stage.includes("-local-")
          ));
          compiler = hasLocalVisualFallback ? "deterministic-fallback" : "ai";
          if (!hasLocalVisualFallback) {
            canvasPlanCache.set(cacheKey, {
              expiresAt: Date.now() + CANVAS_PLAN_CACHE_TTL_MS,
              plan: result,
            });
          }
          compilerDiagnostics.push({
            model: "mixed-stage",
            stage: "final-validation",
            status: hasLocalVisualFallback ? "rejected" : "accepted",
            durationMs: Date.now() - attemptStartedMs,
            detail: hasLocalVisualFallback
              ? "One or more narration segments used a local visual fallback; paid media generation is blocked until AI replanning succeeds"
              : undefined,
          });
        } else {
          const issues = result
              ? auditAiStoryboardPlanUsability(input.script, result, {
                requireMotionChain,
                requireFinalPrompts: true,
                targetDurationSeconds: input.targetDurationSeconds,
              })
            : ["模型没有返回可解析的分镜方案"];
          compilerDiagnostics.push({
            model: "mixed-stage",
            stage: "final-validation",
            status: "rejected",
            durationMs: Date.now() - attemptStartedMs,
            detail: issues.slice(0, 6).join("；").slice(0, 900),
          });
          console.warn("[canvas-prompts] compiler diagnostics:", compilerDiagnostics.slice(-10));
          console.warn("[canvas-prompts] AI plan rejected by structural validation:", issues.slice(0, 6));
        }
      } catch (error) {
        compilerDiagnostics.push({
          model: "mixed-stage",
          stage: "final-validation",
          status: "failed",
          durationMs: Date.now() - attemptStartedMs,
          detail: formatCompilerError(error).slice(0, 900),
        });
        console.warn("[canvas-prompts] AI compiler failed:", error);
      }
    }

    if (authorized && (input.productionMode || "anime-story") === "anime-story" && !plan) {
      return NextResponse.json({
        error: "本次导演拆解没有通过语义包装与动作表演质检，请重试；系统未写入旧版占位镜头。",
        compiler: "deterministic-fallback",
        compilerRevision: CANVAS_COMPILER_REVISION,
        compilerDiagnostics,
      }, { status: 422 });
    }

    const compiled = compileStoryboard({ ...input, preset, plan });
    const compilerQualityNotes = compiler === "deterministic-fallback"
      ? compilerDiagnostics.filter((diagnostic) => diagnostic.status !== "accepted").map((diagnostic) => (
          `AI编排诊断：${diagnostic.stage} / ${diagnostic.model} ${diagnostic.status === "failed" ? "调用失败" : "未通过质检"}（${(diagnostic.durationMs / 1000).toFixed(1)}秒）${diagnostic.detail ? `：${diagnostic.detail}` : ""}`
        ))
      : [];
    return NextResponse.json({
      ...compiled,
      qualityNotes: [...(compiled.qualityNotes || []), ...compilerQualityNotes],
      compiler,
      compilerRevision: CANVAS_COMPILER_REVISION,
      compilerDiagnostics,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "创作信息不完整", details: error.issues }, { status: 400 });
    }
    console.error("[canvas-prompts] Compile failed:", error);
    return NextResponse.json({ error: "分镜编排失败，请稍后重试" }, { status: 500 });
  }
}
