import { z } from "zod";
import { parsePromptBatch } from "@/lib/prompt-parser";
import { GenerationRouteSchema, ReferenceStrategySchema, type GenerationRoute, type ReferenceStrategy } from "@/lib/studio-schema";

export const BrainSceneSchema = z.object({
  narration: z.string().min(1),
  imagePrompt: z.string().min(1),
  startFramePrompt: z.string().default(""),
  endFramePrompt: z.string().default(""),
  keyframePrompt: z.string().default(""),
  refinementPrompt: z.string().default(""),
  videoPrompt: z.string().min(1),
  durationSeconds: z.number().positive().max(20).optional(),
});

export const BrainPlanSchema = z.object({
  title: z.string().default("客服视频"),
  route: GenerationRouteSchema,
  referenceStrategy: ReferenceStrategySchema.default("single"),
  charsPerSecond: z.number().positive().default(6),
  summary: z.string().default(""),
  assetLock: z.string().default(""),
  scenes: z.array(BrainSceneSchema).min(1),
});

export const BrainAgentResponseSchema = z.object({
  reply: z.string().min(1),
  intent: z.enum(["preview", "revise", "apply", "clarify", "chat"]).default("chat"),
  suggestions: z.array(z.string().min(1)).max(4).default([]),
  plan: BrainPlanSchema.nullable().default(null),
});

export type BrainScene = z.infer<typeof BrainSceneSchema>;
export type BrainPlan = z.infer<typeof BrainPlanSchema>;
export type BrainAgentResponse = z.infer<typeof BrainAgentResponseSchema>;
export type AgentInputKind = "chat" | "clarify" | "storyboard_script" | "prompt_batch" | "revision";

