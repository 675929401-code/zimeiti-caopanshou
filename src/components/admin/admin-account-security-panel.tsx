"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Laptop, RefreshCw, ShieldAlert, ShieldCheck, WifiOff } from "lucide-react";

import {
  ADMIN_ACCOUNT_SECURITY_POLL_INTERVAL_MS,
  isAdminAccountSecurityResponse,
  type AdminAccountSecurityMutationResponse,
  type AdminAccountSecurityResponse,
  type AdminSessionItem,
} from "@/lib/admin-account-security-contract";

import styles from "./admin-account-security-panel.module.css";

export interface AdminAccountSecurityPanelProps {
  token: string | null;
  canManage?: boolean;
  stepUpReady?: boolean;
  onRequestUnlock?: () => void;
  endpoint?: string;
  autoRefresh?: boolean;
  variant?: "default" | "command_center";
  className?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTime(value: string | null): string {
  if (!value) return "—";
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

function sessionStatusLabel(session: AdminSessionItem): string {
  if (session.status === "active") return session.current ? "当前设备 · 在线" : "其他设备 · 在线";
  if (session.status === "expired") return "已过期";
  const labels: Record<string, string> = {
    logout: "主动退出",
    concurrency_limit: "超过两设备上限",
    account_credentials_changed: "账号凭据已变更",
    administrator_revoked: "管理员已撤销",
    expired: "已过期",
    other: "已撤销",
  };
  return session.revokeReason ? labels[session.revokeReason] || "已撤销" : "已撤销";
}

function requestKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `session-revoke-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function AdminAccountSecurityPanel({
  token,
  canManage = true,
  stepUpReady,
  onRequestUnlock,
  endpoint = "/api/admin/login-logs/sessions",
  autoRefresh = true,
  variant = "default",
  className = "",
}: AdminAccountSecurityPanelProps) {
  const [snapshot, setSnapshot] = useState<AdminAccountSecurityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutatingHandle, setMutatingHandle] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [nextRefreshAtMs, setNextRefreshAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(0);
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [online, setOnline] = useState(true);
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestInFlightRef = useRef(false);

  const load = useCallback(async (force = false) => {
    if (!token || requestInFlightRef.current) return;
    if (typeof document !== "undefined" && document.hidden) {
      setPageVisible(false);
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      return;
    }
    if (!force && nextRefreshAtMs > Date.now()) return;
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
        const retryAfter = Math.max(1, Number(response.headers.get("Retry-After") || 30));
        setNextRefreshAtMs(Date.now() + retryAfter * 1_000);
        throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "读取过于频繁，请稍后再试");
      }
      if (!response.ok) {
        throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "会话安全状态读取失败");
      }
      if (!isAdminAccountSecurityResponse(body)) throw new Error("会话安全响应合同不完整，本次数据未采用");
      setSnapshot(body);
      const serverNext = Date.parse(body.nextRefreshAt);
      setNextRefreshAtMs(Number.isFinite(serverNext) ? serverNext : Date.now() + ADMIN_ACCOUNT_SECURITY_POLL_INTERVAL_MS);
      setNotice("");
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "会话安全状态读取失败");
      setNextRefreshAtMs(Date.now() + ADMIN_ACCOUNT_SECURITY_POLL_INTERVAL_MS);
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      requestInFlightRef.current = false;
      setLoading(false);
      setClockMs(Date.now());
    }
  }, [endpoint, nextRefreshAtMs, token]);

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
    if (snapshot === null) {
      const timer = window.setTimeout(
        () => void load(true),
        Math.max(0, nextRefreshAtMs - Date.now()),
      );
      return () => window.clearTimeout(timer);
    }
    if (!autoRefresh) return;
    const dueAt = Math.max(nextRefreshAtMs, Date.now() + 1_000);
    const timer = window.setTimeout(() => void load(true), Math.max(0, dueAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [autoRefresh, availabilityReady, load, nextRefreshAtMs, online, pageVisible, snapshot, token]);

  useEffect(() => {
    if (nextRefreshAtMs <= clockMs) return;
    const timer = window.setTimeout(() => setClockMs(Date.now()), nextRefreshAtMs - clockMs + 100);
    return () => window.clearTimeout(timer);
  }, [clockMs, nextRefreshAtMs]);

  const revokeSession = useCallback(async (session: AdminSessionItem) => {
    if (!token || mutatingHandle) return;
    if (!canManage) {
      setError("当前管理员没有会话安全自助管理权限。");
      return;
    }
    const unlocked = stepUpReady ?? snapshot?.stepUp.status === "ready";
    if (!unlocked) {
      onRequestUnlock?.();
      setError("撤销会话前，请先使用后台的“解锁敏感操作”完成管理员密码复核。");
      return;
    }
    const allowCurrent = session.current
      ? window.confirm("退出当前设备后将立即返回管理员登录页。确认继续吗？")
      : true;
    if (!allowCurrent) return;
    setMutatingHandle(session.handle);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey(),
        },
        credentials: "same-origin",
        body: JSON.stringify({ action: "revoke_session", sessionHandle: session.handle, allowCurrent }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "会话撤销失败");
      }
      const result = body as AdminAccountSecurityMutationResponse;
      if (result.signedOut) {
        localStorage.removeItem("auth_token");
        localStorage.removeItem("auth_user");
        sessionStorage.removeItem("entered_app");
        window.location.assign("/admin/superzhujunguo");
        return;
      }
      setNotice(result.alreadyInactive ? "该会话此前已经失效，未重复撤销。" : "其他设备会话已撤销。" );
      setNextRefreshAtMs(0);
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "会话撤销失败");
    } finally {
      setMutatingHandle("");
    }
  }, [canManage, endpoint, load, mutatingHandle, onRequestUnlock, snapshot?.stepUp.status, stepUpReady, token]);

  const activeSessions = useMemo(
    () => snapshot?.sessions.items.filter((item) => item.status === "active") ?? [],
    [snapshot],
  );
  const recentInactiveSessions = useMemo(
    () => snapshot?.sessions.items.filter((item) => item.status !== "active").slice(0, 4) ?? [],
    [snapshot],
  );
  const coolingDown = nextRefreshAtMs > clockMs;
  const effectiveStepUpReady = stepUpReady ?? snapshot?.stepUp.status === "ready";
  const pauseReason = !token
    ? "缺少管理员会话，读取已暂停"
    : !availabilityReady
      ? "正在确认页面与网络状态"
      : !pageVisible
        ? "页面位于后台，自动读取已暂停"
        : !online
          ? "浏览器离线，自动读取已暂停"
          : "";
  const riskLabel = snapshot?.risk.level === "high"
    ? "高风险线索"
    : snapshot?.risk.level === "attention"
      ? "需要关注"
      : snapshot?.risk.level === "normal"
        ? "未发现异常线索"
        : "风险数据不完整";

  return (
    <section
      className={`${styles.panel} ${variant === "command_center" ? styles.commandCenter : ""} ${className}`.trim()}
      aria-labelledby="admin-account-security-title"
      data-testid="admin-account-security-panel"
      data-request-state={pauseReason ? "paused" : loading ? "loading" : "ready"}
      data-can-manage={canManage ? "true" : "false"}
    >
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <ShieldCheck aria-hidden="true" className={styles.titleIcon} />
            <h3 id="admin-account-security-title">管理员账号与会话安全</h3>
            <span className={styles.scopeBadge}>仅当前管理员</span>
            {snapshot && <span className={styles.freshBadge}>快照 {formatTime(snapshot.asOf)}</span>}
          </div>
          <p>查看服务端会话、撤销其他设备，并区分已具备的安全链与尚未接入的 MFA、可信设备和登录前挑战。</p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void load(true)}
          disabled={Boolean(pauseReason) || loading || coolingDown}
        >
          <RefreshCw aria-hidden="true" className={loading ? styles.spinning : ""} />
          {loading ? "读取中" : coolingDown ? "刷新冷却中" : "刷新安全状态"}
        </button>
      </header>

      {pauseReason && <div role="status" className={styles.pauseNotice}><WifiOff aria-hidden="true" />{pauseReason}；恢复可见且联网后再读取。</div>}
      {error && <div role="alert" className={styles.error}>{error}</div>}
      <div aria-live="polite" className={styles.liveStatus}>{notice}</div>

      <div className={styles.summaryGrid}>
        <article className={styles.summaryCard}>
          <span>活跃会话</span>
          <strong>{snapshot?.sessions.activeCount ?? "—"}</strong>
          <small>服务端最多保留两个在线会话</small>
        </article>
        <article className={styles.summaryCard}>
          <span>二次验证</span>
          <strong>{effectiveStepUpReady ? "已解锁" : "未解锁"}</strong>
          <small>{snapshot?.stepUp.expiresAt ? `有效至 ${formatTime(snapshot.stepUp.expiresAt)}` : "写操作需要管理员密码复核"}</small>
        </article>
        <article className={`${styles.summaryCard} ${snapshot?.risk.level === "high" ? styles.dangerCard : ""}`}>
          <span>异常线索</span>
          <strong>{riskLabel}</strong>
          <small>24 小时失败登录：{snapshot?.risk.failedLoginCount24h ?? "数据不可用"}</small>
        </article>
      </div>

      <div className={styles.contentGrid}>
        <section className={styles.card} aria-labelledby="active-admin-sessions-title">
          <div className={styles.cardHeading}>
            <div>
              <h4 id="active-admin-sessions-title"><Laptop aria-hidden="true" />在线设备会话</h4>
              <p>{snapshot?.sessions.detail || "正在读取服务端会话事实源。"}</p>
            </div>
            <span>{snapshot?.sessions.status === "ready" ? `${activeSessions.length} 个` : "不可用"}</span>
          </div>
          <div className={styles.sessionList}>
            {!snapshot && <div className={styles.empty}>正在读取会话状态…</div>}
            {snapshot?.sessions.status === "unavailable" && <div className={styles.unavailable}>会话事实源不可读，本次不显示“0 个会话”。</div>}
            {snapshot?.sessions.status === "ready" && activeSessions.length === 0 && <div className={styles.empty}>当前没有可显示的在线会话。</div>}
            {activeSessions.map((session) => (
              <article key={session.handle} className={session.current ? styles.currentSession : styles.sessionItem}>
                <div className={styles.sessionTopline}>
                  <strong>{sessionStatusLabel(session)}</strong>
                  <span>{formatTime(session.createdAt)} 登录</span>
                </div>
                <dl className={styles.evidenceGrid}>
                  <div><dt>设备证据</dt><dd>{session.deviceEvidence.label}</dd></div>
                  <div><dt>网络证据</dt><dd>{session.networkEvidence.label}</dd></div>
                  <div><dt>会话到期</dt><dd>{formatTime(session.expiresAt)}</dd></div>
                </dl>
                <button
                  type="button"
                  className={session.current ? styles.currentRevokeButton : styles.revokeButton}
                  onClick={() => void revokeSession(session)}
                  disabled={Boolean(mutatingHandle) || !canManage}
                >
                  {mutatingHandle === session.handle
                    ? "正在撤销…"
                    : !effectiveStepUpReady
                      ? "解锁后撤销"
                      : session.current
                        ? "退出当前设备"
                        : "撤销此设备"}
                </button>
              </article>
            ))}
          </div>
          {snapshot && recentInactiveSessions.length > 0 && (
            <details className={styles.history}>
              <summary>查看最近失效会话（{recentInactiveSessions.length}）</summary>
              <ul>
                {recentInactiveSessions.map((session) => (
                  <li key={session.handle}><span>{sessionStatusLabel(session)}</span><time>{formatTime(session.revokedAt || session.expiresAt)}</time></li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className={styles.card} aria-labelledby="admin-login-risk-title">
          <div className={styles.cardHeading}>
            <div>
              <h4 id="admin-login-risk-title"><ShieldAlert aria-hidden="true" />登录风险线索</h4>
              <p>只展示可验证线索，不把账号归属或网络变化直接认定为攻击者身份。</p>
            </div>
            <span>{riskLabel}</span>
          </div>
          <ul className={styles.signalList}>
            {snapshot?.risk.signals.map((signal) => (
              <li key={signal.code} data-severity={signal.severity}>
                <strong>{signal.label}</strong>
                <span>{signal.evidence}</span>
              </li>
            ))}
            {snapshot && snapshot.risk.signals.length === 0 && <li className={styles.noSignal}>当前可用证据未发现异常信号。</li>}
          </ul>
          <details className={styles.limitations}>
            <summary>查看判断边界</summary>
            <ul>{snapshot?.risk.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
        </section>
      </div>

      <section className={styles.readiness} aria-labelledby="admin-strong-auth-readiness-title">
        <div className={styles.cardHeading}>
          <div>
            <h4 id="admin-strong-auth-readiness-title"><KeyRound aria-hidden="true" />强认证链路准备度</h4>
            <p>未完成项保持不可用，不用普通邮箱登录、哈希指纹或操作密码冒充 MFA/可信设备。</p>
          </div>
        </div>
        <div className={styles.readinessGrid}>
          {[snapshot?.mfa, snapshot?.trustedDevices, snapshot?.anomalyChallenge].map((capability, index) => (
            <article key={capability?.code || index} className={capability?.status === "ready" ? styles.readyCapability : styles.pendingCapability}>
              <div><strong>{capability?.label || "读取中"}</strong><span>{capability?.status === "unavailable" ? "未接入" : capability?.status === "partial" ? "部分就绪" : "已就绪"}</span></div>
              <p>{capability?.detail || "正在核对能力状态。"}</p>
              {capability?.nextStep && <small>{capability.nextStep}</small>}
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
