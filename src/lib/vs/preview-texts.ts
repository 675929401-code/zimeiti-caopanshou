const PREVIEW_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  热门推荐: '大家好，欢迎来到智音工坊！今天给大家带来一款实用的智能配音工具，快来试试吧！',
  模拟真人: '你知道吗，有时候生活就是这样，给你关上一扇门的同时，也会为你打开一扇窗。',
  影视解说: '故事的转折往往出人意料。在这个看似平静的小镇上，一场暗流涌动的风暴正在酝酿。',
  角色动漫: '凡人，你终于来了！我已经等你很久了，还不快快报上名来！',
  情感治愈: '你知道吗，有时候生活就是这样，给你关上一扇门的同时，也会为你打开一扇窗。',
  短视频配音: '大家好，今天分享一个实用的小技巧，记得点赞收藏。',
  商业播报: '您好，欢迎致电智音客服中心。我是您的专属客服顾问，很高兴为您服务。',
  __default__: '你好，我是智音工坊的语音助手，希望能为你提供专业的配音服务。',
});

/**
 * The provider and browser cache must use exactly the same fixed text. Keeping
 * the 50-character limit here prevents a second truncation rule from drifting.
 */
export function resolveVoicePreviewText(category?: string | null): string {
  const source = PREVIEW_TEXTS[(category || '').trim()] || PREVIEW_TEXTS.__default__;
  if (source.length <= 50) return source;
  const prefix = source.slice(0, 50);
  const lastPunctuation = Math.max(
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
  );
  return lastPunctuation > 10 ? prefix.slice(0, lastPunctuation + 1) : `${prefix}。`;
}

export const VOICE_PREVIEW_CATEGORIES = Object.freeze(Object.keys(PREVIEW_TEXTS));
