import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getSemanticAgentAvatarFallback, getSemanticAgentAvatarUrl } from '@/lib/agent-avatar-aliases';

const LOCAL_AVATAR_THUMBNAILS: Readonly<Record<string, string>> = {
  '/avatars/soft-placement-v1.png': '/avatars/optimized/soft-placement-v1-256.jpg',
  '/avatars/ip-positioning-v1.png': '/avatars/optimized/ip-positioning-v1-256.jpg',
  '/avatars/selling-proof-v1.png': '/avatars/optimized/selling-proof-v1-256.jpg',
  '/avatars/qianchuan-copy-v1.png': '/avatars/optimized/qianchuan-copy-v1-256.jpg',
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 安全的 JSON.parse 封装，解析失败时返回 fallback 而不抛错。
 * 用于 localStorage 读取、API 响应解析等不可信数据源。
 */
export function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * 安全的 localStorage.getItem 封装，带 try-catch 防护。
 * 在隐私模式或 Storage 被禁用时不会抛错。
 */
export function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 安全的 localStorage.setItem 封装，带 try-catch 防护。
 */
export function safeLocalStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 静默失败（隐私模式/配额超限）
  }
}

/**
 * 安全的 localStorage.removeItem 封装，带 try-catch 防护。
 */
export function safeLocalStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 静默失败
  }
}

/**
 * 将智能体头像字段解析为浏览器可访问的 URL。
 *
 * avatar 字段可能有四种形态：
 * 1. 完整 URL（https://...）→ 直接返回
 * 2. 本地静态路径（/avatars/xxx.jpeg）→ 直接返回（Next.js public 目录）
 * 3. 对象存储 key（coze_storage_xxx / generate_image_xxx）→ 走 /api/avatars?key= 代理
 * 4. Emoji（📝）→ 不是图片，返回空字符串，让调用方走 Emoji/文字回退
 */
export function resolveAvatarUrl(avatar: string | undefined | null): string {
  if (!avatar) return '';
  const trimmed = avatar.trim();
  if (!trimmed) return '';

  const semanticAvatar = getSemanticAgentAvatarUrl(trimmed);
  if (semanticAvatar) return semanticAvatar;

  // 完整 URL 直接返回
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  // 本地静态路径直接返回（Next.js public 目录下的文件）
  if (trimmed.startsWith('/avatars/') || trimmed.startsWith('/uploads/')) {
    return LOCAL_AVATAR_THUMBNAILS[trimmed] || trimmed;
  }

  // Emoji 判断：大部分 emoji 的码点 > 0x1F000 或者长度较短且非路径格式
  // 简单启发：如果不包含 / 和 . 且长度 < 8，大概率是 emoji
  const isLikelyEmoji = trimmed.length <= 4 && !trimmed.includes('/') && !trimmed.includes('.');
  if (isLikelyEmoji) return '';

  // 对象存储 key → 走代理
  const rendition = /\.(?:gif|svg)(?:$|\?)/iu.test(trimmed) ? "" : "&w=384";
  return `/api/avatars?key=${encodeURIComponent(trimmed)}${rendition}`;
}

/**
 * Resolve the stable display image for an agent identity.
 *
 * The database still contains legacy emoji, expired remote URLs and object
 * storage keys. Agent cards already use local semantic artwork, so every
 * other agent surface should use the same local fallback instead of becoming
 * an initials badge when a remote avatar source is unavailable.
 */
export function resolveAgentAvatarUrl(
  agentId: string | undefined | null,
  agentName: string | undefined | null,
  avatar: string | undefined | null,
): string {
  const resolved = resolveAvatarUrl(avatar);
  const requiresStableFallback = !resolved
    || /^https?:\/\//iu.test(resolved);
  if (!requiresStableFallback) return resolved;
  return getSemanticAgentAvatarFallback(agentId || agentName || 'agent', agentName || '智能体');
}

/**
 * 将 Markdown 文本转换为纯文本，去除所有格式符号。
 * 用于复制 AI 回复时提供干净的纯文本内容。
 */
