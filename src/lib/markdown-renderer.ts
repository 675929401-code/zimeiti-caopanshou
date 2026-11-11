/**
 * 🔒 核心底层代码 — 锁定保护
 *
 * 本文件是 Markdown 渲染引擎，格式输出的核心模块。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #9 格式输出层"。
 *
 * 锁定范围：整个文件
 * 锁定原因：渲染引擎是输出链路的核心，修改可能导致代码块崩坏、格式错乱
 *
 * Markdown 渲染引擎 — 对标 NextChat/chatai8
 *
 * 渲染策略：
 * 1. 流式期间：markdown-it渲染完整内容，未闭合代码块转义为纯文本显示
 * 2. 流式结束：markdown-it + highlight.js 完整渲染 + enhanceCodeBlocks增强
 *
 * 代码框渲染 1:1 对标 NextChat：
 * - 独立 header 行（语言标签 + 复制按钮），不遮挡代码
 * - 代码超过20行自动折叠（maxHeight: 400px）
 * - txt/plain/markdown 代码块 whiteSpace: pre-wrap（自动换行）
 * - 展开/折叠按钮 + 渐变遮罩
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { parseThinkTags } from './think-instruction';
import { getCodeBlockPresentation, isPlaintextCodeLanguage } from './code-block-presentation';

// ========== 常量 ==========

/** 代码块折叠行数阈值（已禁用折叠，设为极大值） */
const FOLD_LINE_THRESHOLD = Infinity;

/** 纯文本代码块语言列表（需要 pre-wrap 自动换行） */
function codePresentationAttributes(content: string, language: string, context = ''): string {
  const presentation = getCodeBlockPresentation(content, language, context);
  return `data-code-height="${presentation.heightClass}" data-code-purpose="${presentation.purpose}" data-code-label="${md.utils.escapeHtml(presentation.label)}"`;
}

function codeBlockToolbar(label: string): string {
  return `<div class="code-block-header"><span class="code-block-lang">${label}</span><div class="code-block-actions">` +
    `<button type="button" class="code-block-expand-button" aria-expanded="false">展开全文</button>` +
    `<button type="button" class="send-video-task-button" data-video-task-send title="发送到视频工作台">发送到视频工作台</button>` +
    `<button type="button" class="copy-code-button" title="复制完整内容" aria-label="复制完整内容"></button></div></div>`;
}

// ========== markdown-it 实例 ==========

const md = new MarkdownIt({
  // Assistant output is rendered with dangerouslySetInnerHTML. Keep raw HTML
  // disabled so model/user supplied tags are escaped before they reach the DOM.
  html: false,
  linkify: true,
  breaks: true,
  highlight: function (str: string, lang: string) {
    let highlighted = '';
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(str, { language: lang }).value;
      } catch {
        highlighted = md.utils.escapeHtml(str);
      }
    } else {
      highlighted = md.utils.escapeHtml(str);
    }
    const langClass = lang ? ` language-${lang}` : '';
    return `<pre class="hljs" ${codePresentationAttributes(str, lang)}><code class="hljs${langClass}">${highlighted}</code></pre>`;
  },
});

// A code token carries the original literal content, before HTML entities or
// syntax highlighting. The nearest prose label selects compact media prompts.
const defaultFenceRenderer = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  let context = '';
  for (let previous = index - 1; previous >= 0; previous--) {
    if (tokens[previous].type === 'fence' || tokens[previous].type === 'code_block') break;
    if (tokens[previous].type === 'inline') { context = tokens[previous].content; break; }
  }
  const attributes = codePresentationAttributes(token.content, token.info.trim().split(/\s+/u)[0] || '', context);
  return defaultFenceRenderer(tokens, index, options, env, renderer)
    .replace(/data-code-height="[^"]*" data-code-purpose="[^"]*" data-code-label="[^"]*"/u, attributes);
};

// ========== :::keyword 文档容器插件 ==========
// 解析 :::keyword 标题 ... ::: 语法，渲染为文档输出卡片（滚动框）
// 兼容多种格式：:::copy / :::text / :::article / :::文案 / :::话术 等
// 文档块内部代码块使用 copyable-inner-pre 渲染，避免 enhanceCodeBlocks 产生"框中框"

