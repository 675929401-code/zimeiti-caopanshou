"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";

import {
  COMMAND_CENTER_VIEW_DEFINITIONS,
  commandCenterAuthorizedDrilldownUrl,
  commandCenterViewDefinition,
  normalizeVisibleCommandCenterView,
  type CommandCenterMetric,
  type CommandCenterMetricStatus,
  type CommandCenterSection,
  type CommandCenterSnapshot,
  type CommandCenterSourceStatus,
  type CommandCenterSourceState,
  type CommandCenterView,
} from "@/lib/admin-command-center-domain";

import styles from "./command-center-panel.module.css";

const supplementalLoading = () => (
  <div className={styles.supplementLoading} aria-busy="true" aria-label="正在读取当前目标的数据模块">
    <span>正在读取当前目标的数据模块…</span>
    <i aria-hidden="true" />
    <i aria-hidden="true" />
    <i aria-hidden="true" />
  </div>
);
const MemberRegionReadinessPanel = dynamic(
  () => import("./member-region-readiness-panel").then((module) => module.MemberRegionReadinessPanel),
  { ssr: false, loading: supplementalLoading },
);
const ProductUsagePanel = dynamic(
  () => import("./product-usage-panel").then((module) => module.ProductUsagePanel),
  { ssr: false, loading: supplementalLoading },
);
const RechargeTimelinePanel = dynamic(
  () => import("./recharge-timeline-panel").then((module) => module.RechargeTimelinePanel),
  { ssr: false, loading: supplementalLoading },
);
const RuntimeTelemetryPanel = dynamic(
  () => import("./runtime-telemetry-panel").then((module) => module.RuntimeTelemetryPanel),
  { ssr: false, loading: supplementalLoading },
);
const ExternalSiteMonitorPanel = dynamic(
  () => import("./external-site-monitor-panel").then((module) => module.ExternalSiteMonitorPanel),
  { ssr: false, loading: supplementalLoading },
);
const SloMetricRegistryPanel = dynamic(
  () => import("./slo-metric-registry-panel").then((module) => module.SloMetricRegistryPanel),
  { ssr: false, loading: supplementalLoading },
);

const statusLabels: Record<CommandCenterMetricStatus, string> = {
  healthy: "正常",
  warning: "需关注",
  critical: "严重",
  unknown: "待判定",
  unavailable: "不可用",
};

const sourceStateLabels: Record<CommandCenterSourceState, string> = {
  available: "可用",
  partial: "部分样本 / 覆盖",
  stale: "证据已过期",
  unavailable: "不可用",
};

const textMetricValueLabels: Record<string, string> = {
  healthy: "正常",
  ok: "正常",
  degraded: "性能下降",
  unhealthy: "异常",
  warning: "需关注",
  critical: "严重",
  unknown: "待判定",
  unavailable: "不可用",
  partial: "部分可用",
};

const headlineMetricIds = ["tasks.success-rate", "operations.health-state", "finance.gross-profit"] as const;
const businessSpotlightIds = [
  "business.active-users",
  "finance.cash-received",
  "finance.gross-profit",
  "tasks.success-rate",
] as const;
const riskSpotlightIds = [
  "security.high-risk",
  "security.failed-logins",
  "operations.error-rate",
  "operations.health-state",
] as const;

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const currencyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type MetricTrendPoint = {
  snapshotId: string;
  value: number;
};

type MetricTrendHistory = Record<string, MetricTrendPoint[]>;

function numericMetricValue(metric: CommandCenterMetric): number | null {
  if (metric.value == null || metric.unit === "text") return null;
  const value = typeof metric.value === "number" ? metric.value : Number(metric.value);
  return Number.isFinite(value) ? value : null;
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setReducedMotion(media.matches);
    syncPreference();
    media.addEventListener?.("change", syncPreference);
    return () => media.removeEventListener?.("change", syncPreference);
  }, []);

  return reducedMotion;
}

function formatMetricValue(metric: CommandCenterMetric): string {
  if (metric.value == null) return "不可用";
  if (metric.unit === "text") {
    const rawValue = String(metric.value);
    return textMetricValueLabels[rawValue.trim().toLowerCase()] || rawValue;
  }
  const value = typeof metric.value === "number" ? metric.value : Number(metric.value);
  if (!Number.isFinite(value)) return String(metric.value);
  if (metric.unit === "currency_cny") return currencyFormatter.format(value);
  if (metric.unit === "percent") return `${numberFormatter.format(value)}%`;
  if (metric.unit === "milliseconds") return value < 1_000
    ? `${numberFormatter.format(value)} ms`
    : `${numberFormatter.format(value / 1_000)} s`;
  if (metric.unit === "seconds") return `${numberFormatter.format(value)} 秒`;
  return numberFormatter.format(value);
}

