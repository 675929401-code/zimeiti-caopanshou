type VisualAssetPromptRole = "character" | "pet" | "environment" | "prop";

/** Preserve the requested composition; identity references do not require a turnaround. */
export function buildVisualAssetPrompt(role: VisualAssetPromptRole, userPrompt: string): string {
  const identityLayout = "视角、姿态与排版以以下资产描述的明确要求为准：指定单视角时只生成该单视角；只有未指定视角或排版时，才默认同一主体的单视角全身三分之四主参考：人物完整呈现头部至鞋，宠物完整呈现四足和尾部；不自动生成三视图或多视角拼图。用户明确要求三视图、多视角、近景或其他构图时，按原要求呈现。每次生成一张参考图。";
  const prefix = role === "character"
    ? `角色身份参考图：保持同一人物的脸型、发型、体型以及本项目服装和配饰一致，完整呈现描述要求的身体范围；使用干净的白色或中性背景，不添加剧情分格、字幕或水印。${identityLayout}`
    : role === "pet"
      ? `宠物身份参考图：保持同一只宠物的身体比例、毛色分布、耳尾特征及描述指定的胸背、项圈或配饰一致；使用干净的中性背景，不添加剧情分格、字幕或水印。${identityLayout}`
      : role === "environment"
        ? "场景视觉资产锚点，不是剧情分镜：一张单画面宽幅环境建立图，锁定空间布局、固定家具、门窗或围栏等地标、主色材质和基准光线；不包含人物、宠物、剧情动作、临时道具状态、字幕、文字、水印、四宫格或五宫格。需要其他机位时，基于这张锚点图另行生成独立角度图，不把多角度拼在同一张图里。"
        : "道具视觉资产参考板，不是剧情分镜：同一物体的正面、侧面、背面或关键细节多角度展示，保持形状、数量、材质和颜色一致，中性背景，无字幕、无水印、无四宫格故事板。";
  return `${prefix}\n用户补充的固定资产描述：${userPrompt}`;
}
