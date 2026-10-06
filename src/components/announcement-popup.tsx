"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Info,
  Megaphone,
  Pin,
  ShieldAlert,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/contexts/app-context";
import type { AnnouncementEventType, AnnouncementRecord } from "@/lib/announcement-domain";
import {
  announcementAutoDisplayDecision,
  normalizeAnnouncementDisplayLedger,
  recordAnnouncementImpression,
  type AnnouncementDisplayLedger,
} from "@/lib/announcement-client-policy";
import {
  APP_DIALOG_CLAIMED_EVENT,
  APP_DIALOG_PRIORITY,
  APP_DIALOG_RELEASED_EVENT,
  claimAppDialog,
  currentAppDialogOwner,
  releaseAppDialog,
} from "@/lib/client-dialog-queue";

const INBOX_ENDPOINT = "/api/announcements/inbox";
const POLL_INTERVAL_MS = 15_000;
const BROADCAST_CHANNEL = "announcement-inbox-v1";
const SESSION_DISMISSALS_KEY = "announcement_session_dismissals_v3";
const DISPLAY_LEDGER_KEY = "announcement_display_ledger_v1";

interface AnnouncementInboxItem extends AnnouncementRecord {
  revision?: number;
  pushRevision?: number;
  read_at?: string | null;
  readAt?: string | null;
  is_read?: boolean;
  isRead?: boolean;
  receipt?: {
    revision?: number;
    push_revision?: number;
    pushRevision?: number;
    read_at?: string | null;
    readAt?: string | null;
  } | null;
  delivery?: {
    revision?: number;
    push_revision?: number;
    pushRevision?: number;
    read_at?: string | null;
    readAt?: string | null;
  } | null;
}

type InboxChannelMessage = {
  type: "read" | "dismissed" | "refresh";
  userId?: string;
  announcementId?: string;
  revision?: number;
  key?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractInboxItems(payload: unknown): AnnouncementInboxItem[] {
  if (!isRecord(payload)) return [];
  const candidate = Array.isArray(payload.announcements)
    ? payload.announcements
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.inbox)
        ? payload.inbox
        : [];
  return candidate.filter(isRecord) as unknown as AnnouncementInboxItem[];
}

function pushRevisionOf(announcement: AnnouncementInboxItem): number {
  const candidates = [
    announcement.revision,
    announcement.push_revision,
    announcement.pushRevision,
    announcement.receipt?.revision,
    announcement.receipt?.push_revision,
    announcement.receipt?.pushRevision,
    announcement.delivery?.revision,
    announcement.delivery?.push_revision,
    announcement.delivery?.pushRevision,
  ];
  const revision = candidates.find((value) => typeof value === "number" && Number.isFinite(value));
  return typeof revision === "number" ? Math.max(0, Math.trunc(revision)) : 1;
}

function readAtOf(announcement: AnnouncementInboxItem): string | null {
  if (announcement.is_read || announcement.isRead) return announcement.updated_at || announcement.created_at;
  const readAt = announcement.read_at
    || announcement.readAt
    || announcement.receipt?.read_at
    || announcement.receipt?.readAt
    || announcement.delivery?.read_at
    || announcement.delivery?.readAt;
  return typeof readAt === "string" && readAt ? readAt : null;
}

function isRead(announcement: AnnouncementInboxItem): boolean {
  return Boolean(readAtOf(announcement));
}

function deliveryKey(announcement: AnnouncementInboxItem): string {
  return `${announcement.id}:${pushRevisionOf(announcement)}`;
}

function fingerprintToken(token: string): string {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readSessionDismissals(identity: string): Set<string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_DISMISSALS_KEY) || "{}") as unknown;
    if (!isRecord(parsed) || parsed.identity !== identity || !Array.isArray(parsed.keys)) return new Set();
    return new Set(parsed.keys.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function writeSessionDismissals(identity: string, keys: Set<string>) {
  try {
    sessionStorage.setItem(SESSION_DISMISSALS_KEY, JSON.stringify({ identity, keys: [...keys] }));
  } catch {
    // Session storage is an optimization only. Server read state remains authoritative.
  }
}

function readDisplayLedger(identity: string): AnnouncementDisplayLedger {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISPLAY_LEDGER_KEY) || "{}") as unknown;
    if (!isRecord(parsed) || parsed.identity !== identity) return {};
    return normalizeAnnouncementDisplayLedger(parsed.records);
  } catch {
    return {};
  }
}

