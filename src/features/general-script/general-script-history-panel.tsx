"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock3, FileText, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { AppScopedLink as Link } from "@/components/app-scoped-link";
import type { GeneralScriptRequest, GeneralScriptResult } from "@/lib/short-drama/general-script-contract";
import type { GeneralScriptHistoryItem } from "@/lib/short-drama/general-script-history";
import styles from "./general-script-history-panel.module.css";

interface HistoryPayload {
  ok?: boolean;
  historyReady?: boolean;
  error?: string;
  code?: string;
  unavailableReason?: string;
  items?: GeneralScriptHistoryItem[];
  total?: number;
}

const ACTIVE_STATES = new Set<GeneralScriptHistoryItem["state"]>(["queued", "running"]);

const STATE_LABELS: Record<GeneralScriptHistoryItem["state"], string> = {
  queued: "已提交",
  running: "生成中",
  succeeded: "已完成",
  failed: "未完成",
  reconciliation_required: "待核对",
};

function formatTime(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}

async function readPayload(response: Response): Promise<HistoryPayload> {
  const text = await response.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text) as HistoryPayload; } catch { return { error: text.slice(0, 160) }; }
}

export function GeneralScriptHistoryPanel({
  token,
  surface,
  endpoint = "/api/short-drama/script",
  refreshNonce = 0,
  onLoadRetry,
  onLoadResult,
}: {
  token: string;
  surface: "general" | "formal" | "youcai";
  endpoint?: "/api/general-script" | "/api/short-drama/script";
  refreshNonce?: number;
  onLoadRetry: (request: GeneralScriptRequest, clientRequestId: string) => void;
  onLoadResult: (result: GeneralScriptResult, clientRequestId: string) => void;
}) {
  const [items, setItems] = useState<GeneralScriptHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [historyNotice, setHistoryNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionLoadingId, setActionLoadingId] = useState("");

  const refresh = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(`${endpoint}?surface=${encodeURIComponent(surface)}&limit=20&offset=0`, {
        method: "GET",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      const payload = await readPayload(response);
      if (response.ok && payload.ok === true && payload.historyReady === false) {
        setItems([]);
        setTotal(0);
        setError("");
        setHistoryNotice(payload.unavailableReason || "账号历史正在准备中，当前编辑与未提交内容不会被保存。");
        return;
      }
      if (!response.ok || payload.ok !== true || !Array.isArray(payload.items)) {
        throw new Error(payload.error || "剧本历史暂时无法读取");
      }
      setItems(payload.items);
      setTotal(Number(payload.total || payload.items.length));
      setError("");
      setHistoryNotice("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "剧本历史暂时不可用");
      setHistoryNotice("");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [endpoint, surface, token]);

  const loadDetail = useCallback(async (
    item: GeneralScriptHistoryItem,
    action: "retry" | "result",
  ) => {
    setActionLoadingId(item.id);
    setActionError("");
    try {
      const response = await fetch(`${endpoint}?surface=${encodeURIComponent(surface)}&id=${encodeURIComponent(item.id)}&limit=1&offset=0`, {
        method: "GET",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      const payload = await readPayload(response);
      const detail = Array.isArray(payload.items) ? payload.items[0] : undefined;
      if (!response.ok || payload.ok !== true || !detail || detail.id !== item.id) {
        throw new Error(payload.error || "无法读取这条剧本任务详情");
      }
      if (action === "retry") {
        if (!detail.retrySafe || !detail.requestSnapshot) throw new Error("该任务当前不满足安全重试条件");
        onLoadRetry(detail.requestSnapshot, detail.clientRequestId);
      } else {
        if (detail.state !== "succeeded" || !detail.result) throw new Error("该任务尚无可载入的完成结果");
        onLoadResult(detail.result, detail.clientRequestId);
      }
    } catch (detailError) {
      setActionError(detailError instanceof Error ? detailError.message : "剧本任务详情暂时不可用");
    } finally {
      setActionLoadingId("");
    }
  }, [endpoint, onLoadResult, onLoadRetry, surface, token]);

  useEffect(() => { void refresh(false); }, [refresh, refreshNonce]);

  useEffect(() => {
    if (!items.some((item) => ACTIVE_STATES.has(item.state))) return;
    const timer = window.setInterval(() => { void refresh(true); }, 15_000);
    return () => window.clearInterval(timer);
  }, [items, refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const onFocus = () => { void refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return (
    <section className={styles.panel} aria-label="账号剧本任务历史" data-testid="general-script-server-history">
      <header className={styles.header}>
        <div>
          <h2><Clock3 size={19} /> 剧本任务历史</h2>
          <p>已提交任务保存在账号历史中。刷新页面后仍可查看状态与结果。</p>
        </div>
        <button type="button" onClick={() => void refresh(true)} disabled={refreshing} aria-label="刷新剧本历史">
          <RefreshCw size={16} className={refreshing ? styles.spin : undefined} /> 刷新
        </button>
      </header>

      {loading && <p className={styles.notice}><Loader2 className={styles.spin} size={16} /> 正在读取账号历史…</p>}
      {!loading && error && <p className={styles.error} role="alert"><AlertTriangle size={16} /> {error}</p>}
      {!loading && !error && historyNotice && <p className={styles.notice} role="status"><AlertTriangle size={16} /> {historyNotice}</p>}
      {actionError && <p className={styles.error} role="alert"><AlertTriangle size={16} /> {actionError}</p>}
      {!loading && !error && !historyNotice && items.length === 0 && (
        <p className={styles.notice}>暂无已提交的剧本任务。未提交输入不会在下次进入时恢复。</p>
      )}
      {!loading && !error && items.length > 0 && (
        <div className={styles.list}>
          {items.map((item) => (
            <article className={styles.item} key={item.id} data-state={item.state}>
              <div className={styles.itemTop}>
                <div>
                  <strong><FileText size={15} /> {item.title}</strong>
                  <span>{formatTime(item.submittedAt)} · {item.clientRequestId.slice(0, 28)}</span>
                </div>
                <em>{STATE_LABELS[item.state]}</em>
              </div>
              {item.state === "running" && <p>服务端仍在处理；本页会每 15 秒刷新状态。</p>}
              {item.state === "queued" && <p>请求已持久化，正在等待服务端生成状态。</p>}
              {item.errorMessage && <p className={styles.itemError}>{item.errorMessage}</p>}
              {item.state === "succeeded" && item.hasResult && (
                <div className={styles.actions}>
                  <span>{item.episodeCount ? `${item.episodeCount} 集` : "已生成"} · 账务已结算{item.creditsCharged === null ? "" : ` ${item.creditsCharged} 积分`}</span>
                  {item.projectHref ? (
                    <Link href={item.projectHref}>进入已保存项目</Link>
                  ) : (
                    <button type="button" disabled={actionLoadingId === item.id} onClick={() => void loadDetail(item, "result")}>
                      {actionLoadingId === item.id ? <Loader2 className={styles.spin} size={15} /> : null} 载入结果并保存项目
                    </button>
                  )}
                </div>
              )}
              {item.state === "failed" && item.retrySafe && (
                <div className={styles.actions}>
                  <span>{item.billingState === "refunded" ? "已全额退款" : "未扣费"}；载入后仍需你确认并手动提交。</span>
                  <button type="button" disabled={actionLoadingId === item.id} onClick={() => void loadDetail(item, "retry")}>
                    {actionLoadingId === item.id ? <Loader2 className={styles.spin} size={15} /> : <RotateCcw size={15} />} 载入原参数
                  </button>
                </div>
              )}
              {item.state === "reconciliation_required" && (
                <p className={styles.hold}>执行或账务终态尚未确认，系统不会自动重调模型。</p>
              )}
            </article>
          ))}
        </div>
      )}
      {!loading && !error && total > items.length && (
        <p className={styles.more}>当前显示最近 {items.length} 条，共 {total} 条。</p>
      )}
    </section>
  );
}
