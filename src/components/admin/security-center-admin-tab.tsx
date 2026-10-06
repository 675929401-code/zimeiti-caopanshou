"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { SecurityEventInvestigation } from "@/components/admin/security-event-investigation";
import { safeLocalStorageGet } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage-keys";

const SecurityCaseWorkbench = dynamic(
  () => import("@/components/admin/security-case-workbench").then((module) => module.SecurityCaseWorkbench),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载案件工作台…</div> },
);
const AdminAccountSecurityPanel = dynamic(
  () => import("@/components/admin/admin-account-security-panel").then((module) => module.AdminAccountSecurityPanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载管理员会话…</div> },
);

const inputCls = "w-full px-3 py-2.5 bg-[var(--card)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition-colors placeholder-[var(--muted-foreground)]";
const cardCls = "bg-[var(--card)] rounded-2xl p-6 border border-[var(--border)]";
const btnGhost = "px-4 py-2.5 text-[var(--secondary-foreground)] rounded-xl text-sm hover:bg-[var(--border)] transition-colors";
function formatAdminDate(value?: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "--";
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")} ${valueOf("hour")}:${valueOf("minute")}`;
}

export function SecurityCenterAdminTab({
  token,
  canManageSecurity,
  sensitiveUnlocked,
  onRequestUnlock,
}: {
  token: string | null;
  canManageSecurity: boolean;
  sensitiveUnlocked: boolean;
  onRequestUnlock: () => void;
}) {
  type SecurityWorkspace = "events" | "cases" | "sessions";
  const [workspace, setWorkspace] = useState<SecurityWorkspace>("events");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [events, setEvents] = useState<Array<{
    id: string;
    event_type: string;
    risk_level: string;
    ip_address: string;
    user_id: string;
    username: string;
    display_name: string;
    phone: string;
    source: string;
    user_agent: string;
    path: string;
    method: string;
    details: string;
    blocked: boolean;
    created_at: string;
    identity_status?: "current_account" | "historical_or_deleted" | "anonymous" | string;
  }>>([]);
  const [summary, setSummary] = useState<{
    total: number;
    todayCount: number;
    byType: Record<string, number>;
    byRisk: Record<string, number>;
    topRiskyUsers: Array<{ user_id: string; username: string; display_name: string; phone: string; count: number; sources: string[] }>;
    hourlyTrend: Record<number, number>;
    asOf?: string;
    observedAt?: string | null;
    dataQuality?: {
      summaryCapped: boolean;
      sampledRows: number;
      totalRows: number;
      repairedFieldCount: number;
      sensitiveFields: "masked";
      historicalValuesPreserved: boolean;
    };
  }>({ total: 0, todayCount: 0, byType: {}, byRisk: {}, topRiskyUsers: [], hourlyTrend: {} });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filterType, setFilterType] = useState("");
  const [filterRisk, setFilterRisk] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  useEffect(() => {
    const requested = new URL(window.location.href).searchParams.get("securityView");
    if (requested === "cases" || requested === "sessions" || requested === "events") {
      setWorkspace(requested);
    }
    setWorkspaceReady(true);
  }, []);

  const selectWorkspace = useCallback((next: SecurityWorkspace) => {
    setWorkspace(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "security");
    url.searchParams.set("securityView", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const fetchEvents = useCallback(async (p: number, eventType: string, risk: string, source: string, signal?: AbortSignal) => {
    setLoading(true);
    setLoadError("");
    try {
      const token = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) throw new Error("管理员登录已失效，请重新登录");
      const params = new URLSearchParams({ page: String(p), pageSize: "20" });
      if (eventType) params.set("eventType", eventType);
      if (risk) params.set("riskLevel", risk);
      if (source) params.set("source", source);
      const res = await fetch(`/api/admin/security-events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "安全事件加载失败");
      if (data.events) {
        setEvents(data.events);
        setTotal(data.total);
        setSummary(data.summary);
      }
    } catch (e) {
      if (signal?.aborted) return;
      console.error("Failed to fetch security events:", e);
      setLoadError(e instanceof Error ? e.message : "安全事件加载失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!workspaceReady || workspace !== "events") return;
    const controller = new AbortController();
    void fetchEvents(page, filterType, filterRisk, filterSource, controller.signal);
    return () => controller.abort();
  }, [page, filterType, filterRisk, filterSource, fetchEvents, workspace, workspaceReady]);

  const sourceLabel: Record<string, { label: string; color: string }> = {
    user_client: { label: "用户端", color: "bg-blue-500/10 text-blue-600" },
    admin_panel: { label: "管理后台", color: "bg-[var(--accent)] text-[var(--secondary-foreground)]" },
    api_direct: { label: "API直连", color: "bg-orange-500/10 text-orange-600" },
    anonymous: { label: "未认证请求", color: "bg-gray-500/10 text-gray-500" },
  };

  const eventTypeLabel: Record<string, string> = {
    rate_limit: "限流拦截",
    brute_force: "暴力破解",
    bot_detected: "爬虫检测",
    sql_injection: "SQL注入",
    xss_attempt: "XSS攻击",
    path_traversal: "路径遍历",
    prompt_injection: "提示词注入",
    unauthorized_access: "未授权访问",
    suspicious_behavior: "可疑行为",
    api_abuse: "API滥用",
  };

  const riskColorMap: Record<string, { bg: string; text: string; label: string }> = {
    low: { bg: "bg-gray-500/10", text: "text-gray-500", label: "低风险" },
    medium: { bg: "bg-yellow-500/10", text: "text-yellow-600", label: "中风险" },
    high: { bg: "bg-orange-500/10", text: "text-orange-600", label: "高风险" },
    critical: { bg: "bg-red-500/10", text: "text-red-600", label: "严重" },
  };

  const eventTypeIcon: Record<string, string> = {
    rate_limit: "⏱",
    brute_force: "🔓",
    bot_detected: "🤖",
    sql_injection: "💉",
    xss_attempt: "📜",
    path_traversal: "📁",
    prompt_injection: "🛡",
    unauthorized_access: "🚫",
    suspicious_behavior: "⚠",
    api_abuse: "🔄",
  };

  return (
    <div className="space-y-6" data-admin-security-center>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold text-[var(--foreground)]">安全中心</h3>
            <p className="mt-1 text-sm leading-6 text-[var(--muted-foreground)]">按工作目标直接进入态势、案件或管理员会话；仅当前目标读取数据，避免后台同时轮询。</p>
          </div>
          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700">按需加载 · 页面隐藏与离线时暂停</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3" role="navigation" aria-label="安全中心目标导航" data-testid="security-goal-navigation">
          {([
            ["events", "威胁态势", "查看攻击线索、来源、地区证据与风险变化"],
            ["cases", "案件处置", "认领案件、关联证据、流转状态与查看待执行请求"],
            ["sessions", "管理员会话", "查看本人在线设备、撤销会话与核对 MFA 准备度"],
          ] as const).map(([key, label, description]) => {
            const selected = workspace === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => selectWorkspace(key)}
                aria-current={selected ? "page" : undefined}
                data-testid={`security-goal-${key}`}
                className={`min-h-24 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${selected ? "border-[var(--primary)] bg-[var(--accent)] text-[var(--foreground)]" : "border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:border-[var(--primary)]/50"}`}
              >
                <span className="block text-base font-semibold">{label}</span>
                <span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">{description}</span>
              </button>
            );
          })}
        </div>
      </div>

      {!workspaceReady && (
        <div role="status" className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在恢复安全中心目标…</div>
      )}

      {workspaceReady && workspace === "cases" && (
        <SecurityCaseWorkbench
          token={token}
          canManage={canManageSecurity}
          stepUpReady={sensitiveUnlocked}
          onRequestUnlock={onRequestUnlock}
          autoRefresh
        />
      )}

      {workspaceReady && workspace === "sessions" && (
        <AdminAccountSecurityPanel
          token={token}
          canManage
          stepUpReady={sensitiveUnlocked}
          onRequestUnlock={onRequestUnlock}
          autoRefresh
        />
      )}

      {workspaceReady && workspace === "events" && <>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-[var(--foreground)]">威胁态势</h3>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">近实时汇总已接收的限流、暴力破解、爬虫、注入与提示词套取事件；列表默认脱敏，单条调查需再次验证并留下审计记录。</p>
        </div>
        <button
          type="button"
          onClick={() => void fetchEvents(page, filterType, filterRisk, filterSource)}
          disabled={loading}
          className={btnGhost + " text-xs disabled:opacity-50"}
        >
          {loading ? "刷新中..." : "刷新数据"}
        </button>
      </div>

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">
          <span>{loadError}</span>
          <button type="button" onClick={() => void fetchEvents(page, filterType, filterRisk, filterSource)} className="font-semibold hover:underline">重试</button>
        </div>
      )}

      {summary.asOf && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-xs text-[var(--muted-foreground)]">
          <span>查询时间：{formatAdminDate(summary.asOf)}</span>
          <span>最新事件：{summary.observedAt ? formatAdminDate(summary.observedAt) : "暂无"}</span>
          <span>隐私：手机号与 IP 默认脱敏；调查态按权限单条查看</span>
          {(summary.dataQuality?.repairedFieldCount || 0) > 0 && <span>本次展示修复 {summary.dataQuality?.repairedFieldCount} 个历史乱码字段</span>}
          {summary.dataQuality?.summaryCapped && (
            <span className="font-semibold text-orange-600">统计为最近 {summary.dataQuality.sampledRows} / {summary.dataQuality.totalRows} 条样本</span>
          )}
        </div>
      )}

      {/* 统计概览 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">总事件数</div>
          <div className="text-2xl font-bold text-[var(--foreground)]">{summary.total}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">今日事件</div>
          <div className="text-2xl font-bold text-blue-500">{summary.todayCount}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">严重/高风险</div>
          <div className="text-2xl font-bold text-red-500">{(summary.byRisk?.critical || 0) + (summary.byRisk?.high || 0)}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">暴力破解</div>
          <div className="text-2xl font-bold text-orange-500">{summary.byType?.brute_force || 0}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">提示词注入</div>
          <div className="text-2xl font-bold text-purple-500">{summary.byType?.prompt_injection || 0}</div>
        </div>
      </div>

      {/* 事件类型分布 */}
      <div className={cardCls}>
        <h4 className="text-sm font-semibold text-[var(--foreground)] mb-3">事件类型分布</h4>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {Object.entries(summary.byType).sort(([,a],[,b]) => b - a).map(([type, count]) => (
            <div key={type} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)]">
              <span className="text-base">{eventTypeIcon[type] || "❓"}</span>
              <div>
                <div className="text-xs text-[var(--muted-foreground)]">{eventTypeLabel[type] || type}</div>
                <div className="text-sm font-bold text-[var(--foreground)]">{count}</div>
              </div>
            </div>
          ))}
          {Object.keys(summary.byType).length === 0 && (
            <div className="col-span-5 text-center py-4 text-[var(--muted-foreground)] text-sm">暂无安全事件</div>
          )}
        </div>
      </div>

      {/* 高/严重风险关联账号 Top10 */}
      {summary.topRiskyUsers.length > 0 && (
        <div className={cardCls} data-security-risk-ranking>
          <div className="mb-3">
            <h4 className="text-sm font-semibold text-[var(--foreground)]">高/严重风险关联账号 Top10</h4>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">仅表示事件关联或指向该账号，不等于账号持有人实施攻击；是否为学员本人必须结合已验证会话、可信网络与设备证据判断。</p>
          </div>
          <div className="space-y-2">
            {summary.topRiskyUsers.map((u: { user_id: string; username: string; display_name: string; phone?: string; count: number; sources?: string[] }, i: number) => (
              <div key={u.user_id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)]">
                <span className={`text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center ${i < 3 ? 'bg-red-500/10 text-red-600' : 'bg-gray-500/10 text-gray-500'}`}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--foreground)]">{u.display_name || u.username || u.user_id.slice(0, 8)}</span>
                    {u.phone && <span className="text-xs text-cyan-600">{u.phone}</span>}
                  </div>
                  {u.sources && u.sources.length > 0 && (
                    <div className="flex gap-1 mt-0.5">
                      {u.sources.map((s: string) => sourceLabel[s] && (
                        <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded-full ${sourceLabel[s].color}`}>{sourceLabel[s].label}</span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 font-medium">{u.count} 次高/严重事件</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 24小时趋势 */}
      {Object.keys(summary.hourlyTrend).length > 0 && (
        <div className={cardCls}>
          <h4 className="text-sm font-semibold text-[var(--foreground)] mb-3">24小时事件趋势</h4>
          <div className="flex items-end gap-1 h-20">
            {Array.from({ length: 24 }, (_, h) => {
              const count = summary.hourlyTrend[h] || 0;
              const maxCount = Math.max(...Object.values(summary.hourlyTrend), 1);
              const height = count > 0 ? Math.max(4, (count / maxCount) * 100) : 2;
              return (
                <div key={h} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="text-[9px] text-[var(--muted-foreground)]">{count || ''}</div>
                  <div
                    className={`w-full rounded-t ${count > 0 ? 'bg-red-500/60' : 'bg-[var(--border)]'}`}
                    style={{ height: `${height}%`, minHeight: '2px' }}
                    title={`${h}:00 - ${count}次`}
                  />
                  {h % 4 === 0 && <div className="text-[8px] text-[var(--muted-foreground)]">{h}h</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 筛选 */}
      <div className="flex gap-3 items-center flex-wrap">
        <select
          value={filterType}
          onChange={(e) => { setFilterType(e.target.value); setPage(1); }}
          className={inputCls + " !w-auto"}
        >
          <option value="">全部类型</option>
          {Object.entries(eventTypeLabel).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select
          value={filterRisk}
          onChange={(e) => { setFilterRisk(e.target.value); setPage(1); }}
          className={inputCls + " !w-auto"}
        >
          <option value="">全部风险</option>
          <option value="critical">严重</option>
          <option value="high">高风险</option>
          <option value="medium">中风险</option>
          <option value="low">低风险</option>
        </select>
        <select
          value={filterSource}
          onChange={(e) => { setFilterSource(e.target.value); setPage(1); }}
          className={inputCls + " !w-auto"}
        >
          <option value="">全部来源</option>
          <option value="user_client">用户端</option>
          <option value="admin_panel">管理后台</option>
          <option value="api_direct">API直连</option>
          <option value="anonymous">未认证请求</option>
        </select>
        <span className="text-xs text-[var(--muted-foreground)]">
          共 {total} 条记录 | 严重 <span className="text-red-600 font-semibold">{summary.byRisk?.critical || 0}</span> | 高 <span className="text-orange-600 font-semibold">{summary.byRisk?.high || 0}</span> | 中 <span className="text-yellow-600 font-semibold">{summary.byRisk?.medium || 0}</span>
        </span>
      </div>

      {/* 事件列表 */}
      <div className="space-y-3">
        {loading && <div className="text-center py-4 text-[var(--muted-foreground)] text-sm">加载中...</div>}
        {!loading && events.map((event) => {
          const isExpanded = expandedEvent === event.id;
          const riskInfo = riskColorMap[event.risk_level] || riskColorMap.medium;
          return (
            <div key={event.id} data-security-event-card className={`bg-[var(--card)] rounded-xl border space-y-2 transition-colors ${
              event.risk_level === "critical" ? "border-red-500/50 bg-red-500/[0.02]" :
              event.risk_level === "high" ? "border-orange-500/40" :
              "border-yellow-500/30"
            }`}>
              {/* Header */}
              <div className="flex items-center gap-2 text-xs p-4 pb-0 flex-wrap">
                <span className="text-base">{eventTypeIcon[event.event_type] || "❓"}</span>
                <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500 font-medium">
                  {eventTypeLabel[event.event_type] || event.event_type}
                </span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${riskInfo.bg} ${riskInfo.text}`}>
                  {riskInfo.label}
                </span>
                {/* 来源入口标签 */}
                {event.source && sourceLabel[event.source] && (
                  <span className={`px-2 py-0.5 rounded-full font-medium ${sourceLabel[event.source].color}`}>
                    {sourceLabel[event.source].label}
                  </span>
                )}
                <span className="text-[var(--muted-foreground)]">
                  {new Date(event.created_at).toLocaleString("zh-CN")}
                </span>
                {event.blocked && (
                  <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 font-medium">已拦截</span>
                )}
                {/* 账号关联标签：关联不等于账号持有人实施攻击 */}
                {event.display_name && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--border)] text-[var(--foreground)] font-medium">
                    关联账号：{event.display_name}
                  </span>
                )}
                {event.username && !event.display_name && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--border)] text-[var(--foreground)] font-medium">
                    关联账号：{event.username}
                  </span>
                )}
                <span className={`px-2 py-0.5 rounded-full font-medium ${event.identity_status === "current_account" ? "bg-emerald-500/10 text-emerald-700" : event.identity_status === "historical_or_deleted" ? "bg-amber-500/10 text-amber-700" : "bg-slate-500/10 text-slate-600"}`}>
                  {event.identity_status === "current_account" ? "在籍账号关联" : event.identity_status === "historical_or_deleted" ? "历史账号关联" : "未关联账号"}
                </span>
                {/* 手机号标签 */}
                {event.phone && (
                  <span className="px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-600 font-medium">
                    {event.phone}
                  </span>
                )}
              </div>

              {/* 详情区域 */}
              <div className="px-4">
                <div className={`rounded-lg p-3 text-sm leading-relaxed ${
                  event.risk_level === "critical" ? "bg-red-500/5 border border-red-500/20" :
                  event.risk_level === "high" ? "bg-orange-500/5 border border-orange-500/20" :
                  "bg-yellow-500/5 border border-yellow-500/20"
                }`}>
                  <div className="text-[var(--foreground)]">{event.details || "无详情"}</div>
                </div>
              </div>

              {/* 元数据 */}
              <div className="px-4 pb-4 flex items-center gap-3 flex-wrap text-xs text-[var(--muted-foreground)]">
                {event.path && <span>路径: <code className="bg-[var(--border)] px-1 rounded">{event.method} {event.path}</code></span>}
                {event.ip_address && event.ip_address !== "api" && event.ip_address !== "unknown" && <span>IP: {event.ip_address}</span>}
                {event.user_id && event.user_id !== "unknown" && <span>用户ID: <code className="bg-[var(--border)] px-1 rounded">{event.user_id.slice(0, 8)}</code></span>}
                <button onClick={() => setExpandedEvent(isExpanded ? null : event.id)} className="text-[var(--primary)] hover:underline">
                  {isExpanded ? "收起调查入口" : "查看调查线索"}
                </button>
              </div>
              {isExpanded && (
                <div className="px-4 pb-4">
                  <div className="rounded-lg bg-[var(--background)] border border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)] space-y-2 break-all">
                    {event.user_agent && <div><span className="font-medium text-[var(--foreground)]">UA:</span> {event.user_agent}</div>}
                    {event.ip_address && event.ip_address !== "unknown" && <div><span className="font-medium text-[var(--foreground)]">IP:</span> {event.ip_address}</div>}
                    {event.user_id && event.user_id !== "unknown" && <div><span className="font-medium text-[var(--foreground)]">用户ID:</span> {event.user_id}</div>}
                    {event.phone && <div><span className="font-medium text-[var(--foreground)]">脱敏手机号:</span> {event.phone}</div>}
                    {event.source && <div><span className="font-medium text-[var(--foreground)]">来源入口:</span> {sourceLabel[event.source]?.label || event.source}</div>}
                    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-amber-700">账号关联、登录账号命中或手机号命中都不能单独证明是学员本人。下方调查视图会分别给出身份、网络、设备、地区和证据缺口。</div>
                    <SecurityEventInvestigation
                      eventId={event.id}
                      token={safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN) || ""}
                      sensitiveUnlocked={sensitiveUnlocked}
                      onRequestUnlock={onRequestUnlock}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!loading && events.length === 0 && (
          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无安全事件记录</div>
        )}
      </div>

      {/* 分页 */}
      {total > 20 && (
        <div className="flex items-center justify-center gap-3">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className={btnGhost + " text-sm disabled:opacity-30"}>上一页</button>
          <span className="text-sm text-[var(--muted-foreground)]">第 {page} 页 / 共 {Math.ceil(total / 20)} 页</span>
          <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className={btnGhost + " text-sm disabled:opacity-30"}>下一页</button>
        </div>
      )}
      </>}
    </div>
  );
}