function writeDisplayLedger(identity: string, ledger: AnnouncementDisplayLedger) {
  try {
    const entries = Object.entries(ledger).slice(-500);
    localStorage.setItem(DISPLAY_LEDGER_KEY, JSON.stringify({ identity, records: Object.fromEntries(entries) }));
  } catch {
    // The server read receipt remains authoritative; local policy storage only
    // prevents repeated automatic interruptions in this browser.
  }
}

function announcementEventKey(
  announcement: AnnouncementInboxItem,
  event: AnnouncementEventType,
): string {
  return `announcement:${announcement.id}:r${pushRevisionOf(announcement)}:${event}:v1`;
}

function recordAnalytics(
  announcement: AnnouncementInboxItem,
  event: AnnouncementEventType,
  token: string,
) {
  if (!token) return;
  const revision = pushRevisionOf(announcement);
  void fetch("/api/announcements/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: announcement.id,
      event,
      pushRevision: revision,
      eventKey: announcementEventKey(announcement, event),
    }),
    keepalive: true,
  }).then((response) => {
    if (!response.ok) {
      console.warn(`[announcement-events] ${event} rejected with HTTP ${response.status}`);
    }
  }).catch((error) => {
    console.warn(`[announcement-events] ${event} request failed`, error);
  });
}

function formatDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as unknown;
    if (isRecord(body) && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Use the stable fallback when the response is not JSON.
  }
  return fallback;
}

const priorityUi = {
  normal: {
    label: "通知",
    icon: Info,
    className: "border-sky-400/30 bg-sky-500/8 text-sky-300",
    dot: "bg-sky-400",
  },
  important: {
    label: "重要",
    icon: AlertTriangle,
    className: "border-amber-400/35 bg-amber-500/10 text-amber-300",
    dot: "bg-amber-400",
  },
  urgent: {
    label: "紧急",
    icon: ShieldAlert,
    className: "border-rose-400/40 bg-rose-500/10 text-rose-300",
    dot: "bg-rose-400",
  },
} as const;

