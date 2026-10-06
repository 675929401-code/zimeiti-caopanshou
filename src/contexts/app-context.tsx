"use client";

/**
 * 🔒 核心底层代码 — 锁定保护
 *
 * 本文件是全局状态管理核心，包含三套流式消费函数（sendLLMMessage + sendCozeMessage + sendCozeCodingMessage）+ 定时器节流。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #10 全局状态管理"。
 *
 * 锁定范围：整个文件
 * 锁定原因：全局状态是数据流枢纽，三套 send 函数 + 定时器节流是流式输出性能关键路径
 *
 * 关键函数：
 * - sendLLMMessage：LLM 流式消费核心（含 RAF 节流 dispatch）
 * - sendCozeMessage：Coze 流式消费核心（SSE 事件解析 + content 累积）
 * - sendCozeCodingMessage：Coze Coding 流式消费核心（stream_run SSE 解析）
 * - throttledDispatchUpdate：RAF节流（与浏览器paint对齐，丝滑流式输出）
 * - pendingContentRef / pendingReasoningRef / streamingRafRef：节流状态
 *
 * ⚠️ 经用户同意修改（2026-06-22）：
 * - 从 setTimeout(42ms) 定时器节流迁移到 requestAnimationFrame 节流
 * - 原因：setTimeout 不与浏览器 paint 周期对齐，导致"憋着然后爆发"
 * - RAF 在每次浏览器重绘前 dispatch，实现真正的逐帧增量渲染
 * - 流结束后立即 cancelAnimationFrame + flush，确保无残留
 */

import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from "react";
import type { Agent, Conversation, Message, CreditsInfo, AuthUser, PresetField, PageLayoutConfig, OutputStyle } from "@/types/coze";
import { toast } from "sonner";
import { DEFAULT_PAGE_LAYOUT } from "@/types/coze";
import { parseThinkTags } from "@/lib/think-instruction";
import {
  classifyError,
  shouldCleanupFailedMessage,
  removeFailedMessagePair,
  annotateCollabMessages,
  needsCollabPrompt,
  COLLAB_SYSTEM_PROMPT,
} from "@/lib/chat-pipeline";
import { SseEventStreamDecoder } from "@/lib/sse-stream-decoder";
import { knownChatFailureMessage } from "@/lib/chat-customer-failure";

import { STORAGE_KEYS } from "@/lib/storage-keys";
import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  normalizeTheme,
  normalizeThemeModePreference,
  resolveRenderedTheme,
  resolveThemeModeForTheme,
  type ThemeMode,
  type ThemeModePreference,
} from "@/lib/themes";
import { safeGetItem as safeGet, safeSetItem as safeSet, safeRemoveItem as safeRemove } from "@/lib/safe-storage";
import {
  getClientBootstrapAuthMe,
  getClientBootstrapAppearance,
  getClientBootstrapLayout,
  invalidateClientBootstrapAuthMe,
  invalidateClientBootstrapAppearance,
  invalidateClientBootstrapLayout,
} from "@/lib/client-bootstrap-cache";
import {
  appendImageMemoryToMessage,
  getHybridImageConfig,
  isImageGenerationModelName,
  shouldTriggerHybridImage,
} from "@/lib/hybrid-image-routing";
import { appendImageWorkbenchPromptTransfer } from "@/lib/image-workbench-transfer";
import {
  clearConversationCache,
} from "@/lib/conversation-cache";
import {
  createVirtualChatAgent,
  FREE_CHAT_AGENT_ID,
  isVirtualChatAgentId,
} from "@/lib/virtual-chat-agents";
import { clearMarketplaceReturnIntent } from "@/lib/marketplace-navigation";
import { shouldReturnUnauthenticatedVisitorHome } from "@/lib/auth-route-boundary";

import { isAbortLikeError, isLocalConvId, fetchWithRetry } from "./chat-utils";
import { enrichHistoryMessageIdentity, mapHistoryMessages } from "./history-message-mapper";
import { releaseConversationSend, tryAcquireConversationSend } from "./pending-send-lock";
import { type AppState, type Action as AppAction, reducer, initialState, defaultCredits } from "./chat-reducer";

export type { AppState, AppAction };

// ---- Context ----
interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  fetchAgents: () => Promise<void>;
  startChat: (agentId: string, requestedConversationId?: string) => string | null;
  startFreeChat: (options?: { agentId?: string; conversationName?: string; title?: string }) => void;
  sendMessage: (content: string, mentionedAgentId?: string, images?: string[], modelOverride?: string, apiContent?: string, deepThinkingOverride?: number, webSearchOverride?: boolean, skipUserMessage?: boolean, retryUserMessageId?: string) => Promise<boolean>;
  abortCurrentStream: (convId?: string) => void;
  isConvStreaming: (convId: string) => boolean;
  selectConversation: (conversationId: string) => void;
  loadMessagesForConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => void;
  togglePinAgent: (agentId: string) => void;
  fetchCredits: () => Promise<void>;
  rechargeCredits: (amount: number) => Promise<void>;
  login: (username: string, password: string, securityAnswer?: string) => Promise<{ success: boolean; error?: string; code?: string; securityQuestion?: string; region?: { province: string; city: string } }>;
  logout: () => void;
  saveUserThemePreference: (theme: string) => Promise<void>;
  setThemeModePreference: (preference: ThemeModePreference) => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
  register: (email: string, phone: string, code: string, displayName?: string, password?: string, invitationCode?: string, deviceId?: string) => Promise<{ success: boolean; error?: string }>;
  checkAuth: () => Promise<void>;
  toggleMode: () => void;
  fetchLayoutConfig: () => Promise<void>;
  saveLayoutConfig: (layout: PageLayoutConfig) => Promise<void>;
  resetLayoutConfig: () => Promise<void>;
  setPendingPresetMessage: (msg: { convId: string; content: string; autoSend?: boolean } | null) => void;
  pendingPresetMessage: { convId: string; content: string; autoSend?: boolean } | null;
  forcedLogoutReason: string | null;
  clearForcedLogout: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function hasAssistantHistoryMessage(conv: Conversation) {
  return conv.messages.some((message) =>
    message.role === "assistant" &&
    Boolean(message.content?.trim() || message.reasoningContent?.trim() || message.generatedImages?.length)
  );
}

const MAX_INLINE_CHAT_IMAGE_CHARS = 12 * 1024 * 1024;
const SAFE_INLINE_CHAT_IMAGE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\r\n]+$/i;

// Paint the first provider text immediately, then keep every RAF increment
// visibly progressive. A large upstream chunk must never collapse into a
// one-frame block. Provider deltas remain visibly progressive without leaving
// Markdown in tiny half-token states long enough to flicker or feel sluggish.
const TYPEWRITER_MIN_STEP = 1;
const TYPEWRITER_MAX_STEP = 64;
const TYPEWRITER_TARGET_CATCHUP_FRAMES = 6;

function safeTypewriterBoundary(target: string, requestedEnd: number): number {
  let end = Math.min(requestedEnd, target.length);
  if (end >= target.length) return target.length;

  // Never paint half an emoji/supplementary character. Extend combining
  // marks, variation selectors and ZWJ emoji sequences as one visual glyph,
  // preventing the replacement-character flash seen in CJK/emoji output.
  const previous = target.charCodeAt(end - 1);
  const next = target.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1;

  const trailingGlyphPart = /[\u0300-\u036f\ufe00-\ufe0f\u{1f3fb}-\u{1f3ff}]/u;
  while (end < target.length) {
    const rest = target.slice(end);
    const first = Array.from(rest)[0] || "";
    if (trailingGlyphPart.test(first)) {
      end += first.length;
      continue;
    }
    if (first === "\u200d") {
      end += 1;
      const joined = Array.from(target.slice(end))[0] || "";
      end += joined.length;
      continue;
    }
    break;
  }
  return end;
}

function takeTypewriterSlice(current: string, target: string, framesRemaining: number): string {
  if (current === target) return current;
  if (!target.startsWith(current)) return target;
  const remaining = target.length - current.length;
  const step = Math.min(
    TYPEWRITER_MAX_STEP,
    Math.max(TYPEWRITER_MIN_STEP, Math.ceil(remaining / Math.max(1, framesRemaining))),
  );
  const requestedEnd = current.length + Math.min(step, remaining);
  return target.slice(0, safeTypewriterBoundary(target, requestedEnd));
}

function toLlmImageUrl(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.startsWith("data:")) {
    if (normalized.length > MAX_INLINE_CHAT_IMAGE_CHARS || !SAFE_INLINE_CHAT_IMAGE.test(normalized)) return null;
    return normalized;
  }
  // Legacy callers pass an opaque owned-storage key. Never forward an arbitrary
  // client URL or local file URI through the generic chat pipeline.
  if (/^(?:https?:|file:|blob:|javascript:)/i.test(normalized) || normalized.length > 2048) return null;
  return `/api/file?key=${encodeURIComponent(normalized)}`;
}

function persistStoredAuthSession(token: string, user: AuthUser): void {
  // A different token is a different cache scope. Evict the prior identity
  // before publishing the new local session.
  invalidateClientBootstrapAuthMe();
  safeSet(STORAGE_KEYS.AUTH_TOKEN, token);
  safeSet(STORAGE_KEYS.AUTH_USER, JSON.stringify(user));
}

