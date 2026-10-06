"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RechargeCategory,
  RechargeReconciliationSummary,
  RechargeSourceState,
  RechargeTimelineEvent,
  RechargeWindow,
} from "@/lib/server/admin-recharge-read-model";
import styles from "./recharge-timeline-panel.module.css";

type RechargeTimelineResponse = {
  summary: RechargeReconciliationSummary;
  timeline: { events: RechargeTimelineEvent[]; totalCount: number; limit: number; truncated: boolean };
  dataQuality: {
    status: "complete" | "partial" | "unavailable";
    availableSources: number;
    partialSources: number;
    unavailableSources: number;
    notRequestedSources: number;
    truncatedSources: number;
    notes: string[];
  };
  sourceStates: RechargeSourceState[];
  asOf: string;
  window: RechargeWindow;
  freshness: {
    state: "fresh" | "stale";
    ageMs: number;
    maxAgeMs: number;
    basis: "process_cache_age";
  };
  nextRefreshAt: string;
  cacheStatus: "miss" | "hit" | "shared";
  rateLimit: {
    scope: "process-local-admin-filter";
    limit: 1;
    intervalMs: number;
    remaining: 0 | 1;
    retryAfterSeconds: number;
    nextAllowedAt: string;
  };
  readBudget: {
    mode: "summary";
    maxRowsPerSource: number;
    exhaustive: boolean;
  };
};

export interface RechargeTimelinePanelProps {
  token?: string | null;
  userId?: string;
  category?: RechargeCategory;
  endpoint?: string;
  timelineLimit?: number;
  title?: string;
  autoRefresh?: boolean;
  variant?: "default" | "command_center";
  className?: string;
}

const WINDOW_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 180, label: "近 180 天" },
  { value: 0, label: "全部" },
] as const;

const KIND_LABELS: Record<RechargeTimelineEvent["kind"], string> = {
  online_payment: "在线订单",
  wallet_credit: "钱包入账",
  legacy_credit: "历史充值",
  refund: "退款",
  offline_payment: "线下收款",
  member_activation: "会员激活",
  member_package: "套餐派发",
};

function beijingDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function dateInputValue(days: number): string | null {
  if (days <= 0) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

function metricNumber(value: number | null, options: Intl.NumberFormatOptions = {}): string {
  if (value == null || !Number.isFinite(value)) return "暂不可用";
  return new Intl.NumberFormat("zh-CN", options).format(value);
}

function metricCurrency(value: number | null): string {
  return value == null || !Number.isFinite(value)
    ? "暂不可用"
    : `¥${metricNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function eventAmount(event: RechargeTimelineEvent): string {
  const parts = [
    event.amount.currency != null ? `¥${metricNumber(event.amount.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
    event.amount.credits != null ? `${metricNumber(event.amount.credits, { maximumFractionDigits: 2 })} 积分` : "",
    event.amount.cash != null && event.amount.currency == null ? `${metricNumber(event.amount.cash, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 现金` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "无金额变动";
}

function sourceStateLabel(source: RechargeSourceState): string {
  if (source.state === "not_requested") return "本筛选未请求";
  if (source.state === "unavailable") return "不可用";
  if (source.state === "partial" || source.truncated) return "部分可用";
  return `${source.rowCount ?? 0} 条`;
}

function cacheStateLabel(value: RechargeTimelineResponse["cacheStatus"]): string {
  if (value === "hit") return "60 秒进程缓存";
  if (value === "shared") return "合并了同筛选读取";
  return "最新有界读取";
}

export function RechargeTimelinePanel({
  token,
  userId,
  category = "",
  endpoint = "/api/admin/reconciliation/recharges",
  timelineLimit = 80,
  title = "会员充值时间线",
  autoRefresh = false,
  variant = "default",
  className = "",
}: RechargeTimelinePanelProps) {
  const [windowDays, setWindowDays] = useState(180);
  const [data, setData] = useState<RechargeTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nextRefreshAtMs, setNextRefreshAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [loadedRequestUrl, setLoadedRequestUrl] = useState("");
  const [attemptedRequestUrl, setAttemptedRequestUrl] = useState("");
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const [availabilityRevision, setAvailabilityRevision] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [online, setOnline] = useState(true);
  const requestAbortRef = useRef<AbortController | null>(null);
  const wasAvailableRef = useRef(false);
  const handledAvailabilityRevisionRef = useRef(-1);

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ summaryOnly: "1", timelineLimit: String(Math.min(200, Math.max(1, timelineLimit))) });
    if (userId) params.set("userId", userId);
    if (category) params.set("category", category);
    const startDate = dateInputValue(windowDays);
    if (startDate) params.set("startDate", startDate);
    return `${endpoint}?${params.toString()}`;
  }, [category, endpoint, timelineLimit, userId, windowDays]);

  const load = useCallback(async (bypassCache = false) => {
    if (typeof document !== "undefined" && document.hidden) {
      setPageVisible(false);
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      return;
    }
    if (requestAbortRef.current) return;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setAttemptedRequestUrl(requestUrl);
    setLoading(true);
    setError("");
    try {
      const authToken = token === undefined ? localStorage.getItem("auth_token") : token;
      const url = new URL(requestUrl, window.location.origin);
      if (bypassCache) url.searchParams.set("refresh", "1");
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        signal: controller.signal,
      });
      const payload = await response.json() as Partial<RechargeTimelineResponse> & { error?: string; code?: string };
      if (response.status === 429) {
        const headerValue = Number(response.headers.get("Retry-After") || 0);
        const headerSeconds = Number.isFinite(headerValue) && headerValue > 0 ? Math.ceil(headerValue) : 60;
        const payloadNextRefreshAtMs = typeof payload.nextRefreshAt === "string" ? Date.parse(payload.nextRefreshAt) : Number.NaN;
        setNextRefreshAtMs(Number.isFinite(payloadNextRefreshAtMs)
          ? payloadNextRefreshAtMs
          : Date.now() + Math.max(1, headerSeconds) * 1_000);
        setClockMs(Date.now());
        setError(payload.error || "充值时间线仍在刷新冷却期");
        return;
      }
      if (!response.ok) {
        const retryAfterValue = Number(response.headers.get("Retry-After") || 60);
        const retryAfterSeconds = Number.isFinite(retryAfterValue) && retryAfterValue > 0 ? Math.ceil(retryAfterValue) : 60;
        setNextRefreshAtMs(Date.now() + retryAfterSeconds * 1_000);
        setClockMs(Date.now());
        throw new Error(payload.error || "充值时间线读取失败");
      }
      if (!payload.summary || !payload.timeline || !payload.dataQuality || !payload.sourceStates || !payload.asOf || !payload.window || !payload.nextRefreshAt || !payload.cacheStatus || !payload.rateLimit || !payload.freshness || !payload.readBudget) {
        throw new Error("充值时间线响应合同不完整");
      }
      setData(payload as RechargeTimelineResponse);
      setLoadedRequestUrl(requestUrl);
      const parsedNextRefreshAt = Date.parse(payload.nextRefreshAt);
      setNextRefreshAtMs(Number.isFinite(parsedNextRefreshAt) ? parsedNextRefreshAt : Date.now() + 60_000);
      setClockMs(Date.now());
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") {
        if (requestAbortRef.current === controller) setAttemptedRequestUrl("");
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "充值时间线读取失败");
      setNextRefreshAtMs((current) => current > Date.now() ? current : Date.now() + 60_000);
      setClockMs(Date.now());
    } finally {
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [requestUrl, token]);

  useEffect(() => () => requestAbortRef.current?.abort(), [requestUrl, token]);

  useEffect(() => {
    const syncAvailability = () => {
      const visible = !document.hidden;
      const connected = navigator.onLine;
      const available = visible && connected;
      setPageVisible(visible);
      setOnline(connected);
      setAvailabilityReady(true);
      setClockMs(Date.now());
      if (available && !wasAvailableRef.current) setAvailabilityRevision((value) => value + 1);
      wasAvailableRef.current = available;
      if (!available) requestAbortRef.current?.abort();
    };
    syncAvailability();
    document.addEventListener("visibilitychange", syncAvailability);
    window.addEventListener("online", syncAvailability);
    window.addEventListener("offline", syncAvailability);
    return () => {
      document.removeEventListener("visibilitychange", syncAvailability);
      window.removeEventListener("online", syncAvailability);
      window.removeEventListener("offline", syncAvailability);
      requestAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!availabilityReady || !pageVisible || !online || loading && requestAbortRef.current) return;
    const hasCurrentSnapshot = data !== null && loadedRequestUrl === requestUrl;
    const firstAttemptForFilter = attemptedRequestUrl !== requestUrl;
    const resumed = handledAvailabilityRevisionRef.current !== availabilityRevision;
    handledAvailabilityRevisionRef.current = availabilityRevision;
    const resumeNeedsRead = resumed && (!hasCurrentSnapshot || (autoRefresh && nextRefreshAtMs <= Date.now()));
    if (!firstAttemptForFilter && !resumeNeedsRead) return;
    void load();
  }, [attemptedRequestUrl, autoRefresh, availabilityReady, availabilityRevision, data, load, loadedRequestUrl, loading, nextRefreshAtMs, online, pageVisible, requestUrl]);

  useEffect(() => {
    if (nextRefreshAtMs <= clockMs || !pageVisible || !online) return;
    const timer = window.setTimeout(() => {
      setClockMs(Date.now());
      if (autoRefresh && !requestAbortRef.current && !document.hidden && navigator.onLine) void load(false);
    }, nextRefreshAtMs - clockMs + 100);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, clockMs, load, nextRefreshAtMs, online, pageVisible]);

  const coolingDown = nextRefreshAtMs > clockMs;
  const cooldownSeconds = coolingDown ? Math.max(1, Math.ceil((nextRefreshAtMs - clockMs) / 1_000)) : 0;
  const pauseReason = !availabilityReady
    ? "正在确认页面与网络状态，充值读取暂缓"
    : !pageVisible
      ? "页面位于后台，充值读取已暂停"
      : !online
        ? "浏览器当前离线，充值读取已暂停"
        : "";

  const qualityLabel = data?.dataQuality.status === "complete" ? "数据完整"
    : data?.dataQuality.status === "partial" ? "部分来源不可用"
      : data?.dataQuality.status === "unavailable" ? "数据不可用" : "读取中";

  return (
    <section className={`${styles.panel} ${className}`.trim()} data-variant={variant} data-testid="recharge-timeline-panel" aria-labelledby="recharge-timeline-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>MEMBER · RECHARGE · EVIDENCE</p>
          <h2 id="recharge-timeline-title" className={styles.title}>{title}</h2>
          <p className={styles.subtitle}>订单、钱包、历史流水、退款、线下收款与会员权益按事实时间合并；缺失来源明确显示不可用。</p>
        </div>
        <div className={styles.actions}>
          <label className={styles.windowControl}>
            <span>时间范围</span>
            <select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))} disabled={loading}>
              {WINDOW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button type="button" className={styles.refreshButton} onClick={() => void load(true)} disabled={loading || coolingDown || Boolean(pauseReason)}>
            {loading ? "读取中…" : coolingDown ? `${cooldownSeconds} 秒后可刷新` : "刷新"}
          </button>
        </div>
      </header>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {pauseReason && <div className={styles.pause} role="status">{pauseReason}</div>}

      <div className={styles.qualityBar} data-state={data?.dataQuality.status || "loading"}>
        <strong>{qualityLabel}</strong>
        {data && <span>读取于 {beijingDate(data.asOf)} · {cacheStateLabel(data.cacheStatus)} · 每源最多 {data.readBudget.maxRowsPerSource} 条 · 可用 {data.dataQuality.availableSources} · 部分 {data.dataQuality.partialSources} · 不可用 {data.dataQuality.unavailableSources}</span>}
      </div>

      <div className={styles.metrics} aria-label="充值核对指标">
        <article className={styles.metricCard}>
          <span>净确认收入</span>
          <strong>{data ? metricCurrency(data.summary.revenue.netConfirmedAmount) : "—"}</strong>
          <small>仅含渠道确认、线下确认并扣除已完成退款</small>
        </article>
        <article className={styles.metricCard}>
          <span>已支付核对范围</span>
          <strong>{data ? metricNumber(data.summary.paidOrderScopeCount) : "—"}</strong>
          <small>只核对 paid / refunded；expired 不计收入</small>
        </article>
        <article className={styles.metricCard}>
          <span>已支付未入账</span>
          <strong>{data ? metricNumber(data.summary.paidWithoutWalletCreditCount) : "—"}</strong>
          <small>必须有 completed 钱包入账凭证</small>
        </article>
        <article className={styles.metricCard}>
          <span>缺渠道确认</span>
          <strong>{data ? metricNumber(data.summary.providerConfirmationMissingCount) : "—"}</strong>
          <small>确认时间缺失时不推断为已确认</small>
        </article>
      </div>

      {data && (
        <details className={styles.sources}>
          <summary>数据来源状态</summary>
          <div className={styles.sourceGrid}>
            {data.sourceStates.map((source) => (
              <div key={source.id} className={styles.sourceItem} data-state={source.state}>
                <span>{source.label}</span>
                <strong>{sourceStateLabel(source)}</strong>
                {source.errorCode && <code>{source.errorCode}</code>}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className={styles.timelineHeader}>
        <div><strong>时间线</strong><span>{data ? `显示 ${data.timeline.events.length} / ${data.timeline.totalCount} 条` : "等待读取"}</span></div>
        {data?.timeline.truncated && <span className={styles.boundaryBadge}>已按 {data.timeline.limit} 条上限截断</span>}
      </div>

      {loading && !data ? (
        <div className={styles.empty}>正在读取充值事实…</div>
      ) : data?.timeline.events.length ? (
        <ol className={styles.timeline}>
          {data.timeline.events.map((event) => (
            <li key={event.id} className={styles.event} data-evidence={event.evidenceState}>
              <div className={styles.eventRail}><span /></div>
              <div className={styles.eventBody}>
                <div className={styles.eventTopline}>
                  <span className={styles.kind}>{KIND_LABELS[event.kind]}</span>
                  <time dateTime={event.occurredAt}>{beijingDate(event.occurredAt)}</time>
                  <span className={styles.status}>{event.statusLabel}</span>
                </div>
                <div className={styles.eventMain}>
                  <div>
                    <h3>{event.title}</h3>
                    <p>{event.detail}</p>
                  </div>
                  <strong className={styles.amount}>{eventAmount(event)}</strong>
                </div>
                <div className={styles.eventMeta}>
                  <span>{event.user.displayName}</span>
                  <code>{event.user.id || "账号 ID 未记录"}</code>
                  {event.user.identityState === "historical_or_deleted" && <span className={styles.historyBadge}>历史或已删除账号</span>}
                  {event.providerConfirmation.state === "unavailable" && <span className={styles.unavailableBadge}>渠道确认不可用</span>}
                  {event.providerConfirmation.state === "confirmed" && <span>渠道确认 {beijingDate(event.providerConfirmation.confirmedAt || event.occurredAt)}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className={styles.empty}>{error ? "读取失败，未生成虚假零值。" : "当前范围没有充值事件。"}</div>
      )}
    </section>
  );
}
