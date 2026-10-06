"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isSloMetricRegistrySnapshot,
  SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS,
  SLO_METRIC_REGISTRY_REFRESH_MS,
  type SloMetricAvailability,
  type SloMetricRegistryItem,
  type SloMetricRegistrySnapshot,
} from "@/lib/slo-metric-registry";

import styles from "./slo-metric-registry-panel.module.css";

export interface SloMetricRegistryPanelProps {
  token: string | null;
  endpoint?: string;
  windowHours?: number;
  autoRefresh?: boolean;
  variant?: "default" | "command_center";
  className?: string;
}

const SECTION_LABELS: Record<string, string> = {
  business: "会员增长",
  finance: "资金与收益",
  tasks: "生产任务",
  models: "模型与通道",
  security: "安全态势",
  operations: "系统运行",
  governance: "治理闭环",
};

const AVAILABILITY_LABELS: Record<SloMetricAvailability, string> = {
  available: "可用",
  partial: "部分",
  unavailable: "不可用",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatTime(value: string | null): string {
  if (!value) return "不可用";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatValue(metric: SloMetricRegistryItem): string {
  const value = metric.current.value;
  if (value == null) return "不可用";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return "不可用";
  if (metric.unit === "currency_cny") return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value);
  if (metric.unit === "percent") return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
  if (metric.unit === "milliseconds") return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ms`;
  if (metric.unit === "seconds") return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function reasonLabel(code: string | null): string {
  if (code === "HISTORY_MIGRATION_NOT_APPLIED") return "历史表设计尚未作为发布迁移应用";
  if (code === "HISTORY_EMPTY") return "历史表已存在，但尚无采集快照";
  if (code === "HISTORY_READ_FAILED") return "历史读取失败";
  if (code === "HISTORY_NOT_REQUESTED") return "本次未请求历史";
  return "历史快照不可用";
}

export function SloMetricRegistryPanel({
  token,
  endpoint = "/api/admin/slo-metrics/registry",
  windowHours = 24,
  autoRefresh = true,
  variant = "default",
  className = "",
}: SloMetricRegistryPanelProps) {
  const [snapshot, setSnapshot] = useState<SloMetricRegistrySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [availabilityFilter, setAvailabilityFilter] = useState("all");
  const [nextAutoRefreshAtMs, setNextAutoRefreshAtMs] = useState(0);
  const [manualRefreshAvailableAtMs, setManualRefreshAvailableAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [online, setOnline] = useState(true);
  const requestInFlightRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const activeWindowHoursRef = useRef(windowHours);

  const load = useCallback(async (manual = false) => {
    if (!token || requestInFlightRef.current) return;
    if (typeof document !== "undefined" && document.hidden) {
      setPageVisible(false);
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      return;
    }
    const controller = new AbortController();
    requestAbortRef.current = controller;
    requestInFlightRef.current = true;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ hours: String(windowHours), historyPoints: "12" });
      if (manual) query.set("refresh", "1");
      const response = await fetch(`${endpoint}?${query.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("Retry-After") || 60);
        const retryAt = isRecord(body) && typeof body.nextRefreshAt === "string"
          ? Date.parse(body.nextRefreshAt)
          : Date.now() + Math.max(1, retryAfterSeconds) * 1_000;
        const resolvedRetryAt = Number.isFinite(retryAt) ? retryAt : Date.now() + SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS;
        if (manual) setManualRefreshAvailableAtMs(resolvedRetryAt);
        else setNextAutoRefreshAtMs(resolvedRetryAt);
        setClockMs(Date.now());
        setError(isRecord(body) && typeof body.error === "string" ? body.error : "刷新过于频繁，请稍后重试");
        return;
      }
      if (!response.ok) {
        throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "指标注册表读取失败");
      }
      if (!isSloMetricRegistrySnapshot(body)) throw new Error("指标注册表响应合同不完整，本次数据未采用");
      setSnapshot(body);
      const nextAutoRefresh = Date.parse(body.refresh.nextRefreshAt);
      const nextManualRefresh = Date.parse(body.refresh.rateLimit.nextAllowedAt);
      setNextAutoRefreshAtMs(Number.isFinite(nextAutoRefresh) ? nextAutoRefresh : Date.now() + SLO_METRIC_REGISTRY_REFRESH_MS);
      setManualRefreshAvailableAtMs(
        body.refresh.rateLimit.remaining === 0 && Number.isFinite(nextManualRefresh) && nextManualRefresh > Date.now()
          ? nextManualRefresh
          : 0,
      );
      setClockMs(Date.now());
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "指标注册表读取失败");
      setNextAutoRefreshAtMs(Date.now() + SLO_METRIC_REGISTRY_REFRESH_MS);
      if (manual) setManualRefreshAvailableAtMs(Date.now() + SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS);
      setClockMs(Date.now());
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      requestInFlightRef.current = false;
      setLoading(false);
    }
  }, [endpoint, token, windowHours]);

  useEffect(() => {
    if (activeWindowHoursRef.current === windowHours) return;
    activeWindowHoursRef.current = windowHours;
    requestAbortRef.current?.abort();
    setNextAutoRefreshAtMs(0);
    setClockMs(Date.now());
  }, [windowHours]);

  useEffect(() => {
    const syncAvailability = () => {
      const visible = !document.hidden;
      const connected = navigator.onLine;
      setPageVisible(visible);
      setOnline(connected);
      setAvailabilityReady(true);
      setClockMs(Date.now());
      if (!visible || !connected) requestAbortRef.current?.abort();
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
    if (!availabilityReady || !token || !pageVisible || !online || loading) return;
    const windowChanged = snapshot?.windowHours !== windowHours;
    const due = windowChanged || nextAutoRefreshAtMs <= clockMs;
    if (!due || (snapshot && !autoRefresh)) return;
    const timer = window.setTimeout(() => void load(false), 0);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, availabilityReady, clockMs, load, loading, nextAutoRefreshAtMs, online, pageVisible, snapshot, token, windowHours]);

  useEffect(() => {
    if (!availabilityReady || !pageVisible || !online) return;
    const wakeCandidates = [
      manualRefreshAvailableAtMs > clockMs ? manualRefreshAvailableAtMs : Number.POSITIVE_INFINITY,
      autoRefresh && nextAutoRefreshAtMs > clockMs ? nextAutoRefreshAtMs : Number.POSITIVE_INFINITY,
    ];
    const nextWakeAtMs = Math.min(...wakeCandidates);
    if (!Number.isFinite(nextWakeAtMs)) return;
    const timer = window.setTimeout(() => setClockMs(Date.now()), nextWakeAtMs - clockMs + 100);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, availabilityReady, clockMs, manualRefreshAvailableAtMs, nextAutoRefreshAtMs, online, pageVisible]);

  const metrics = useMemo(() => (snapshot?.metrics || []).filter((entry) => (
    (sectionFilter === "all" || entry.section === sectionFilter)
    && (availabilityFilter === "all" || entry.current.availability === availabilityFilter)
  )), [availabilityFilter, sectionFilter, snapshot]);
  const coolingDown = manualRefreshAvailableAtMs > clockMs;
  const pauseReason = !token
    ? "缺少有效管理员会话，指标读取已暂停"
    : !availabilityReady
      ? "正在确认页面与网络状态"
      : !pageVisible
        ? "页面位于后台，指标读取已暂停"
        : !online
          ? "浏览器离线，指标读取已暂停"
          : "";

  return (
    <section
      className={`${styles.panel} ${variant === "command_center" ? styles.commandCenter : ""} ${className}`.trim()}
      aria-labelledby="slo-metric-registry-title"
      data-testid="slo-metric-registry-panel"
      data-history-state={snapshot?.historyPersistence.state || "unavailable"}
      data-request-state={pauseReason ? "paused" : loading ? "loading" : "ready"}
      data-window-hours={snapshot?.windowHours ?? ""}
      data-registry-version={snapshot?.registryVersion || ""}
    >
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h3 id="slo-metric-registry-title">指标注册表与 SLO 历史</h3>
            <span className={styles.versionBadge}>registry {snapshot?.registryVersion || "等待读取"}</span>
            <span className={snapshot?.historyPersistence.state === "available" ? styles.availableBadge : styles.unavailableBadge}>
              历史{snapshot?.historyPersistence.state === "available" ? "已接入" : "不可用"}
            </span>
          </div>
          <p className={styles.description}>
            每项指标固定负责人、公式、分子分母、排除规则、查询版本、阈值与新鲜度。页面只读；历史写入只能由独立签名调度器触发。
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          disabled={Boolean(pauseReason) || loading || coolingDown}
          onClick={() => void load(true)}
        >
          {loading ? "读取中…" : pauseReason ? "读取已暂停" : coolingDown ? "等待刷新窗口" : "刷新证据"}
        </button>
      </header>

      {pauseReason && <div className={styles.pauseNotice} role="status">{pauseReason}；恢复可见且联网后仅在快照过期时继续。</div>}
      {error && <div className={styles.error} role="alert">{error}</div>}

      <div className={styles.summaryGrid} aria-label="指标注册表摘要">
        <article><span>注册覆盖</span><strong>{snapshot ? `${snapshot.summary.registered}/${snapshot.summary.expected}` : "—"}</strong><small>当前源码审计为 41 项</small></article>
        <article data-tone="healthy"><span>当前可用</span><strong>{snapshot?.summary.available ?? "—"}</strong><small>值与来源证据完整</small></article>
        <article data-tone="warning"><span>当前部分</span><strong>{snapshot?.summary.partial ?? "—"}</strong><small>部分覆盖、未知或过期</small></article>
        <article data-tone="critical"><span>当前不可用</span><strong>{snapshot?.summary.unavailable ?? "—"}</strong><small>保持空值，不回退为 0</small></article>
        <article data-tone="history"><span>有历史趋势</span><strong>{snapshot?.summary.historyConnected ?? "—"}</strong><small>每项最多 12 个点</small></article>
      </div>

      <div className={styles.boundaryGrid}>
        <article>
          <strong>历史持久化</strong>
          <span>{snapshot?.historyPersistence.state === "available" ? "已连接" : reasonLabel(snapshot?.historyPersistence.reasonCode || null)}</span>
          <small>设计版本 {snapshot?.historyPersistence.designVersion || "2026-10-03.design-v1"}；未应用迁移前不画空趋势。</small>
        </article>
        <article>
          <strong>事故与 SLO</strong>
          <span>{snapshot?.incidentSlo.collectorsConnected ? "采集器已接入" : "采集器未接入"}</span>
          <small>{snapshot?.incidentSlo.note || "控制面与真实测量窗口分开验收。"}</small>
        </article>
        <article>
          <strong>低成本读取</strong>
          <span>{snapshot ? `${snapshot.readBudget.commandCenterViews} 个按目标视图` : "6 个按目标视图"}</span>
          <small>60 秒服务缓存与 singleflight；页面隐藏、离线时暂停，5 分钟一次自动读取。</small>
        </article>
      </div>

      <div className={styles.toolbar}>
        <label>
          <span>功能目标</span>
          <select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)}>
            <option value="all">全部目标</option>
            {Object.entries(SECTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>数据状态</span>
          <select value={availabilityFilter} onChange={(event) => setAvailabilityFilter(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="available">可用</option>
            <option value="partial">部分</option>
            <option value="unavailable">不可用</option>
          </select>
        </label>
        <div className={styles.meta}>
          <span>证据时间 {formatTime(snapshot?.asOf || null)}</span>
          <span>窗口 {snapshot?.windowHours ?? 24} 小时</span>
          <span>缓存 {snapshot?.refresh.cacheStatus || "等待读取"}</span>
        </div>
      </div>

      <div className={styles.metricList} data-testid="slo-metric-registry-list">
        {metrics.length === 0 && <div className={styles.empty}>当前筛选条件下没有可展示指标。</div>}
        {metrics.map((entry) => (
          <details
            className={styles.metricCard}
            key={entry.id}
            data-testid={`slo-metric-${entry.id}`}
            data-availability={entry.current.availability}
            data-missing={entry.current.value == null ? "true" : "false"}
          >
            <summary>
              <span className={styles.sectionTag}>{SECTION_LABELS[entry.section] || entry.section}</span>
              <span className={styles.metricIdentity}>
                <strong>{entry.name}</strong>
                <small>{entry.id}</small>
              </span>
              <span className={styles.metricValue}>{formatValue(entry)}</span>
              <span className={styles.availabilityBadge} data-availability={entry.current.availability}>
                {AVAILABILITY_LABELS[entry.current.availability]}
              </span>
            </summary>
            <div className={styles.metricDetail}>
              <dl>
                <div><dt>业务目标</dt><dd>{entry.businessObjective}</dd></div>
                <div><dt>负责人</dt><dd>{entry.owner}</dd></div>
                <div><dt>公式</dt><dd>{entry.formula}</dd></div>
                <div><dt>分子</dt><dd>{entry.numerator}</dd></div>
                <div><dt>分母</dt><dd>{entry.denominator}</dd></div>
                <div><dt>统计粒度</dt><dd>{entry.grain}</dd></div>
                <div><dt>排除规则</dt><dd>{entry.exclusions.join("；") || "无额外排除"}</dd></div>
                <div><dt>数据源</dt><dd>{entry.dataSources.join("、")}</dd></div>
                <div><dt>查询版本</dt><dd className={styles.mono}>{entry.queryVersion}</dd></div>
                <div><dt>告警边界</dt><dd>警告：{entry.alertThreshold.warning}；严重：{entry.alertThreshold.critical}</dd></div>
                <div><dt>新鲜度目标</dt><dd>{entry.freshnessTargetSeconds.toLocaleString("zh-CN")} 秒</dd></div>
                <div><dt>当前证据</dt><dd>覆盖率 {entry.current.coverageRatio == null ? "不可用" : `${(entry.current.coverageRatio * 100).toFixed(1)}%`}；业务记录新鲜度 {entry.current.freshnessSeconds == null ? "不可用" : `${entry.current.freshnessSeconds} 秒`}</dd></div>
                <div><dt>历史趋势</dt><dd>{entry.history.state === "available" ? `${entry.history.points.length} 个已保存点` : "不可用；不会显示空折线或 0"}</dd></div>
              </dl>
              <a href={entry.drilldownUrl}>打开业务下钻</a>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