const SPOKEN_CHAR_PATTERN = /[\p{L}\p{N}]/u;
const CASUAL_CHAT_PATTERN = /^(你好|您好|hi|hello|在吗|你在吗|测试|你是谁|你能做什么|能聊聊吗)[。！？!?，,\s]*$/i;
const STORYBOARD_REQUEST_PATTERN = /口播|文案|脚本|分镜|镜头|拆镜|拆分/;
const EXPLICIT_PROMPT_IMPORT_PATTERN = /提示词导入|导入画布|批量生图|批量出图/;
const PROMPT_BATCH_REQUEST_PATTERN = /图片提示词|生图提示词|视频提示词/;
const STORYBOARD_REVISION_PATTERN = /修改|调整|重写|优化|替换|增加|删除|第\s*\d+|分镜|镜头|首帧|尾帧|提示词/;
const SEGMENTED_LINE_PATTERN = /^\s*(?:(?:第?\s*[一二三四五六七八九十百千万\d]+\s*[段镜条]|[一二三四五六七八九十百千万\d]+)\s*[.．、:：)）\-—]?\s*|[-*•]\s+)(.+?)\s*$/u;
const SEGMENT_WRAPPER_PATTERN = /^(?:[【\[\(（「『“"])([\s\S]+?)(?:[】\]\)）」』”"])$/u;

type StoryboardDurationSeconds = 8 | 10 | 15;

export function countSpokenCharacters(text: string): number {
  return Array.from(text).filter((char) => SPOKEN_CHAR_PATTERN.test(char)).length;
}

export function extractCreativePayload(message: string): string {
  const normalized = message.trim();
  const labeledPayload = normalized.match(/(?:口播文案|完整文案|文案|脚本|图片提示词|生图提示词|提示词导入)\s*[：:]\s*([\s\S]+)$/)?.[1]?.trim();
  if (labeledPayload) return labeledPayload;
  return normalized;
}

function creativePayloadForClassification(message: string): string {
  const normalized = message.trim();
  const payload = extractCreativePayload(normalized);
  if (payload !== normalized) return payload;
  return normalized
    .replace(/请|帮我|把|这段|下面|以下|这个|这些|口播|文案|脚本|拆成|拆分|分镜|镜头|生成|整理|一个|方案|待确认|先|暂时|不要|写入|画布/g, "")
    .trim();
}

function hasCreativePayload(message: string): boolean {
  const normalized = message.trim();
  const payload = creativePayloadForClassification(normalized);
  const payloadChars = countSpokenCharacters(payload);
  if (/[：:]/.test(normalized)) return payloadChars >= 12;
  return payloadChars >= 36 || countSpokenCharacters(normalized) >= 72;
}

function looksLikePromptBatch(message: string): boolean {
  const parsed = parsePromptBatch(message);
  if (parsed.items.length < 2) return false;
  if (EXPLICIT_PROMPT_IMPORT_PATTERN.test(message) || PROMPT_BATCH_REQUEST_PATTERN.test(message) || parsed.mode === "tagged" || parsed.mode === "numbered" || parsed.mode === "separated") return true;
  const longVisualLines = parsed.items.filter((item) => countSpokenCharacters(item.imagePrompt) >= 12).length;
  return longVisualLines >= 3 && /镜头|画面|场景|角色|特写|远景|近景|光线|构图|风格|,|，/.test(message);
}

export function classifyAgentMessage(message: string, hasExistingPlan = false): AgentInputKind {
  const normalized = message.trim();
  if (!normalized) return "chat";
  if (CASUAL_CHAT_PATTERN.test(normalized)) return "chat";
  if (hasExistingPlan && STORYBOARD_REVISION_PATTERN.test(normalized)) return "revision";
  if (EXPLICIT_PROMPT_IMPORT_PATTERN.test(normalized)) return hasCreativePayload(normalized) ? "prompt_batch" : "clarify";
  if (looksLikePromptBatch(normalized)) return "prompt_batch";
  if (STORYBOARD_REQUEST_PATTERN.test(normalized)) return hasCreativePayload(normalized) ? "storyboard_script" : "clarify";
  if (PROMPT_BATCH_REQUEST_PATTERN.test(normalized)) return hasCreativePayload(normalized) ? "prompt_batch" : "clarify";
  return countSpokenCharacters(normalized) >= 48 ? "storyboard_script" : "chat";
}

export function messageNeedsStoryboardPlan(message: string, hasExistingPlan = false): boolean {
  const kind = classifyAgentMessage(message, hasExistingPlan);
  return kind === "storyboard_script" || kind === "prompt_batch" || kind === "revision";
}

function normalizeSegmentText(value: string): string {
  const trimmed = value.trim();
  const wrapped = trimmed.match(SEGMENT_WRAPPER_PATTERN)?.[1]?.trim();
  return wrapped || trimmed;
}

export function extractSegmentedNarrations(script: string): string[] {
  const normalized = script.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const lines = normalized.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  const lineSegments = lines
    .map((line) => line.match(SEGMENTED_LINE_PATTERN)?.[1])
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeSegmentText);
  if (lineSegments.length >= 2 && lineSegments.length === lines.length) return lineSegments;

  const inlineSegments = [...normalized.matchAll(
    /(?:^|\n|\s)(?:第?\s*[一二三四五六七八九十百千万\d]+\s*[段镜条]?|[一二三四五六七八九十百千万\d]+)\s*[.．、:：)）\-—]\s*(【[\s\S]*?】|[^\n]+?)(?=\s*(?:\n|第?\s*[一二三四五六七八九十百千万\d]+\s*[段镜条]?|[一二三四五六七八九十百千万\d]+)\s*[.．、:：)）\-—]|$)/gu,
  )].map((match) => normalizeSegmentText(match[1])).filter(Boolean);
  return inlineSegments.length >= 2 ? inlineSegments : [];
}

