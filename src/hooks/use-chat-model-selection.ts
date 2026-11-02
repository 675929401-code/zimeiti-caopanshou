"use client";

/**
 * 对话模型热切换的客户端状态：
 * - 从 /api/chat-models 读取公开目录（真实数据源，不在前端写死模型清单）；
 * - 按账户、会话和目标智能体记住选择，刷新或切回会话后仍显示同一个模型；
 * - 未显式选择时不携带覆盖参数，继续使用服务端默认模型。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildChatModelGroups,
  chatModelSelectionScope,
  chatModelSelectionStorageKey,
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
  scope: string | null;
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
  /** 只有用户显式选择后才返回 pm_ 标识；null 表示使用服务端默认模型。 */
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
  accountId: string | null;
  conversationId: string | null;
  targetAgentId: string | null;
  useFreeChatDefault?: boolean;
}): ChatModelSelection {
  const { enabled, accountId, conversationId, targetAgentId, useFreeChatDefault = false } = input;
  const scope = chatModelSelectionScope(accountId, conversationId, targetAgentId);
  const activeScope = enabled ? scope : null;
  const scopeRef = useRef(activeScope);
  scopeRef.current = activeScope;
  const [catalog, setCatalog] = useState<{ scope: string | null; groups: ChatModelGroup[]; status: ChatModelCatalogStatus }>({ scope: null, groups: [], status: "disabled" });
  const [selection, setSelection] = useState<ScopedSelection>({ scope: null, modelId: null });
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const requestId = ++requestRef.current;
    if (!activeScope) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setCatalog({ scope: activeScope, groups: [], status: "loading" });
    void (async () => {
      try {
        const response = await fetch("/api/chat-models", {
          cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal,
        });
        if (!response.ok) throw new Error(`CHAT_MODEL_CATALOG_HTTP_${response.status}`);
        const payload = await response.json() as DirectoryResponse;
        if (controller.signal.aborted || requestId !== requestRef.current || scopeRef.current !== activeScope) return;
        const groups = buildChatModelGroups(toCatalogRows(payload.models));
        let stored: string | null = null;
        try { stored = window.localStorage.getItem(chatModelSelectionStorageKey(activeScope)); } catch { /* Optional persistence. */ }
        setSelection({ scope: activeScope, modelId: resolveChatModelId(stored, groups) });
        setCatalog({ scope: activeScope, groups, status: "ready" });
      } catch {
        if (controller.signal.aborted || requestId !== requestRef.current || scopeRef.current !== activeScope) return;
        setCatalog({ scope: activeScope, groups: [], status: "error" });
      }
    })();
  }, [activeScope]);

  useEffect(() => {
    load();
    return () => { abortRef.current?.abort(); ++requestRef.current; };
  }, [load]);

  const groups = activeScope && catalog.scope === activeScope ? catalog.groups : [];
  const status: ChatModelCatalogStatus = !activeScope ? "disabled" : catalog.scope === activeScope ? catalog.status : "loading";
  const select = useCallback((model: ChatModelOption) => {
    if (!activeScope || scopeRef.current !== activeScope || catalog.scope !== activeScope || catalog.status !== "ready") return;
    const valid = findChatModelOption(catalog.groups, model.id);
    if (!valid) return;
    setSelection({ scope: activeScope, modelId: valid.id });
    try { window.localStorage.setItem(chatModelSelectionStorageKey(activeScope), valid.id); } catch { /* Keep the in-memory selection. */ }
  }, [activeScope, catalog]);

  const scopedModelId = selection.scope === activeScope ? selection.modelId : null;
  const selectedModel = useMemo(() => findChatModelOption(groups, scopedModelId), [groups, scopedModelId]);
  const fallbackModel = useMemo(() => useFreeChatDefault ? defaultChatModelOption(groups) : null, [groups, useFreeChatDefault]);
  return {
    groups, status,
    selectedModelId: selectedModel?.id ?? null,
    selectedModel,
    selectedLabel: selectedModel?.label ?? fallbackModel?.label ?? (useFreeChatDefault ? "默认模型" : "智能体默认"),
    effectiveModelId: status === "ready" ? selectedModel?.id ?? fallbackModel?.id ?? null : null,
    explicitModelId: status === "ready" ? selectedModel?.id ?? null : null,
    select, reload: load,
  };
}
