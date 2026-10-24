"use client";

/**
 * 对话模型热切换的客户端状态：
 * - 从 /api/chat-models 读取公开目录（真实数据源，不在前端写死模型清单）；
 * - 按会话记住管理员的选择，刷新或切回会话后仍显示同一个模型；
 * - 未显式选择时不携带覆盖参数，继续使用服务端默认模型。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import {
  buildChatModelGroups,
  defaultChatModelOption,
  findChatModelOption,
  resolveChatModelId,
  type ChatModelCatalogRow,
  type ChatModelGroup,
  type ChatModelOption,
} from "@/lib/chat-model-catalog";

export type ChatModelCatalogStatus = "disabled" | "loading" | "ready" | "error";

interface DirectoryModelRow {
  id?: unknown;
  displayName?: unknown;
}

interface DirectoryResponse {
  models?: unknown;
}

interface ScopedSelection {
  conversationId: string | null;
  modelId: string | null;
}

export interface ChatModelSelection {
  groups: ChatModelGroup[];
  status: ChatModelCatalogStatus;
  selectedModelId: string | null;
  selectedModel: ChatModelOption | null;
  selectedLabel: string;
  /** 界面当前生效的模型（显式选择或服务端默认对应的目录项），用于下拉框选中态。 */
  effectiveModelId: string | null;
  /** 只有管理员显式选择后才返回 pm_ 标识；null 表示使用服务端默认模型。 */
  explicitModelId: string | null;
  select: (model: ChatModelOption) => void;
  reload: () => void;
}

function toCatalogRows(value: unknown): ChatModelCatalogRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry): ChatModelCatalogRow => {
    const record = entry && typeof entry === "object" ? entry as DirectoryModelRow : {};
    return {
      id: typeof record.id === "string" ? record.id : "",
      displayName: typeof record.displayName === "string" ? record.displayName : "",
    };
  });
}

export function useChatModelSelection(input: {
  enabled: boolean;
  conversationId: string | null;
}): ChatModelSelection {
  const { enabled, conversationId } = input;
  const [groups, setGroups] = useState<ChatModelGroup[]>([]);
  const [status, setStatus] = useState<ChatModelCatalogStatus>(enabled ? "loading" : "disabled");
  const [selection, setSelection] = useState<ScopedSelection>({ conversationId: null, modelId: null });
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestRef.current;
    setStatus("loading");
    void (async () => {
      try {
        const response = await fetch("/api/chat-models", {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`CHAT_MODEL_CATALOG_HTTP_${response.status}`);
        const payload = await response.json() as DirectoryResponse;
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        setGroups(buildChatModelGroups(toCatalogRows(payload.models)));
        setStatus("ready");
      } catch {
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        setGroups([]);
        setStatus("error");
      }
    })();
  }, []);

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      abortRef.current = null;
      setGroups([]);
      setStatus("disabled");
      setSelection({ conversationId: null, modelId: null });
      return;
    }
    load();
    return () => abortRef.current?.abort();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || status !== "ready" || typeof window === "undefined") return;
    if (groups.length === 0) {
      setSelection({ conversationId, modelId: null });
      return;
    }
    let storedConversation: string | null = null;
    let storedLast: string | null = null;
    try {
      storedConversation = conversationId
        ? window.localStorage.getItem(`${STORAGE_KEYS.MODEL_OVERRIDE_PREFIX}${conversationId}`)
        : null;
      storedLast = window.localStorage.getItem(STORAGE_KEYS.LAST_USED_MODEL);
    } catch {
      storedConversation = null;
      storedLast = null;
    }
    const modelId = resolveChatModelId(storedConversation, groups)
      ?? resolveChatModelId(storedLast, groups);
    setSelection({ conversationId, modelId });
  }, [enabled, status, groups, conversationId]);

  const select = useCallback((model: ChatModelOption) => {
    setSelection({ conversationId, modelId: model.id });
    if (typeof window === "undefined") return;
    try {
      if (conversationId) {
        window.localStorage.setItem(`${STORAGE_KEYS.MODEL_OVERRIDE_PREFIX}${conversationId}`, model.id);
      }
      window.localStorage.setItem(STORAGE_KEYS.LAST_USED_MODEL, model.id);
    } catch {
      // 浏览器禁用本地存储时只保留本次会话的内存选择。
    }
  }, [conversationId]);

  const scopedModelId = selection.conversationId === conversationId ? selection.modelId : null;
  const selectedModel = useMemo(
    () => findChatModelOption(groups, scopedModelId),
    [groups, scopedModelId],
  );
  const fallbackModel = useMemo(() => defaultChatModelOption(groups), [groups]);
  const selectedLabel = selectedModel?.label ?? fallbackModel?.label ?? "";
  const effectiveModelId = status === "ready" ? selectedModel?.id ?? fallbackModel?.id ?? null : null;
  const explicitModelId = status === "ready" ? selectedModel?.id ?? null : null;

  return {
    groups,
    status,
    selectedModelId: selectedModel?.id ?? null,
    selectedModel,
    selectedLabel,
    effectiveModelId,
    explicitModelId,
    select,
    reload: load,
  };
}
