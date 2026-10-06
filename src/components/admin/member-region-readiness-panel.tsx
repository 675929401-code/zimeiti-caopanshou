"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  MEMBER_REGION_CACHE_TTL_MS,
  isMemberRegionDistributionResponse,
  type MemberRegionDimensionSnapshot,
  type MemberRegionDistributionResponse,
  type MemberRegionSourceState,
} from "@/lib/member-region-distribution-contract";

import styles from "./member-region-readiness-panel.module.css";

export interface MemberRegionReadinessPanelProps {
  token: string | null;
  endpoint?: string;
  autoRefresh?: boolean;
  className?: string;
  variant?: "admin" | "command_center";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateLabel(state: MemberRegionSourceState): string {
  if (state === "available") return "可用";
  if (state === "partial") return "部分可用";
  if (state === "stale") return "已过期";
  return "未接入";
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "不可用";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "不可用";
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

function formatCount(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN");
}

function formatCoverage(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "不可计算" : `${(value * 100).toFixed(1)}%`;
}

function dimensionValue(dimension: MemberRegionDimensionSnapshot): string {
  if (dimension.privacySuppressed) return "少于 5 人，已隐藏";
  if (dimension.state === "unavailable") return "地域事实源未接入";
  return formatCoverage(dimension.coverageRatio);
}

function regionLabel(bucket: MemberRegionDistributionResponse["regionBuckets"][number]): string {
  return bucket.districtName
    || bucket.cityName
    || bucket.provinceName
    || bucket.countryCode
    || "行政区名称不可用";
}

export function MemberRegionReadinessPanel({
  token,
  endpoint = "/api/admin/users/regions",
  autoRefresh = false,
  className = "",
  variant = "admin",
}: MemberRegionReadinessPanelProps) {
  const [snapshot, setSnapshot] = useState<MemberRegionDistributionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pageActive, setPageActive] = useState(true);
  const [nextRefreshAtMs, setNextRefreshAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const requestInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!token || requestInFlightRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    requestInFlightRef.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
        cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) {
        const nextRefreshAt = isRecord(body) && typeof body.nextRefreshAt === "string"
          ? Date.parse(body.nextRefreshAt)
          : Number.NaN;
        const retryAfterSeconds = Number(response.headers.get("Retry-After") || 60);
        setNextRefreshAtMs(Number.isFinite(nextRefreshAt)
          ? nextRefreshAt
          : Date.now() + Math.max(1, retryAfterSeconds) * 1_000);
        setClockMs(Date.now());
        setError(isRecord(body) && typeof body.error === "string" ? body.error : "读取频率受限，请稍后重试");
        return;
      }
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === "string"
          ? body.error
          : "会员地域数据准备度读取失败";
        throw new Error(message);
      }
      if (!isMemberRegionDistributionResponse(body)) {
        throw new Error("会员地域响应合同不完整，本次数据未采用");
      }
      setSnapshot(body);
      setNextRefreshAtMs(Date.parse(body.refresh.nextRefreshAt));
      setClockMs(Date.now());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "会员地域数据准备度读取失败");
    } finally {
      requestInFlightRef.current = false;
      setLoading(false);
    }
  }, [endpoint, token]);

  useEffect(() => {
    const synchronize = () => setPageActive(document.visibilityState === "visible" && navigator.onLine);
    synchronize();
    document.addEventListener("visibilitychange", synchronize);
    window.addEventListener("online", synchronize);
    window.addEventListener("offline", synchronize);
    return () => {
      document.removeEventListener("visibilitychange", synchronize);
      window.removeEventListener("online", synchronize);
      window.removeEventListener("offline", synchronize);
    };
  }, []);

  useEffect(() => {
    if (!token || !pageActive || snapshot || nextRefreshAtMs > Date.now()) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [clockMs, load, nextRefreshAtMs, pageActive, snapshot, token]);

  useEffect(() => {
    if (!token || !autoRefresh || !snapshot || !pageActive) return;
    const delayMs = Number.isFinite(nextRefreshAtMs)
      ? Math.max(1_000, nextRefreshAtMs - Date.now() + 100)
      : MEMBER_REGION_CACHE_TTL_MS;
    const timer = window.setTimeout(() => void load(), delayMs);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, load, nextRefreshAtMs, pageActive, snapshot, token]);

  useEffect(() => {
    if (nextRefreshAtMs <= clockMs) return;
    const timer = window.setTimeout(() => setClockMs(Date.now()), nextRefreshAtMs - clockMs + 100);
    return () => window.clearTimeout(timer);
  }, [clockMs, nextRefreshAtMs]);

  const sourceStates = snapshot?.sourceStates ?? [];
  const regionBuckets = snapshot?.regionBuckets ?? [];
  const groupedBuckets = useMemo(() => regionBuckets.slice().sort((left, right) => (
    right.memberCount - left.memberCount || regionLabel(left).localeCompare(regionLabel(right), "zh-CN")
  )), [regionBuckets]);
  const coolingDown = nextRefreshAtMs > clockMs;

  return (
    <section
      className={`${styles.panel} ${variant === "command_center" ? styles.commandCenter : ""} ${className}`.trim()}
      aria-labelledby="member-region-readiness-title"
      aria-busy={loading}
      data-testid="member-region-readiness-panel"
      data-variant={variant}
    >
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h3 id="member-region-readiness-title" className={styles.title}>会员地域数据准备度</h3>
            <span className={styles.privacyBadge}>k≥5 隐私抑制</span>
            <span className={snapshot?.freshness.state === "fresh" ? styles.readyBadge : styles.unavailableBadge}>
              {snapshot?.freshness.label ?? "等待读取"}
            </span>
          </div>
          <p className={styles.description}>
            分开核对会员自报常住地、近期访问地域和业务服务城市。没有可信事实源时只展示准备度，不绘制地图，也不把缺失值补成 0。
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void load()}
          disabled={!token || loading || !pageActive || coolingDown}
        >
          {loading ? "读取中…" : !pageActive ? "页面暂停读取" : coolingDown ? "等待 60 秒放行" : "刷新来源状态"}
        </button>
      </header>

      {!token && <div role="status" className={styles.notice}>需要具备“查看会员”权限的管理员会话。</div>}
      {token && !pageActive && <div role="status" className={styles.notice}>页面当前隐藏或网络离线，地域读取已暂停。</div>}
      {error && <div role="alert" className={styles.error}>{error}</div>}

      <div className={styles.metaRow}>
        <span>数据截至：{formatTime(snapshot?.asOf)}</span>
        <span>缓存：{snapshot?.refresh.cacheStatus === "hit" ? "服务端缓存命中" : "本次读取"}</span>
        <span>会员分母：{snapshot?.population.countSuppressed ? "少于 5 人，已隐藏" : formatCount(snapshot?.population.totalMembers)}</span>
        <span>原始 IP：不进入聚合响应</span>
      </div>

      <div className={styles.dimensionGrid} aria-label="三类会员地域事实源">
        {(snapshot?.dimensions ?? []).map((dimension) => (
          <article key={dimension.id} className={styles.dimensionCard} data-state={dimension.state}>
            <div className={styles.cardHeading}>
              <h4>{dimension.label}</h4>
              <span>{stateLabel(dimension.state)}</span>
            </div>
            <p className={styles.primaryValue}>{dimensionValue(dimension)}</p>
            <dl className={styles.metricList}>
              <div><dt>已观测会员</dt><dd>{formatCount(dimension.observedMembers)}</dd></div>
              <div><dt>未知会员</dt><dd>{formatCount(dimension.unknownMembers)}</dd></div>
              <div><dt>可发布地域组</dt><dd>{formatCount(dimension.publishedBucketCount)}</dd></div>
              <div><dt>最新采集</dt><dd>{formatTime(dimension.latestCollectedAt)}</dd></div>
            </dl>
            <p className={styles.definition}>{dimension.definition}</p>
            <p className={styles.boundary}>不能等同于：{dimension.notEquivalentTo}</p>
          </article>
        ))}
        {!snapshot && (
          <div className={styles.initialState}>读取后将在这里分别显示三类地域来源的覆盖率、未知量与新鲜度。</div>
        )}
      </div>

      <div className={styles.lowerGrid}>
        <section className={styles.evidenceCard} aria-labelledby="member-region-network-input-title">
          <div className={styles.sectionHeading}>
            <h4 id="member-region-network-input-title">近期访问地域的输入准备度</h4>
            <span>只读统计</span>
          </div>
          <div className={styles.inputMetrics}>
            <div><span>成功登录事件</span><strong>{formatCount(snapshot?.accessInputReadiness.successfulLoginEvents)}</strong></div>
            <div><span>含网络地址输入</span><strong>{formatCount(snapshot?.accessInputReadiness.eventsWithNetworkAddress)}</strong></div>
            <div><span>输入覆盖率</span><strong>{formatCoverage(snapshot?.accessInputReadiness.networkAddressCoverageRatio)}</strong></div>
          </div>
          <p className={styles.boundaryNote}>
            {snapshot?.accessInputReadiness.disclaimer ?? "登录网络输入尚未读取；任何 IP 都不能证明会员常住地。"}
          </p>
        </section>

        <section className={styles.evidenceCard} aria-labelledby="member-region-map-readiness-title">
          <div className={styles.sectionHeading}>
            <h4 id="member-region-map-readiness-title">地图发布门槛</h4>
            <span>{groupedBuckets.length > 0 ? `${groupedBuckets.length} 个可发布地域组` : "当前不绘制地图"}</span>
          </div>
          {groupedBuckets.length === 0 ? (
            <div className={styles.mapEmpty}>
              <strong>暂无满足证据与隐私门槛的地域分组</strong>
              <p>需要真实地域观测、行政区代码、来源版本、用途依据与至少 5 名会员后，才允许展示区域分布。</p>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>维度</th><th>地域</th><th>会员数</th><th>置信度</th><th>采集时间</th></tr></thead>
                <tbody>
                  {groupedBuckets.map((bucket) => (
                    <tr key={`${bucket.dimension}:${bucket.regionLevel}:${bucket.provinceCode}:${bucket.cityCode}:${bucket.districtCode}`}>
                      <td>{snapshot?.dimensions.find((dimension) => dimension.id === bucket.dimension)?.label ?? bucket.dimension}</td>
                      <td>{regionLabel(bucket)}</td>
                      <td>{formatCount(bucket.memberCount)}</td>
                      <td>{bucket.averageConfidence == null ? "—" : `${(bucket.averageConfidence * 100).toFixed(0)}%`}</td>
                      <td>{formatTime(bucket.latestCollectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <details className={styles.sourceDetails}>
        <summary>查看来源状态与缺口</summary>
        <div className={styles.sourceGrid}>
          {sourceStates.map((source) => (
            <article key={source.id} className={styles.sourceItem}>
              <div><strong>{source.label}</strong><span>{stateLabel(source.state)}</span></div>
              <p>{source.detail}</p>
              <small>覆盖率 {formatCoverage(source.coverageRatio)} · 最新记录 {formatTime(source.latestRecordAt)}</small>
            </article>
          ))}
          {sourceStates.length === 0 && <p className={styles.emptySources}>尚未读取来源状态。</p>}
        </div>
      </details>
    </section>
  );
}
