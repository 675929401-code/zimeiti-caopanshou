"use client";

import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from "react";
import { Check, Copy, ClipboardCopy, ChevronDown, ChevronUp, Film, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { cn, copyToClipboard, extractPureText } from "@/lib/utils";
import { renderMarkdown, renderStreamingText, clearStreamingCache } from "@/lib/markdown-renderer";
import { renderTextWithCodeBlocks } from "@/components/chat/render-helpers";
import morphdom from "morphdom";
import type { OutputStyle } from "@/types/coze";
import { dispatchVideoTaskTransfer, makeVideoTaskTransferPayload } from "@/lib/video-task-transfer";
import {
  parseStructuredAgentOutput,
  publishStructuredAgentOutputOnce,
  type StructuredAgentOutputResult,
} from "@/lib/structured-agent-output";

// Keep the DOM morph cadence on the browser paint clock. 16 ms preserves the
// directness of the provider stream without introducing a second artificial
// queue; the app-context typewriter only meters what is already buffered.
const STREAM_MORPH_INTERVAL_MS = 16;

function appendStreamingCaret(html: string, caretId: string): string {
  const caret = `<span id="${caretId}" class="streaming-typewriter-caret" aria-hidden="true"></span>`;
  const trailingTextContainer = /<\/(?:p|li|h[1-6]|blockquote)>/giu;
  let insertionIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = trailingTextContainer.exec(html)) !== null) insertionIndex = match.index;
  return insertionIndex >= 0
    ? `${html.slice(0, insertionIndex)}${caret}${html.slice(insertionIndex)}`
    : `${html}${caret}`;
}

/**
 * message-content.tsx — 消息内容渲染组件
 * 从 chat-view.tsx 提取，负责所有消息内容的渲染逻辑
 *
 * 包含组件：
 * - ObjectStorageImage — 对象存储图片懒加载
 * - PromptBlock — 提示词折叠块（含推送至视频）
 * - CodeBlockWithCopy — 代码块（含行号+复制）
 * - TableWithCopy — 表格（含复制）
 * - ThinkingIndicator — 等待状态（头像涟漪+波浪点）
 * - StreamingContentWrapper — 流式包装器（思考指示器→内容切换）
 * - MessageContent — 核心渲染（流式/非流式双路径+Markdown+图片提取+标签）
 */

// ======================== 辅助函数 ========================

// ======================== 子组件 ========================

function ObjectStorageImage({ storageKey, index }: { storageKey: string; index: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadUrl = async () => {
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem("auth_token") : null;
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(`/api/file?key=${encodeURIComponent(storageKey)}`, { headers });
        if (!res.ok) throw new Error("Failed to get signed URL");
        const data = await res.json();
        if (!cancelled && data.url) setSrc(data.url);
        else if (!cancelled) setError(true);
      } catch {
        if (!cancelled) setError(true);
      }
    };
    loadUrl();
    return () => { cancelled = true; };
  }, [storageKey]);

  if (error) return <span className="text-[var(--text-secondary)] text-xs">[图片加载失败]</span>;
  if (!src) return <span className="text-[var(--text-secondary)] text-xs animate-pulse">[加载中...]</span>;

  return (
    <a key={`objimg-${index}`} href={src} target="_blank" rel="noopener noreferrer">
      <img
        src={src}
        alt={`图片 ${index + 1}`}
        className="max-w-[280px] max-h-[280px] rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-80 transition-opacity object-cover my-1"
        loading="lazy"
      />
    </a>
  );
}

