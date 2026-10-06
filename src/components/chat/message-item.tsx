"use client";

import React, { useState, useEffect } from "react";
import { AlertCircle, Check, CheckCircle2, Copy, Film, Loader2, Volume2, VolumeX, Trash2, RotateCw, Palette, Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { copyToClipboard, resolveAgentAvatarUrl } from "@/lib/utils";
import { reportProblem } from "@/lib/diagnostic-sentry";
import { ReasoningBlock } from "@/components/chat/reasoning-block";
import { StreamingContentWrapper, extractAllStructuredPrompts } from "@/components/chat/message-content";
import { ImageGallery, type GeneratedImage } from "@/components/chat/image-gallery";
import type { OutputStyle } from "@/types/coze";
import {
  dispatchVideoTaskTransfer,
  extractVideoPromptItemsFromMarkdown,
  makeVideoTaskTransferPayload,
} from "@/lib/video-task-transfer";
import { parseStructuredAgentOutput } from "@/lib/structured-agent-output";
import { bipStep } from "@/lib/business-ip/catalog";
import { businessIpMemberVisibleText } from "@/lib/business-ip/business-profile";

/**
 * message-item.tsx — 消息气泡 + 操作按钮
 * 从 chat-view.tsx 提取，负责单条消息的完整渲染和交互
 */

// ======================== 类型定义 ========================

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  displayContent?: string;
  agentId?: string;
  agentName?: string;
  agentIconUrl?: string;
  reasoningContent?: string;
  isStreaming?: boolean;
  streamStatus?: string;
  images?: string[];
  generatedImages?: GeneratedImage[]; // 生图模型输出
  error?: string; // 发送失败时的错误信息
}

// ======================== 辅助函数 ========================

/** 提取纯文本内容（去掉 markdown 语法） */
function extractPureText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/!\[([^\]]*)\]\([^\)]+\)/g, '')
    .replace(/\[([^\]]*)\]\([^\)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** 根据智能体名称推断协同指令 */
export function inferAgentInstruction(agentName: string): string {
  const name = agentName.toLowerCase();
  if (name.includes('质检') || name.includes('审核') || name.includes('检查') || name.includes('校对')) return '请对以上文案进行质量检查，指出问题并给出改进建议';
  if (name.includes('选题') || name.includes('策划') || name.includes('规划')) return '请基于以上内容进行选题策划';
  if (name.includes('优化') || name.includes('改写') || name.includes('润色') || name.includes('精修') || name.includes('修改')) return '请优化改写以上内容';
  if (name.includes('裂变') || name.includes('扩展') || name.includes('衍生') || name.includes('延伸')) return '请基于以上内容进行裂变扩展创作';
  if (name.includes('翻译') || name.includes('translate')) return '请将以上内容翻译为对应语言';
  if (name.includes('摘要') || name.includes('总结') || name.includes('提炼')) return '请对以上内容进行总结提炼';
  if (name.includes('视频') || name.includes('脚本') || name.includes('分镜')) return '请基于以上内容创作视频脚本';
  if (name.includes('标题') || name.includes('headline')) return '请为以上内容生成吸引人的标题';
  if (name.includes('排版') || name.includes('格式')) return '请对以上内容进行排版优化';
  if (name.includes('匹配') || name.includes('推荐')) return '请基于以上内容进行智能匹配推荐';
  if (name.includes('架构') || name.includes('设计') || name.includes('工程师')) return '请基于以上内容进行架构设计';
  if (name.includes('钩子') || name.includes('开头') || name.includes('hook')) return '请为以上内容设计吸引人的3秒钩子';
  return '请执行你的专业任务';
}

// ======================== ObjectStorageImage (also used by MessageBubble) ========================

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
      <img src={src} alt={`图片 ${index + 1}`} className="max-w-[280px] max-h-[280px] rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-80 transition-opacity object-cover my-1" loading="lazy" />
    </a>
  );
}

const SAFE_INLINE_CHAT_IMAGE = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;
const MAX_INLINE_CHAT_IMAGE_CHARS = 12 * 1024 * 1024;

