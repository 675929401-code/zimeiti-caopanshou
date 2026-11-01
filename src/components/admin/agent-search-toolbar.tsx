"use client";

import { useRef, useState } from "react";
import { RefreshCw, Search, X } from "lucide-react";

interface AgentSearchToolbarProps {
  value: string;
  onChange: (value: string) => void;
  matchedCount: number;
  scopeCount: number;
  totalCount: number;
  categoryName?: string;
  isSearching: boolean;
  showAvatarScopeHint?: boolean;
  onRefresh: () => void | Promise<void>;
}

export default function AgentSearchToolbar({
  value, onChange, matchedCount, scopeCount, totalCount, categoryName,
  isSearching, showAvatarScopeHint = false, onRefresh,
}: AgentSearchToolbarProps) {
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const clearSearch = () => {
    onChange("");
    inputRef.current?.focus();
  };
  const refreshList = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" aria-label="智能体搜索">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1">
          <label htmlFor="admin-agent-search" className="mb-1.5 block text-sm font-medium text-[var(--foreground)]">搜索智能体</label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <input
              ref={inputRef}
              id="admin-agent-search"
              type="search"
              aria-label="搜索智能体"
              aria-describedby="admin-agent-search-summary"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); clearSearch(); }
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="名称、描述、分类、模型或 ID；多个关键词用空格分开"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] py-2 pl-9 pr-10 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/15"
            />
            {value.length > 0 && (
              <button type="button" aria-label="清空智能体搜索" title="清空搜索" onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <button type="button" onClick={() => { void refreshList(); }} disabled={refreshing} aria-busy={refreshing} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-50">
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "刷新中…" : "刷新列表"}
        </button>
      </div>
      <p id="admin-agent-search-summary" role="status" aria-live="polite" className="mt-2 text-xs text-[var(--muted-foreground)]">
        显示 {matchedCount} / {scopeCount} 个{categoryName ? `（当前分类：${categoryName}；全部 ${totalCount} 个）` : "智能体"}
        {isSearching ? "；搜索期间暂停拖拽排序，清空搜索后恢复。" : "。"}
      </p>
      {showAvatarScopeHint && isSearching && <p className="mt-1 text-xs text-[var(--muted-foreground)]">批量头像仍按全列表中符合条件的智能体执行，不受搜索影响。</p>}
    </section>
  );
}
