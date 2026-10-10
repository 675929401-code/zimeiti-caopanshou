"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Check, ChevronLeft, ChevronRight, Gift, WalletCards, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/contexts/app-context";
import {
  APP_DIALOG_CLAIMED_EVENT,
  APP_DIALOG_RELEASED_EVENT,
  APP_TOAST_CLAIMED_EVENT,
  APP_TOAST_PRIORITY,
  APP_TOAST_RELEASED_EVENT,
  claimAppDialog,
  claimAppToast,
  currentAppDialogOwner,
  currentAppToastOwner,
  releaseAppDialog,
  releaseAppToast,
} from "@/lib/client-dialog-queue";

const POLL_INTERVAL_MS = 15_000;
const CHANNEL_NAME = "account-notifications-v1";
const DELIVERY_SESSION_KEY = "account_notification_delivery_session_v1";
const RECENT_PAGE_SIZE = 50;
const BACKLOG_PAGE_SIZE = 100;
const MAX_BACKLOG_PAGES = 100;
const MAX_BACKLOG_SYNC_ROUNDS = 3;

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

type AccountNotificationPage = {
  notifications: AccountNotification[];
  unreadCount: number;
  hasMore: boolean;
  nextCursor: string | null;
};

function sortNotifications(left: AccountNotification, right: AccountNotification) {
  const timeDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
  return timeDifference || right.id.localeCompare(left.id);
}

function mergeNotifications(...groups: AccountNotification[][]) {
  const byId = new Map<string, AccountNotification>();
  for (const group of groups) {
    for (const notification of group) byId.set(notification.id, notification);
  }
  return [...byId.values()].sort(sortNotifications);
}

function fingerprintToken(token: string) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readDeliverySession(sessionIdentity: string) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DELIVERY_SESSION_KEY) || "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { initialized: false, knownIds: new Set<string>() };
    const state = parsed as { sessionIdentity?: unknown; knownIds?: unknown };
    if (state.sessionIdentity !== sessionIdentity || !Array.isArray(state.knownIds)) {
      return { initialized: false, knownIds: new Set<string>() };
    }
    return {
      initialized: true,
      knownIds: new Set(state.knownIds.filter((value): value is string => typeof value === "string")),
    };
  } catch {
    return { initialized: false, knownIds: new Set<string>() };
  }
}

