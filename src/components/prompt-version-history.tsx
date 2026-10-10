"use client";

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { Clock, RotateCcw, ChevronDown, ChevronUp, Trash2, FileText, Loader2 } from "lucide-react";

/** 单条版本记录 */
export interface PromptVersion {
  /** 数据库 ID */
  id: string;
  /** 保存时间戳 ms */
  ts: number;
  /** 提示词内容 */
  prompt: string;
  /** 产生该快照的共享智能体配置版本 */
  agent_revision?: number;
  /** 精确提示词内容的 SHA-256（服务端数据库生成） */
  prompt_hash?: string;
}

/** 暴露给父组件的方法 */
export interface PromptVersionHistoryHandle {
  /** 保存新版本（调用 API 持久化） */
  pushVersion: (prompt: string) => Promise<void>;
}

/** 格式化时间为友好显示 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  // 今天的记录只显示时间
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // 昨天显示"昨天"
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 更早显示完整日期
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 截取预览文本 */
function previewText(text: string, maxLen = 80): string {
  const clean = text.replace(/\n+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "...";
}

interface PromptVersionHistoryProps {
  /** 智能体 ID */
  agentId: string;
  /** 当前提示词内容（用于判断是否是当前使用版本） */
  currentPrompt: string;
  /** 恢复回调 */
  onRestore: (prompt: string) => void;
  /** 是否默认展开 */
  defaultExpanded?: boolean;
  /** 管理员 auth headers */
  authHeaders: Record<string, string>;
}

const PromptVersionHistory = forwardRef<PromptVersionHistoryHandle, PromptVersionHistoryProps>(
  function PromptVersionHistory(
    { agentId, currentPrompt, onRestore, defaultExpanded = false, authHeaders },
    ref,
  ) {
    const [versions, setVersions] = useState<PromptVersion[]>([]);
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [immutable, setImmutable] = useState(false);

    // 用 ref 稳定 authHeaders 引用，避免 useCallback 因对象引用变化无限重建
    const authHeadersRef = useRef(authHeaders);
    authHeadersRef.current = authHeaders;

    // 是否为新建智能体的临时 key（尚未持久化到数据库，无法查询版本历史）
    // 注意：真实 agent ID 格式为 "agent-xxx-yyy" 或 "agent-aiweb-xxx"，不是 UUID
    const isTempKey = !agentId || agentId === "new_agent";

    // 从 API 加载版本列表
    const loadVersions = useCallback(async () => {
      if (!agentId || isTempKey) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/prompt-versions?agent_id=${agentId}`, {
          headers: authHeadersRef.current,
        });
        if (res.ok) {
          const data = await res.json();
          setVersions(data.versions || []);
          setImmutable(data.immutable === true);
        } else {
          const errText = await res.text();
          console.error("[prompt-versions] load failed:", res.status, errText);
          setError(`加载失败 (${res.status})`);
        }
      } catch (err) {
        console.error("[prompt-versions] load error:", err);
        setError("网络错误");
      } finally {
        setLoading(false);
      }
    }, [agentId, isTempKey]); // authHeaders 改用 ref，不再作为依赖

    // 初始加载 + agentId 变化时重新加载
    useEffect(() => {
      loadVersions();
    }, [loadVersions]);

    // 保存新版本 — 调用 API 持久化到数据库
    const pushVersion = useCallback(
      async (prompt: string) => {
        if (immutable) {
          await loadVersions();
          return;
        }
        if (!prompt.trim() || !agentId || isTempKey) {
          console.warn("[prompt-versions] pushVersion skipped:", { hasPrompt: !!prompt.trim(), agentId, isTempKey });
          return;
        }
        setSaving(true);
        setError(null);
        try {
          const res = await fetch("/api/admin/prompt-versions", {
            method: "POST",
            headers: { ...authHeadersRef.current, "Content-Type": "application/json" },
            body: JSON.stringify({ agent_id: agentId, prompt, max_versions: 10 }),
          });
          if (res.ok) {
            const data = await res.json();
            if (!data.skipped) {
              // 新版本保存成功，刷新列表
              await loadVersions();
            } else {
              console.log("[prompt-versions] pushVersion skipped (same as latest)");
            }
          } else {
            const errText = await res.text();
            console.error("[prompt-versions] save failed:", res.status, errText);
            setError(`保存失败 (${res.status})`);
          }
        } catch (err) {
          console.error("[prompt-versions] save error:", err);
          setError("保存网络错误");
        } finally {
          setSaving(false);
        }
      },
      [agentId, immutable, isTempKey, loadVersions], // authHeaders 改用 ref
    );

    // 暴露给父组件
    useImperativeHandle(ref, () => ({ pushVersion }), [pushVersion]);

    // 删除单条
    const deleteVersion = useCallback(
      async (id: string) => {
        try {
          const res = await fetch(`/api/admin/prompt-versions?id=${id}`, {
            method: "DELETE",
            headers: authHeadersRef.current,
          });
          if (res.ok) {
            setVersions((prev) => prev.filter((v) => v.id !== id));
          }
        } catch (err) {
          console.error("[prompt-versions] delete error:", err);
        }
      },
      [], // authHeaders 改用 ref
    );

    // 清空全部
    const clearAll = useCallback(async () => {
      if (isTempKey) return;
      try {
        const res = await fetch(`/api/admin/prompt-versions?agent_id=${agentId}`, {
          method: "DELETE",
          headers: authHeadersRef.current,
        });
        if (res.ok) {
          setVersions([]);
        }
      } catch (err) {
        console.error("[prompt-versions] clear error:", err);
      }
    }, [agentId]); // authHeaders 改用 ref

    // 判断某条是否是当前使用版本
    const isCurrent = useCallback(
      (v: PromptVersion) => v.prompt === currentPrompt,
      [currentPrompt],
    );

    return (
      <div className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--card)]/50 mt-2">
        {/* 折叠头部 */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--muted)]/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />
            <span className="text-xs font-medium text-[var(--foreground)]">提示词版本历史</span>
            {versions.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--primary)]/10 text-[var(--primary)] font-medium">
                {versions.length}
              </span>
            )}
            {saving && <Loader2 className="w-3 h-3 animate-spin text-[var(--primary)]" />}
          </div>
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />
          )}
        </button>

        {/* 展开内容 */}
        {expanded && (
          <div className="border-t border-[var(--border)]">
            {loading ? (
              <div className="px-3 py-6 text-center">
                <Loader2 className="w-5 h-5 mx-auto text-[var(--muted-foreground)] animate-spin mb-2" />
                <p className="text-xs text-[var(--muted-foreground)]">加载版本记录...</p>
              </div>
            ) : error ? (
              <div className="px-3 py-4 text-center">
                <p className="text-xs text-red-500">{error}</p>
                <button
                  type="button"
                  onClick={loadVersions}
                  className="text-[10px] text-[var(--primary)] hover:underline mt-1"
                >
                  重试
                </button>
              </div>
            ) : versions.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <FileText className="w-8 h-8 mx-auto text-[var(--muted-foreground)]/30 mb-2" />
                <p className="text-xs text-[var(--muted-foreground)]">暂无版本记录</p>
                <p className="text-[10px] text-[var(--muted-foreground)]/70 mt-1">
                  {isTempKey ? "创建智能体后自动记录提示词版本" : "保存智能体时自动记录提示词版本"}
                </p>
              </div>
            ) : (
              <>
                {/* 版本列表 */}
                <div className="max-h-[320px] overflow-y-auto">
                  {versions.map((v, idx) => {
                    const current = isCurrent(v);
                    return (
                      <div
                        key={v.id}
                        className={`group flex items-start gap-2 px-3 py-2 border-b border-[var(--border)]/50 last:border-b-0 transition-colors ${
                          current
                            ? "bg-[var(--primary)]/5"
                            : "hover:bg-[var(--muted)]/20"
                        }`}
                      >
                        {/* 时间线圆点 */}
                        <div className="flex flex-col items-center pt-0.5 shrink-0">
                          <div
                            className={`w-2 h-2 rounded-full ${
                              current
                                ? "bg-[var(--primary)] ring-2 ring-[var(--primary)]/20"
                                : idx === 0
                                  ? "bg-emerald-500"
                                  : "bg-[var(--muted-foreground)]/30"
                            }`}
                          />
                        </div>

                        {/* 版本信息 */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] text-[var(--muted-foreground)] font-mono">
                              {formatTime(v.ts)}
                            </span>
                            {Number.isSafeInteger(v.agent_revision) && (
                              <span
                                className="text-[9px] text-[var(--muted-foreground)] font-mono"
                                title={v.prompt_hash ? `SHA-256 ${v.prompt_hash}` : undefined}
                              >
                                r{v.agent_revision}
                              </span>
                            )}
                            {idx === 0 && !current && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-600 font-medium">
                                最新
                              </span>
                            )}
                            {current && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--primary)]/10 text-[var(--primary)] font-medium">
                                当前使用
                              </span>
                            )}
                          </div>
                          <p
                            className="text-[11px] text-[var(--foreground)]/70 leading-relaxed break-all"
                            title={v.prompt}
                          >
                            {previewText(v.prompt)}
                          </p>
                        </div>

                        {/* 操作按钮 */}
                        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          {!current && (
                            <button
                              type="button"
                              onClick={() => onRestore(v.prompt)}
                              className="p-1 rounded hover:bg-[var(--primary)]/10 text-[var(--primary)] transition-colors"
                              title="使用此版本"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </button>
                          )}
                          {!immutable && (
                            <button
                              type="button"
                              onClick={() => deleteVersion(v.id)}
                              className="p-1 rounded hover:bg-red-50 text-[var(--muted-foreground)] hover:text-red-500 transition-colors"
                              title="删除此版本"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 底部操作栏 */}
                {versions.length > 0 && (
                  <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--border)]/50 bg-[var(--muted)]/10">
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      {immutable ? `共 ${versions.length} 条不可变审计记录` : `共 ${versions.length}/10 条版本记录，满后自动覆盖旧版本`}
                    </span>
                    {!immutable && versions.length > 1 && (
                      <button
                        type="button"
                        onClick={clearAll}
                        className="text-[10px] text-red-500 hover:text-red-600 transition-colors"
                      >
                        清空全部
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);

export default PromptVersionHistory;