function PromptBlock({ text, label, allMessages }: { text: string; label?: string; allMessages?: Message[] }) {
  const [collapsed, setCollapsed] = useState(true);
  const [copied, setCopied] = useState(false);
  const lineCount = text.split('\n').length;
  const isLong = lineCount > 20;

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      toast.success("已复制成功");
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopied(false);
      toast.error("复制失败，请手动复制");
    }
  };

  const handlePushToVideo = () => {
    try {
      let contentToPush = text.trim();
      if (allMessages && allMessages.length > 0) {
        const allPrompts = extractAllStructuredPrompts(allMessages);
        if (allPrompts.trim()) contentToPush = allPrompts;
      }
      const dispatched = dispatchVideoTaskTransfer(makeVideoTaskTransferPayload([{
        order: 1,
        prompt: contentToPush,
        label: "任务1",
        title: "来自对话提示词",
        source: "chat-message",
      }], "batch"));
      if (!dispatched) { toast.error("临时交接失败，请手动复制提示词"); return; }
      toast.success("已推送至视频平台，已自动填入视频任务卡片");
      window.location.assign("/video");
    } catch {
      toast.error("推送失败，请手动复制提示词");
    }
  };

  return (
    <div className="my-1.5 rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-[var(--muted)]/50 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5">
          <ClipboardCopy className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />
          <span className="text-[11px] font-semibold text-[var(--text-secondary)]">{label || '提示词'}</span>
          {isLong && (
            <span className="text-[10px] text-[var(--text-secondary)]">({lineCount}行)</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handlePushToVideo}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-[var(--text-secondary)] hover:bg-[var(--muted)] transition-colors"
            title="推送提示词至视频生成平台"
          >
            <Film className="w-3 h-3" /> 推送至视频
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--muted)] transition-colors"
          >
            {copied ? (
              <><Check className="w-3 h-3" /> 已复制</>
            ) : (
              <><Copy className="w-3 h-3" /> 一键复制</>
            )}
          </button>
          {isLong && (
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-[var(--muted-foreground)] hover:bg-[var(--muted)] transition-colors"
            >
              {collapsed ? (
                <><ChevronDown className="w-3 h-3" /> 展开</>
              ) : (
                <><ChevronUp className="w-3 h-3" /> 收起</>
              )}
            </button>
          )}
        </div>
      </div>
      <div
        className="relative px-2.5 py-2 text-[12.5px] leading-[1.55] whitespace-pre-wrap break-words text-[var(--card-foreground)] overflow-y-auto transition-[max-height] duration-300 ease-in-out"
        style={{ maxHeight: collapsed && isLong ? '800px' : 'none' }}
      >
        {text}
        <button
          onClick={handleCopy}
          className="absolute bottom-1.5 right-1.5 p-1 rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] transition-colors opacity-60 hover:opacity-100"
          title="复制"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