function MessageImage({ value, index }: { value: string; index: number }) {
  if (SAFE_INLINE_CHAT_IMAGE.test(value) && value.length <= MAX_INLINE_CHAT_IMAGE_CHARS) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={value} alt={`图片 ${index + 1}`} className="max-w-[280px] max-h-[280px] rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-80 transition-opacity object-cover my-1" loading="lazy" />
      </a>
    );
  }
  return <ObjectStorageImage storageKey={value} index={index} />;
}

// ======================== MessageBubble ========================

const MessageBubble = React.memo(function MessageBubble({ message, allMessages, onRetry, onContinue, onDelete, onEdit, fontSize, outputStyle, onStyleChange, onSaveStyleAsTemplate, responseFormat, primaryAgentId }: { message: ChatMessage; allMessages?: ChatMessage[]; onRetry?: () => void; onContinue?: () => void; onDelete?: () => void; onEdit?: (content: string) => void; fontSize?: number; outputStyle?: OutputStyle; onStyleChange?: (style: OutputStyle) => void; onSaveStyleAsTemplate?: () => void; responseFormat?: string; primaryAgentId?: string }) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [showFormatBar, setShowFormatBar] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isFailed = (message.content?.startsWith("发送失败：") || !!message.error) ?? false;
  const isLongUserPaste = isUser && (message.content || "").replace(/\s/g, "").length >= 180;
  const rawVisibleText = message.displayContent ?? message.content ?? "";
  const visibleText = !isUser && bipStep(message.agentId || primaryAgentId)
    ? businessIpMemberVisibleText(rawVisibleText)
    : rawVisibleText;
  const failureDetail = `${visibleText}\n${message.error || ""}`;
  const isOutcomeUnknown = /(?:最终结果|结果|终态).{0,12}(?:暂未确认|不明)|避免重复发送|禁止重复提交|RECONCILIATION_REQUIRED|RESULT_UNKNOWN/iu.test(failureDetail);
  const canRetrySafely = Boolean(onRetry && !isOutcomeUnknown);
  const hasVisibleText = Boolean(visibleText.trim());
  const hasVisibleOutput = Boolean(hasVisibleText || message.images?.length || message.generatedImages?.length);
  const handleCopy = async () => {
    const ok = await copyToClipboard(extractPureText(visibleText));
    if (ok) {
      setCopied(true);
      toast.success("已复制");
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("复制失败，请手动复制");
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      let raw = visibleText;
      raw = raw.replace(/^:::[\w\u4e00-\u9fff]+(?:\s+.*)?\s*$/gm, '');
      raw = raw.replace(/^:::\s*$/gm, '');
      raw = raw.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');
      raw = raw.replace(/\n{3,}/g, '\n\n').trim();
      const ok = await copyToClipboard(raw);
      if (ok) {
        setCopied(true);
        toast.success("已复制 Markdown 源码");
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error("复制失败");
      }
    } catch {
      toast.error("复制失败");
    }
  };

  const handleReadAloud = () => {
    if (!window.speechSynthesis) {
      toast.error("当前浏览器不支持语音朗读");
      return;
    }
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const plainText = visibleText
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]*)\]\(.*?\)/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[#*_~>|`-]/g, '')
      .replace(/\n{2,}/g, '。')
      .replace(/\n/g, '，')
      .trim();
    if (!plainText) return;
    const utterance = new SpeechSynthesisUtterance(plainText);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  };

  useEffect(() => {
    return () => {
      if (isSpeaking) window.speechSynthesis.cancel();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [localStyle, setLocalStyle] = useState<OutputStyle>(outputStyle ?? {});
  useEffect(() => { setLocalStyle(outputStyle ?? {}); }, [outputStyle]);

  const updateStyle = (patch: Partial<OutputStyle>) => {
    const next = { ...localStyle, ...patch };
    setLocalStyle(next);
    onStyleChange?.(next);
  };

  return (
    <article
      className={cn(
      "chat-message-row flex w-full flex-col px-1 py-2 msg-animate group/message",
      isUser ? "chat-message-row-user" : "chat-message-row-assistant",
      isUser && (isLongUserPaste ? "items-end pl-6 md:pl-12" : "items-end pl-28"),
      )}
      data-message-role={isUser ? "user" : "assistant"}
      aria-label={isUser ? "你的消息" : `${message.agentName || "智能体"}的回复`}
    >
      {!isUser && (
        <div className="chat-message-identity chat-message-identity-assistant" data-testid="chat-message-role-label">
          <Avatar className="chat-message-identity-avatar">
            <AvatarImage
              src={resolveAgentAvatarUrl(message.agentId || primaryAgentId, message.agentName, message.agentIconUrl)}
              alt=""
            />
            <AvatarFallback className="bg-[var(--chat-sheet-strong)] text-[9px] text-[var(--chat-text)]">
              {(message.agentName || "AI").slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          <span>{message.agentName || "智能体"}</span>
        </div>
      )}

      <div className={cn(
        "chat-message-bubble relative break-words",
        isUser
          ? cn("chat-message-bubble-user text-[var(--foreground)] text-[15px] leading-normal", isLongUserPaste ? "w-full max-w-[1120px]" : "max-w-[85%]")
          : isFailed
            ? "chat-message-bubble-assistant chat-message-bubble-failed text-[var(--foreground)] w-full"
            : cn(
              "chat-message-bubble-assistant text-[var(--foreground)] w-full",
              message.isStreaming && "chat-message-bubble-streaming"
            )
      )}>
        {!isUser && (
          <div
            className={cn(
              "mb-1.5 inline-flex items-center gap-1.5 text-[11px] leading-none",
              message.isStreaming
                ? "text-[var(--primary)]"
                : isFailed
                  ? "text-red-500"
                  : "text-[var(--text-secondary)]",
            )}
            role="status"
            aria-live={message.isStreaming ? "polite" : "off"}
            data-testid="chat-output-status"
            data-state={message.isStreaming ? "streaming" : isOutcomeUnknown ? "unknown" : isFailed ? "failed" : hasVisibleOutput ? "completed" : "empty"}
          >
            {message.isStreaming ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{message.streamStatus || "正在生成"}</>
            ) : isOutcomeUnknown ? (
              <><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />结果待确认</>
            ) : isFailed ? (
              <><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />生成失败{canRetrySafely ? "，可重新生成" : ""}</>
            ) : hasVisibleOutput ? (
              <><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />已完成</>
            ) : (
              <>等待输出</>
            )}
          </div>
        )}
        {message.reasoningContent && (
          <ReasoningBlock content={message.reasoningContent} isThinking={!!message.isStreaming && !message.content} defaultCollapsed={true} />
        )}

        <StreamingContentWrapper text={visibleText} messageId={message.id} isUser={isUser} outputStyle={showFormatBar ? localStyle : outputStyle} fontSize={fontSize} isStreaming={message.isStreaming} hasReasoning={!!message.reasoningContent} responseFormat={responseFormat} />

        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {message.images.map((imgKey, i) => (
              <MessageImage key={`msgimg-${i}`} value={imgKey} index={i} />
            ))}
          </div>
        )}

        {/* 生图模型输出画廊 */}
        {message.generatedImages && message.generatedImages.length > 0 && (
          <ImageGallery
            images={message.generatedImages}
            prompt={visibleText}
            isGenerating={!!message.isStreaming && message.generatedImages.length === 0}
          />
        )}
      </div>

      {!isUser && isFailed && (
        <div
          className={cn("chat-message-state", isOutcomeUnknown && "chat-message-state-unknown")}
          role="alert"
          data-testid="chat-message-status"
          data-state={isOutcomeUnknown ? "unknown" : "network-error"}
        >
          <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="chat-message-state-copy">
            <strong>{isOutcomeUnknown ? "结果待确认，请勿重复发送" : "本次回复未完成"}</strong>
            <span>{isOutcomeUnknown ? "原请求已经保留，刷新后查看最新记录。" : "已保留现有内容，你可以手动重新生成。"}</span>
          </div>
          {isOutcomeUnknown ? (
            <button type="button" className="chat-message-state-action" onClick={() => window.location.reload()}>
              刷新状态
            </button>
          ) : canRetrySafely ? (
            <button type="button" className="chat-message-state-action" onClick={onRetry}>
              重新生成
            </button>
          ) : null}
        </div>
      )}

      {/* 用户消息发送失败提示 + 重试按钮 */}
      {isUser && message.error && (
        <div
          className={cn("chat-message-state", isOutcomeUnknown && "chat-message-state-unknown")}
          role="alert"
          data-testid="chat-message-status"
          data-state={isOutcomeUnknown ? "unknown" : "network-error"}
        >
          <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="chat-message-state-copy">
            <strong>{isOutcomeUnknown ? "结果待确认，请勿重复发送" : "消息未发送"}</strong>
            <span>{message.error}</span>
          </div>
          {isOutcomeUnknown ? (
            <button type="button" className="chat-message-state-action" onClick={() => window.location.reload()}>
              刷新状态
            </button>
          ) : canRetrySafely ? (
            <button type="button" className="chat-message-state-action" onClick={onRetry}>
              重新发送
            </button>
          ) : null}
        </div>
      )}

      {/* AI message action bar */}
      {!isUser && !message.isStreaming && hasVisibleText && (
        <div className="chat-message-actions chat-message-actions-assistant flex items-center gap-1 mt-2 ml-0.5 flex-wrap">
          <button onClick={handleCopyMarkdown} className={cn("chat-message-action p-1 rounded-md transition-colors", copied ? "text-green-500 bg-green-500/10" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]")} title={copied ? "已复制 Markdown 源码" : "复制 Markdown 源码"} aria-label={copied ? "已复制 Markdown 源码" : "复制 Markdown 源码"}>
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button onClick={handleReadAloud} className={cn("chat-message-action p-1 rounded-md transition-colors", isSpeaking ? "text-[var(--primary)] bg-[var(--primary)]/10" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]")} title={isSpeaking ? "停止朗读" : "朗读"} aria-label={isSpeaking ? "停止朗读" : "朗读回复"}>
            {isSpeaking ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => { onDelete?.(); }} className="chat-message-action p-1 rounded-md text-[var(--muted-foreground)] hover:text-red-500 hover:bg-red-500/10 transition-colors" title="删除" aria-label="删除回复">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {(onRetry || onContinue) && !isFailed && (
            <button
              onClick={onContinue || onRetry}
              className="chat-message-action p-1 rounded-md transition-colors text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]"
              title={onContinue ? "继续回复" : "重新生成"}
              aria-label={onContinue ? "继续回复" : "重新生成"}
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="w-px h-3.5 bg-[var(--border)] mx-0.5" />
          <button onClick={() => setShowFormatBar(!showFormatBar)} className={cn("chat-message-action p-1 rounded-md transition-colors", showFormatBar ? "text-[var(--primary)] bg-[var(--primary)]/10" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]")} title="格式调节" aria-label="调节回复格式">
            <Palette className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => {
            try {
              const msgs = allMessages || [message];
              const structured = parseStructuredAgentOutput(message.content || "", true);
              if (structured.status === "valid" && structured.segments.length > 0) {
                const dispatched = dispatchVideoTaskTransfer(makeVideoTaskTransferPayload(
                  structured.segments.map((segment, index) => ({
                    order: index + 1,
                    prompt: segment.video_prompt,
                    label: segment.segment_id,
                    title: segment.narration,
                    source: "chat-message",
                  })),
                  "batch",
                ));
                if (!dispatched) { toast.error("临时交接失败，请手动复制提示词"); return; }
                toast.success(`已按稳定协议发送 ${structured.segments.length} 条视频提示词`);
                window.location.assign("/video");
                return;
              }
              const currentPromptItems = extractVideoPromptItemsFromMarkdown(message.content || "");
              const promptItems = currentPromptItems.length > 0 ? currentPromptItems : msgs
                .filter(m => m.role === "assistant" && m.content)
                .flatMap(m => extractVideoPromptItemsFromMarkdown(m.content));
              if (promptItems.length > 0) {
                const dispatched = dispatchVideoTaskTransfer(makeVideoTaskTransferPayload(promptItems, "batch"));
                if (!dispatched) { toast.error("临时交接失败，请手动复制提示词"); return; }
                toast.success(`已按顺序发送 ${promptItems.length} 条提示词到视频任务卡片`);
                window.location.assign("/video");
                return;
              }

              const allPrompts = extractAllStructuredPrompts(msgs);
              let fallbackPrompt = allPrompts.trim();
              if (!fallbackPrompt) {
                const fallbackText = msgs.filter(m => m.role === "assistant" && m.content).map(m => {
                  let c = m.content.trim();
                  c = c.replace(/<(?:think|thinking)[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, "");
                  c = c.replace(/^#{1,4}\s*思考[^\n]*\n(?:[^\n#]*\n)*?(?=^#{1,4}\s|\z|```)/gm, "");
                  c = c.replace(/^reasoning_content:\s*[\s\S]*?(?=\ncontent:|$)/im, "");
                  return c.trim();
                }).filter(c => c.length > 10).join("\n\n");
                if (!fallbackText.trim()) { toast.error("未检测到视频提示词内容"); return; }
                fallbackPrompt = fallbackText.trim();
              }
              const dispatched = dispatchVideoTaskTransfer(makeVideoTaskTransferPayload([{
                order: 1,
                prompt: fallbackPrompt,
                label: "任务1",
                title: "来自智能体对话",
                source: "chat-message",
              }], "single"));
              if (!dispatched) { toast.error("临时交接失败，请手动复制提示词"); return; }
              toast.success("已推送至视频平台，请在智能导入面板中确认");
              window.location.assign("/video");
            } catch { toast.error("推送失败，请手动复制提示词"); }
          }} className="chat-message-action p-1 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors" title="推送至视频" aria-label="推送回复至视频平台">
            <Film className="w-3.5 h-3.5" />
          </button>
          {isFailed && (
            <button onClick={() => { reportProblem((message.content || "").substring(0, 200), { agent_name: message.agentName }); toast.success("已反馈，管理员将尽快处理"); }} className="chat-message-action px-2 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors ml-1" aria-label="反馈本次回复问题">
              反馈此问题
            </button>
          )}
        </div>
      )}

      {/* Format toolbar */}
      {!isUser && showFormatBar && !message.isStreaming && message.content && (
        <div className="mt-1 ml-1 p-2 rounded-lg border border-[var(--border)] bg-[var(--card)]/80 backdrop-blur-sm space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">行高</span>
              <select value={localStyle.lineHeight ?? 1.8} onChange={e => updateStyle({ lineHeight: parseFloat(e.target.value) })} className="h-5 px-1 rounded text-[10px] bg-[var(--muted)] border-none">
                <option value={1.4}>1.4</option><option value={1.6}>1.6</option><option value={1.8}>1.8</option><option value={2.0}>2.0</option><option value={2.2}>2.2</option><option value={2.4}>2.4</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">字体</span>
              <select value={localStyle.fontFamily ?? 'system'} onChange={e => updateStyle({ fontFamily: e.target.value as 'system' | 'serif' | 'monospace' })} className="h-5 px-1 rounded text-[10px] bg-[var(--muted)] border-none">
                <option value="system">系统</option><option value="serif">宋体</option><option value="monospace">等宽</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">段距</span>
              <select value={localStyle.paragraphSpacing ?? 16} onChange={e => updateStyle({ paragraphSpacing: parseInt(e.target.value) })} className="h-5 px-1 rounded text-[10px] bg-[var(--muted)] border-none">
                <option value={8}>8px</option><option value={12}>12px</option><option value={16}>16px</option><option value={20}>20px</option><option value={24}>24px</option><option value={32}>32px</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">缩进</span>
              <button onClick={() => updateStyle({ firstLineIndent: !localStyle.firstLineIndent })} className={cn("w-5 h-5 rounded flex items-center justify-center text-[10px] transition-colors", localStyle.firstLineIndent ? "bg-[var(--primary)]/20 text-[var(--primary)]" : "bg-[var(--muted)]")}>
                {localStyle.firstLineIndent ? "✓" : "—"}
              </button>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">分割线</span>
              <select value={localStyle.dividerStyle ?? 'none'} onChange={e => updateStyle({ dividerStyle: e.target.value as 'none' | 'solid' | 'dashed' | 'dotted' })} className="h-5 px-1 rounded text-[10px] bg-[var(--muted)] border-none">
                <option value="none">无</option><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">对齐</span>
              <select value={localStyle.textAlign ?? 'left'} onChange={e => updateStyle({ textAlign: e.target.value as 'left' | 'center' | 'justify' })} className="h-5 px-1 rounded text-[10px] bg-[var(--muted)] border-none">
                <option value="left">左</option><option value="center">中</option><option value="justify">两端</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">标题色</span>
              <input type="color" value={localStyle.headingColor ?? '#165DFF'} onChange={e => updateStyle({ headingColor: e.target.value })} className="w-5 h-5 rounded cursor-pointer border-0" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-secondary)]">标签</span>
              {(localStyle.tags ?? []).map((tag, i) => (
                <span key={i} className="px-1.5 py-0 rounded text-[9px] text-white cursor-pointer hover:opacity-80" style={{ backgroundColor: tag.color || 'var(--primary)' }} onClick={() => { const newTags = [...(localStyle.tags ?? [])]; newTags.splice(i, 1); updateStyle({ tags: newTags }); }} title="点击移除">
                  {tag.text}
                </span>
              ))}
              <button onClick={() => { const text = prompt('标签文字'); if (text?.trim()) { updateStyle({ tags: [...(localStyle.tags ?? []), { text: text.trim(), color: '#165DFF' }] }); } }} className="w-5 h-5 rounded flex items-center justify-center bg-[var(--primary)]/15 text-[var(--primary)] text-[12px] hover:bg-[var(--primary)]/25" title="添加标签">+</button>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-[var(--border)]">
            <button onClick={() => { onSaveStyleAsTemplate?.(); setShowFormatBar(false); toast.success('已保存为该智能体的默认样式'); }} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--primary)] text-white hover:opacity-90 transition-opacity">
              <Save className="w-3 h-3" /> 存为模板
            </button>
            <button onClick={() => { setLocalStyle({}); onStyleChange?.({}); toast.success('已重置为默认样式'); }} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors">
              <RotateCw className="w-3 h-3" /> 重置
            </button>
            <button onClick={() => setShowFormatBar(false)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-[var(--muted-foreground)] hover:text-[var(--primary)] transition-colors ml-auto">
              收起
            </button>
          </div>
        </div>
      )}

      {/* User message action bar */}
      {isUser && message.content && (
        <div className="chat-message-actions chat-message-actions-user flex items-center gap-0.5 mt-1 mr-1">
          <button onClick={handleCopy} className="chat-message-action p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors" title={copied ? "已复制" : "复制"} aria-label={copied ? "已复制" : "复制你的消息"}>
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </button>
          <button onClick={() => { onDelete?.(); }} className="chat-message-action p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-red-500 hover:bg-red-500/10 transition-colors" title="删除" aria-label="删除你的消息">
            <Trash2 className="w-4 h-4" />
          </button>
          <button onClick={() => { onEdit?.(message.content); }} className="chat-message-action p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--primary)] hover:bg-[var(--primary)]/10 transition-colors" title="改写" aria-label="改写你的消息">
            <Pencil className="w-4 h-4" />
          </button>
        </div>
      )}
    </article>
  );
});

export { MessageBubble };
export type { ChatMessage };
