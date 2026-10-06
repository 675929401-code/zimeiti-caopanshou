"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface FlightEvent {
  id: string;
  capture_sequence: number;
  trace_id: string;
  user_id: string | null;
  user_label: string;
  source: string;
  domain: string;
  operation: string;
  phase: string;
  outcome: string;
  duration_ms: number | null;
  http_status: number | null;
  route: string | null;
  error_code: string | null;
  error_fingerprint: string | null;
  summary: string | null;
  source_version: string | null;
  build_id: string | null;
  occurred_at: string;
}

interface FlightSummary {
  windowHours: number;
  events: number;
  errors: number;
  uniqueErrorFingerprints: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  byDomain: Record<string, number>;
  bySource: Record<string, number>;
  capped: boolean;
}

interface TraceDetail {
  traceId: string;
  user: { id: string | null; label: string };
  events: FlightEvent[];
  incidents: Array<{ id: string; problem_type: string; severity: string; description: string; status: string; created_at: string }>;
  analysis: {
    classification: string;
    failedEventCount: number;
    automaticRepairEligible: boolean;
    automaticRepairReason: string;
    recommendations: string[];
  };
  codexBundle: Record<string, unknown>;
}

const domainLabels: Record<string, string> = {
  chat: "对话/模型",
  image: "生图/封面",
  video: "视频",
  voice: "语音",
  extract: "提取/拆解",
  payment: "支付/资产",
  auth: "登录/注册",
  storage: "素材存储",
  admin: "后台操作",
  system: "系统",
  other: "其他",
};

const sourceLabels: Record<string, string> = {
  browser: "浏览器感知",
  database: "业务账本",
  server: "服务端",
  worker: "后台任务",
  system: "系统",
  admin: "管理员",
};

const outcomeLabels: Record<string, string> = {
  in_progress: "进行中",
  success: "成功",
  warning: "需关注",
  error: "异常",
  cancelled: "已取消",
  unknown: "待判定",
};

