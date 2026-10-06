"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EXTERNAL_SITE_MONITOR_CACHE_TTL_MS,
  isExternalSiteMonitorResponse,
  type ExternalSiteMonitorResponse,
  type ExternalSiteMonitorTargetSnapshot,
  type ExternalSiteProbeState,
} from "@/lib/external-site-monitor-contract";

import styles from "./external-site-monitor-panel.module.css";

export interface ExternalSiteMonitorPanelProps {
  token: string | null;
  endpoint?: string;
  autoRefresh?: boolean;
  className?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function stateLabel(value: ExternalSiteProbeState | ExternalSiteMonitorTargetSnapshot["state"] | undefined): string {
  if (value === "passed" || value === "active") return "正常";
  if (value === "degraded") return "降级";
  if (value === "failed") return "失败";
  if (value === "stale") return "已过期";
  return "未接入";
}

function stateTone(value: ExternalSiteProbeState | ExternalSiteMonitorTargetSnapshot["state"] | undefined): string {
  if (value === "passed" || value === "active") return "healthy";
  if (value === "degraded" || value === "stale") return "warning";
  if (value === "failed") return "danger";
  return "unavailable";
}

export function ExternalSiteMonitorPanel({
  token,
  endpoint = "/api/admin/external-site-monitor",
  autoRefresh = false,
  className = "",
}: ExternalSiteMonitorPanelProps) {
  const [snapshot, setSnapshot] = useState<ExternalSiteMonitorResponse | null>(null);
  const [selectedHostname, setSelectedHostname] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pageActive, setPageActive] = useState(true);
  const [nextAllowedAtMs, setNextAllowedAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!token || requestRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const controller = new AbortController();
    requestRef.current = controller;
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
        const bodyRecord = record(body);
        const nextRefreshAt = typeof bodyRecord?.nextRefreshAt === "string"
          ? Date.parse(bodyRecord.nextRefreshAt)
          : Number.NaN;
        const retryAfterSeconds = Number(response.headers.get("Retry-After") || 30);
        setNextAllowedAtMs(Number.isFinite(nextRefreshAt)
          ? nextRefreshAt
          : Date.now() + Math.max(1, retryAfterSeconds) * 1_000);
        setClockMs(Date.now());
        setError(typeof bodyRecord?.error === "string" ? bodyRecord.error : "读取频率受限，请稍后重试");
        return;
      }
      if (!response.ok) {
        const message = record(body);
        throw new Error(typeof message?.error === "string" ? message.error : "外部站点监测读取失败");
      }
      if (!isExternalSiteMonitorResponse(body)) {
        throw new Error("外部监测响应合同不完整，本次数据未采用");
      }
      setSnapshot(body);
      setSelectedHostname((current) => (
        current && body.targets.some((target) => target.hostname === current)
          ? current
          : body.targets[0]?.hostname || ""
      ));
      setNextAllowedAtMs(Date.now() + body.rateLimit.minimumIntervalMs);
      setClockMs(Date.now());
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "外部站点监测读取失败");
      setNextAllowedAtMs(Date.now() + EXTERNAL_SITE_MONITOR_CACHE_TTL_MS);
      setClockMs(Date.now());
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setLoading(false);
    }
  }, [endpoint, token]);

  useEffect(() => {
    const synchronize = () => {
      const active = document.visibilityState === "visible" && navigator.onLine;
      setPageActive(active);
      if (!active) requestRef.current?.abort();
    };
    synchronize();
    document.addEventListener("visibilitychange", synchronize);
    window.addEventListener("online", synchronize);
    window.addEventListener("offline", synchronize);
    return () => {
      document.removeEventListener("visibilitychange", synchronize);
      window.removeEventListener("online", synchronize);
      window.removeEventListener("offline", synchronize);
      requestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!token || !pageActive || snapshot || nextAllowedAtMs > clockMs) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [clockMs, load, nextAllowedAtMs, pageActive, snapshot, token]);

  useEffect(() => {
    if (!token || !autoRefresh || !snapshot || !pageActive) return;
    const refreshAt = Math.max(Date.parse(snapshot.nextRefreshAt), nextAllowedAtMs);
    const delayMs = Number.isFinite(refreshAt)
      ? Math.max(1_000, refreshAt - Date.now() + 100)
      : EXTERNAL_SITE_MONITOR_CACHE_TTL_MS;
    const timer = window.setTimeout(() => void load(), delayMs);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, load, nextAllowedAtMs, pageActive, snapshot, token]);

  useEffect(() => {
    if (nextAllowedAtMs <= clockMs) return;
    const timer = window.setTimeout(() => setClockMs(Date.now()), nextAllowedAtMs - clockMs + 100);
    return () => window.clearTimeout(timer);
  }, [clockMs, nextAllowedAtMs]);

  const target = useMemo(() => (
    snapshot?.targets.find((candidate) => candidate.hostname === selectedHostname)
    || snapshot?.targets[0]
    || null
  ), [selectedHostname, snapshot]);
  const probe = target?.latestProbe || null;
  const schedulerSource = snapshot?.sources.find((source) => source.id === "external_scheduler") || null;
  const coolingDown = nextAllowedAtMs > clockMs;
  const activationTone = stateTone(snapshot?.activation.state);

  const checks = [
    {
      id: "dns",
      label: "DNS 解析",
      state: probe?.checks.dns.state,
      value: probe ? `${probe.checks.dns.ipv4Count ?? "—"} A · ${probe.checks.dns.ipv6Count ?? "—"} AAAA` : "无外部样本",
      note: probe ? `外部耗时 ${formatDuration(probe.checks.dns.durationMs)}；仅保存地址集合摘要` : "需要独立主机完成解析并签名摄取",
    },
    {
      id: "tls",
      label: "TLS 与证书",
      state: probe?.checks.tls.state,
      value: probe?.checks.tls.daysRemaining == null ? "证书信息不可用" : `剩余 ${probe.checks.tls.daysRemaining.toFixed(1)} 天`,
      note: probe ? `${probe.checks.tls.negotiatedProtocol || "协议不可用"} · 到期 ${formatTime(probe.checks.tls.certificateNotAfter)}` : "尚无外部 TLS 握手证据",
    },
    {
      id: "https",
      label: "HTTPS 首页",
      state: probe?.checks.https.state,
      value: probe?.checks.https.statusCode == null ? "状态不可用" : `HTTP ${probe.checks.https.statusCode}`,
      note: probe ? `外部耗时 ${formatDuration(probe.checks.https.durationMs)} · ${probe.checks.https.contentType || "类型不可用"}` : "应用服务器不会从内部自查代替此项",
    },
    {
      id: "assets",
      label: "关键静态资源",
      state: probe?.checks.staticAssets.state,
      value: probe ? `${probe.checks.staticAssets.checkedCount ?? "—"} 项已检查` : "资源证据不可用",
      note: probe?.checks.staticAssets.items.length
        ? probe.checks.staticAssets.items.map((item) => `${item.path} ${item.statusCode ?? "—"}`).join(" · ")
        : "尚无同源脚本、样式或显式关键资源样本",
    },
    {
      id: "login",
      label: "登录入口 DOM",
      state: probe?.checks.loginDom.state,
      value: probe ? `${probe.checks.loginDom.markers.filter((marker) => marker.present).length}/${probe.checks.loginDom.markers.length} 标记存在` : "DOM 证据不可用",
      note: probe ? `服务端 HTML 模式 · HTTP ${probe.checks.loginDom.statusCode ?? "—"} · ${formatDuration(probe.checks.loginDom.durationMs)}` : "不执行登录，也不提交账号密码",
    },
  ] as const;

  return (
    <section
      className={`${styles.panel} ${className}`.trim()}
      aria-labelledby="external-site-monitor-title"
      aria-busy={loading}
      data-testid="external-site-monitor-panel"
      data-activation={snapshot?.activation.state || "unavailable"}
      data-target-hostname={target?.hostname || ""}
      data-evidence-completed-at={probe?.completedAt || ""}
    >
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h3 id="external-site-monitor-title">外部站点监测</h3>
            <span className={styles.scopeBadge}>EXTERNAL VANTAGE</span>
            <span className={styles.statusBadge} data-tone={activationTone}>
              {stateLabel(snapshot?.activation.state)}
            </span>
          </div>
          <p>
            DNS、TLS、HTTPS、关键静态资源和登录入口由独立主机探测后签名回传。后台只读取证据，不从应用服务器内部自检。
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void load()}
          disabled={!token || loading || !pageActive || coolingDown}
        >
          {loading ? "读取中…" : !pageActive ? "页面暂停读取" : coolingDown ? "等待读取放行" : "刷新外部证据"}
        </button>
      </header>

      {!token && <div className={styles.notice} role="status">需要具备“查看运行日志”权限的管理员会话。</div>}
      {token && !pageActive && <div className={styles.notice} role="status">页面隐藏或网络离线，读取已暂停并取消在途请求。</div>}
      {error && <div className={styles.error} role="alert">{error}</div>}

      <div className={styles.metaRow}>
        <span>证据截至：{formatTime(probe?.completedAt)}</span>
        <span>新鲜度：{snapshot?.freshness.ageSeconds == null ? "不可用" : `${snapshot.freshness.ageSeconds} 秒`}</span>
        <span>预计频率：{snapshot ? `${snapshot.expectedIntervalSeconds} 秒` : "未读取"}</span>
        <span>服务端外网请求：0</span>
        <span>业务写入：0</span>
      </div>

      {snapshot && !snapshot.activation.productionExternalMonitoringReady && (
        <div className={styles.activationGap} role="status">
          <strong>生产外部监测尚未激活</strong>
          <span>{snapshot.activation.reasonCode}</span>
          <p>迁移、独立调度器身份、摄取密钥和新鲜外部样本必须同时成立；缺少任一项都保持 unavailable。</p>
        </div>
      )}

      {snapshot && snapshot.targets.length > 1 && (
        <div className={styles.targetTabs} aria-label="监测域名">
          {snapshot.targets.map((item) => (
            <button
              key={item.hostname}
              type="button"
              className={item.hostname === target?.hostname ? styles.targetActive : ""}
              onClick={() => setSelectedHostname(item.hostname)}
            >
              <span>{item.hostname}</span>
              <small>{stateLabel(item.state)}</small>
            </button>
          ))}
        </div>
      )}

      <div className={styles.targetHeading}>
        <div>
          <span>当前目标</span>
          <strong>{target?.hostname || "未登记可监测域名"}</strong>
        </div>
        <div>
          <span>外部观测点</span>
          <strong>{probe ? probe.vantage.region : "未观测"}</strong>
        </div>
        <div>
          <span>调度器</span>
          <strong>{schedulerSource?.state === "available" ? "已验证外部调度" : schedulerSource?.state === "stale" ? "外部样本已过期" : "未接入"}</strong>
        </div>
      </div>

      <div className={styles.checkGrid} aria-label="外部站点监测五项检查">
        {checks.map((check) => (
          <article
            key={check.id}
            className={styles.checkCard}
            data-tone={stateTone(check.state)}
            data-check-id={check.id}
            data-check-state={check.state || "unavailable"}
          >
            <div className={styles.checkHeader}>
              <h4>{check.label}</h4>
              <span>{stateLabel(check.state)}</span>
            </div>
            <strong className={styles.checkValue}>{check.value}</strong>
            <p title={check.note}>{check.note}</p>
          </article>
        ))}
      </div>

      <div className={styles.lowerGrid}>
        <section className={styles.sourceCard} aria-labelledby="external-monitor-source-title">
          <div className={styles.sectionHeading}>
            <h4 id="external-monitor-source-title">激活链路</h4>
            <span>缺口不会补成 0</span>
          </div>
          <ul>
            {(snapshot?.sources || []).map((source) => (
              <li key={source.id}>
                <div><strong>{source.label}</strong><span data-tone={source.state === "available" ? "healthy" : source.state === "stale" ? "warning" : "unavailable"}>{source.state === "available" ? "已连接" : source.state === "stale" ? "已过期" : "未接入"}</span></div>
                <p>{source.detail}</p>
              </li>
            ))}
            {!snapshot && <li className={styles.emptySource}>读取后显示外部调度器、签名摄取与证据表状态。</li>}
          </ul>
        </section>

        <section className={styles.sourceCard} aria-labelledby="external-monitor-boundary-title">
          <div className={styles.sectionHeading}>
            <h4 id="external-monitor-boundary-title">监测边界</h4>
            <span>低资源模式</span>
          </div>
          <ul className={styles.boundaryList}>
            {(snapshot?.limitations || [
              "独立外部调度器未接入前，当前状态保持 unavailable。",
              "不保存响应正文、账号密码或原始 DNS 地址。",
              "不自动切流、不自动改证书、不执行恢复动作。",
            ]).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      </div>
    </section>
  );
}