function hardSplit(fragment: string, maxSpokenChars: number): string[] {
  const parts: string[] = [];
  let current = "";
  let spoken = 0;
  for (const char of Array.from(fragment)) {
    current += char;
    if (SPOKEN_CHAR_PATTERN.test(char)) spoken += 1;
    if (spoken >= maxSpokenChars) {
      parts.push(current.trim());
      current = "";
      spoken = 0;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function splitNarration(
  script: string,
  charsPerSecond = 6,
  shotSeconds = 5,
): string[] {
  const normalized = script.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];
  const segmentedNarrations = extractSegmentedNarrations(normalized);
  if (segmentedNarrations.length >= 2) return segmentedNarrations;
  const maxSpokenChars = Math.max(6, Math.round(charsPerSecond * shotSeconds));
  const fragments = normalized
    .split(/(?<=[，。！？；,.!?;])|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => countSpokenCharacters(part) > maxSpokenChars ? hardSplit(part, maxSpokenChars) : [part]);

  const scenes: string[] = [];
  let current = "";
  for (const fragment of fragments) {
    const candidate = current ? `${current}${fragment}` : fragment;
    if (current && countSpokenCharacters(candidate) > maxSpokenChars) {
      scenes.push(current);
      current = fragment;
    } else {
      current = candidate;
    }
  }
  if (current) scenes.push(current);
  return scenes;
}

function normalizeStoryboardDuration(shotSeconds: number): StoryboardDurationSeconds | null {
  const rounded = Math.round(shotSeconds);
  if (rounded === 8 || rounded === 10 || rounded === 15) return rounded;
  if (shotSeconds >= 13) return 15;
  if (shotSeconds >= 9) return 10;
  if (shotSeconds >= 7) return 8;
  return null;
}

function shotCountLabel(durationSeconds: StoryboardDurationSeconds) {
  if (durationSeconds === 8) return { count: "3", range: "3个真实镜头", panel: "四格2x2故事板" };
  if (durationSeconds === 15) return { count: "4-6", range: "4至6个真实镜头", panel: "四格2x2或底部全宽五格故事板" };
  return { count: "3-4", range: "3至4个真实镜头", panel: "四格2x2故事板，必要时五格" };
}

function inferStoryboardScene(narration: string) {
  if (/(?:医院|兽医|医生|检查|病|疼|吐|拉肚|伤口|皮肤|耳朵|口腔|牙|身体|不舒服|健康)/u.test(narration)) return "宠物健康中心或家中室内护理角，干净柔和灯光，健康记录卡、听诊器贴纸和爪印盾牌图标作为友好安全表达";
  if (/(?:吃|食盆|粮|零食|水果|药|误吞|吞|喂|饭)/u.test(narration)) return "家中厨房边或客厅喂食区，食盆、防滑垫、小块食物样本和收纳盒清楚可见";
  if (/(?:遛|牵引绳|小区|公园|草地|外面|出门|马路|车)/u.test(narration)) return "小区花园或公园步道，牵引绳、草地边缘、路灯和安全提示牌形成空间层次，不默认大马路";
  if (/(?:洗澡|护理|美容|梳毛|剪|店)/u.test(narration)) return "宠物店或室内护理台，梳子、毛巾、护理喷瓶和柔和顶光整齐摆放";
  return "温暖现代客厅，浅色沙发、木地板、狗窝、玩具和食盆形成前中后景";
}

function inferStoryboardPackaging(narration: string) {
  if (/(?:为什么|怎么会|难道|是不是|吗|呢|？|\?)/u.test(narration)) return { anchor: "悬浮问号贴纸与放大镜光圈", image: "问号贴纸从狗狗视线前方的小放大镜边缘弹出，停在留白区，不遮挡表情", video: "悬浮问号贴纸随狗狗歪头轻弹一次，放大镜光圈沿视线扫过后淡出" };
  if (/(?:以为|误会|误解|不是|别把|搞错|错)/u.test(narration)) return { anchor: "错位标签与断开的连接线", image: "两张无字错位标签贴在道具两侧，断开的连接线从主人手势处拉开", video: "错位标签被主人手势拨正，断开的连接线短暂摇晃后收束" };
  if (/(?:危险|风险|中毒|不能|不要|别|伤|疼|吐|拉肚|医院|病|严重|警惕)/u.test(narration)) return { anchor: "红橙警示牌与爪印盾牌", image: "红橙警示牌由道具接触点弹出，旁边有爪印盾牌保护狗狗侧前方", video: "警示牌随道具碰撞亮起一次，爪印盾牌向前挡住风险物后稳定停留" };
  if (/(?:结论|所以|记住|正确|建议|答案|重点|一定要|只要)/u.test(narration)) return { anchor: "金色结论牌与绿色勾选章", image: "金色无字结论牌停在主人手势指向处，绿色勾选章落在安全道具旁", video: "金色结论牌由主人手势带出，绿色勾选章轻扣到安全道具旁并稳定发光" };
  if (/(?:反而|却|没想到|突然|原来|其实|不是.*而是)/u.test(narration)) return { anchor: "红黑爆裂牌与翻转裂片", image: "红黑爆裂牌从道具后方半露，几片裂片沿狗狗视线方向翻开", video: "红黑爆裂牌快速翻出又收住，裂片沿视线方向旋转半圈后消散" };
  if (/(?:害怕|紧张|焦虑|委屈|压力|惊恐|心虚|不安)/u.test(narration)) return { anchor: "角色外侧光晕与细密震动线", image: "细密震动线只放在狗狗身体外侧留白区，暖色光晕贴着地面反射，不接触毛发", video: "震动线随狗狗后缩轻颤两次，外侧光晕随呼吸起伏后减弱" };
  if (/(?:原因|机制|判断|知识|表现|信号|说明|检查|对比)/u.test(narration)) return { anchor: "安全示意面板与颜色区箭头", image: "无字安全示意面板立在背景侧面，颜色区箭头从真实道具指向安全图标", video: "颜色区箭头沿道具路径滑动，安全示意面板轻微点亮后保持" };
  return { anchor: "道具触发的轻量强调线", image: "轻量强调线从真实道具接触点向外展开，贴合场景透视并留出角色表情空间", video: "强调线随道具接触短暂展开，动作完成时自然淡出" };
}

function inferDogPerformance(narration: string) {
  if (/(?:害怕|危险|疼|不舒服|紧张|惊恐)/u.test(narration)) return "狗狗眼白扩大、耳朵压低、身体重心后移，尾巴收紧，保持自然四足结构";
  if (/(?:疑惑|为什么|吗|不懂|误会)/u.test(narration)) return "狗狗歪头、瞳孔扫视、耳朵一只竖起一只微压，鼻尖靠近道具但不拿取";
  if (/(?:委屈|心虚|躲|藏)/u.test(narration)) return "狗狗缩脖后退半步，斜眼看主人，尾巴低低摆动，前爪只做自然支撑";
  if (/(?:开心|放心|正确|安全|恢复)/u.test(narration)) return "狗狗靠近主人脚边，耳朵放松，尾巴自然摇动，眼神从紧张转为安心";
  return "狗狗用耳朵、眼神、尾巴和重心完成中度动画化反应，始终是自然四足犬类比例";
}

function storyboardSoundPrompt(narration: string) {
  if (/(?:公园|小区|外面|遛|牵引绳)/u.test(narration)) return "轻微风声、远处环境底噪、爪垫踏地声、牵引绳轻响";
  if (/(?:食盆|吃|喂|粮|零食)/u.test(narration)) return "室内底噪、食盆轻碰、爪垫移动、小块道具落在垫上的轻声";
  if (/(?:检查|医院|兽医|护理|梳毛)/u.test(narration)) return "安静室内底噪、纸卡轻响、护理工具轻碰、狗狗轻微呼吸";
  return "室内环境底噪、脚步声、爪垫轻响、布料摩擦和道具轻碰";
}

function storyboardVideoTimeline(durationSeconds: StoryboardDurationSeconds, mainAction: string, packagingAction: string) {
  if (durationSeconds === 8) {
    return `镜头1 0-2.4秒：狗狗保持动作前势，主人手或牵引绳把视线引向关键道具；镜头2 2.4-5.6秒：${mainAction}，${packagingAction}；镜头3 5.6-8秒：角色反应收住，道具停稳，镜头轻推到稳定落幅。`;
  }
  if (durationSeconds === 15) {
    return `镜头1 0-2.6秒：建立场景、狗狗表情和关键道具位置；镜头2 2.6-5.4秒：主人动作触发道具反馈；镜头3 5.4-8.4秒：${mainAction}；镜头4 8.4-11.4秒：${packagingAction}；镜头5 11.4-13.6秒：狗狗情绪转折并靠近或后缩；镜头6 13.6-15秒：所有动作停在清楚安全的落幅。`;
  }
  return `镜头1 0-2.6秒：狗狗和关键道具入画，主人手势建立动作方向；镜头2 2.6-5.4秒：${mainAction}；镜头3 5.4-8秒：${packagingAction}，道具和环境同步反馈；镜头4 8-10秒：狗狗表情收住，镜头轻推到稳定落幅。`;
}

function storyboardPrompts(narration: string, index: number, route: GenerationRoute, referenceStrategy: ReferenceStrategy, durationSeconds: StoryboardDurationSeconds): BrainScene {
  const shotInfo = shotCountLabel(durationSeconds);
  const scene = inferStoryboardScene(narration);
  const packaging = inferStoryboardPackaging(narration);
  const dogPerformance = inferDogPerformance(narration);
  const soundPrompt = storyboardSoundPrompt(narration);
  const owner = "年轻亚洲女主人，黄色时尚连帽卫衣或轻运动休闲上衣，蓝色牛仔裤或休闲裤，白色运动鞋；同一条视频内服装一致";
  const dog = "自然四足狗狗，商业3D动画毛发质感；允许瞪眼、眼白扩大、耳朵压低或竖起、尾巴反馈、后缩、靠近主人、惊恐、委屈或好奇；不长人手、不站立行走、不拿工具、不穿成人服装";
  const mainAction = "主人用手势、食盆、牵引绳或检查卡引导狗狗完成一个清楚动作，狗狗用耳朵、眼神、尾巴和重心给出同步反应";
  const timeline = storyboardVideoTimeline(durationSeconds, mainAction, packaging.video);
  const imagePrompt = [
    `第${index + 1}段参考图，${shotInfo.panel}，商业3D宠物科普动画质感，圆润大眼、细腻布料、蓬松毛发、暖金光影、高饱和但干净的包装色。`,
    `角色锁定：${owner}；${dog}。`,
    `场景：${scene}。`,
    `画面任务：把本段信息转成一个可见微剧情；每格只冻结一个动作峰值，准备、触发、反应、落幅连续接力，构图在近景表演、道具特写、低机位或俯视证据之间变化。`,
    `语义包装：${packaging.anchor}；${packaging.image}；所有特效都由角色视线、脚步、牵引绳、食盆、放大镜、检查卡或环境反馈触发，不凭空堆装饰。`,
    `安全表达：健康、医院、病症、伤口、身体不适只用图标贴纸、外部中景检查动作、侧腰外轮廓、抽象颜色区和安全示意面板表达。`,
    `版本边界：图文注释版只允许每格极短导演注释；纯画面参考版必须把说明条、小字和注释转成无字图标、箭头、颜色区或空间锚点，避免污染视频参考。`,
  ].join("\n");
  const startFramePrompt = `${imagePrompt}\n首帧取第一格动作前势：关键道具、主人手势、狗狗视线和后续运动空间清楚。`;
  const endFramePrompt = `${imagePrompt}\n尾帧取最后一格稳定落幅：狗狗情绪、道具位置、${packaging.anchor}和场景光线全部收住。`;
  const videoPrompt = [
    `生成约${durationSeconds}秒，用${shotInfo.range}，只让参考图里的角色、道具和${packaging.anchor}动起来。`,
    timeline,
    `狗狗表演边界：${dogPerformance}；不改变犬类身体结构。`,
    `镜头沿核心动作方向推进、跟随或轻微俯仰，包装只按出现、增强、接触或改变、收束的生命周期运动，落幅接力到下一段。`,
    `声音只保留现场声：${soundPrompt}；人物嘴部保持自然闭合或呼吸微张，不做发声表演，画面内不出现可读字卡或歌词性文字。`,
  ].join("\n");
  return {
    narration,
    durationSeconds,
    imagePrompt,
    startFramePrompt: referenceStrategy === "first-last" ? startFramePrompt : "",
    endFramePrompt: referenceStrategy === "first-last" ? endFramePrompt : "",
    keyframePrompt: route === "keyframe-img2img" ? imagePrompt : "",
    refinementPrompt: route === "keyframe-img2img" ? "保持同一角色、犬种、服装、场景和故事板布局，只增强材质、光影、构图清晰度和商业3D动画完成度。" : "",
    videoPrompt,
  };
}

function localPrompts(narration: string, index: number, route: GenerationRoute, referenceStrategy: ReferenceStrategy): BrainScene {
  const base = `客服产品短视频第${index + 1}镜，${narration}，主体明确，真实商业场景，画面干净，竖屏构图，品牌广告质感`;
  const startFramePrompt = `${base}，动作起始状态，人物与主体位置清晰，保留后续运动空间`;
  const endFramePrompt = `${base}，动作完成后的稳定落点，人物、服装、主体、场景、构图和光线与首帧一致`;
  return {
    narration,
    imagePrompt: route === "text-to-image" ? base : `${base}，关键帧成片效果`,
    startFramePrompt: referenceStrategy === "first-last" ? startFramePrompt : "",
    endFramePrompt: referenceStrategy === "first-last" ? endFramePrompt : "",
    keyframePrompt: route === "keyframe-img2img" ? `${base}，静态关键帧，人物和产品位置清晰` : "",
    refinementPrompt: route === "keyframe-img2img" ? "保持人物、产品和构图一致，优化材质、灯光与商业广告质感，不改变主体身份" : "",
    videoPrompt: referenceStrategy === "first-last"
      ? `以首帧为动作起点、尾帧为稳定落点，${narration}；镜头轻微推进，主体动作自然，角色和场景一致，无跳变，无新增人物，时长与口播匹配`
      : `以当前参考图为首帧，${narration}；镜头轻微推进，主体动作自然，口型与动作稳定，无跳变，无新增人物，时长与口播匹配`,
  };
}

export function createLocalBrainPlan(
  script: string,
  route: GenerationRoute,
  charsPerSecond = 6,
  shotSeconds = 5,
  referenceStrategy: ReferenceStrategy = "single",
): BrainPlan {
  const payload = extractCreativePayload(script);
  const segmentedNarrations = extractSegmentedNarrations(payload);
  const usesSegmentedStoryboard = segmentedNarrations.length >= 2;
  const storyboardDuration = normalizeStoryboardDuration(shotSeconds) || (usesSegmentedStoryboard ? 10 : null);
  const narrations = usesSegmentedStoryboard ? segmentedNarrations : splitNarration(payload, charsPerSecond, shotSeconds);
  return BrainPlanSchema.parse({
    title: usesSegmentedStoryboard ? "自由画布分段故事板" : "客服口播视频",
    route,
    referenceStrategy,
    charsPerSecond,
    summary: usesSegmentedStoryboard
      ? `识别到用户已分段文案，共 ${narrations.length} 段；保留原分段边界，每段生成 1 张故事板参考图和 1 条约 ${storyboardDuration} 秒视频提示词。`
      : `按语义完整和每秒约 ${charsPerSecond} 字拆分，共 ${narrations.length} 个镜头。`,
    assetLock: usesSegmentedStoryboard
      ? "自由画布独立规则：固定年轻亚洲主人、自然四足狗狗、场景语义路由、语义包装和后期配声边界；不依赖任何智能体配置。"
      : "保持人物、主体、服装、产品、场景布局与光影方向连续一致。",
    scenes: narrations.map((narration, index) => (
      usesSegmentedStoryboard && storyboardDuration
        ? storyboardPrompts(narration, index, route, referenceStrategy, storyboardDuration)
        : localPrompts(narration, index, route, referenceStrategy)
    )),
  });
}

export function createPromptBatchBrainPlan(
  input: string,
  route: GenerationRoute,
  charsPerSecond = 6,
  referenceStrategy: ReferenceStrategy = "single",
): BrainPlan {
  const parsed = parsePromptBatch(extractCreativePayload(input));
  const items = parsed.items.filter((item) => item.imagePrompt.trim()).slice(0, 40);
  return BrainPlanSchema.parse({
    title: "提示词导入项目",
    route,
    referenceStrategy,
    charsPerSecond,
    summary: `识别到 ${items.length} 条图片提示词，已整理为可确认分镜；视频提示词可继续由智能体补充。`,
    assetLock: "沿用导入提示词中的角色、产品、场景和风格；批量生成时保持画幅与主体一致。",
    scenes: items.map((item, index) => {
      const imagePrompt = item.imagePrompt.trim();
      const fallbackVideoPrompt = `以该分镜参考图为首帧，保持画面主体、构图、服装、产品和场景一致，做轻微镜头推进或自然动作演绎，无新增主体，无跳变，适合口播短视频。`;
      return {
        narration: `分镜 ${String(index + 1).padStart(2, "0")}`,
        durationSeconds: 5,
        imagePrompt,
        startFramePrompt: referenceStrategy === "first-last" ? imagePrompt : "",
        endFramePrompt: referenceStrategy === "first-last" ? `${imagePrompt}，动作完成后的稳定落点，主体和构图与首帧一致` : "",
        keyframePrompt: route === "keyframe-img2img" ? imagePrompt : "",
        refinementPrompt: route === "keyframe-img2img" ? "在不改变主体身份和构图的前提下，增强光影、材质、商业广告质感与画面完成度。" : "",
        videoPrompt: item.videoPrompt.trim() || fallbackVideoPrompt,
      };
    }),
  });
}

export function extractJsonObject(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("模型未返回 JSON 对象");
  return JSON.parse(candidate);
}