function formatDuration(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function shortTrace(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`;
}

export function OperationFlightRecorderPanel({ token }: { token: string | null }) {
  const [events, setEvents] = useState<FlightEvent[]>([]);
  const [summary, setSummary] = useState<FlightSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [domain, setDomain] = useState("");
  const [outcome, setOutcome] = useState("");
  const [source, setSource] = useState("");
  const [traceSearch, setTraceSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token || ""}` }), [token]);

  const loadEvents = useCallback(async (targetPage = 1) => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(targetPage), pageSize: "30", hours: "24" });
      if (domain) params.set("domain", domain);
      if (outcome) params.set("outcome", outcome);
      if (source) params.set("source", source);
      if (traceSearch.trim()) params.set("traceId", traceSearch.trim());
      const response = await fetch(`/api/admin/operation-events?${params}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "运行日志加载失败");
      setEvents(Array.isArray(body.data) ? body.data : []);
      setSummary(body.summary || null);
      setTotal(Number(body.total || 0));
      setPage(targetPage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "运行日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [domain, headers, outcome, source, token, traceSearch]);

  useEffect(() => {
    void loadEvents(1);
  }, [loadEvents]);

  const openTrace = useCallback(async (traceId: string) => {
    setDetailLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/operation-events/${encodeURIComponent(traceId)}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Trace 时间线加载失败");
      setDetail(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Trace 时间线加载失败");
    } finally {
      setDetailLoading(false);
    }
  }, [headers]);

  const downloadCodexBundle = useCallback(() => {
    if (!detail) return;
    const blob = new Blob([`${JSON.stringify(detail.codexBundle, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `codex-diagnostic-${detail.traceId.slice(0, 48)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [detail]);

  const totalPages = Math.max(1, Math.ceil(total / 30));

  return (
    <section className="space-y-3" aria-labelledby="operation-flight-recorder-title" data-testid="operation-flight-recorder">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="operation-flight-recorder-title" className="text-sm font-semibold text-[var(--foreground)]">运行飞行日志</h3>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">独立数据库持久化</span>
          </div>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-[var(--muted-foreground)]">
            浏览器耗时与模型、生图、视频、语音、提取等耐久业务状态按 Trace ID 汇合。只记录路径、状态、耗时和安全标识，不保存提示词正文、生成结果、凭据或签名链接。
          </p>
        </div>
        <button type="button" onClick={() => void loadEvents(page)} disabled={loading} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] hover:border-[var(--primary)] disabled:opacity-50">
          {loading ? "刷新中…" : "刷新日志"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5" data-testid="operation-flight-summary">
        {[
          ["24 小时事件", summary?.events ?? 0, "浏览器与业务账本"],
          ["异常事件", summary?.errors ?? 0, `${summary?.uniqueErrorFingerprints ?? 0} 个问题指纹`],
          ["响应中位数", formatDuration(summary?.p50DurationMs ?? null), "P50 用户感知/终态"],
          ["慢请求阈值", formatDuration(summary?.p95DurationMs ?? null), "P95 定位性能退化"],
          ["覆盖业务域", Object.keys(summary?.byDomain || {}).length, "同一 Trace 串联"],
        ].map(([label, value, note]) => (
          <div key={String(label)} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <p className="text-[10px] font-semibold text-[var(--muted-foreground)]">{label}</p>
            <p className="mt-1 text-lg font-black text-[var(--foreground)]">{value}</p>
            <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">{note}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3" data-testid="operation-repair-policy">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-blue-700">安全修复分级</p>
          <span className="text-[10px] font-medium text-blue-600">线上自动改代码：关闭 · 付费任务自动重放：关闭</span>
        </div>
        <div className="mt-2 grid gap-2 text-[11px] leading-relaxed text-[var(--muted-foreground)] lg:grid-cols-3">
          <p><strong className="text-[var(--foreground)]">L0 自动恢复：</strong>仅浏览器重连、幂等读取和无需付费的安全恢复。</p>
          <p><strong className="text-[var(--foreground)]">L1 管理员维护：</strong>确定性健康探针与可逆清理，必须由管理员主动触发。</p>
          <p><strong className="text-[var(--foreground)]">L2 工程修复：</strong>导出脱敏 Codex 问题包，在 F 盘修复后走版本化局部更新。</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
        <select value={domain} onChange={(event) => { setDomain(event.target.value); setPage(1); }} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-xs text-[var(--foreground)]" aria-label="飞行日志业务类型">
          <option value="">全部业务</option>
          {Object.entries(domainLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={outcome} onChange={(event) => { setOutcome(event.target.value); setPage(1); }} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-xs text-[var(--foreground)]" aria-label="飞行日志结果">
          <option value="">全部结果</option>
          {Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={source} onChange={(event) => { setSource(event.target.value); setPage(1); }} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-xs text-[var(--foreground)]" aria-label="飞行日志来源">
          <option value="">全部来源</option>
          {Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input value={traceSearch} onChange={(event) => setTraceSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadEvents(1); }} className="min-w-64 flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-xs text-[var(--foreground)]" placeholder="输入完整 Trace ID 精确查询" aria-label="Trace ID" />
        <button type="button" onClick={() => void loadEvents(1)} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-white">查询</button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600">{error}</div>}

      <div className="space-y-2" data-testid="operation-flight-events">
        {!loading && events.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center">
            <p className="text-sm font-semibold text-[var(--foreground)]">当前筛选下暂无运行事件</p>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">新关键请求会自动写入；数据库生命周期事件不依赖用户保持页面在线。</p>
          </div>
        )}
        {events.map((event) => (
          <article key={event.id} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3" data-outcome={event.outcome}>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              <div className="w-32 shrink-0">
                <p className="text-xs font-semibold text-[var(--foreground)]">{formatTime(event.occurred_at)}</p>
                <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{sourceLabels[event.source] || event.source}</p>
              </div>
              <div className="w-28 shrink-0">
                <p className="text-xs font-semibold text-[var(--foreground)]">{domainLabels[event.domain] || event.domain}</p>
                <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]" title={event.phase}>{event.phase}</p>
              </div>
              <div className="min-w-56 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${event.outcome === "error" ? "bg-red-500/10 text-red-600" : event.outcome === "warning" ? "bg-amber-500/10 text-amber-600" : event.outcome === "success" ? "bg-emerald-500/10 text-emerald-600" : "bg-blue-500/10 text-blue-600"}`}>{outcomeLabels[event.outcome] || event.outcome}</span>
                  <span className="truncate text-xs font-medium text-[var(--foreground)]">{event.operation}</span>
                </div>
                <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]">{event.user_label} · {event.route || "数据库生命周期"}{event.http_status ? ` · HTTP ${event.http_status}` : ""}</p>
                {(event.error_code || event.summary) && <p className="mt-1 truncate text-[10px] text-red-500">{event.error_code || event.summary}</p>}
              </div>
              <div className="w-28 shrink-0 text-right">
                <p className="text-xs font-semibold text-[var(--foreground)]">{formatDuration(event.duration_ms)}</p>
                <button type="button" onClick={() => void openTrace(event.trace_id)} className="mt-1 text-[10px] font-semibold text-[var(--primary)] hover:underline" title={event.trace_id}>{detailLoading ? "读取中…" : shortTrace(event.trace_id)}</button>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
        <span>第 {page} / {totalPages} 页，共 {total} 条</span>
        <div className="flex gap-2">
          <button type="button" disabled={page <= 1 || loading} onClick={() => void loadEvents(page - 1)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 disabled:opacity-40">上一页</button>
          <button type="button" disabled={page >= totalPages || loading} onClick={() => void loadEvents(page + 1)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 disabled:opacity-40">下一页</button>
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="flight-trace-title" data-testid="operation-trace-dialog">
          <div className="flex max-h-[84vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
              <div className="min-w-0">
                <h4 id="flight-trace-title" className="text-base font-bold text-[var(--foreground)]">Trace 完整时间线</h4>
                <p className="mt-1 break-all font-mono text-[10px] text-[var(--muted-foreground)]">{detail.traceId}</p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">用户：{detail.user.label} · {detail.events.length} 个事件 · {detail.incidents.length} 个诊断记录</p>
              </div>
              <button type="button" onClick={() => setDetail(null)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)]">关闭</button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-amber-700">诊断：{detail.analysis.classification}</p>
                  <button type="button" onClick={downloadCodexBundle} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-white">导出脱敏 Codex 问题包</button>
                </div>
                <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">{detail.analysis.automaticRepairReason}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-[var(--muted-foreground)]">
                  {detail.analysis.recommendations.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
              <div className="space-y-2">
                {detail.events.map((event, index) => (
                  <div key={event.id} className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                    <div className="flex w-8 shrink-0 flex-col items-center"><span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white ${event.outcome === "error" ? "bg-red-500" : event.outcome === "success" ? "bg-emerald-500" : "bg-blue-500"}`}>{index + 1}</span>{index < detail.events.length - 1 && <span className="mt-1 h-full min-h-5 w-px bg-[var(--border)]" />}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-[var(--foreground)]">{sourceLabels[event.source] || event.source} · {event.operation} · {event.phase}</p><time className="text-[10px] text-[var(--muted-foreground)]">{formatTime(event.occurred_at)}</time></div>
                      <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{outcomeLabels[event.outcome] || event.outcome} · {formatDuration(event.duration_ms)}{event.http_status ? ` · HTTP ${event.http_status}` : ""}{event.error_code ? ` · ${event.error_code}` : ""}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
