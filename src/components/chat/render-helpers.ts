/**
 * 纯函数渲染工具 — 无 React 依赖，可独立测试
 *
 * 从 chat-view.tsx 提取，负责纯文本+代码块的 HTML 拼装。
 * 锁定规则：DOM 结构必须与 markdown-renderer.ts 的 enhanceCodeBlocks 输出一致（#18 DOM 一致性保护）
 */

/** 纯文本+代码块混合渲染：response_format=text 时使用 */
const CODE_HEIGHT_LEVEL_SM = 10;
const CODE_HEIGHT_LEVEL_MD = 25;

function getCodeBlockHeightClass(codeContent: string): string {
  const lineCount = (codeContent.match(/\n/g) || []).length + 1;
  if (lineCount <= CODE_HEIGHT_LEVEL_SM) return "code-block-h-sm";
  if (lineCount <= CODE_HEIGHT_LEVEL_MD) return "code-block-h-md";
  return "code-block-h-lg";
}

export function renderTextWithCodeBlocks(text: string): string {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // 代码块前的纯文本
    if (match.index > lastIndex) {
      result += `<p>${escapeHtml(text.slice(lastIndex, match.index)).replace(/\n/g, "<br/>")}</p>`;
    }
    const lang = match[1] || "text";
    const code = match[2].replace(/\n$/, "");
    const heightClass = getCodeBlockHeightClass(code);
    result += `<div class="code-block-wrapper ${heightClass}"><div class="code-block-header"><span class="code-block-lang">${lang}</span><span class="copy-code-button"></span></div><pre class="hljs code-block-pre"><code class="hljs language-${lang}">${escapeHtml(code)}</code></pre></div>`;
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result += `<p>${escapeHtml(text.slice(lastIndex)).replace(/\n/g, "<br/>")}</p>`;
  }

  return result || "<p></p>";
}

/** 流式纯文本+代码块混合渲染（未闭合代码块用骨架占位） */
export function renderStreamingTextWithCodeBlocks(text: string): string {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += `<p>${escapeHtml(text.slice(lastIndex, match.index)).replace(/\n/g, "<br/>")}</p>`;
    }
    const lang = match[1] || "text";
    const code = match[2].replace(/\n$/, "");
    const heightClass = "code-block-h-lg";
    result += `<div class="code-block-wrapper ${heightClass}"><div class="code-block-header"><span class="code-block-lang">${lang}</span><span class="copy-code-button"></span></div><pre class="hljs code-block-pre"><code class="hljs language-${lang}">${escapeHtml(code)}</code></pre></div>`;
    lastIndex = match.index + match[0].length;
  }

  // 处理剩余内容（可能包含未闭合代码块）
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    const openFence = remaining.match(/```(\w*)(?:\n([\s\S]*))?$/);
    if (openFence) {
      const lang = openFence[1] || "text";
      const code = openFence[2] || "";
      result += `<div class="code-block-wrapper code-block-streaming code-block-h-lg"><div class="code-block-header"><span class="code-block-lang">${lang}</span><span class="copy-code-button"></span></div><pre class="hljs code-block-pre"><code class="hljs language-${lang}">${escapeHtml(code)}</code></pre></div>`;
    } else {
      result += `<p>${escapeHtml(remaining).replace(/\n/g, "<br/>")}</p>`;
    }
  }

  return result || "<p></p>";
}

/** 流式纯文本渲染：response_format=text + isStreaming */
export function renderStreamingPlainText(text: string): string {
  return renderStreamingTextWithCodeBlocks(text);
}

/** HTML 转义 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