/** 文档块关键词 → 默认标签映射 */
const DOC_BLOCK_LABELS: Record<string, string> = {
  copy: '可复制内容',
  text: '文本文档',
  article: '文章',
  content: '内容',
  template: '模板',
  output: '输出',
  document: '文档',
  prompt: '提示词',
  work: 'Work done',
  workdone: 'Work done',
  'work-done': 'Work done',
  work_done: 'Work done',
  '文案': '文案',
  '话术': '话术',
  '视频提示词': '视频提示词',
  '文生视频': '文生视频提示词',
};

const COPY_BLOCK_KEYWORDS = new Set(Object.keys(DOC_BLOCK_LABELS).map((key) => key.toLowerCase()));

function isCopyBlockFragment(rawMarkdown: string): boolean {
  const text = rawMarkdown.trim();
  if (!text) return true;
  const lineCount = text.split('\n').filter((line) => line.trim()).length;
  return text.replace(/\s/g, '').length < 180 && lineCount <= 2;
}

function copyBlockPlugin(md: MarkdownIt) {
  // 匹配 :::keyword 标题\n内容\n::: 或 :::keyword\n内容\n:::
  // keyword 支持英文字母和中文，兼容 :::copy / :::text / :::文案 / :::话术 等
  const fenceReg = /^:::([\w\u4e00-\u9fff]+)(?:\s+(.*))?\s*$/;

  md.block.ruler.before('fence', 'copy_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const line = state.src.slice(start, max);

    const match = line.match(fenceReg);
    if (!match) return false;

    const keyword = match[1];
    if (!COPY_BLOCK_KEYWORDS.has(keyword.toLowerCase())) return false;
    if (silent) return true;
    const explicitTitle = match[2]?.trim();
    // 有显式标题用显式标题，否则用关键词映射，最后回退到关键词本身
    const title = explicitTitle || DOC_BLOCK_LABELS[keyword] || keyword;
    let nextLine = startLine + 1;

    // 寻找闭合 :::
    while (nextLine < endLine) {
      const pos = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const lineText = state.src.slice(pos, lineMax).trim();
      if (lineText === ':::') {
        break;
      }
      nextLine++;
    }

    // 未闭合 → 渲染到末尾
    const contentStart = state.bMarks[startLine + 1];
    const contentEnd = nextLine < endLine
      ? state.bMarks[nextLine]
      : state.eMarks[endLine - 1] + 1;
    const content = state.src.slice(contentStart, contentEnd).trimEnd();

    // 解析内部内容为 markdown
    let innerHtml = md.render(content);

    // 标记内部代码块，避免 enhanceCodeBlocks 包装为 code-block-wrapper（防止"框中框"）
    // 文档卡片本身就是外框，内部代码块只需简单渲染，不需要独立的代码框包装
    innerHtml = innerHtml
      .replace(/<pre class="hljs"[^>]*>/g, '<pre class="copyable-inner-pre">')
      .replace(/<code class="hljs language-/g, '<code class="copyable-inner-code language-')
      .replace(/<code class="hljs">/g, '<code class="copyable-inner-code">');

    // 存储原始 Markdown 源码（用于复制按钮直接复制标准 Markdown，而非纯文本）
    const rawContent = md.utils.escapeHtml(content);

    const token = state.push('copy_block', '', 0);
    token.content = innerHtml;
    token.meta = { title, rawContent };
    token.map = [startLine, nextLine + 1];

    state.line = nextLine < endLine ? nextLine + 1 : nextLine;
    return true;
  });

  md.renderer.rules.copy_block = (tokens, idx) => {
    const token = tokens[idx];
    const title = md.utils.escapeHtml(token.meta.title || '可复制内容');
    const content = token.content;
    const rawContent = token.meta.rawContent || '';
    const htmlEntityMap: Record<string, string> = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"};
    const rawMarkdown = (token.meta.rawContent || '').replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (c: string) => htmlEntityMap[c] || c);
    const isLong = rawMarkdown.length > 1000;
    const isFragment = isCopyBlockFragment(rawMarkdown);
    const classes = [
      'copyable-block',
      isLong ? 'copyable-block-long' : '',
      isFragment ? 'copyable-block-fragment' : '',
    ].filter(Boolean).join(' ');
    const footer = isFragment ? '' : (
      `<div class="copyable-block-footer">` +
      `<button class="copyable-block-copy-btn" title="复制文本">` +
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
      `</button>` +
      `</div>`
    );
    return (
      `<div class="${classes}" data-copy-title="${title}">` +
      `${isFragment ? '' : `<div class="copyable-block-header">`}` +
      `${isFragment ? '' : `<span class="copyable-block-label">${title}</span>`}` +
      `${isFragment ? '' : `</div>`}` +
      `<div class="copyable-block-content" data-raw="${rawContent}">${content}</div>` +
      footer +
      `</div>`
    );
  };
}

