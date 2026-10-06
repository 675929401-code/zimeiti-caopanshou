"use client";

import { useCallback, useEffect, useState } from "react";
import { safeLocalStorageGet } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage-keys";

const inputCls = "w-full px-3 py-2.5 bg-[var(--card)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition-colors placeholder-[var(--muted-foreground)]";
const cardCls = "bg-[var(--card)] rounded-2xl p-6 border border-[var(--border)]";
const btnGhost = "px-4 py-2.5 text-[var(--secondary-foreground)] rounded-xl text-sm hover:bg-[var(--border)] transition-colors";

export function GuardLogsAdminTab() {
  const [logs, setLogs] = useState<Array<{
    id: string;
    user_id: string;
    user_display_name: string;
    user_academy: string;
    agent_name: string;
    agent_source: string;
    message_preview: string;
    risk_level: string;
    reason: string;
    matched_patterns: string[];
    blocked_at: string;
  }>>([]);
  const [summary, setSummary] = useState<{ total: number; bySource: Record<string, number>; byRisk: Record<string, number> }>({ total: 0, bySource: {}, byRisk: {} });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filterSource, setFilterSource] = useState("");
  const [filterRisk, setFilterRisk] = useState("");
  const [loading, setLoading] = useState(false);
  const [guardLoadError, setGuardLoadError] = useState("");
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const fetchLogs = useCallback(async (p: number, source: string, risk: string) => {
    setLoading(true);
    setGuardLoadError("");
    try {
      const token = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) throw new Error("管理员登录已失效，请重新登录");
      const params = new URLSearchParams({ page: String(p), pageSize: "20" });
      if (source) params.set("source", source);
      if (risk) params.set("riskLevel", risk);
      const res = await fetch(`/api/admin/guard-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "防护日志加载失败");
      if (data.logs) {
        setLogs(data.logs);
        setTotal(data.total);
        setSummary(data.summary);
      }
    } catch (e) {
      console.error("Failed to fetch guard logs:", e);
      setGuardLoadError(e instanceof Error ? e.message : "防护日志加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs(page, filterSource, filterRisk);
  }, [page, filterSource, filterRisk, fetchLogs]);

  const sourceLabel = (s: string) => s === "llm" ? "LLM" : s === "coze" ? "Coze" : "编程";
  const riskLabel = (r: string) => r === "high" ? "高风险" : "中风险";

  /** 高亮匹配的关键词 */
  const highlightPatterns = (text: string, patterns: string[]): React.ReactNode => {
    if (!patterns || patterns.length === 0) return <>{text}</>;
    // 构建正则，将所有 pattern 作为关键词高亮
    const escaped = patterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(p => p.length > 0);
    if (escaped.length === 0) return <>{text}</>;
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    const parts = text.split(regex);
    return <>{parts.map((part, i) => 
      escaped.some(e => part.toLowerCase() === e.toLowerCase()) 
        ? <mark key={i} className="bg-red-500/20 text-red-600 dark:text-red-400 px-0.5 rounded font-semibold">{part}</mark>
        : part
    )}</>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-[var(--foreground)]">安全预警</h3>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">检测提示词套取行为；列表只展示经过乱码修复、敏感信息遮罩和长度限制的审计摘要。</p>
        </div>
        <button type="button" onClick={() => void fetchLogs(page, filterSource, filterRisk)} disabled={loading} className={btnGhost + " text-xs disabled:opacity-50"}>{loading ? "刷新中..." : "刷新数据"}</button>
      </div>

      {guardLoadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">
          <span>{guardLoadError}</span>
          <button type="button" onClick={() => void fetchLogs(page, filterSource, filterRisk)} className="font-semibold hover:underline">重试</button>
        </div>
      )}

      {/* 统计概览 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">总拦截次数</div>
          <div className="text-2xl font-bold text-[var(--foreground)]">{summary.total}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">LLM 拦截</div>
          <div className="text-2xl font-bold text-blue-500">{summary.bySource?.llm || 0}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">Coze 拦截</div>
          <div className="text-2xl font-bold text-purple-500">{summary.bySource?.coze || 0}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">编程智能体拦截</div>
          <div className="text-2xl font-bold text-orange-500">{summary.bySource?.coding || 0}</div>
        </div>
      </div>

      {/* 筛选 */}
      <div className="flex gap-3 items-center flex-wrap">
        <select
          value={filterSource}
          onChange={(e) => { setFilterSource(e.target.value); setPage(1); }}
          className={inputCls + " !w-auto"}
        >
          <option value="">全部来源</option>
          <option value="llm">LLM</option>
          <option value="coze">Coze</option>
          <option value="coding">编程</option>
        </select>
        <select
          value={filterRisk}
          onChange={(e) => { setFilterRisk(e.target.value); setPage(1); }}
          className={inputCls + " !w-auto"}
        >
          <option value="">全部风险</option>
          <option value="high">高风险</option>
          <option value="medium">中风险</option>
        </select>
        <span className="text-xs text-[var(--muted-foreground)]">
          共 {total} 条记录 | 高风险 <span className="text-red-500 font-semibold">{summary.byRisk?.high || 0}</span> | 中风险 <span className="text-yellow-600 font-semibold">{summary.byRisk?.medium || 0}</span>
        </span>
      </div>

      {/* 日志列表 - 增强版 */}
      <div className="space-y-3">
        {loading && <div className="text-center py-4 text-[var(--muted-foreground)] text-sm">加载中...</div>}
        {!loading && logs.map((log) => {
          const isExpanded = expandedLog === log.id;
          const displayMsg = log.message_preview;
          const previewMsg = displayMsg.slice(0, 120);
          return (
            <div key={log.id} className={`bg-[var(--card)] rounded-xl border space-y-2 transition-colors ${log.risk_level === "high" ? "border-red-500/40" : "border-yellow-500/30"}`}>
              {/* Header */}
              <div className="flex items-center gap-3 text-xs p-4 pb-0">
                <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500 font-medium">
                  {sourceLabel(log.agent_source)}
                </span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${log.risk_level === "high" ? "bg-red-500/10 text-red-500" : "bg-yellow-500/10 text-yellow-600"}`}>
                  {riskLabel(log.risk_level)}
                </span>
                <span className="text-[var(--muted-foreground)]">
                  {new Date(log.blocked_at).toLocaleString("zh-CN")}
                </span>
                {log.user_display_name && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--border)] text-[var(--foreground)] font-medium">
                    {log.user_display_name}
                  </span>
                )}
                {log.user_academy && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                    {log.user_academy}
                  </span>
                )}
                <span className="text-[var(--foreground)] font-medium ml-auto">
                  智能体: {log.agent_name}
                </span>
              </div>

              {/* 高亮套取文案 - 核心区域 */}
              <div className="px-4">
                <div className={`rounded-lg p-3 text-sm leading-relaxed ${log.risk_level === "high" ? "bg-red-500/5 border border-red-500/20" : "bg-yellow-500/5 border border-yellow-500/20"}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="w-4 h-4 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                    <span className="text-xs font-semibold text-red-600 dark:text-red-400">脱敏拦截摘要：</span>
                  </div>
                  <div className="text-[var(--foreground)]">
                    {isExpanded 
                      ? highlightPatterns(displayMsg, log.matched_patterns)
                      : highlightPatterns(previewMsg, log.matched_patterns)
                    }
                    {displayMsg.length > 120 && !isExpanded && <span className="text-[var(--muted-foreground)]">...</span>}
                  </div>
                  {displayMsg.length > 120 && (
                    <button onClick={() => setExpandedLog(isExpanded ? null : log.id)} className="text-xs text-[var(--primary)] mt-2 hover:underline">
                      {isExpanded ? "收起" : "展开摘要"}
                    </button>
                  )}
                </div>
              </div>

              {/* 匹配模式标签 */}
              <div className="px-4 pb-4 flex items-center gap-2 flex-wrap">
                <span className="text-xs text-[var(--muted-foreground)]">匹配规则:</span>
                {log.matched_patterns?.map((pattern, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-medium border border-red-500/20">
                    {pattern}
                  </span>
                ))}
                <span className="text-xs text-[var(--muted-foreground)] ml-2">原因: {log.reason}</span>
              </div>
            </div>
          );
        })}
        {!loading && logs.length === 0 && (
          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无安全预警记录</div>
        )}
      </div>

      {/* 分页 */}
      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className={btnGhost + " disabled:opacity-50"}
          >
            上一页
          </button>
          <span className="px-3 py-2 text-sm text-[var(--muted-foreground)]">
            第 {page} 页
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page * 20 >= total}
            className={btnGhost + " disabled:opacity-50"}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
