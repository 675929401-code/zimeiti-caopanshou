export type CoverCompositionPlan = {
  title: string;
  subtitle: string;
  aspectRatio: "16:9" | "9:16" | "4:3" | "3:4";
  layoutTemplateId: string;
  animationStyleId: string;
  /** Optional for legacy history; every new Cover Studio task writes both fields. */
  coverModeId?: "cartoon" | "funny-cartoon";
  materialSourceId?: "text" | "template" | "upload";
  subjectModeId?: "semantic" | "product";
};

/** Match the rendering endpoint before a paid background request is submitted. */
export function coverCompositionValidationError(plan: CoverCompositionPlan): string | null {
  if (typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 80) return "封面标题请填写 1～80 个字符";
  if (typeof plan.subtitle !== "string" || plan.subtitle.length > 120) return "封面副标题不能超过 120 个字符";
  if (/[\x00-\x08\x0b-\x1f]/u.test(plan.title + plan.subtitle)) return "封面文字包含不支持的控制字符";
  if (plan.title.split(/\r?\n/u).length > 3) return "封面标题最多使用三行";
  if (plan.coverModeId !== undefined && !["cartoon", "funny-cartoon"].includes(plan.coverModeId)) return "请选择有效的创作模式";
  if (plan.materialSourceId !== undefined && !["text", "template", "upload"].includes(plan.materialSourceId)) return "请选择有效的创作来源";
  if (plan.subjectModeId !== undefined && !["semantic", "product"].includes(plan.subjectModeId)) return "请选择有效的参考用途";
  if (!["16:9", "9:16", "4:3", "3:4"].includes(plan.aspectRatio)
    || !/^gaoding-[a-z0-9-]{1,48}$/u.test(plan.layoutTemplateId)
    || !["pet-3d", "pixar-3d", "clay-soft", "storybook", "anime-soft", "cinematic-real", "photo-real"].includes(plan.animationStyleId)) return "请选择有效的封面比例、版式与风格";
  return null;
}

/** The model supplies artwork only; the application owns every visible glyph. */
export function buildCoverBackgroundPrompt(input: {
  brief: string;
  visualStyle: string;
  layoutHint: string;
  coverModeId?: "cartoon" | "funny-cartoon";
  materialSourceId?: "text" | "template" | "upload";
}): string {
  const modeRule = input.materialSourceId === "template"
    ? "学习参考模板的主体占比、阅读动线和自然负空间；原图中的文字框、条幅或底栏只学习占比，底图必须改成连续场景或自然纹理，不能复刻为空框。"
    : input.materialSourceId === "upload"
      ? "学习参考图的主体关系、构图节奏和色彩氛围，所有需要叠字的区域必须仍是连续场景或自然纹理。"
      : input.coverModeId === "funny-cartoon"
        ? "突出夸张而清晰的表情反应，主体占据中下部，上方保留连续场景中的低细节区域。"
        : "突出温暖的情绪关系和故事瞬间，主体位于中下部，在场景中自然形成可阅读的低细节区域。";
  return [
    "生成一张无字封面底图，只生成主体、环境、材质与光影。",
    `内容场景：${input.brief}`,
    `画面风格：${input.visualStyle}`,
    `版式参考：${input.layoutHint}；只参考主体关系、阅读动线与自然负空间，不绘制任何文字。`,
    modeRule,
    "主体完整且面部不被遮挡。供后续排版的位置必须是画面本身的连续背景，不能生成空白文字框、黑色横条、白色底栏、卡片、色块占位或标题框。",
    "硬性要求：画面内不得出现汉字、英文字母、数字、标点符号、标题、副标题、标语、标识、水印、拟文字或任何可被误认为文字的笔画。文字将由应用程序逐字绘制，请勿代写或改写文案。",
  ].join("\n");
}

export function coverCompositionMatches(value: unknown, plan: CoverCompositionPlan, sourceAssetId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const text = row.renderedText as Record<string, unknown> | undefined;
  return row.outputKind === "cover-composition" && row.sourceAssetId === sourceAssetId
    && text?.title === plan.title && text?.subtitle === plan.subtitle;
}