md.use(copyBlockPlugin);

// ========== enhanceCodeBlocks — 1:1 对标 NextChat ==========

function enhanceCodeBlocks(html: string): string {
  // 快速跳过不含代码块的文本段（splitByCodeBlocks 分出的文本段通常不含 <pre>）
  if (!html.includes('<pre class="hljs"')) return html;
  // 匹配 markdown-it highlight 渲染的代码块
  return html.replace(
    /<pre class="hljs" data-code-height="(code-block-h-(?:sm|md|lg))" data-code-purpose="([^"]+)" data-code-label="([^"]*)"><code class="hljs language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_match: string, heightClass: string, purpose: string, label: string, lang: string, codeContent: string) => {
      const isPlaintext = isPlaintextCodeLanguage(lang);

      const wrapperClasses = ['code-block-wrapper'];
      if (isPlaintext) wrapperClasses.push('code-block-plaintext');
      wrapperClasses.push(heightClass);

      return (
        `<div class="${wrapperClasses.join(' ')}" data-code-purpose="${purpose}">` +
        codeBlockToolbar(label) +
        `<pre class="hljs code-block-pre">` +
        `<code class="hljs language-${lang}">${codeContent}</code>` +
        `</pre>` +
        `</div>`
      );
    }
  );
}

function enhancePlainCodeBlocks(html: string): string {
  // 快速跳过不含无语言代码块的文本段
  if (!html.includes('<code class="hljs">')) return html;
  // 无语言标签的代码块
  return html.replace(
    /<pre class="hljs" data-code-height="(code-block-h-(?:sm|md|lg))" data-code-purpose="([^"]+)" data-code-label="([^"]*)"><code class="hljs">([\s\S]*?)<\/code><\/pre>/g,
    (_match: string, heightClass: string, purpose: string, label: string, codeContent: string) => {
      // 无语言代码块默认为 plaintext（pre-wrap）
      const wrapperClasses = ['code-block-wrapper', 'code-block-plaintext'];
      wrapperClasses.push(heightClass);

      return (
        `<div class="${wrapperClasses.join(' ')}" data-code-purpose="${purpose}">` +
        codeBlockToolbar(label) +
        `<pre class="hljs code-block-pre">` +
        `<code class="hljs">${codeContent}</code>` +
        `</pre>` +
        `</div>`
      );
    }
  );
}

// ========== renderMarkdown — 流式结束后完整渲染 ==========

