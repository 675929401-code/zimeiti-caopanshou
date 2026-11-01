/** Shared tiers for every agent. Prompt viewports are equal-height within a tier;
 * ordinary documents and code use the tier as a natural-height ceiling. */
export function isPlaintextCodeLanguage(language: string): boolean {
  return ['', 'txt', 'text', 'plain', 'plaintext', 'markdown', 'md', 'prompt', 'image-prompt', 'video-prompt'].includes(language.toLowerCase());
}

export function getCodeBlockPresentation(content: string, language = '', context = ''): {
  heightClass: string; purpose: 'image-prompt' | 'video-prompt' | 'generic-prompt' | 'document' | 'code'; label: string;
} {
  const plain = isPlaintextCodeLanguage(language);
  const label = context.trim().split('\n').filter(Boolean).at(-1) || '';
  const mediaLabel = /(?:生图|图生视频|文生视频|图片|图像|视频|image|video|text.to.image|image.to.video)\s*(?:生成)?\s*(?:prompt|提示词)|(?:prompt|提示词)\s*[：:|｜-]?\s*(?:生图|图片|图像|视频|image|video)/iu;
  const mediaBody = /(?:镜头|画面|景别|光线|构图|角色|camera|lighting|cinematic|composition)/iu;
  const promptLabel = /(?:prompt|提示词)/iu.test(label);
  const prompt = plain && (/(?:^|-)prompt$/iu.test(language) || mediaLabel.test(label) || mediaLabel.test(content.slice(0, 180)) ||
    (promptLabel && mediaBody.test(content.slice(0, 600))));
  const mediaKind = (value: string) => /(?:视频|video)/iu.test(value) ? 'video-prompt' as const
    : /(?:生图|图片|图像|image)/iu.test(value) ? 'image-prompt' as const : undefined;
  const explicitKind = language.toLowerCase() === 'video-prompt' ? 'video-prompt'
    : language.toLowerCase() === 'image-prompt' ? 'image-prompt' : undefined;
  const contextualKind = mediaLabel.test(label) ? mediaKind(label) : undefined;
  const bodyKind = mediaLabel.test(content.slice(0, 180)) ? mediaKind(content.slice(0, 180)) : undefined;
  const purpose = prompt ? explicitKind || contextualKind || bodyKind || 'generic-prompt' : plain ? 'document' : 'code';
  const displayLabel = purpose === 'image-prompt' ? '生图提示词' : purpose === 'video-prompt' ? '视频提示词'
    : purpose === 'generic-prompt' ? '提示词' : purpose === 'document' ? '文档' : language.toUpperCase();
  if (prompt) return { heightClass: 'code-block-h-sm', purpose, label: displayLabel };

  // Estimate wrapped reading lines as well as volume. A single long paragraph
  // must not be treated as one tiny line; sparse formatted code also needs room.
  const lines = content.trimEnd().split('\n');
  const readingLines = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / (plain ? 72 : 110))), 0);
  const heightClass = content.length <= 3000 && readingLines <= 32 ? 'code-block-h-sm'
    : content.length <= 9000 && readingLines <= 100 ? 'code-block-h-md' : 'code-block-h-lg';
  return { heightClass, purpose, label: displayLabel };
}

export function getCodeBlockHeightClass(content: string, language = '', context = ''): string {
  return getCodeBlockPresentation(content, language, context).heightClass;
}