function AnimatedMetricValue({
  metric,
  reducedMotion,
  testId,
}: {
  metric: CommandCenterMetric;
  reducedMotion: boolean;
  testId: string;
}) {
  const targetValue = numericMetricValue(metric);
  const previousValueRef = useRef<number | null>(targetValue);
  const frameRef = useRef<number | null>(null);
  const [displayValue, setDisplayValue] = useState<number | null>(targetValue);

  useEffect(() => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    const previousValue = previousValueRef.current;
    previousValueRef.current = targetValue;

    if (targetValue == null || previousValue == null || reducedMotion || previousValue === targetValue) {
      setDisplayValue(targetValue);
      frameRef.current = null;
      return;
    }

    const startedAt = performance.now();
    const durationMs = 460;
    const renderFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / durationMs);
      const easedProgress = 1 - ((1 - progress) ** 3);
      setDisplayValue(previousValue + ((targetValue - previousValue) * easedProgress));
      if (progress < 1) frameRef.current = requestAnimationFrame(renderFrame);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(renderFrame);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [metric.id, reducedMotion, targetValue]);

  const visibleMetric = displayValue == null ? metric : { ...metric, value: displayValue };
  return (
    <>
      <span
        aria-hidden="true"
        data-motion={targetValue == null ? "static" : reducedMotion ? "reduced" : "animated"}
        data-testid={testId}
      >
        {formatMetricValue(visibleMetric)}
      </span>
      <span className={styles.srOnly}>{formatMetricValue(metric)}</span>
    </>
  );
}

