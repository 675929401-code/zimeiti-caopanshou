import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  buildStoryboardUserPrompt,
  formatStoryboardTxt,
  segmentNarration,
  StoryboardPanelModeSchema,
  StoryboardProjectSchema,
  StoryboardTargetDurationSchema,
  StoryboardTextLayoutModeSchema,
  storyboardTextLayoutInstruction,
} from "@/lib/storyboard-workbench";
import { loadStoryboardAgentConfig } from "@/lib/server/storyboard-agent-store";

const RequestSchema = z.object({
  script: z.string().trim().min(10).max(30000),
  style: z.string().trim().min(2).max(500).default("高品质电影级3D卡通动画，柔和暖光，细腻毛发，夸张但可信的表演"),
  ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).default("16:9"),
  panelMode: StoryboardPanelModeSchema.default("fixed-4"),
  targetDuration: StoryboardTargetDurationSchema.default(10),
  textLayoutMode: StoryboardTextLayoutModeSchema.default("visual-only"),
});
// 模型名由服务端固定：/api/llm 的 model_overridden 覆盖要求 pm_ 公共ID，
// 普通用户带 model_overridden 会 404；改走按名称解析（仅服务端可信名称）。
const STORYBOARD_COMPILE_MODEL = "gpt-5.6-sol";

function parseJsonContent(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("智能体没有返回可识别的JSON");
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  }
}

function extractMessageContent(payload: Record<string, unknown>) {
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content || "";
}

function normalizeVideoExecutionPrompt(value: string) {
  return value
    .replace(/Frame\s*\d+\s*[:：][^。；\n]*/giu, "")
    .replace(/英文说明条|Frame文字|Frame说明条|导演注释|底部小字/gu, "图形化包装锚点")
    .replace(/医院名称|科室招牌|病历小字|药品标签|医疗说明/gu, "兽医十字图标贴纸")
    .replace(/宠物医院|医院|就医|看医生|问医生|问医|拍视频问医/gu, "兽医十字图标贴纸和手机问诊图标")
    .replace(/狗狗?哼声/gu, "低频呼吸动作音")
    .replace(/哼叫/gu, "呼吸节奏线、眼白扩大")
    .replace(/急促呼吸声|急促喘息声|喘息声/gu, "呼吸节奏线配合轻微呼吸拟音")
    .replace(/狗叫|犬吠|吠叫/gu, "爪垫摩擦和急停动作")
    .replace(/猫叫/gu, "室内环境声")
    .replace(/惊讶张嘴/gu, "瞪眼抬眉")
    .replace(/嘴巴张开急促喘息|张开急促喘息|张大嘴巴|张嘴大叫|开口大叫/gu, "眼白扩大、眉毛上扬、呼吸节奏明显")
    .replace(/开口说话|人物说话|宠物说话|对白口型|连续口型|念出|读出/gu, "眉眼和手势表达")
    .replace(/局部放大窗/gu, "无字兽医安全图标窗")
    .replace(/翻开嘴唇|掀开嘴唇|扒开嘴/gu, "轻托脸侧并亮起口腔健康色块图标")
    .replace(/肚子随呼吸紧绷起伏|腹部随呼吸紧绷起伏/gu, "侧腰外轮廓随呼吸节奏微微起伏")
    .replace(/肚子绷紧|腹部绷紧|肚子硬胀|腹部硬胀/gu, "侧腰外轮廓紧张")
    .replace(/肚子起伏|腹部起伏/gu, "侧腰呼吸节奏")
    .replace(/肚子红区膨胀|腹部红区膨胀/gu, "侧腹外轮廓红橙风险区")
    .replace(/肚子|腹部/gu, "侧腰外轮廓")
    .replace(/牙龈白区|牙龈色块/gu, "口腔健康色块图标")
    .replace(/胸腹起伏线/gu, "呼吸节奏线")
    .replace(/扫描嗡嗡声|光晕扫描|扫描|嗡嗡声/gu, "光晕扩散轻响")
    .replace(/内部危险信号/gu, "外部可见风险信号")
    .replace(/腹股沟|下腹|生殖[^，。；\n]*|排泄[^，。；\n]*|私密[^，。；\n]*|乳头|裸露器官|真实病灶|翻肚皮/gu, "侧腰外轮廓安全视角");
}

