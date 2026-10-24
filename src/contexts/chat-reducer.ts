/**
 * Chat Reducer — 纯函数状态管理
 * 
 * 从 app-context.tsx 拆分出来的 reducer + 类型定义。
 * 零 React 依赖，零 hooks，纯数据变换。
 */

import type { Agent, Conversation, Message, CreditsInfo, AuthUser, PageLayoutConfig } from "@/types/coze";
import { DEFAULT_PAGE_LAYOUT } from "@/types/coze";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { isVirtualChatAgentId } from "@/lib/virtual-chat-agents";
import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  normalizeTheme,
  normalizeThemeModePreference,
  type ThemeMode,
  type ThemeModePreference,
} from "@/lib/themes";

function getAssistantHistoryContent(message: Message): string {
  if (message.role !== "assistant") return "";
  if (message.content?.trim()) return message.content;
  if (message.reasoningContent?.trim()) return message.reasoningContent;
  if (message.generatedImages?.length) return "[图片生成记录]";
  return "";
}

// ---- State Shape ----
export interface AppState {
  agents: Agent[];
  pinnedAgentIds: string[];
  conversations: Conversation[];
  activeConversationId: string | null;
  activeAgentId: string | null;
  view: "marketplace" | "chat" | "profile" | "format" | "segment" | "cover" | "create" | string;
  isLoadingAgents: boolean;
  streamingConvIds: Set<string>;
  isStreaming: boolean;
  isChatFullscreen: boolean;
  credits: CreditsInfo;
  cashBalance: number;
  theme: string;
  modePreference: ThemeModePreference;
  mode: ThemeMode;
  layoutConfig: PageLayoutConfig;
  editMode: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  pendingPresetMessage: { convId: string; content: string; autoSend?: boolean } | null;
  auth: {
    user: AuthUser | null;
    token: string | null;
    isAuthenticated: boolean;
  };
  forcedLogoutReason: string | null;
}

export const defaultCredits: CreditsInfo = {
  total: 0,
  used: 0,
  remaining: 0,
  costPerMessage: 10,
};

export const initialState: AppState = {
  agents: [],
  pinnedAgentIds: [],
  conversations: [],
  activeConversationId: null,
  activeAgentId: null,
  view: "marketplace",
  isLoadingAgents: false,
  streamingConvIds: new Set<string>(),
  isStreaming: false,
  isChatFullscreen: false,
  credits: defaultCredits,
  cashBalance: 0,
  theme: DEFAULT_THEME,
  modePreference: DEFAULT_MODE_PREFERENCE,
  mode: "dark",
  layoutConfig: DEFAULT_PAGE_LAYOUT,
  editMode: false,
  sidebarWidth: 300,
  sidebarCollapsed: false,
  auth: {
    user: null,
    token: null,
    isAuthenticated: false,
  },
  pendingPresetMessage: null as { convId: string; content: string; autoSend?: boolean } | null,
  forcedLogoutReason: null,
};