export function renderMarkdown(text: string): string {
  // 自动闭合未闭合的代码围栏：当行首 ``` 出现奇数次时，追加闭合标记
  // 场景：LLM 输出被 max_tokens 截断，代码块中途断开无闭合 ```
  // 注意：只计算行首的 ```（CommonMark 规范），行内的 ``` 不是围栏
  let processedText = text;
  const fenceCount = (processedText.match(/(?:^|\n) {0,3}```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    processedText += '\n```';
  }

  let html = md.render(processedText);
  html = enhanceCodeBlocks(html);
  html = enhancePlainCodeBlocks(html);
  // 给 <table> 外面包一层容器，含横向滚动和复制按钮
  html = html.replace(/<table>/g, '<div class="table-wrapper"><button class="table-copy-btn" title="复制表格"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><table>');
  html = html.replace(/<\/table>/g, '</table></div>');
  return html;
}

// ========== splitByCodeBlocks — 流式渲染分段 ==========

interface CodeSegment {
  type: 'text' | 'closed-code' | 'open-code' | 'closed-copy' | 'open-copy';
  content: string;
  lang?: string;
  codeContent?: string;
  copyTitle?: string;
  copyKeyword?: string;  // :::keyword 中的 keyword（copy/text/article/文案 等）
}

function splitByCodeBlocks(text: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // 优先检测 :::keyword 文档容器（比 ``` 更早匹配）
    const copyMatch = remaining.match(/^:::([\w\u4e00-\u9fff]+)(?:\s+(.*))?\s*\n/m);
    const copyStartIdx = copyMatch ? (copyMatch.index ?? -1) : -1;
    // CommonMark 规范：代码围栏必须位于行首（最多3个空格缩进）
    // 如果 ``` 出现在行内（前面有非空白字符），则不是围栏，是行内代码
    const fenceLineMatch = remaining.match(/(?:^|\n)( {0,3}```)/);
    const fenceStart = fenceLineMatch
      ? (fenceLineMatch.index! + fenceLineMatch[0].length - 3) // 指向 ``` 本身的位置
      : -1;

    // 决定先处理哪种块
    let processCopy = false;
    let processFence = false;

    if (copyStartIdx !== -1 && fenceStart !== -1) {
      processCopy = copyStartIdx <= fenceStart;
      processFence = !processCopy;
    } else if (copyStartIdx !== -1) {
      processCopy = true;
    } else if (fenceStart !== -1) {
      processFence = true;
    }

    if (processCopy) {
      // :::copy 之前的文字
      if (copyStartIdx! > 0) {
        const beforeText = remaining.substring(0, copyStartIdx);
        if (beforeText.trim()) {
          segments.push({ type: 'text', content: beforeText });
        }
      }

      const copyKeyword = copyMatch![1];
      if (!COPY_BLOCK_KEYWORDS.has(copyKeyword.toLowerCase())) {
        if (remaining.trim()) {
          segments.push({ type: 'text', content: remaining });
        }
        break;
      }
      const copyTitle = copyMatch![2]?.trim() || DOC_BLOCK_LABELS[copyKeyword] || copyKeyword;
      const afterHeader = remaining.substring(copyStartIdx! + copyMatch![0].length);
      // 只匹配独立的 ::: 闭合行，排除 :::keyword 开头的行（防止误闭合）
      const closeMatch = afterHeader.match(/\n:::(?![\w\u4e00-\u9fff])/);
      const closeIdx = closeMatch ? closeMatch.index! : -1;

      if (closeIdx !== -1) {
        // 闭合 :::keyword 块
        const copyContent = afterHeader.substring(0, closeIdx);
        segments.push({ type: 'closed-copy', content: copyContent, copyTitle, copyKeyword });
        remaining = afterHeader.substring(closeIdx + 4); // skip \n:::
      } else {
        // 未闭合 :::keyword 块
        segments.push({ type: 'open-copy', content: afterHeader, copyTitle, copyKeyword });
        break;
      }
      continue;
    }

    if (!processFence) {
      // 没有代码块也没有 :::copy 了
      if (remaining.trim()) {
        segments.push({ type: 'text', content: remaining });
      }
      break;
    }

    // 代码块前的文字
    if (fenceStart > 0) {
      const beforeText = remaining.substring(0, fenceStart);
      if (beforeText.trim()) {
        segments.push({ type: 'text', content: beforeText });
      }
    }

    // 找代码块语言和内容
    const afterFence = remaining.substring(fenceStart + 3);
    const newLineIdx = afterFence.indexOf('\n');
    if (newLineIdx === -1) {
      // 只有语言标签，没有内容行
      segments.push({ type: 'open-code', content: remaining.substring(fenceStart), lang: afterFence.trim() || 'txt', codeContent: '' });
      break;
    }

    const lang = afterFence.substring(0, newLineIdx).trim() || 'txt';
    const codeBody = afterFence.substring(newLineIdx + 1);

    // 找闭合 ```（CommonMark: 行首最多3个空格缩进 + 尾随空格 + 行尾）
    // 闭合围栏必须独占一行：```后面只能跟空白符（空格/制表符）和换行符
    const closeMatch = codeBody.match(/\n {0,3}```[\t ]*(?:\n|$)/);
    if (!closeMatch) {
      // 也检查代码块最后一行就是 ```（无前导换行，如 LLM 输出最后恰好是 ```）
      if (/^ {0,3}```[\t ]*$/.test(codeBody.trimEnd())) {
        // 整个 codeBody 的末尾就是闭合围栏
        const closedContent = remaining.substring(fenceStart, fenceStart + 3 + newLineIdx + 1 + codeBody.trimEnd().length);
        segments.push({ type: 'closed-code', content: closedContent });
        remaining = '';
      } else {
        // 未闭合代码块
        segments.push({ type: 'open-code', content: remaining.substring(fenceStart), lang, codeContent: codeBody });
        break;
      }
    } else {
      const closeIdx = closeMatch.index!;
      const closeLength = closeMatch[0].length;
      // 闭合代码块
      const closedContent = remaining.substring(fenceStart, fenceStart + 3 + newLineIdx + 1 + closeIdx + closeLength);
      segments.push({ type: 'closed-code', content: closedContent });

      // 继续处理闭合代码块后面的内容
      remaining = codeBody.substring(closeIdx + closeLength);
    }
  }

  return segments;
}

// ========== renderStreamingText — 流式期间渲染 ==========

/**
 * 流式期间渲染策略（对标 chatai8/AIWeb）：
 * - 普通文本 → markdown-it 完整渲染（标题/列表/链接/表格等，与 chatai8 一致）
 * - 已闭合代码块 → markdown-it 完整渲染（code-block-wrapper，稳定不抖动）
 * - 未闭合代码块 → 轻量纯文本显示（streaming-code-hint + 光标闪烁）
 * - 已闭合 :::keyword 块 → renderMarkdown 完整渲染（copyable-block 卡片）
 * - 未闭合 :::keyword 块 → 轻量纯文本显示（带标题提示）
 */
// ========== Closed code block render cache ==========
// During streaming, renderStreamingText is called on every content update.
// Closed code blocks don't change between frames, so caching their rendered
// HTML avoids redundant highlight.js calls and eliminates code block flickering.
const closedCodeCache = new Map<string, string>();
const CLOSED_CODE_CACHE_MAX = 50;
// 文本段渲染缓存：流式期间稳定的文本段（非最后一个）可复用已渲染结果，避免重复 md.render()
const textRenderCache = new Map<string, string>();
const TEXT_RENDER_CACHE_MAX = 30;

interface StreamingRenderState {
  text: string;
  result: string;
  segmentCount: number;
  lastSegmentType: string;
  lastFullRenderLength: number;
}

const DEFAULT_STREAM_KEY = '__default_stream__';
const STREAMING_STATE_MAX = 100;
const STREAMING_FULL_RENDER_INTERVAL = 96;
const streamingRenderStates = new Map<string, StreamingRenderState>();

// Any ASCII punctuation or whitespace can complete Markdown/link syntax. Those
// updates use the full parser. Plain prose can be appended to an already plain
// trailing paragraph and is periodically reconciled with markdown-it.
const STREAMING_STRUCTURAL_APPEND_RE = /[\s\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/u;
const STREAMING_LINK_TAIL_RE = /(?:https?:\/\/|www\.|\S+@)\S*$/iu;

function patchTrailingPlainParagraph(renderedHtml: string, appendedText: string): string | null {
  if (!appendedText || STREAMING_STRUCTURAL_APPEND_RE.test(appendedText)) return null;
  if (!/<p>[^<]*<\/p>\n?$/u.test(renderedHtml)) return null;

  const closingIndex = renderedHtml.lastIndexOf('</p>');
  if (closingIndex < 0) return null;
  return `${renderedHtml.slice(0, closingIndex)}${md.utils.escapeHtml(appendedText)}${renderedHtml.slice(closingIndex)}`;
}

function rememberStreamingState(streamKey: string, state: StreamingRenderState): void {
  if (!streamingRenderStates.has(streamKey) && streamingRenderStates.size >= STREAMING_STATE_MAX) {
    const oldestKey = streamingRenderStates.keys().next().value;
    if (oldestKey !== undefined) streamingRenderStates.delete(oldestKey);
  }
  streamingRenderStates.set(streamKey, state);
}

/**
 * Render one streaming message. streamKey isolates incremental state so two
 * conversations/messages can update without invalidating each other.
 */
export function renderStreamingText(text: string, streamKey = DEFAULT_STREAM_KEY): string {
  const previous = streamingRenderStates.get(streamKey);

  if (previous && text.length > previous.text.length && text.startsWith(previous.text)) {
    const isInsideOpenBlock = previous.lastSegmentType === 'open-code' || previous.lastSegmentType === 'open-copy';
    const appendedText = text.slice(previous.text.length);
    const withinReparseInterval = text.length - previous.lastFullRenderLength < STREAMING_FULL_RENDER_INTERVAL;
    const linkMayStillBeGrowing = STREAMING_LINK_TAIL_RE.test(text.slice(-160));

    if (!isInsideOpenBlock && withinReparseInterval && !linkMayStillBeGrowing) {
      const patchedResult = patchTrailingPlainParagraph(previous.result, appendedText);
      if (patchedResult !== null) {
        rememberStreamingState(streamKey, {
          ...previous,
          text,
          result: patchedResult,
        });
        return patchedResult;
      }
    }
  }

  // Non-append updates, structural Markdown and open blocks are reconciled by
  // the full parser. Closed segment caches still avoid repeated highlighting.
  const segments = splitByCodeBlocks(text);
  let result = '';
  let lastType = 'text';
  let codeContext = '';
  for (const seg of segments) {
    result += renderSegment(seg, codeContext);
    codeContext = seg.type === 'text' ? seg.content : '';
    lastType = seg.type;
  }
  rememberStreamingState(streamKey, {
    text,
    result,
    segmentCount: segments.length,
    lastSegmentType: lastType,
    lastFullRenderLength: text.length,
  });
  return result;
}

/** 渲染单个段（提取自原 renderStreamingText，保持逻辑一致） */
function renderSegment(seg: { type: string; content: string; lang?: string; codeContent?: string; copyKeyword?: string; copyTitle?: string }, codeContext = ''): string {
  if (seg.type === 'text') {
    const cacheKey = seg.content;
    let rendered = textRenderCache.get(cacheKey);
    if (!rendered) {
      rendered = streamingLightRender(seg.content);
      if (textRenderCache.size >= TEXT_RENDER_CACHE_MAX) {
        const firstKey = textRenderCache.keys().next().value;
        if (firstKey !== undefined) textRenderCache.delete(firstKey);
      }
      textRenderCache.set(cacheKey, rendered);
    }
    return rendered;
  } else if (seg.type === 'closed-code') {
    const cacheKey = `${codeContext}\u0000${seg.content}`;
    let rendered = closedCodeCache.get(cacheKey);
    if (!rendered) {
      rendered = renderStreamingCodeBlock(seg.content, codeContext);
      if (closedCodeCache.size >= CLOSED_CODE_CACHE_MAX) {
        const firstKey = closedCodeCache.keys().next().value;
        if (firstKey !== undefined) closedCodeCache.delete(firstKey);
      }
      closedCodeCache.set(cacheKey, rendered);
    }
    return rendered;
  } else if (seg.type === 'open-code') {
    const lang = seg.lang || 'txt';
    const code = seg.codeContent || '';
    const escapedCode = md.utils.escapeHtml(code);
    const isPlaintext = isPlaintextCodeLanguage(lang);
    const presentation = getCodeBlockPresentation(code, lang, codeContext);
    const wrapperClasses = ['code-block-wrapper', 'code-block-streaming', presentation.heightClass];
    if (isPlaintext) wrapperClasses.push('code-block-plaintext');
    // 添加data-streaming-code标识 + data-lang，用于增量更新时定位和复用
    return (
      `<div class="${wrapperClasses.join(' ')}" data-code-purpose="${presentation.purpose}" data-streaming-code data-lang="${lang}">` +
      codeBlockToolbar(md.utils.escapeHtml(presentation.label)) +
      `<pre class="hljs code-block-pre"><code class="hljs language-${lang}">${escapedCode}</code></pre>` +
      `</div>`
    );
  } else if (seg.type === 'closed-copy') {
    const keyword = seg.copyKeyword || 'copy';
    const title = md.utils.escapeHtml(seg.copyTitle || DOC_BLOCK_LABELS[keyword] || keyword);
    const content = md.utils.escapeHtml(seg.content);
    return (
      `<div class="copyable-block copyable-block-streaming">` +
      `<div class="copyable-block-header">` +
      `<span class="copyable-block-label">${title}</span>` +
      `</div>` +
      `<div class="copyable-block-content">` +
      `<div class="whitespace-pre-wrap text-[var(--card-foreground)]">${content}</div>` +
      `</div>` +
      `<div class="copyable-block-footer">` +
      `<button class="copyable-block-copy-btn" title="复制文本">` +
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
      `</button>` +
      `</div>` +
      `</div>`
    );
  } else if (seg.type === 'open-copy') {
    const title = md.utils.escapeHtml(seg.copyTitle || '可复制内容');
    const content = md.utils.escapeHtml(seg.content);
    return (
      `<div class="copyable-block copyable-block-streaming">` +
      `<div class="copyable-block-header">` +
      `<span class="copyable-block-label">${title}</span>` +
      `</div>` +
      `<div class="copyable-block-content">` +
      `<div class="whitespace-pre-wrap text-[var(--card-foreground)]">${content}</div>` +
      `</div>` +
      `<div class="copyable-block-footer">` +
      `<button class="copyable-block-copy-btn" title="复制文本">` +
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
      `</button>` +
      `</div>` +
      `</div>`
    );
  }
  return '';
}

/**
 * ⚡ 流式渲染 — 对标 chatai8/AIWeb 完整 markdown 渲染
 *
 * 核心策略：使用 md.render() 渲染完整 markdown 格式（标题/列表/链接/表格等），
 * 让流式期间用户就能看到完全格式化的输出，与 chatai8 一致。
 * 未闭合代码块/文档块仍使用轻量纯文本显示。
 *
 * 性能：md.render() 约 1-5ms/帧，在 RAF 节流下（≤16ms/帧）有充足余量。
 */
function streamingLightRender(text: string): string {
  // 使用 markdown-it 完整渲染 + enhanceCodeBlocks，确保流式/最终DOM结构一致
  // 这样流式→最终渲染切换时不会因为DOM结构差异导致闪屏
  let html = md.render(text);
  html = enhanceCodeBlocks(html);
  html = enhancePlainCodeBlocks(html);
  // 表格也需要包裹 table-wrapper，与 renderMarkdown 保持 DOM 结构一致
  // 否则流式→最终切换时 table DOM 结构差异导致闪烁
  html = html.replace(/<table>/g, '<div class="table-wrapper"><button class="table-copy-btn" title="复制表格"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><table>');
  html = html.replace(/<\/table>/g, '</table></div>');
  return html;
}

/**
 * ⚡ 流式期间的闭合代码块轻量渲染 — 跳过 highlight.js
 *
 * 与 renderMarkdown() 的区别：不做语法高亮，只做转义 + code-block-wrapper 骨架。
 * 高亮推迟到流结束后的 renderMarkdown() 一次性完成。
 */
function renderStreamingCodeBlock(codeBlockText: string, codeContext = ''): string {
  // 提取语言和代码内容
  const match = codeBlockText.match(/^```([\w+#.-]*)\n?/);
  const lang = match ? (match[1] || 'txt') : 'txt';
  const codeContent = match ? codeBlockText.substring(match[0].length).replace(/\n?```\s*$/, '') : codeBlockText;
  const escapedCode = md.utils.escapeHtml(codeContent);
  const isPlaintext = isPlaintextCodeLanguage(lang);
  const presentation = getCodeBlockPresentation(codeContent, lang, codeContext);
  const wrapperClasses = ['code-block-wrapper'];
  if (isPlaintext) wrapperClasses.push('code-block-plaintext');
  wrapperClasses.push(presentation.heightClass);
  return (
    `<div class="${wrapperClasses.join(' ')}" data-code-purpose="${presentation.purpose}">` +
    codeBlockToolbar(md.utils.escapeHtml(presentation.label)) +
    `<pre class="hljs code-block-pre">` +
    `<code class="hljs language-${lang}">${escapedCode}</code>` +
    `</pre>` +
    `</div>`
  );
}

/**
 * Clear the closed code block render cache.
 * Called when streaming ends to free memory and ensure fresh renders
 * for the final non-streaming output.
 */
export function clearStreamingCache(streamKey?: string) {
  if (streamKey !== undefined) {
    streamingRenderStates.delete(streamKey);
    return;
  }
  closedCodeCache.clear();
  textRenderCache.clear();
  streamingRenderStates.clear();
}

/**
 * 重新导出 parseThinkTags
 */
export { parseThinkTags } from './think-instruction';