function MetricTrend({
  metric,
  points,
  snapshotId,
  reducedMotion,
}: {
  metric: CommandCenterMetric;
  points: readonly MetricTrendPoint[];
  snapshotId: string;
  reducedMotion: boolean;
}) {
  if (numericMetricValue(metric) == null) return null;
  if (points.length < 2) {
    return <div className={styles.metricTrendWaiting}>等待下一份真实快照后显示本页会话趋势</div>;
  }

  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, Math.abs(maximum) * 0.01, 1);
  const width = 132;
  const height = 28;
  const padding = 2;
  const coordinates = points.map((point, index) => {
    const x = padding + ((width - padding * 2) * index) / Math.max(1, points.length - 1);
    const y = height - padding - (((point.value - minimum) / range) * (height - padding * 2));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const delta = values[values.length - 1] - values[0];
  const deltaLabel = delta === 0 ? "无变化" : `${delta > 0 ? "+" : ""}${numberFormatter.format(delta)}`;
  const label = `本页会话 ${points.length} 份真实快照，较首份快照 ${deltaLabel}`;

  return (
    <div className={styles.metricTrend} aria-label={label} data-point-count={points.length}>
      <svg
        key={`${metric.id}:${snapshotId}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        data-motion={reducedMotion ? "reduced" : "updated"}
      >
        <polyline points={coordinates} pathLength="1" />
      </svg>
      <span>{points.length} 份真实快照 · {deltaLabel}</span>
    </div>
  );
}

function formatTime(value: string | null): string {
  if (!value) return "暂无时间证据";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : "时间格式异常";
}

function formatCoverage(value: number | null): string {
  if (value == null) return "覆盖率未知";
  return `覆盖 ${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`;
}

function statusSummary(metric: CommandCenterMetric): string {
  const parts = [statusLabels[metric.status], formatCoverage(metric.coverageRatio)];
  if (metric.partial) parts.push("部分样本 / 覆盖");
  return parts.join(" · ");
}

function findMetrics(snapshot: CommandCenterSnapshot | null, ids: readonly string[]): CommandCenterMetric[] {
  if (!snapshot) return [];
  const byId = new Map(snapshot.sections.flatMap((section) => section.metrics).map((metric) => [metric.id, metric]));
  return ids.map((id) => byId.get(id)).filter((metric): metric is CommandCenterMetric => Boolean(metric));
}

function DrilldownText({
  url,
  allowedAdminTabs,
  children,
}: {
  url: string;
  allowedAdminTabs: readonly string[];
  children: string;
}) {
  const href = commandCenterAuthorizedDrilldownUrl(url, allowedAdminTabs);
  return href
    ? <a href={href} data-drilldown-authorized="true">{children}</a>
    : <span className={styles.restrictedDrilldown} data-drilldown-authorized="false" title="当前岗位未获目标后台模块权限">无权下钻</span>;
}

function MetricCard({
  metric,
  sources,
  allowedAdminTabs,
  reducedMotion,
}: {
  metric: CommandCenterMetric;
  sources: CommandCenterSourceStatus[];
  allowedAdminTabs: readonly string[];
  reducedMotion: boolean;
}) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const evidenceSources = metric.sourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is CommandCenterSourceStatus => Boolean(source));
  return (
    <article
      className={styles.metricCard}
      data-testid={`command-center-metric-${metric.id}`}
      data-status={metric.status}
    >
      <div className={styles.metricCardHeading}>
        <p className={styles.metricLabel}>{metric.label}</p>
        <span className={styles.statusBadge} data-status={metric.status}>{statusLabels[metric.status]}</span>
      </div>
      <div className={styles.metricValueRow}>
        <p className={styles.metricValue} data-missing={metric.value == null ? "true" : "false"}>
          <AnimatedMetricValue metric={metric} reducedMotion={reducedMotion} testId={`command-center-value-${metric.id}`} />
        </p>
        {metric.partial && <span className={styles.partialQualifier}>部分样本 / 覆盖</span>}
      </div>
      <p className={styles.metricDefinition}>{metric.definition}</p>
      <div className={styles.metricEvidence}>
        <span>{formatCoverage(metric.coverageRatio)}</span>
        <span>证据时间 {formatTime(metric.asOf)}</span>
        {metric.freshnessSeconds != null && <span>最新业务记录距今 {metric.freshnessSeconds} 秒</span>}
        {metric.partial && <strong>不可按精确总量解读</strong>}
      </div>
      <div className={styles.metricSourceRow}>
        <span title={metric.source.join("、")}>来源：{metric.source.length > 0 ? metric.source.join("、") : "未提供"}</span>
        <DrilldownText url={metric.drilldownUrl} allowedAdminTabs={allowedAdminTabs}>下钻</DrilldownText>
      </div>
      <details className={styles.metricEvidenceDetails} data-testid={`command-center-evidence-${metric.id}`}>
        <summary>证据链 {evidenceSources.length} 项</summary>
        <div className={styles.metricEvidenceList}>
          {evidenceSources.map((source) => {
            const href = commandCenterAuthorizedDrilldownUrl(source.drilldownUrl, allowedAdminTabs);
            const content = <>
              <span className={styles.signalDot} aria-hidden="true" />
              <span className={styles.metricEvidenceSourceCopy}>
                <strong>{source.label}</strong>
                <small>{source.source}</small>
              </span>
              <span>{sourceStateLabels[source.state]}</span>
              <span>{formatCoverage(source.coverageRatio)}</span>
              <span>{source.returnedRows}/{source.totalRows ?? "?"} 行</span>
              <span>{formatTime(source.asOf)}</span>
              {source.errorCode && <code>{source.errorCode}</code>}
              {!href && <span className={styles.restrictedDrilldown}>无权下钻</span>}
            </>;
            return href
              ? <a key={source.id} href={href} data-source-state={source.state} data-drilldown-authorized="true">{content}</a>
              : <div key={source.id} className={styles.restrictedEvidenceRow} data-source-state={source.state} data-drilldown-authorized="false" aria-disabled="true">{content}</div>;
          })}
        </div>
      </details>
    </article>
  );
}

function HeadlineMetric({
  metric,
  allowedAdminTabs,
  history,
  snapshotId,
  reducedMotion,
}: {
  metric: CommandCenterMetric;
  allowedAdminTabs: readonly string[];
  history: readonly MetricTrendPoint[];
  snapshotId: string;
  reducedMotion: boolean;
}) {
  const attentionStatus = metric.status === "warning" || metric.status === "critical";
  return (
    <article
      className={styles.headlineMetric}
      data-testid={`command-center-headline-${metric.id}`}
      data-status={metric.status}
    >
      <div className={styles.headlineTopline}>
        <span>{metric.label}</span>
        <span className={styles.headlineStatus}>
          {attentionStatus && (
            <span
              key={`${snapshotId}:${metric.status}`}
              className={styles.alertPulse}
              data-status={metric.status}
              data-motion={reducedMotion ? "reduced" : "changed"}
              aria-hidden="true"
            />
          )}
          <span className={styles.statusBadge} data-status={metric.status}>{statusLabels[metric.status]}</span>
        </span>
      </div>
      <div className={styles.headlineValueRow}>
        <div className={styles.headlineValue}>
          <AnimatedMetricValue metric={metric} reducedMotion={reducedMotion} testId={`command-center-headline-value-${metric.id}`} />
        </div>
        {metric.partial && <span className={styles.partialQualifier}>部分样本 / 覆盖</span>}
      </div>
      <MetricTrend metric={metric} points={history} snapshotId={snapshotId} reducedMotion={reducedMotion} />
      <p>{metric.definition}</p>
      <div className={styles.headlineFoot}>
        <span>{statusSummary(metric)}</span>
        <DrilldownText url={metric.drilldownUrl} allowedAdminTabs={allowedAdminTabs}>查看证据</DrilldownText>
      </div>
    </article>
  );
}

function SpotlightPanel({
  title,
  kicker,
  metrics,
  allowedAdminTabs,
}: {
  title: string;
  kicker: string;
  metrics: CommandCenterMetric[];
  allowedAdminTabs: readonly string[];
}) {
  return (
    <section className={styles.spotlightPanel} aria-label={title}>
      <header className={styles.panelHeading}>
        <div><span>{kicker}</span><h4>{title}</h4></div>
        <span className={styles.panelCount}>{metrics.length || "—"}</span>
      </header>
      {metrics.length > 0 ? (
        <div className={styles.spotlightList}>
          {metrics.map((metric) => {
            const href = commandCenterAuthorizedDrilldownUrl(metric.drilldownUrl, allowedAdminTabs);
            const content = <>
              <span className={styles.signalDot} aria-hidden="true" />
              <span className={styles.spotlightCopy}>
                <strong>{metric.label}</strong>
                <small>{statusSummary(metric)}</small>
              </span>
              <span className={styles.spotlightValue}>{formatMetricValue(metric)}</span>
              {!href && <span className={styles.restrictedDrilldown}>无权下钻</span>}
            </>;
            return href
              ? <a key={metric.id} className={styles.spotlightRow} data-status={metric.status} data-testid={`command-center-spotlight-${metric.id}`} href={href} title={metric.definition} data-drilldown-authorized="true">{content}</a>
              : <div key={metric.id} className={`${styles.spotlightRow} ${styles.restrictedSurface}`} data-status={metric.status} data-testid={`command-center-spotlight-${metric.id}`} title={`${metric.definition}；当前岗位不可下钻`} data-drilldown-authorized="false" aria-disabled="true">{content}</div>;
          })}
        </div>
      ) : <p className={styles.emptyPanel}>等待真实指标快照</p>}
    </section>
  );
}

function SourceDistribution({ snapshot, allowedAdminTabs }: { snapshot: CommandCenterSnapshot | null; allowedAdminTabs: readonly string[] }) {
  const counts = {
    available: snapshot?.sources.filter((source) => source.state === "available").length ?? null,
    partial: snapshot?.sources.filter((source) => source.state === "partial").length ?? null,
    stale: snapshot?.sources.filter((source) => source.state === "stale").length ?? null,
    unavailable: snapshot?.sources.filter((source) => source.state === "unavailable").length ?? null,
  };
  const total = snapshot?.sources.length ?? 0;
  const availableRatio = total > 0 ? counts.available! / total : 0;
  const partialRatio = total > 0 ? counts.partial! / total : 0;
  const staleRatio = total > 0 ? counts.stale! / total : 0;
  const sourceRingStyle = {
    "--source-available-end": `${availableRatio * 360}deg`,
    "--source-partial-end": `${(availableRatio + partialRatio) * 360}deg`,
    "--source-stale-end": `${(availableRatio + partialRatio + staleRatio) * 360}deg`,
  } as CSSProperties;
  const attentionSources = snapshot?.sources
    .filter((source) => source.state !== "available")
    .sort((left, right) => (
      Number(right.state === "unavailable") - Number(left.state === "unavailable")
      || left.label.localeCompare(right.label, "zh-CN")
    )) ?? [];
  const availableSources = snapshot?.sources
    .filter((source) => source.state === "available")
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN")) ?? [];

  const renderSourceNode = (source: CommandCenterSourceStatus) => {
    const href = commandCenterAuthorizedDrilldownUrl(source.drilldownUrl, allowedAdminTabs);
    const content = <>
      <span aria-hidden="true" />
      <small>{source.label}</small>
      {!href && <span className={styles.restrictedDrilldown}>无权</span>}
    </>;
    const common = {
      className: `${styles.sourceNode} ${href ? "" : styles.restrictedSurface}`,
      "data-source-state": source.state,
      title: `${source.label}：${sourceStateLabels[source.state]}；${formatCoverage(source.coverageRatio)}；证据时间 ${formatTime(source.asOf)}${href ? "" : "；当前岗位不可下钻"}`,
      "aria-label": `${source.label}，${sourceStateLabels[source.state]}${href ? "" : "，当前岗位不可下钻"}`,
    };
    return href
      ? <a key={source.id} {...common} href={href} data-drilldown-authorized="true">{content}</a>
      : <div key={source.id} {...common} data-drilldown-authorized="false" aria-disabled="true">{content}</div>;
  };

  return (
    <section className={styles.sourcePanel} aria-labelledby="command-center-source-title">
      <header className={styles.panelHeading}>
        <div><span>SOURCE EVIDENCE MATRIX</span><h4 id="command-center-source-title">来源证据与异常聚合</h4></div>
        <span className={styles.readOnlyFlag}>近实时快照</span>
      </header>

      <div className={styles.sourceCore}>
        <div
          className={styles.sourceRing}
          style={sourceRingStyle}
          data-empty={total === 0 ? "true" : "false"}
          role="img"
          aria-label={total > 0
              ? `共 ${total} 个真实来源，可用 ${counts.available} 个，部分 ${counts.partial} 个，过期 ${counts.stale} 个，不可用 ${counts.unavailable} 个`
            : "尚未收到来源状态快照"}
        >
          <div><strong>{total || "—"}</strong><span>来源证据</span></div>
        </div>
        <div className={styles.sourceLegend}>
          {(["available", "partial", "stale", "unavailable"] as const).map((state) => (
            <div key={state} className={styles.sourceLegendRow} data-source-state={state}>
              <span className={styles.signalDot} aria-hidden="true" />
              <span>{sourceStateLabels[state]}</span>
              <strong>{counts[state] ?? "—"}</strong>
              <small>{total > 0 && counts[state] != null ? `${((counts[state] / total) * 100).toFixed(1)}%` : "待快照"}</small>
            </div>
          ))}
        </div>
      </div>

      {snapshot ? (
        <div className={styles.sourceGroups} aria-label="按状态分组的来源证据">
          <section className={styles.sourceGroup} data-group="attention" aria-label="需关注来源">
            <div className={styles.sourceGroupHeading}>
              <span>需关注来源</span>
              <strong>{attentionSources.length}</strong>
            </div>
            {attentionSources.length > 0
              ? <div className={styles.sourceMatrix}>{attentionSources.map(renderSourceNode)}</div>
              : <p className={styles.sourceGroupEmpty}>当前快照没有部分覆盖或读取失败的来源。</p>}
          </section>
          <details className={styles.sourceGroup} data-group="available" open={attentionSources.length === 0}>
            <summary className={styles.sourceGroupHeading}>
              <span>正常来源（默认收起）</span>
              <strong>{availableSources.length}</strong>
            </summary>
            <div className={styles.sourceMatrix}>{availableSources.map(renderSourceNode)}</div>
          </details>
        </div>
      ) : <p className={styles.sourceWaiting}>等待首次读取，不用空值绘制假态势。</p>}
    </section>
  );
}

function SectionPanel({
  section,
  sources,
  allowedAdminTabs,
  reducedMotion,
}: {
  section: CommandCenterSection;
  sources: CommandCenterSourceStatus[];
  allowedAdminTabs: readonly string[];
  reducedMotion: boolean;
}) {
  const attentionCount = section.metrics.filter((metric) => metric.status !== "healthy").length;
  return (
    <section
      className={styles.sectionPanel}
      data-section={section.id}
      data-testid={`command-center-section-${section.id}`}
      aria-labelledby={`command-center-section-${section.id}`}
    >
      <header className={styles.sectionHeading}>
        <div>
          <span>{section.id.toUpperCase()}</span>
          <h4 id={`command-center-section-${section.id}`}>{section.title}</h4>
          <p>{section.description}</p>
        </div>
        <div className={styles.sectionTally}>
          <strong>{section.metrics.length}</strong>
          <span>{attentionCount > 0 ? `${attentionCount} 项非正常` : "全部正常"}</span>
        </div>
      </header>
      <div className={styles.metricGrid}>{section.metrics.map((metric) => <MetricCard key={metric.id} metric={metric} sources={sources} allowedAdminTabs={allowedAdminTabs} reducedMotion={reducedMotion} />)}</div>
    </section>
  );
}

export function CommandCenterPanel({
  token,
  allowedViews,
  allowedAdminTabs,
  defaultWindowHours = 24,
}: {
  token: string | null;
  allowedViews: readonly CommandCenterView[];
  allowedAdminTabs: readonly string[];
  defaultWindowHours?: number;
}) {
  const [snapshot, setSnapshot] = useState<CommandCenterSnapshot | null>(null);
  const [view, setView] = useState<CommandCenterView>(() => allowedViews[0] || "overview");
  const [viewReady, setViewReady] = useState(false);
  const [windowHours, setWindowHours] = useState(defaultWindowHours);
  const [paused, setPaused] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [lastReceivedAt, setLastReceivedAt] = useState<string | null>(null);
  const [nextRetryAt, setNextRetryAt] = useState<string | null>(null);
  const [manualRefreshAvailableAtMs, setManualRefreshAvailableAtMs] = useState(0);
  const [scheduleRevision, setScheduleRevision] = useState(0);
  const [metricTrendHistory, setMetricTrendHistory] = useState<Record<string, MetricTrendHistory>>({});
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const hasSnapshotRef = useRef(false);
  const inFlightRef = useRef(false);
  const failureCountRef = useRef(0);
  const retryDelayMsRef = useRef(0);
  const wasAutoRefreshActiveRef = useRef(true);
  const reducedMotion = usePrefersReducedMotion();

  const headers = useMemo(() => ({ Authorization: `Bearer ${token || ""}` }), [token]);
  const allowedViewSet = useMemo(() => new Set<CommandCenterView>(allowedViews), [allowedViews]);
  const visibleViewDefinitions = useMemo(
    () => COMMAND_CENTER_VIEW_DEFINITIONS.filter((definition) => allowedViewSet.has(definition.id)),
    [allowedViewSet],
  );
  const viewDefinition = useMemo(() => commandCenterViewDefinition(view), [view]);

  const applyView = useCallback((nextView: CommandCenterView) => {
    controllerRef.current?.abort();
    requestSequence.current += 1;
    inFlightRef.current = false;
    hasSnapshotRef.current = false;
    setSnapshot(null);
    setLastReceivedAt(null);
    setNextRetryAt(null);
    setManualRefreshAvailableAtMs(0);
    setError("");
    failureCountRef.current = 0;
    retryDelayMsRef.current = 0;
    setView(nextView);
  }, []);

  useEffect(() => {
    const syncFromUrl = () => {
      const url = new URL(window.location.href);
      const requestedView = url.searchParams.get("view");
      const nextView = normalizeVisibleCommandCenterView(requestedView, allowedViews);
      if (!nextView) {
        setViewReady(false);
        return;
      }
      if (requestedView !== nextView) {
        url.searchParams.set("tab", "dashboard");
        url.searchParams.set("view", nextView);
        window.history.replaceState({}, "", url);
      }
      applyView(nextView);
      setViewReady(true);
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [allowedViews, applyView]);

  useEffect(() => {
    const syncRuntimeState = () => {
      setPageVisible(document.visibilityState === "visible");
      setOnline(navigator.onLine);
    };
    syncRuntimeState();
    document.addEventListener("visibilitychange", syncRuntimeState);
    window.addEventListener("online", syncRuntimeState);
    window.addEventListener("offline", syncRuntimeState);
    return () => {
      document.removeEventListener("visibilitychange", syncRuntimeState);
      window.removeEventListener("online", syncRuntimeState);
      window.removeEventListener("offline", syncRuntimeState);
    };
  }, []);

  const selectView = useCallback((nextView: CommandCenterView) => {
    if (nextView === view || !allowedViewSet.has(nextView)) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "dashboard");
    url.searchParams.set("view", nextView);
    window.history.pushState({}, "", url);
    applyView(nextView);
  }, [allowedViewSet, applyView, view]);

  const loadSnapshot = useCallback(async (force: boolean) => {
    if (!viewReady || !allowedViewSet.has(view)) return;
    if (!token) {
      hasSnapshotRef.current = false;
      setSnapshot(null);
      setLastReceivedAt(null);
      setLoading(false);
      setRefreshing(false);
      setError("缺少管理员登录凭据，无法读取平台指挥中心。");
      return;
    }
    if (!force && inFlightRef.current) return;

    const sequence = ++requestSequence.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = true;
    setError("");
    if (hasSnapshotRef.current) setRefreshing(true);
    else setLoading(true);

    try {
      const params = new URLSearchParams({ hours: String(windowHours), view });
      if (force) params.set("refresh", "1");
      const response = await fetch(`/api/admin/command-center?${params.toString()}`, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        failureCountRef.current += 1;
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const serverRetryMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : 0;
        const exponentialDelayMs = Math.min(120_000, 30_000 * (2 ** Math.min(2, failureCountRef.current - 1)));
        retryDelayMsRef.current = Math.max(serverRetryMs, exponentialDelayMs);
        setNextRetryAt(new Date(Date.now() + retryDelayMsRef.current).toISOString());
        const manualResetAt = Date.parse(String(body.nextRefreshAt || body.rateLimit?.nextAllowedAt || ""));
        if (response.status === 429 && Number.isFinite(manualResetAt)) setManualRefreshAvailableAtMs(manualResetAt);
        throw new Error(String(body.error || "平台指挥中心读取失败"));
      }
      if (!body || !Array.isArray(body.sections) || !Array.isArray(body.sources)) {
        throw new Error("平台指挥中心返回的数据结构不完整");
      }
      if (sequence !== requestSequence.current) return;
      failureCountRef.current = 0;
      retryDelayMsRef.current = 0;
      setNextRetryAt(null);
      hasSnapshotRef.current = true;
      setSnapshot(body as CommandCenterSnapshot);
      setLastReceivedAt(new Date().toISOString());
      const manualResetAt = Date.parse(String(body.refresh?.rateLimit?.nextAllowedAt || ""));
      setManualRefreshAvailableAtMs(body.refresh?.rateLimit?.remaining === 0 && Number.isFinite(manualResetAt) && manualResetAt > Date.now()
        ? manualResetAt
        : 0);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (sequence !== requestSequence.current) return;
      if (retryDelayMsRef.current <= 0) {
        failureCountRef.current += 1;
        retryDelayMsRef.current = Math.min(120_000, 30_000 * (2 ** Math.min(2, failureCountRef.current - 1)));
        setNextRetryAt(new Date(Date.now() + retryDelayMsRef.current).toISOString());
      }
      setError(caught instanceof Error ? caught.message : "平台指挥中心读取失败");
    } finally {
      if (sequence === requestSequence.current) {
        inFlightRef.current = false;
        setLoading(false);
        setRefreshing(false);
        setScheduleRevision((value) => value + 1);
      }
    }
  }, [allowedViewSet, headers, token, view, viewReady, windowHours]);

  useEffect(() => {
    void loadSnapshot(false);
    return () => controllerRef.current?.abort();
  }, [loadSnapshot]);

  useEffect(() => {
    if (!token || paused || !viewReady || !pageVisible || !online) return;
    const baseDelayMs = retryDelayMsRef.current || viewDefinition.pollIntervalMs;
    const jitterRatio = retryDelayMsRef.current > 0
      ? 1 + Math.random() * 0.1
      : 0.9 + Math.random() * 0.2;
    const delayMs = Math.max(1_000, Math.round(baseDelayMs * jitterRatio));
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void loadSnapshot(false);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [loadSnapshot, online, pageVisible, paused, scheduleRevision, token, viewDefinition.pollIntervalMs, viewReady]);

  useEffect(() => {
    const active = Boolean(token && viewReady && !paused && pageVisible && online);
    const resumed = active && !wasAutoRefreshActiveRef.current;
    wasAutoRefreshActiveRef.current = active;
    if (!resumed || inFlightRef.current) return;
    const generatedAt = snapshot ? Date.parse(snapshot.generatedAt) : Number.NaN;
    const stale = !Number.isFinite(generatedAt) || Date.now() - generatedAt >= viewDefinition.pollIntervalMs;
    if (stale) void loadSnapshot(false);
  }, [loadSnapshot, online, pageVisible, paused, snapshot, token, viewDefinition.pollIntervalMs, viewReady]);

  useEffect(() => {
    const remainingMs = manualRefreshAvailableAtMs - Date.now();
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(() => setManualRefreshAvailableAtMs(0), remainingMs + 100);
    return () => window.clearTimeout(timer);
  }, [manualRefreshAvailableAtMs]);

  const headlineMetrics = useMemo(() => view === "overview"
    ? findMetrics(snapshot, headlineMetricIds)
    : snapshot?.sections.flatMap((section) => section.metrics).slice(0, 3) || [], [snapshot, view]);
  const businessSpotlights = useMemo(() => findMetrics(snapshot, businessSpotlightIds), [snapshot]);
  const riskSpotlights = useMemo(() => findMetrics(snapshot, riskSpotlightIds), [snapshot]);
  const trendScopeKey = `${view}:${windowHours}`;
  const activeTrendHistory = metricTrendHistory[trendScopeKey] || {};

  useEffect(() => {
    if (!snapshot) return;
    const numericMetrics = snapshot.sections
      .flatMap((section) => section.metrics)
      .map((metric) => ({ metric, value: numericMetricValue(metric) }))
      .filter((entry): entry is { metric: CommandCenterMetric; value: number } => entry.value != null);
    if (numericMetrics.length === 0) return;

    setMetricTrendHistory((current) => {
      const currentScope = current[trendScopeKey] || {};
      const nextScope: MetricTrendHistory = { ...currentScope };
      let changed = false;
      for (const { metric, value } of numericMetrics) {
        const points = currentScope[metric.id] || [];
        if (points.at(-1)?.snapshotId === snapshot.snapshotId) continue;
        nextScope[metric.id] = [...points, { snapshotId: snapshot.snapshotId, value }].slice(-8);
        changed = true;
      }
      return changed ? { ...current, [trendScopeKey]: nextScope } : current;
    });
  }, [snapshot, trendScopeKey]);

  const isBusy = loading || refreshing;
  const autoRefreshSuspended = paused || !pageVisible || !online;
  const manualRefreshCoolingDown = manualRefreshAvailableAtMs > 0;
  const showOverviewDeck = view === "overview";
  const showEvidencePanel = view === "evidence";
  const showAnomalies = view === "evidence" || view === "security" || view === "system";

  return (
    <section
      className={styles.commandCenter}
      aria-labelledby="command-center-title"
      aria-busy={isBusy}
      data-testid="admin-command-center"
      data-overall-status={snapshot?.overallStatus || "unknown"}
      data-view={view}
      data-window-hours={snapshot?.window.hours ?? ""}
      data-snapshot-id={snapshot?.snapshotId || ""}
    >
      <header className={styles.commandHeader}>
        <div className={styles.identityBlock}>
          <span className={styles.identityMark} aria-hidden="true"><i /><i /><i /></span>
          <div>
            <p className={styles.eyebrow}>PLATFORM OPERATIONS · EVIDENCE VIEW</p>
            <div className={styles.titleRow}>
              <h3 id="command-center-title">平台运营安全指挥中心</h3>
              <span className={styles.readOnlyFlag}>只读 · 近实时快照 · 零供应商调用</span>
              {snapshot && <span className={styles.statusBadge} data-status={snapshot.overallStatus}>全局{statusLabels[snapshot.overallStatus]}</span>}
            </div>
            <p className={styles.intro}>{viewDefinition.description} 失败、过期和覆盖不全均原样披露，不用 0 填补未知。</p>
          </div>
        </div>

        <div className={styles.controlCluster} aria-label="指挥中心读取控制">
          <label>
            <span>统计窗口</span>
            <select value={windowHours} onChange={(event) => setWindowHours(Number(event.target.value))} aria-label="平台指挥中心统计窗口">
              <option value={24}>24 小时</option>
              <option value={72}>3 天</option>
              <option value={168}>7 天</option>
            </select>
          </label>
          <button type="button" onClick={() => setPaused((value) => !value)} aria-pressed={paused} data-testid="command-center-poll-toggle">
            <span className={styles.controlLight} data-active={paused ? "false" : "true"} aria-hidden="true" />
            {paused ? "恢复轮询" : "暂停轮询"}
          </button>
          <button
            type="button"
            onClick={() => void loadSnapshot(true)}
            disabled={isBusy || !token || !online || !pageVisible || manualRefreshCoolingDown}
            className={styles.primaryControl}
            data-testid="command-center-refresh"
          >
            {refreshing ? "刷新中…" : manualRefreshCoolingDown ? "刷新冷却中" : "立即刷新"}
          </button>
        </div>
      </header>

      <nav className={styles.goalNavigation} aria-label="指挥中心目标视图" data-testid="command-center-goal-navigation">
        {visibleViewDefinitions.map((definition) => (
          <button
            key={definition.id}
            type="button"
            onClick={() => selectView(definition.id)}
            aria-current={view === definition.id ? "page" : undefined}
            data-testid={`command-center-view-${definition.id}`}
          >
            <strong>{definition.label}</strong>
            <span>{definition.sectionIds.length === 1 ? "单目标读取" : `${definition.sectionIds.length} 个证据域`}</span>
          </button>
        ))}
      </nav>

      <div className={styles.viewContext} data-testid="command-center-view-context">
        <div>
          <span>当前目标</span>
          <strong>{viewDefinition.label}</strong>
          <p>{viewDefinition.description}</p>
        </div>
        <span>{view === "evidence" ? "读取全部已登记来源" : `仅查询：${viewDefinition.querySectionIds.join(" · ")}`}</span>
      </div>

      <div className={styles.snapshotBar} data-testid="command-center-snapshot-bar">
        <span key={snapshot?.snapshotId || "idle"} className={styles.snapshotPulse} data-active={!autoRefreshSuspended && Boolean(snapshot)} aria-hidden="true" />
        <span>{loading ? "正在读取真实数据源…" : snapshot ? `快照生成 ${formatTime(snapshot.generatedAt)} · 新鲜度 ${snapshot.freshnessSeconds} 秒 · ${snapshot.window.hours} 小时窗口` : "尚无可用快照"}</span>
        <span>{autoRefreshSuspended
          ? paused ? "自动轮询已手动暂停" : !online ? "网络离线，自动轮询已暂停" : "页面不可见，自动轮询已暂停"
          : `${Math.round(viewDefinition.pollIntervalMs / 1_000)} 秒按目标只读轮询 · 非实时流`}</span>
        {snapshot && (
          <span className={styles.snapshotQuality} data-testid="command-center-data-quality">
            证据 {snapshot.dataQuality.availableSources}/{snapshot.dataQuality.totalSources} 可用
            {` · ${snapshot.dataQuality.partialSources} 部分 · ${snapshot.dataQuality.unavailableSources} 不可用 · ${snapshot.dataQuality.staleSources} 过期`}
            {` · ${snapshot.snapshotId} · 口径 ${snapshot.definitionVersion}`}
          </span>
        )}
        {snapshot && (
          <span>
            {snapshot.refresh.cacheStatus === "hit" ? "复用服务端缓存" : snapshot.refresh.cacheStatus === "shared" ? "复用并发构建" : "生成新快照"}
            {` · 构建 ${snapshot.refresh.buildDurationMs} ms · 建议下次 ${formatTime(snapshot.refresh.nextRefreshAt)}`}
          </span>
        )}
        {nextRetryAt && <span>读取失败后退避，预计 {formatTime(nextRetryAt)} 重试</span>}
        <span>{lastReceivedAt ? `页面接收 ${formatTime(lastReceivedAt)}` : "等待首次读取"}</span>
      </div>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {autoRefreshSuspended
          ? paused ? "自动轮询已手动暂停" : !online ? "网络离线，自动轮询已暂停" : "页面不可见，自动轮询已暂停"
          : `当前目标 ${viewDefinition.label}`}
      </span>

      {error && (
        <div role="alert" className={styles.errorBanner} data-testid="command-center-load-error">
          <strong>读取异常</strong>
          <span>{error}{snapshot ? "；已保留上一份快照，未将指标清零。" : ""}</span>
        </div>
      )}

      <div className={styles.viewBody} key={view} data-view={view}>
      {headlineMetrics.length > 0 ? (
        <div className={styles.headlineGrid} aria-label={`${viewDefinition.label}主指标`}>
          {headlineMetrics.map((metric) => (
            <HeadlineMetric
              key={metric.id}
              metric={metric}
              allowedAdminTabs={allowedAdminTabs}
              history={activeTrendHistory[metric.id] || []}
              snapshotId={snapshot?.snapshotId || "idle"}
              reducedMotion={reducedMotion}
            />
          ))}
        </div>
      ) : (
        <div className={styles.headlineGrid} aria-label="主指标等待状态">
          {["任务交付", "健康检查", "任务毛利快照"].map((label) => (
            <div key={label} className={styles.headlinePlaceholder} data-loading={loading ? "true" : "false"}>
              <span>{label}</span>
              {loading ? (
                <span className={styles.headlineSkeleton} aria-hidden="true"><i /><i /><i /></span>
              ) : <strong>—</strong>}
              <small>{loading ? "正在读取真实数据证据" : "等待真实数据证据"}</small>
            </div>
          ))}
        </div>
      )}

      {showOverviewDeck && (
        <div className={styles.operationalDeck}>
          <SpotlightPanel title="经营与用户" kicker="BUSINESS SIGNALS" metrics={businessSpotlights} allowedAdminTabs={allowedAdminTabs} />
          <SourceDistribution snapshot={snapshot} allowedAdminTabs={allowedAdminTabs} />
          <SpotlightPanel title="安全与运维" kicker="RISK & RELIABILITY" metrics={riskSpotlights} allowedAdminTabs={allowedAdminTabs} />
        </div>
      )}

      {showEvidencePanel && (
        <div className={styles.evidenceDeck}>
          <SourceDistribution snapshot={snapshot} allowedAdminTabs={allowedAdminTabs} />
          <SloMetricRegistryPanel
            token={token}
            windowHours={windowHours}
            variant="command_center"
            autoRefresh={!paused}
          />
        </div>
      )}

      {snapshot && !showOverviewDeck && (
        <div className={styles.sectionGrid} data-testid="command-center-sections">
          {snapshot.sections.map((section) => <SectionPanel key={section.id} section={section} sources={snapshot.sources} allowedAdminTabs={allowedAdminTabs} reducedMotion={reducedMotion} />)}
        </div>
      )}

      {view === "members" && (
        <div className={styles.viewSupplement} data-testid="command-center-members-supplement">
          <MemberRegionReadinessPanel
            token={token}
            variant="command_center"
            autoRefresh={!paused}
          />
          <ProductUsagePanel
            token={token}
            variant="command_center"
            autoRefresh={!paused}
          />
        </div>
      )}

      {view === "revenue" && (
        <div className={styles.viewSupplement} data-testid="command-center-revenue-supplement">
          <RechargeTimelinePanel
            token={token}
            variant="command_center"
            title="会员充值、到账与权益时间线"
            autoRefresh={!paused}
          />
        </div>
      )}

      {view === "system" && (
        <div className={styles.viewSupplement} data-testid="command-center-system-supplement">
          <RuntimeTelemetryPanel token={token} autoRefresh={!paused} />
          <ExternalSiteMonitorPanel token={token} autoRefresh={!paused} />
        </div>
      )}

      {snapshot && showAnomalies && (
        <section className={styles.anomalyPanel} aria-labelledby="command-center-anomaly-title" data-testid="command-center-source-anomalies">
          <header className={styles.anomalyHeading}>
            <div>
              <span>SOURCE EXCEPTION TIMELINE</span>
              <h4 id="command-center-anomaly-title">来源异常时间线</h4>
              <p>只记录读取失败、部分覆盖和超过新鲜度目标的真实来源。</p>
            </div>
            <strong>{snapshot.sourceAnomalies.length} 项</strong>
          </header>
          {snapshot.sourceAnomalies.length === 0 ? (
            <div className={styles.noAnomaly}><span className={styles.signalDot} aria-hidden="true" />本次快照未发现来源读取异常。</div>
          ) : (
            <div className={styles.timeline}>
              {snapshot.sourceAnomalies.map((anomaly) => (
                <article key={anomaly.id} className={styles.timelineItem} data-severity={anomaly.severity}>
                  <span className={styles.timelineRail} aria-hidden="true"><i /></span>
                  <div className={styles.timelineTime}>{formatTime(anomaly.detectedAt)}</div>
                  <div className={styles.timelineCopy}>
                    <div><span className={styles.severityBadge}>{anomaly.severity === "critical" ? "严重" : "需关注"}</span><strong>{anomaly.title}</strong></div>
                    <p>{anomaly.description}</p>
                    <small>来源标识：{anomaly.sourceId}</small>
                  </div>
                  <DrilldownText url={anomaly.drilldownUrl} allowedAdminTabs={allowedAdminTabs}>查看来源</DrilldownText>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {!snapshot && !loading && !error && <div className={styles.emptyState}>尚无平台指挥中心快照。</div>}
      </div>
    </section>
  );
}
