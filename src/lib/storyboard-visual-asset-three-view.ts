export type StoryboardPetIdentityState = 'current' | 'young' | 'senior';
/** petState is retained for historical records; new requests follow the original prompt. */
export type StoryboardThreeViewInput = { sourceAssetId?: string; petState?: StoryboardPetIdentityState };

/** Keep the imported identity description intact; image identity is an explicit option. */
export function storyboardFirstThreeViewInput<T extends { role: string; name: string; prompt: string; planId: string }>(
  input: T, petState?: StoryboardPetIdentityState, sourceAssetId?: string,
): T & { threeView?: StoryboardThreeViewInput } {
  void petState;
  if (input.role !== 'character' && input.role !== 'pet') return input;
  return { ...input, threeView: { ...(sourceAssetId ? { sourceAssetId } : {}) } };
}

/** Historical metadata helper; age wording no longer blocks or changes generation. */
export function petThreeViewNeedsState(asset: { name?: string; prompt?: string; planId?: string }) {
  const text = [asset.name, asset.prompt, asset.planId].filter(Boolean).join(' ');
  return /age[_-]?pair|双年龄|年龄对照|青年老年/u.test(text)
    || /青年|年轻|幼年|幼犬/u.test(text) && /老年|年老|老犬|高龄/u.test(text);
}

export function buildStoryboardThreeViewPrompt(role: 'character' | 'pet', petState?: StoryboardPetIdentityState, identityPrompt?: string, hasReferenceImage = identityPrompt === undefined): string {
  void role;
  void petState;
  if (!hasReferenceImage && !identityPrompt?.trim()) throw new Error('请提供人物或宠物的身份描述后生成三视图。');
  const identity = hasReferenceImage ? '以实际提供的唯一参考图和下方身份描述为身份依据。' : '仅依据下方原始身份描述直接创建同一主体，不要求已有主图或上传图片。';
  const layout = '制作同一主体的单张三视图：在同一张画布中从左到右并列展示近正面、自然侧面、近背面，主体完整入画，三个视角比例与尺度一致，彼此留白且不重叠。允许视角自然遮挡，不可见细节仅作保守合理补全。主体身份、物种、年龄、阶段、外形、姿态与画面风格均遵循原始身份描述，不额外指定。无文字、数字、视角标签、箭头、边框、标志或水印。';
  const description = identityPrompt === undefined ? '' : '\n原始身份描述（完整保留）：\n' + identityPrompt;
  return identity + layout + description;
}