// ---- Actions ----
export type Action =
  | { type: "SET_AGENTS"; payload: Agent[] }
  | { type: "ADD_AGENTS"; payload: Agent[] }
  | { type: "UPDATE_AGENT_CATEGORY"; payload: { agentId: string; category: string; sort_order?: number } }
  | { type: "SET_LOADING_AGENTS"; payload: boolean }
  | { type: "TOGGLE_PIN_AGENT"; payload: string }
  | { type: "SET_PINNED"; payload: string[] }
  | { type: "START_CONVERSATION"; payload: Conversation }
  | { type: "ADD_CONVERSATION"; payload: Conversation }
  | { type: "UPDATE_CONVERSATION"; payload: Conversation }
  | { type: "RENAME_CONVERSATION_ID"; payload: { oldId: string; newId: string } }
  | { type: "DELETE_CONVERSATION"; payload: string }
  | { type: "SET_CONVERSATIONS"; payload: Conversation[] }
  | { type: "SET_ACTIVE_CONVERSATION"; payload: string | null }
  | { type: "SET_ACTIVE_AGENT"; payload: string | null }
  | { type: "SET_VIEW"; payload: "marketplace" | "chat" }
  | { type: "SET_ACTIVE_VIEW"; payload: "marketplace" | "chat" | "format" | "segment" | "cover" | "create" | "extract" }
  | { type: "ADD_MESSAGE"; payload: { conversationId: string; message: Message } }
  | { type: "UPDATE_MESSAGE"; payload: { conversationId: string; messageId: string; content?: string; reasoningContent?: string; displayContent?: string; streamStatus?: string; generatedImages?: Message["generatedImages"] } }
  | { type: "SET_MESSAGE_STREAMING"; payload: { conversationId: string; messageId: string; isStreaming: boolean } }
  | { type: "SET_MESSAGES_FOR_CONVERSATION"; payload: { conversationId: string; messages: Message[] } }
  | { type: "MARK_CONVERSATION_LOADED"; payload: string }
  | { type: "MARK_CONVERSATION_DIRTY"; payload: string }
  | { type: "SET_IS_STREAMING"; payload: boolean }
  | { type: "SET_CONV_STREAMING"; payload: { conversationId: string; isStreaming: boolean } }
  | { type: "SET_CREDITS"; payload: CreditsInfo }
  | { type: "CONSUME_CREDITS"; payload: number }
  | { type: "RECHARGE_CREDITS"; payload: number }
  | { type: "SET_AUTH"; payload: { user: AuthUser | null; token: string | null } }
  | { type: "PIN_AGENT"; payload: string }
  | { type: "UNPIN_AGENT"; payload: string }
  | { type: "SET_THEME"; payload: string }
  | { type: "SET_MODE"; payload: ThemeMode }
  | { type: "SET_MODE_PREFERENCE"; payload: { preference: ThemeModePreference; mode: ThemeMode } }
  | { type: "SET_APPEARANCE"; payload: { theme: string; modePreference: ThemeModePreference; mode: ThemeMode } }
  | { type: "SET_LAYOUT_CONFIG"; payload: PageLayoutConfig }
  | { type: "TOGGLE_EDIT_MODE" }
  | { type: "SET_EDIT_MODE"; payload: boolean }
  | { type: "SET_PENDING_PRESET_MESSAGE"; payload: { convId: string; content: string; autoSend?: boolean } | null }
  | { type: "DELETE_LAST_MESSAGE"; payload: { conversationId: string } }
  | { type: "DELETE_MESSAGE"; payload: { conversationId: string; messageId: string } }
  | { type: "TRUNCATE_MESSAGES_FROM"; payload: { conversationId: string; messageId: string } }
  | { type: "DELETE_MESSAGE_PAIR"; payload: { conversationId: string; userMessageId: string; assistantMessageId: string } }
  | { type: "MARK_MESSAGE_ERROR"; payload: { conversationId: string; messageId: string; error: string } }
  | { type: "CLEAR_MESSAGE_ERROR"; payload: { conversationId: string; messageId: string } }
  | { type: "TOGGLE_CHAT_FULLSCREEN" }
  | { type: "SET_SIDEBAR_WIDTH"; payload: number }
  | { type: "SET_SIDEBAR_COLLAPSED"; payload: boolean }
  | { type: "LOGOUT" }
  | { type: "FORCED_LOGOUT"; payload: string }
  | { type: "SET_CASH_BALANCE"; payload: number }
  | { type: "ADD_CASH_BALANCE"; payload: number }
  | { type: "MARK_CLEAN"; payload: { conversationId: string; updatedAt: number; title: string; agentId: string; source: string } };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_AGENTS":
      if (action.payload.length === 0 && state.agents.length > 0) return state;
      // Catalog refreshes must not erase virtual agents restored from active
      // conversations. Merge them inside the reducer so concurrent async
      // responses cannot race against a stale React closure.
      const payloadAgentIds = new Set(action.payload.map((agent) => agent.id));
      const preservedVirtualAgents = state.agents.filter(
        (agent) => isVirtualChatAgentId(agent.id) && !payloadAgentIds.has(agent.id),
      );
      const updatedAgents = [...action.payload, ...preservedVirtualAgents];
      if (state.conversations.length > 0) {
        return {
          ...state,
          agents: updatedAgents,
          conversations: state.conversations,
        };
      }
      return { ...state, agents: updatedAgents };

    case "ADD_AGENTS":
      return {
        ...state,
        agents: [
          ...state.agents,
          ...action.payload.filter((agent) => !state.agents.some((current) => current.id === agent.id)),
        ],
      };

    case "UPDATE_AGENT_CATEGORY": {
      const { agentId, category, sort_order } = action.payload;
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === agentId ? { ...a, category, sort_order: sort_order ?? a.sort_order } : a
        ),
      };
    }

    case "SET_LOADING_AGENTS":
      return { ...state, isLoadingAgents: action.payload };

    case "TOGGLE_PIN_AGENT": {
      const id = action.payload;
      const pinned = state.pinnedAgentIds.includes(id)
        ? state.pinnedAgentIds.filter((x) => x !== id)
        : [...state.pinnedAgentIds, id];
      if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEYS.PINNED_AGENT_IDS, JSON.stringify(pinned));
      return { ...state, pinnedAgentIds: pinned };
    }

    case "SET_PINNED":
      return { ...state, pinnedAgentIds: action.payload };

    case "START_CONVERSATION": {
      const nextConversation = action.payload;
      if (typeof window !== "undefined") {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_CONVERSATION_ID, nextConversation.id);
        localStorage.setItem(STORAGE_KEYS.ACTIVE_VIEW, "chat");
      }
      return {
        ...state,
        conversations: [
          nextConversation,
          ...state.conversations.filter((conversation) => conversation.id !== nextConversation.id),
        ],
        activeConversationId: nextConversation.id,
        activeAgentId: nextConversation.agentId || null,
        view: "chat",
      };
    }

    case "ADD_CONVERSATION":
      return {
        ...state,
        conversations: [action.payload, ...state.conversations],
      };

    case "UPDATE_CONVERSATION":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.id ? action.payload : c
        ),
      };

    case "RENAME_CONVERSATION_ID": {
      const { oldId, newId } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === oldId ? { ...c, id: newId } : c
        ),
        activeConversationId: state.activeConversationId === oldId ? newId : state.activeConversationId,
      };
    }

    case "DELETE_CONVERSATION":
      return {
        ...state,
        conversations: state.conversations.filter((c) => c.id !== action.payload),
        activeConversationId: state.activeConversationId === action.payload ? null : state.activeConversationId,
      };

    case "SET_CONVERSATIONS":
      return { ...state, conversations: action.payload };

    case "SET_ACTIVE_CONVERSATION":
      if (typeof window !== "undefined" && action.payload) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_CONVERSATION_ID, action.payload);
      }
      return { ...state, activeConversationId: action.payload };

    case "SET_ACTIVE_AGENT":
      return { ...state, activeAgentId: action.payload };

    case "SET_VIEW":
    case "SET_ACTIVE_VIEW": {
      const v = action.payload as AppState["view"];
      if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEYS.ACTIVE_VIEW, v);
      return { ...state, view: v };
    }

    case "ADD_MESSAGE": {
      const { conversationId, message } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          // 去重保护1：如果同 ID 消息已存在则跳过
          if (c.messages.some((m) => m.id === message.id)) return c;
          // 去重保护2：如果2秒内已有同角色同内容的消息则跳过（防止重复发送）
          const now = Date.now();
          if (c.messages.some((m) =>
            m.role === message.role &&
            m.content === message.content &&
            Math.abs(new Date(m.timestamp).getTime() - now) < 2000
          )) return c;
          const historyContent = getAssistantHistoryContent(message);
          return {
            ...c,
            messages: [...c.messages, message],
            ...(historyContent
              ? {
                  lastMessage: historyContent,
                  lastMessageTime: message.timestamp,
                  updatedAt: message.timestamp,
                  dirty: true,
                }
              : {}),
          };
        }),
      };
    }

    case "UPDATE_MESSAGE": {
      const { conversationId, messageId, content, reasoningContent, displayContent, streamStatus, generatedImages } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          let historyContent = "";
          let historyTime = c.updatedAt;
          const messages = c.messages.map((m) => {
            if (m.id !== messageId) return m;
            const nextMessage = {
              ...m,
              ...(content !== undefined ? { content } : {}),
              ...(reasoningContent !== undefined ? { reasoningContent } : {}),
              ...(displayContent !== undefined ? { displayContent } : {}),
              ...(streamStatus !== undefined ? { streamStatus } : {}),
              ...(generatedImages !== undefined ? { generatedImages } : {}),
            };
            historyContent = getAssistantHistoryContent(nextMessage);
            historyTime = nextMessage.timestamp || Date.now();
            return nextMessage;
          });
          return {
            ...c,
            messages,
            ...(historyContent
              ? {
                  lastMessage: historyContent,
                  lastMessageTime: historyTime,
                  updatedAt: historyTime,
                  dirty: true,
                }
              : {}),
          };
        }),
      };
    }

    case "SET_MESSAGE_STREAMING": {
      const { conversationId, messageId, isStreaming } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, isStreaming } : m
                ),
              }
            : c
        ),
      };
    }

    case "SET_MESSAGES_FOR_CONVERSATION": {
      const { conversationId, messages } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const lastAssistantMessage = [...messages].reverse().find((message) => getAssistantHistoryContent(message));
          const historyContent = lastAssistantMessage ? getAssistantHistoryContent(lastAssistantMessage) : "";
          return {
            ...c,
            messages,
            messagesLoaded: true,
            ...(historyContent
              ? {
                  lastMessage: historyContent,
                  lastMessageTime: lastAssistantMessage?.timestamp || c.lastMessageTime,
                  updatedAt: lastAssistantMessage?.timestamp || c.updatedAt,
                }
              : {}),
          };
        }),
      };
    }

    case "MARK_CONVERSATION_LOADED":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload ? { ...c, messagesLoaded: true } : c
        ),
      };

    case "MARK_CONVERSATION_DIRTY":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload ? { ...c, dirty: true } : c
        ),
      };

    case "SET_IS_STREAMING":
      return { ...state, isStreaming: action.payload };

    case "SET_CONV_STREAMING": {
      const { conversationId, isStreaming } = action.payload;
      const next = new Set(state.streamingConvIds);
      if (isStreaming) next.add(conversationId); else next.delete(conversationId);
      return { ...state, streamingConvIds: next, isStreaming: next.size > 0 };
    }

    case "SET_CREDITS":
      return { ...state, credits: action.payload };

    case "CONSUME_CREDITS":
      return {
        ...state,
        credits: {
          ...state.credits,
          used: state.credits.used + action.payload,
          remaining: state.credits.remaining - action.payload,
        },
      };

    case "RECHARGE_CREDITS":
      return {
        ...state,
        credits: {
          ...state.credits,
          remaining: state.credits.remaining + action.payload,
        },
      };

    case "SET_AUTH":
      return {
        ...state,
        auth: {
          user: action.payload.user,
          token: action.payload.token,
          isAuthenticated: !!(action.payload.user && action.payload.token),
        },
      };

    case "PIN_AGENT":
      return {
        ...state,
        pinnedAgentIds: state.pinnedAgentIds.includes(action.payload)
          ? state.pinnedAgentIds
          : [...state.pinnedAgentIds, action.payload],
      };

    case "UNPIN_AGENT":
      return {
        ...state,
        pinnedAgentIds: state.pinnedAgentIds.filter((id) => id !== action.payload),
      };

    case "SET_THEME": {
      // 不在 reducer 中操作 DOM（副作用会导致闪烁和双重写入）
      // DOM 更新统一由 app-context.tsx 的 useEffect 处理
      // 非法主题（已下线/未知）统一回退默认主题，防止 CSS 变量缺失导致页面无样式
      const nextTheme = normalizeTheme(action.payload);
      const nextMode = state.modePreference === "system" ? state.mode : state.modePreference;
      return { ...state, theme: nextTheme, mode: nextMode };
    }

    case "SET_MODE": {
      // 不在 reducer 中操作 DOM，由 app-context.tsx useEffect 统一处理
      return { ...state, mode: action.payload };
    }

    case "SET_MODE_PREFERENCE": {
      const preference = normalizeThemeModePreference(action.payload.preference) || state.modePreference;
      return {
        ...state,
        modePreference: preference,
        mode: action.payload.mode,
      };
    }

    case "SET_APPEARANCE": {
      const modePreference = normalizeThemeModePreference(action.payload.modePreference) || DEFAULT_MODE_PREFERENCE;
      const theme = normalizeTheme(action.payload.theme);
      return {
        ...state,
        theme,
        modePreference,
        mode: action.payload.mode,
      };
    }

    case "SET_LAYOUT_CONFIG":
      return { ...state, layoutConfig: action.payload };

    case "TOGGLE_EDIT_MODE":
      return { ...state, editMode: !state.editMode };

    case "SET_EDIT_MODE":
      return { ...state, editMode: action.payload };

    case "SET_PENDING_PRESET_MESSAGE":
      return { ...state, pendingPresetMessage: action.payload };

    case "SET_SIDEBAR_WIDTH":
      if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEYS.SIDEBAR_WIDTH, String(action.payload));
      return { ...state, sidebarWidth: action.payload };

    case "SET_SIDEBAR_COLLAPSED":
      if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEYS.SIDEBAR_COLLAPSED, String(action.payload));
      return { ...state, sidebarCollapsed: action.payload };

    case "TOGGLE_CHAT_FULLSCREEN":
      return { ...state, isChatFullscreen: !state.isChatFullscreen };

    case "DELETE_LAST_MESSAGE": {
      const convId = action.payload.conversationId;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === convId && c.messages.length > 0
            ? { ...c, messages: c.messages.slice(0, -1) }
            : c
        ),
      };
    }

    case "TRUNCATE_MESSAGES_FROM": {
      const { conversationId, messageId } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== conversationId) return c;
          const index = c.messages.findIndex((m) => m.id === messageId);
          if (index < 0) return c;
          return { ...c, messages: c.messages.slice(0, index), dirty: true };
        }),
      };
    }

    case "DELETE_MESSAGE": {
      const { conversationId, messageId } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: c.messages.filter((m) => m.id !== messageId), dirty: true }
            : c
        ),
      };
    }

    case "DELETE_MESSAGE_PAIR": {
      const { conversationId, userMessageId, assistantMessageId } = action.payload;
      const idsToRemove = new Set([userMessageId, assistantMessageId]);
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: c.messages.filter((m) => !idsToRemove.has(m.id)), dirty: true }
            : c
        ),
      };
    }

    case "MARK_MESSAGE_ERROR": {
      const { conversationId: errConvId, messageId: errMsgId, error } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === errConvId
            ? { ...c, messages: c.messages.map((m) => m.id === errMsgId ? { ...m, error } : m) }
            : c
        ),
      };
    }

    case "CLEAR_MESSAGE_ERROR": {
      const { conversationId: clearConvId, messageId: clearMsgId } = action.payload;
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === clearConvId
            ? {
                ...conversation,
                messages: conversation.messages.map((message) => {
                  if (message.id !== clearMsgId) return message;
                  const { error: _error, ...clearedMessage } = message;
                  return clearedMessage;
                }),
              }
            : conversation
        ),
      };
    }

    case "LOGOUT":
      return {
        ...initialState,
        // 保留用户偏好设置（主题/布局/侧边栏）
        theme: state.theme,
        modePreference: state.modePreference,
        mode: state.mode,
        layoutConfig: state.layoutConfig,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
      };

    case "FORCED_LOGOUT":
      return {
        ...initialState,
        // 保留用户偏好设置
        theme: state.theme,
        modePreference: state.modePreference,
        mode: state.mode,
        layoutConfig: state.layoutConfig,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        forcedLogoutReason: action.payload,
      };

    case "SET_CASH_BALANCE":
      return { ...state, cashBalance: action.payload };

    case "ADD_CASH_BALANCE":
      return { ...state, cashBalance: state.cashBalance + action.payload };

    case "MARK_CLEAN": {
      const convId = action.payload.conversationId;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === convId && c.updatedAt === action.payload.updatedAt &&
          (c.title || "") === action.payload.title && c.agentId === action.payload.agentId &&
          (c.source || "llm") === action.payload.source
            ? { ...c, dirty: false } : c
        ),
      };
    }

    default:
      return state;
  }
}