export function stripMarkdown(md: string): string {
  let text = md;

  // 1. 移除代码块 ```lang\n...\n```
  text = text.replace(/```[\w]*\n?[\s\S]*?```/g, (match) => {
    // 保留代码块内的纯文本内容
    return match.replace(/```\w*\n?/g, '').replace(/```$/g, '');
  });

  // 2. 移除行内代码 `code`
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. 移除图片 ![alt](url) → 保留 alt 文字
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 4. 移除链接 [text](url) → 保留 text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 5. 移除加粗 **text** 或 __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // 6. 移除斜体 *text* 或 _text_
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');

  // 7. 移除标题标记 # ## ### 等
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 8. 移除水平分割线 --- 或 *** 或 ___
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');

  // 9. 移除引用标记 >
  text = text.replace(/^>\s?/gm, '');

  // 10. 移除无序列表标记 - * +（保留内容）
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');

  // 11. 移除有序列表标记 1. 2. 等（保留内容）
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');

  // 12. 移除 HTML 标签
  text = text.replace(/<[^>]+>/g, '');

  // 13. 清理多余空行（最多保留2个连续换行）
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * 跨浏览器安全的剪贴板复制函数。
 * 优先使用 Clipboard API（需 HTTPS / localhost），
 * 失败时回退到 document.execCommand('copy')。
 * @returns true=复制成功, false=复制失败
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 1. 优先 Clipboard API（现代浏览器 + 安全上下文）
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(trimmed);
      return true;
    } catch {
      // Clipboard API 失败，继续 fallback
    }
  }

  // 2. Fallback: textarea + execCommand（兼容 HTTP / 旧浏览器 / iframe）
  try {
    const textarea = document.createElement('textarea');
    textarea.value = trimmed;
    // 避免在页面底部出现滚动条
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 提取纯文案文本，专用于"一键复制文案"场景。
 * 与 stripMarkdown 的区别：
 * 1. 代码块（```...```）完全移除，不保留内容
 * 2. 移除 PromptBlock 注入标记（【来自「xxx」的输出...】）
 * 3. 移除元数据行（逻辑主线:、风险提醒:、创作策略: 等结构性标注）
 * 4. 移除 --- 分隔线
 * 5. 清理所有 Markdown 格式符号
 * 返回可直接粘贴使用的纯文案段落。
 */
export function extractPureText(md: string): string {
  let text = md;

  // 1. 完全移除代码块 ```lang\n...\n``` （不保留内容）
  text = text.replace(/```[\w]*\n?[\s\S]*?```/g, '');

  // 2. 移除行内代码 `code` → 保留内容
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. 移除 PromptBlock 注入标记（【来自「xxx」的输出，请直接基于此内容执行任务...】）
  text = text.replace(/【来自「[^」]*」的输出[^\】]*】/g, '');

  // 4. 移除元数据行（逻辑主线:、风险提醒:、创作策略:、输出格式: 等结构性标注）
  text = text.replace(/^(逻辑主线|风险提醒|创作策略|输出格式|核心策略|内容策略|写作策略|结构规划|关键要点|注意事项|目标受众|内容要求|风格要求|格式要求|内容框架|写作框架|执行要点|重点提示|温馨提示|补充说明|特别说明|参考方向|延伸建议)\s*[:：].*$/gm, '');

  // 5. 移除图片 ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 6. 移除链接 [text](url) → 保留 text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 7. 移除加粗 **text** 或 __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // 8. 移除斜体 *text* 或 _text_
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');

  // 9. 移除标题标记 # ## ### 等
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 10. 移除水平分割线 --- 或 *** 或 ___
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');

  // 11. 移除引用标记 >
  text = text.replace(/^>\s?/gm, '');

  // 12. 移除无序列表标记 - * +（保留内容）
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');

  // 13. 移除有序列表标记 1. 2. 等（保留内容）
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');

  // 14. 移除 HTML 标签
  text = text.replace(/<[^>]+>/g, '');

  // 15. 清理多余空行（最多保留2个连续换行）
  text = text.replace(/\n{3,}/g, '\n\n');

  // 16. 清理行首行尾空白
  text = text
    .split('\n')
    .map(line => line.trim())
    .join('\n');

  // 17. 再次清理多余空行（trim 后可能产生新空行）
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
