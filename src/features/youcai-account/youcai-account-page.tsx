"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useApp } from "@/contexts/app-context";
import { safeGetItem } from "@/lib/safe-storage";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { summarizeMediaHistoryCount } from "@/lib/media-history-count";
import {
  ArrowRight,
  BadgeCheck,
  Coins,
  FolderOpen,
  Gift,
  History,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  UserRound,
  WalletCards,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./youcai-account-page.module.css";

interface AccountAssets {
  credits: {
    balance: number;
    totalRecharged: number;
    totalConsumed: number;
  };
  cash: {
    balance: number;
    totalRecharged: number;
    totalConsumed: number;
  };
}

interface AccountSnapshot {
  displayName: string;
  username: string;
  role: string;
  memberStatus: string;
  email: string;
  phone: string;
  assets: AccountAssets | null;
  generatedCount: number | null;
  generatedCountIsExact: boolean;
  generatedCountWindowLimit: number;
  storedCount: number | null;
  usedBytes: number | null;
  partialFailures: string[];
}

function memberStatusLabel(status: string) {
  if (status === "active") return "正式会员";
  if (status === "trial") return "体验会员";
  if (status === "expired") return "会员已到期";
  return "会员未激活";
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function safeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function fetchAccountJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const payload = await response.json() as T;
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

export function YoucaiAccountPage() {
  const router = useRouter();
  const { state, checkAuth, logout } = useApp();
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const snapshotRef = useRef<AccountSnapshot | null>(null);
  const activeTokenRef = useRef<string | null>(null);
  const loadRequestRef = useRef(0);
  const token = state.auth.token || safeGetItem(STORAGE_KEYS.AUTH_TOKEN);

  useEffect(() => {
    let active = true;
    const deadline = window.setTimeout(() => {
      // AppContext currently owns the auth fetches and does not expose an
      // AbortSignal. Release this page from an unbounded spinner even if that
      // shared check stalls; a stored token can still run the bounded account
      // reads, and a later auth state update will reconcile normally.
      if (active) setChecked(true);
    }, 8_000);
    void checkAuth()
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(deadline);
        if (active) setChecked(true);
      });
    return () => {
      active = false;
      window.clearTimeout(deadline);
    };
  }, [checkAuth]);

  const loadAccount = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    if (!token) {
      activeTokenRef.current = null;
      snapshotRef.current = null;
      setSnapshot(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const tokenChanged = activeTokenRef.current !== null && activeTokenRef.current !== token;
    activeTokenRef.current = token;
    if (tokenChanged) {
      snapshotRef.current = null;
      setSnapshot(null);
    }
    const previousSnapshot = snapshotRef.current;
    setLoading(!previousSnapshot);
    setRefreshing(Boolean(previousSnapshot));
    setError("");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [meResult, assetsResult] = await Promise.allSettled([
        fetchAccountJson<{ user?: Record<string, unknown> }>(
          "/api/auth/me",
          { headers, cache: "no-store" },
          8_000,
        ),
        fetchAccountJson<AccountAssets>(
          "/api/user/assets",
          { headers, cache: "no-store" },
          8_000,
        ),
      ]);

      if (meResult.status !== "fulfilled" || !meResult.value.response.ok) {
        throw new Error("账户身份暂时无法读取，请重新登录或稍后重试");
      }

      const user = meResult.value.payload.user || {};
      const partialFailures: string[] = [];

      let assets: AccountAssets | null = null;
      if (assetsResult.status === "fulfilled" && assetsResult.value.response.ok) {
        const payload = assetsResult.value.payload;
        assets = {
          credits: {
            balance: safeNumber(payload.credits?.balance),
            totalRecharged: safeNumber(payload.credits?.totalRecharged),
            totalConsumed: safeNumber(payload.credits?.totalConsumed),
          },
          cash: {
            balance: safeNumber(payload.cash?.balance),
            totalRecharged: safeNumber(payload.cash?.totalRecharged),
            totalConsumed: safeNumber(payload.cash?.totalConsumed),
          },
        };
      } else {
        partialFailures.push("积分与余额");
      }

      const baseSnapshot: AccountSnapshot = {
        displayName: String(user.displayName || user.display_name || user.username || "创作者"),
        username: String(user.username || ""),
        role: String(user.role || "student"),
        memberStatus: String(user.memberStatus || user.member_status || "inactive"),
        email: String(user.email || ""),
        phone: String(user.phone || ""),
        assets,
        generatedCount: null,
        generatedCountIsExact: false,
        generatedCountWindowLimit: 20,
        storedCount: null,
        usedBytes: null,
        partialFailures,
      };
      if (requestId !== loadRequestRef.current) return;
      snapshotRef.current = baseSnapshot;
      setSnapshot(baseSnapshot);
      // Identity and balances are the primary account contract. Do not keep
      // the whole page behind optional media/storage aggregation.
      setLoading(false);

      const [mediaResult, storageResult] = await Promise.allSettled([
        fetchAccountJson<unknown>(
          "/api/media-history?limit=20&includeTotal=true",
          { headers, cache: "no-store" },
          6_000,
        ),
        fetchAccountJson<{ quota?: { fileCount?: number; usedBytes?: number } }>(
          "/api/storage/files?limit=1&offset=0&quota=true",
          { headers, cache: "no-store" },
          6_000,
        ),
      ]);
      if (requestId !== loadRequestRef.current) return;

      const optionalFailures: string[] = [];
      let generatedCount: number | null = null;
      let generatedCountIsExact = false;
      let generatedCountWindowLimit = 20;
      if (mediaResult.status === "fulfilled" && mediaResult.value.response.ok) {
        const countSummary = summarizeMediaHistoryCount(mediaResult.value.payload);
        generatedCount = countSummary.count;
        generatedCountIsExact = countSummary.exact;
        generatedCountWindowLimit = countSummary.windowLimit;
        if (countSummary.count === null) optionalFailures.push("生成记录");
      } else {
        optionalFailures.push("生成记录");
      }

      let storedCount: number | null = null;
      let usedBytes: number | null = null;
      if (storageResult.status === "fulfilled" && storageResult.value.response.ok) {
        const payload = storageResult.value.payload;
        if (payload.quota?.fileCount === undefined || payload.quota?.usedBytes === undefined) {
          optionalFailures.push("上传素材");
        } else {
          storedCount = safeNumber(payload.quota.fileCount);
          usedBytes = safeNumber(payload.quota.usedBytes);
        }
      } else {
        optionalFailures.push("上传素材");
      }

      const completeSnapshot = {
        ...baseSnapshot,
        generatedCount,
        generatedCountIsExact,
        generatedCountWindowLimit,
        storedCount,
        usedBytes,
        partialFailures: [...partialFailures, ...optionalFailures],
      };
      snapshotRef.current = completeSnapshot;
      setSnapshot(completeSnapshot);
    } catch (reason) {
      if (requestId !== loadRequestRef.current) return;
      const message = reason instanceof Error ? reason.message : "账户信息暂时无法读取";
      if (snapshotRef.current) {
        setSnapshot(snapshotRef.current);
        setError(`${message}；已保留上次成功同步的账户数据`);
      } else {
        snapshotRef.current = null;
        setSnapshot(null);
        setError(message);
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [token]);

  useEffect(() => {
    if (checked && token) void loadAccount();
  }, [checked, loadAccount, token]);

  const identityDetails = useMemo(() => {
    if (!snapshot) return "";
    return snapshot.phone || snapshot.email || snapshot.username || "已登录账户";
  }, [snapshot]);

  if (!checked || (loading && !snapshot)) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingState} role="status"><LoaderCircle size={22} />正在同步账户数据…</div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className={styles.page}>
        <section className={styles.loginState}>
          <span><UserRound size={31} /></span>
          <h1>个人中心</h1>
        <p>登录统一账号后，可在漫剧工作台内查看会员、积分、余额和个人资产。</p>
          <Link href="/login?redirect=/youcai/profile"><LogIn size={17} />立即登录</Link>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page} data-page="manju-account" aria-busy={refreshing}>
      <header className={styles.accountHeader}>
        <div className={styles.identityMark}><UserRound size={28} /></div>
        <div>
          <span>漫剧工作台 · 个人中心</span>
          <h1>{snapshot?.displayName || "个人中心"}</h1>
          <p>{identityDetails}</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" disabled={loading || refreshing} onClick={() => void loadAccount()}><RefreshCw size={15} />{refreshing ? "刷新中" : "刷新"}</button>
          <button
            type="button"
            onClick={() => {
              logout();
              router.replace("/youcai");
            }}
          ><LogOut size={15} />退出登录</button>
        </div>
      </header>

      {error && <div className={styles.errorState} role="alert">{error}<button type="button" onClick={() => void loadAccount()}>重试</button></div>}
      {snapshot?.partialFailures.length ? (
        <div className={styles.noticeState} role="status">
          {snapshot.partialFailures.join("、")}暂时无法同步；页面没有用占位数据冒充真实账户值。
        </div>
      ) : null}

      <section className={styles.metrics} aria-label="账户概况">
        <article>
          <span data-tone="amber"><Coins size={21} /></span>
          <div><small>可用积分</small><strong>{snapshot?.assets ? snapshot.assets.credits.balance.toLocaleString("zh-CN") : "—"}</strong></div>
        </article>
        <article>
          <span data-tone="blue"><WalletCards size={21} /></span>
          <div><small>现金余额</small><strong>{snapshot?.assets ? `¥${snapshot.assets.cash.balance.toFixed(2)}` : "—"}</strong></div>
        </article>
        <article>
          <span data-tone="violet"><BadgeCheck size={21} /></span>
          <div><small>会员状态</small><strong>{memberStatusLabel(snapshot?.memberStatus || "inactive")}</strong></div>
        </article>
        <article>
          <span data-tone="green"><FolderOpen size={21} /></span>
          <div><small>资产文件</small><strong>{snapshot?.storedCount === null || snapshot?.storedCount === undefined ? "—" : snapshot.storedCount}</strong></div>
        </article>
      </section>

      <section className={styles.linkGrid} aria-label="账户功能">
        <Link href="/assets">
          <span data-tone="blue"><FolderOpen size={22} /></span>
          <div>
            <h2>个人资产</h2>
            <p>
              {snapshot?.generatedCount ?? "—"} 条{snapshot?.generatedCountIsExact ? "生成记录" : "最近生成记录"}
              {snapshot && !snapshot.generatedCountIsExact ? `（当前窗口最多 ${snapshot.generatedCountWindowLimit} 条）` : ""}
              {" · "}{snapshot?.storedCount ?? "—"} 个上传文件
            </p>
          </div>
          <ArrowRight size={18} />
        </Link>
        <Link href="/recharge">
          <span data-tone="amber"><Coins size={22} /></span>
            <div><h2>积分充值</h2><p>使用统一支付、积分到账与会员协议</p></div>
          <ArrowRight size={18} />
        </Link>
        <Link href="/referral">
          <span data-tone="violet"><Gift size={22} /></span>
          <div><h2>推荐计划</h2><p>查看邀请码、好友激活状态与活动福利</p></div>
          <ArrowRight size={18} />
        </Link>
      </section>

      <section className={styles.dataContract} aria-label="数据来源与触发规则">
        <div>
          <h2>这里什么时候会有数据？</h2>
          <p>余额来自统一账户资产数据；充值成功或任务终态结算后更新。生成记录来自已持久化的图片/视频任务；上传素材只有在对象存储及文件索引都成功后才计入。失败、未落库或仍在处理中不会伪装成已完成资产。</p>
        </div>
        <dl>
          <div>
            <dt>{snapshot?.generatedCountIsExact ? "生成记录总数" : "最近生成记录"}</dt>
            <dd>
              {snapshot?.generatedCount ?? "—"}
              {snapshot && !snapshot.generatedCountIsExact ? `（最多 ${snapshot.generatedCountWindowLimit} 条）` : ""}
            </dd>
          </div>
          <div><dt>存储占用</dt><dd>{formatBytes(snapshot?.usedBytes ?? null)}</dd></div>
          <div><dt>账户角色</dt><dd>{snapshot?.role === "admin" ? "管理员" : "会员"}</dd></div>
        </dl>
      </section>
    </div>
  );
}