export function AnnouncementBell({ onClick, unread }: { onClick: () => void; unread: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-transparent transition-colors hover:border-[var(--border)] hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      aria-label={`平台通知${unread > 0 ? `，${unread}条未读` : ""}`}
      title="平台通知"
    >
      <Bell className="h-4 w-4 text-[var(--muted-foreground)]" />
      {unread > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

export function AnnouncementPopup() {
  const router = useRouter();
  const { state } = useApp();
  const userId = state.auth.user?.id ? String(state.auth.user.id) : "";
  const token = state.auth.token || "";
  const isAuthenticated = Boolean(state.auth.isAuthenticated && userId && token);
  const sessionIdentity = isAuthenticated ? `${userId}:${fingerprintToken(token)}` : "";

  const [announcements, setAnnouncements] = useState<AnnouncementInboxItem[]>([]);
  const [selectedAnnouncementId, setSelectedAnnouncementId] = useState<string | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [onlineToastKey, setOnlineToastKey] = useState<string | null>(null);
  const [, refreshDialogQueueState] = useState(0);
  const [loading, setLoading] = useState(false);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [loadError, setLoadError] = useState("");

  const announcementsRef = useRef<AnnouncementInboxItem[]>([]);
  const readerOpenRef = useRef(false);
  const deferredReaderRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const dismissalsRef = useRef(new Set<string>());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const requestSequenceRef = useRef(0);
  const cursorRef = useRef("");
  const previousSessionIdentityRef = useRef("");
  const initializedRef = useRef(false);
  const knownDeliveryKeysRef = useRef(new Set<string>());
  const automaticImpressionsRef = useRef(new Set<string>());

  useEffect(() => { announcementsRef.current = announcements; }, [announcements]);
  useEffect(() => { readerOpenRef.current = readerOpen; }, [readerOpen]);

  const eligibleForAutomaticDisplay = useCallback((announcement: AnnouncementInboxItem) => {
    if (!sessionIdentity) return false;
    return announcementAutoDisplayDecision(
      announcement,
      readDisplayLedger(sessionIdentity),
    ).eligible;
  }, [sessionIdentity]);

  const recordAutomaticDisplay = useCallback((announcement: AnnouncementInboxItem) => {
    if (!sessionIdentity) return;
    const key = deliveryKey(announcement);
    if (automaticImpressionsRef.current.has(key)) return;
    automaticImpressionsRef.current.add(key);
    const next = recordAnnouncementImpression(announcement, readDisplayLedger(sessionIdentity));
    writeDisplayLedger(sessionIdentity, next);
    recordAnalytics(announcement, "impression", token);
  }, [sessionIdentity, token]);

  const openReader = useCallback((
    announcementId?: string | null,
    options: { automatic?: boolean } = {},
  ) => {
    if (announcementId) {
      selectedIdRef.current = announcementId;
      setSelectedAnnouncementId(announcementId);
    }
    const selected = announcementsRef.current.find((announcement) => (
      announcement.id === (announcementId || selectedIdRef.current)
    ));
    const priority = selected?.priority === "urgent"
      ? APP_DIALOG_PRIORITY.announcementUrgent
      : APP_DIALOG_PRIORITY.announcement;
    if (!claimAppDialog("announcement", priority)) {
      deferredReaderRef.current = true;
      return false;
    }
    deferredReaderRef.current = false;
    readerOpenRef.current = true;
    setReaderOpen(true);
    setOnlineToastKey(null);
    if (options.automatic && selected) recordAutomaticDisplay(selected);
    return true;
  }, [recordAutomaticDisplay]);
  useEffect(() => { selectedIdRef.current = selectedAnnouncementId; }, [selectedAnnouncementId]);

  const authHeaders = useMemo(
    (): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {},
    [token],
  );

  const rememberDismissed = useCallback((key: string, broadcast = true) => {
    if (!sessionIdentity || !key) return;
    dismissalsRef.current.add(key);
    writeSessionDismissals(sessionIdentity, dismissalsRef.current);
    if (broadcast) {
      channelRef.current?.postMessage({ type: "dismissed", userId, key } satisfies InboxChannelMessage);
    }
  }, [sessionIdentity, userId]);

  const applyReadLocally = useCallback((announcementId: string, revision: number, readAt: string) => {
    setAnnouncements((current) => current.map((announcement) => (
      announcement.id === announcementId && pushRevisionOf(announcement) === revision
        ? { ...announcement, read_at: readAt, readAt, is_read: true, isRead: true }
        : announcement
    )));
  }, []);

  const fetchInbox = useCallback(async (allowAutoOpen = true) => {
    if (!isAuthenticated) return;
    const requestSequence = ++requestSequenceRef.current;
    setLoading((current) => current || announcementsRef.current.length === 0);

    try {
      const endpoint = cursorRef.current
        ? `${INBOX_ENDPOINT}?cursor=${encodeURIComponent(cursorRef.current)}`
        : INBOX_ENDPOINT;
      const response = await fetch(endpoint, {
        headers: authHeaders,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await responseMessage(response, "公告收件箱暂时不可用"));
      const payload = await response.json() as unknown;
      if (requestSequence !== requestSequenceRef.current) return;
      setLoadError("");
      if (isRecord(payload) && typeof payload.cursor === "string") cursorRef.current = payload.cursor;
      if (isRecord(payload) && payload.unchanged === true) return;

      const items = extractInboxItems(payload);
      const firstLoad = !initializedRef.current;
      const newlyPushed = firstLoad
        ? null
        : items.find((announcement) => (
          !isRead(announcement)
          && !knownDeliveryKeysRef.current.has(deliveryKey(announcement))
          && !dismissalsRef.current.has(deliveryKey(announcement))
          && eligibleForAutomaticDisplay(announcement)
        )) || null;
      initializedRef.current = true;
      knownDeliveryKeysRef.current = new Set(items.map(deliveryKey));
      announcementsRef.current = items;
      setAnnouncements(items);

      const selectedStillExists = selectedIdRef.current
        && items.some((announcement) => announcement.id === selectedIdRef.current);
      if (!selectedStillExists) {
        const preferred = items.find((announcement) => !isRead(announcement)) || items[0] || null;
        selectedIdRef.current = preferred?.id || null;
        setSelectedAnnouncementId(preferred?.id || null);
      }

      if (allowAutoOpen && firstLoad && !readerOpenRef.current) {
        const candidate = items.find((announcement) => (
          !isRead(announcement)
          && !dismissalsRef.current.has(deliveryKey(announcement))
          && eligibleForAutomaticDisplay(announcement)
        ));
        if (candidate) {
          openReader(candidate.id, { automatic: true });
        }
      } else if (allowAutoOpen && newlyPushed && !readerOpenRef.current) {
        window.dispatchEvent(new CustomEvent("notification-toast-claimed", { detail: "announcement" }));
        setOnlineToastKey(deliveryKey(newlyPushed));
      }
    } catch (error) {
      console.warn("[announcement-inbox] fetch failed:", error);
      if (requestSequence === requestSequenceRef.current) {
        setLoadError(error instanceof Error ? error.message : "公告收件箱暂时不可用");
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [authHeaders, eligibleForAutomaticDisplay, isAuthenticated, openReader]);

  useEffect(() => {
    const previousIdentity = previousSessionIdentityRef.current;
    previousSessionIdentityRef.current = sessionIdentity;
    if (previousIdentity && !sessionIdentity) {
      try {
        sessionStorage.removeItem(SESSION_DISMISSALS_KEY);
      } catch {
        // A fresh login still resets the in-memory dismissal set below.
      }
    }
    requestSequenceRef.current += 1;
    setActionError("");
    setLoadError("");
    setAnnouncements([]);
    announcementsRef.current = [];
    setSelectedAnnouncementId(null);
    selectedIdRef.current = null;
    deferredReaderRef.current = false;
    setReaderOpen(false);
    readerOpenRef.current = false;
    releaseAppDialog("announcement");
    setOnlineToastKey(null);
    initializedRef.current = false;
    knownDeliveryKeysRef.current = new Set();
    automaticImpressionsRef.current = new Set();
    cursorRef.current = "";
    dismissalsRef.current = sessionIdentity ? readSessionDismissals(sessionIdentity) : new Set();
  }, [sessionIdentity]);

  useEffect(() => {
    if (!isAuthenticated) return;

    void fetchInbox(true);
    const poll = () => {
      if (document.visibilityState === "visible") void fetchInbox(true);
    };
    const onFocus = () => void fetchInbox(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void fetchInbox(true);
    };
    const onRefresh = () => void fetchInbox(true);
    const onOpen = () => {
      const current = announcementsRef.current;
      const preferred = current.find((announcement) => !isRead(announcement)) || current[0] || null;
      if (preferred) {
        selectedIdRef.current = preferred.id;
        setSelectedAnnouncementId(preferred.id);
      }
      openReader(preferred?.id || null);
      void fetchInbox(false);
    };

    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("refresh-announcements", onRefresh);
    window.addEventListener("open-announcements", onOpen);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("refresh-announcements", onRefresh);
      window.removeEventListener("open-announcements", onOpen);
    };
  }, [fetchInbox, isAuthenticated, openReader]);

  useEffect(() => {
    const onClaimed = (event: Event) => {
      refreshDialogQueueState((revision) => revision + 1);
      const owner = (event as CustomEvent<{ owner?: string }>).detail?.owner;
      if (owner === "announcement" || !readerOpenRef.current) return;
      deferredReaderRef.current = announcementsRef.current.some((announcement) => !isRead(announcement));
      readerOpenRef.current = false;
      setReaderOpen(false);
    };
    const onReleased = () => {
      refreshDialogQueueState((revision) => revision + 1);
      if (!deferredReaderRef.current || currentAppDialogOwner()) return;
      const preferred = announcementsRef.current.find((announcement) => !isRead(announcement));
      if (preferred) openReader(preferred.id);
      else deferredReaderRef.current = false;
    };
    window.addEventListener(APP_DIALOG_CLAIMED_EVENT, onClaimed);
    window.addEventListener(APP_DIALOG_RELEASED_EVENT, onReleased);
    return () => {
      window.removeEventListener(APP_DIALOG_CLAIMED_EVENT, onClaimed);
      window.removeEventListener(APP_DIALOG_RELEASED_EVENT, onReleased);
      releaseAppDialog("announcement");
    };
  }, [openReader]);

  useEffect(() => {
    const hideWhenAnotherSurfaceWins = (event: Event) => {
      if ((event as CustomEvent).detail !== "announcement") setOnlineToastKey(null);
    };
    window.addEventListener("notification-toast-claimed", hideWhenAnotherSurfaceWins);
    return () => window.removeEventListener("notification-toast-claimed", hideWhenAnotherSurfaceWins);
  }, []);

  useEffect(() => {
    if (!isAuthenticated || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(BROADCAST_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<InboxChannelMessage>) => {
      const message = event.data;
      if (!message || (message.userId && message.userId !== userId)) return;
      if (message.type === "read" && message.announcementId && typeof message.revision === "number") {
        applyReadLocally(message.announcementId, message.revision, new Date().toISOString());
      } else if (message.type === "dismissed" && message.key) {
        rememberDismissed(message.key, false);
      } else if (message.type === "refresh") {
        void fetchInbox(true);
      }
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [applyReadLocally, fetchInbox, isAuthenticated, rememberDismissed, userId]);

  const unreadCount = useMemo(
    () => announcements.filter((announcement) => !isRead(announcement)).length,
    [announcements],
  );

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("announcement-unread", { detail: unreadCount }));
  }, [unreadCount]);

  useEffect(() => {
    const reportUnread = () => {
      window.dispatchEvent(new CustomEvent("announcement-unread", { detail: unreadCount }));
    };
    window.addEventListener("request-announcement-unread", reportUnread);
    return () => window.removeEventListener("request-announcement-unread", reportUnread);
  }, [unreadCount]);

  const selectedAnnouncement = announcements.find((announcement) => announcement.id === selectedAnnouncementId)
    || announcements.find((announcement) => !isRead(announcement))
    || announcements[0]
    || null;
  const selectedIndex = selectedAnnouncement
    ? announcements.findIndex((announcement) => announcement.id === selectedAnnouncement.id)
    : -1;
  const selectedUi = selectedAnnouncement ? priorityUi[selectedAnnouncement.priority] : priorityUi.normal;
  const SelectedIcon = selectedUi.icon;
  const onlineToastAnnouncement = announcements.find((announcement) => (
    onlineToastKey === deliveryKey(announcement) && !isRead(announcement)
  )) || null;

  useEffect(() => {
    if (!onlineToastAnnouncement || readerOpen || currentAppDialogOwner()) return;
    recordAutomaticDisplay(onlineToastAnnouncement);
  }, [onlineToastAnnouncement, readerOpen, recordAutomaticDisplay]);

  const markRead = useCallback(async (announcement: AnnouncementInboxItem) => {
    const revision = pushRevisionOf(announcement);
    const response = await fetch(`/api/announcements/${encodeURIComponent(announcement.id)}/read`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    });
    if (!response.ok) throw new Error(await responseMessage(response, "已阅读状态保存失败"));

    const readAt = new Date().toISOString();
    applyReadLocally(announcement.id, revision, readAt);
    recordAnalytics(announcement, "read", token);
    if (onlineToastKey === deliveryKey(announcement)) setOnlineToastKey(null);
    channelRef.current?.postMessage({
      type: "read",
      userId,
      announcementId: announcement.id,
      revision,
    } satisfies InboxChannelMessage);
  }, [applyReadLocally, authHeaders, onlineToastKey, token, userId]);

  const markSelectedRead = async () => {
    if (!selectedAnnouncement || isRead(selectedAnnouncement) || readingId) return;
    setActionError("");
    setReadingId(selectedAnnouncement.id);
    try {
      await markRead(selectedAnnouncement);
      const nextUnread = announcements.find((announcement) => (
        announcement.id !== selectedAnnouncement.id && !isRead(announcement)
      ));
      if (nextUnread) {
        selectedIdRef.current = nextUnread.id;
        setSelectedAnnouncementId(nextUnread.id);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "已阅读状态保存失败");
    } finally {
      setReadingId(null);
    }
  };

  const closeReader = useCallback(() => {
    const pendingAcknowledgement = announcementsRef.current.find((announcement) => (
      announcement.require_ack && !isRead(announcement)
    ));
    if (pendingAcknowledgement) {
      selectedIdRef.current = pendingAcknowledgement.id;
      setSelectedAnnouncementId(pendingAcknowledgement.id);
      setActionError("这条公告需要确认阅读后才能关闭");
      return false;
    }
    announcementsRef.current
      .filter((announcement) => !isRead(announcement))
      .forEach((announcement) => {
        rememberDismissed(deliveryKey(announcement));
        recordAnalytics(announcement, "close", token);
      });
    readerOpenRef.current = false;
    setReaderOpen(false);
    setActionError("");
    releaseAppDialog("announcement");
    return true;
  }, [rememberDismissed, token]);

  const selectIndex = (index: number) => {
    const next = announcements[index];
    if (!next) return;
    selectedIdRef.current = next.id;
    setSelectedAnnouncementId(next.id);
    setActionError("");
  };

  const openLinkedContent = () => {
    if (!selectedAnnouncement?.link_url) return;
    recordAnalytics(selectedAnnouncement, "click", token);
    if (!closeReader()) return;
    if (selectedAnnouncement.link_url.startsWith("/")) router.push(selectedAnnouncement.link_url);
    else window.open(selectedAnnouncement.link_url, "_blank", "noopener,noreferrer");
  };

  if (!isAuthenticated) return null;

  return (
    <>
      {onlineToastAnnouncement && !readerOpen && !currentAppDialogOwner() && (
        <aside
          data-testid="announcement-online-toast"
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-[118] flex min-h-[190px] w-[340px] flex-col overflow-hidden rounded-2xl border border-[var(--primary)]/25 bg-[color-mix(in_srgb,var(--card)_86%,transparent)] p-5 text-[var(--foreground)] shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-start gap-3">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border ${priorityUi[onlineToastAnnouncement.priority].className}`}><Megaphone className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--primary)]">在线推送</p>
              <h2 className="mt-1 line-clamp-2 text-base font-black leading-6">{onlineToastAnnouncement.title}</h2>
            </div>
            <button type="button" onClick={() => { rememberDismissed(deliveryKey(onlineToastAnnouncement)); setOnlineToastKey(null); }} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)]" aria-label="稍后查看"><X className="h-4 w-4" /></button>
          </div>
          <p className="mt-3 line-clamp-3 text-sm leading-6 text-[var(--secondary-foreground)]">{onlineToastAnnouncement.summary || onlineToastAnnouncement.content}</p>
          <div className="mt-auto flex items-center justify-end gap-2 pt-4">
            <button type="button" onClick={() => openReader(onlineToastAnnouncement.id)} className="h-9 rounded-lg border border-[var(--border)] px-3 text-xs font-bold hover:bg-[var(--muted)]">查看详情</button>
            <button type="button" onClick={() => void markRead(onlineToastAnnouncement)} className="h-9 rounded-lg bg-[var(--primary)] px-3 text-xs font-bold text-[var(--primary-foreground)]">知道了</button>
          </div>
        </aside>
      )}
      <Dialog open={readerOpen} onOpenChange={(open) => { if (!open) closeReader(); }}>
      <DialogContent
        data-testid="announcement-reader"
        showCloseButton={false}
        style={{
          width: "min(1120px, calc(100vw - 96px))",
          maxWidth: "none",
          height: "min(680px, calc(100vh - 120px))",
        }}
        className="announcement-dialog announcement-reader grid h-[min(680px,calc(100vh-120px))] w-[min(1120px,calc(100vw-96px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] p-0 shadow-2xl"
      >
        <header className="relative flex min-h-24 items-center gap-5 border-b border-[var(--border)] px-9 py-6 pr-24">
          <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border ${selectedUi.className}`} aria-hidden="true">
            <SelectedIcon className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <DialogTitle className="text-2xl font-black tracking-tight text-[var(--foreground)]">系统公告</DialogTitle>
              {unreadCount > 0 && <span className="rounded-full border border-[var(--primary)]/25 bg-[var(--primary)]/10 px-2.5 py-1 text-xs font-bold text-[var(--primary)]">{unreadCount} 条未读</span>}
              {selectedAnnouncement && isRead(selectedAnnouncement) && <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-bold text-emerald-500"><Check className="h-3.5 w-3.5" />已阅读</span>}
            </div>
            <DialogDescription className="mt-1.5 flex items-center gap-1.5 text-sm text-[var(--muted-foreground)]">
              <Clock3 className="h-3.5 w-3.5" />
              发布时间：{selectedAnnouncement ? new Date(selectedAnnouncement.created_at).toLocaleString("zh-CN", { hour12: false }) : "--"}
            </DialogDescription>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">Announcement</p>
            <p className="mt-1 font-mono text-sm font-bold text-[var(--primary)]">{selectedIndex >= 0 ? String(selectedIndex + 1).padStart(2, "0") : "00"} / {String(announcements.length).padStart(2, "0")}</p>
          </div>
          <button type="button" onClick={closeReader} className="absolute right-7 top-7 grid h-10 w-10 place-items-center rounded-xl border border-[var(--border)] bg-[var(--muted)]/45 text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/45 hover:text-[var(--foreground)]" aria-label="关闭系统公告">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div data-testid="announcement-reader-content" className="min-h-0 overflow-y-auto overscroll-contain px-9 py-7" aria-live="polite">
          {loadError && (
            <div role="alert" data-testid="announcement-inbox-error" className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3 text-sm text-rose-500">
              <span>{loadError}</span>
              <button type="button" onClick={() => void fetchInbox(false)} disabled={loading} className="shrink-0 rounded-lg border border-current/30 px-3 py-1.5 text-xs font-bold hover:bg-rose-500/10 disabled:opacity-50">{loading ? "重试中..." : "重新读取"}</button>
            </div>
          )}
          {loading && announcements.length === 0 && <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]"><span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />正在加载公告</div>}
          {!loading && !loadError && !selectedAnnouncement && <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-[var(--muted-foreground)]"><Megaphone className="h-10 w-10 opacity-45" />暂无公告</div>}
          {selectedAnnouncement && (
            <article className="grid min-h-full grid-cols-[minmax(0,1.45fr)_minmax(280px,0.55fr)] gap-7">
              <section className="flex min-w-0 flex-col rounded-2xl border border-[var(--border)] bg-[var(--background)]/25 px-8 py-7">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--primary)]">
                  <span className={`h-2 w-2 rounded-full ${selectedUi.dot}`} />
                  <span>{selectedUi.label}公告</span>
                  {selectedAnnouncement.require_ack && !isRead(selectedAnnouncement) && <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-rose-500">需确认阅读</span>}
                  {selectedAnnouncement.is_pinned && <span className="inline-flex items-center gap-1 rounded-full border border-current/20 px-2 py-0.5"><Pin className="h-3 w-3" />置顶</span>}
                  <span className="ml-auto rounded-full bg-[var(--muted)] px-2 py-0.5 font-mono text-[var(--muted-foreground)]">V{pushRevisionOf(selectedAnnouncement)}</span>
                </div>
                <h2 className="mt-5 text-[clamp(26px,2.25vw,36px)] font-black leading-[1.18] tracking-tight text-[var(--foreground)]">{selectedAnnouncement.title}</h2>
                {selectedAnnouncement.summary && <p className="mt-4 text-base font-semibold leading-8 text-[var(--secondary-foreground)]">{selectedAnnouncement.summary}</p>}
                <div className="mt-6 border-t border-[var(--border)] pt-5">
                  <p className="whitespace-pre-wrap text-[15px] leading-8 text-[var(--secondary-foreground)]">{selectedAnnouncement.content}</p>
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-7 text-xs text-[var(--muted-foreground)]">
                  <span>更新于 {formatDate(selectedAnnouncement.updated_at || selectedAnnouncement.created_at)}</span>
                  {selectedAnnouncement.link_url && <button type="button" onClick={openLinkedContent} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 font-bold text-[var(--foreground)] hover:border-[var(--primary)]/45 hover:bg-[var(--muted)]"><span>{selectedAnnouncement.link_text || "查看相关内容"}</span><ExternalLink className="h-3.5 w-3.5" /></button>}
                </div>
              </section>

              <aside className="flex min-w-0 flex-col gap-4">
                {selectedAnnouncement.image_url ? (
                  <img src={selectedAnnouncement.image_url} alt="" className="min-h-56 max-h-72 w-full rounded-2xl border border-[var(--border)] object-cover" loading="lazy" />
                ) : (
                  <div className="flex min-h-56 flex-col justify-between overflow-hidden rounded-2xl border border-[var(--primary)]/24 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--primary)_14%,var(--card)),color-mix(in_srgb,var(--background)_94%,transparent))] p-6">
                    <Megaphone className="h-9 w-9 text-[var(--primary)]" />
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--primary)]">Platform Update</p>
                      <p className="mt-2 text-lg font-black leading-snug text-[var(--foreground)]">重要变化逐条送达，阅读状态跟随账号保存。</p>
                    </div>
                  </div>
                )}
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--background)]/28 p-5">
                  <p className="text-xs font-bold text-[var(--muted-foreground)]">阅读说明</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--secondary-foreground)]">关闭不会记为已读。只有点击“标记已阅读”后，当前推送版本才不再自动出现。</p>
                </div>
              </aside>
            </article>
          )}
        </div>

        <footer className="flex min-h-20 items-center gap-3 border-t border-[var(--border)] bg-[var(--background)]/38 px-9 py-5">
          {actionError ? <p role="alert" className="mr-auto max-w-72 text-xs font-semibold text-rose-500">{actionError}</p> : <span className="mr-auto text-xs text-[var(--muted-foreground)]">请逐条阅读并确认</span>}
          <button data-testid="announcement-previous" type="button" onClick={() => selectIndex(selectedIndex + 1)} disabled={selectedIndex < 0 || selectedIndex >= announcements.length - 1} className="inline-flex h-10 min-w-24 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold text-[var(--secondary-foreground)] hover:border-[var(--primary)]/45 hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-35"><ChevronLeft className="h-4 w-4" />上一条</button>
          <button data-testid="announcement-next" type="button" onClick={() => selectIndex(selectedIndex - 1)} disabled={selectedIndex <= 0} className="inline-flex h-10 min-w-24 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm font-semibold text-[var(--secondary-foreground)] hover:border-[var(--primary)]/45 hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-35">下一条<ChevronRight className="h-4 w-4" /></button>
          {selectedAnnouncement && !isRead(selectedAnnouncement) ? (
            <button data-testid="announcement-mark-read" type="button" onClick={() => void markSelectedRead()} disabled={readingId === selectedAnnouncement.id} className="inline-flex h-10 min-w-36 items-center justify-center gap-2 rounded-xl bg-[var(--primary)] px-4 text-sm font-bold text-[var(--primary-foreground)] shadow-sm hover:brightness-110 disabled:cursor-wait disabled:opacity-60"><Check className="h-4 w-4" />{readingId === selectedAnnouncement.id ? "保存中..." : "标记已阅读"}</button>
          ) : (
            <span className="inline-flex h-10 min-w-36 items-center justify-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 text-sm font-bold text-emerald-500"><Check className="h-4 w-4" />当前已阅读</span>
          )}
        </footer>
      </DialogContent>
      </Dialog>
    </>
  );
}
