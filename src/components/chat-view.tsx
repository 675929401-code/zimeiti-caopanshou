"use client";

/**
 * 🔒 核心底层代码 — 锁定保护
 *
 * 本文件是聊天界面核心组件，包含流式/非流式渲染切换 + PromptBlock + 智能滚动。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #9 格式输出层"。
 *
 * 锁定范围：整个文件
 * 锁定原因：渲染输出是用户体验核心，对标 AIWeb 的 md-editor-v3 innerHTML 直渲
 *
 * 关键组件/逻辑：
 * - MessageContent：流式/非流式双阶段渲染
 * - StreamingContentWrapper：流式期间轻量渲染
 * - PromptBlock：提示词折叠组件
 * - 智能自动滚动（isUserScrollingRef）
 */

import { useApp } from "@/contexts/app-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { resolveAgentAvatarUrl } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { Bot, Copy, Check, RotateCw, Sparkles, Search, Maximize2, Minimize2, ChevronDown, ChevronUp, ChevronRight, ClipboardCopy, Home, Film, X, ImagePlus, Palette, Save, Type, AlignLeft, AlignCenter, AlignJustify, Minus, Tag, Loader2, CheckCircle2, Volume2, VolumeX, Trash2, Pencil, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { cn, extractPureText, copyToClipboard } from "@/lib/utils";
import { reportProblem } from "@/lib/diagnostic-sentry";

// Extracted sub-components
import { MessageContent, StreamingContentWrapper } from "./chat/message-content";
import { ReasoningBlock } from "./chat/reasoning-block";
import { MessageBubble, inferAgentInstruction } from "./chat/message-item";
import { ChatErrorBoundary } from "./chat/chat-error-boundary";
import { extractAllStructuredPrompts } from "./chat/message-content";
import { NavButton } from "@/components/sub-page-header";
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Message } from "@/types/coze";
import { fuzzyMatch } from "@/lib/pinyin";
import {
  dispatchVideoTaskTransfer,
  inferVideoTaskOrder,
  isLikelyVideoPrompt,
  makeVideoTaskTransferPayload,
  sanitizeVideoPrompt,
  type VideoTaskTransferItem,
} from "@/lib/video-task-transfer";
import { appendImageWorkbenchPromptTransfer } from "@/lib/image-workbench-transfer";
import { FREE_CHAT_AGENT_ID } from "@/lib/virtual-agent-policy";
import { FREE_CHAT_DEEP_THINKING_TYPE, shouldAutoEnableWebSearch } from "@/lib/free-chat-runtime-policy";
import { bipStep } from "@/lib/business-ip/catalog";
import { BusinessIpFlow } from "@/components/chat/business-ip-flow";

const VIDEO_TASK_ORDER_CONTEXT_RE = /(?:\u65b9\u6848|\u5206\u6bb5|\u6bb5\u843d|\u56fe\u7247|\u56fe\u50cf|\u4efb\u52a1|\u5361\u7247|\u7b2c|\u955c\u5934|\u5206\u955c|task|part|segment|section|scene|shot)\s*[\[\u3010\uff08(]?\s*(?:\d{1,2}|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])/i;
const CHAT_SCROLL_LATEST_THRESHOLD_PX = 80;
const CHAT_OUTCOME_UNKNOWN_RE = /(?:最终结果|结果|终态).{0,12}(?:暂未确认|不明)|避免重复发送|禁止重复提交|RECONCILIATION_REQUIRED|RESULT_UNKNOWN/iu;

function isChatOutcomeUnknown(message: Pick<Message, "content" | "error">): boolean {
  return CHAT_OUTCOME_UNKNOWN_RE.test(`${message.content || ""}\n${message.error || ""}`);
}

function findNearestVideoTaskOrderContext(text: string): string {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => sanitizeVideoPrompt(line))
    .filter(Boolean)
    .reverse();
  return lines.find((line) => VIDEO_TASK_ORDER_CONTEXT_RE.test(line)) || (text || "").slice(-220);
}

