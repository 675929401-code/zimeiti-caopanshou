/**
 * 纯函数渲染工具 — 无 React 依赖，可独立测试
 *
 * 从 chat-view.tsx 提取，负责纯文本+代码块的 HTML 拼装。
 * 锁定规则：DOM 结构必须与 markdown-renderer.ts 的 enhanceCodeBlocks 输出一致（#18 DOM 一致性保护）
 */

import { getCodeBlockPresentation, isPlaintextCodeLanguage } from '../../lib/code-block-presentation';

function renderLiteralCode(code: string, lang: string, context: string, streaming = false): string {
  const presentation = getCodeBlockPresentation(code, lang, context);
  const classes = ['code-block-wrapper', presentation.heightClass, isPlaintextCodeLanguage(lang) ? 'code-block-plaintext' : '', streaming ? 'code-block-streaming' : ''].filter(Boolean).join(' ');
  return `<div class="${classes}" data-code-purpose="${presentation.purpose}"><div class="code-block-header"><span class="code-block-lang">${escapeHtml(presentation.label)}</span><div class="code-block-actions"><button type="button" class="code-block-expand-button" aria-expanded="false">展开全文</button><button type="button" class="copy-code-button" title="复制完整内容" aria-label="复制完整内容"></button></div></div><pre class="hljs code-block-pre"><code class="hljs language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre></div>`;
}

export function renderTextWithCodeBlocks(text: string): string {
  const codeBlockRegex = /```([\w+#.-]*)\n([\s\S]*?)```/g;
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
    result += renderLiteralCode(code, lang, text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result += `<p>${escapeHtml(text.slice(lastIndex)).replace(/\n/g, "<br/>")}</p>`;
  }

  return result || "<p></p>";
}

/** 流式纯文本+代码块混合渲染（未闭合代码块用骨架占位） */
export function renderStreamingTextWithCodeBlocks(text: string): string {
  const codeBlockRegex = /```([\w+#.-]*)\n([\s\S]*?)```/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += `<p>${escapeHtml(text.slice(lastIndex, match.index)).replace(/\n/g, "<br/>")}</p>`;
    }
    const lang = match[1] || "text";
    const code = match[2].replace(/\n$/, "");
    result += renderLiteralCode(code, lang, text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
  }

  // 处理剩余内容（可能包含未闭合代码块）
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    const openFence = remaining.match(/```([\w+#.-]*)(?:\n([\s\S]*))?$/);
    if (openFence) {
      const lang = openFence[1] || "text";
      const code = openFence[2] || "";
      result += renderLiteralCode(code, lang, remaining.slice(0, openFence.index), true);
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
