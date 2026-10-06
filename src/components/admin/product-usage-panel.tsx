"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PRODUCT_USAGE_CACHE_TTL_MS,
  isProductUsageAnalyticsResponse,
  type ProductUsageAnalyticsResponse,
  type ProductUsageMetric,
} from "@/lib/product-usage-contract";

import styles from "./product-usage-panel.module.css";

export interface ProductUsagePanelProps {
  token: string | null;
  endpoint?: string;
  autoRefresh?: boolean;
  variant?: "admin" | "command_center";
  className?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTime(value: string | null): string {
  if (!value) return "事实源未提供时间";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "时间不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

function formatCount(value: number | null): string {
  return value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatRatio(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function metricValue(metric: ProductUsageMetric | undefined): string {
  if (!metric || metric.value == null) return "—";
  return metric.unit === "ratio" ? formatRatio(metric.value) : formatCount(metric.value);
}

function metricNote(metric: ProductUsageMetric | undefined): string {
  if (!metric) return "事实源未返回此指标";
  if (metric.privacySuppressed) return "样本少于 5 人，精确值已隐藏";
  if (metric.value == null) return metric.reasonCode || "事实源未接入";
  return metric.definition;
}

function availabilityLabel(value: ProductUsageAnalyticsResponse["availability"] | null): string {
  if (value === "available") return "完整事实源";
  if (value === "partial") return "部分可用";
  return "事实源未接入";
}

function availabilityClass(value: ProductUsageAnalyticsResponse["availability"] | null): string {
  if (value === "available") return styles.availableBadge;
  if (value === "partial") return styles.partialBadge;
  return styles.unavailableBadge;
}

function rateLimitedDetails(body: unknown, response: Response): { message: string; nextRefreshAtMs: number } {
  const record = isRecord(body) ? body : {};
  const retryAfterHeader = Number(response.headers.get("retry-after") || 0);
  const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
    ? retryAfterHeader
    : isRecord(record.rateLimit) && typeof record.rateLimit.retryAfterSeconds === "number"
      ? record.rateLimit.retryAfterSeconds
      : 60;
  const candidate = typeof record.nextRefreshAt === "string" ? Date.parse(record.nextRefreshAt) : Number.NaN;
  return {
    message: typeof record.error === "string" ? record.error : "刷新过于频繁，请稍后重试",
    nextRefreshAtMs: Number.isFinite(candidate) ? candidate : Date.now() + retryAfterSeconds * 1_000,
  };
}

export function ProductUsagePanel({
  token,
  endpoint = "/api/admin/product-usage",
  autoRefresh = false,
  variant = "admin",
  className = "",
}: ProductUsagePanelProps) {
  const [snapshot, setSnapshot] = useState<ProductUsageAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pausedReason, setPausedReason] = useState<"hidden" | "offline" | null>(null);
  const [nextAllowedAtMs, setNextAllowedAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const controllerRef = useRef<AbortController | null>(null);
  const snapshotRef = useRef<ProductUsageAnalyticsResponse | null>(null);
  const loadedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const load = useCallback(async (reason: "initial" | "manual" | "scheduled" | "resume") => {
    if (!token || typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      setPausedReason("hidden");
      return;
    }
    if (navigator.onLine === false) {
      setPausedReason("offline");
      return;
    }
    if (reason !== "initial" && Date.now() < nextAllowedAtMs) {
      setError(`刷新冷却中，请在 ${formatTime(new Date(nextAllowedAtMs).toISOString())} 后重试`);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setPausedReason(null);
    if (reason !== "scheduled") setError(null);
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as unknown;
      if (response.status === 429) {
        const details = rateLimitedDetails(body, response);
        setNextAllowedAtMs(details.nextRefreshAtMs);
        setClockMs(Date.now());
        setError(details.message);
        return;
      }
      if (!response.ok || !isProductUsageAnalyticsResponse(body)) {
        const message = isRecord(body) && typeof body.error === "string" ? body.error : "产品使用数据暂时无法读取";
        throw new Error(message);
      }
      setSnapshot(body);
      snapshotRef.current = body;
      const next = Date.parse(body.refresh.nextRefreshAt);
      setNextAllowedAtMs(Number.isFinite(next) ? next : Date.now() + body.refresh.rateLimit.minimumIntervalMs);
      setClockMs(Date.now());
      setError(null);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "产品使用数据暂时无法读取");
      setNextAllowedAtMs((current) => current > Date.now() ? current : Date.now() + PRODUCT_USAGE_CACHE_TTL_MS);
      setClockMs(Date.now());
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [endpoint, nextAllowedAtMs, token]);

  useEffect(() => {
    if (!token) {
      controllerRef.current?.abort();
      setSnapshot(null);
      setError(null);
      loadedTokenRef.current = null;
      return;
    }
    if (loadedTokenRef.current === token) return;
    loadedTokenRef.current = token;
    void load("initial");
    return () => controllerRef.current?.abort();
  }, [load, token]);

  useEffect(() => {
    const updateAvailability = () => {
      if (document.visibilityState === "hidden") {
        controllerRef.current?.abort();
        setLoading(false);
        setPausedReason("hidden");
        return;
      }
      if (navigator.onLine === false) {
        controllerRef.current?.abort();
        setLoading(false);
        setPausedReason("offline");
        return;
      }
      const current = snapshotRef.current;
      const shouldResume = !current || (autoRefresh && Date.now() >= Date.parse(current.refresh.nextRefreshAt));
      setPausedReason(null);
      if (shouldResume) void load("resume");
    };
    document.addEventListener("visibilitychange", updateAvailability);
    window.addEventListener("online", updateAvailability);
    window.addEventListener("offline", updateAvailability);
    return () => {
      document.removeEventListener("visibilitychange", updateAvailability);
      window.removeEventListener("online", updateAvailability);
      window.removeEventListener("offline", updateAvailability);
    };
  }, [autoRefresh, load]);

  useEffect(() => {
    if (!autoRefresh || pausedReason || !token) return;
    const requestedAt = snapshot ? Date.parse(snapshot.refresh.nextRefreshAt) : nextAllowedAtMs;
    if (!snapshot && requestedAt <= clockMs) return;
    const delayMs = Math.max(1_000, (Number.isFinite(requestedAt) ? requestedAt : Date.now() + 60_000) - Date.now());
    const timer = window.setTimeout(() => void load("scheduled"), delayMs);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, clockMs, load, nextAllowedAtMs, pausedReason, snapshot, token]);

  useEffect(() => {
    if (nextAllowedAtMs <= clockMs) return;
    const timer = window.setTimeout(() => setClockMs(Date.now()), nextAllowedAtMs - clockMs + 100);
    return () => window.clearTimeout(timer);
  }, [clockMs, nextAllowedAtMs]);

  const metricCards = useMemo(() => [
    { key: "dau", label: "日活会员", metric: snapshot?.metrics.dau },
    { key: "wau", label: "周活会员", metric: snapshot?.metrics.wau },
    { key: "mau", label: "月活会员", metric: snapshot?.metrics.mau },
    { key: "activation", label: "7 日激活率", metric: snapshot?.metrics.activation },
  ], [snapshot]);

  const panelClassName = [
    styles.panel,
    variant === "command_center" ? styles.commandCenter : styles.admin,
    className,
  ].filter(Boolean).join(" ");

  return (
    <section
      className={panelClassName}
      data-testid="product-usage-panel"
      data-snapshot-state={snapshot ? "ready" : loading ? "loading" : error ? "error" : "pending"}
      data-availability={snapshot?.availability ?? "pending"}
      data-source-mode={snapshot?.sourceMode ?? "pending"}
      data-freshness={snapshot?.freshness.state ?? "pending"}
      data-window-hours={snapshot?.fallbackSignal.windowHours ?? "pending"}
      data-schema-version={snapshot?.schemaVersion ?? "pending"}
      aria-labelledby="product-usage-title"
    >
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h3 id="product-usage-title">产品使用与价值路径</h3>
            <span className={availabilityClass(snapshot?.availability ?? null)}>
              {availabilityLabel(snapshot?.availability ?? null)}
            </span>
            {pausedReason && <span className={styles.pausedBadge}>{pausedReason === "hidden" ? "页面隐藏，已暂停" : "离线，已暂停"}</span>}
          </div>
          <p className={styles.description}>
            只从白名单产品事件计算活跃、激活、留存、功能采用和价值路径；飞行记录只作运行参考，不替代产品分析。
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          disabled={!token || loading || pausedReason !== null || clockMs < nextAllowedAtMs}
          onClick={() => void load("manual")}
        >
          {loading ? "正在读取…" : "刷新事实快照"}
        </button>
      </header>

      {error && <div className={styles.error} role="status">{error}</div>}

      <div className={styles.metaRow}>
        <span>指标时间：{formatTime(snapshot?.asOf ?? null)}</span>
        <span>读取状态：{snapshot?.refresh.cacheStatus === "hit" ? "60 秒缓存命中" : snapshot ? "有界查询" : "等待读取"}</span>
        <span>下一次刷新：{formatTime(snapshot?.refresh.nextRefreshAt ?? null)}</span>
        <span>业务写入：0</span>
      </div>

      <div className={styles.metricGrid}>
        {metricCards.map((card) => (
          <article key={card.key} className={styles.metricCard}>
            <p className={styles.metricLabel}>{card.label}</p>
            <p className={styles.metricValue}>{metricValue(card.metric)}</p>
            <p className={styles.metricNote}>{metricNote(card.metric)}</p>
          </article>
        ))}
      </div>

      <div className={styles.analysisGrid}>
        <section className={styles.sectionCard} aria-labelledby="product-retention-title">
          <div className={styles.sectionHeading}>
            <h4 id="product-retention-title">新会员留存</h4>
            <span>同期注册 cohort</span>
          </div>
          <div className={styles.retentionGrid}>
            {[1, 7, 30].map((day) => {
              const point = snapshot?.retention.find((candidate) => candidate.day === day);
              return (
                <article key={day}>
                  <span>D{day}</span>
                  <strong>{formatRatio(point?.rate ?? null)}</strong>
                  <small>{point?.privacySuppressed ? "小样本已隐藏" : point?.reasonCode || "等待事实源"}</small>
                </article>
              );
            })}
          </div>
        </section>

        <section className={styles.sectionCard} aria-labelledby="product-fallback-title">
          <div className={styles.sectionHeading}>
            <h4 id="product-fallback-title">运行事实参考</h4>
            <span>最近 24 小时</span>
          </div>
          <div className={styles.fallbackStats}>
            <div><span>有限事件</span><strong>{formatCount(snapshot?.fallbackSignal.eventCount ?? null)}</strong></div>
            <div><span>匿名会员</span><strong>{formatCount(snapshot?.fallbackSignal.pseudonymousUserCount ?? null)}</strong></div>
            <div><span>错误事件</span><strong>{formatCount(snapshot?.fallbackSignal.errorEventCount ?? null)}</strong></div>
          </div>
          <p className={styles.boundaryNote}>{snapshot?.fallbackSignal.disclaimer ?? "飞行记录读取状态尚未返回；它不能用于计算 DAU、激活、留存或价值路径。"}</p>
        </section>
      </div>

      <div className={styles.analysisGrid}>
        <section className={styles.sectionCard} aria-labelledby="product-adoption-title">
          <div className={styles.sectionHeading}>
            <h4 id="product-adoption-title">功能采用</h4>
            <span>月活会员口径</span>
          </div>
          <div className={styles.list}>
            {(snapshot?.featureAdoption ?? []).map((feature) => (
              <div key={feature.featureKey} className={styles.listItem}>
                <div><strong>{feature.label}</strong><span>完成人数 {formatCount(feature.workflowCompletedUsers)}</span></div>
                <div className={styles.barTrack} aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, (feature.adoptionRate ?? 0) * 100))}%` }} /></div>
                <b>{formatRatio(feature.adoptionRate)}</b>
              </div>
            ))}
            {(snapshot?.featureAdoption.length ?? 0) === 0 && (
              <p className={styles.emptyState}>统一产品事件未接入，暂不绘制采用率，避免把请求量冒充用户采用。</p>
            )}
          </div>
        </section>

        <section className={styles.sectionCard} aria-labelledby="product-path-title">
          <div className={styles.sectionHeading}>
            <h4 id="product-path-title">价值路径</h4>
            <span>活跃 → 价值里程碑</span>
          </div>
          <ol className={styles.pathList}>
            {(snapshot?.valuePath ?? []).map((stage, index) => (
              <li key={stage.key}>
                <span className={styles.pathIndex}>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{stage.label}</strong><small>上一步转化 {formatRatio(stage.conversionFromPrevious)}</small></div>
                <b>{formatCount(stage.users)}</b>
              </li>
            ))}
          </ol>
          {(snapshot?.valuePath.length ?? 0) === 0 && (
            <p className={styles.emptyState}>价值路径事实源未接入；当前不会生成看似完整的漏斗。</p>
          )}
        </section>
      </div>

      <details className={styles.sourceDetails}>
        <summary>查看事实源、隐私边界与缺口</summary>
        <div className={styles.sourceGrid}>
          {(snapshot?.sourceStates ?? []).map((source) => (
            <article key={source.id}>
              <div><strong>{source.label}</strong><span>{availabilityLabel(source.state)}</span></div>
              <p>{source.detail}</p>
              <small>最新记录 {formatTime(source.latestRecordAt)} · 返回 {formatCount(source.returnedRows)} / 上限 {formatCount(source.rowLimit)}</small>
            </article>
          ))}
          {!snapshot && <p className={styles.emptyState}>正在等待受权限保护的事实源状态。</p>}
        </div>
        <p className={styles.privacyNote}>
          响应不含用户 ID、原始会话、IP、UA、邮箱、提示词、正文或素材 URL；少于 5 人的群组隐藏精确值。
        </p>
      </details>
    </section>
  );
}