function writeDeliverySession(sessionIdentity: string, knownIds: Set<string>) {
  try {
    sessionStorage.setItem(DELIVERY_SESSION_KEY, JSON.stringify({
      sessionIdentity,
      knownIds: [...knownIds].slice(0, 500),
    }));
  } catch {
    // The server read state remains authoritative when session storage is unavailable.
  }
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
  const sessionIdentity = authenticated ? `${userId}:${fingerprintToken(token)}` : "";

  const [items, setItems] = useState<AccountNotification[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toastId, setToastId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, refreshDialogQueueState] = useState(0);
  const [, refreshToastQueueState] = useState(0);

  const itemsRef = useRef<AccountNotification[]>([]);
  const dialogOpenRef = useRef(false);
  const deferredDialogRef = useRef(false);
  const initializedRef = useRef(false);
  const knownIdsRef = useRef(new Set<string>());
  const toastIdRef = useRef<string | null>(null);
  const previousSessionIdentityRef = useRef("");
  const requestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { dialogOpenRef.current = dialogOpen; }, [dialogOpen]);
  useEffect(() => { toastIdRef.current = toastId; }, [toastId]);

  const queueToast = useCallback((notificationId: string | null) => {
    toastIdRef.current = notificationId;
    setToastId(notificationId);
    if (notificationId) claimAppToast("account", APP_TOAST_PRIORITY.account);
    else releaseAppToast("account");
  }, []);

  const openDialog = useCallback((notificationId?: string | null) => {
    setError("");
    if (notificationId) setSelectedId(notificationId);
    if (!claimAppDialog("account")) {
      deferredDialogRef.current = true;
      return false;
    }
    deferredDialogRef.current = false;
    dialogOpenRef.current = true;
    setDialogOpen(true);
    queueToast(null);
    return true;
  }, [queueToast]);

  const closeDialog = useCallback(() => {
    const unread = itemsRef.current.find((item) => !item.is_read) || null;
    dialogOpenRef.current = false;
    setDialogOpen(false);
    releaseAppDialog("account");
    const current = toastIdRef.current;
    queueToast(current && itemsRef.current.some((item) => item.id === current && !item.is_read)
      ? current
      : unread?.id || null);
  }, [queueToast]);

  const headers = useMemo<Record<string, string>>(
    () => token ? { Authorization: `Bearer ${token}` } : {} as Record<string, string>,
    [token],
  );

  const fetchPage = useCallback(async ({
    cursor = null,
    unreadOnly = false,
    limit,
    signal,
  }: {
    cursor?: string | null;
    unreadOnly?: boolean;
    limit: number;
    signal: AbortSignal;
  }): Promise<AccountNotificationPage> => {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor) search.set("cursor", cursor);
    if (unreadOnly) search.set("unreadOnly", "true");
    const response = await fetch(`/api/notifications/user?${search.toString()}`, {
      headers,
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(await responseMessage(response, "账号消息暂时无法读取"));
    const payload = await response.json() as Record<string, unknown>;
    const notifications = Array.isArray(payload.notifications)
      ? payload.notifications as AccountNotification[]
      : null;
    const unreadCount = Number(payload.unreadCount);
    const hasMore = payload.hasMore === true;
    const nextCursor = typeof payload.nextCursor === "string" && payload.nextCursor
      ? payload.nextCursor
      : null;
    if (!notifications
      || !Number.isSafeInteger(unreadCount)
      || unreadCount < 0
      || (hasMore && !nextCursor)) {
      throw new Error("账号消息分页响应无效");
    }
    return { notifications, unreadCount, hasMore, nextCursor };
  }, [headers]);

  const fetchAllUnread = useCallback(async (signal: AbortSignal) => {
    for (let round = 0; round < MAX_BACKLOG_SYNC_ROUNDS; round += 1) {
      const unreadById = new Map<string, AccountNotification>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let observedUnreadCount = 0;
      let completed = false;
      for (let pageNumber = 0; pageNumber < MAX_BACKLOG_PAGES; pageNumber += 1) {
        const page = await fetchPage({ cursor, unreadOnly: true, limit: BACKLOG_PAGE_SIZE, signal });
        observedUnreadCount = page.unreadCount;
        for (const notification of page.notifications) {
          if (!notification.is_read) unreadById.set(notification.id, notification);
        }
        if (!page.hasMore) {
          completed = true;
          break;
        }
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
          throw new Error("账号消息分页游标未前进");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      if (!completed) throw new Error("未读消息过多，请稍后重试");
      if (unreadById.size === observedUnreadCount) {
        return {
          notifications: [...unreadById.values()].sort(sortNotifications),
          unreadCount: observedUnreadCount,
        };
      }
    }
    throw new Error("账号消息正在更新，请稍后重试");
  }, [fetchPage]);

  const load = useCallback(async () => {
    if (!authenticated) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const sequence = ++requestRef.current;
    if (itemsRef.current.length === 0) setLoading(true);
    try {
      const recentPage = await fetchPage({ limit: RECENT_PAGE_SIZE, signal: controller.signal });
      if (sequence !== requestRef.current) return;
      setLoadError("");
      const recent = recentPage.notifications;
      const optimistic = mergeNotifications(
        itemsRef.current.filter((item) => !item.is_read),
        recent,
      );
      let unread = optimistic.filter((item) => !item.is_read);
      let authoritativeUnreadCount = recentPage.unreadCount;
      if (unread.length !== authoritativeUnreadCount) {
        const backlog = await fetchAllUnread(controller.signal);
        if (sequence !== requestRef.current) return;
        unread = backlog.notifications;
        authoritativeUnreadCount = backlog.unreadCount;
      }
      const next = mergeNotifications(
        recent.filter((item) => item.is_read),
        unread,
      );
      if (next.filter((item) => !item.is_read).length !== authoritativeUnreadCount) {
        throw new Error("未读消息数量校验失败，请重试");
      }
      const unreadItems = next.filter((item) => !item.is_read);
      const backlogLoad = !initializedRef.current;
      const newlyArrived = backlogLoad
        ? null
        : recent.find((item) => !item.is_read && !knownIdsRef.current.has(item.id)) || null;

      initializedRef.current = true;
      knownIdsRef.current = new Set(next.map((item) => item.id));
      writeDeliverySession(sessionIdentity, knownIdsRef.current);
      itemsRef.current = next;
      setItems(next);
      if (backlogLoad && unreadItems.length > 0) {
        openDialog(unreadItems[0].id);
      } else if (newlyArrived) {
        queueToast(newlyArrived.id);
      } else if (!dialogOpenRef.current && unreadItems.length > 0 && !toastIdRef.current) {
        queueToast(unreadItems[0].id);
      } else if (unreadItems.length === 0) {
        queueToast(null);
      }
    } catch (loadFailure) {
      if (sequence === requestRef.current && !(loadFailure instanceof DOMException && loadFailure.name === "AbortError")) {
        setLoadError(loadFailure instanceof Error ? loadFailure.message : "账号消息暂时无法读取");
      }
    } finally {
      if (sequence === requestRef.current) {
        if (loadAbortRef.current === controller) loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [authenticated, fetchAllUnread, fetchPage, openDialog, queueToast, sessionIdentity]);

  useEffect(() => {
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    requestRef.current += 1;
    const previousSessionIdentity = previousSessionIdentityRef.current;
    if (!sessionIdentity && previousSessionIdentity) {
      try { sessionStorage.removeItem(DELIVERY_SESSION_KEY); } catch { /* no-op */ }
    }
    previousSessionIdentityRef.current = sessionIdentity;
    const deliverySession = sessionIdentity
      ? readDeliverySession(sessionIdentity)
      : { initialized: false, knownIds: new Set<string>() };
    initializedRef.current = deliverySession.initialized;
    knownIdsRef.current = deliverySession.knownIds;
    itemsRef.current = [];
    setItems([]);
    dialogOpenRef.current = false;
    deferredDialogRef.current = false;
    setDialogOpen(false);
    releaseAppDialog("account");
    setSelectedId(null);
    queueToast(null);
    setError("");
    setLoadError("");
    setLoading(false);
  }, [queueToast, sessionIdentity]);

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
    const onToastClaimed = () => refreshToastQueueState((revision) => revision + 1);
    const onToastReleased = () => {
      refreshToastQueueState((revision) => revision + 1);
      if (toastIdRef.current && !dialogOpenRef.current && !currentAppDialogOwner()) {
        claimAppToast("account", APP_TOAST_PRIORITY.account);
      }
    };
    window.addEventListener(APP_TOAST_CLAIMED_EVENT, onToastClaimed);
    window.addEventListener(APP_TOAST_RELEASED_EVENT, onToastReleased);
    return () => {
      window.removeEventListener(APP_TOAST_CLAIMED_EVENT, onToastClaimed);
      window.removeEventListener(APP_TOAST_RELEASED_EVENT, onToastReleased);
      releaseAppToast("account");
    };
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
      const receipt = await response.json().catch(() => null) as {
        success?: unknown;
        status?: unknown;
        notificationId?: unknown;
        readAt?: unknown;
        error?: unknown;
      } | null;
      const readAt = typeof receipt?.readAt === "string" && Number.isFinite(Date.parse(receipt.readAt))
        ? receipt.readAt
        : "";
      if (!response.ok
        || receipt?.success !== true
        || receipt.status !== "read"
        || receipt.notificationId !== notification.id
        || !readAt) {
        throw new Error(typeof receipt?.error === "string" && receipt.error ? receipt.error : "已读状态保存失败");
      }
      loadAbortRef.current?.abort();
      requestRef.current += 1;
      const next = itemsRef.current.map((item) => item.id === notification.id
        ? { ...item, is_read: true, read_at: readAt }
        : item);
      itemsRef.current = next;
      setItems(next);
      const currentIndex = next.findIndex((item) => item.id === notification.id);
      const nextUnread = [
        ...next.slice(currentIndex + 1),
        ...next.slice(0, Math.max(0, currentIndex)),
      ].find((item) => !item.is_read) || null;
      if (dialogOpenRef.current) {
        if (nextUnread) setSelectedId(nextUnread.id);
        else closeDialog();
      } else if (toastId === notification.id) {
        queueToast(nextUnread?.id || null);
      }
      channelRef.current?.postMessage({ type: "read", id: notification.id });
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : "已读状态保存失败");
    } finally {
      setSaving(false);
    }
  }, [closeDialog, headers, queueToast, saving, toastId]);

  const selectOffset = (offset: number) => {
    const next = items[selectedIndex + offset];
    if (next) setSelectedId(next.id);
  };

  if (!authenticated) return null;

  return (
    <>
      {toastItem && !dialogOpen && !currentAppDialogOwner() && currentAppToastOwner() === "account" && (
        <aside
          data-testid="account-notification-toast"
          data-platform-popup="account-toast"
          role="status"
          aria-live="polite"
          className="announcement-toast fixed bottom-7 right-7 z-[120] flex w-[344px] flex-col overflow-hidden rounded-[18px] border"
        >
          <div className="announcement-toast-head flex items-start gap-3 px-4 pb-3 pt-4">
            <span className="announcement-priority grid h-10 w-10 shrink-0 place-items-center rounded-[12px] border shadow-sm"><Gift className="h-[18px] w-[18px]" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-extrabold tracking-[0.16em] text-[var(--primary)]">新消息已送达</p>
              <h2 className="mt-1 line-clamp-2 text-[15px] font-extrabold leading-[1.45] tracking-[-0.01em]">{toastItem.title}</h2>
            </div>
          </div>
          <p className="announcement-toast-body line-clamp-2 px-4 py-3 text-[13px] font-medium leading-[1.65] text-[var(--secondary-foreground)]">{toastItem.content}</p>
          {error && <p role="alert" className="announcement-toast-body border-t border-rose-500/20 px-4 py-2 text-xs font-semibold text-rose-400">{error}</p>}
          <div className="announcement-toast-actions flex items-center justify-end gap-2 px-4 py-3">
            <button type="button" onClick={() => openDialog(toastItem.id)} className="h-8 rounded-[9px] border border-[var(--border)] px-3 text-xs font-bold transition hover:bg-[var(--muted)]">详情</button>
            <button type="button" onClick={() => void markRead(toastItem)} disabled={saving} className="h-8 rounded-[9px] bg-[var(--primary)] px-3.5 text-xs font-bold text-[var(--primary-foreground)] shadow-sm transition hover:brightness-105 disabled:cursor-wait disabled:opacity-60">{saving ? "保存中..." : "知道了"}</button>
          </div>
        </aside>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent data-testid="account-notification-dialog" data-platform-popup="account-reader" showCloseButton={false} className="account-notification-reader grid max-h-[min(640px,calc(100vh-96px))] w-[min(620px,calc(100vw-80px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--card)] p-0">
          <header className="platform-message-header flex items-center gap-3.5 border-b border-[var(--border)] px-6 py-4">
            <span className="announcement-priority grid h-11 w-11 place-items-center rounded-[13px] border shadow-sm"><BellRing className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-[19px] font-black tracking-[-0.02em] text-[var(--foreground)]">账号消息</DialogTitle>
                {unreadCount > 0 && <span className="rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-bold text-white">{unreadCount} 条未读</span>}
              </div>
              <DialogDescription className="mt-1 text-xs text-[var(--muted-foreground)]">离线期间的礼包与系统通知会在登录后优先展示。</DialogDescription>
            </div>
            <button type="button" onClick={closeDialog} className="grid h-9 w-9 place-items-center rounded-[11px] border border-[var(--border)] bg-[var(--muted)]/45 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" aria-label="关闭账号消息"><X className="h-4 w-4" /></button>
          </header>

          <div className="platform-message-body min-h-0 overflow-y-auto overscroll-contain px-6 py-5">
            {loadError && (
              <div role="alert" data-testid="account-notification-inbox-error" className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3 text-sm text-rose-500">
                <span>{loadError}</span>
                <button type="button" onClick={() => void load()} disabled={loading} className="shrink-0 rounded-lg border border-current/30 px-3 py-1.5 text-xs font-bold hover:bg-rose-500/10 disabled:opacity-50">{loading ? "重试中..." : "重新读取"}</button>
              </div>
            )}
            {selected ? (
              <article className="platform-message-panel rounded-[16px] border border-[var(--border)] p-5">
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted-foreground)]">
                  <span className="inline-flex items-center gap-1.5 font-bold text-[var(--primary)]"><WalletCards className="h-4 w-4" />{selected.type.startsWith("wallet_") ? "资产到账" : "账号通知"}</span>
                  <span>{formatBeijing(selected.created_at)}</span>
                </div>
                <h2 className="mt-4 text-[22px] font-black leading-tight tracking-[-0.02em] text-[var(--foreground)]">{selected.title}</h2>
                <p className="mt-3 whitespace-pre-wrap break-words text-[14px] font-medium leading-7 text-[var(--secondary-foreground)]">{selected.content}</p>
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

          <footer className="platform-message-footer flex items-center gap-2 border-t border-[var(--border)] px-6 py-3.5">
            <button type="button" onClick={() => { closeDialog(); router.push("/profile?tab=notifications"); }} className="mr-auto h-9 rounded-lg border border-[var(--border)] px-3 text-xs font-bold text-[var(--foreground)] hover:bg-[var(--muted)]">去个人中心查看</button>
            <button type="button" onClick={() => selectOffset(1)} disabled={selectedIndex < 0 || selectedIndex >= items.length - 1} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] disabled:opacity-30" aria-label="上一条"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => selectOffset(-1)} disabled={selectedIndex <= 0} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] disabled:opacity-30" aria-label="下一条"><ChevronRight className="h-4 w-4" /></button>
            {selected && !selected.is_read && <button type="button" onClick={() => void markRead(selected)} disabled={saving} className="h-9 rounded-lg bg-[var(--primary)] px-4 text-xs font-bold text-[var(--primary-foreground)] disabled:opacity-60">{saving ? "保存中..." : "知道了"}</button>}
          </footer>
        </DialogContent>
      </Dialog>
    </>
  );
}