export function ChatView() {
  const { state, sendMessage, abortCurrentStream, isConvStreaming, dispatch, setPendingPresetMessage } = useApp();
  const router = useRouter();
  const isAdmin = state.auth.user?.role === "admin";
  const canSwitchAssistant = isAdmin;
  const [inputValue, setInputValue] = useState("");
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionSearch, setMentionSearch] = useState("");

  // @mention 临时提示：发送@消息后短暂显示；本次只做一次性转发，不接管后续对话
  const [mentionTip, setMentionTip] = useState<{ agentName: string; agentId: string; agentIconUrl: string } | null>(null);

  // 模型记忆：恢复时使用的 localStorage key
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [contentWidthClass, setContentWidthClass] = useState(2); // 0=紧凑, 1=标准, 2=宽屏, 3=全屏
  const [isExpanded, setIsExpanded] = useState(false); // 对话框放大状态（侧边栏折叠）
  const [isInputExpanded, setIsInputExpanded] = useState(false); // 输入框展开/收起（maxHeight切换）

  // 侧边栏可见性检测：仅桌面端 + 非全屏 + 侧边栏展开时，内容区需要视觉居中补偿
  const [isMobileView, setIsMobileView] = useState(false);
  useEffect(() => {
    const check = () => setIsMobileView(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // 文本代码框可按点击顺序推送到 AI 生图工作台；不解析、不拆分、不改写提示词。
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const sendBtn = target.closest('.send-image-workbench-button') as HTMLElement | null;
      if (!sendBtn) return;
      e.preventDefault();
      e.stopPropagation();

      const wrapper = sendBtn.closest('.code-block-wrapper') as HTMLElement | null;
      const codeEl = wrapper?.querySelector('code') as HTMLElement | null;
      if (!wrapper || !codeEl || !wrapper.classList.contains('code-block-plaintext')) return;

      const payload = appendImageWorkbenchPromptTransfer(codeEl.textContent || '');
      if (!payload) {
        toast.info("这段提示词为空，暂时不能推送。");
        return;
      }

      sendBtn.classList.add('sent');
      window.setTimeout(() => sendBtn.classList.remove('sent'), 1600);
      toast.success(`已推送图片提示词到 AI 生图工作台队列（共 ${payload.items.length} 条）`);
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // 代码块展开/折叠事件委托 — 已禁用折叠功能（代码块始终全量显示），保留事件委托框架以防未来恢复
  useEffect(() => {
    // No-op: 折叠按钮已移除，代码块始终全量显示
  }, []);

  // 代码块复制按钮事件委托 — document 级确保点击事件可达
  useEffect(() => {
    const handleClick = async (e: Event) => {
      const target = e.target as HTMLElement;
      const copyBtn = target.closest('.copy-code-button');
      if (copyBtn) {
        const wrapper = copyBtn.closest('.code-block-wrapper');
        if (wrapper) {
          const codeEl = wrapper.querySelector('code');
          if (codeEl) {
            const ok = await copyToClipboard(codeEl.textContent || '');
            if (ok) {
              copyBtn.classList.add('copied');
              toast.success("已复制到剪贴板");
              setTimeout(() => copyBtn.classList.remove('copied'), 2000);
            } else {
              toast.error("复制失败，请手动复制");
            }
          }
        }
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // 代码框发送到视频任务：按“段落/图片/任务 N”识别；无显式编号时按本条消息内代码框顺序兜底。
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const sendBtn = target.closest('.send-video-task-button') as HTMLElement | null;
      if (!sendBtn) return;
      e.preventDefault();
      e.stopPropagation();

      const wrapper = sendBtn.closest('.code-block-wrapper') as HTMLElement | null;
      const codeEl = wrapper?.querySelector('code') as HTMLElement | null;
      if (!wrapper || !codeEl) return;

      const messageRoot = wrapper.closest('.markdown-body') || document;
      const codeBlocks = Array.from(messageRoot.querySelectorAll('.code-block-wrapper')) as HTMLElement[];
      const messageText = messageRoot.textContent || "";
      const mergedItems = new Map<number, VideoTaskTransferItem & { wrappers: HTMLElement[] }>();
      const validWrappers = new Set<HTMLElement>();
      let searchCursor = 0;

      for (const block of codeBlocks) {
        const blockCodeEl = block.querySelector('code') as HTMLElement | null;
        if (!blockCodeEl) continue;

        const rawCode = blockCodeEl.textContent || "";
        const prompt = sanitizeVideoPrompt(rawCode);
        if (!prompt) continue;

        const language = (block.querySelector('.code-block-lang')?.textContent || '').trim();
        const codeIndex = messageText.indexOf(rawCode, searchCursor);
        const beforeText = (codeIndex >= 0 ? messageText.slice(0, codeIndex) : "").slice(-520);
        if (codeIndex >= 0) searchCursor = codeIndex + rawCode.length;
        if (!isLikelyVideoPrompt(`${beforeText}\n${prompt}`, language)) continue;

        validWrappers.add(block);
        const fallbackOrder = Math.max(1, codeBlocks.indexOf(block) + 1);
        const orderContext = findNearestVideoTaskOrderContext(beforeText);
        const orderSource = orderContext.trim()
          ? `${orderContext}\n${prompt}`
          : prompt.replace(/(?:\u955c\u5934|\u5206\u955c|scene|shot)\s*[\[\u3010\uff08(]?\s*\d{1,2}/gi, "");
        const order = inferVideoTaskOrder(orderSource, fallbackOrder);
        const existing = mergedItems.get(order);
        if (existing) {
          existing.prompt = [existing.prompt, prompt].filter(Boolean).join("\n\n");
          existing.wrappers.push(block);
        } else {
          mergedItems.set(order, {
            order,
            prompt,
            label: `任务${order}`,
            title: `段落${order}`,
            source: "chat-code",
            wrappers: [block],
          });
        }
      }

      if (!validWrappers.has(wrapper)) {
        toast.info("这个代码框不像视频提示词，我先不发送，避免误填任务卡片。");
        return;
      }

      const items = Array.from(mergedItems.values())
        .sort((left, right) => left.order - right.order)
        .map(({ wrappers: _wrappers, ...item }) => item);
      const payload = makeVideoTaskTransferPayload(items, items.length > 1 ? "batch" : "single");
      if (payload.items.length === 0) return;

      if (!dispatchVideoTaskTransfer(payload)) {
        toast.error("临时交接失败，请稍后重试");
        return;
      }
      for (const block of validWrappers) {
        const blockSendBtn = block.querySelector('.send-video-task-button') as HTMLElement | null;
        blockSendBtn?.classList.add('sent');
        if (blockSendBtn) setTimeout(() => blockSendBtn.classList.remove('sent'), 1600);
      }
      if (payload.items.length > 1) {
        toast.success(`已一次发送 ${payload.items.length} 条提示词到视频任务卡片`);
      } else {
        toast.success(`已发送到视频任务${payload.items[0]?.order || 1}`);
      }
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // :::copy 可复制容器 — 复制文本按钮事件委托
  useEffect(() => {
    const handleClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('.copyable-block-copy-btn') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const block = btn.closest('.copyable-block') as HTMLElement | null;
      if (!block) return;

      const contentEl = block.querySelector('.copyable-block-content') as HTMLElement | null;
      if (!contentEl) return;

      // 优先复制原始 Markdown 源码（data-raw 属性），确保粘贴到其他 LLM 时格式完整
      let copyText = '';
      const rawAttr = contentEl.getAttribute('data-raw');
      if (rawAttr) {
        // 解码 HTML 实体，还原标准 Markdown
        const textarea = document.createElement('textarea');
        textarea.innerHTML = rawAttr;
        copyText = textarea.value;
      } else {
        // 流式输出期间（未闭合块）没有 data-raw，回退到 textContent
        copyText = contentEl.textContent || '';
      }
      const ok = await copyToClipboard(copyText);
      if (ok) {
        btn.classList.add('copied');
        toast.success("已复制到剪贴板");
        setTimeout(() => btn.classList.remove('copied'), 2000);
      } else {
        toast.error("复制失败，请手动复制");
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // 表格复制按钮事件委托
  useEffect(() => {
    const handleClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('.table-copy-btn') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const wrapper = btn.closest('.table-wrapper') as HTMLElement | null;
      if (!wrapper) return;

      const table = wrapper.querySelector('table') as HTMLElement | null;
      if (!table) return;

      // 将表格转为 TSV 格式，方便粘贴到 Excel/文档
      const rows = table.querySelectorAll('tr');
      const tsv = Array.from(rows).map(row => {
        const cells = row.querySelectorAll('th, td');
        return Array.from(cells).map(cell => cell.textContent?.trim() || '').join('\t');
      }).join('\n');
      const ok = await copyToClipboard(tsv);
      if (ok) {
        btn.classList.add('copied');
        toast.success("表格已复制到剪贴板");
        setTimeout(() => btn.classList.remove('copied'), 2000);
      } else {
        toast.error("复制失败，请手动复制");
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  /** 侧边栏是否占据左侧空间 — 为使内容视觉居中于整个视口，需在右侧补偿等宽留白 */
  const sidebarVisible = !isMobileView && !state.isChatFullscreen && !state.sidebarCollapsed;

  // 同步侧边栏折叠状态：当侧边栏从外部被操作时更新 isExpanded 和内容宽度
  useEffect(() => {
    // 仅在 isExpanded 与 sidebarCollapsed 不一致时同步
    if (state.sidebarCollapsed && !isExpanded) {
      setIsExpanded(true);
      setContentWidthClass(3);
    } else if (!state.sidebarCollapsed && isExpanded) {
      setIsExpanded(false);
      setContentWidthClass(2);
    }
  }, [state.sidebarCollapsed]);

  const [pendingImages, setPendingImages] = useState<{ key: string; url: string; name: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // 联网搜索保留为唯一的对话能力开关。自由对话的模型和深度思考
  // 由服务端固定策略控制，避免浏览器状态导致能力漂移。
  const [webSearchOverride, setWebSearchOverride] = useState<boolean>(false);
  useEffect(() => {
    setWebSearchOverride(false);
    setMentionTip(null);
  }, [state.activeAgentId, state.activeConversationId]);

  const widthClasses = ['max-w-4xl', 'max-w-5xl', 'max-w-6xl', 'max-w-full'];
  const widthLabels = ['紧凑', '标准', '宽屏', '全屏'];


  // Image upload handler
  const handleImageUpload = useCallback(async (files: FileList | File[]) => {
    const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
    const maxSize = 5 * 1024 * 1024; // 5MB
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      if (!allowedTypes.includes(file.type)) {
        toast.error(`不支持的格式：${file.name}，仅支持 PNG/JPG/GIF/WebP`);
        continue;
      }
      if (file.size > maxSize) {
        toast.error(`文件过大：${file.name}，最大 5MB`);
        continue;
      }
      try {
        const formData = new FormData();
        formData.append("file", file);
        const token = state.auth.token || localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: formData,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const fallback = res.status === 401 ? "登录已过期，请重新登录" : "上传失败，请稍后重试";
          throw new Error(data.error || fallback);
        }
        if (data.success && data.key) {
          setPendingImages(prev => [...prev, { key: data.key, url: data.url, name: file.name }]);
        } else {
          toast.error(`${file.name}：${data.error || "上传结果无效，请重试"}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "上传失败，请稍后重试";
        toast.error(`${file.name}：${message}`);
      }
    }
  }, [state.auth.token]);

  const removePendingImage = useCallback((index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Drag & drop handlers for input area
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleImageUpload(files);
    }
  }, [handleImageUpload]);


  const activeConv = state.conversations.find((c) => c.id === state.activeConversationId);
  const [bipSelection, setBipSelection] = useState<{conversationId:string;agentId:string}|null>(null);
  const isBipProject = Boolean(bipStep(activeConv?.agentId));
  const bipDraftScope=useRef<{id?:string;wasBip:boolean}>({wasBip:false});
  useEffect(()=>{
    if(bipDraftScope.current.id!==activeConv?.id&&(isBipProject||bipDraftScope.current.wasBip))setInputValue('');
    bipDraftScope.current={id:activeConv?.id,wasBip:isBipProject};
  },[activeConv?.id,isBipProject]);
  const lastBipReply = activeConv?.messages.slice().reverse().find(m=>m.role==='assistant'&&bipStep(m.agentId));
  const bipAgentId = isBipProject ? (bipSelection && bipSelection.conversationId===activeConv?.id ? bipSelection.agentId : lastBipReply?.agentId || activeConv?.agentId) : undefined;
  // BUG FIX: activeConv 可能为 undefined（如删除当前对话后），所有后续访问必须用 ?.
  // 不在 hooks 中间 early return（违反 React hooks 规则），改为安全访问

  // A single scroll controller owns the transcript position. Layout changes must
  // never be mistaken for user scrolling, otherwise streaming content oscillates.
  const autoFollowRef = useRef(true);
  const needScrollToBottomRef = useRef(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const autoScrollRafRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  const prevConvIdRef = useRef<string | null>(null);

  const scrollToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottomTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - bottomTop) > 1) {
      el.scrollTop = bottomTop;
    }
    needScrollToBottomRef.current = false;
    autoFollowRef.current = true;
    setShowScrollBottom(false);
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (autoScrollRafRef.current !== null) return;
    autoScrollRafRef.current = requestAnimationFrame(() => {
      autoScrollRafRef.current = null;
      if (needScrollToBottomRef.current || autoFollowRef.current) {
        scrollToBottomNow();
      }
    });
  }, [scrollToBottomNow]);

  const resumeAutoFollow = useCallback(() => {
    autoFollowRef.current = true;
    needScrollToBottomRef.current = true;
    setShowScrollBottom(false);
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom]);

  const pauseAutoFollow = useCallback(() => {
    autoFollowRef.current = false;
    needScrollToBottomRef.current = false;
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight > CHAT_SCROLL_LATEST_THRESHOLD_PX) {
      setShowScrollBottom(true);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    };
  }, []);

  // A conversation switch always starts at the latest message.
  useEffect(() => {
    const currentConvId = state.activeConversationId;
    const prevConvId = prevConvIdRef.current;
    if (currentConvId !== prevConvId) {
      autoFollowRef.current = true;
      needScrollToBottomRef.current = true;
      setShowScrollBottom(false);
      prevConvIdRef.current = currentConvId;
      scheduleScrollToBottom();
    }
  }, [state.activeConversationId, scheduleScrollToBottom]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom <= CHAT_SCROLL_LATEST_THRESHOLD_PX;
    const shouldShowButton = !nearBottom;
    setShowScrollBottom((prev) => prev === shouldShowButton ? prev : shouldShowButton);
    if (nearBottom) {
      // Reaching the bottom, by any input method, resumes following.
      needScrollToBottomRef.current = false;
      autoFollowRef.current = true;
    } else {
      // Scrollbar dragging, keyboard scrolling and assistive input do not emit
      // wheel/touch events. Any position away from the latest message pauses
      // follow mode so the next streamed token cannot snap the reader down.
      needScrollToBottomRef.current = false;
      autoFollowRef.current = false;
    }
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pauseAutoFollow();
  }, [pauseAutoFollow]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const currentY = event.touches[0]?.clientY;
    const startY = touchStartYRef.current;
    if (currentY !== undefined && startY !== null && currentY > startY + 4) {
      pauseAutoFollow();
    }
    touchStartYRef.current = currentY ?? null;
  }, [pauseAutoFollow]);

  const handleScrollPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.target === event.currentTarget && event.clientX >= rect.right - 16) {
      pauseAutoFollow();
    }
  }, [pauseAutoFollow]);

  const shouldAutoScroll = useCallback(() => {
    return needScrollToBottomRef.current || autoFollowRef.current;
  }, []);

  // ResizeObserver is the only layout-driven scroll writer. This covers message
  // insertion, token growth, delayed media and final Markdown rendering.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const contentEl = container.firstElementChild as HTMLElement | null;
    if (!contentEl) return;

    const observer = new ResizeObserver(() => {
      if (shouldAutoScroll()) {
        scheduleScrollToBottom();
      } else {
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        const shouldShowButton = distanceFromBottom > CHAT_SCROLL_LATEST_THRESHOLD_PX;
        setShowScrollBottom((prev) => prev === shouldShowButton ? prev : shouldShowButton);
      }
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [state.activeConversationId, shouldAutoScroll, scheduleScrollToBottom]);

  // Auto-send pending preset message from context
  useEffect(() => {
    if (state.pendingPresetMessage?.convId === state.activeConversationId) {
      const msg = state.pendingPresetMessage;
      if (!msg) return;
      if (isBipProject && !msg.autoSend) {
        setInputValue(msg.content);
        setPendingPresetMessage(null);
        return;
      }
      const timer = setTimeout(() => {
        setPendingPresetMessage(null);
        const deepThinking = state.activeAgentId === FREE_CHAT_AGENT_ID
          ? FREE_CHAT_DEEP_THINKING_TYPE
          : undefined;
        const webSearch = webSearchOverride || shouldAutoEnableWebSearch(msg.content)
          ? true
          : undefined;
        sendMessage(msg.content, undefined, undefined, undefined, undefined, deepThinking, webSearch);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [state.pendingPresetMessage, state.activeConversationId, state.activeAgentId, isBipProject,
    webSearchOverride, sendMessage, setPendingPresetMessage]);

  // ESC/F11 key to toggle fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.isChatFullscreen) {
        dispatch({ type: "TOGGLE_CHAT_FULLSCREEN" });
      }
      if (e.key === "F11" && activeConv) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_CHAT_FULLSCREEN" });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.isChatFullscreen, dispatch, activeConv]);

  // Filter agents for mention (supports name + pinyin initials)
  const mentionAgents = useMemo(
    () =>
      state.agents.filter((a) => {
        if (a.id === state.activeAgentId) return false;
        // 非管理员过滤不可用/已下架的智能体
        const isAdmin = state.auth.user?.role === "admin";
        if (!isAdmin && a.user_access === "hidden") return false;
        if (!isAdmin && !a.is_active) return false;
        if (!mentionSearch) return true;
        const { matched } = fuzzyMatch(a.name, mentionSearch);
        return matched;
      }),
    [state.agents, state.activeAgentId, mentionSearch, state.auth.user?.role]
  );

  // Get active agent's output style
  const activeAgent = useMemo(
    () => state.agents.find(a => a.id === (bipAgentId || state.activeAgentId)),
    [state.agents, state.activeAgentId, bipAgentId]
  );
  const activeAgentAvatarUrl = resolveAgentAvatarUrl(
    activeAgent?.id || activeConv?.agentId || activeConv?.id,
    activeAgent?.name || activeConv?.agentName,
    activeAgent?.iconUrl || activeConv?.agentIconUrl,
  );
  const activeAgentBaseStyle = activeAgent?.outputStyle;
  const [agentOutputStyle, setAgentOutputStyle] = useState<import('@/types/coze').OutputStyle>(activeAgentBaseStyle ?? {});
  useEffect(() => { setAgentOutputStyle(activeAgentBaseStyle ?? {}); }, [activeAgentBaseStyle]);

  const handleInputChange = (value: string) => {
    setInputValue(value);

    // @ 切换助手仅管理员。普通用户输入里的 @ 保持原文，不打开选择器。
    if (!canSwitchAssistant) {
      setShowMentionDropdown(false);
      return;
    }
    // Detect @ mention — 仅在@位于开头或前面是空格时触发，避免匹配邮箱地址
    const lastAtIndex = value.lastIndexOf("@");
    if (lastAtIndex >= 0) {
      const charBefore = lastAtIndex > 0 ? value[lastAtIndex - 1] : " ";
      const isStandaloneAt = charBefore === " " || charBefore === "\n" || lastAtIndex === 0;
      const textAfterAt = value.slice(lastAtIndex + 1);
      if (isStandaloneAt && !textAfterAt.includes(" ") && textAfterAt.length < 20) {
        setShowMentionDropdown(true);
        setMentionSearch(textAfterAt);
        setMentionStartIndex(lastAtIndex);
        setSelectedMentionIndex(0);
      } else {
        setShowMentionDropdown(false);
      }
    } else {
      setShowMentionDropdown(false);
    }
  };

  const handleMentionSelect = (agentId: string) => {
    if (!canSwitchAssistant) {
      setShowMentionDropdown(false);
      return;
    }
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent || mentionStartIndex < 0) return;

    const before = inputValue.slice(0, mentionStartIndex);
    const after = inputValue.slice(mentionStartIndex + 1 + mentionSearch.length);
    setInputValue(`${before}@${agent.name} ${after}`);
    setShowMentionDropdown(false);

    // 不自动进入协同模式；@mention 只作为一次性调用

    inputRef.current?.focus();
  };

  // ★ 架构改进：发送防抖，防止连续点击导致429限流
  const sendDebounceRef = useRef(false);
  const SEND_DEBOUNCE_MS = 500;

  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed && pendingImages.length === 0) return;
    if (activeConv && isConvStreaming(activeConv.id)) {
      toast.info("当前回复仍在生成，请先停止接收后再发送新消息");
      return;
    }

    // 防抖：500ms内只允许一次发送
    if (sendDebounceRef.current) {
      console.log("[handleSend] 防抖拦截：发送过快，忽略");
      return;
    }
    sendDebounceRef.current = true;
    window.setTimeout(() => {
      sendDebounceRef.current = false;
    }, SEND_DEBOUNCE_MS);
    resumeAutoFollow();

    console.log(`[handleSend] 🔵 CALLED: content="${trimmed?.slice(0,30)}...", activeConv=${activeConv?.id}, isConvStreaming=${activeConv ? isConvStreaming(activeConv.id) : 'no-conv'}`);

    // Build message content
    let messageContent = trimmed;
    let apiContent: string | undefined; // 实际发送给API的内容（协同时与展示内容不同）

    // Check if there's a @mention. 非管理员不把 @ 解析成助手切换。
    let mentionedAgentId: string | undefined = bipAgentId;
    // 仅匹配独立的@提及（@位于开头或前面是空格），避免匹配邮箱地址
    const mentionMatch = canSwitchAssistant ? trimmed.match(/(?:^|\s)@(\S+)(?:\s|$)/) : null;
    if (canSwitchAssistant && mentionMatch) {
      const mentionedAgent = state.agents.find((a) => a.name === mentionMatch[1]);
      if (mentionedAgent) {
        mentionedAgentId = mentionedAgent.id;

        // @mention 只做一次性发送提示，不再提供持久协同/接管后续对话
        setMentionTip({
          agentName: mentionedAgent.name,
          agentId: mentionedAgent.id,
          agentIconUrl: mentionedAgent.iconUrl || '',
        });
        // 5秒后自动隐藏临时提示
        setTimeout(() => setMentionTip(prev => prev?.agentId === mentionedAgent.id ? null : prev), 5000);

        // 智能协同：不再重复发送上一轮AI的完整输出内容（浪费tokens/积分）
        // 对话历史已经包含上一轮输出，新智能体可通过上下文自动获取
        // 只发送简短指令，引导新智能体基于对话历史执行任务
        if (activeConv && activeConv.messages.length > 0) {
          const lastAssistantMsg = [...activeConv.messages]
            .reverse()
            .find(m => m.role === "assistant" && m.content && !m.content.startsWith("发送失败"));

          if (lastAssistantMsg && lastAssistantMsg.content) {
            // 用户指令：去掉@提及部分，若为空则根据智能体名称自动推断
            const rawInstruction = trimmed.replace(/@\S+\s*/, '').trim();
            const autoInstruction = inferAgentInstruction(mentionedAgent.name);
            const userInstruction = rawInstruction || autoInstruction;

            // 直接发送用户指令或自动推断指令，对话历史已包含上下文无需重复
            apiContent = userInstruction;
            // 前端展示：只显示用户的简短输入（去掉@提及部分后若为空，显示@提及）
            const displayText = rawInstruction || `@${mentionedAgent.name}`;
            messageContent = displayText;
          }
        }
      }
    }

    const imageKeys = pendingImages.length > 0 ? pendingImages.map(img => img.key) : undefined;
    const targetAgentId = mentionedAgentId || state.activeAgentId;
    const deepThinkingValue = targetAgentId === FREE_CHAT_AGENT_ID
      ? FREE_CHAT_DEEP_THINKING_TYPE
      : undefined;
    const webSearchValue = webSearchOverride || shouldAutoEnableWebSearch(apiContent || messageContent)
      ? true
      : undefined;
    // ★ 先清空输入框，再发送消息 — 必须在 sendMessage 之前清空
    // sendMessage 是 await 的，会等到整个流式输出完成才返回
    // 如果放在 await 之后清空，用户会看到输入框内容一直保留到 AI 回复完毕
    const contentToSend = messageContent;
    // ── 前端安全拦截：已下架智能体禁止发送消息（虚拟智能体跳过检查）──
    const targetAgent = targetAgentId ? state.agents.find(a => a.id === targetAgentId) : null;
    const isVirtualAgent = targetAgentId?.startsWith("__");
    if (targetAgent && !isVirtualAgent && !targetAgent.is_active && state.auth.user?.role !== "admin") {
      setInputValue("");
      setPendingImages([]);
      setShowMentionDropdown(false);
      if (inputRef.current) inputRef.current.style.height = 'auto';
      toast.warning("该智能体已下架，暂不可使用");
      return;
    }
    // ★ 先清空输入框，再发送消息 — 必须在 sendMessage 之前清空
    setInputValue("");
    setPendingImages([]);
    setShowMentionDropdown(false);
    // Reset textarea height after send
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    await sendMessage(contentToSend, mentionedAgentId, imageKeys, undefined, apiContent, deepThinkingValue, webSearchValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionDropdown && mentionAgents.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMentionIndex((prev) => Math.min(prev + 1, mentionAgents.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMentionIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleMentionSelect(mentionAgents[selectedMentionIndex].id);
        return;
      }
      if (e.key === "Escape") {
        setShowMentionDropdown(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Textarea 高度参数 — 对齐 style: fontSize=16px, lineHeight=1.65 → 1行=26.4px≈27px, padding=13px*2=26px
  // 2026-07-27 老狼需求：输入窗口整体高度按原尺寸增高 1/3（×4/3）
  // 2026-07-28 老狼需求：输入框再增高一点（×1.5）
  const LINE_HEIGHT = 27;
  const TEXTAREA_MIN_HEIGHT = Math.round((LINE_HEIGHT + 26) * 1.5); // ≈80px（原 53px → 71px → 80px）
  const TEXTAREA_MAX_HEIGHT = Math.round((6 * LINE_HEIGHT + 26) * 1.5); // ≈282px（原 188px → 251px → 282px，超出后滚动）

  const [textareaOverflowY, setTextareaOverflowY] = useState<'hidden' | 'auto'>('hidden');
  const [textareaHeight, setTextareaHeight] = useState<number>(TEXTAREA_MIN_HEIGHT);

  // 自动调整 textarea 高度（核心函数，全部通过 React state 驱动）
  const autoResizeTextarea = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    // 临时收缩以获取真实 scrollHeight
    textarea.style.height = 'auto';
    const scrollH = textarea.scrollHeight;
    const maxH = isInputExpanded ? Math.min(window.innerHeight * 0.4, 500) : TEXTAREA_MAX_HEIGHT;
    const newHeight = Math.max(TEXTAREA_MIN_HEIGHT, Math.min(scrollH, maxH));
    // 立即恢复高度避免闪烁，React state 更新后会最终覆盖
    textarea.style.height = newHeight + 'px';
    // 通过 React state 驱动最终高度
    setTextareaHeight(newHeight);
    setTextareaOverflowY(scrollH > maxH ? 'auto' : 'hidden');
  }, [isInputExpanded]);

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    handleInputChange(e.target.value);
    // 使用 requestAnimationFrame 确保在 React 更新 DOM 后调整高度
    requestAnimationFrame(() => autoResizeTextarea());
  };

  // 内容变化时自动调整高度（粘贴、@mention注入、清空等场景）
  useEffect(() => {
    requestAnimationFrame(() => autoResizeTextarea());
  }, [inputValue, autoResizeTextarea]);

  if (!activeConv) {
    //G 刷新位置保持：区分"对话加载中"和"未选择对话"两种状态
    // 如果 activeConversationId 已设置（从 localStorage 恢复），但对话还在加载中，显示加载指示器
    const isConvLoading = state.activeConversationId !== null;
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--background)]">
        <div className="text-center text-[var(--text-secondary)] animate-fade-up">
          {isConvLoading ? (
            <>
              <div className="w-10 h-10 rounded-xl bg-[var(--primary)]/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
                <Bot className="w-5 h-5 text-[var(--primary)]" />
              </div>
              <p className="text-sm text-[var(--muted-foreground)]">正在恢复对话...</p>
            </>
          ) : (
            <>
              <div className="w-20 h-20 rounded-2xl bg-[var(--card)] flex items-center justify-center mx-auto mb-5 border border-[var(--border)] animate-float">
                <Bot className="w-10 h-10 text-[var(--primary)] opacity-60" />
              </div>
              <p className="text-sm font-medium text-[var(--foreground)]">选择一个智能体开始对话</p>
              <p className="text-xs mt-2 text-[var(--text-secondary)]">
                {isAdmin ? "从应用广场选择，或点击左侧「新建对话」" : "从应用广场选择智能体开始对话"}
              </p>
            </>
          )}
        </div>

      </div>
    );
  }

  return (
    <div className="chat-stage relative flex flex-col h-full bg-[var(--background)]" data-chat-surface="unified-glass">
      {isBipProject && activeConv && bipAgentId && <BusinessIpFlow key={activeConv.id} value={bipAgentId} conversationId={activeConv.id} onChange={agentId=>setBipSelection({conversationId:activeConv.id,agentId})} agents={state.agents} disabled={isConvStreaming(activeConv.id)} onPrepare={text=>setInputValue(current=>current?`${current}\n\n${text}`:text)} />}
      {/* Corner float: expand/collapse/fullscreen — 圆角融为一体 */}
      <div className="absolute top-1.5 right-1.5 z-50 flex items-center gap-0.5">
        {activeConv?.messages?.length > 0 ? (
          <>
            {/* Fullscreen toggle — 仅常态下显示 */}
            {!(isExpanded || state.isChatFullscreen) && (
              <button
                onClick={() => dispatch({ type: "TOGGLE_CHAT_FULLSCREEN" })}
                className="w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/80 transition-all duration-200"
                title="全屏对话"
                aria-label="全屏对话"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
            )}
            {/* Expand/collapse toggle */}
            <button
              onClick={() => {
                if (isExpanded) {
                  setIsExpanded(false);
                  dispatch({ type: "SET_SIDEBAR_COLLAPSED", payload: false });
                  setContentWidthClass(2);
                } else {
                  setIsExpanded(true);
                  dispatch({ type: "SET_SIDEBAR_COLLAPSED", payload: true });
                  setContentWidthClass(3);
                }
              }}
              className={cn(
                "w-6 h-6 flex items-center justify-center rounded-md transition-all duration-200",
                isExpanded
                  ? "text-[var(--primary)] hover:bg-[var(--primary)]/10"
                  : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/80"
              )}
              title={isExpanded ? "恢复大小" : "放大对话"}
              aria-label={isExpanded ? "恢复对话大小" : "放大对话"}
            >
              {isExpanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
            </button>
            {/* Collapse from fullscreen */}
            {state.isChatFullscreen && (
              <button
                onClick={() => dispatch({ type: "TOGGLE_CHAT_FULLSCREEN" })}
                className="w-6 h-6 flex items-center justify-center rounded-md text-[var(--primary)] hover:bg-[var(--primary)]/10 transition-all duration-200"
                title="退出全屏 (Esc)"
                aria-label="退出全屏"
              >
                <Minimize2 className="w-3 h-3" />
              </button>
            )}
          </>
        ) : (
          /* 空对话：仅显示全屏按钮 */
          <button
            onClick={() => dispatch({ type: "TOGGLE_CHAT_FULLSCREEN" })}
            className="w-6 h-6 flex items-center justify-center rounded-md text-[var(--muted-foreground)]/40 hover:text-[var(--foreground)] hover:bg-[var(--accent)]/80 transition-all duration-200"
            title="全屏对话"
            aria-label="全屏对话"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {/* Chat Header */}
      <div
        className={cn(
          "chat-stage-header relative z-50 bg-[var(--background)]/80 backdrop-blur-sm border-b border-[var(--border)] h-[60px] pl-14 sm:pl-3 pr-3 flex items-center justify-between cursor-default",
        )}
        onDoubleClick={() => dispatch({ type: "TOGGLE_CHAT_FULLSCREEN" })}
        title="双击切换全屏"
      >
        <div className="flex items-center gap-3">
          <Avatar className="w-11 h-11 ring-1 ring-[var(--border)]" data-testid="chat-agent-avatar">
            <AvatarImage src={activeAgentAvatarUrl} alt={activeConv?.agentName} />
            <AvatarFallback className="text-xs bg-gradient-to-br from-[#4F8FF7] to-[#7B61FF] text-white">
              {activeConv?.agentName?.slice(0, 2) || "AI"}
            </AvatarFallback>
          </Avatar>
          <div>
            <h2 className="text-sm font-medium text-[var(--foreground)]" data-testid="chat-agent-name">{activeAgent?.name || activeConv?.agentName || "智能体"}</h2>
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="chat-agent-online-ping animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-40" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#10B981]" />
              </span>
              <p className="text-[11px] text-[var(--text-secondary)]">在线</p>
              {/* 深度思考由自由对话服务端固定开启；界面只保留联网入口。 */}
              {(activeAgent?.source === "llm" || state.activeAgentId === FREE_CHAT_AGENT_ID) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setWebSearchOverride(!webSearchOverride);
                  }}
                  className={cn(
                    "ml-1 flex h-7 w-7 items-center justify-center rounded-md border transition-all",
                    webSearchOverride
                      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
                      : "text-[var(--muted-foreground)] border-[var(--border)] hover:border-emerald-500/30 hover:text-[var(--foreground)]"
                  )}
                  title={webSearchOverride ? "联网搜索：已开启（点击关闭）" : "联网搜索：点击开启；也可直接说“联网找一下”"}
                  aria-label={webSearchOverride ? "关闭联网搜索" : "开启联网搜索"}
                  aria-pressed={webSearchOverride}
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Quick nav: app marketplace — keep it as the left-most navbar item */}
          <NavButton icon={LayoutGrid} label="应用广场" variant="ghost" onClick={() => dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" })} title="前往应用广场" />
          {/* Quick nav: back to marketplace */}
          <NavButton icon={Home} label="主页" variant="ghost" onClick={() => dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" })} title="返回应用广场" />

          {isAdmin && (
          <button
            onClick={() => setContentWidthClass(c => (c + 1) % widthClasses.length)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] text-[var(--text-secondary)] hover:text-[var(--foreground)] bg-[var(--background)] border border-[var(--border)] hover:border-[var(--primary)]/30 transition-colors"
            title="切换内容宽度"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="12" height="10" rx="1"/><line x1="5" y1="3" x2="5" y2="13"/>
            </svg>
            {widthLabels[contentWidthClass]}
          </button>
          )}
          {/* Credits badge */}
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#10B981]/10 text-[#10B981] text-xs font-medium">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6"/></svg>
            {(state.credits?.remaining ?? 0).toLocaleString()} 积分
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        className={`chat-canvas flex-1 overflow-y-auto chat-scroll relative${activeConv && isConvStreaming(activeConv.id) ? ' chat-streaming' : ''}`}
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onPointerDown={handleScrollPointerDown}
      >
        <div className={`chat-content-rail chat-shared-rail py-8 space-y-3 ${widthClasses[contentWidthClass]} mx-auto`}>
          {activeConv?.messages?.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 animate-fade-up">
              {state.activeAgentId === FREE_CHAT_AGENT_ID ? (
                <>
                  <p className="text-sm text-[var(--foreground)]">GPT-5.6 已就绪，直接开始自由对话</p>
                  <p className="text-xs mt-1.5 text-[var(--text-secondary)]">深度思考默认开启；需要实时信息时点击联网图标，或直接说“联网找一下”</p>
                </>
              ) : activeAgent?.guideMessage || activeAgent?.guide_message ? (
                <>
                  <div className="flex items-center gap-2.5">
                    <Avatar className="w-8 h-8 ring-1 ring-[var(--border)] shrink-0">
                      <AvatarImage src={activeAgentAvatarUrl} alt={activeConv?.agentName} />
                      <AvatarFallback className="text-[10px] bg-gradient-to-br from-[#4F8FF7] to-[#7B61FF] text-white">
                        {activeConv?.agentName?.slice(0, 2) || "AI"}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm text-[var(--foreground)] leading-relaxed whitespace-pre-line max-w-xl">
                      {isBipProject ? (activeAgent.guideMessage || activeAgent.guide_message) : (activeAgent.guideMessage || activeAgent.guide_message || '').split('\n')[0]}
                    </span>
                  </div>
                  <p className="text-xs mt-3 text-[var(--text-secondary)]">{isBipProject ? '直接说你的情况，不清楚的内容由我协助判断。' : (canSwitchAssistant ? '输入问题，使用 @ 可以切换其他智能体' : '输入问题开始对话')}</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-[var(--foreground)]">开始与 {activeConv?.agentName} 对话吧</p>
                  <p className="text-xs mt-1.5 text-[var(--text-secondary)]">{canSwitchAssistant ? "输入问题，使用 @ 可以切换其他智能体" : "输入问题开始对话"}</p>
                </>
              )}
            </div>
          )}
          {activeConv?.messages?.map((msg, idx) => (
            <ChatErrorBoundary key={`eb-${msg.id}`} context={`message-${msg.id}`}>
            <MessageBubble
              key={msg.id}
              message={msg}
              allMessages={activeConv?.messages}
              outputStyle={agentOutputStyle}
              responseFormat={activeAgent?.responseFormat ?? activeAgent?.response_format}
              onStyleChange={(newStyle) => setAgentOutputStyle(newStyle)}
              onSaveStyleAsTemplate={async () => {
                if (!state.activeAgentId) return;
                try {
                  const token = localStorage.getItem("auth_token");
                  if (!token) throw new Error("AUTH_TOKEN_REQUIRED");
                  let currentAgent: { id?: unknown; config_revision?: unknown } | undefined;
                  for (const path of ["/api/admin/agents", "/api/admin/agents?include_internal=1"]) {
                    const revisionResponse = await fetch(path, {
                      headers: { Authorization: `Bearer ${token}` },
                      cache: "no-store",
                    });
                    if (!revisionResponse.ok) {
                      if (path.includes("include_internal")) break;
                      throw new Error(`AGENT_REVISION_READ_FAILED:${revisionResponse.status}`);
                    }
                    const revisionPayload = await revisionResponse.json() as {
                      agents?: Array<{ id?: unknown; config_revision?: unknown }>;
                    };
                    currentAgent = (revisionPayload.agents || []).find((agent) => agent.id === state.activeAgentId);
                    if (currentAgent) break;
                  }
                  const expectedRevision = Number(currentAgent?.config_revision);
                  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
                    throw new Error("AGENT_EXPECTED_REVISION_REQUIRED");
                  }
                  const res = await fetch("/api/admin/agents", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                      agentId: state.activeAgentId,
                      expected_revision: expectedRevision,
                      output_style: agentOutputStyle,
                    }),
                  });
                  if (!res.ok) toast.error(res.status === 409 ? "模板已被另一端更新，请刷新后重试" : "保存失败");
                } catch { toast.error("无法读取最新配置版本，模板未保存"); }
              }}
              onRetry={!isChatOutcomeUnknown(msg) && ((msg.role === "assistant" && !msg.isStreaming) || (msg.role === "user" && msg.error)) ? () => {
                if (msg.role === "assistant") {
                  // Retry: re-send the last user message before this assistant message
                  const msgIdx = activeConv?.messages?.findIndex(m => m.id === msg.id) ?? -1;
                  const prevUserMsg = msgIdx > 0 ? activeConv?.messages?.slice(0, msgIdx).reverse().find(m => m.role === "user") : undefined;
                  if (prevUserMsg) {
                    // Remove this failed assistant message (do NOT re-add user message)
                    dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: activeConv?.id, messageId: msg.id } });
                    const retryDeepThinking = state.activeAgentId === FREE_CHAT_AGENT_ID
                      ? FREE_CHAT_DEEP_THINKING_TYPE
                      : undefined;
                    const retryWebSearch = webSearchOverride || shouldAutoEnableWebSearch(prevUserMsg.content)
                      ? true
                      : undefined;
                    // content 现在始终存储发送给API的完整内容，直接使用
                    sendMessage(prevUserMsg.content, undefined, undefined, undefined, undefined, retryDeepThinking, retryWebSearch, true);
                  }
                } else if (msg.role === "user" && msg.error) {
                  // Preserve the user's original input. Clear the visible error
                  // while retrying and pass its ID through so another failure can
                  // mark this same message again without creating a duplicate.
                  dispatch({ type: "CLEAR_MESSAGE_ERROR", payload: { conversationId: activeConv?.id, messageId: msg.id } });
                  const retryDeepThinking = state.activeAgentId === FREE_CHAT_AGENT_ID
                    ? FREE_CHAT_DEEP_THINKING_TYPE
                    : undefined;
                  const retryWebSearch = webSearchOverride || shouldAutoEnableWebSearch(msg.content)
                    ? true
                    : undefined;
                  sendMessage(msg.content, undefined, undefined, undefined, undefined, retryDeepThinking, retryWebSearch, true, msg.id);
                }
              } : undefined}
              onContinue={msg.role === "assistant" && !msg.isStreaming && /(?:\[已终止\]|输出中断|网络中断|连接中断)/.test(msg.content || "") ? () => {
                const retryDeepThinking = state.activeAgentId === FREE_CHAT_AGENT_ID
                  ? FREE_CHAT_DEEP_THINKING_TYPE
                  : undefined;
                const continuationInstruction = [
                  "请从上一条助手回复的中断位置继续，保留已经完成的正文，不要重复已完整输出的段落。",
                  "如果上一条正在输出 storyboard_director_output.v1 或 agent_prompt_package.v1，请在本次回复末尾只给出一个完整、可解析的最终机器 JSON 包。",
                  "不要重新解释任务，也不要把未闭合 JSON 当成完成结果。",
                ].join("\n");
                sendMessage("继续生成", undefined, undefined, undefined, continuationInstruction, retryDeepThinking, webSearchOverride ? true : undefined);
              } : undefined}
              onDelete={() => {
                dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: activeConv?.id, messageId: msg.id } });
              }}
              onEdit={msg.role === "user" ? (content: string) => {
                // 改写：将用户消息内容填入输入框
                setInputValue(content);
                inputRef.current?.focus();
              } : undefined}
              primaryAgentId={activeConv?.agentId}
            />
            </ChatErrorBoundary>
          ))}


        </div>
      </div>

      {/* Input Area — 对标竞品：sticky bottom */}
      <div className="chat-input-dock relative z-20 shrink-0 pt-6 pb-1">
        {/* Anchored above the input dock, outside the transcript scroll container. */}
        {showScrollBottom && activeConv.messages.length > 0 && (
          <div className={`chat-latest-rail chat-shared-rail pointer-events-none absolute inset-x-0 bottom-full z-40 ${widthClasses[contentWidthClass]} mx-auto`}>
            <button
              type="button"
              onClick={resumeAutoFollow}
              className={cn(
                "chat-latest-jump pointer-events-auto absolute z-40 inline-flex items-center justify-center",
                isConvStreaming(activeConv.id) && "is-streaming",
              )}
              aria-label={isConvStreaming(activeConv.id) ? "有新内容，回到最新消息" : "回到最新消息"}
              title={isConvStreaming(activeConv.id) ? "正在生成新内容，回到最新消息" : "回到最新消息"}
              data-testid="chat-scroll-to-latest"
            >
              <span
                className="chat-latest-dots"
                aria-hidden="true"
                data-testid="chat-streaming-latest-indicator"
              >
                <span className="chat-latest-dot" />
                <span className="chat-latest-dot" />
                <span className="chat-latest-dot" />
              </span>
              <ChevronDown className="chat-latest-arrow" aria-hidden="true" data-testid="chat-latest-arrow" />
            </button>
          </div>
        )}
        <div className={`chat-composer-rail chat-shared-rail relative ${widthClasses[contentWidthClass]} mx-auto`}>
          {/* Mention Dropdown */}
          {showMentionDropdown && (
            <div className="absolute bottom-full left-0 mb-2 w-80 max-h-72 overflow-hidden bg-[var(--card)]/90 backdrop-blur-md rounded-xl shadow-2xl border border-[var(--border)]/60 z-50 flex flex-col animate-fade-scale" role="dialog" aria-label="选择智能体">
              {/* Search input */}
              <div className="px-3 py-2 border-b border-[var(--border)]">
                <div className="flex items-center gap-2 bg-[var(--background)] rounded-lg px-3 py-1.5">
                  <Search className="w-3.5 h-3.5 text-[var(--muted-foreground)] flex-shrink-0" />
                  <input
                    type="text"
                    value={mentionSearch}
                    onChange={(e) => {
                      setMentionSearch(e.target.value);
                      setSelectedMentionIndex(0);
                      if (mentionStartIndex >= 0) {
                        const before = inputValue.slice(0, mentionStartIndex + 1);
                        const after = inputValue.slice(mentionStartIndex + 1 + mentionSearch.length);
                        setInputValue(before + e.target.value + after);
                      }
                    }}
                    placeholder="搜索名称或拼音首字母..."
                    className="flex-1 bg-transparent text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none"
                    role="combobox"
                    aria-label="搜索智能体"
                    aria-expanded="true"
                    aria-controls="chat-mention-options"
                    aria-activedescendant={mentionAgents[selectedMentionIndex] ? `chat-mention-option-${mentionAgents[selectedMentionIndex].id}` : undefined}
                    autoFocus
                  />
                  <span className="text-[10px] text-[#4B5563] flex-shrink-0">
                    {mentionAgents.length}个结果
                  </span>
                </div>
              </div>
              {/* Agent list */}
              <div className="overflow-y-auto flex-1" id="chat-mention-options" role="listbox" aria-label="智能体搜索结果">
                {mentionAgents.length > 0 ? (
                  mentionAgents.map((agent, idx) => {
                    const { matchType } = mentionSearch
                      ? fuzzyMatch(agent.name, mentionSearch)
                      : { matchType: 'none' as const };
                    return (
                      <button
                        key={agent.id}
                        id={`chat-mention-option-${agent.id}`}
                        role="option"
                        aria-selected={idx === selectedMentionIndex}
                        className={cn(
                          "flex items-center gap-3 w-full px-3 py-2.5 text-sm transition-colors",
                          idx === selectedMentionIndex ? "bg-[var(--primary)]/10" : "hover:bg-[var(--muted)]"
                        )}
                        onClick={() => handleMentionSelect(agent.id)}
                        onMouseEnter={() => setSelectedMentionIndex(idx)}
                      >
                        <Avatar className="w-9 h-9 ring-1 ring-[var(--border)]">
                          <AvatarImage src={resolveAgentAvatarUrl(agent.id, agent.name, agent.iconUrl)} alt={agent.name} />
                          <AvatarFallback className="text-[10px] bg-gradient-to-br from-[#4F8FF7] to-[#7B61FF] text-white">
                            {agent.name.slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="text-left flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] text-[var(--foreground)] font-medium">{agent.name}</span>
                            {matchType === 'pinyin' && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#4F8FF7]/15 text-[#4F8FF7]">拼音</span>
                            )}
                          </div>
                          <div className="text-[10px] text-[var(--text-secondary)] truncate">
                            {agent.description}
                          </div>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="px-3 py-6 text-center text-[11px] text-[#4B5563]">
                    未找到匹配的智能体
                  </div>
                )}
              </div>
            </div>
          )}

          {/* @mention 临时提示：发送@消息后短暂显示，本次只做一次性调用 */}
          {mentionTip && (
            <div className="flex items-center gap-2 mb-1.5 px-3 py-1.5 rounded-xl bg-blue-500/10 border border-blue-500/20 animate-fade-up">
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-500 font-medium shrink-0">@</span>
                <span className="text-[12px] text-[var(--foreground)] font-medium truncate">已一次性发送给 {mentionTip.agentName}</span>
                <span className="text-[10px] text-[var(--text-secondary)] shrink-0">后续仍回到当前智能体</span>
              </div>
              <button
                onClick={() => setMentionTip(null)}
                className="chat-composer-action shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors"
                title="关闭提示"
                aria-label="关闭智能体调用提示"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Input Box — 匹配竞品 rounded-3xl 容器 */}
          <div
            className={cn(
              "flex w-full flex-col rounded-3xl transition-all duration-200 relative chat-composer-rainbow",
              isDragOver && "bg-[var(--muted)]"
            )}
            style={{
              border: "1px solid var(--chat-glass-border, var(--border))",
              background: isDragOver
                ? "color-mix(in srgb, var(--primary) 10%, var(--chat-sheet-strong, var(--card)))"
                : "var(--chat-sheet-strong, var(--card))",
              boxShadow: "var(--chat-shadow, 0 18px 42px rgba(15, 23, 42, 0.12))",
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 rounded-3xl bg-primary/10 border-2 border-dashed border-primary/60 z-10 flex items-center justify-center pointer-events-none">
                <div className="flex flex-col items-center gap-2 text-primary">
                  <ImagePlus className="w-8 h-8" />
                  <span className="text-sm font-medium">释放以上传图片</span>
                </div>
              </div>
            )}
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleImageUpload(e.target.files);
                  e.target.value = "";
                }
              }}
            />
            {/* Expand/Collapse button — 右上角，纯图标，对标竞品 */}
            {inputValue.length > 0 && (
              <div className="absolute top-1 right-1 z-10">
                <button
                  onClick={() => {
                    setIsInputExpanded(prev => !prev);
                    // 延迟重算高度，让 isInputExpanded 状态更新后再调整
                    requestAnimationFrame(() => autoResizeTextarea());
                  }}
                  className="chat-composer-action w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors"
                  aria-label={isInputExpanded ? "收起输入框" : "展开输入框"}
                >
                  {isInputExpanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                </button>
              </div>
            )}
            {/* Pending image previews */}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-1 px-2 pt-2">
                {pendingImages.map((img, idx) => (
                  <div key={img.key} className="relative group">
                    <img src={img.url} alt={img.name} className="w-8 h-8 rounded border border-[var(--border)] object-cover" />
                    <button onClick={() => removePendingImage(idx)} className="chat-composer-action absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" aria-label={`移除图片 ${img.name}`}>
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Textarea — 排版参数与CSS .chat-input-box对齐 */}
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              placeholder={activeConv && isConvStreaming(activeConv?.id || '') ? "当前回复生成中，可先停止接收" : isBipProject ? `向 ${activeAgent?.name || '当前步骤'} 补充信息或提出任务，不清楚也可以直接说` : `向 ${activeConv?.agentName || 'AI'} 发消息，使用 @ 一次性调用其他智能体`}
              aria-label={`向 ${activeConv?.agentName || "AI"} 发送消息`}
              className="w-full resize-none text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] bg-transparent outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 box-border"
              style={{
                height: textareaHeight + 'px',
                minHeight: TEXTAREA_MIN_HEIGHT + 'px',
                maxHeight: isInputExpanded ? '500px' : TEXTAREA_MAX_HEIGHT + 'px',
                fontSize: '16px',
                lineHeight: '1.65',
                padding: '13px 18px',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
                overflowX: 'hidden',
                overflowY: textareaOverflowY,
                transition: 'height 0.15s ease',
              }}
              rows={1}
            />
            {/* Bottom toolbar — 对齐 textarea padding */}
            <div className="flex items-center justify-between w-full px-[18px] pb-3.5">
              <div className="flex items-center gap-1">
                <button onClick={() => fileInputRef.current?.click()} className="chat-composer-action flex-shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-full text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors" title="上传图片" aria-label="上传图片">
                  <ImagePlus className="w-[18px] h-[18px]" />
                </button>
              </div>
              <div className="flex items-center gap-1">
                {/* Stop or Send button */}
                {activeConv && isConvStreaming(activeConv.id) ? (
                  <button onClick={() => abortCurrentStream(activeConv.id)} className="chat-composer-action flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-red-500/10 hover:text-red-500 hover:border-red-300" title="停止接收；已提交的付费任务继续处理并按实际用量结算" aria-label="停止接收">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /></svg>
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!inputValue.trim() && pendingImages.length === 0}
                    className={cn(
                      "chat-composer-action chat-send-button flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all text-white shadow-sm shadow-[#1677FF]/25",
                      !inputValue.trim() && pendingImages.length === 0
                        ? "cursor-not-allowed"
                        : "bg-[#1677FF] hover:bg-[#0958D9] hover:shadow-md hover:shadow-[#1677FF]/35 active:scale-95"
                    )}
                    title="发送"
                    aria-label="发送消息"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M1 7L13 1L7 13L6 8L1 7Z" fill="currentColor" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
export default ChatView;