function normalizeStoryboardImagePrompt(value: string) {
  return value
    .replace(/每格下方[^。]*Frame[^。]*。?/giu, "")
    .replace(/Frame\s*\d+\s*[:：][^。；\n]*/giu, "")
    .replace(/英文说明条|Frame文字|Frame说明条|导演注释|底部小字/gu, "图形化包装锚点")
    .replace(/医院名称|科室招牌|病历小字|药品标签|医疗说明/gu, "兽医十字图标贴纸")
    .replace(/宠物医院|医院|就医|看医生|问医生|问医|拍视频问医/gu, "兽医十字图标贴纸和手机问诊图标")
    .replace(/局部放大窗/gu, "无字兽医安全图标窗")
    .replace(/翻开嘴唇|掀开嘴唇|扒开嘴/gu, "轻托脸侧并亮起口腔健康色块图标")
    .replace(/肚子随呼吸紧绷起伏|腹部随呼吸紧绷起伏/gu, "侧腰外轮廓随呼吸节奏微微起伏")
    .replace(/肚子绷紧|腹部绷紧|肚子硬胀|腹部硬胀/gu, "侧腰外轮廓紧张")
    .replace(/肚子红区膨胀|腹部红区膨胀/gu, "侧腰外轮廓红橙风险区")
    .replace(/肚子|腹部/gu, "侧腰外轮廓")
    .replace(/牙龈发白|牙龈白区|牙龈色块|牙龈/gu, "口腔健康色块图标")
    .replace(/胸腹起伏线/gu, "呼吸节奏线")
    .replace(/扫描|嗡嗡声/gu, "粒子轻响")
    .replace(/腹股沟|下腹|生殖[^，。；\n]*|排泄[^，。；\n]*|私密[^，。；\n]*|乳头|裸露器官|真实病灶|翻肚皮/gu, "侧腰外轮廓安全视角");
}

function assertVideoPromptQuality(prompt: string, segmentIndex: number) {
  const hardFailures = [
    /猫叫|狗叫|犬吠|吠叫|哼叫|狗狗?哼声|急促喘息声|喘息声/u,
    /开口说话|人物说话|宠物说话|对白口型|连续口型|念出|读出|嘴巴张开|张大嘴巴|张嘴大叫|开口大叫/u,
    /腹股沟|下腹|生殖|排泄|私密|乳头|裸露器官|真实病灶|翻肚皮/u,
    /局部放大窗|肚子|腹部|肚子红区膨胀|腹部红区膨胀|牙龈白区|牙龈色块/u,
    /Frame\s*\d+|英文说明条|Frame文字|Frame说明条|导演注释|底部小字/u,
    /医院名称|科室招牌|病历小字|药品标签|医疗说明/u,
    /此格动作已|已在(?:上一镜|镜头\d?|前后镜头)|不单独(?:成镜|生成)|无需(?:生成|单独)|只作参考|仅作参考/u,
    /扫描|嗡嗡声|全息|透明解剖/u,
  ];
  const matched = hardFailures.find((pattern) => pattern.test(prompt));
  if (matched) {
    throw new Error(`片段 ${segmentIndex + 1} 视频Prompt含高风险未编译词：${matched.source}`);
  }
}

function assertStoryboardImagePromptQuality(prompt: string, segmentIndex: number) {
  const hardFailures = [
    /腹股沟|下腹|生殖|排泄|私密|乳头|裸露器官|真实病灶|翻肚皮/u,
    /局部放大窗|肚子|腹部|肚子红区膨胀|腹部红区膨胀|牙龈发白|牙龈白区|牙龈色块|牙龈/u,
    /Frame\s*\d+|英文说明条|Frame文字|Frame说明条|导演注释|底部小字/u,
    /医院名称|科室招牌|病历小字|药品标签|医疗说明/u,
    /全息|透明解剖/u,
  ];
  const matched = hardFailures.find((pattern) => pattern.test(prompt));
  if (matched) {
    throw new Error(`片段 ${segmentIndex + 1} 生图Prompt含高风险未编译词：${matched.source}`);
  }
}

