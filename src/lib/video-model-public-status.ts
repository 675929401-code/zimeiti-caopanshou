/** Fixed product copy only. Provider and administrator diagnostics are private. */
const PUBLIC_VIDEO_MODEL_MESSAGES: Readonly<Record<string, string>> = {
  WORKSPACE_MODEL_KIND_MISMATCH: "当前页面不支持此模型类型",
  DEDICATED_DIGITAL_HUMAN_MODEL: "该模型需在数字人专用工作台使用",
  VIDEO_DURATION_INVALID: "视频时长能力待配置",
  VIDEO_IMAGE_LIMIT_CONFLICT: "参考图数量能力待核验",
  VIDEO_AUDIO_LIMIT_CONFLICT: "参考音频数量能力待核验",
  VIDEO_SOURCE_CONTRACT_CONFLICT: "源视频输入能力待核验",
  STORYBOARD_IMAGE_INPUT_REQUIRED: "当前页面需要图生视频能力，此模型不接收故事板图片",
  STORYBOARD_TOO_MANY_REQUIRED_IMAGES: "需多张参考图，当前分镜卡仅提供一张图片",
  STORYBOARD_LAST_FRAME_REQUIRED: "需首尾帧，当前分镜卡未提供尾帧入口",
  STORYBOARD_SOURCE_VIDEO_REQUIRED: "需源视频，当前分镜卡未提供源视频入口",
  STORYBOARD_AUDIO_REQUIRED: "需参考音频，当前分镜卡未提供音频入口",
  CANVAS_SOURCE_VIDEO_REQUIRED: "需源视频，当前画布未提供源视频入口",
  COMMERCE_MULTI_REFERENCE_REQUIRED: "当前页面需要至少五张参考图的能力",
  COMMERCE_LAST_FRAME_ONLY: "当前页面不支持强制尾帧的输入方式",
  VIDEO_CAPABILITIES_UNVERIFIED: "能力待核验",
  VIDEO_MODEL_SUBMISSION_PAUSED: "该模型已暂停提交",
  VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED: "计费适配中，暂不可提交",
  VIDEO_PERSON_REFERENCE_PENDING: "人物参考能力待配置",
  VIDEO_PRICE_UNCONFIGURED: "价格待配置，暂不可提交",
  VIDEO_MODEL_INACTIVE: "该模型暂不可提交",
  VIDEO_CONFIGURATION_PENDING: "模型配置待完成，暂不可提交",
};

export function publicVideoModelCompatibilityCode(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(PUBLIC_VIDEO_MODEL_MESSAGES, value) ? value : "";
}

export function publicVideoModelCompatibilityMessage(value: unknown): string {
  const code = publicVideoModelCompatibilityCode(value);
  return code ? PUBLIC_VIDEO_MODEL_MESSAGES[code] : "";
}

/** Explain the most specific missing input before a generic image mismatch. */
export function publicVideoModelInputCompatibilityCode(issues: ReadonlyArray<{ code: string }>): string {
  const specific = ["STORYBOARD_SOURCE_VIDEO_REQUIRED", "STORYBOARD_LAST_FRAME_REQUIRED", "STORYBOARD_AUDIO_REQUIRED", "STORYBOARD_TOO_MANY_REQUIRED_IMAGES"]
    .find(code => issues.some(issue => issue.code === code));
  return publicVideoModelCompatibilityCode(specific || issues[0]?.code);
}
