"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS,
  isRuntimeTelemetryResponse,
  type RuntimeTelemetryResponse,
} from "@/lib/runtime-telemetry-contract";

import styles from "./runtime-telemetry-panel.module.css";

export interface RuntimeTelemetryPanelProps {
  token: string | null;
  endpoint?: string;
  autoRefresh?: boolean;
  className?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let amount = Math.max(0, value);
  let unitIndex = 0;
  while (amount >= 1_024 && unitIndex < units.length - 1) {
    amount /= 1_024;
    unitIndex += 1;
  }
  return `${amount.toFixed(unitIndex < 2 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}

function formatMilliseconds(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

function formatUptime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.floor(value));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}天 ${hours}小时` : `${hours}小时 ${minutes}分`;
}

function formatTime(value: string | null): string {
  if (!value) return "采样器预热中";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间不可用";
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

function rateLimitedDetails(body: unknown, response: Response): { message: string; nextRefreshAtMs: number } {
  const record = isRecord(body) ? body : {};
  const nextRefreshAt = typeof record.nextRefreshAt === "string" ? Date.parse(record.nextRefreshAt) : Number.NaN;
  const retryAfterSeconds = Number(response.headers.get("Retry-After") || 0);
  return {
    message: typeof record.error === "string" ? record.error : "遥测读取过于频繁，请稍后重试",
    nextRefreshAtMs: Number.isFinite(nextRefreshAt)
      ? nextRefreshAt
      : Date.now() + Math.max(1, retryAfterSeconds) * 1_000,
  };
}

export function RuntimeTelemetryPanel({
  token,
  endpoint = "/api/admin/runtime-telemetry",
  autoRefresh = true,
  className = "",
}: RuntimeTelemetryPanelProps) {
  const [snapshot, setSnapshot] = useState<RuntimeTelemetryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nextRefreshAtMs, setNextRefreshAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [online, setOnline] = useState(true);
  const requestInFlightRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
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
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) {
        const limited = rateLimitedDetails(body, response);
        setNextRefreshAtMs(limited.nextRefreshAtMs);
        setClockMs(Date.now());
        setError(limited.message);
        return;
      }
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === "string"
          ? body.error
          : "当前 Web 进程遥测读取失败";
        throw new Error(message);
      }
      if (!isRuntimeTelemetryResponse(body)) throw new Error("遥测响应合同不完整，本次数据未采用");
      setSnapshot(body);
      setNextRefreshAtMs(Date.parse(body.nextRefreshAt));
      setClockMs(Date.now());
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "当前 Web 进程遥测读取失败");
      setNextRefreshAtMs(Date.now() + RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS);
      setClockMs(Date.now());
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      requestInFlightRef.current = false;
      setLoading(false);
    }
  }, [endpoint, token]);

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
    if (!availabilityReady || !token || !pageVisible || !online) return;
    const due = nextRefreshAtMs <= clockMs;
    const shouldReadInitial = snapshot === null && due;
    const shouldAutoRefresh = autoRefresh && due;
    if (!shouldReadInitial && !shouldAutoRefresh) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, availabilityReady, clockMs, load, nextRefreshAtMs, online, pageVisible, snapshot, token]);

  useEffect(() => {
    if (!availabilityReady || !pageVisible || !online || nextRefreshAtMs <= clockMs) return;
    const timer = window.setTimeout(() => setClockMs(Date.now()), nextRefreshAtMs - clockMs + 100);
    return () => window.clearTimeout(timer);
  }, [availabilityReady, clockMs, nextRefreshAtMs, online, pageVisible]);

  const current = snapshot?.current ?? null;
  const unavailable = useMemo(
    () => snapshot ? Object.values(snapshot.unavailable) : [],
    [snapshot],
  );
  const recentSamples = useMemo(
    () => snapshot?.series.slice(-6).reverse() ?? [],
    [snapshot],
  );
  const coolingDown = nextRefreshAtMs > clockMs;
  const pauseReason = !token
    ? "缺少有效管理员会话，遥测读取已暂停"
    : !availabilityReady
      ? "正在确认页面与网络状态，遥测读取暂缓"
      : !pageVisible
        ? "页面位于后台，首次读取与自动刷新已暂停"
        : !online
          ? "浏览器当前离线，首次读取与自动刷新已暂停"
          : "";
  const cacheStatusLabel = snapshot?.cacheStatus === "background_sample_hit"
    ? "后台采样命中"
    : snapshot?.cacheStatus === "background_sampler_resumed"
      ? "空闲后已安全恢复"
      : snapshot?.cacheStatus === "background_sampler_idle_suspended"
        ? "采样器空闲挂起"
        : "后台采样预热";
  const freshnessLabel = snapshot?.freshness.state === "fresh"
    ? "采样新鲜"
    : snapshot?.freshness.state === "stale"
      ? "采样已过期"
      : "采样器预热中";

  return (
    <section
      className={`${styles.panel} ${className}`.trim()}
      aria-labelledby="runtime-telemetry-title"
      data-testid="runtime-telemetry-panel"
      data-scope="current_web_process"
      data-request-state={pauseReason ? "paused" : loading ? "loading" : "ready"}
    >
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h3 id="runtime-telemetry-title" className={styles.title}>当前 Web 进程负载</h3>
            <span className={styles.scopeBadge}>scope: current_web_process</span>
            <span className={snapshot?.freshness.state === "stale" ? styles.staleBadge : styles.freshBadge}>
              {freshnessLabel}
            </span>
            {pauseReason && <span className={styles.pausedBadge}>读取已暂停</span>}
          </div>
          <p className={styles.description}>
            后台采样器按固定间隔记录 Node Web 进程自身的 CPU 增量、内存和事件循环。这里不代表整台服务器、数据库或共享 Worker 的总负载。
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void load()}
          disabled={Boolean(pauseReason) || loading || coolingDown}
        >
          {loading ? "读取中…" : pauseReason ? "当前已暂停" : coolingDown ? "等待 15 秒放行" : "刷新进程采样"}
        </button>
      </header>

      {pauseReason && <div role="status" className={styles.pauseNotice}>{pauseReason}；恢复可见且联网后，仅在快照已到期时读取。</div>}
      {error && <div role="alert" className={styles.error}>{error}</div>}

      <div className={styles.metaRow}>
        <span>采样时间：{formatTime(snapshot?.asOf ?? null)}</span>
        <span>进程内保留：{snapshot?.sampling.retainedSamples ?? 0}/{snapshot?.sampling.retentionSamples ?? 60} 点</span>
        <span>缓存状态：{cacheStatusLabel}</span>
        <span>持久化：仅进程内，重启清空</span>
        <span>空闲策略：5 分钟无读取即停表，下次读取复用同一采样器恢复</span>
      </div>

      <div className={styles.metricGrid} aria-label="当前 Web 进程指标">
        <article className={styles.metricCard}>
          <p className={styles.metricLabel}>CPU 增量</p>
          <p className={styles.metricValue}>{formatPercent(current?.cpuDelta.percentOfSingleCore)}</p>
          <p className={styles.metricNote}>单核时间基准 · 区间 {current?.intervalMs ? `${current.intervalMs} ms` : "预热中"}</p>
        </article>
        <article className={styles.metricCard}>
          <p className={styles.metricLabel}>RSS 常驻内存</p>
          <p className={styles.metricValue}>{formatBytes(current?.memory.rssBytes)}</p>
          <p className={styles.metricNote}>仅当前 Node Web 进程</p>
        </article>
        <article className={styles.metricCard}>
          <p className={styles.metricLabel}>Heap 已用 / 总量</p>
          <p className={styles.metricValue}>{formatBytes(current?.memory.heapUsedBytes)}</p>
          <p className={styles.metricNote}>{formatBytes(current?.memory.heapTotalBytes)} 已分配堆</p>
        </article>
        <article className={styles.metricCard}>
          <p className={styles.metricLabel}>事件循环利用率</p>
          <p className={styles.metricValue}>{formatPercent(current?.eventLoop.utilizationPercent)}</p>
          <p className={styles.metricNote}>Node eventLoopUtilization 区间差值</p>
        </article>
        <article className={styles.metricCard}>
          <p className={styles.metricLabel}>事件循环延迟 P95</p>
          <p className={styles.metricValue}>{formatMilliseconds(current?.eventLoop.delayP95Ms)}</p>
          <p className={styles.metricNote}>mean {formatMilliseconds(current?.eventLoop.delayMeanMs)}</p>
        </article>
        <article className={styles.metricCard}>
          <p className={styles.metricLabel}>进程运行时长</p>
          <p className={styles.metricValue}>{formatUptime(current?.uptimeSeconds)}</p>
          <p className={styles.metricNote}>来自 process.uptime()</p>
        </article>
      </div>

      <div className={styles.lowerGrid}>
        <section className={styles.seriesCard} aria-labelledby="runtime-telemetry-series-title">
          <div className={styles.sectionHeading}>
            <h4 id="runtime-telemetry-series-title">最近进程内采样</h4>
            <span>{snapshot?.sampling.intervalMs ?? 5_000} ms/点</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>CPU</th>
                  <th>RSS</th>
                  <th>ELU</th>
                  <th>P95 延迟</th>
                </tr>
              </thead>
              <tbody>
                {recentSamples.length === 0 && (
                  <tr><td colSpan={5} className={styles.emptyCell}>后台采样器尚未返回数据</td></tr>
                )}
                {recentSamples.map((sample) => (
                  <tr key={sample.sampledAt}>
                    <td>{formatTime(sample.sampledAt)}</td>
                    <td>{formatPercent(sample.cpuDelta.percentOfSingleCore)}</td>
                    <td>{formatBytes(sample.memory.rssBytes)}</td>
                    <td>{formatPercent(sample.eventLoop.utilizationPercent)}</td>
                    <td>{formatMilliseconds(sample.eventLoop.delayP95Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.unavailableCard} aria-labelledby="runtime-telemetry-unavailable-title">
          <div className={styles.sectionHeading}>
            <h4 id="runtime-telemetry-unavailable-title">第一阶段未接入</h4>
            <span>全部明确 unavailable</span>
          </div>
          <ul className={styles.unavailableList}>
            {unavailable.map((metric) => (
              <li key={`${metric.scope}:${metric.label}`}>
                <span>{metric.label}</span>
                <strong>未接入</strong>
              </li>
            ))}
          </ul>
          <p className={styles.boundaryNote}>
            未接入项不会回退为 0，也不会用当前开发电脑的一次性采样冒充服务器总量。
          </p>
        </section>
      </div>
    </section>
  );
}