function clearStoredAuthSession(): void {
  invalidateClientBootstrapAuthMe();
  safeRemove(STORAGE_KEYS.AUTH_TOKEN);
  safeRemove(STORAGE_KEYS.AUTH_USER);
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveAppearance(
  requestedTheme: string | null | undefined,
  requestedModePreference?: string | null,
): { theme: string; modePreference: ThemeModePreference; mode: ThemeMode } {
  const theme = normalizeTheme(requestedTheme);
  const modePreference = normalizeThemeModePreference(requestedModePreference)
    || DEFAULT_MODE_PREFERENCE;
  return {
    theme,
    modePreference,
    mode: resolveThemeModeForTheme(theme, modePreference, systemPrefersDark()),
  };
}

function renderedThemeForAppearance(appearance: {
  theme: string;
  modePreference: ThemeModePreference;
  mode: ThemeMode;
}): string {
  return resolveRenderedTheme(appearance.theme, appearance.modePreference, appearance.mode);
}

const AUTH_LOGOUT_REASON_KEY = "auth_logout_reason";

function replaceWithPublicHome(reason?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (reason) sessionStorage.setItem(AUTH_LOGOUT_REASON_KEY, reason);
    sessionStorage.removeItem("entered_app");
    sessionStorage.removeItem("trial_dialog_dismissed");
    clearMarketplaceReturnIntent();
  } catch {}
  if (window.location.pathname === "/") {
    window.location.reload();
  } else {
    window.location.replace("/");
  }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // AbortController map for cancelling ongoing stream requests (one per conversation)
  const abortControllerMap = useRef<Map<string, AbortController>>(new Map());
  // Track which conversations were aborted by the user (vs. network errors/timeouts)
  const userAbortedSet = useRef<Set<string>>(new Set());
  // Track watchdog cancellations separately so an automatic timeout is never shown as a user stop.
  const watchdogAbortedSet = useRef<Set<string>>(new Set());
  // Legacy ref kept for compatibility with code that reads .current
  const abortControllerRef = useRef<AbortController | null>(null);
  const getOrCreateAbortController = (convId: string): AbortController => {
    const existing = abortControllerMap.current.get(convId);
    // 如果已有 controller 但已经被 abort（遗留），删除后创建新的
    if (existing && existing.signal.aborted) {
      abortControllerMap.current.delete(convId);
    }
    if (!abortControllerMap.current.has(convId)) {
      // A new stream owns fresh abort state. Never inherit a previous request's reason.
      userAbortedSet.current.delete(convId);
      watchdogAbortedSet.current.delete(convId);
      abortControllerMap.current.set(convId, new AbortController());
    }
    const ctrl = abortControllerMap.current.get(convId)!;
    abortControllerRef.current = ctrl; // keep legacy ref in sync
    return ctrl;
  };
  const finalizeAbortController = (convId: string, controller: AbortController): void => {
    // An older request must never delete or relabel a newer request for the same conversation.
    if (abortControllerMap.current.get(convId) !== controller) return;
    abortControllerMap.current.delete(convId);
    userAbortedSet.current.delete(convId);
    watchdogAbortedSet.current.delete(convId);
  };

  // ── 客户端 hydration 初始化：从 localStorage/document 恢复持久化状态 ──
  // 必须在 useEffect 中读取，避免 SSR/客户端 initialState 不一致导致 Hydration mismatch
  useEffect(() => {
    try {
      const validViews = ["marketplace", "chat", "format", "segment", "cover", "create", "extract"] as const;
      const storedView = safeGet(STORAGE_KEYS.ACTIVE_VIEW);
      if (storedView && validViews.includes(storedView as typeof validViews[number])) {
        dispatch({ type: "SET_ACTIVE_VIEW", payload: storedView as typeof validViews[number] });
      }
    } catch {}
    //G 刷新位置保持：同步恢复 activeConversationId，避免 ChatView 因 activeConv=undefined 显示空状态
    try {
      const savedActiveId = safeGet(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
      if (savedActiveId) {
        dispatch({ type: "SET_ACTIVE_CONVERSATION", payload: savedActiveId });
      }
    } catch {}
    // 注意：不再在此处 dispatch SET_THEME / SET_MODE
    // 主题的 DOM→state 反向同步已由下方的 themeSyncedRef effect 首次渲染时处理
    // 避免重复 dispatch 导致多余重渲染
    try {
      const sw = safeGet(STORAGE_KEYS.SIDEBAR_WIDTH);
      if (sw) dispatch({ type: "SET_SIDEBAR_WIDTH", payload: parseInt(sw, 10) });
    } catch {}
    try {
      const sc = safeGet(STORAGE_KEYS.SIDEBAR_COLLAPSED);
      if (sc === "true") dispatch({ type: "SET_SIDEBAR_COLLAPSED", payload: true });
    } catch {}
  }, []);

  // Load pinned agents from localStorage
  useEffect(() => {
    try {
      const stored = safeGet(STORAGE_KEYS.PINNED_AGENT_IDS);
      if (stored) {
        dispatch({ type: "SET_PINNED", payload: JSON.parse(stored) });
      }
    } catch {
      // ignore
    }
  }, []);

  // Save pinned agents to localStorage
  useEffect(() => {
    try {
      safeSet(STORAGE_KEYS.PINNED_AGENT_IDS, JSON.stringify(state.pinnedAgentIds));
    } catch {
      // ignore
    }
  }, [state.pinnedAgentIds]);

  // Enrich conversations with agent info whenever agents list changes
  // This ensures all conversations show correct agent name/avatar even after reload
  useEffect(() => {
    if (state.agents.length === 0 || state.conversations.length === 0) return;
    let needsUpdate = false;
    const enriched = state.conversations.map(conv => {
      const identity = conv.agentId || conv.botId || "";
      const agent = identity
        ? state.agents.find(a => a.id === identity || a.botId === identity)
        : undefined;
      const messages = enrichHistoryMessageIdentity(conv.messages, state.agents, identity);
      const agentName = conv.agentName || agent?.name || "";
      const agentIconUrl = conv.agentIconUrl || agent?.iconUrl || "";
      if (messages === conv.messages && agentName === conv.agentName && agentIconUrl === conv.agentIconUrl) return conv;
      needsUpdate = true;
      return {
        ...conv,
        agentName,
        agentIconUrl,
        messages,
      };
    });
    if (needsUpdate) {
      dispatch({ type: "SET_CONVERSATIONS", payload: enriched });
    }
  }, [state.agents, state.conversations]);

  // ── AIWeb-style: Server-first, no localStorage for messages ──
  // Like AIWeb: 
  //   - /api/group/query → load conversation list (metadata only)
  //   - /api/chatlog/chatList → load messages when user opens a conversation
  //   - recordState() → only save active conv ID to localStorage
  //   - After each chat, immediately sync to server
  // Server is the single source of truth. No merge logic.

  const conversationsRef = useRef(state.conversations);
  conversationsRef.current = state.conversations;
  const activeConversationIdRef = useRef(state.activeConversationId);
  activeConversationIdRef.current = state.activeConversationId;
  const streamingConvIdsRef = useRef(state.streamingConvIds);
  streamingConvIdsRef.current = state.streamingConvIds;
  const pendingSendConversationIdsRef = useRef<Set<string>>(new Set());
  const initialLoadDone = useRef(false);
  const isStreamingRef = useRef(false);
  const pendingLocalConversationsRef = useRef<Map<string, Conversation>>(new Map());

  const rememberPendingLocalConversation = useCallback((conversation: Conversation) => {
    pendingLocalConversationsRef.current.set(conversation.id, conversation);
  }, []);

  const forgetPendingLocalConversation = useCallback((conversationId: string) => {
    pendingLocalConversationsRef.current.delete(conversationId);
  }, []);

  // Track auth state via ref so useCallback closures always get the latest value
  const authRef = useRef(state.auth);
  authRef.current = state.auth;
  const checkAuthInFlightRef = useRef<{ token: string | null; promise: Promise<void> } | null>(null);

  // Track streaming state to suppress sync during streaming
  useEffect(() => {
    isStreamingRef.current = state.isStreaming;
  }, [state.isStreaming]);

  // ── isStreaming 安全网：防止因异常导致状态永久锁死 ──
  // 当 isStreaming 持续超过 300 秒未恢复，自动重置（与推理模型最大超时一致）
  // 注意：120秒太短，推理模型 TTFB 可达 200+ 秒
  useEffect(() => {
    if (!state.isStreaming) return;
    const timer = setTimeout(() => {
      if (isStreamingRef.current) {
        console.error("[app-context] isStreaming stuck for 300s, auto-resetting. streamingConvIds:", [...state.streamingConvIds]);
        // 标记为自动安全网终止，不能伪装成用户主动点击“停止”。
        abortControllerMap.current.forEach((_: AbortController, id: string) => {
          watchdogAbortedSet.current.add(id);
        });
        abortControllerMap.current.forEach((ac: AbortController) => { try { ac.abort(); } catch {} });
        dispatch({ type: "SET_IS_STREAMING", payload: false }); // Also clears streamingConvIds
      }
    }, 300_000);
    return () => clearTimeout(timer);
  }, [state.isStreaming]);

  // ── AIWeb's recordState: only save active conv ID to localStorage ──
  // This is what AIWeb does — store only the "active" pointer, NOT messages
  useEffect(() => {
    try {
      if (state.activeConversationId) {
        safeSet(STORAGE_KEYS.ACTIVE_CONVERSATION_ID, state.activeConversationId);
      } else {
        safeRemove(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
      }
    } catch {
      // ignore
    }
  }, [state.activeConversationId]);

  // Retire browser message-body cache bytes on every client boot. Account
  // conversation history is restored only from the authenticated server API.
  useEffect(() => {
    clearConversationCache();
  }, []);

  // Load conversation list from server (METADATA ONLY — like AIWeb's queryMyGroup)
  // No dependency on agents — load independently for speed
  useEffect(() => {
    const controller = new AbortController();
    const abortForPageLifecycle = () => controller.abort();
    window.addEventListener("pagehide", abortForPageLifecycle);
    if (state.auth.isAuthenticated && !initialLoadDone.current) {
      void loadFromServer(controller.signal);
    }
    if (!state.auth.isAuthenticated) {
      initialLoadDone.current = false;
    }
    return () => {
      window.removeEventListener("pagehide", abortForPageLifecycle);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.auth.isAuthenticated]);

  const loadFromServer = async (signal?: AbortSignal) => {
    try {
      const token = safeGet(STORAGE_KEYS.AUTH_TOKEN);
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      // ── Step 2: 从服务端获取最新数据 ──
      const res = await fetch("/api/conversations/history", { headers, signal });
      if (!res.ok) {
        // Keep the current in-memory view; browser history cache is retired.
        initialLoadDone.current = true;
        return;
      }
      const data = await res.json();

      if (!data.conversations?.length) {
        dispatch({ type: "SET_CONVERSATIONS", payload: [] });
        initialLoadDone.current = true;
        return;
      }

      // 服务端数据
      const serverConvs: Conversation[] = data.conversations.map((conv: Record<string, unknown>) => {
        const updatedTime = conv.updated_at ? new Date(conv.updated_at as string).getTime() : Date.now();
        const createdTime = conv.created_at ? new Date(conv.created_at as string).getTime() : updatedTime;
        const agentId = (conv.agent_id as string) || "";
        // 从已加载的 agents 列表补全服务端会话的展示名称与图标。
        // 同时按 botId 查找回退，处理 chat/route 存储 Coze botId 的情况
        const matchedAgent = agentId
          ? (state.agents.find((a) => a.id === agentId) || state.agents.find((a) => a.botId && a.botId === agentId))
          : null;
        return {
          id: conv.id as string,
          // botId 必须来自 matchedAgent，不能回退到 agentId（LLM 智能体 botId 为 null）
          botId: matchedAgent?.botId ?? null,
          agentId,
          agentName: matchedAgent?.name || "",
          agentIconUrl: matchedAgent?.iconUrl || "",
          title: (conv.title as string) || "",
          lastMessage: (conv.last_message as string) || "",
          lastMessageTime: updatedTime,
          createdAt: createdTime,
          updatedAt: updatedTime,
          messages: [],
          messagesLoaded: false,
          dirty: false,
        };
      });

      // Backfill agentName/agentIconUrl from agents list for server-restored conversations
      // ⚠️ 对话元数据不可变原则：agentId/botId 在创建时确定，后续只补全缺失的展示字段
      // 绝不修改 agentId（即使是 Coze botId 格式），避免破坏对话-智能体绑定
      const backfilledConvs = serverConvs.map(conv => {
        if (!conv.agentId) return conv;
        const matchedAgent = state.agents.find(a => a.id === conv.agentId)
          || state.agents.find(a => a.botId && a.botId === conv.agentId);
        if (!matchedAgent) return conv;
        // 只补全缺失的展示字段，不修改身份字段
        if (conv.agentName && conv.agentIconUrl) return conv;
        return {
          ...conv,
          agentName: conv.agentName || matchedAgent.name,
          agentIconUrl: conv.agentIconUrl || matchedAgent.iconUrl || "",
        };
      });

      // 生产域名历史接口比本地慢时，用户可能已经点了「新建对话」。
      // 这些 local_/conv_ 会话还没来得及同步到服务端，不能被稍后返回的旧服务端列表覆盖，
      // 否则 UI 会从 ChatView 被误判回应用广场，表现为“点击发送没反应 / 搜索框吞掉输入”。
      const activeIdBeforeReplace = safeGet(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
      const hydratedIds = new Set(backfilledConvs.map((conversation) => conversation.id));
      const pendingLocalConvMap = new Map<string, Conversation>();
      const rememberIfPending = (conversation: Conversation) => {
        if (hydratedIds.has(conversation.id)) return;
        if (
          isLocalConvId(conversation.id) ||
          conversation.dirty === true ||
          conversation.id === activeIdBeforeReplace
        ) {
          pendingLocalConvMap.set(conversation.id, conversation);
        }
      };
      for (const conversation of pendingLocalConversationsRef.current.values()) {
        rememberIfPending(conversation);
      }
      for (const conversation of conversationsRef.current) {
        rememberIfPending(conversation);
      }
      if (
        activeIdBeforeReplace &&
        isLocalConvId(activeIdBeforeReplace) &&
        !hydratedIds.has(activeIdBeforeReplace) &&
        !pendingLocalConvMap.has(activeIdBeforeReplace)
      ) {
        const fallbackAgentId = activeConversationIdRef.current === activeIdBeforeReplace
          ? (state.activeAgentId || FREE_CHAT_AGENT_ID)
          : FREE_CHAT_AGENT_ID;
        const fallbackAgent =
          state.agents.find((agent) => agent.id === fallbackAgentId) ||
          createVirtualChatAgent(fallbackAgentId) ||
          createVirtualChatAgent(FREE_CHAT_AGENT_ID);
        if (fallbackAgent) {
          pendingLocalConvMap.set(activeIdBeforeReplace, {
            id: activeIdBeforeReplace,
            agentId: fallbackAgent.id,
            botId: fallbackAgent.botId || fallbackAgent.id,
            agentName: fallbackAgent.name,
            agentIconUrl: fallbackAgent.iconUrl,
            title: fallbackAgent.id === FREE_CHAT_AGENT_ID ? "新对话" : `与 ${fallbackAgent.name} 的对话`,
            lastMessage: "",
            lastMessageTime: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            messagesLoaded: true,
            dirty: true,
          });
        }
      }
      const pendingLocalConvs = [...pendingLocalConvMap.values()];
      const hydratedConvs = [...pendingLocalConvs, ...backfilledConvs]
        .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

      dispatch({ type: "SET_CONVERSATIONS", payload: hydratedConvs });

      // Restore every known virtual agent referenced by persisted conversations.
      const persistedVirtualIds = [...new Set(
        hydratedConvs.map((conversation) => conversation.agentId).filter(isVirtualChatAgentId),
      )];
      const missingVirtualAgents = persistedVirtualIds
        .filter((agentId) => !state.agents.some((agent) => agent.id === agentId))
        .map(createVirtualChatAgent)
        .filter((agent): agent is Agent => Boolean(agent));
      if (missingVirtualAgents.length > 0) {
        dispatch({ type: "ADD_AGENTS", payload: missingVirtualAgents });
      }

      // Restore active conversation from localStorage
      const savedActiveId = safeGet(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
      if (savedActiveId && hydratedConvs.some(c => c.id === savedActiveId)) {
        dispatch({ type: "SET_ACTIVE_CONVERSATION", payload: savedActiveId });
        const activeConv = hydratedConvs.find(c => c.id === savedActiveId);
        if (activeConv?.agentId) {
          dispatch({ type: "SET_ACTIVE_AGENT", payload: activeConv.agentId });
        }
        //G 刷新位置保持：仅当用户上次的视图是 chat 时才恢复到聊天界面
        // 如果用户在应用广场刷新，应留在应用广场，不因有活跃对话就强制跳转
        const lastView2 = safeGet(STORAGE_KEYS.ACTIVE_VIEW);
        if (lastView2 === "chat") {
          dispatch({ type: "SET_VIEW", payload: "chat" });
        }
        // local_/conv_ 只表示 ID 最初由浏览器生成，不代表它仍是纯本地会话。
        // /api/llm 会沿用该 ID 持久化会话；刷新后若它已出现在服务端列表，
        // 必须继续加载服务端 messages。仅对服务端列表中不存在的纯本地会话
        // 保留短路，避免无意义的 404 fetch 和重复恢复循环。
        const activeConversationIsServerPersisted = serverConvs.some((conversation) => conversation.id === savedActiveId);
        if (isLocalConvId(savedActiveId) && !activeConversationIsServerPersisted) {
          dispatch({ type: "MARK_CONVERSATION_LOADED", payload: savedActiveId });
          initialLoadDone.current = true;
          return;
        }
        // 如果缓存已经提供了消息，跳过网络请求
        if (activeConv?.messagesLoaded && activeConv.messages.length > 0) {
          // 缓存恢复的消息已经可用，但仍异步从服务端刷新以确保最新
          fetch(`/api/conversations/history?id=${savedActiveId}`, { headers, signal })
            .then(r => r.ok ? r.json() : null)
            .then(msgData => {
              if (!msgData) return;
              const serverMessages = mapHistoryMessages(msgData.conversation?.messages || msgData.messages || []);
              if (serverMessages.length > 0) {
                dispatch({ type: "SET_MESSAGES_FOR_CONVERSATION", payload: { conversationId: savedActiveId, messages: serverMessages } });
              }
            })
            .catch(() => {}); // 静默失败，缓存消息仍然可用
        } else {
          // 缓存没有消息，从服务端加载
          const msgRes = await fetch(`/api/conversations/history?id=${savedActiveId}`, { headers, signal });
          if (msgRes.ok) {
            const msgData = await msgRes.json();
            const loadedMessages = mapHistoryMessages(msgData.conversation?.messages || msgData.messages || []);
            if (loadedMessages.length) {
              dispatch({ type: "SET_MESSAGES_FOR_CONVERSATION", payload: { conversationId: savedActiveId, messages: loadedMessages } });
              dispatch({ type: "MARK_CONVERSATION_LOADED", payload: savedActiveId });
            }
          }
        }
      }

      //G 刷新位置保持：加载完成后，校验 activeConversationId 有效性
      // 如果 activeConversationId 指向的对话不在列表中，清除并回退到 marketplace
      const finalActiveId = safeGet(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
      if (finalActiveId && !hydratedConvs.some(c => c.id === finalActiveId)) {
        dispatch({ type: "SET_ACTIVE_CONVERSATION", payload: null });
        dispatch({ type: "SET_ACTIVE_AGENT", payload: null });
        dispatch({ type: "SET_VIEW", payload: "marketplace" });
        safeRemove(STORAGE_KEYS.ACTIVE_CONVERSATION_ID);
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      console.error("[loadFromServer] Error:", err);
    } finally {
      if (!signal?.aborted) initialLoadDone.current = true;
    }
  };

  // ── AIWeb-style: sync conversation metadata to server ──
  // Messages are saved by backend (LLM/chat route) directly to conversation_messages table
  // Frontend only syncs metadata (title, agentId) — like AIWeb's recordState
  const metadataSyncTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const metadataSyncInFlight = useRef(new Map<string, string | null>());
  useEffect(() => () => {
    for (const timer of metadataSyncTimers.current.values()) clearTimeout(timer);
    metadataSyncTimers.current.clear();
  }, []);

  const syncConversationToServer = useCallback(async (convId: string, retryAttempt = 0): Promise<void> => {
    if (isStreamingRef.current) return;
    const conv = conversationsRef.current.find(c => c.id === convId);
    if (!conv) return;
    if (!hasAssistantHistoryMessage(conv)) return;

    const token = safeGet(STORAGE_KEYS.AUTH_TOKEN);
    if (!token || metadataSyncInFlight.current.get(convId) === token) return;
    const pendingTimer = metadataSyncTimers.current.get(convId);
    if (pendingTimer) clearTimeout(pendingTimer);
    metadataSyncTimers.current.delete(convId);
    metadataSyncInFlight.current.set(convId, token);
    const snapshot = {
      conversationId: convId, updatedAt: conv.updatedAt,
      title: conv.title || "", agentId: conv.agentId, source: conv.source || "llm",
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const response = await fetch("/api/conversations/history", {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          conversation: {
            id: conv.id,
            agentId: conv.agentId,
            title: conv.title || "",
            source: conv.source || "llm",
          },
        }),
      });
      if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
      if ([400, 401, 403, 404].includes(response.status)) return;
      if (!response.ok) throw new Error("CONVERSATION_METADATA_SYNC_FAILED");
      dispatch({ type: "MARK_CLEAN", payload: snapshot });
    } catch {
      if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
      const delay = [1000, 3000, 10000][retryAttempt];
      if (delay !== undefined) {
        metadataSyncTimers.current.set(convId, setTimeout(() => {
          metadataSyncTimers.current.delete(convId);
          if (safeGet(STORAGE_KEYS.AUTH_TOKEN) === token) {
            void syncConversationToServer(convId, retryAttempt + 1);
          }
        }, delay));
      }
    } finally {
      if (metadataSyncInFlight.current.get(convId) === token) {
        metadataSyncInFlight.current.delete(convId);
      }
    }
  }, []);

  // ── AIWeb-style: NO visibilitychange reload ──
  // AIWeb doesn't reload on tab focus — it trusts server data from initial load
  // Removed the old visibilitychange handler that caused "popping" behavior

  // ── Load messages for a single conversation on demand ──
  // Like AIWeb's queryActiveChatLogList — called when user opens a conversation
  // 增强：服务端失败或无消息时，从本地缓存恢复（中断恢复场景）
  // 增强：合并而非替换 — 保留内存中尚未持久化的流式消息
  const loadMessagesForConversation = useCallback(async (conversationId: string) => {
    const conv = conversationsRef.current.find(c => c.id === conversationId);
    // Skip if already loaded
    if (!conv || conv.messagesLoaded) return;

    // 保存当前内存中的消息（可能包含正在流式输出、尚未存到DB的消息）
    const inMemoryMessages = conv.messages || [];

    try {
      const token = safeGet(STORAGE_KEYS.AUTH_TOKEN);
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      // Use ?id= param to load single conversation with messages (like AIWeb's /chatlog/chatList)
      const res = await fetch(`/api/conversations/history?id=${encodeURIComponent(conversationId)}`, { headers });
      if (res.ok) {
        const data = await res.json();
        const messagesData = data.conversation?.messages || data.messages || [];
        if (messagesData.length) {
          const dbMessages = mapHistoryMessages(messagesData);
          // 合并：DB消息为主 + 内存中DB没有的消息（正在流式输出的消息）
          const dbMsgIds = new Set(dbMessages.map(m => m.id));
          const extraInMemory = inMemoryMessages.filter(
            m => !dbMsgIds.has(m.id) && m.content
          );
          const merged = extraInMemory.length > 0
            ? [...dbMessages, ...extraInMemory]
            : dbMessages;
          dispatch({ type: "SET_MESSAGES_FOR_CONVERSATION", payload: { conversationId, messages: merged } });
          return;
        }
      }

      // The server is authoritative. A missing history response cannot be
      // replaced with stale browser messages.
      dispatch({ type: "SET_MESSAGES_FOR_CONVERSATION", payload: { conversationId, messages: [] } });
    } catch (err) {
      console.error("[loadMessagesForConversation] Error:", err);
      dispatch({ type: "SET_MESSAGES_FOR_CONVERSATION", payload: { conversationId, messages: [] } });
    }
  }, []);

  // Sync the independent theme key, mode preference and resolved mode.
  // layout.tsx has already applied all three before hydration, so the first
  // pass only adopts those values and never repaints the page with defaults.
  const themeSyncedRef = useRef(false);
  const themePreferenceSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const appearanceIntentRef = useRef<{ theme: string; modePreference: ThemeModePreference }>({
    theme: DEFAULT_THEME,
    modePreference: DEFAULT_MODE_PREFERENCE,
  });
  useEffect(() => {
    const effectiveTheme = normalizeTheme(state.theme || DEFAULT_THEME);
    const effectiveModePreference = state.modePreference;
    const effectiveMode = state.mode;
    appearanceIntentRef.current = {
      theme: effectiveTheme,
      modePreference: effectiveModePreference,
    };
    const renderedTheme = resolveRenderedTheme(effectiveTheme, effectiveModePreference, effectiveMode);
    const root = document.documentElement;

    if (!themeSyncedRef.current) {
      themeSyncedRef.current = true;
      try {
        const domTheme = normalizeTheme(
          root.getAttribute("data-theme-selection") || root.getAttribute("data-theme"),
        );
        const domPreference = normalizeThemeModePreference(root.getAttribute("data-mode-preference"))
          || DEFAULT_MODE_PREFERENCE;
        const domModeValue = root.getAttribute("data-mode");
        const domMode: ThemeMode = domModeValue === "light" || domModeValue === "dark"
          ? domModeValue
          : resolveThemeModeForTheme(domTheme, domPreference, systemPrefersDark());
        if (
          domTheme !== effectiveTheme
          || domPreference !== effectiveModePreference
          || domMode !== effectiveMode
        ) {
          dispatch({
            type: "SET_APPEARANCE",
            payload: { theme: domTheme, modePreference: domPreference, mode: domMode },
          });
        }
        safeSet(STORAGE_KEYS.APP_THEME, domTheme);
        safeSet(STORAGE_KEYS.APP_MODE, domMode);
      } catch {}
      return;
    }

    try {
      if (root.getAttribute("data-theme-selection") !== effectiveTheme) {
        root.setAttribute("data-theme-selection", effectiveTheme);
      }
      if (root.getAttribute("data-theme") !== renderedTheme) root.setAttribute("data-theme", renderedTheme);
      if (root.getAttribute("data-mode-preference") !== effectiveModePreference) {
        root.setAttribute("data-mode-preference", effectiveModePreference);
      }
      if (root.getAttribute("data-mode") !== effectiveMode) root.setAttribute("data-mode", effectiveMode);
      safeSet(STORAGE_KEYS.APP_THEME, effectiveTheme);
      safeSet(STORAGE_KEYS.APP_MODE, effectiveMode);
    } catch {}
  }, [state.theme, state.modePreference, state.mode]);

  // System changes only affect the page after the user has selected “自动”.
  useEffect(() => {
    if (state.modePreference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemMode = (event?: MediaQueryListEvent) => {
      dispatch({
        type: "SET_MODE",
        payload: resolveThemeModeForTheme(state.theme, "system", event?.matches ?? media.matches),
      });
    };
    syncSystemMode();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", syncSystemMode);
      return () => media.removeEventListener("change", syncSystemMode);
    }
    media.addListener(syncSystemMode);
    return () => media.removeListener(syncSystemMode);
  }, [state.theme, state.modePreference]);

  // Platform settings are authoritative for visitors and for accounts whose
  // seven-day, IP-scoped preference is absent or invalid. localStorage only
  // mirrors an already validated server response and never proves validity.
  useEffect(() => {
    const applyAppearance = (newTheme: string, modePreference?: string | null) => {
      const appearance = resolveAppearance(newTheme, modePreference);
      const root = document.documentElement;
      const renderedTheme = renderedThemeForAppearance(appearance);
      if (
        root.getAttribute("data-theme-selection") !== appearance.theme
        || root.getAttribute("data-theme") !== renderedTheme
        || root.getAttribute("data-mode-preference") !== appearance.modePreference
        || root.getAttribute("data-mode") !== appearance.mode
      ) {
        dispatch({ type: "SET_APPEARANCE", payload: appearance });
      }
    };

    const fetchTheme = async () => {
      safeRemove(STORAGE_KEYS.DEPRECATED_USER_THEME_CHOICE);
      const token = safeGet(STORAGE_KEYS.AUTH_TOKEN);
      let platformTheme = normalizeTheme(safeGet(STORAGE_KEYS.PLATFORM_THEME) || DEFAULT_THEME);
      let platformMode = normalizeThemeModePreference(safeGet(STORAGE_KEYS.PLATFORM_THEME_MODE))
        || DEFAULT_MODE_PREFERENCE;

      try {
        const requests: [Promise<Response>, Promise<Response> | null] = [
          getClientBootstrapAppearance(),
          token ? getClientBootstrapAuthMe(token) : null,
        ];
        const [settingsRes, meRes] = await Promise.all([
          requests[0],
          requests[1] || Promise.resolve(null),
        ]);
        if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;

        if (settingsRes.ok) {
          const settingsData = await settingsRes.json();
          platformTheme = normalizeTheme(settingsData.settings?.theme);
          platformMode = normalizeThemeModePreference(settingsData.settings?.theme_mode)
            || DEFAULT_MODE_PREFERENCE;
          safeSet(STORAGE_KEYS.PLATFORM_THEME, platformTheme);
          safeSet(STORAGE_KEYS.PLATFORM_THEME_MODE, platformMode);
        }

        if (token && meRes?.ok) {
          const meData = await meRes.json();
          if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
          const userTheme = meData.user?.themePreference || meData.user?.theme_preference;
          const userMode = normalizeThemeModePreference(
            meData.user?.themeModePreference || meData.user?.theme_mode_preference,
          );
          if (userTheme && userMode) {
            safeSet(STORAGE_KEYS.USER_THEME_PREFERENCE, userTheme);
            safeSet(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE, userMode);
            applyAppearance(userTheme, userMode);
            return;
          }
        }
      } catch {
        // Last validated platform cache remains available during a transient
        // settings outage. A cached user preference is deliberately ignored
        // because the current IP/expiry cannot be proven without /auth/me.
      }

      safeRemove(STORAGE_KEYS.USER_THEME_PREFERENCE);
      safeRemove(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE);
      applyAppearance(platformTheme, platformMode);
    };
    void fetchTheme();

    const handleStorageUpdate = (event: StorageEvent) => {
      if (
        event.key === STORAGE_KEYS.USER_THEME_PREFERENCE
        || event.key === STORAGE_KEYS.USER_THEME_MODE_PREFERENCE
        || event.key === STORAGE_KEYS.PLATFORM_THEME
        || event.key === STORAGE_KEYS.PLATFORM_THEME_MODE
      ) {
        void fetchTheme();
      }
    };
    const handleThemeUpdate = () => {
      // 管理后台保存平台默认外观后，不能命中 1.5 秒 settled cache，
      // 否则当前标签页会短暂恢复旧默认值。
      invalidateClientBootstrapAppearance();
      void fetchTheme();
    };
    window.addEventListener("theme-updated", handleThemeUpdate);
    window.addEventListener("storage", handleStorageUpdate);
    return () => {
      window.removeEventListener("theme-updated", handleThemeUpdate);
      window.removeEventListener("storage", handleStorageUpdate);
    };
  }, []);

  const fetchAgents = useCallback(async () => {
    dispatch({ type: "SET_LOADING_AGENTS", payload: true });
    try {
      const headers: Record<string, string> = {};
      const token = authRef.current.token || safeGet(STORAGE_KEYS.AUTH_TOKEN);
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/bots?shape=agents", { headers });
      const data = await res.json();

      const apiAgents: Agent[] = [];

      // Agents from database (LLM, Coze, and Coze Coding types)
      const agentList = data.agents || data.bots || data.data?.items || [];
      if (agentList.length > 0) {
        for (const bot of agentList as Array<Record<string, unknown>>) {
          const source = String(bot.source || "coze") as "coze" | "coze_coding" | "llm";
          const iconUrl = String(bot.icon_url || bot.avatar || "");
          const agentId = String(bot.id || bot.bot_id);

          apiAgents.push({
            id: agentId,
            name: String(bot.bot_name || bot.name || "未命名智能体"),
            description: String(bot.description || "暂无描述"),
            iconUrl,
            category: String(bot.category || "通用"),
            botId: String(bot.bot_id || ""),
            source,
            model: String(bot.model || ""),
            systemPrompt: String(bot.system_prompt || ""),
            is_active: bot.is_active !== false,
            baseFee: Number(bot.base_fee) || 0,
            sort_order: Number(bot.sort_order ?? 0),
            user_access: (bot.user_access as "available" | "hidden") || undefined,
            cozeCodingApiUrl: String(bot.coze_coding_api_url || ""),
            cozeCodingProjectId: String(bot.coze_coding_project_id || ""),
            cozeCodingApiToken: String(bot.coze_coding_api_token || ""),
            presetFields: Array.isArray(bot.preset_fields) ? bot.preset_fields as PresetField[] : [],
            outputStyle: (bot.output_style ?? {}) as OutputStyle,
            enableThinkTags: !!bot.enable_think_tags,
            proxyUrl: String(bot.proxy_url || ""),
            deepThinkingType: Number(bot.deep_thinking_type ?? 0),
            deductDeepThink: Number(bot.deduct_deep_think ?? 1),
            maxContextRounds: Number(bot.max_context_rounds ?? 0),
            maxContextTokens: Number(bot.max_context_tokens ?? 0),
            maxReplyTokens: Number(bot.max_reply_tokens ?? 16384),
            timeout: Number(bot.timeout ?? 300),
            enableWebSearch: !!bot.enable_web_search,
            temperature: bot.temperature != null ? Number(bot.temperature) : undefined,
            responseFormat: bot.response_format as "text" | "markdown" | "json_object" | undefined,
            response_format: bot.response_format as "text" | "markdown" | "json_object" | undefined,
            // 智能体级独立Token计费
            token_billing_enabled: !!bot.token_billing_enabled,
            input_cost_per_million: bot.input_cost_per_million != null ? Number(bot.input_cost_per_million) : undefined,
            output_cost_per_million: bot.output_cost_per_million != null ? Number(bot.output_cost_per_million) : undefined,
            cached_cost_per_million: bot.cached_cost_per_million != null ? Number(bot.cached_cost_per_million) : undefined,
            profit_margin: bot.profit_margin != null ? Number(bot.profit_margin) : undefined,
            token_rounding_unit: bot.token_rounding_unit != null ? Number(bot.token_rounding_unit) : 0,
            model_id: bot.model_id ? String(bot.model_id) : undefined,
            model_public_id: bot.model_public_id ? String(bot.model_public_id) : undefined,
            model_billing: (bot.model_billing as Agent['model_billing']) || null,
            cover_url: bot.cover_url ? String(bot.cover_url) : undefined,
            guideMessage: bot.guide_message ? String(bot.guide_message) : undefined,
            guide_message: bot.guide_message ? String(bot.guide_message) : undefined,
          });
        }
      }

      dispatch({ type: "SET_AGENTS", payload: apiAgents });
    } catch (error) {
      if (isAbortLikeError(error) || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      console.error("Failed to fetch agents:", error);
    } finally {
      dispatch({ type: "SET_LOADING_AGENTS", payload: false });
    }
  }, []);

  const startChat = useCallback(
    (agentId: string, requestedConversationId?: string) => {
      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return null;
      const requestedId = requestedConversationId?.trim();
      if (requestedId && !/^[a-zA-Z0-9_-]{8,128}$/u.test(requestedId)) {
        console.error("[startChat] Invalid requested conversation id");
        return null;
      }
      if (requestedId && (
        state.conversations.some((conversation) => conversation.id === requestedId)
        || pendingLocalConversationsRef.current.has(requestedId)
      )) {
        console.error("[startChat] Requested conversation id already exists");
        return null;
      }

      const conversation: Conversation = {
        id: requestedId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        agentId: agent.id,
        botId: agent.botId || agent.id,
        agentName: agent.name,
        agentIconUrl: agent.iconUrl,
        title: `与 ${agent.name} 的对话`,
        lastMessage: "",
        lastMessageTime: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        messagesLoaded: true, // New conversation — no need to fetch
        dirty: true, // Mark as dirty so it gets synced to server
      };

      rememberPendingLocalConversation(conversation);
      dispatch({ type: "START_CONVERSATION", payload: conversation });
      return conversation.id;
    },
    [rememberPendingLocalConversation, state.agents, state.conversations]
  );

  // ---- Start free chat (model selection in chat view) ----
  const startFreeChat = useCallback(
    (options?: { agentId?: string; conversationName?: string; title?: string }) => {
      // Create a known virtual LLM agent. Dedicated app IDs keep histories isolated
      // while still using the main account, conversation storage and model pool.
      const freeChatAgentId = options?.agentId?.trim() || FREE_CHAT_AGENT_ID;
      const virtualAgent = createVirtualChatAgent(freeChatAgentId);
      if (!virtualAgent) {
        console.error("[startFreeChat] Unsupported virtual agent:", freeChatAgentId);
        return;
      }
      // Check if virtual agent already exists in state
      const existing = state.agents.find(a => a.id === freeChatAgentId);
      if (!existing) {
        dispatch({ type: "ADD_AGENTS", payload: [virtualAgent] });
      }

      const conversation: Conversation = {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        agentId: freeChatAgentId,
        botId: freeChatAgentId,
        agentName: options?.conversationName?.trim() || virtualAgent.name,
        agentIconUrl: "",
        title: options?.title?.trim() || "新对话",
        lastMessage: "",
        lastMessageTime: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        messagesLoaded: true,
        dirty: true,
      };

      rememberPendingLocalConversation(conversation);
      dispatch({ type: "START_CONVERSATION", payload: conversation });
    },
    [rememberPendingLocalConversation, state.agents]
  );

  // ---- Send message with routing by agent source ----
  const sendMessage = useCallback(
    async (content: string, mentionedAgentId?: string, images?: string[], modelOverride?: string, apiContent?: string, deepThinkingOverride?: number, webSearchOverride?: boolean, skipUserMessage?: boolean, retryUserMessageId?: string): Promise<boolean> => {
      const convId = state.activeConversationId;
      console.log(`[sendMessage] 🔵 ENTRY convId=${convId}, content="${content?.slice(0,30)}...", isStreaming=${state.isStreaming}, streamingConvs=[${[...streamingConvIdsRef.current]}], activeAgent=${state.activeAgentId}`);
      if (!convId) {
        console.warn("[sendMessage] ❌ NO convId, returning false");
        return false;
      }

      // A conversation accepts one logical send at a time. The user can stop
      // receiving first, then explicitly submit the next message.
      // 使用 ref 确保读取最新的 streamingConvIds，避免 stale closure 导致误判
      const currentStreamingIds = streamingConvIdsRef.current;
      const currentStreamingConvId = currentStreamingIds.size > 0
        ? [...currentStreamingIds].find(cid => cid === convId)
        : null;
      if (currentStreamingConvId) {
        console.warn("[sendMessage] Duplicate send blocked while conversation is streaming:", currentStreamingConvId);
        return false;
      }

      const conversation = state.conversations.find((c) => c.id === convId);
      if (!conversation) {
        console.error("[sendMessage] Conversation not found, convId:", convId, "available:", state.conversations.map(c => c.id).join(','));
        // 尝试恢复：清除失效的activeConversationId
        dispatch({ type: "SET_ACTIVE_CONVERSATION", payload: null });
        return false;
      }

      if (!tryAcquireConversationSend(pendingSendConversationIdsRef.current, convId)) {
        console.warn("[sendMessage] Duplicate send blocked before streaming state committed:", convId);
        return false;
      }

      try {

      // 🔒 对话-智能体绑定自愈：对话创建时 agentId 应不可变
      // 如果 conversation.agentId 与 activeAgentId 不一致，以 conversation.agentId 为准
      const findAgentByAnyId = (id?: string | null) => id
        ? state.agents.find((a) => a.id === id) || state.agents.find((a) => !!a.botId && a.botId === id)
        : undefined;

      const convBoundAgentId = conversation.agentId;
      const convBoundAgent = findAgentByAnyId(convBoundAgentId);
      const activeAgent = findAgentByAnyId(state.activeAgentId);
      const effectiveAgentId = mentionedAgentId || convBoundAgent?.id || activeAgent?.id || convBoundAgentId || state.activeAgentId;
      if (convBoundAgentId && convBoundAgent?.id && convBoundAgent.id !== state.activeAgentId) {
        console.warn("[sendMessage] ⚠️ 绑定自愈: conversation.agentId=", convBoundAgentId, "≠ activeAgentId=", state.activeAgentId, "→ 以 conversation.agentId 为准");
        dispatch({ type: "SET_ACTIVE_AGENT", payload: convBoundAgent.id });
      } else if (!mentionedAgentId && convBoundAgentId && !convBoundAgent && activeAgent) {
        console.warn("[sendMessage] Repairing stale conversation agent binding:", convBoundAgentId, "->", activeAgent.id);
        dispatch({
          type: "UPDATE_CONVERSATION",
          payload: {
            ...conversation,
            agentId: activeAgent.id,
            botId: activeAgent.botId || null,
            agentName: activeAgent.name,
            agentIconUrl: activeAgent.iconUrl,
            dirty: true,
          },
        });
      }
      const targetAgentId = effectiveAgentId;
      let targetAgent = findAgentByAnyId(targetAgentId);
      if (!targetAgent) {
        console.warn("[sendMessage] No target agent found, agentId:", targetAgentId, "agents count:", state.agents.length, "— attempting re-fetch");
        // Agent 不在当前列表中，可能是 SET_AGENTS 替换后丢失（如 __free_chat__ 虚拟智能体）
        // 或首次加载竞态。尝试重新 fetchAgents 一次
        try {
          await fetchAgents();
        } catch { /* 静默 */ }
        // 重试查找（从最新 state 中读取需要用 dispatch 后的值，但 sendMessage 用的是闭包 state）
        // 使用一个短暂的延迟等待 React 重渲染后重试
        await new Promise(r => setTimeout(r, 100));
        // 由于闭包问题，我们需要从 reducer 的最新状态中重新查找
        // 这里通过 dispatch 一个自定义 action 来触发重试是不现实的，
        // 改为直接从 /api/bots 读取 agent 信息作为兜底
        const retryToken = state.auth.token || safeGet(STORAGE_KEYS.AUTH_TOKEN);
        const retryHeaders: Record<string, string> = {};
        if (retryToken) retryHeaders["Authorization"] = `Bearer ${retryToken}`;
        try {
          const retryRes = await fetch("/api/bots?shape=agents", { headers: retryHeaders });
          if (retryRes.ok) {
            const retryData = await retryRes.json() as {
              agents?: Array<Agent & { bot_id?: string | null }>;
              bots?: Array<Agent & { bot_id?: string | null }>;
            };
            const retryAgents = retryData.agents || retryData.bots || [];
            const retryAgent = retryAgents.find((a) =>
              a.id === targetAgentId || (!!a.bot_id && a.bot_id === targetAgentId)
            );
            if (retryAgent) {
              // 找到了！更新 agents 列表并继续发送
              console.log("[sendMessage] Agent found after re-fetch:", retryAgent.name);
              dispatch({ type: "ADD_AGENTS", payload: [retryAgent] });
              targetAgent = retryAgent;
            }
          }
        } catch { /* 静默 */ }
        // Virtual agents do not exist in /api/bots. Restore the known local
        // definition directly and continue the same send instead of asking the
        // user to retry after a refresh race.
        if (!targetAgent && targetAgentId) {
          const virtualAgent = createVirtualChatAgent(targetAgentId);
          if (virtualAgent) {
            dispatch({ type: "ADD_AGENTS", payload: [virtualAgent] });
            targetAgent = virtualAgent;
          }
        }
      }
      if (!targetAgent) {
        console.error("[sendMessage] No target agent found after retry, agentId:", targetAgentId);
        // 重试时（skipUserMessage=true）不重复添加用户消息，避免点击"重新生成"后用户消息重复
        if (!skipUserMessage) {
          const userMessage: Message = {
            id: `msg_${Date.now()}_user`,
            role: "user",
            content,
            timestamp: Date.now(),
            images: images && images.length > 0 ? images : undefined,
          };
          dispatch({ type: "ADD_MESSAGE", payload: { conversationId: convId, message: userMessage } });
        }
        const assistantMessage: Message = {
          id: `msg_${Date.now()}_assistant`,
          role: "assistant",
          content: "⚠️ 智能体信息加载中，请稍后重试或切换其他智能体。",
          agentId: targetAgentId || "",
          agentName: "系统",
          timestamp: Date.now(),
          isStreaming: false,
        };
        dispatch({ type: "ADD_MESSAGE", payload: { conversationId: convId, message: assistantMessage } });
        return false;
      }
      console.log("[sendMessage] targetAgent:", targetAgent.name, "source:", targetAgent.source);

      // 前端积分提醒（不硬性阻止，由后端决定是否允许）
      // remaining === 0 且 total > 0 表示确认已用完；remaining < 0 表示未获取到真实积分
      // [PERF优化] 积分检查不再阻塞消息发送，改为与消息请求并行
      if (state.credits?.remaining === 0 && state.credits?.total > 0) {
        // 异步验证积分，不阻塞消息发送
        const userId = state.auth?.user?.id;
        if (userId) {
          fetch(`/api/credits?user_id=${userId}`, {
            headers: state.auth?.token ? { Authorization: `Bearer ${state.auth.token}` } : {},
          })
            .then(res => res.ok ? res.json() : null)
            .then(creditsData => {
              if (creditsData) {
                if (creditsData.cashBalance !== undefined) {
                  dispatch({ type: "SET_CASH_BALANCE", payload: creditsData.cashBalance });
                }
                const serverCredits = creditsData.credits ?? 0;
                if (serverCredits > 0) {
                  dispatch({
                    type: "SET_CREDITS",
                    payload: {
                      total: serverCredits,
                      used: 0,
                      remaining: serverCredits,
                      costPerMessage: state.credits.costPerMessage,
                    },
                  });
                }
              }
            })
            .catch((e: unknown) => { console.error("[app-context] fetchCredits failed:", e instanceof Error ? e.message : e); });
          // 不再阻塞：让后端决定是否因积分不足而拒绝
          // 如果后端返回402，前端会显示相应提示
        }
      }

      // Add user message (skip on retry — user message already exists)
      // content: 用于前端展示的简短文本；apiContent: 实际发送给API的内容（协同时为完整指令）
      const effectiveApiContent = apiContent || content;
      let userMessageId: string | undefined = retryUserMessageId;
      if (!skipUserMessage) {
        const userMessage: Message = {
          id: `msg_${Date.now()}_user`,
          role: "user",
          content: effectiveApiContent, // 始终存储发送给API的完整内容（重试时使用）
          displayContent: apiContent ? content : undefined, // 有 apiContent 时仅展示简短文本
          timestamp: Date.now(),
          images: images && images.length > 0 ? images : undefined,
          ...(mentionedAgentId && mentionedAgentId !== state.activeAgentId
            ? { agentId: targetAgent.id, agentName: targetAgent.name, agentIconUrl: targetAgent.iconUrl }
            : {}),
        };
        userMessageId = userMessage.id;
        dispatch({ type: "ADD_MESSAGE", payload: { conversationId: convId, message: userMessage } });
      }

      // Add assistant placeholder (streaming)
      const assistantMessage: Message = {
        id: `msg_${Date.now()}_assistant`,
        role: "assistant",
        content: "",
        agentId: targetAgent.id,
        agentName: targetAgent.name,
        agentIconUrl: targetAgent.iconUrl,
        timestamp: Date.now(),
        isStreaming: true,
      };
      dispatch({ type: "ADD_MESSAGE", payload: { conversationId: convId, message: assistantMessage } });
      dispatch({ type: "SET_CONV_STREAMING", payload: { conversationId: convId, isStreaming: true } });
      resetTypewriterState({ conversationId: convId, messageId: assistantMessage.id });

      // Route based on agent source (model override forces LLM route for any agent type)
      const useLLMRoute = targetAgent.source === "llm" || !!modelOverride;
      // 检测是否为生图模型（model name 包含 image/drawing/dall-e 等关键词）
      const effectiveModel = modelOverride || targetAgent.model || "";
      const isImageModel = isImageGenerationModelName(effectiveModel);
      const hybridImageConfig = getHybridImageConfig(targetAgent.outputStyle);
      // 协同调度：auto模式根据消息内容自动检测生图意图，always模式无条件路由到生图
      const shouldUseHybridImage =
        !isImageModel &&
        hybridImageConfig?.enabled &&
        (hybridImageConfig.routingMode === "always" ||
         (hybridImageConfig.routingMode === "auto" && shouldTriggerHybridImage(effectiveApiContent, hybridImageConfig)));
      const hybridImagePrompt = effectiveApiContent;
      console.log(
        "[sendMessage] routing to:",
        isImageModel || shouldUseHybridImage
          ? "sendImageGenMessage"
          : useLLMRoute
            ? "sendLLMMessage"
            : targetAgent.source === "coze_coding"
              ? "sendCozeCodingMessage"
              : "sendCozeMessage",
        "modelOverride:",
        modelOverride || "(none)",
        "isImageModel:",
        isImageModel,
        "shouldUseHybridImage:",
        shouldUseHybridImage,
        "hybridImageModel:",
        hybridImageConfig?.model || "(none)"
      );
      try {
        if (isImageModel || shouldUseHybridImage) {
          await sendImageGenMessage(
            convId,
            assistantMessage.id,
            hybridImagePrompt
          );
        } else if (useLLMRoute) {
          await sendLLMMessage(convId, assistantMessage.id, effectiveApiContent, conversation, targetAgent, images, modelOverride, deepThinkingOverride, webSearchOverride, userMessageId);
        } else if (targetAgent.source === "coze_coding") {
          await sendCozeCodingMessage(convId, assistantMessage.id, effectiveApiContent, conversation, targetAgent, images, userMessageId);
        } else {
          await sendCozeMessage(convId, assistantMessage.id, effectiveApiContent, conversation, targetAgent, images, userMessageId);
        }
        return true;
      } catch (err) {
        console.error("[sendMessage] send error:", err);
        return false;
      }
      } finally {
        releaseConversationSend(pendingSendConversationIdsRef.current, convId);
      }
    },
    [state.activeConversationId, state.activeAgentId, state.agents, state.conversations, state.isStreaming, state.credits, state.auth]
  );

  // ---- Abort ongoing stream(s) ----
  // If convId is provided, only abort that conversation's stream; otherwise abort all
  const abortCurrentStream = useCallback((convId?: string) => {
    const controllers = abortControllerMap.current;
    if (convId) {
      const ctrl = controllers.get(convId);
      if (ctrl && !ctrl.signal.aborted) {
        watchdogAbortedSet.current.delete(convId);
        userAbortedSet.current.add(convId); // Mark only a live request as user-initiated.
        ctrl.abort();
      }
      dispatch({ type: "SET_CONV_STREAMING", payload: { conversationId: convId, isStreaming: false } });
      // Mark streaming messages in this conversation as no longer streaming
      const conv = state.conversations.find(c => c.id === convId);
      if (conv) {
        for (const msg of conv.messages) {
          if (msg.isStreaming) {
            dispatch({
              type: "SET_MESSAGE_STREAMING",
              payload: { conversationId: conv.id, messageId: msg.id, isStreaming: false },
            });
          }
        }
      }
    } else {
      // Abort all streams
      controllers.forEach((ctrl: AbortController, id: string) => {
        if (ctrl.signal.aborted) return;
        watchdogAbortedSet.current.delete(id);
        userAbortedSet.current.add(id); // Mark all as user-initiated
        ctrl.abort();
      });
      dispatch({ type: "SET_IS_STREAMING", payload: false });
      for (const conv of state.conversations) {
        for (const msg of conv.messages) {
          if (msg.isStreaming) {
            dispatch({
              type: "SET_MESSAGE_STREAMING",
              payload: { conversationId: conv.id, messageId: msg.id, isStreaming: false },
            });
          }
        }
      }
    }
  }, [state.isStreaming, state.conversations]);

  // ---- LLM (OpenAI-compatible) message sending ----
  // ── RAF-throttled dispatch for streaming ──
  // requestAnimationFrame aligns dispatches with the browser's paint cycle,
  // so every content update is immediately visible on the next frame.
  // Unlike setTimeout (which fires at arbitrary times and may miss paint
  // windows), RAF guarantees the browser paints right after our callback.
  // This eliminates the "holding back → burst" feel caused by timer
  // misalignment.  RAF naturally skips frames when the main thread is busy
  // (e.g. markdown-it parse), preventing accumulation.
  const streamingRafRef = useRef<number | null>(null);
  const pendingUpdateRef = useRef<{ conversationId: string; messageId: string; content: string; reasoningContent?: string } | null>(null);
  type StreamingUpdatePayload = { conversationId: string; messageId: string; content: string; reasoningContent?: string };
  type TypewriterEntry = {
    target: StreamingUpdatePayload;
    displayedContent: string;
    displayedReasoning: string;
    framesRemaining: number;
  };
  type StreamPerfRecord = {
    startedAt: number;
    lastTargetAt: number;
    targetUpdates: number;
    firstPaintAt?: number;
    paintFrames: number;
    lastPaintedLength: number;
  };
  const typewriterEntriesRef = useRef<Map<string, TypewriterEntry>>(new Map());
  const streamPerfRef = useRef<Map<string, StreamPerfRecord>>(new Map());
  // Keep the last painted prefix even after an entry catches up. Network chunks
  // often arrive slower than the typewriter; dropping this state made every new
  // chunk restart the whole answer from an empty string.
  const typewriterDisplayedRef = useRef<Map<string, { content: string; reasoning: string }>>(new Map());
  const typewriterDrainResolversRef = useRef<Map<string, Set<() => void>>>(new Map());
  // Each concurrently streaming message owns its own immediate first paint.
  // A single global counter made a second conversation wait for another
  // conversation's RAF cycle.
  const instantlyPaintedStreamKeysRef = useRef<Set<string>>(new Set());
  const streamKey = useCallback((payload: Pick<StreamingUpdatePayload, "conversationId" | "messageId">) => `${payload.conversationId}:${payload.messageId}`, []);
  const isStreamDebugEnabled = () => {
    try {
      return typeof window !== "undefined" && window.localStorage?.getItem("debug_stream") === "1";
    } catch {
      return false;
    }
  };
  const customerStreamError = (value: unknown) => {
    const knownFailure = knownChatFailureMessage(value);
    if (knownFailure) return knownFailure;
    const detail = typeof value === "string" ? value : JSON.stringify(value || "");
    if (/PROMPT_INJECTION_BLOCKED|安全防护拦截|内部设定/i.test(detail)) {
      return "这个问题涉及智能体内部设定，已由安全防护正常拦截；你可以继续提出业务问题。";
    }
    if (/LLM_UPSTREAM_CONTENT_REJECTED|content[_\s-]*(?:filter|policy)|moderation|\bsafety\b|内容审核|未通过内容审核/iu.test(detail)) {
      return "这次请求未通过上游内容审核，请调整表述后重试。";
    }
    if (/RESULT_UNKNOWN|RECONCILIATION_REQUIRED|结果暂未确认/i.test(detail)) {
      return "这次回复未完成，最终结果暂未确认。请先查看聊天记录，避免重复发送。";
    }
    if (/LLM_EMPTY_RESPONSE|EMPTY_RESPONSE|无回复内容|未返回有效内容/i.test(detail)) {
      return "上游没有返回有效内容，本次未得到可用回复，请稍后重试。";
    }
    if (/余额不足|LLM_UPSTREAM_BALANCE|insufficient[_\s-]*(?:balance|credit)|quota/i.test(detail)) {
      return "当前对话服务额度不足，请稍后重试或切换可用服务。";
    }
    if (/401|403|LLM_UPSTREAM_AUTH|unauthori[sz]ed|forbidden|鉴权|授权/i.test(detail)) {
      return "当前对话服务授权暂不可用，请稍后重试。";
    }
    if (/LLM_UPSTREAM_TIMEOUT|SSE读取超时|读取超时|timeout|超时/i.test(detail)) {
      return "这次回复等待超时，系统已停止等待；请稍后重试。";
    }
    if (/429|rate[_\s-]*limit|限流|繁忙/i.test(detail)) {
      return "当前对话服务繁忙，请稍后重试。";
    }
    if (/LLM_STREAM_CLIENT_DISCONNECTED|LLM_STREAM_INTERRUPTED|回复中断|连接中断/i.test(detail)) {
      return "这次回复中断，尚未生成完整文案，请稍后再试。";
    }
    if (/Failed to fetch|NetworkError|network error|网络连接异常/i.test(detail)) {
      return "网络连接异常，请检查连接后重试。";
    }
    return "当前智能体暂时无法完成回复，请稍后重试。";
  };
  const streamPerfNow = () => (
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now()
  );
  const streamPayloadLength = useCallback((payload: Pick<StreamingUpdatePayload, "content" | "reasoningContent">) =>
    (payload.content || "").length + (payload.reasoningContent || "").length, []);
  const markStreamTarget = useCallback((payload: StreamingUpdatePayload) => {
    if (!isStreamDebugEnabled()) return;
    const key = streamKey(payload);
    const now = streamPerfNow();
    let record = streamPerfRef.current.get(key);
    if (!record) {
      record = {
        startedAt: now,
        lastTargetAt: now,
        targetUpdates: 0,
        paintFrames: 0,
        lastPaintedLength: 0,
      };
      streamPerfRef.current.set(key, record);
      console.log(`[stream-perf] first-target key=${key} length=${streamPayloadLength(payload)} immediateFirstPaint=true`);
    }
    record.lastTargetAt = now;
    record.targetUpdates += 1;
  }, [streamKey, streamPayloadLength]);
  const markStreamPaint = useCallback((key: string, target: StreamingUpdatePayload, paintedLength: number, done: boolean) => {
    if (!isStreamDebugEnabled()) return;
    const now = streamPerfNow();
    let record = streamPerfRef.current.get(key);
    if (!record) {
      record = {
        startedAt: now,
        lastTargetAt: now,
        targetUpdates: 0,
        paintFrames: 0,
        lastPaintedLength: 0,
      };
      streamPerfRef.current.set(key, record);
    }
    record.paintFrames += 1;
    record.lastPaintedLength = paintedLength;
    const targetLength = streamPayloadLength(target);
    if (!record.firstPaintAt && paintedLength > 0) {
      record.firstPaintAt = now;
      console.log(`[stream-perf] first-paint key=${key} ttfp=${Math.round(now - record.startedAt)}ms painted=${paintedLength}/${targetLength}`);
    }
    if (done || record.paintFrames <= 3 || record.paintFrames % 15 === 0) {
      console.log(`[stream-perf] paint key=${key} frame=${record.paintFrames} painted=${paintedLength}/${targetLength} catchup=${Math.round(now - record.lastTargetAt)}ms done=${done}`);
    }
  }, [streamPayloadLength]);
  const markStreamFinal = useCallback((payload: StreamingUpdatePayload, reason: string) => {
    if (!isStreamDebugEnabled()) return;
    const key = streamKey(payload);
    const now = streamPerfNow();
    const record = streamPerfRef.current.get(key);
    if (record) {
      console.log(`[stream-perf] final key=${key} reason=${reason} total=${Math.round(now - record.startedAt)}ms targetUpdates=${record.targetUpdates} paintFrames=${record.paintFrames} length=${streamPayloadLength(payload)}`);
    } else {
      console.log(`[stream-perf] final key=${key} reason=${reason} length=${streamPayloadLength(payload)}`);
    }
    streamPerfRef.current.delete(key);
  }, [streamKey, streamPayloadLength]);
  const resolveTypewriterDrain = useCallback((key: string) => {
    const resolvers = typewriterDrainResolversRef.current.get(key);
    if (!resolvers) return;
    typewriterDrainResolversRef.current.delete(key);
    for (const resolve of resolvers) resolve();
  }, []);
  const cancelStreamingFrameIfIdle = useCallback(() => {
    if (typewriterEntriesRef.current.size > 0 || streamingRafRef.current === null) return;
    cancelAnimationFrame(streamingRafRef.current);
    streamingRafRef.current = null;
  }, []);
  const flushStreamingUpdate = useCallback(function flushStreamingUpdate() {
    streamingRafRef.current = null;
    let hasMore = false;
    for (const [key, entry] of typewriterEntriesRef.current) {
      const targetReasoning = entry.target.reasoningContent ?? "";
      const previousContent = entry.displayedContent;
      const previousReasoning = entry.displayedReasoning;
      const nextContent = takeTypewriterSlice(entry.displayedContent, entry.target.content || "", entry.framesRemaining);
      const nextReasoning = entry.target.reasoningContent !== undefined
        ? takeTypewriterSlice(entry.displayedReasoning, targetReasoning, entry.framesRemaining)
        : undefined;

      entry.displayedContent = nextContent;
      if (nextReasoning !== undefined) entry.displayedReasoning = nextReasoning;
      typewriterDisplayedRef.current.set(key, {
        content: entry.displayedContent,
        reasoning: entry.displayedReasoning,
      });

      if (nextContent !== previousContent || (nextReasoning !== undefined && nextReasoning !== previousReasoning)) {
        dispatch({
          type: "UPDATE_MESSAGE",
          payload: {
            conversationId: entry.target.conversationId,
            messageId: entry.target.messageId,
            content: nextContent,
            reasoningContent: nextReasoning,
          },
        });
      }

      const contentDone = nextContent === (entry.target.content || "");
      const reasoningDone = entry.target.reasoningContent === undefined || entry.displayedReasoning === targetReasoning;
      markStreamPaint(
        key,
        entry.target,
        nextContent.length + (nextReasoning ?? entry.displayedReasoning).length,
        contentDone && reasoningDone
      );
      if (contentDone && reasoningDone) {
        typewriterEntriesRef.current.delete(key);
        resolveTypewriterDrain(key);
      } else {
        entry.framesRemaining = Math.max(1, entry.framesRemaining - 1);
        hasMore = true;
      }
    }

    if (hasMore) {
      streamingRafRef.current = requestAnimationFrame(flushStreamingUpdate);
    }
  }, [dispatch, markStreamPaint, resolveTypewriterDrain]);
  const resetTypewriterState = useCallback((payload?: Pick<StreamingUpdatePayload, "conversationId" | "messageId">) => {
    if (payload) {
      const key = streamKey(payload);
      typewriterEntriesRef.current.delete(key);
      typewriterDisplayedRef.current.delete(key);
      instantlyPaintedStreamKeysRef.current.delete(key);
      streamPerfRef.current.delete(key);
      if (pendingUpdateRef.current && streamKey(pendingUpdateRef.current) === key) {
        pendingUpdateRef.current = null;
      }
      resolveTypewriterDrain(key);
      cancelStreamingFrameIfIdle();
      return;
    }
    typewriterEntriesRef.current.clear();
    typewriterDisplayedRef.current.clear();
    instantlyPaintedStreamKeysRef.current.clear();
    streamPerfRef.current.clear();
    pendingUpdateRef.current = null;
    for (const key of typewriterDrainResolversRef.current.keys()) {
      resolveTypewriterDrain(key);
    }
    cancelStreamingFrameIfIdle();
  }, [cancelStreamingFrameIfIdle, resolveTypewriterDrain, streamKey]);
  useEffect(() => () => resetTypewriterState(), [resetTypewriterState]);
  const throttledDispatchUpdate = useCallback((payload: StreamingUpdatePayload) => {
    pendingUpdateRef.current = payload;
    const key = streamKey(payload);
    markStreamTarget(payload);
    const existing = typewriterEntriesRef.current.get(key);
    const painted = typewriterDisplayedRef.current.get(key);
    const displayedContent = existing?.displayedContent ?? painted?.content ?? "";
    const displayedReasoning = existing?.displayedReasoning ?? painted?.reasoning ?? "";
    typewriterEntriesRef.current.set(key, {
      target: payload,
      // takeTypewriterSlice atomically applies a corrected/non-prefix target.
      // Never blank the already painted response before that correction.
      displayedContent,
      displayedReasoning,
      framesRemaining: TYPEWRITER_TARGET_CATCHUP_FRAMES,
    });
    // Every message paints its first chunk immediately. Later network targets
    // coalesce into the next animation frame.
    if (!instantlyPaintedStreamKeysRef.current.has(key)) {
      instantlyPaintedStreamKeysRef.current.add(key);
      // If another message already owns the scheduled frame, that frame will
      // paint every entry in the map. Calling flush synchronously here would
      // orphan the existing RAF handle and start a second drain loop.
      if (streamingRafRef.current === null) flushStreamingUpdate();
      return;
    }
    if (streamingRafRef.current === null) {
      streamingRafRef.current = requestAnimationFrame(flushStreamingUpdate);
    }
  }, [flushStreamingUpdate, markStreamTarget, streamKey]);

  const settleTypewriterUpdate = useCallback((payload: StreamingUpdatePayload, maxWaitMs = 2_000) => {
    const key = streamKey(payload);
    return new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        const resolvers = typewriterDrainResolversRef.current.get(key);
        resolvers?.delete(finish);
        if (resolvers && resolvers.size === 0) {
          typewriterDrainResolversRef.current.delete(key);
        }
        typewriterEntriesRef.current.delete(key);
        typewriterDisplayedRef.current.delete(key);
        instantlyPaintedStreamKeysRef.current.delete(key);
        if (pendingUpdateRef.current && streamKey(pendingUpdateRef.current) === key) {
          pendingUpdateRef.current = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        cancelStreamingFrameIfIdle();
      };

      const finish = (reason = "settle-drained") => {
        if (settled) return;
        settled = true;
        markStreamFinal(payload, reason);
        cleanup();
        resolve();
      };

      const targetReasoning = payload.reasoningContent ?? "";
      const existing = typewriterEntriesRef.current.get(key);
      const painted = typewriterDisplayedRef.current.get(key);
      const displayedContent = existing?.displayedContent ?? painted?.content ?? "";
      const displayedReasoning = existing?.displayedReasoning ?? painted?.reasoning ?? "";
      const alreadyPainted = displayedContent === (payload.content || "")
        && (payload.reasoningContent === undefined || displayedReasoning === targetReasoning);

      if (alreadyPainted) {
        dispatch({ type: "UPDATE_MESSAGE", payload });
        finish("settle-already-painted");
        return;
      }

      let resolvers = typewriterDrainResolversRef.current.get(key);
      if (!resolvers) {
        resolvers = new Set();
        typewriterDrainResolversRef.current.set(key, resolvers);
      }
      resolvers.add(finish);

      timeoutId = setTimeout(() => {
        dispatch({ type: "UPDATE_MESSAGE", payload });
        finish("settle-timeout");
      }, maxWaitMs);

      throttledDispatchUpdate(payload);
    });
  }, [cancelStreamingFrameIfIdle, dispatch, markStreamFinal, streamKey, throttledDispatchUpdate]);

  // ── 生图意图交接到专用工作台 ──
  const sendImageGenMessage = useCallback(
    async (convId: string, assistantMsgId: string, content: string) => {
      const transferred = appendImageWorkbenchPromptTransfer(content);
      if (!transferred) {
        const transferError = "无法写入 AI 生图工作台草稿，请检查浏览器存储权限后重试";
        dispatch({
          type: "UPDATE_MESSAGE",
          payload: {
            conversationId: convId,
            messageId: assistantMsgId,
            content: transferError,
          },
        });
        dispatch({
          type: "SET_MESSAGE_STREAMING",
          payload: { conversationId: convId, messageId: assistantMsgId, isStreaming: false },
        });
        dispatch({
          type: "SET_CONV_STREAMING",
          payload: { conversationId: convId, isStreaming: false },
        });
        toast.error(transferError);
        throw new Error(transferError);
      }

      dispatch({
        type: "UPDATE_MESSAGE",
        payload: {
          conversationId: convId,
          messageId: assistantMsgId,
          content:
            "已将完整提示词带入 AI 生图工作台。请在工作台确认模型、尺寸、数量与预计费用后再生成。",
        },
      });
      dispatch({
        type: "SET_MESSAGE_STREAMING",
        payload: { conversationId: convId, messageId: assistantMsgId, isStreaming: false },
      });
      dispatch({
        type: "SET_CONV_STREAMING",
        payload: { conversationId: convId, isStreaming: false },
      });
      toast.success("已带入 AI 生图工作台");
      window.setTimeout(() => {
        window.location.assign("/tools/image/image-chat");
      }, 0);
    },
    [dispatch]
  );

  const sendLLMMessage = useCallback(
    async (
      convId: string,
      assistantMsgId: string,
      content: string,
      conversation: Conversation,
      agent: Agent,
      images?: string[],
      modelOverride?: string,
      deepThinkingOverride?: number,
      webSearchOverride?: boolean,
      userMsgId?: string // ★ 架构改进：传入用户消息ID，用于失败时清理消息对
    ) => {
      let fullContent = "";
      let continueAfterDisconnect = false;
      let responseErrorMessage: string | null = null;
      let rawContent = ""; // Raw accumulated content for think tag parsing
      let reasoningContent = "";

      // Create new AbortController for this conversation's stream
      const controller = getOrCreateAbortController(convId);

      // ── 流式诊断变量（在 try 外声明，供 catch 块和 final update 访问） ──
      let sseChunkCount = 0;
      let sseStreamEndReason = "not_started"; // "done" | "error_break" | "exception" | "not_started"
      let receivedDoneSignal = false; // 追踪是否收到 [DONE] 标记

      try {

        console.log("[sendLLMMessage] starting fetch, model:", modelOverride || agent.model || "deepseek-v4-flash", "hasAuth:", !!authRef.current.token, "signal.aborted:", controller.signal.aborted);
        // Build messages array with system prompt + conversation history
        const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [];
        if (agent.systemPrompt) {
          messages.push({ role: "system", content: agent.systemPrompt });
        }
        // ★ 架构改进：多智能体协作消息标注（对标AIWeb，解决A看不到B内容的问题）
        // 检测对话中是否有多个智能体参与
        const currentAgentId = agent.id;
        // ★ 补全 agentName：数据库只存 agent_id，前端需要从 agents 列表反查名称
        const enrichedMessages = conversation.messages.map(msg => {
          if (msg.role === "assistant" && msg.agentId && !msg.agentName) {
            const agentInfo = state.agents.find(a => a.id === msg.agentId);
            if (agentInfo) {
              return { ...msg, agentName: agentInfo.name, agentIconUrl: agentInfo.iconUrl };
            }
          }
          return msg;
        });
        const hasCollab = needsCollabPrompt(enrichedMessages, currentAgentId);

        // ★ 上下文隔离：过滤掉来自其他智能体的助手消息，防止身份混淆
        // 核心问题：当用户从历史记录切换对话时，消息可能来自不同智能体，
        // 如果不过滤，LLM 会看到其他智能体的回复并采用其角色（如"文案质检专家"）
        const isolatedHistory = enrichedMessages.filter(msg => {
          // 用户消息始终保留
          if (msg.role !== "assistant") return true;
          // 当前智能体的回复始终保留
          if (!msg.agentId || msg.agentId === currentAgentId) return true;
          // 协作模式下，其他智能体的回复也保留（带标注）
          if (hasCollab) return true;
          // 非协作模式下，其他智能体的回复排除（防止身份混淆）
          return false;
        });

        if (hasCollab) {
          messages.push({ role: "system", content: COLLAB_SYSTEM_PROMPT });
        }
        // Add conversation history — 不限制轮数，由后端 max_context_tokens 控制
        // 所有历史消息都发给后端，后端按 token 上限裁剪
        // ★ 架构改进：使用 pipeline 模块标注协作消息，替代原始 UUID name 字段
        const annotatedMessages = annotateCollabMessages(isolatedHistory, currentAgentId);
        for (const msg of annotatedMessages) {
          if (msg.role === "user" || msg.role === "assistant") {
            messages.push({ role: msg.role, content: appendImageMemoryToMessage(msg) });
          }
        }
        // Add current user message (with images if present)
        const resolvedImageUrls = (images || [])
          .slice(0, 20)
          .map(toLlmImageUrl)
          .filter((url): url is string => Boolean(url));
        if (resolvedImageUrls.length > 0) {
          const imageParts = resolvedImageUrls.map((url) => ({
            type: "image_url",
            image_url: { url },
          }));
          messages.push({
            role: "user",
            content: [
              { type: "text", text: content },
              ...imageParts,
            ],
          });
        } else {
          messages.push({ role: "user", content });
        }

        // A transport failure must remain visible until the user explicitly
        // chooses to retry. Keep the stable key for this submitted request, but
        // never let the generic fetch helper automatically re-send an LLM call.
        const clientRequestId = `llm_${crypto.randomUUID()}`;
        const res = await fetchWithRetry("/api/llm", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": clientRequestId,
            ...(authRef.current.token ? { Authorization: `Bearer ${authRef.current.token}` } : {}),
          },
          body: JSON.stringify({
            client_request_id: clientRequestId,
            messages,
            modelId: modelOverride || undefined,
            model_overridden: !!modelOverride, // 用户主动切换模型标志，后端据此决定是否覆盖预设
            stream: true,
            userId: authRef.current.user?.id,
            agentName: agent.name,
            agentId: agent.id,
            conversationId: convId, // AIWeb-style: backend saves messages to DB
            deepThinkingType: deepThinkingOverride != null ? deepThinkingOverride : (agent.deepThinkingType ?? agent.deep_thinking_type ?? 0),
            deepThinkingOverridden: deepThinkingOverride != null, // 用户端手动覆盖标志，阻止后端数据库/预设覆盖
            deductDeepThink: agent.deductDeepThink ?? agent.deduct_deep_think ?? 1,
            maxContextRounds: 0, // 不限制轮数，由后端 max_context_tokens 控制
            maxContextTokens: agent.maxContextTokens ?? agent.max_context_tokens ?? 0,
            maxReplyTokens: agent.maxReplyTokens ?? agent.max_reply_tokens ?? 16384,
            timeout: agent.timeout ?? 300,
            enableWebSearch: webSearchOverride != null ? webSearchOverride : (agent.enableWebSearch ?? agent.enable_web_search ?? false),
            enableWebSearchOverridden: webSearchOverride != null, // 用户端手动覆盖标志
            temperature: agent.temperature ?? undefined,
            responseFormat: agent.responseFormat ?? agent.response_format ?? undefined,
          }),
        }, 0);

        console.log(`[sendLLMMessage] 🔵 FETCH RETURNED: status=${res.status}, ok=${res.ok}, contentType=${res.headers.get("content-type")}, signal.aborted=${controller.signal.aborted}`);

        if (!res.ok) {
          if (res.status === 401) {
            // Token过期/无效 → 自动登出
            dispatch({ type: "LOGOUT" });
            if (typeof window !== "undefined") {
              clearStoredAuthSession();
              replaceWithPublicHome();
            }
            throw new Error("登录已过期，请重新登录");
          }
          if (res.status === 402) {
            const errData = await res.json().catch(() => ({}));
            // 保留当前会话，提供由用户主动打开的充值入口
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("insufficient-balance", { detail: { mode: "credits", message: errData.error } }));
            }
            throw new Error(errData.error || "积分不足，请联系管理员充值");
          }
          if (res.status === 403) {
            const errData = await res.json().catch(() => ({}));
            // 被拉黑用户：自动撤回消息 + 强制登出
            if (errData.code === "USER_BLOCKED") {
              dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: convId, messageId: userMsgId! } });
              dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: convId, messageId: assistantMsgId } });
              if (typeof window !== "undefined") {
                toast.error("消息已自动撤回：您的账户已被管理员拉黑");
                // 延迟强制登出，让用户看到提示
                setTimeout(() => {
                  dispatch({ type: "FORCED_LOGOUT", payload: "您的账户已被管理员拉黑" });
                  clearStoredAuthSession();
                  replaceWithPublicHome();
                }, 2000);
              }
              return false;
            }
            // 会员未激活/已过期 → 弹出卡密兑换弹窗
            if (errData.code === "MEMBERSHIP_REQUIRED" && typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("membership-required"));
            }
            throw new Error(errData.error || "请求已被安全防护拦截");
          }
          if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            const retryAfter = errData.retryAfter ? `，请${errData.retryAfter}秒后再试` : "，请稍后再试";
            throw new Error(errData.error || `请求过于频繁${retryAfter}`);
          }
          // 其他错误：尝试读取后端返回的具体错误信息
          const errData = await res.json().catch(() => ({}));
          const detail = errData.error ? errData : res.status;
          responseErrorMessage = customerStreamError(detail);
          throw new Error(responseErrorMessage);
        }

        const contentType = res.headers.get("content-type") || "";
        continueAfterDisconnect = res.headers.get("X-LLM-Continue-After-Disconnect") === "true";

        if (contentType.includes("text/event-stream")) {
          // Streaming SSE response
          const reader = res.body?.getReader();
          if (!reader) throw new Error("No reader available");

          const sseDecoder = new SseEventStreamDecoder();
          // ── 流式诊断：使用外层声明的变量（sseChunkCount, sseStreamEndReason, receivedDoneSignal） ──
          const streamStartTime = Date.now();
          let lastChunkTime = Date.now();
          const SSE_READ_TIMEOUT = 310_000; // 310秒无数据视为流中断（对齐后端推理模型300秒超时+10秒缓冲）

          let streamErrored = false; // 标记流是否遇到错误，用于跳出 while 循环
          while (true) {
            if (streamErrored) break; // 错误后立即退出 while 循环，避免空读挂起
            if (receivedDoneSignal) break; // 收到[DONE]后立即退出，不再等待 reader.read()
            let readTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const readPromise = reader.read();
            const timeoutPromise = new Promise<never>((_, reject) => {
              readTimeoutId = setTimeout(() => reject(new Error(`SSE读取超时(${SSE_READ_TIMEOUT/1000}秒无数据)`)), SSE_READ_TIMEOUT);
            });
            const { done, value } = await Promise.race([readPromise, timeoutPromise])
              .finally(() => { if (readTimeoutId) clearTimeout(readTimeoutId); });
            if (done) {
              sseStreamEndReason = "done";
              const duration = Date.now() - streamStartTime;
              // 关键诊断：如果流结束但未收到 [DONE]，说明连接中途断了
              if (!receivedDoneSignal && sseChunkCount > 0) {
                console.warn(`[sendLLMMessage] ⚠️ 流异常结束：未收到[DONE]信号！chunks=${sseChunkCount}, 内容=${fullContent.length}字符, 耗时=${duration}ms — 疑似连接中途断开`);
              } else if (sseChunkCount === 0) {
                console.error(`[sendLLMMessage] 🔴 流结束但零chunk！done=true, receivedDone=${receivedDoneSignal}, signal.aborted=${controller.signal.aborted} — 请求可能未到达服务器`);
              } else {
                console.log(`[sendLLMMessage] SSE流正常结束: chunks=${sseChunkCount}, 内容=${fullContent.length}字符, 推理=${reasoningContent.length}字符, 耗时=${duration}ms`);
              }
            } else {
              sseChunkCount++;
              const chunkGap = Date.now() - lastChunkTime;
              lastChunkTime = Date.now();
              // 每隔10个chunk或首个chunk记录一次
              if (isStreamDebugEnabled() && (sseChunkCount <= 2 || sseChunkCount % 10 === 0)) {
                console.log(`[sendLLMMessage] SSE chunk #${sseChunkCount}: ${value?.length || 0}bytes, gap=${chunkGap}ms, 累计内容=${fullContent.length}字符`);
              }
            }

            for (const event of done ? sseDecoder.finish() : sseDecoder.push(value)) {
                const raw = event.data.trim();
                if (raw === "[DONE]") {
                    receivedDoneSignal = true;
                    // [DONE] 是 SSE 流结束标志，收到后立即退出 while 循环
                    // 不再继续 reader.read() 等待，避免流未正常关闭时卡住120秒超时
                    break;
                  }

                try {
                  const data = JSON.parse(raw);

                  // ── 模型降级事件已禁用：不再自动切换模型 ──
                  // 用户要求选择哪个模型就用哪个，错误信息直接展示便于排查

                  // 检测后端 proxy 发送的错误 chunk（如流中断、API 错误等）
                  if (data.error) {
                    const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
                    const customerMessage = customerStreamError(data);
                    sseStreamEndReason = "error_break";
                    receivedDoneSignal = true; // 标记为已结束，防止后续追加"输出中断"误报
                    const duration = Date.now() - streamStartTime;
                    console.error(`[sendLLMMessage] SSE流因error中断: chunks=${sseChunkCount}, 内容=${fullContent.length}字符, 推理=${reasoningContent.length}字符, 耗时=${duration}ms, error=${errMsg}`);

                    // ── 自动降级已禁用：不再自动切换模型，错误信息直接展示 ──

                    // 如果已收到部分内容，追加错误标记；否则设置为错误消息
                    // ★ 区分余额不足和临时限流：余额不足不应建议重试
                    if (fullContent || reasoningContent) {
                      fullContent += `\n\n⚠ ${customerMessage}`;
                    } else {
                      fullContent = `⚠ ${customerMessage}`;
                    }
                    streamErrored = true;
                    break; // 终止 for (lines) 循环，streamErrored 会让 while 也退出
                  }
                  if (data.type === "generation_progress") {
                    const receivedChars = Number(data.received_chars || 0);
                    dispatch({
                      type: "UPDATE_MESSAGE",
                      payload: {
                        conversationId: convId,
                        messageId: assistantMsgId,
                        streamStatus: receivedChars > 0 ? "正在生成" : "正在连接模型",
                      },
                    });
                    continue;
                  }
                  const delta = data.choices?.[0]?.delta;
                  if (delta) {
                    // Handle reasoning content (deep thinking) — support both reasoning_content and reasoning fields
                    // Some APIs (e.g., GLM-5.1) use "reasoning" instead of "reasoning_content"
                    const reasoningChunk = delta.reasoning_content || delta.reasoning;
                    if (reasoningChunk) {
                      reasoningContent += reasoningChunk;
                      throttledDispatchUpdate({ conversationId: convId, messageId: assistantMsgId, content: fullContent, reasoningContent });
                    }
                    // Handle main content — parse <think compatible> tags when:
                    // 1. Agent explicitly enables think tags, OR
                    // 2. Agent has deep thinking enabled (type 1 or 2) — some APIs embed thinking in <think compatible> tags
                    if (delta.content) {
                      rawContent += delta.content;
                      const shouldParseThinkTags = agent.enableThinkTags || (agent.deepThinkingType ?? agent.deep_thinking_type ?? 0) > 0;
                      if (shouldParseThinkTags) {
                        // Parse think tags from raw content to extract reasoning
                        const parsed = parseThinkTags(rawContent);
                        fullContent = parsed.displayContent;
                        if (parsed.reasoningContent) {
                          reasoningContent = parsed.reasoningContent;
                        }
                      } else {
                        fullContent = rawContent;
                      }
                      throttledDispatchUpdate({ conversationId: convId, messageId: assistantMsgId, content: fullContent, reasoningContent });
                    }
                  }
                } catch {
                  // Skip non-JSON lines
                }
            }
            if (done) break;
          }
        } else {
          // Non-streaming JSON response
          const data = await res.json();
          const choice = data.choices?.[0];
          if (choice?.message) {
            rawContent = choice.message.content || "";
            reasoningContent = choice.message.reasoning_content || choice.message.reasoning || "";
            // Parse think tags when enabled or when deep thinking is active
            const shouldParseThinkTags = agent.enableThinkTags || (agent.deepThinkingType ?? agent.deep_thinking_type ?? 0) > 0;
            if (shouldParseThinkTags) {
              const parsed = parseThinkTags(rawContent);
              fullContent = parsed.displayContent;
              if (parsed.reasoningContent) reasoningContent = parsed.reasoningContent;
            } else {
              fullContent = rawContent;
            }
            // Let the shared typewriter settle path own the first visible paint.
            // Dispatching the complete JSON payload here and then starting the
            // typewriter from an empty prefix made the message visibly shrink.
          }
        }

        // Final update — preserve reasoningContent for display
        // Flush any pending timer update first, then do final dispatch immediately
        // 当 fullContent 为空但 reasoningContent 不为空时，回退显示推理内容
        // 这避免推理模型只返回思考内容时显示「无回复内容」
        let finalContent = fullContent || reasoningContent || "（无回复内容）";
        // 流异常结束检测：未收到 [DONE] 但流就结束了 → 追加中断提示
        if (!receivedDoneSignal && sseChunkCount > 0 && (fullContent || reasoningContent)) {
          console.warn(`[sendLLMMessage] 流异常结束，追加中断提示：receivedDoneSignal=${receivedDoneSignal}, chunks=${sseChunkCount}`);
          finalContent = finalContent + "\n\n---\n*⚠️ 输出中断，内容可能不完整。如需继续，请点击重新生成。*";
        }
        await settleTypewriterUpdate({ conversationId: convId, messageId: assistantMsgId, content: finalContent, reasoningContent: fullContent ? reasoningContent : "" });

        // Sync credits from backend — actual billing already done by /api/llm
        // The backend deducts credits based on real token usage after stream ends
        fetchCredits().catch((e: unknown) => { console.error("[app-context] fetchCredits after LLM stream failed:", e instanceof Error ? e.message : e); });
      } catch (error) {
        const isUserAborted = userAbortedSet.current.has(convId);
        userAbortedSet.current.delete(convId); // 清理标记
        const isWatchdogAborted = watchdogAbortedSet.current.has(convId);
        watchdogAbortedSet.current.delete(convId);
        const isAbortError = isAbortLikeError(error);
        const isSignalAborted = controller.signal.aborted;

        // 诊断日志：区分用户手动 abort / 安全网 abort / 网络错误
        console.warn("[sendLLMMessage] catch:", {
          convId,
          sseStreamEndReason,
          sseChunkCount,
          isUserAborted,
          isWatchdogAborted,
          isAbortError,
          isSignalAborted,
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
          fullContentLength: fullContent.length,
          streamingConvIds: [...(state.streamingConvIds || [])],
          mapKeys: [...abortControllerMap.current.keys()],
        });

        if (isUserAborted) {
          // 用户主动终止 — 保留已接收的内容
          const stoppedText = continueAfterDisconnect
            ? "[已停止接收；任务完成后按实际用量结算，可在历史查看结果]"
            : "[已终止]";
          if (fullContent) {
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: fullContent + "\n\n" + stoppedText, reasoningContent },
            });
          } else {
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: stoppedText },
            });
          }
        } else if (isWatchdogAborted || isSignalAborted || isAbortError) {
          const automaticStopMessage = continueAfterDisconnect
            ? "页面已停止接收，但服务器可能仍在处理，最终结果暂未确认。原请求已保留，请勿重复发送；请刷新后查看聊天记录。"
            : isWatchdogAborted
              ? "回复等待超过安全时限，系统已停止等待，请稍后重试。"
              : "回复连接意外中断，请稍后重试。";
          console.error("[sendLLMMessage] 非用户 abort", { convId, isWatchdogAborted });
          dispatch({
            type: "UPDATE_MESSAGE",
            payload: {
              conversationId: convId,
              messageId: assistantMsgId,
              content: fullContent ? `${fullContent}\n\n---\n*${automaticStopMessage}已保留已接收内容。*` : `发送失败：${automaticStopMessage}`,
              reasoningContent,
            },
          });
        } else {
          // 网络或上游失败会通过用户消息状态恢复，不应制造未处理错误噪声。
          console.warn("[sendLLMMessage] request failed:", error);
          const errorInfo = classifyError(error);
          const failureMessage = responseErrorMessage || customerStreamError(error instanceof Error ? error.message : error);
          
          if (fullContent.trim() || (reasoningContent && reasoningContent.trim())) {
            // 流式传输中途断开，但已收到部分内容 → 保留内容，追加中断提示
            // 不显示"发送失败"，避免丢失已接收的有用内容
            const suffix = fullContent.trim() ? `\n\n---\n*${failureMessage} 已保留已接收内容。*` : "";
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: fullContent + suffix, reasoningContent },
            });
          } else {
            // ★ 修复"消息消失"：完全失败时保留用户消息，只删除空的助手占位消息
            // 用户消息是用户输入，无论API是否成功都不应被删除（原逻辑DELETE_MESSAGE_PAIR会同时删除用户消息）
            // 修复后：删除空助手占位 + 标记用户消息失败（前端显示错误提示+重试按钮）
            dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: convId, messageId: assistantMsgId } });
            if (userMsgId) {
              dispatch({ type: "MARK_MESSAGE_ERROR", payload: { conversationId: convId, messageId: userMsgId, error: responseErrorMessage || errorInfo.userMessage } });
            }
          }
        }
      } finally {
        if (isStreamDebugEnabled()) console.log(`[sendLLMMessage finally] SET_MESSAGE_STREAMING false: convId=${convId}, msgId=${assistantMsgId}`);
        resetTypewriterState({ conversationId: convId, messageId: assistantMsgId });
        finalizeAbortController(convId, controller);
        dispatch({
          type: "SET_MESSAGE_STREAMING",
          payload: { conversationId: convId, messageId: assistantMsgId, isStreaming: false },
        });
        dispatch({ type: "SET_CONV_STREAMING", payload: { conversationId: convId, isStreaming: false } });
        // 立即同步更新 isStreamingRef，避免安全网读到过时值误触发
        // dispatch 是异步的（下次渲染才生效），但 ref 可以立即更新
        // 检查 streamingConvIdsRef 是否还有其他流式会话
        const remainingStreams = new Set(streamingConvIdsRef.current);
        remainingStreams.delete(convId);
        isStreamingRef.current = remainingStreams.size > 0;
        // AIWeb-style: sync to server immediately after streaming ends
        setTimeout(() => syncConversationToServer(convId), 500);
      }
    },
    []
  );

  // ---- Coze Bot message sending ----
  const sendCozeMessage = useCallback(
    async (
      convId: string,
      assistantMsgId: string,
      content: string,
      conversation: Conversation,
      agent: Agent,
      images?: string[],
      userMsgId?: string
    ) => {
      let fullContent = "";
      let rawContent = ""; // Raw accumulated content for think tag parsing
      let reasoningContent = "";
      let responseErrorMessage: string | null = null;
      let effectiveConvId = convId; // 跟踪重命名后的会话ID，用于 finally 块

      // Create new AbortController for this conversation's stream
      const controller = getOrCreateAbortController(convId);

      try {
        const res = await fetchWithRetry("/api/chat", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(authRef.current.token ? { Authorization: `Bearer ${authRef.current.token}` } : {}),
          },
          body: JSON.stringify({
            botId: agent.botId,
            agentId: agent.id,
            message: content,
            conversationId: conversation.id, // Always send — backend saves messages to DB
            userId: authRef.current.user?.id,
            agentName: agent.name,
            baseFee: agent.baseFee || 0,
            images,
          }),
        });

        if (!res.ok) {
          if (res.status === 401) {
            dispatch({ type: "LOGOUT" });
            if (typeof window !== "undefined") {
              clearStoredAuthSession();
              replaceWithPublicHome();
            }
            throw new Error("登录已过期，请重新登录");
          }
          if (res.status === 402) {
            const errData = await res.json().catch(() => ({}));
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("insufficient-balance", { detail: { mode: "credits", message: errData.error } }));
            }
            throw new Error(errData.error || "积分不足，请联系管理员充值");
          }
          if (res.status === 403) {
            const errData = await res.json().catch(() => ({}));
            // 被拉黑用户：自动撤回消息 + 强制登出
            if (errData.code === "USER_BLOCKED") {
              if (userMsgId) dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: convId, messageId: userMsgId } });
              dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: convId, messageId: assistantMsgId } });
              if (typeof window !== "undefined") {
                toast.error("消息已自动撤回：您的账户已被管理员拉黑");
                setTimeout(() => {
                  dispatch({ type: "FORCED_LOGOUT", payload: "您的账户已被管理员拉黑" });
                  clearStoredAuthSession();
                  replaceWithPublicHome();
                }, 2000);
              }
              return;
            }
            if (errData.code === "MEMBERSHIP_REQUIRED" && typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("membership-required"));
            }
            throw new Error(errData.error || "请求已被安全防护拦截");
          }
          if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            const retryAfter = errData.retryAfter ? `，请${errData.retryAfter}秒后再试` : "，请稍后再试";
            throw new Error(errData.error || `请求过于频繁${retryAfter}`);
          }
          const errData = await res.json().catch(() => ({}));
          responseErrorMessage = customerStreamError(Object.keys(errData).length ? errData : `Chat API error: ${res.status}`);
          throw new Error(responseErrorMessage);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No reader available");

        const sseDecoder = new SseEventStreamDecoder();
        let cozeConversationId = "";

        let cozeChunkIdx = 0;
        let cozeLastChunkTime = Date.now();
        let cozeStreamErrored = false;
        const COZE_SSE_READ_TIMEOUT = 310_000; // 310秒无数据视为流中断（对齐后端推理模型300秒超时+10秒缓冲）

        while (true) {
          if (cozeStreamErrored) break;
          let cozeReadTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const readPromise = reader.read();
          const timeoutPromise = new Promise<never>((_, reject) => {
            cozeReadTimeoutId = setTimeout(() => reject(new Error(`Coze SSE读取超时(${COZE_SSE_READ_TIMEOUT/1000}秒无数据)`)), COZE_SSE_READ_TIMEOUT);
          });
          const { done, value } = await Promise.race([readPromise, timeoutPromise])
            .finally(() => { if (cozeReadTimeoutId) clearTimeout(cozeReadTimeoutId); });
          if (!done) {
            cozeChunkIdx++;
            const cozeNow = Date.now();
            if (isStreamDebugEnabled() && (cozeChunkIdx <= 10 || cozeChunkIdx % 20 === 0)) {
              console.log(`[Coze 流式诊断] chunk #${cozeChunkIdx} | delta: ${cozeNow - cozeLastChunkTime}ms | rawSize: ${value?.length ?? 0}B`);
            }
            cozeLastChunkTime = cozeNow;
          }

          for (const event of done ? sseDecoder.finish() : sseDecoder.push(value)) {
              const currentEvent = event.event;
              const raw = event.data.trim();
              if (currentEvent === "done" || raw === "[DONE]") continue;
              try {
                const data = JSON.parse(raw);
                // 检测后端 proxy 发送的错误 chunk（如流中断、API 错误等）
                if (data.error && !data.content) {
                  const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
                  console.error("[sendCozeMessage] SSE stream error chunk:", errMsg);
                  const customerMessage = customerStreamError(data);
                  responseErrorMessage = customerMessage;
                  if (fullContent || reasoningContent) {
                    fullContent += `\n\n⚠ ${customerMessage}`;
                  } else {
                    fullContent = `⚠ ${customerMessage}`;
                  }
                  cozeStreamErrored = true;
                  break;
                }
                if (currentEvent === "conversation.chat.created" && data.conversation_id) {
                  cozeConversationId = data.conversation_id;
                }
                if (currentEvent === "conversation.message.delta") {
                  // Support both reasoning_content and reasoning fields
                  const reasoningChunk = data.reasoning_content || data.reasoning;
                  if (reasoningChunk) {
                    reasoningContent += reasoningChunk;
                    throttledDispatchUpdate({ conversationId: convId, messageId: assistantMsgId, content: fullContent, reasoningContent });
                  } else if (data.content) {
                    rawContent += data.content;
                    const shouldParseThinkTags = agent.enableThinkTags || (agent.deepThinkingType ?? agent.deep_thinking_type ?? 0) > 0;
                    if (shouldParseThinkTags) {
                      const parsed = parseThinkTags(rawContent);
                      fullContent = parsed.displayContent;
                      if (parsed.reasoningContent) {
                        reasoningContent = parsed.reasoningContent;
                      }
                    } else {
                      fullContent = rawContent;
                    }
                    throttledDispatchUpdate({ conversationId: convId, messageId: assistantMsgId, content: fullContent, reasoningContent });
                  }
                }
                if (currentEvent === "conversation.message.completed" && data.content) {
                  const shouldParseThinkTags = agent.enableThinkTags || (agent.deepThinkingType ?? agent.deep_thinking_type ?? 0) > 0;
                  if (shouldParseThinkTags) {
                    const parsed = parseThinkTags(data.content);
                    fullContent = parsed.displayContent;
                    reasoningContent = parsed.reasoningContent;
                  } else {
                    fullContent = data.content;
                  }
                  throttledDispatchUpdate({ conversationId: convId, messageId: assistantMsgId, content: fullContent, reasoningContent });
                }
              } catch {
                // Skip
              }
          }
          if (done || cozeStreamErrored) break;
        }

        // 最终内容仍走打字机队列。若本地临时会话随后要重命名，先在旧 ID 上追平，
        // 再整体 rename，避免旧 key 的动画队列残留或最终内容整段跳出。
        const finalContent = fullContent || reasoningContent || "（无回复内容）";
        await settleTypewriterUpdate({ conversationId: convId, messageId: assistantMsgId, content: finalContent, reasoningContent: fullContent ? reasoningContent : "" });

        if (cozeConversationId && isLocalConvId(convId)) {
          // 用新action正确替换会话ID（UPDATE_CONVERSATION按新ID查找会找不到旧记录）
          forgetPendingLocalConversation(convId);
          dispatch({ type: "RENAME_CONVERSATION_ID", payload: { oldId: convId, newId: cozeConversationId } });
          effectiveConvId = cozeConversationId; // 更新跟踪变量，确保 finally 块使用新ID
        }

        // Sync credits from backend after conversation
        fetchCredits().catch((e: unknown) => { console.error("[app-context] fetchCredits after LLM stream failed:", e instanceof Error ? e.message : e); });
      } catch (error) {
        const isUserAborted = userAbortedSet.current.has(convId);
        userAbortedSet.current.delete(convId);
        const isWatchdogAborted = watchdogAbortedSet.current.has(convId);
        watchdogAbortedSet.current.delete(convId);
        const isAbortError = isAbortLikeError(error);
        const isSignalAborted = controller.signal.aborted;

        console.warn("[sendCozeMessage] catch:", {
          convId, isUserAborted, isWatchdogAborted, isAbortError, isSignalAborted,
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
          fullContentLength: fullContent.length,
        });

        if (isUserAborted) {
          if (fullContent) {
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: fullContent + "\n\n[已终止]", reasoningContent },
            });
          } else {
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: "[已终止]" },
            });
          }
        } else if (isWatchdogAborted || isSignalAborted || isAbortError) {
          const automaticStopMessage = isWatchdogAborted
            ? "回复等待超过安全时限，系统已停止等待，请稍后重试。"
            : "回复连接意外中断，请稍后重试。";
          console.error("[sendCozeMessage] 非用户 abort", { convId, isWatchdogAborted });
          dispatch({
            type: "UPDATE_MESSAGE",
            payload: {
              conversationId: convId,
              messageId: assistantMsgId,
              content: fullContent ? `${fullContent}\n\n---\n*${automaticStopMessage}已保留已接收内容。*` : `发送失败：${automaticStopMessage}`,
              reasoningContent,
            },
          });
        } else {
          console.error("Coze chat error:", error);
          const failureMessage = responseErrorMessage || customerStreamError(error instanceof Error ? error.message : error);
          if (fullContent.trim() || (reasoningContent && reasoningContent.trim())) {
            // 流式传输中途断开，但已收到部分内容 → 保留内容，追加中断提示
            const suffix = fullContent.trim() ? `\n\n---\n*${failureMessage} 已保留已接收内容。*` : "";
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: fullContent + suffix, reasoningContent },
            });
          } else {
            // 完全没有收到内容 → 显示友好的错误提示
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: {
                conversationId: convId,
                messageId: assistantMsgId,
                content: `发送失败：${failureMessage}`,
              },
            });
          }
        }
      } finally {
        if (isStreamDebugEnabled()) console.log(`[sendCozeMessage finally] SET_MESSAGE_STREAMING false: convId=${effectiveConvId}, msgId=${assistantMsgId}`);
        resetTypewriterState({ conversationId: convId, messageId: assistantMsgId });
        finalizeAbortController(convId, controller);
        dispatch({ type: "SET_MESSAGE_STREAMING", payload: { conversationId: effectiveConvId, messageId: assistantMsgId, isStreaming: false } });
        dispatch({ type: "SET_CONV_STREAMING", payload: { conversationId: effectiveConvId, isStreaming: false } });
        // 立即同步更新 isStreamingRef，避免安全网读到过时值误触发
        const remainingStreams = new Set(streamingConvIdsRef.current);
        remainingStreams.delete(effectiveConvId);
        isStreamingRef.current = remainingStreams.size > 0;
        // AIWeb-style: sync to server immediately after streaming ends
        setTimeout(() => syncConversationToServer(effectiveConvId), 500);
      }
    },
    []
  );

  // ---- Coze Coding (stream_run) message sending ----
  const sendCozeCodingMessage = useCallback(
    async (
      convId: string,
      assistantMsgId: string,
      content: string,
      conversation: Conversation,
      agent: Agent,
      _images?: string[],
      userMsgId?: string
    ) => {
      let fullContent = "";
      let rawContent = ""; // Raw accumulated content for think tag parsing
      let reasoningContent = "";
      let responseErrorMessage: string | null = null;
      let effectiveConvId = convId; // 跟踪重命名后的会话ID，用于 finally 块

      // Create new AbortController for this conversation's stream
      const controller = getOrCreateAbortController(convId);

      try {
        const res = await fetchWithRetry("/api/chat/coding", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(authRef.current.token ? { Authorization: `Bearer ${authRef.current.token}` } : {}),
          },
          body: JSON.stringify({
            agentId: agent.id,
            projectId: agent.botId,
            message: content,
            sessionId: isLocalConvId(conversation.id) ? "" : conversation.id,
            userId: authRef.current.user?.id,
            agentName: agent.name,
          }),
        });

        if (!res.ok) {
          if (res.status === 401) {
            dispatch({ type: "LOGOUT" });
            if (typeof window !== "undefined") {
              clearStoredAuthSession();
              replaceWithPublicHome();
            }
            throw new Error("登录已过期，请重新登录");
          }
          if (res.status === 402) {
            const errData = await res.json().catch(() => ({}));
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("insufficient-balance", { detail: { mode: "credits", message: errData.error } }));
            }
            throw new Error(errData.error || "积分不足，请联系管理员充值");
          }
          if (res.status === 403) {
            const errData = await res.json().catch(() => ({}));
            // 被拉黑用户：自动撤回消息 + 强制登出
            if (errData.code === "USER_BLOCKED") {
              if (userMsgId) dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: convId, messageId: userMsgId } });
              dispatch({ type: "DELETE_MESSAGE", payload: { conversationId: convId, messageId: assistantMsgId } });
              if (typeof window !== "undefined") {
                toast.error("消息已自动撤回：您的账户已被管理员拉黑");
                setTimeout(() => {
                  dispatch({ type: "FORCED_LOGOUT", payload: "您的账户已被管理员拉黑" });
                  clearStoredAuthSession();
                  replaceWithPublicHome();
                }, 2000);
              }
              return;
            }
            throw new Error(errData.error || "请求已被拦截");
          }
          if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            const retryAfter = errData.retryAfter ? `，请${errData.retryAfter}秒后再试` : "，请稍后再试";
            throw new Error(errData.error || `请求过于频繁${retryAfter}`);
          }
          const errData = await res.json().catch(() => ({}));
          responseErrorMessage = customerStreamError(Object.keys(errData).length ? errData : `Coze Coding API error: ${res.status}`);
          throw new Error(responseErrorMessage);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No reader available");

        const sseDecoder = new SseEventStreamDecoder();
        let codingSessionId = "";
        let codingStreamErrored = false;
        const CODING_SSE_READ_TIMEOUT = 310_000; // 310秒无数据视为流中断（对齐后端推理模型300秒超时+10秒缓冲）

        while (true) {
          if (codingStreamErrored) break;
          let codingReadTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const readPromise = reader.read();
          const timeoutPromise = new Promise<never>((_, reject) => {
            codingReadTimeoutId = setTimeout(() => reject(new Error(`CozeCoding SSE读取超时(${CODING_SSE_READ_TIMEOUT/1000}秒无数据)`)), CODING_SSE_READ_TIMEOUT);
          });
          const { done, value } = await Promise.race([readPromise, timeoutPromise])
            .finally(() => { if (codingReadTimeoutId) clearTimeout(codingReadTimeoutId); });
          for (const event of done ? sseDecoder.finish() : sseDecoder.push(value)) {
              const raw = event.data.trim();
              if (raw === "" || raw === "[DONE]") continue;
              try {
                const data = JSON.parse(raw);

                // 检测后端 proxy 发送的错误 chunk（如流中断、API 错误等）
                if (data.error) {
                  const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
                  console.error("[sendCozeCodingMessage] SSE stream error chunk:", errMsg);
                  const customerMessage = customerStreamError(data);
                  responseErrorMessage = customerMessage;
                  if (fullContent || reasoningContent) {
                    fullContent += `\n\n⚠ ${customerMessage}`;
                  } else {
                    fullContent = `⚠ ${customerMessage}`;
                  }
                  codingStreamErrored = true;
                  break;
                }

                // ── 提取 Coze Coding session_id 用于上下文记忆 ──
                if (data.type === "session" && data.session_id) {
                  codingSessionId = data.session_id;
                }

                // Unified helper: accumulate content and throttle dispatch
                const accumulateAndDispatch = (chunk: string) => {
                  rawContent += chunk;
                  if (agent.enableThinkTags) {
                    const parsed = parseThinkTags(rawContent);
                    fullContent = parsed.displayContent;
                    if (parsed.reasoningContent) reasoningContent = parsed.reasoningContent;
                  } else {
                    fullContent = rawContent;
                  }
                  throttledDispatchUpdate({ conversationId: convId, messageId: assistantMsgId, content: fullContent, reasoningContent });
                };

                // 后端转发的简化格式: {"type":"content","content":"增量文字"}
                if (data.type === "content" && typeof data.content === "string") {
                  accumulateAndDispatch(data.content);
                }
                // Coze Coding 原始格式: {"type":"answer","content":{"answer":"增量文字"}}
                if (data.type === "answer" && data.content?.answer) {
                  accumulateAndDispatch(data.content.answer);
                }
                // 兼容: content 为纯字符串
                if (data.type === "answer" && typeof data.content === "string" && !data.content?.answer) {
                  accumulateAndDispatch(data.content);
                }
                if (data.type === "done") {
                  // 流结束
                }
                if (data.delta?.content) {
                  accumulateAndDispatch(data.delta.content);
                }
                if (data.choices?.[0]?.delta?.content) {
                  accumulateAndDispatch(data.choices[0].delta.content);
                }
                if (data.content && typeof data.content === "string" && !data.type && !data.delta && !data.choices) {
                  accumulateAndDispatch(data.content);
                }
                // Support both reasoning_content and reasoning fields
                const reasoningChunk2 = data.reasoning_content || data.reasoning;
                if (reasoningChunk2) {
                  reasoningContent += reasoningChunk2;
                  throttledDispatchUpdate({ conversationId: convId, messageId: assistantMsgId, content: fullContent, reasoningContent });
                }
              } catch {
                // Skip non-JSON
              }
          }
          if (done || codingStreamErrored) break;
        }

        const cozeFinalContent = fullContent || reasoningContent || "（无回复内容）";
        await settleTypewriterUpdate({ conversationId: convId, messageId: assistantMsgId, content: cozeFinalContent, reasoningContent: fullContent ? reasoningContent : "" });

        // ── 更新会话ID：Coze Coding 返回的 session_id 需要保存，以维持上下文记忆 ──
        if (codingSessionId && isLocalConvId(convId)) {
          forgetPendingLocalConversation(convId);
          dispatch({ type: "RENAME_CONVERSATION_ID", payload: { oldId: convId, newId: codingSessionId } });
          effectiveConvId = codingSessionId; // 更新跟踪变量，确保 finally 块使用新ID
        }
        fetchCredits().catch((e: unknown) => { console.error("[app-context] fetchCredits after LLM stream failed:", e instanceof Error ? e.message : e); });
      } catch (error) {
        const isUserAborted = userAbortedSet.current.has(convId);
        userAbortedSet.current.delete(convId);
        const isWatchdogAborted = watchdogAbortedSet.current.has(convId);
        watchdogAbortedSet.current.delete(convId);
        const isAbortError = isAbortLikeError(error);
        const isSignalAborted = controller.signal.aborted;

        console.warn("[sendCozeCodingMessage] catch:", {
          convId, isUserAborted, isWatchdogAborted, isAbortError, isSignalAborted,
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
          fullContentLength: fullContent.length,
        });

        if (isUserAborted) {
          if (fullContent) {
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: fullContent + "\n\n[已终止]", reasoningContent },
            });
          } else {
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: "[已终止]" },
            });
          }
        } else if (isWatchdogAborted || isSignalAborted || isAbortError) {
          const automaticStopMessage = isWatchdogAborted
            ? "回复等待超过安全时限，系统已停止等待，请稍后重试。"
            : "回复连接意外中断，请稍后重试。";
          console.error("[sendCozeCodingMessage] 非用户 abort", { convId, isWatchdogAborted });
          dispatch({
            type: "UPDATE_MESSAGE",
            payload: {
              conversationId: convId,
              messageId: assistantMsgId,
              content: fullContent ? `${fullContent}\n\n---\n*${automaticStopMessage}已保留已接收内容。*` : `发送失败：${automaticStopMessage}`,
              reasoningContent,
            },
          });
        } else {
          console.error("Coze Coding chat error:", error);
          const failureMessage = responseErrorMessage || customerStreamError(error instanceof Error ? error.message : error);
          if (fullContent.trim() || (reasoningContent && reasoningContent.trim())) {
            // 流式传输中途断开，但已收到部分内容 → 保留内容，追加中断提示
            const suffix = fullContent.trim() ? `\n\n---\n*${failureMessage} 已保留已接收内容。*` : "";
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: { conversationId: convId, messageId: assistantMsgId, content: fullContent + suffix, reasoningContent },
            });
          } else {
            // 完全没有收到内容 → 显示友好的错误提示
            dispatch({
              type: "UPDATE_MESSAGE",
              payload: {
                conversationId: convId,
                messageId: assistantMsgId,
                content: `发送失败：${failureMessage}`,
              },
            });
          }
        }
      } finally {
        if (isStreamDebugEnabled()) console.log(`[sendCozeCodingMessage finally] SET_MESSAGE_STREAMING false: convId=${effectiveConvId}, msgId=${assistantMsgId}`);
        resetTypewriterState({ conversationId: convId, messageId: assistantMsgId });
        finalizeAbortController(convId, controller);
        dispatch({ type: "SET_MESSAGE_STREAMING", payload: { conversationId: effectiveConvId, messageId: assistantMsgId, isStreaming: false } });
        dispatch({ type: "SET_CONV_STREAMING", payload: { conversationId: effectiveConvId, isStreaming: false } });
        // 立即同步更新 isStreamingRef，避免安全网读到过时值误触发
        const remainingStreams = new Set(streamingConvIdsRef.current);
        remainingStreams.delete(effectiveConvId);
        isStreamingRef.current = remainingStreams.size > 0;
        // AIWeb-style: sync to server immediately after streaming ends
        setTimeout(() => syncConversationToServer(effectiveConvId), 500);
      }
    },
    []
  );

  const selectConversation = useCallback(
    (conversationId: string) => {
      const conv = state.conversations.find((c) => c.id === conversationId);
      if (conv) {
        // 优先按botId匹配，其次按agentId匹配
        // 注意：LLM智能体的botId为null，__free_chat__的botId也是null，
        // null===null会导致错误匹配，所以botId匹配时排除null/空值
        const agent = (conv.botId ? state.agents.find((a) => a.botId === conv.botId) : null)
          || (conv.agentId ? state.agents.find((a) => a.id === conv.agentId) : null);
        // 如果找不到agent，保留对话原有的agentId（而不是设为null）
        // 这样 sendMessage 时仍能通过重试机制找到agent
        dispatch({ type: "SET_ACTIVE_AGENT", payload: agent?.id || conv.agentId || null });
      }
      dispatch({ type: "SET_ACTIVE_CONVERSATION", payload: conversationId });
      dispatch({ type: "SET_VIEW", payload: "chat" });
      // Lazy load messages if not yet loaded
      if (conv && !conv.messagesLoaded) {
        loadMessagesForConversation(conversationId);
      }
      // 同步 updatedAt 到服务端（保证刷新后排序一致）
      syncConversationToServer(conversationId);
    },
    [state.conversations, state.agents, loadMessagesForConversation, syncConversationToServer]
  );

  const deleteConversation = useCallback((conversationId: string) => {
    forgetPendingLocalConversation(conversationId);
    dispatch({ type: "DELETE_CONVERSATION", payload: conversationId });
    // Delete from server
    const token = authRef.current?.token || safeGet(STORAGE_KEYS.AUTH_TOKEN);
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    fetch(`/api/conversations/history?id=${encodeURIComponent(conversationId)}`, { method: "DELETE", headers }).catch((e: unknown) => { console.error("[app-context] deleteConversation history failed:", e instanceof Error ? e.message : e); });
    if (!isLocalConvId(conversationId)) {
      fetch(`/api/conversations/${conversationId}`, { method: "DELETE", headers }).catch((e: unknown) => { console.error("[app-context] deleteConversation failed:", e instanceof Error ? e.message : e); });
    }
  }, [forgetPendingLocalConversation]);

  const togglePinAgent = useCallback((agentId: string) => {
    dispatch({ type: "TOGGLE_PIN_AGENT", payload: agentId });
  }, []);

  const fetchCredits = useCallback(async () => {
    try {
      // 优先使用登录用户的积分
      const userId = authRef.current?.user?.id;
      if (userId) {
        const res = await fetch(`/api/credits?user_id=${userId}`, {
          headers: authRef.current?.token ? { Authorization: `Bearer ${authRef.current.token}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          const serverCredits = Number(data.credits ?? 0);
          dispatch({
            type: "SET_CREDITS",
            payload: {
              total: serverCredits,
              used: 0,
              remaining: serverCredits,
              costPerMessage: 10,
            },
          });
          // 同步现金余额
          if (data.cashBalance !== undefined) {
            dispatch({ type: "SET_CASH_BALANCE", payload: data.cashBalance });
          }
          // 同步 auth.user.credits，确保侧边栏积分实时更新
          const currentUser = authRef.current?.user;
          if (currentUser && currentUser.credits !== serverCredits) {
            dispatch({
              type: "SET_AUTH",
              payload: { user: { ...currentUser, credits: serverCredits }, token: authRef.current?.token || null },
            });
          }
          return;
        }
      }
      // 未登录或查询失败，使用默认积分（不阻止对话）
      dispatch({
        type: "SET_CREDITS",
        payload: { ...defaultCredits },
      });
    } catch {
      // 查询失败也设置默认积分，不要阻止对话
      dispatch({
        type: "SET_CREDITS",
        payload: { ...defaultCredits },
      });
    }
  }, []);

  const rechargeCredits = useCallback(async (_amount: number) => {
    try {
      // 充值只能通过管理员操作，这里仅刷新本地积分
      const userId = authRef.current?.user?.id;
      if (userId) {
        const res = await fetch(`/api/credits?user_id=${userId}`, {
          headers: authRef.current?.token ? { Authorization: `Bearer ${authRef.current.token}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          dispatch({ type: "SET_CREDITS", payload: { total: Number(data.credits) || 0, used: 0, remaining: Number(data.credits) || 0, costPerMessage: state.credits.costPerMessage } });
        }
      }
    } catch (error) {
      console.error("[credits] realtime refresh failed after recharge", error);
    }
  }, []);

  const login = useCallback(async (username: string, password: string, securityAnswer?: string): Promise<{ success: boolean; error?: string; code?: string; securityQuestion?: string; region?: { province: string; city: string } }> => {
    try {
      const body: Record<string, string | undefined> = { phone: username, password };
      if (securityAnswer) body.securityAnswer = securityAnswer;

      const controller = new AbortController();
      const loginTimeout = setTimeout(() => controller.abort(), 45000);
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(loginTimeout);
      const data = await res.json();

      // 非贵州IP需要安全问题验证
      if (res.status === 403 && data.code === "REGION_VERIFY_REQUIRED") {
        return { success: false, error: data.error, code: data.code, securityQuestion: data.securityQuestion, region: data.region };
      }

      // 安全问题答案错误
      if (res.status === 403 && data.code === "SECURITY_ANSWER_WRONG") {
        return { success: false, error: data.error, code: data.code };
      }

      if (data.success && data.user && data.token) {
        persistStoredAuthSession(data.token, data.user);
        let authenticatedUser = data.user;
        let platformTheme = normalizeTheme(safeGet(STORAGE_KEYS.PLATFORM_THEME) || DEFAULT_THEME);
        let platformMode = normalizeThemeModePreference(safeGet(STORAGE_KEYS.PLATFORM_THEME_MODE))
          || DEFAULT_MODE_PREFERENCE;
        try {
          const [settingsRes, meRes] = await Promise.all([
            getClientBootstrapAppearance({ force: true }),
            getClientBootstrapAuthMe(data.token, { force: true }),
          ]);
          if (settingsRes.ok) {
            const settingsData = await settingsRes.json();
            platformTheme = normalizeTheme(settingsData.settings?.theme);
            platformMode = normalizeThemeModePreference(settingsData.settings?.theme_mode)
              || DEFAULT_MODE_PREFERENCE;
            safeSet(STORAGE_KEYS.PLATFORM_THEME, platformTheme);
            safeSet(STORAGE_KEYS.PLATFORM_THEME_MODE, platformMode);
          }
          if (meRes.ok) {
            const meData = await meRes.json();
            authenticatedUser = meData.user || authenticatedUser;
          }
        } catch {}

        persistStoredAuthSession(data.token, authenticatedUser);
        dispatch({ type: "SET_AUTH", payload: { user: authenticatedUser, token: data.token } });
        const userPref = authenticatedUser.themePreference || authenticatedUser.theme_preference;
        const userMode = normalizeThemeModePreference(
          authenticatedUser.themeModePreference || authenticatedUser.theme_mode_preference,
        );
        if (userPref && userMode) {
          safeSet(STORAGE_KEYS.USER_THEME_PREFERENCE, userPref);
          safeSet(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE, userMode);
          dispatch({ type: "SET_APPEARANCE", payload: resolveAppearance(userPref, userMode) });
        } else {
          safeRemove(STORAGE_KEYS.USER_THEME_PREFERENCE);
          safeRemove(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE);
          dispatch({ type: "SET_APPEARANCE", payload: resolveAppearance(platformTheme, platformMode) });
        }
        dispatch({
          type: "SET_CREDITS",
          payload: {
            total: Number(data.user.credits ?? 0),
            used: 0,
            remaining: Number(data.user.credits ?? 0),
            costPerMessage: state.credits.costPerMessage,
          },
        });
        return { success: true };
      }
      if (typeof window !== "undefined" && window.location.pathname !== "/") replaceWithPublicHome();
      return { success: false, error: data.error || "登录失败" };
    } catch {
      if (typeof window !== "undefined" && window.location.pathname !== "/") replaceWithPublicHome();
      return { success: false, error: "网络错误或请求超时，请稍后重试" };
    }
  }, []);

  const logout = useCallback(() => {
    // Clear the HttpOnly cookie too. The sidebar navigates immediately after
    // logout, so keepalive prevents that navigation from cancelling the call.
    const token = state.auth.token || safeGet(STORAGE_KEYS.AUTH_TOKEN);
    fetch("/api/auth/logout", {
      method: "POST",
      keepalive: true,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
    clearStoredAuthSession();
    // 个性化外观属于 user + IP 的服务端租约。登出后立即回到平台
    // 默认，避免下一位使用同一浏览器的账号看到前一账号偏好。
    safeRemove(STORAGE_KEYS.USER_THEME_PREFERENCE);
    safeRemove(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE);
    clearConversationCache();
    dispatch({ type: "LOGOUT" });
    const platformTheme = safeGet(STORAGE_KEYS.PLATFORM_THEME) || DEFAULT_THEME;
    const platformMode = normalizeThemeModePreference(safeGet(STORAGE_KEYS.PLATFORM_THEME_MODE))
      || DEFAULT_MODE_PREFERENCE;
    dispatch({ type: "SET_APPEARANCE", payload: resolveAppearance(platformTheme, platformMode) });
  }, [state.auth.token]);

  const persistUserAppearancePreference = useCallback(async (
    theme: string,
    modePreference: ThemeModePreference,
  ) => {
    const token = state.auth.token || safeGet(STORAGE_KEYS.AUTH_TOKEN);
    if (!token) return false;
    let persisted = false;
    const save = async () => {
      if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
      invalidateClientBootstrapAuthMe();
      try {
        const response = await fetch("/api/auth/me", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            theme_preference: theme,
            theme_mode_preference: modePreference,
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
        safeSet(STORAGE_KEYS.USER_THEME_PREFERENCE, theme);
        safeSet(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE, modePreference);
        persisted = true;
      } catch {
        console.warn("[theme] 保存七天用户外观偏好失败");
      } finally {
        // A GET started while the mutation was pending may contain the old DB
        // preference, so evict once more after the write settles.
        invalidateClientBootstrapAuthMe();
      }
    };
    const queued = themePreferenceSaveChainRef.current.catch(() => undefined).then(save);
    themePreferenceSaveChainRef.current = queued;
    await queued;
    return persisted;
  }, [state.auth.token]);

  /** 保存用户主题与当前模式；服务端绑定 user + IP 并签发七天有效期。 */
  const saveUserThemePreference = useCallback(async (theme: string) => {
    const normalizedTheme = normalizeTheme(theme);
    const modePreference = appearanceIntentRef.current.modePreference;
    appearanceIntentRef.current = { theme: normalizedTheme, modePreference };
    const persisted = await persistUserAppearancePreference(normalizedTheme, modePreference);
    if (persisted) {
      dispatch({ type: "SET_APPEARANCE", payload: resolveAppearance(normalizedTheme, modePreference) });
    } else {
      toast.error("主题偏好保存失败，请稍后重试");
    }
  }, [persistUserAppearancePreference]);

  const setThemeModePreference = useCallback(async (preference: ThemeModePreference) => {
    const normalizedPreference = normalizeThemeModePreference(preference);
    if (!normalizedPreference) return;
    const theme = appearanceIntentRef.current.theme;
    appearanceIntentRef.current = { theme, modePreference: normalizedPreference };
    const persisted = await persistUserAppearancePreference(theme, normalizedPreference);
    if (persisted) {
      dispatch({
        type: "SET_APPEARANCE",
        payload: resolveAppearance(theme, normalizedPreference),
      });
    } else {
      toast.error("明暗模式保存失败，请稍后重试");
    }
  }, [persistUserAppearancePreference]);

  const toggleMode = useCallback(() => {
    // 保留旧 Context 接口，旧调用也只能回到系统跟随，不能再人为切换明暗。
    void setThemeModePreference("system");
  }, [setThemeModePreference]);

  const changePassword = useCallback(async (oldPassword: string, newPassword: string): Promise<boolean> => {
    try {
      const token = state.auth.token || safeGet(STORAGE_KEYS.AUTH_TOKEN);
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json();
      return data.success === true;
    } catch {
      return false;
    }
  }, [state.auth.token]);

  // 注册功能
  const register = useCallback(async (email: string, phone: string, code: string, displayName?: string, password?: string, invitationCode?: string, deviceId?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, phone, code, displayName, password, invitationCode, deviceId }),
      });
      const data = await res.json();

      if (data.success && data.user && data.token) {
        persistStoredAuthSession(data.token, data.user);
        dispatch({ type: "SET_AUTH", payload: { user: data.user, token: data.token } });
        safeRemove(STORAGE_KEYS.USER_THEME_PREFERENCE);
        safeRemove(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE);
        const platformTheme = safeGet(STORAGE_KEYS.PLATFORM_THEME) || DEFAULT_THEME;
        const platformMode = normalizeThemeModePreference(safeGet(STORAGE_KEYS.PLATFORM_THEME_MODE))
          || DEFAULT_MODE_PREFERENCE;
        dispatch({ type: "SET_APPEARANCE", payload: resolveAppearance(platformTheme, platformMode) });
        dispatch({
          type: "SET_CREDITS",
          payload: {
            total: data.user.credits || 0,
            used: 0,
            remaining: data.user.credits || 0,
            costPerMessage: 10,
          },
        });
        return { success: true };
      }

      return { success: false, error: data.error || "注册失败" };
    } catch {
      return { success: false, error: "网络错误，请稍后重试" };
    }
  }, []);

  const runAuthCheck = useCallback(async (force: boolean) => {
    const token = safeGet(STORAGE_KEYS.AUTH_TOKEN);
    const userStr = safeGet(STORAGE_KEYS.AUTH_USER);
    let cachedUser: AuthUser | null = null;
    if (userStr) {
      try {
        cachedUser = JSON.parse(userStr) as AuthUser;
      } catch {
        safeRemove(STORAGE_KEYS.AUTH_USER);
      }
    }

    // AUTH_USER is only a cache. A still-valid token must be able to rebuild it
    // after storage cleanup, partial migration, or a previous interrupted write.
    if (token) {
      try {
        // Verify token is still valid
        const res = await getClientBootstrapAuthMe(token, { force });
        if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
        // 拉黑用户检测：/api/auth/me 返回 403 + USER_BLOCKED → 强制登出
        if (res.status === 403) {
          try {
            const errData = await res.json();
            if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
            if (errData.code === "USER_BLOCKED") {
              const reason = "您的账户已被管理员拉黑";
              dispatch({ type: "FORCED_LOGOUT", payload: reason });
              clearStoredAuthSession();
              if (typeof window !== "undefined") {
                toast.error(reason);
                setTimeout(() => replaceWithPublicHome(reason), 1500);
              }
              return;
            }
          } catch { /* ignore parse error */ }
        }
        if (res.ok) {
          const data = await res.json();
          if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
          const authUser = data.user || cachedUser;
          if (!authUser) throw new Error("认证响应缺少用户信息");
          safeSet(STORAGE_KEYS.AUTH_USER, JSON.stringify(authUser));
          dispatch({ type: "SET_AUTH", payload: { user: authUser, token } });
          // 用户显式选择优先；DB 空偏好持续继承平台默认，并清理
          // 可能来自上一账号的浏览器主题和模式。
          const userThemePref = authUser?.themePreference || authUser?.theme_preference;
          const userModePref = normalizeThemeModePreference(
            authUser?.themeModePreference || authUser?.theme_mode_preference,
          );
          if (userThemePref && userModePref) {
            safeSet(STORAGE_KEYS.USER_THEME_PREFERENCE, userThemePref);
            safeSet(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE, userModePref);
            dispatch({ type: "SET_APPEARANCE", payload: resolveAppearance(userThemePref, userModePref) });
          } else {
            safeRemove(STORAGE_KEYS.USER_THEME_PREFERENCE);
            safeRemove(STORAGE_KEYS.USER_THEME_MODE_PREFERENCE);
            let platformTheme = normalizeTheme(safeGet(STORAGE_KEYS.PLATFORM_THEME) || DEFAULT_THEME);
            let platformMode = normalizeThemeModePreference(safeGet(STORAGE_KEYS.PLATFORM_THEME_MODE))
              || DEFAULT_MODE_PREFERENCE;
            try {
              const settingsRes = await getClientBootstrapAppearance();
              const settingsData = await settingsRes.json();
              platformTheme = normalizeTheme(settingsData.settings?.theme);
              platformMode = normalizeThemeModePreference(settingsData.settings?.theme_mode)
                || DEFAULT_MODE_PREFERENCE;
              safeSet(STORAGE_KEYS.PLATFORM_THEME, platformTheme);
              safeSet(STORAGE_KEYS.PLATFORM_THEME_MODE, platformMode);
            } catch {}
            dispatch({ type: "SET_APPEARANCE", payload: resolveAppearance(platformTheme, platformMode) });
          }
          // Sync credits from server after auth confirmed
          if (authUser?.id) {
            try {
              const creditsRes = await fetch(`/api/credits?user_id=${authUser.id}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
              if (creditsRes.ok) {
                const creditsData = await creditsRes.json();
                if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
                dispatch({
                  type: "SET_CREDITS",
                  payload: {
                    total: Number(creditsData.credits ?? 0),
                    used: 0,
                    remaining: Number(creditsData.credits ?? 0),
                    costPerMessage: 10,
                  },
                });
                // 同步现金余额（充值后首次加载需要）
                if (creditsData.cashBalance !== undefined) {
                  dispatch({ type: "SET_CASH_BALANCE", payload: creditsData.cashBalance });
                }
              }
            } catch {
              // Credits fetch failed, use defaults
            }
          }
          return;
        }

        if (res.status === 401 || res.status === 403 || res.status === 404) {
          const reason = "登录状态已失效，请重新登录";
          clearStoredAuthSession();
          dispatch({ type: "FORCED_LOGOUT", payload: reason });
          replaceWithPublicHome(reason);
          return;
        } else if (res.status >= 500 && cachedUser) {
          // A transient server outage must not erase a locally recoverable login.
          dispatch({ type: "SET_AUTH", payload: { user: cachedUser, token } });
          return;
        }
      } catch {
        if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
        // Network failures keep a complete cached session usable. The periodic
        // auth check will reconcile it once the server is reachable again.
        if (cachedUser) {
          dispatch({ type: "SET_AUTH", payload: { user: cachedUser, token } });
          return;
        }
      }
    } else {
      invalidateClientBootstrapAuthMe();
    }
    // Not authenticated: clear auth only. The visual theme preference is not login state.
    if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
    dispatch({ type: "SET_AUTH", payload: { user: null, token: null } });
    if (
      !token
      && typeof window !== "undefined"
      && shouldReturnUnauthenticatedVisitorHome(window.location.pathname)
    ) {
      replaceWithPublicHome();
    }
  }, []);

  const checkAuth = useCallback((options: { force?: boolean } = {}): Promise<void> => {
    const requestToken = safeGet(STORAGE_KEYS.AUTH_TOKEN);
    if (checkAuthInFlightRef.current?.token === requestToken) {
      return checkAuthInFlightRef.current.promise;
    }

    let trackedRequest: Promise<void>;
    trackedRequest = runAuthCheck(options.force ?? true).finally(() => {
      if (checkAuthInFlightRef.current?.promise === trackedRequest) {
        checkAuthInFlightRef.current = null;
      }
    });
    checkAuthInFlightRef.current = { token: requestToken, promise: trackedRequest };
    return trackedRequest;
  }, [runAuthCheck]);

  // Check auth on mount
  useEffect(() => {
    try {
      const reason = sessionStorage.getItem(AUTH_LOGOUT_REASON_KEY);
      if (reason) {
        sessionStorage.removeItem(AUTH_LOGOUT_REASON_KEY);
        dispatch({ type: "FORCED_LOGOUT", payload: reason });
      }
    } catch {}
    void checkAuth({ force: false });
  }, [checkAuth]);

  // Keep the page-local auth cache aligned with login/logout in another tab.
  // Same-tab token writes go through persist/clearStoredAuthSession above.
  useEffect(() => {
    const handleAuthStorageChange = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEYS.AUTH_TOKEN) return;
      invalidateClientBootstrapAuthMe();
      checkAuthInFlightRef.current = null;
      clearConversationCache();
      dispatch({ type: "LOGOUT" });
      if (event.newValue) void checkAuth({ force: false });
      else replaceWithPublicHome("登录状态已在其他窗口退出");
    };

    window.addEventListener("storage", handleAuthStorageChange);
    return () => window.removeEventListener("storage", handleAuthStorageChange);
  }, [checkAuth]);

  // Periodic session check - detect forced logout from another device (every 30s)
  useEffect(() => {
    if (!state.auth.isAuthenticated) return;
    const interval = setInterval(async () => {
      const token = safeGet(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) {
        invalidateClientBootstrapAuthMe();
        dispatch({ type: "SET_AUTH", payload: { user: null, token: null } });
        replaceWithPublicHome();
        return;
      }
      try {
        const res = await getClientBootstrapAuthMe(token, { force: true });
        if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
        if (!res.ok) {
          // 5xx 服务端错误（502/503/504 等）不应触发强制登出
          // 可能是 Nginx 重启、服务短暂不可用等，并非 token 失效
          if (res.status >= 500) return;
          try {
            const data = await res.json();
            if (safeGet(STORAGE_KEYS.AUTH_TOKEN) !== token) return;
            // Session invalidated by another login (401/403)
            clearStoredAuthSession();
            // Forced auth logout also preserves the local visual theme.
            const reason = data.error || "账号已在其他设备登录";
            dispatch({ type: "FORCED_LOGOUT", payload: reason });
            replaceWithPublicHome(reason);
          } catch {
            // JSON 解析失败，可能是 5xx 返回的 HTML 错误页，不登出
          }
        }
      } catch {
        // Network error, ignore - don't force logout on network issues
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [state.auth.isAuthenticated]);

  // Returning to the tab should reconcile a revoked/expired session at once;
  // the interval remains a background safety net.
  useEffect(() => {
    if (!state.auth.isAuthenticated) return;
    const reconcileVisibleSession = () => {
      if (document.visibilityState === "visible") void checkAuth({ force: true });
    };
    window.addEventListener("focus", reconcileVisibleSession);
    document.addEventListener("visibilitychange", reconcileVisibleSession);
    return () => {
      window.removeEventListener("focus", reconcileVisibleSession);
      document.removeEventListener("visibilitychange", reconcileVisibleSession);
    };
  }, [checkAuth, state.auth.isAuthenticated]);

  // 当窗口重新获得焦点时刷新余额（用户从支付App返回后自动检测到账）
  useEffect(() => {
    if (!state.auth.isAuthenticated) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchCredits().catch(() => { /* ignore */ });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [state.auth.isAuthenticated, fetchCredits]);

  // 每10分钟自动刷新积分和现金余额
  useEffect(() => {
    if (!state.auth.isAuthenticated) return;
    const interval = setInterval(() => { fetchCredits().catch(() => { /* ignore */ }); }, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [state.auth.isAuthenticated, fetchCredits]);

  // Load layout config on mount
  useEffect(() => {
    const fetchLayoutConfig = async (force = false) => {
      try {
        const res = await getClientBootstrapLayout({ force });
        const data = await res.json();
        if (data.layout) {
          dispatch({ type: "SET_LAYOUT_CONFIG", payload: data.layout });
        }
      } catch {
        // use defaults
      }
    };
    void fetchLayoutConfig();

    // 当窗口重新获得焦点时，重新 fetch 布局配置（确保管理员修改后用户端及时更新）
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchLayoutConfig(true);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // 每5分钟轻量检查布局配置是否有更新（管理员保存后下次切回页面时可见）
    const layoutInterval = setInterval(() => { void fetchLayoutConfig(true); }, 5 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(layoutInterval);
    };
  }, []);

  return (
    <AppContext.Provider
      value={{
        state,
        dispatch,
        fetchAgents,
        startChat,
        startFreeChat,
        sendMessage,
        abortCurrentStream,
        isConvStreaming: (convId: string) => {
          return state.streamingConvIds ? state.streamingConvIds.has(convId) : state.isStreaming;
        },
        selectConversation,
        loadMessagesForConversation,
        deleteConversation,
        togglePinAgent,
        fetchCredits,
        rechargeCredits,
        login,
        logout,
        saveUserThemePreference,
        setThemeModePreference,
        changePassword,
        register,
        checkAuth,
        toggleMode,
        fetchLayoutConfig: async () => {
          try {
            const res = await getClientBootstrapLayout({ force: true });
            const data = await res.json();
            if (data.layout) {
              dispatch({ type: "SET_LAYOUT_CONFIG", payload: data.layout });
            }
          } catch (err) {
            console.error("[layout] fetch error:", err);
          }
        },
        saveLayoutConfig: async (layout: PageLayoutConfig) => {
          const token = state.auth.token;
          invalidateClientBootstrapLayout();
          const res = await fetch("/api/settings/layout", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token || ""}`,
            },
            body: JSON.stringify({ layout, token }),
          });
          const data = await res.json();
          if (data.success) {
            invalidateClientBootstrapLayout();
            dispatch({ type: "SET_LAYOUT_CONFIG", payload: layout });
          } else {
            throw new Error(data.error || "保存失败");
          }
        },
        pendingPresetMessage: state.pendingPresetMessage,
        setPendingPresetMessage: (msg: { convId: string; content: string; autoSend?: boolean } | null) => {
          dispatch({ type: "SET_PENDING_PRESET_MESSAGE", payload: msg });
        },
        forcedLogoutReason: state.forcedLogoutReason,
        clearForcedLogout: () => {
          try { sessionStorage.removeItem(AUTH_LOGOUT_REASON_KEY); } catch {}
          clearStoredAuthSession();
          dispatch({ type: "LOGOUT" });
          replaceWithPublicHome();
        },
        resetLayoutConfig: async () => {
          const token = state.auth.token;
          invalidateClientBootstrapLayout();
          const res = await fetch(`/api/settings/layout?token=${token}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token || ""}` },
          });
          const data = await res.json();
          if (data.success) {
            invalidateClientBootstrapLayout();
            dispatch({ type: "SET_LAYOUT_CONFIG", payload: DEFAULT_PAGE_LAYOUT });
          } else {
            throw new Error(data.error || "重置失败");
          }
        },
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}
