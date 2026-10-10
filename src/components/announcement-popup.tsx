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
  normalizeAnnouncementDisplayLedger,
  recordAnnouncementImpression,
  type AnnouncementDisplayLedger,
} from "@/lib/announcement-client-policy";
import {
  APP_DIALOG_CLAIMED_EVENT,
  APP_DIALOG_PRIORITY,
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

const INBOX_ENDPOINT = "/api/announcements/inbox";
const POLL_INTERVAL_MS = 15_000;
const BROADCAST_CHANNEL = "announcement-inbox-v1";
const DISPLAY_LEDGER_KEY = "announcement_display_ledger_v1";
const DELIVERY_SESSION_KEY = "announcement_delivery_session_v1";

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
  type: "read" | "refresh";
  userId?: string;
  announcementId?: string;
  revision?: number;
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

function readDeliverySession(sessionIdentity: string) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DELIVERY_SESSION_KEY) || "null") as unknown;
    if (!isRecord(parsed) || parsed.sessionIdentity !== sessionIdentity || !Array.isArray(parsed.knownDeliveryKeys)) {
      return { initialized: false, knownDeliveryKeys: new Set<string>() };
    }
    return {
      initialized: true,
      knownDeliveryKeys: new Set(parsed.knownDeliveryKeys.filter((value): value is string => typeof value === "string")),
    };
  } catch {
    return { initialized: false, knownDeliveryKeys: new Set<string>() };
  }
}

