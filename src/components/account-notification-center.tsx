"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Check, ChevronLeft, ChevronRight, Gift, WalletCards, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/contexts/app-context";
import {
  APP_DIALOG_CLAIMED_EVENT,
  APP_DIALOG_RELEASED_EVENT,
  claimAppDialog,
  currentAppDialogOwner,
  releaseAppDialog,
} from "@/lib/client-dialog-queue";

const POLL_INTERVAL_MS = 15_000;
const CHANNEL_NAME = "account-notifications-v1";

type AccountNotification = {
  id: string;
  type: string;
  title: string;
  content: string;
  has_cami_code: boolean;
  is_read: boolean;
  created_at: string;
  read_at: string | null;
  metadata?: Record<string, unknown>;
};

function fingerprintToken(token: string) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function formatBeijing(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

async function responseMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" && payload.error ? payload.error : fallback;
  } catch {
    return fallback;
  }
}

export function AccountNotificationCenter() {
  const router = useRouter();
  const { state } = useApp();
  const userId = state.auth.user?.id ? String(state.auth.user.id) : "";
  const token = state.auth.token || "";
  const authenticated = Boolean(state.auth.isAuthenticated && userId && token);
  const identity = authenticated ? `${userId}:${fingerprintToken(token)}` : "";

  const [items, setItems] = useState<AccountNotification[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toastId, setToastId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, refreshDialogQueueState] = useState(0);

  const itemsRef = useRef<AccountNotification[]>([]);
  const dialogOpenRef = useRef(false);
  const deferredDialogRef = useRef(false);
  const initializedRef = useRef(false);
  const knownIdsRef = useRef(new Set<string>());
  const requestRef = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { dialogOpenRef.current = dialogOpen; }, [dialogOpen]);

  const openDialog = useCallback((notificationId?: string | null) => {
    if (notificationId) setSelectedId(notificationId);
    if (!claimAppDialog("account")) {
      deferredDialogRef.current = true;
      return false;
    }
    deferredDialogRef.current = false;
    dialogOpenRef.current = true;
    setDialogOpen(true);
    setToastId(null);
    return true;
  }, []);

  const closeDialog = useCallback(() => {
    dialogOpenRef.current = false;
    setDialogOpen(false);
    releaseAppDialog("account");
  }, []);

  const headers = useMemo<Record<string, string>>(
    () => token ? { Authorization: `Bearer ${token}` } : {} as Record<string, string>,
    [token],
  );

  const load = useCallback(async () => {
    if (!authenticated) return;
    const sequence = ++requestRef.current;
    if (itemsRef.current.length === 0) setLoading(true);
    try {
      const response = await fetch("/api/notifications/user", { headers, cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response, "账号消息暂时无法读取"));
      const payload = await response.json();
      if (sequence !== requestRef.current) return;
      setLoadError("");
      const next = Array.isArray(payload.notifications) ? payload.notifications as AccountNotification[] : [];
      const unread = next.filter((item) => !item.is_read);
      const firstLoad = !initializedRef.current;
      const newlyArrived = firstLoad
        ? null
        : unread.find((item) => !knownIdsRef.current.has(item.id)) || null;

      initializedRef.current = true;
      knownIdsRef.current = new Set(next.map((item) => item.id));
      itemsRef.current = next;
      setItems(next);
      if (firstLoad && unread.length > 0) {
        openDialog(unread[0].id);
      } else if (newlyArrived) {
        window.dispatchEvent(new CustomEvent("notification-toast-claimed", { detail: "account" }));
        setToastId(newlyArrived.id);
      }
    } catch (loadFailure) {
      if (sequence === requestRef.current) {
        setLoadError(loadFailure instanceof Error ? loadFailure.message : "账号消息暂时无法读取");
      }
    } finally {
      if (sequence === requestRef.current) setLoading(false);
    }
  }, [authenticated, headers, openDialog]);

  useEffect(() => {
    requestRef.current += 1;
    initializedRef.current = false;
    knownIdsRef.current = new Set();
    itemsRef.current = [];
    setItems([]);
    dialogOpenRef.current = false;
    deferredDialogRef.current = false;
    setDialogOpen(false);
    releaseAppDialog("account");
    setSelectedId(null);
    setToastId(null);
    setError("");
    setLoadError("");
    setLoading(false);
  }, [identity]);

  useEffect(() => {
    if (!authenticated) return;
    void load();
    const poll = () => { if (document.visibilityState === "visible") void load(); };
    const onFocus = () => void load();
    const onVisibility = () => { if (document.visibilityState === "visible") void load(); };
    const onOpen = () => {
      const preferred = itemsRef.current.find((item) => !item.is_read) || itemsRef.current[0] || null;
      openDialog(preferred?.id || null);
      void load();
    };
    const onRefresh = () => void load();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("open-account-notifications", onOpen);
    window.addEventListener("refresh-account-notifications", onRefresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("open-account-notifications", onOpen);
      window.removeEventListener("refresh-account-notifications", onRefresh);
    };
  }, [authenticated, load, openDialog]);

  useEffect(() => {
    const onClaimed = (event: Event) => {
      refreshDialogQueueState((revision) => revision + 1);
      const owner = (event as CustomEvent<{ owner?: string }>).detail?.owner;
      if (owner === "account" || !dialogOpenRef.current) return;
      deferredDialogRef.current = itemsRef.current.some((item) => !item.is_read);
      dialogOpenRef.current = false;
      setDialogOpen(false);
    };
    const onReleased = () => {
      refreshDialogQueueState((revision) => revision + 1);
      if (!deferredDialogRef.current || currentAppDialogOwner()) return;
      const preferred = itemsRef.current.find((item) => !item.is_read);
      if (preferred) openDialog(preferred.id);
      else deferredDialogRef.current = false;
    };
    window.addEventListener(APP_DIALOG_CLAIMED_EVENT, onClaimed);
    window.addEventListener(APP_DIALOG_RELEASED_EVENT, onReleased);
    return () => {
      window.removeEventListener(APP_DIALOG_CLAIMED_EVENT, onClaimed);
      window.removeEventListener(APP_DIALOG_RELEASED_EVENT, onReleased);
      releaseAppDialog("account");
    };
  }, [openDialog]);

  useEffect(() => {
    const hideWhenAnotherSurfaceWins = (event: Event) => {
      if ((event as CustomEvent).detail !== "account") setToastId(null);
    };
    window.addEventListener("notification-toast-claimed", hideWhenAnotherSurfaceWins);
    return () => window.removeEventListener("notification-toast-claimed", hideWhenAnotherSurfaceWins);
  }, []);

  useEffect(() => {
    if (!authenticated || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = () => void load();
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [authenticated, load]);

  const unreadCount = useMemo(() => items.filter((item) => !item.is_read).length, [items]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("account-notification-unread", { detail: unreadCount }));
  }, [unreadCount]);
  useEffect(() => {
    const report = () => window.dispatchEvent(new CustomEvent("account-notification-unread", { detail: unreadCount }));
    window.addEventListener("request-account-notification-unread", report);
    return () => window.removeEventListener("request-account-notification-unread", report);
  }, [unreadCount]);

  const selected = items.find((item) => item.id === selectedId)
    || items.find((item) => !item.is_read)
    || items[0]
    || null;
  const selectedIndex = selected ? items.findIndex((item) => item.id === selected.id) : -1;
  const toastItem = items.find((item) => item.id === toastId && !item.is_read) || null;

  const markRead = useCallback(async (notification: AccountNotification) => {
    if (notification.is_read || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/notifications/user", {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId: notification.id }),
      });
      if (!response.ok) throw new Error("已读状态保存失败");
      setItems((current) => current.map((item) => item.id === notification.id
        ? { ...item, is_read: true, read_at: new Date().toISOString() }
        : item));
      if (toastId === notification.id) setToastId(null);
      channelRef.current?.postMessage({ type: "read", id: notification.id });
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : "已读状态保存失败");
    } finally {
      setSaving(false);
    }
  }, [headers, saving, toastId]);

  const selectOffset = (offset: number) => {
    const next = items[selectedIndex + offset];
    if (next) setSelectedId(next.id);
  };

  if (!authenticated) return null;

  return (
    <>
      {toastItem && !dialogOpen && !currentAppDialogOwner() && (
        <aside
          data-testid="account-notification-toast"
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-[120] flex min-h-[190px] w-[340px] flex-col overflow-hidden rounded-2xl border border-[var(--primary)]/25 bg-[color-mix(in_srgb,var(--card)_86%,transparent)] p-5 text-[var(--foreground)] shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--primary)]/12 text-[var(--primary)]"><Gift className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--primary)]">新消息已送达</p>
              <h2 className="mt-1 line-clamp-2 text-base font-black leading-6">{toastItem.title}</h2>
            </div>
            <button type="button" onClick={() => setToastId(null)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]" aria-label="稍后查看"><X className="h-4 w-4" /></button>
          </div>
          <p className="mt-3 line-clamp-3 text-sm leading-6 text-[var(--secondary-foreground)]">{toastItem.content}</p>
          <div className="mt-auto flex items-center justify-end gap-2 pt-4">
            <button type="button" onClick={() => openDialog(toastItem.id)} className="h-9 rounded-lg border border-[var(--border)] px-3 text-xs font-bold hover:bg-[var(--muted)]">查看详情</button>
            <button type="button" onClick={() => void markRead(toastItem)} disabled={saving} className="h-9 rounded-lg bg-[var(--primary)] px-3 text-xs font-bold text-[var(--primary-foreground)] disabled:opacity-60">知道了</button>
          </div>
        </aside>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent data-testid="account-notification-dialog" showCloseButton={false} className="w-[min(680px,calc(100vw-96px))] max-w-none overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] p-0 shadow-2xl">
          <header className="flex items-center gap-4 border-b border-[var(--border)] px-7 py-5">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--primary)]/12 text-[var(--primary)]"><BellRing className="h-6 w-6" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-xl font-black text-[var(--foreground)]">账号消息</DialogTitle>
                {unreadCount > 0 && <span className="rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-bold text-white">{unreadCount} 条未读</span>}
              </div>
              <DialogDescription className="mt-1 text-xs text-[var(--muted-foreground)]">离线期间的礼包与系统通知会在登录后优先展示。</DialogDescription>
            </div>
            <button type="button" onClick={closeDialog} className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]" aria-label="关闭账号消息"><X className="h-4 w-4" /></button>
          </header>

          <div className="min-h-[300px] px-7 py-6">
            {loadError && (
              <div role="alert" data-testid="account-notification-inbox-error" className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3 text-sm text-rose-500">
                <span>{loadError}</span>
                <button type="button" onClick={() => void load()} disabled={loading} className="shrink-0 rounded-lg border border-current/30 px-3 py-1.5 text-xs font-bold hover:bg-rose-500/10 disabled:opacity-50">{loading ? "重试中..." : "重新读取"}</button>
              </div>
            )}
            {selected ? (
              <article className="rounded-2xl border border-[var(--border)] bg-[var(--background)]/36 p-6">
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted-foreground)]">
                  <span className="inline-flex items-center gap-1.5 font-bold text-[var(--primary)]"><WalletCards className="h-4 w-4" />{selected.type.startsWith("wallet_") ? "资产到账" : "账号通知"}</span>
                  <span>{formatBeijing(selected.created_at)}</span>
                </div>
                <h2 className="mt-5 text-2xl font-black leading-tight text-[var(--foreground)]">{selected.title}</h2>
                <p className="mt-4 whitespace-pre-wrap text-[15px] leading-7 text-[var(--secondary-foreground)]">{selected.content}</p>
                {selected.has_cami_code && (
                  <div className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3">
                    <p className="font-mono text-sm font-bold tracking-[0.22em] text-amber-600">激活凭证：••••••••</p>
                    <p className="mt-2 text-xs leading-relaxed text-[var(--secondary-foreground)]">凭证已安全绑定当前账号，明文不会显示、复制或进入剪贴板。前往个人中心一键激活后，套餐与权限才会正式生效。</p>
                    <button
                      data-testid="notification-cami-redeem-link"
                      type="button"
                      onClick={() => { closeDialog(); router.push("/profile?tab=notifications"); }}
                      className="mt-3 h-9 rounded-lg bg-amber-500 px-4 text-xs font-black text-white hover:bg-amber-600"
                    >去个人中心一键激活</button>
                  </div>
                )}
                {selected.is_read && <p className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-500"><Check className="h-4 w-4" />已阅读</p>}
              </article>
            ) : !loadError ? (
              <div className="grid min-h-[300px] place-items-center text-sm text-[var(--muted-foreground)]">暂无账号消息</div>
            ) : null}
            {error && <p role="alert" className="mt-3 text-xs font-semibold text-rose-500">{error}</p>}
          </div>

          <footer className="flex items-center gap-2 border-t border-[var(--border)] px-7 py-4">
            <button type="button" onClick={() => { closeDialog(); router.push("/profile?tab=notifications"); }} className="mr-auto h-9 rounded-lg border border-[var(--border)] px-3 text-xs font-bold text-[var(--foreground)] hover:bg-[var(--muted)]">去个人中心查看</button>
            <button type="button" onClick={() => selectOffset(1)} disabled={selectedIndex < 0 || selectedIndex >= items.length - 1} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] disabled:opacity-30" aria-label="上一条"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => selectOffset(-1)} disabled={selectedIndex <= 0} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] disabled:opacity-30" aria-label="下一条"><ChevronRight className="h-4 w-4" /></button>
            {selected && !selected.is_read && <button type="button" onClick={() => void markRead(selected)} disabled={saving} className="h-9 rounded-lg bg-[var(--primary)] px-4 text-xs font-bold text-[var(--primary-foreground)] disabled:opacity-60">{saving ? "保存中..." : "标记已读"}</button>}
          </footer>
        </DialogContent>
      </Dialog>
    </>
  );
}