function storyboardVideoOpeningGuard(beatCount: number, duration: 8 | 10 | 15) {
  const shotCount = duration === 15 ? "4至6" : duration === 8 ? "3" : "3至4";
  return [
    `读取输入的${beatCount}格故事板作为按时间顺序排列的视觉锚点、动作路线和角色资产依据，成片呈现正常全屏连续视频；参考图里的分格边界、角标和校准文字只作为内部读取依据。`,
    `用${shotCount}个真实镜头完成${duration}秒演出，不按面板数机械强切；保持角色、场景、道具、光影、色彩与语义包装连续。`,
    "角色全程用非语言表演：人物用眼睛、眉毛、手势和身体重心表达情绪，口部只呈现短暂表情形态并回到自然闭合；宠物用眼白、瞳孔、耳朵、尾巴、毛发、爪子和重心表达情绪。",
    "现场声轨只包含纯环境拟音：安静室内或户外底噪、脚步声、布料摩擦、道具碰撞、粒子闪光、爪垫摩擦和轻微呼吸，全部声音来自画面中的物体、空间和动作；人物口部保持闭合表情节奏，宠物嘴部只承担呼吸和表情。",
    "健康检查画面采用可发布的安全构图：完整中景或近中景的外部检查动作，无字兽医图标窗、兽医十字图标贴纸、听诊器贴纸、爪印盾牌、侧腰外轮廓、口腔健康色块图标、呼吸节奏线、温度/警示图标和红橙风险光晕；镜头聚焦宠物脸部、耳朵、肩背、侧腰外轮廓、四足落点和主人手势，宠物身体完整自然。",
  ].join("");
}

export async function POST(request: Request) {
  try {
    const input = RequestSchema.parse(await request.json());
    const authorization = request.headers.get("authorization");
    if (!authorization) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const segments = segmentNarration(input.script, input.targetDuration * 6);
    if (!segments.length) return NextResponse.json({ error: "文案没有可拆分内容" }, { status: 400 });
    const config = await loadStoryboardAgentConfig(getSupabaseAdminClient());
    const response = await fetch(new URL("/api/llm", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(240_000)]),
      body: JSON.stringify({
        messages: [{ role: "user", content: buildStoryboardUserPrompt({ ...input, segments }) }],
        agentId: "__canvas_storyboard_compiler__",
        agentName: "10秒故事板导演",
        model: STORYBOARD_COMPILE_MODEL,
        stream: false,
        system_prompt: `${config.prompt}\n\n# 本次画面文字模式（最高优先级）\n${storyboardTextLayoutInstruction(input.textLayoutMode)}`,
        response_format: "json_object",
        deep_thinking_type: 0,
        deep_thinking_overridden: true,
        temperature: 0.35,
        max_reply_tokens: 16000,
        timeout: 235,
        internal_workflow: "canvas-compiler",
      }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error || `导演智能体调用失败（${response.status}）`));
    const project = StoryboardProjectSchema.parse(parseJsonContent(extractMessageContent(payload)));
    if (project.segments.length !== segments.length) {
      throw new Error(`智能体返回 ${project.segments.length} 段，固定分段为 ${segments.length} 段`);
    }
    project.segments.forEach((segment, index) => {
      if (segment.narration !== segments[index]) throw new Error(`片段 ${index + 1} 改写了原文，已拒绝装卡`);
      if (segment.durationSeconds !== input.targetDuration) {
        throw new Error(`片段 ${index + 1} 应为 ${input.targetDuration} 秒，智能体返回了 ${segment.durationSeconds} 秒`);
      }
      const requiredBeatCount = input.panelMode === "fixed-4" ? 4 : input.panelMode === "fixed-5" ? 5 : null;
      if (requiredBeatCount && segment.beats.length !== requiredBeatCount) {
        throw new Error(`片段 ${index + 1} 应为 ${requiredBeatCount} 格，智能体返回了 ${segment.beats.length} 格`);
      }
      segment.storyboardImagePrompt = normalizeStoryboardImagePrompt(segment.storyboardImagePrompt);
      assertStoryboardImagePromptQuality(segment.storyboardImagePrompt, index);
      segment.videoPrompt = segment.beats
        .map((beat) => `第${beat.order}格图生视频 Prompt（${beat.timeRange}）：${normalizeVideoExecutionPrompt(beat.videoPrompt)}`)
        .join("\n\n");
      segment.videoPrompt = `${storyboardVideoOpeningGuard(segment.beats.length, input.targetDuration)}\n\n${segment.videoPrompt}`;
      assertVideoPromptQuality(segment.videoPrompt, index);
    });
    project.version = config.version;
    return NextResponse.json({
      project,
      txt: formatStoryboardTxt(project),
      agent: { version: config.version, updatedAt: config.updatedAt },
    });
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；")
      : error instanceof Error ? error.message : "故事板拆解失败";
    console.error("[storyboard/compile]", detail);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