function writeDeliverySession(sessionIdentity: string, knownDeliveryKeys: Set<string>) {
  try {
    sessionStorage.setItem(DELIVERY_SESSION_KEY, JSON.stringify({
      sessionIdentity,
      knownDeliveryKeys: [...knownDeliveryKeys].slice(-500),
    }));
  } catch {
    // The server receipt remains authoritative when session storage is unavailable.
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
    className: "announcement-priority",
    dot: "bg-sky-400",
  },
  important: {
    label: "重要",
    icon: AlertTriangle,
    className: "announcement-priority announcement-priority-important",
    dot: "bg-amber-400",
  },
  urgent: {
    label: "紧急",
    icon: ShieldAlert,
    className: "announcement-priority announcement-priority-urgent",
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
  const [, refreshToastQueueState] = useState(0);

  const announcementsRef = useRef<AnnouncementInboxItem[]>([]);
  const readerOpenRef = useRef(false);
  const deferredReaderRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const onlineToastKeyRef = useRef<string | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const requestSequenceRef = useRef(0);
  const cursorRef = useRef("");
  const initializedRef = useRef(false);
  const knownDeliveryKeysRef = useRef(new Set<string>());
  const automaticImpressionsRef = useRef(new Set<string>());
  const previousSessionIdentityRef = useRef("");

  useEffect(() => { announcementsRef.current = announcements; }, [announcements]);
  useEffect(() => { readerOpenRef.current = readerOpen; }, [readerOpen]);
  useEffect(() => { onlineToastKeyRef.current = onlineToastKey; }, [onlineToastKey]);

  const recordAutomaticDisplay = useCallback((announcement: AnnouncementInboxItem) => {
    if (!sessionIdentity) return;
    const key = deliveryKey(announcement);
    if (automaticImpressionsRef.current.has(key)) return;
    automaticImpressionsRef.current.add(key);
    const next = recordAnnouncementImpression(announcement, readDisplayLedger(sessionIdentity));
    writeDisplayLedger(sessionIdentity, next);
    recordAnalytics(announcement, "impression", token);
  }, [sessionIdentity, token]);

  const queueToast = useCallback((announcement: AnnouncementInboxItem | null) => {
    const key = announcement ? deliveryKey(announcement) : null;
    onlineToastKeyRef.current = key;
    setOnlineToastKey(key);
    if (announcement) {
      claimAppToast(
        "announcement",
        announcement.priority === "urgent"
          ? APP_TOAST_PRIORITY.announcementUrgent
          : APP_TOAST_PRIORITY.announcement,
      );
    } else {
      releaseAppToast("announcement");
    }
  }, []);

  const openReader = useCallback((
    announcementId?: string | null,
    options: { automatic?: boolean } = {},
  ) => {
    setActionError("");
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
    queueToast(null);
    if (options.automatic && selected) recordAutomaticDisplay(selected);
    return true;
  }, [queueToast, recordAutomaticDisplay]);
  useEffect(() => { selectedIdRef.current = selectedAnnouncementId; }, [selectedAnnouncementId]);

  const authHeaders = useMemo(
    (): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {},
    [token],
  );

  const applyReadLocally = useCallback((announcementId: string, revision: number, readAt: string) => {
    const next = announcementsRef.current.map((announcement) => (
      announcement.id === announcementId && pushRevisionOf(announcement) === revision
        ? { ...announcement, read_at: readAt, readAt, is_read: true, isRead: true }
        : announcement
    ));
    announcementsRef.current = next;
    setAnnouncements(next);
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
      const backlogLoad = !initializedRef.current;
      const newlyPushed = backlogLoad
        ? null
        : items.find((announcement) => (
          !isRead(announcement)
          && !knownDeliveryKeysRef.current.has(deliveryKey(announcement))
        )) || null;
      initializedRef.current = true;
      knownDeliveryKeysRef.current = new Set(items.map(deliveryKey));
      writeDeliverySession(sessionIdentity, knownDeliveryKeysRef.current);
      announcementsRef.current = items;
      setAnnouncements(items);

      const selectedStillExists = selectedIdRef.current
        && items.some((announcement) => announcement.id === selectedIdRef.current);
      if (!selectedStillExists) {
        const preferred = items.find((announcement) => !isRead(announcement)) || items[0] || null;
        selectedIdRef.current = preferred?.id || null;
        setSelectedAnnouncementId(preferred?.id || null);
      }

      if (allowAutoOpen && backlogLoad && !readerOpenRef.current) {
        const candidate = items.find((announcement) => !isRead(announcement));
        if (candidate) {
          openReader(candidate.id, { automatic: true });
        }
      } else if (allowAutoOpen && newlyPushed) {
        queueToast(newlyPushed);
      } else if (allowAutoOpen && !readerOpenRef.current && !onlineToastKeyRef.current) {
        queueToast(items.find((announcement) => !isRead(announcement)) || null);
      }
    } catch (error) {
      console.warn("[announcement-inbox] fetch failed:", error);
      if (requestSequence === requestSequenceRef.current) {
        setLoadError(error instanceof Error ? error.message : "公告收件箱暂时不可用");
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [authHeaders, isAuthenticated, openReader, queueToast, sessionIdentity]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    const previousSessionIdentity = previousSessionIdentityRef.current;
    if (!sessionIdentity && previousSessionIdentity) {
      try { sessionStorage.removeItem(DELIVERY_SESSION_KEY); } catch { /* no-op */ }
    }
    previousSessionIdentityRef.current = sessionIdentity;
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
    queueToast(null);
    const deliverySession = sessionIdentity
      ? readDeliverySession(sessionIdentity)
      : { initialized: false, knownDeliveryKeys: new Set<string>() };
    initializedRef.current = deliverySession.initialized;
    knownDeliveryKeysRef.current = deliverySession.knownDeliveryKeys;
    automaticImpressionsRef.current = new Set();
    cursorRef.current = "";
  }, [queueToast, sessionIdentity]);

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
    const onToastClaimed = () => refreshToastQueueState((revision) => revision + 1);
    const onToastReleased = () => {
      refreshToastQueueState((revision) => revision + 1);
      const pending = announcementsRef.current.find((announcement) => (
        onlineToastKeyRef.current === deliveryKey(announcement) && !isRead(announcement)
      ));
      if (pending && !readerOpenRef.current && !currentAppDialogOwner()) {
        claimAppToast(
          "announcement",
          pending.priority === "urgent"
            ? APP_TOAST_PRIORITY.announcementUrgent
            : APP_TOAST_PRIORITY.announcement,
        );
      }
    };
    window.addEventListener(APP_TOAST_CLAIMED_EVENT, onToastClaimed);
    window.addEventListener(APP_TOAST_RELEASED_EVENT, onToastReleased);
    return () => {
      window.removeEventListener(APP_TOAST_CLAIMED_EVENT, onToastClaimed);
      window.removeEventListener(APP_TOAST_RELEASED_EVENT, onToastReleased);
      releaseAppToast("announcement");
    };
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
      } else if (message.type === "refresh") {
        void fetchInbox(true);
      }
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [applyReadLocally, fetchInbox, isAuthenticated, userId]);

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
    const receipt = await response.json().catch(() => null) as {
      success?: unknown;
      announcementId?: unknown;
      revision?: unknown;
      readAt?: unknown;
      status?: unknown;
      error?: unknown;
    } | null;
    const readAt = typeof receipt?.readAt === "string" && Number.isFinite(Date.parse(receipt.readAt))
      ? receipt.readAt
      : "";
    if (!response.ok
      || receipt?.success !== true
      || receipt.announcementId !== announcement.id
      || receipt.revision !== revision
      || receipt.status !== "read"
      || !readAt) {
      throw new Error(typeof receipt?.error === "string" && receipt.error ? receipt.error : "已阅读状态保存失败");
    }
    applyReadLocally(announcement.id, revision, readAt);
    recordAnalytics(announcement, "read", token);
    channelRef.current?.postMessage({
      type: "read",
      userId,
      announcementId: announcement.id,
      revision,
    } satisfies InboxChannelMessage);
  }, [applyReadLocally, authHeaders, token, userId]);

  const closeReader = useCallback(() => {
    const unreadForToast = announcementsRef.current.find((announcement) => !isRead(announcement)) || null;
    const preservedOnlineToast = announcementsRef.current.find((announcement) => (
      onlineToastKeyRef.current === deliveryKey(announcement) && !isRead(announcement)
    )) || null;
    announcementsRef.current
      .filter((announcement) => !isRead(announcement))
      .forEach((announcement) => {
        recordAnalytics(announcement, "close", token);
      });
    readerOpenRef.current = false;
    setReaderOpen(false);
    setActionError("");
    releaseAppDialog("announcement");
    queueToast(preservedOnlineToast || unreadForToast);
    return true;
  }, [queueToast, token]);

  const markSelectedRead = async () => {
    if (!selectedAnnouncement || isRead(selectedAnnouncement) || readingId) return;
    setActionError("");
    setReadingId(selectedAnnouncement.id);
    try {
      await markRead(selectedAnnouncement);
      const currentIndex = announcementsRef.current.findIndex((announcement) => (
        announcement.id === selectedAnnouncement.id
      ));
      const nextUnread = [
        ...announcementsRef.current.slice(currentIndex + 1),
        ...announcementsRef.current.slice(0, Math.max(0, currentIndex)),
      ].find((announcement) => !isRead(announcement));
      if (nextUnread) {
        selectedIdRef.current = nextUnread.id;
        setSelectedAnnouncementId(nextUnread.id);
      } else {
        closeReader();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "已阅读状态保存失败");
    } finally {
      setReadingId(null);
    }
  };

  const acknowledgeToast = async (announcement: AnnouncementInboxItem) => {
    if (readingId) return;
    setActionError("");
    setReadingId(announcement.id);
    try {
      await markRead(announcement);
      const currentIndex = announcementsRef.current.findIndex((item) => item.id === announcement.id);
      const nextUnread = [
        ...announcementsRef.current.slice(currentIndex + 1),
        ...announcementsRef.current.slice(0, Math.max(0, currentIndex)),
      ].find((item) => !isRead(item));
      queueToast(nextUnread || null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "已阅读状态保存失败");
    } finally {
      setReadingId(null);
    }
  };

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
      {onlineToastAnnouncement && !readerOpen && !currentAppDialogOwner() && currentAppToastOwner() === "announcement" && (
        <aside
          data-testid="announcement-online-toast"
          data-platform-popup="announcement-toast"
          role="status"
          aria-live="polite"
          className="announcement-toast fixed bottom-7 right-7 z-[118] flex w-[344px] flex-col overflow-hidden rounded-[18px] border"
        >
          <div className="announcement-toast-head flex items-start gap-3 px-4 pb-3 pt-4">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-[12px] border shadow-sm ${priorityUi[onlineToastAnnouncement.priority].className}`}><Megaphone className="h-[18px] w-[18px]" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-extrabold tracking-[0.16em] text-[var(--primary)]">在线推送</p>
              <h2 className="mt-1 line-clamp-2 text-[15px] font-extrabold leading-[1.45] tracking-[-0.01em]">{onlineToastAnnouncement.title}</h2>
            </div>
          </div>
          <p className="announcement-toast-body line-clamp-2 px-4 py-3 text-[13px] font-medium leading-[1.65] text-[var(--secondary-foreground)]">{onlineToastAnnouncement.summary || onlineToastAnnouncement.content}</p>
          {actionError && <p role="alert" className="announcement-toast-body border-t border-rose-500/20 px-4 py-2 text-xs font-semibold text-rose-400">{actionError}</p>}
          <div className="announcement-toast-actions flex items-center justify-end gap-2 px-4 py-3">
            <button type="button" onClick={() => openReader(onlineToastAnnouncement.id)} className="h-8 rounded-[9px] border border-[var(--border)] px-3 text-xs font-bold transition hover:bg-[var(--muted)]">详情</button>
            <button type="button" onClick={() => void acknowledgeToast(onlineToastAnnouncement)} disabled={readingId === onlineToastAnnouncement.id} className="h-8 rounded-[9px] bg-[var(--primary)] px-3.5 text-xs font-bold text-[var(--primary-foreground)] shadow-sm transition hover:brightness-105 disabled:cursor-wait disabled:opacity-60">{readingId === onlineToastAnnouncement.id ? "保存中..." : "知道了"}</button>
          </div>
        </aside>
      )}
      <Dialog open={readerOpen} onOpenChange={(open) => { if (!open) closeReader(); }}>
      <DialogContent
        data-testid="announcement-reader"
        data-platform-popup="announcement-reader"
        showCloseButton={false}
        style={{
          width: "min(920px, calc(100vw - 80px))",
          maxWidth: "none",
          height: "min(590px, calc(100vh - 112px))",
        }}
        className="announcement-dialog announcement-reader grid h-[min(590px,calc(100vh-112px))] w-[min(920px,calc(100vw-80px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--card)] p-0"
      >
        <header className="announcement-reader-header relative flex min-h-[82px] items-center gap-4 border-b border-[var(--border)] px-6 py-4 pr-20">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] border ${selectedUi.className}`} aria-hidden="true">
            <SelectedIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="text-[20px] font-black tracking-[-0.02em] text-[var(--foreground)]">系统公告</DialogTitle>
              {unreadCount > 0 && <span className="rounded-full border border-[var(--primary)]/25 bg-[var(--primary)]/10 px-2 py-0.5 text-[11px] font-bold text-[var(--primary)]">{unreadCount} 条未读</span>}
              {selectedAnnouncement && isRead(selectedAnnouncement) && <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-500"><Check className="h-3 w-3" />已阅读</span>}
            </div>
            <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
              <Clock3 className="h-3 w-3" />
              发布时间：{selectedAnnouncement ? new Date(selectedAnnouncement.created_at).toLocaleString("zh-CN", { hour12: false }) : "--"}
            </DialogDescription>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">Announcement</p>
            <p className="mt-0.5 font-mono text-xs font-bold text-[var(--primary)]">{selectedIndex >= 0 ? String(selectedIndex + 1).padStart(2, "0") : "00"} / {String(announcements.length).padStart(2, "0")}</p>
          </div>
          <button type="button" onClick={closeReader} className="absolute right-5 top-5 grid h-9 w-9 place-items-center rounded-[11px] border border-[var(--border)] bg-[var(--muted)]/45 text-[var(--muted-foreground)] transition-colors hover:border-[var(--primary)]/45 hover:text-[var(--foreground)]" aria-label="关闭系统公告">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div data-testid="announcement-reader-content" className="announcement-reader-body min-h-0 overflow-y-auto overscroll-contain px-6 py-5" aria-live="polite">
          {loadError && (
            <div role="alert" data-testid="announcement-inbox-error" className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3 text-sm text-rose-500">
              <span>{loadError}</span>
              <button type="button" onClick={() => void fetchInbox(false)} disabled={loading} className="shrink-0 rounded-lg border border-current/30 px-3 py-1.5 text-xs font-bold hover:bg-rose-500/10 disabled:opacity-50">{loading ? "重试中..." : "重新读取"}</button>
            </div>
          )}
          {loading && announcements.length === 0 && <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]"><span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />正在加载公告</div>}
          {!loading && !loadError && !selectedAnnouncement && <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-[var(--muted-foreground)]"><Megaphone className="h-10 w-10 opacity-45" />暂无公告</div>}
          {selectedAnnouncement && (
            <article className="grid min-h-full grid-cols-[minmax(0,1fr)_240px] gap-5">
              <section className="announcement-reader-panel flex min-w-0 flex-col rounded-[16px] border border-[var(--border)] px-6 py-5">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--primary)]">
                  <span className={`h-2 w-2 rounded-full ${selectedUi.dot}`} />
                  <span>{selectedUi.label}公告</span>
                  {selectedAnnouncement.require_ack && !isRead(selectedAnnouncement) && <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-rose-500">需确认阅读</span>}
                  {selectedAnnouncement.is_pinned && <span className="inline-flex items-center gap-1 rounded-full border border-current/20 px-2 py-0.5"><Pin className="h-3 w-3" />置顶</span>}
                  <span className="ml-auto rounded-full bg-[var(--muted)] px-2 py-0.5 font-mono text-[var(--muted-foreground)]">V{pushRevisionOf(selectedAnnouncement)}</span>
                </div>
                <h2 className="mt-4 text-[clamp(21px,1.8vw,27px)] font-black leading-[1.25] tracking-[-0.025em] text-[var(--foreground)]">{selectedAnnouncement.title}</h2>
                {selectedAnnouncement.summary && <p className="mt-3 text-[14px] font-semibold leading-6 text-[var(--secondary-foreground)]">{selectedAnnouncement.summary}</p>}
                <div className="mt-4 border-t border-[var(--border)] pt-4">
                  <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.75] text-[var(--secondary-foreground)]">{selectedAnnouncement.content}</p>
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-5 text-[11px] text-[var(--muted-foreground)]">
                  <span>更新于 {formatDate(selectedAnnouncement.updated_at || selectedAnnouncement.created_at)}</span>
                  {selectedAnnouncement.link_url && <button type="button" onClick={openLinkedContent} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 font-bold text-[var(--foreground)] hover:border-[var(--primary)]/45 hover:bg-[var(--muted)]"><span>{selectedAnnouncement.link_text || "查看相关内容"}</span><ExternalLink className="h-3.5 w-3.5" /></button>}
                </div>
              </section>

              <aside className="flex min-w-0 flex-col gap-3">
                {selectedAnnouncement.image_url ? (
                  <img src={selectedAnnouncement.image_url} alt="" className="min-h-40 max-h-52 w-full rounded-[16px] border border-[var(--border)] object-cover" loading="lazy" />
                ) : (
                  <div className="announcement-reader-feature flex min-h-40 flex-col justify-between overflow-hidden rounded-[16px] border p-5">
                    <Megaphone className="h-7 w-7 text-[var(--primary)]" />
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--primary)]">Platform Update</p>
                      <p className="mt-2 text-[15px] font-black leading-snug text-[var(--foreground)]">重要变化逐条送达，阅读状态跟随账号保存。</p>
                    </div>
                  </div>
                )}
                <div className="announcement-reader-note rounded-[16px] border border-[var(--border)] p-4">
                  <p className="text-[11px] font-bold text-[var(--muted-foreground)]">阅读说明</p>
                  <p className="mt-1.5 text-xs leading-5 text-[var(--secondary-foreground)]">关闭详情不会记为已读，提醒会回到右下角。只有点击“知道了”并保存成功后，当前推送版本才不再出现。</p>
                </div>
              </aside>
            </article>
          )}
        </div>

        <footer className="announcement-reader-footer flex min-h-[66px] items-center gap-2.5 border-t border-[var(--border)] px-6 py-3.5">
          {actionError ? <p role="alert" className="mr-auto max-w-72 text-xs font-semibold text-rose-500">{actionError}</p> : <span className="mr-auto text-xs text-[var(--muted-foreground)]">请逐条阅读并确认</span>}
          <button data-testid="announcement-previous" type="button" onClick={() => selectIndex(selectedIndex + 1)} disabled={selectedIndex < 0 || selectedIndex >= announcements.length - 1} className="inline-flex h-9 min-w-20 items-center justify-center gap-1 rounded-[10px] border border-[var(--border)] px-3 text-xs font-semibold text-[var(--secondary-foreground)] hover:border-[var(--primary)]/45 hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-35"><ChevronLeft className="h-3.5 w-3.5" />上一条</button>
          <button data-testid="announcement-next" type="button" onClick={() => selectIndex(selectedIndex - 1)} disabled={selectedIndex <= 0} className="inline-flex h-9 min-w-20 items-center justify-center gap-1 rounded-[10px] border border-[var(--border)] px-3 text-xs font-semibold text-[var(--secondary-foreground)] hover:border-[var(--primary)]/45 hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-35">下一条<ChevronRight className="h-3.5 w-3.5" /></button>
          {selectedAnnouncement && !isRead(selectedAnnouncement) ? (
            <button data-testid="announcement-mark-read" type="button" onClick={() => void markSelectedRead()} disabled={readingId === selectedAnnouncement.id} className="inline-flex h-9 min-w-32 items-center justify-center gap-1.5 rounded-[10px] bg-[var(--primary)] px-4 text-xs font-bold text-[var(--primary-foreground)] shadow-sm hover:brightness-110 disabled:cursor-wait disabled:opacity-60"><Check className="h-3.5 w-3.5" />{readingId === selectedAnnouncement.id ? "保存中..." : "知道了"}</button>
          ) : (
            <span className="inline-flex h-9 min-w-32 items-center justify-center gap-1.5 rounded-[10px] border border-emerald-500/25 bg-emerald-500/10 px-4 text-xs font-bold text-emerald-500"><Check className="h-3.5 w-3.5" />当前已阅读</span>
          )}
        </footer>
      </DialogContent>
      </Dialog>
    </>
  );
}