/** Generic code block with copy button */
function CodeBlockWithCopy({ text, language, children: highlightedChildren }: { text: string; language?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [hovering, setHovering] = useState(false);
  const lineCount = text.split('\n').length;
  const isPromptLang = !language || language === 'text' || language === 'txt' || language === 'prompt';
  const hasCodeSyntax = /^(import |from |def |class |function |const |let |var |return |if \(|for \(|while \(|#include|using |namespace |public |private |protected )/m.test(text);
  const isLongPrompt = isPromptLang && text.length > 200 && !hasCodeSyntax;

  if (isLongPrompt) {
    return <PromptBlock text={text} label="提示词" />;
  }

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      toast.success("已复制成功");
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopied(false);
      toast.error("复制失败，请手动复制");
    }
  };

  const displayLang = language || 'text';

  return (
    <div
      className="code-block-wrapper my-2 rounded-lg border border-[var(--border)] overflow-hidden"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="flex items-center gap-2 px-4 py-2 bg-[var(--muted)] border-b border-[var(--border)]">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">{displayLang}</span>
        <div className="flex-1" />
        <button
          onClick={handleCopy}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all duration-200",
            copied
              ? "bg-green-500/15 text-green-500"
              : "text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]"
          )}
        >
          {copied ? (
            <><Check className="w-3.5 h-3.5" /> 已复制</>
          ) : (
            <><Copy className="w-3.5 h-3.5" /> {hovering ? '复制' : ''}</>
          )}
        </button>
      </div>
      <div className="code-block-pre px-4 py-3 text-[85%] leading-[1.6] bg-[var(--color-canvas-subtle)]/60 overflow-x-auto overflow-y-auto">
        {isPromptLang ? (
          <code className="whitespace-pre text-[var(--card-foreground)]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace' }}>{text}</code>
        ) : (
          <div className="flex">
            {lineCount > 1 && (
              <div className="select-none pr-4 text-right text-[12px] text-[var(--text-secondary)] leading-[1.5] shrink-0 border-r border-[var(--border)]/30 mr-4" style={{ fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace' }}>
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
            )}
            {highlightedChildren ? (
              <code className="hljs whitespace-pre" style={{ fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace' }}>{highlightedChildren}</code>
            ) : (
              <code className="whitespace-pre text-[var(--card-foreground)]" style={{ fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace' }}>{text}</code>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Table with copy button */
function TableWithCopy({ children, ...props }: React.ComponentPropsWithoutRef<'table'>) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      const extractText = (node: React.ReactNode): string => {
        if (typeof node === 'string') return node;
        if (typeof node === 'number') return String(node);
        if (!node) return '';
        if (Array.isArray(node)) return node.map(extractText).join('');
        if (React.isValidElement(node)) return extractText((node.props as Record<string, React.ReactNode>).children);
        return '';
      };
      const extractTableRows = (node: React.ReactNode): string[][] => {
        const rows: string[][] = [];
        const findRows = (n: React.ReactNode) => {
          if (!n || typeof n === 'string' || typeof n === 'number') return;
          if (Array.isArray(n)) { n.forEach(findRows); return; }
          if (!React.isValidElement(n)) return;
          const props = n.props as Record<string, React.ReactNode>;
          const type = typeof n.type === 'string' ? n.type : '';
          if (type === 'tr') {
            const cells: string[] = [];
            const findCells = (c: React.ReactNode) => {
              if (!c || typeof c === 'string' || typeof c === 'number') return;
              if (Array.isArray(c)) { c.forEach(findCells); return; }
              if (!React.isValidElement(c)) return;
              const ct = typeof c.type === 'string' ? c.type : '';
              if (ct === 'th' || ct === 'td') {
                cells.push(extractText(c).trim());
              } else {
                findCells((c.props as Record<string, React.ReactNode>).children);
              }
            };
            findCells(props.children);
            if (cells.length > 0) rows.push(cells);
          } else {
            findRows(props.children);
          }
        };
        findRows(node);
        return rows;
      };
      const rows = extractTableRows(children);
      const text = rows.length > 0
        ? rows.map(row => row.join('\t')).join('\n')
        : extractText(children).replace(/\s{2,}/g, '\t');
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopied(true);
        toast.success("表格已复制");
        setTimeout(() => setCopied(false), 2000);
      } else {
        setCopied(false);
        toast.error("复制失败，请手动复制");
      }
    } catch {
      setCopied(false);
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <div className="my-1.5 rounded-lg border border-[var(--border)] overflow-hidden">
      <div className="flex items-center justify-end px-3 py-1 bg-[var(--muted)]/60 border-b border-[var(--border)]">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] transition-colors"
        >
          {copied ? (
            <><Check className="w-3 h-3" /> 已复制</>
          ) : (
            <><Copy className="w-3 h-3" /> 复制表格</>
          )}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    </div>
  );
}

/** First-token indicator. Identity/avatar is rendered once by MessageBubble. */
function ThinkingIndicator() {
  return (
    <div
      className="chat-first-token-indicator flex min-h-5 items-center py-0.5"
      role="status"
      aria-label="等待首段内容"
      data-testid="chat-first-token-indicator"
    >
      <div className="thinking-wave flex items-center gap-[3px]" aria-hidden="true">
        <span /><span /><span />
      </div>
    </div>
  );
}

/** Streaming content wrapper — handles thinking→content transition */
function StreamingContentWrapper({ text, messageId, isUser, outputStyle, fontSize, isStreaming, hasReasoning, responseFormat }: {
  text: string; messageId?: string; isUser: boolean; outputStyle?: OutputStyle; fontSize?: number; isStreaming?: boolean; hasReasoning?: boolean; responseFormat?: string
}) {
  if (isStreaming && !text && !hasReasoning) {
    return <ThinkingIndicator />;
  }
  return <MessageContent text={text} messageId={messageId} isUser={isUser} outputStyle={outputStyle} fontSize={fontSize} isStreaming={isStreaming} responseFormat={responseFormat} />;
}

// ======================== 核心渲染组件 ========================

/** Message type — minimal, used by PromptBlock for push-to-video */
interface Message {
  role: string;
  content: string;
  name?: string;
}

/** Extract all structured prompts from message list (for push-to-video) */
function extractAllStructuredPrompts(messages: Message[]): string {
  const promptRegex = /(?:提示词|Prompt|prompt|【提示词】|🔑\s*提示词|文生视频[Pp]rompt|视频提示词|生图[Pp]rompt)[：:]\s*([\s\S]*?)(?=\n\n(?:#{1,3}\s|提示词|Prompt|prompt|【提示词】|🔑\s*提示词|文生视频[Pp]rompt|视频提示词|生图[Pp]rompt)|$)/gi;
  const results: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    let m;
    while ((m = promptRegex.exec(msg.content)) !== null) {
      const content = m[1].trim();
      if (content) results.push(content);
    }
  }
  return results.join('\n\n');
}

function getTextMetrics(text: string) {
  const plain = extractPureText(text)
    .replace(/\s+/g, ' ')
    .trim();
  const compact = plain.replace(/\s/g, '');
  const sentences = plain
    .split(/[。！？!?；;]\s*/)
    .map((s) => s.trim())
    .filter(Boolean).length;
  const nonEmptyLines = text.split('\n').filter((line) => line.trim()).length;
  const listLikeLines = text
    .split('\n')
    .filter((line) => /^\s*(?:[-*+]\s+|\d+[.)、]\s*|#{1,6}\s+)/.test(line)).length;
  const listRatio = nonEmptyLines > 0 ? listLikeLines / nonEmptyLines : 0;

  return {
    plain,
    charCount: compact.length,
    sentences,
    nonEmptyLines,
    listRatio,
  };
}

function StructuredOutputInspector({ result, onRetry }: { result: StructuredAgentOutputResult; onRetry: () => void }) {
  if (result.status !== "invalid") return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/35 bg-amber-500/8 px-3 py-2 text-xs text-amber-200">
      <span>{result.errors[0] || "结构解析失败，正文已保留"}</span>
      <button type="button" onClick={onRetry} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-amber-500/15">
        <RotateCw className="h-3.5 w-3.5" /> 重试解析
      </button>
    </div>
  );
}

function hasExplicitCopyContainer(text: string, responseFormat?: string) {
  if (responseFormat === 'text') return true;
  if (/^:::\s*(?:copy|text|work(?:[-_\s]?done)?|article|content|document|prompt|文案|话术)\b/im.test(text)) return true;
  if (/^```(?:text|txt|plain|plaintext|work(?:[-_]?done)?)\b/im.test(text)) return true;
  return false;
}

function isLikelyCopywriting(text: string, responseFormat?: string) {
  if (!text || hasExplicitCopyContainer(text, responseFormat)) return false;
  if (/```|<table|^\s*\|.+\|\s*$/m.test(text)) return false;

  const { plain, charCount, sentences, nonEmptyLines, listRatio } = getTextMetrics(text);
  if (charCount < 260 || sentences < 4 || listRatio > 0.45) return false;

  const cueMatches = plain.match(/钩子|痛点|故事|转折|互动|评论区|评论|关注|收藏|转发|私信|点赞|结尾|开头|标题|口播|爆款|文案|脚本/g) || [];
  const hasStoryShape = /你|我|他|她|我们|它/.test(plain) && /因为|但是|后来|结果|最后|所以|直到|突然|如果/.test(plain);
  const hasInteractiveEnding = /(你会|你觉得|评论区|留言|关注|收藏|转发|私信|点赞|你有没有|你是不是).{0,40}$/.test(plain);

  return (
    charCount >= 420 ||
    (charCount >= 320 && sentences >= 6) ||
    (charCount >= 260 && nonEmptyLines >= 3 && (cueMatches.length >= 2 || hasStoryShape || hasInteractiveEnding))
  );
}

function normalizeUserPastedText(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+(?=\d{1,2}[.、]\s*[【"“])/g, '\n')
    .replace(/[ \t]+(?=(?:单段视频时长|视频比例|视频风格|视频时长|画面比例)[：:])/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isStructuredUserText(text: string) {
  const normalized = normalizeUserPastedText(text);
  const compactLength = normalized.replace(/\s/g, '').length;
  const lines = normalized.split('\n').filter((line) => line.trim());
  const numberedLines = lines.filter((line) => /^\s*\d{1,2}[.、]\s*/.test(line)).length;
  const metaLines = lines.filter((line) => /^\s*(?:单段视频时长|视频比例|视频风格|视频时长|画面比例)[：:]/.test(line)).length;
  return compactLength >= 180 && (numberedLines >= 3 || metaLines >= 2 || lines.length >= 8);
}

function UserTextSegment({ text }: { text: string }) {
  const normalized = normalizeUserPastedText(text);
  const structured = isStructuredUserText(text);

  if (!structured) {
    return <span className="whitespace-pre-wrap break-words leading-[1.65]">{text}</span>;
  }

  const lines = normalized.split('\n');
  const numberedCount = lines.filter((line) => /^\s*\d{1,2}[.\u3001]\s*/.test(line)).length;
  const longLineCount = lines.filter((line) => line.trim().length >= 72).length;
  const dense = lines.length >= 8 || numberedCount >= 5 || longLineCount >= 2;
  const ultraDense = lines.length >= 16 || longLineCount >= 10 || normalized.replace(/\s/g, '').length >= 1200;

  return (
    <div className="user-pasted-copy-card w-full px-1 py-1 text-[var(--foreground)]">
      <div className={cn(
        "space-y-0",
        ultraDense ? "text-[14px] leading-[1.5]" : dense ? "text-[14.5px] leading-[1.56]" : "text-[15px] leading-[1.68]"
      )}>
        {lines.map((line, index) => {
          const trimmed = line.trim();
          if (!trimmed) return <div key={`gap-${index}`} className={dense ? "h-0.5" : "h-1"} />;

          const numberMatch = trimmed.match(/^(\d{1,2})[.\u3001]\s*(.*)$/);
          if (numberMatch) {
            return (
              <div key={`line-${index}`} className={cn("flex rounded-lg border-l border-[var(--primary)]/18", dense ? "gap-1.5 px-2 py-0.5" : "gap-2 px-2.5 py-1.5")}>
                <span className={cn("flex min-w-5 justify-center font-semibold text-[var(--primary)]/85", dense ? "mt-[1px] text-[11px]" : "mt-[2px] text-[12px]")}>
                  {numberMatch[1]}
                </span>
                <span className="min-w-0 flex-1 break-words text-[var(--foreground)]/90">{numberMatch[2]}</span>
              </div>
            );
          }

          if (/^(?:单段视频时长|视频比例|视频风格|视频时长|画面比例)[：:]/.test(trimmed)) {
            return (
              <div key={`meta-${index}`} className={cn("px-2.5 text-[13px] text-[var(--text-secondary)]", dense ? "py-0" : "py-0.5")}>
                {trimmed}
              </div>
            );
          }

          if (/^(?:分段文案|文案|原文|需求|备注)[：:]/.test(trimmed)) {
            return (
              <div key={`title-${index}`} className="pb-1 text-[13px] font-medium tracking-wide text-[var(--text-secondary)]">
                {trimmed}
              </div>
            );
          }

          return (
            <p key={`plain-${index}`} className="break-words text-[var(--foreground)]/86">
              {trimmed}
            </p>
          );
        })}
      </div>
    </div>
  );
}

/** Core message content renderer — dual-path streaming/non-streaming */
const MessageContent = React.memo(function MessageContent({ text, messageId, isUser, outputStyle, fontSize, isStreaming, responseFormat }: { text: string; messageId?: string; isUser: boolean; outputStyle?: OutputStyle; fontSize?: number; isStreaming?: boolean; responseFormat?: string }) {
  const fallbackStreamingRenderKey = React.useId();
  // messageId is timestamp-based for newly-created local messages, so combine
  // it with React's per-mount ID to remain unique across concurrent chats.
  const streamingRenderKey = `${messageId || "anonymous-message"}:${fallbackStreamingRenderKey}`;
  const streamingCaretId = `streaming-caret-${streamingRenderKey.replace(/[^a-z0-9_-]/giu, "-")}`;
  const prevStreamingRef = useRef(isStreaming);
  const containerRef = useRef<HTMLDivElement>(null);
  const [copywritingCopied, setCopywritingCopied] = useState(false);
  useEffect(() => {
    if (prevStreamingRef.current !== isStreaming) {
      prevStreamingRef.current = isStreaming;
    }
  }, [isStreaming]);
  useEffect(() => {
    if (!isStreaming) clearStreamingCache(streamingRenderKey);
  }, [isStreaming, streamingRenderKey]);
  useEffect(() => () => clearStreamingCache(streamingRenderKey), [streamingRenderKey]);

  let processedText = text;
  processedText = processedText.replace(/\r\n/g, '\n');
  processedText = processedText.replace(/\n{3,}/g, '\n\n');

  const isPlainText = responseFormat === 'text';
  const structuredResult = useMemo(() => {
    if (isUser || isStreaming) {
      return { status: "none", visible_text: processedText, errors: [] } as StructuredAgentOutputResult;
    }
    return parseStructuredAgentOutput(processedText, true);
  }, [isUser, isStreaming, processedText]);
  useEffect(() => {
    if (!messageId || isUser || isStreaming || structuredResult.status !== "valid") return;
    publishStructuredAgentOutputOnce(messageId, structuredResult);
  }, [isStreaming, isUser, messageId, structuredResult]);
  const combinedPattern = /\[img\]([^\[]+)\[\/img\]|!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|((?:https?:\/\/)[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp)(?:\?[^\s]*)?)/gi;

  let userContent: React.ReactNode = null;
  if (isUser) {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let keyIdx = 0;

    while ((match = combinedPattern.exec(processedText)) !== null) {
      const objKey = match[1];
      const mdUrl = match[3];
      const bareUrl = match[4];

      if (match.index > lastIndex) {
        parts.push(<UserTextSegment key={`text-${keyIdx++}`} text={processedText.slice(lastIndex, match.index)} />);
      }

      if (objKey) {
        parts.push(<ObjectStorageImage key={`objimg-${keyIdx++}`} storageKey={objKey} index={keyIdx - 1} />);
      } else {
        const url = mdUrl || bareUrl;
        parts.push(
          <a key={`img-${keyIdx++}`} href={url} target="_blank" rel="noopener noreferrer">
            <img src={url} alt="图片" className="max-w-[280px] max-h-[280px] rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-80 transition-opacity object-cover my-1" loading="lazy" />
          </a>
        );
      }
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < processedText.length) {
      parts.push(<UserTextSegment key={`text-${keyIdx++}`} text={processedText.slice(lastIndex)} />);
    }

    userContent = (
      <div className="user-message-content break-words text-[var(--foreground)]">
        {parts.length > 0 ? <>{parts}</> : <UserTextSegment text={processedText} />}
      </div>
    );
  }

  // Non-streaming: extract images and process prompt blocks
  const imageUrls: string[] = [];
  const objKeys: string[] = [];
  let textWithoutImages = structuredResult.status === "valid" ? structuredResult.visible_text : processedText;

  if (!isStreaming) {
    textWithoutImages = textWithoutImages.replace(/\[img\]([^\[]+)\[\/img\]/gi, (_m, key: string) => {
      objKeys.push(key);
      return '';
    });
    textWithoutImages = textWithoutImages.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi, (_m, _alt: string, url: string) => {
      imageUrls.push(url);
      return '';
    });
    textWithoutImages = textWithoutImages.replace(/((?:https?:\/\/)[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp)(?:\?[^\s]*)?)/gi, (_m, url: string) => {
      imageUrls.push(url);
      return '';
    });
    textWithoutImages = textWithoutImages.replace(/\n{3,}/g, '\n\n').trim();

    // 普通“提示词/文案”标题保持正文展示；只有模型明确输出 ``` 才渲染为代码框。
    textWithoutImages = textWithoutImages.replace(/\n{3,}/g, '\n\n').trim();
  }

  // Build dynamic styles from outputStyle + fontSize
  const os = (outputStyle ?? {}) as OutputStyle;
  const containerStyle: React.CSSProperties = {};
  const effectiveFontSize = fontSize || os.fontSize;
  if (effectiveFontSize && effectiveFontSize !== 16) containerStyle.fontSize = `${effectiveFontSize}px`;
  if (os.lineHeight && os.lineHeight !== 1.5) containerStyle.lineHeight = os.lineHeight;
  if (os.fontFamily && os.fontFamily !== 'system') {
    const fontFamilyMap: Record<string, string> = {
      system: 'system-ui, -apple-system, sans-serif',
      serif: '"Songti SC", "SimSun", "STSong", serif',
      sans: '"PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif',
      mono: '"SF Mono", "Fira Code", "Consolas", monospace',
    };
    containerStyle.fontFamily = fontFamilyMap[os.fontFamily] || fontFamilyMap.system;
  }
  if (os.textAlign && os.textAlign !== 'left') containerStyle.textAlign = os.textAlign;

  const tagPatterns = (os.tags && os.tags.length > 0) ? os.tags : [];

  const finalHtml = useMemo(() => {
    if (isStreaming) return '';
    try {
      if (isPlainText && textWithoutImages) {
        return renderTextWithCodeBlocks(textWithoutImages);
      }
      return renderMarkdown(textWithoutImages);
    } catch (e) {
      // 降级：直接显示原始文本
      return `<p>${(textWithoutImages || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</p>`;
    }
  }, [isStreaming, textWithoutImages, isPlainText]);

  const shouldShowCopywritingCopy = !isUser && !isStreaming && isLikelyCopywriting(textWithoutImages, responseFormat);

  const handleCopyCopywriting = async () => {
    const cleanText = extractPureText(textWithoutImages).trim();
    if (!cleanText) return;
    const ok = await copyToClipboard(cleanText);
    if (ok) {
      setCopywritingCopied(true);
      toast.success("文案已复制");
      setTimeout(() => setCopywritingCopied(false), 2000);
    } else {
      toast.error("复制失败，请手动复制");
    }
  };

  // 🔒 防御：流式渲染可能因边界情况（空文本、异常内容等）抛出异常，
  // 用 try-catch 包裹防止整个消息崩溃
  // 仅在流式期间计算 streamingHtml。每条消息使用独立 key，避免并行
  // 会话/消息共享增量状态并相互污染。
  let streamingHtml = '';
  if (isStreaming) {
    try {
      // 统一走增量渲染器：文本段按成品 markdown 渲染（与最终 DOM 结构一致），
      // 未闭合代码块/文档块用骨架占位，闭合代码块走缓存。
      // 配合下方 morphdom 原地更新，稳定节点不再每帧重建，消除闪屏。
      streamingHtml = appendStreamingCaret(
        renderStreamingText(processedText, streamingRenderKey),
        streamingCaretId,
      );
    } catch (e) {
      // 降级：渲染异常时保留可读文本。
      streamingHtml = appendStreamingCaret(
        `<p>${processedText.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</p>`,
        streamingCaretId,
      );
    }
  }

  // 🚀 morphdom-based streaming DOM update — eliminates flicker by morphing DOM in-place
  // instead of full innerHTML replacement. Preserves existing nodes (code blocks, tables, etc.)
  const streamingLayerRef = useRef<HTMLDivElement>(null);
  const prevMorphHtmlRef = useRef('');
  const pendingMorphHtmlRef = useRef('');
  const morphTimerRef = useRef<number | null>(null);
  const lastMorphAtRef = useRef(0);

  // 🚀 morphdom streaming update: morph DOM in-place instead of full innerHTML replacement
  // 使用 useLayoutEffect 而非 useEffect：useLayoutEffect 在 React commit 后、浏览器绘制前
  // 同步执行，消除了 useEffect 异步执行导致的「旧内容闪一帧再更新」的双重绘制问题。
  // 覆盖全部流式内容（普通 markdown + 代码块）：任何全量 innerHTML 替换都会让
  // :last-child 淡入动画每帧重启，这就是文字闪屏的根因。
  useLayoutEffect(() => {
    if (!isStreaming || !streamingLayerRef.current) return;
    pendingMorphHtmlRef.current = streamingHtml;
    if (prevMorphHtmlRef.current === streamingHtml) return;

    const applyLatestMorph = () => {
      morphTimerRef.current = null;
      const layer = streamingLayerRef.current;
      const latestHtml = pendingMorphHtmlRef.current;
      if (!layer || prevMorphHtmlRef.current === latestHtml) return;

      morphdom(layer, `<div class="render-layer-streaming">${latestHtml}</div>`, {
        childrenOnly: true,
        // 不使用 onBeforeElUpdated + isEqualNode：isEqualNode 会对每个元素做深度递归比较，
        // 在表格/代码块等大节点上开销极大，反而导致渲染延迟和闪屏。
        // morphdom 自身的 diff 算法已经是高效的，让它自行决策即可。
      });
      prevMorphHtmlRef.current = latestHtml;
      lastMorphAtRef.current = window.performance.now();
    };

    const elapsed = window.performance.now() - lastMorphAtRef.current;
    const remaining = STREAM_MORPH_INTERVAL_MS - elapsed;
    if (lastMorphAtRef.current === 0 || remaining <= 0) {
      applyLatestMorph();
    } else if (morphTimerRef.current === null) {
      morphTimerRef.current = window.setTimeout(applyLatestMorph, remaining);
    }
  }, [streamingHtml, isStreaming]);

  // Reset morph state when the stream ends so a retry/next stream starts fresh.
  // The pending ref always holds the newest frame, so throttling cannot drop the
  // final update while the stream is active.
  useEffect(() => {
    if (!isStreaming) {
      if (morphTimerRef.current !== null) {
        window.clearTimeout(morphTimerRef.current);
        morphTimerRef.current = null;
      }
      prevMorphHtmlRef.current = '';
      pendingMorphHtmlRef.current = '';
      lastMorphAtRef.current = 0;
    }
    return () => {
      if (morphTimerRef.current !== null) {
        window.clearTimeout(morphTimerRef.current);
        morphTimerRef.current = null;
      }
    };
  }, [isStreaming]);

  if (userContent) return userContent;

  return (
    <div
      ref={containerRef}
      className={cn(
        "markdown-body text-[var(--foreground)]",
        isStreaming && "markdown-body-generate streaming-typewriter-content",
        !isStreaming && os.firstLineIndent && 'output-indent',
      )}
      style={Object.keys(containerStyle).length > 0 ? containerStyle : undefined}
    >
      {!isStreaming ? (
        <div key="final-content" className={cn("copywriting-output-shell", shouldShowCopywritingCopy && "copywriting-output-shell-copyable")}>
          {shouldShowCopywritingCopy && (
            <button
              type="button"
              onClick={handleCopyCopywriting}
              className={cn("copywriting-output-copy-btn", copywritingCopied && "copied")}
              title="复制整篇文案"
            >
              {copywritingCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copywritingCopied ? "已复制" : "复制文案"}</span>
            </button>
          )}
          <div
            className="render-layer-final"
            dangerouslySetInnerHTML={{ __html: finalHtml }}
          />
          <StructuredOutputInspector
            result={structuredResult}
            onRetry={() => {
              const retried = parseStructuredAgentOutput(processedText, true);
              if (retried.status === "valid") toast.success("结构解析成功");
              else toast.error(retried.status === "invalid" ? retried.errors[0] : "未检测到稳定机器包");
            }}
          />
        </div>
      ) : (
        <div
          key="streaming-content"
          ref={streamingLayerRef}
          className="render-layer-streaming render-layer-streaming-typewriter"
        />
      )}
      {!isStreaming && tagPatterns.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {tagPatterns.map((tag, i) => (
            <span key={`tag-${i}`} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold" style={{ backgroundColor: `${tag.color}22`, color: tag.color, border: `1px solid ${tag.color}44` }}>
              {tag.text}
            </span>
          ))}
        </div>
      )}
      {!isStreaming && (imageUrls.length > 0 || objKeys.length > 0) && (
        <div className="flex flex-wrap gap-2 mt-1">
          {objKeys.map((key, i) => (
            <ObjectStorageImage key={`objimg-${i}`} storageKey={key} index={i} />
          ))}
          {imageUrls.map((url, i) => (
            <a key={`img-${i}`} href={url} target="_blank" rel="noopener noreferrer">
              <img src={url} alt="图片" className="max-w-[280px] max-h-[280px] rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-80 transition-opacity object-cover" loading="lazy" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
});

export { MessageContent, StreamingContentWrapper, CodeBlockWithCopy, TableWithCopy, extractAllStructuredPrompts };
export type { Message };
