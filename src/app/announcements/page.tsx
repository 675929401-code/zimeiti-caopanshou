"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BellRing,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Megaphone,
  Pin,
  Search,
  ShieldAlert,
} from "lucide-react";
import { SubPageHeader } from "@/components/sub-page-header";
import { useApp } from "@/contexts/app-context";
import type {
  AnnouncementInboxRecord,
  AnnouncementReadResponse,
  AnnouncementRecord as Announcement,
} from "@/lib/announcement-domain";

type AnnouncementFilter = "all" | "important";
type ReaderMode = "authenticated" | "public";

function isCanonicalReadReceipt(
  value: unknown,
  announcementId: string,
  revision: number,
): value is AnnouncementReadResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<AnnouncementReadResponse>;
  return receipt.success === true
    && receipt.announcementId === announcementId
    && receipt.revision === revision
    && receipt.status === "read"
    && typeof receipt.alreadyRead === "boolean"
    && typeof receipt.readAt === "string"
    && Number.isFinite(Date.parse(receipt.readAt));
}

function formatFullDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function previewText(announcement: Announcement): string {
  return (announcement.summary || announcement.content || "暂无摘要").replace(/\s+/g, " ").trim();
}

function priorityLabel(priority: Announcement["priority"]): string {
  if (priority === "urgent") return "紧急";
  if (priority === "important") return "重要";
  return "通知";
}

function AnnouncementsPageFallback() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--background)]">
      <SubPageHeader title="公告中心" subtitle="平台规则与服务动态" icon={<Megaphone className="h-5 w-5 text-[var(--primary)]" />} />
      <div className="grid flex-1 place-items-center">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
          <p className="mt-3 text-sm text-[var(--muted-foreground)]">正在加载公告中心...</p>
        </div>
      </div>
    </div>
  );
}

function AnnouncementsPageContent() {
  const { state } = useApp();
  const searchParams = useSearchParams();
  const requestedId = searchParams.get("id");
  const token = state.auth.token;
  const userId = state.auth.user?.id;
  const [announcements, setAnnouncements] = useState<AnnouncementInboxRecord[]>([]);
  const [selectedId, setSelectedId] = useState(requestedId || "");
  const [filter, setFilter] = useState<AnnouncementFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readerMode, setReaderMode] = useState<ReaderMode>("public");
  const [readOnlyReason, setReadOnlyReason] = useState("未登录，仅展示公开公告；登录后可同步账号已读状态。");
  const [readingId, setReadingId] = useState("");
  const [actionError, setActionError] = useState("");

  const fetchAnnouncements = useCallback(async () => {
    setLoading(true);
    setError("");
    setActionError("");
    try {
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
      let items: AnnouncementInboxRecord[] | null = null;
      let fallbackReason = "未登录，仅展示公开公告；登录后可同步账号已读状态。";

      if (token) {
        try {
          const inboxResponse = await fetch("/api/announcements/inbox", {
            headers: authHeaders,
            cache: "no-store",
          });
          const inboxData = inboxResponse.ok
            ? await inboxResponse.json() as { announcements?: unknown }
            : null;
          if (inboxResponse.ok && Array.isArray(inboxData?.announcements)) {
            items = inboxData.announcements as AnnouncementInboxRecord[];
            setReaderMode("authenticated");
            setReadOnlyReason("");
          } else {
            fallbackReason = "账号已读状态暂时无法读取，当前已降级为公开只读；不会把公告假装成已读。";
          }
        } catch {
          fallbackReason = "账号已读状态暂时无法读取，当前已降级为公开只读；不会把公告假装成已读。";
        }
      }

      if (!items) {
        const response = await fetch("/api/announcements", {
          headers: authHeaders,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`ANNOUNCEMENTS_${response.status}`);
        const data = await response.json() as { announcements?: unknown };
        const publicItems = (Array.isArray(data.announcements) ? data.announcements : []) as Announcement[];
        items = publicItems.map(item => ({
          ...item,
          revision: item.push_revision,
          readAt: null,
          isRead: false,
        }));
        setReaderMode("public");
        setReadOnlyReason(fallbackReason);
      }

      setAnnouncements(items);
      setSelectedId(current => {
        if (current && items.some(item => item.id === current)) return current;
        if (requestedId && items.some(item => item.id === requestedId)) return requestedId;
        return items.find(item => item.is_pinned)?.id || items[0]?.id || "";
      });
    } catch {
      setAnnouncements([]);
      setError("公告服务暂时无法加载，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [requestedId, token]);

  useEffect(() => { void fetchAnnouncements(); }, [fetchAnnouncements]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return announcements.filter(item => {
      if (filter === "important" && !item.is_pinned && !["important", "urgent"].includes(item.priority)) return false;
      if (!normalizedQuery) return true;
      return `${item.title} ${item.summary || ""} ${item.content}`.toLowerCase().includes(normalizedQuery);
    });
  }, [announcements, filter, query]);

  useEffect(() => {
    if (loading) return;
    const validSelectedId = filtered.some(item => item.id === selectedId)
      ? selectedId
      : filtered[0]?.id || "";
    if (validSelectedId === selectedId) return;
    setSelectedId(validSelectedId);
    const url = new URL(window.location.href);
    if (validSelectedId) url.searchParams.set("id", validSelectedId);
    else url.searchParams.delete("id");
    window.history.replaceState({}, "", url);
  }, [filtered, loading, selectedId]);

  const selected = filtered.find(item => item.id === selectedId) || filtered[0] || null;
  const selectedIndex = selected ? filtered.findIndex(item => item.id === selected.id) : -1;
  const pinnedCount = announcements.filter(item => item.is_pinned).length;
  const importantCount = announcements.filter(item => ["important", "urgent"].includes(item.priority)).length;
  const statistics = [
    { label: "全部公告", value: announcements.length, icon: Megaphone },
    { label: "置顶", value: pinnedCount, icon: Pin },
    { label: "重要", value: importantCount, icon: ShieldAlert },
  ];

  const chooseAnnouncement = (id: string) => {
    setActionError("");
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("id", id);
    window.history.replaceState({}, "", url);
  };

  const markSelectedRead = async () => {
    if (!selected || readerMode !== "authenticated" || selected.isRead || readingId) return;
    const revision = selected.revision;
    if (!token || !Number.isInteger(revision) || revision <= 0) {
      setActionError("该公告暂无可确认的账号版本，请刷新后重试。");
      return;
    }

    setActionError("");
    setReadingId(selected.id);
    try {
      const response = await fetch(`/api/announcements/${encodeURIComponent(selected.id)}/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ revision }),
      });
      const receipt = await response.json().catch(() => null) as unknown;
      if (!response.ok || !isCanonicalReadReceipt(receipt, selected.id, revision)) {
        const message = receipt && typeof receipt === "object" && "error" in receipt
          && typeof (receipt as { error?: unknown }).error === "string"
          ? (receipt as { error: string }).error
          : "已读状态保存失败，请重试。";
        throw new Error(message);
      }

      setAnnouncements(current => current.map(item => (
        item.id === receipt.announcementId && item.revision === receipt.revision
          ? { ...item, isRead: true, readAt: receipt.readAt }
          : item
      )));
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("announcement-inbox-v1");
        channel.postMessage({
          type: "read",
          userId,
          announcementId: receipt.announcementId,
          revision: receipt.revision,
        });
        channel.close();
      }
    } catch (readError) {
      setActionError(readError instanceof Error ? readError.message : "已读状态保存失败，请重试。");
    } finally {
      setReadingId("");
    }
  };

  return (
    <div className="flex h-screen min-w-[1080px] flex-col overflow-hidden bg-[var(--background)]" data-testid="announcement-reading-center">
      <SubPageHeader title="公告中心" subtitle="平台规则与服务动态" icon={<Megaphone className="h-5 w-5 text-[var(--primary)]" />} />

      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full max-w-7xl flex-col gap-5 px-6 py-6">
          <section className="grid shrink-0 grid-cols-[minmax(0,1fr)_160px_160px_160px] items-stretch overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)] shadow-sm">
            <div className="p-6">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-[var(--primary)]"><BellRing className="h-4 w-4" /> Platform bulletin</div>
              <h1 className="mt-2 text-2xl font-bold text-[var(--foreground)]">重要信息，一处读完</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">集中查看平台规则、功能升级、服务安排和运营通知。左侧快速定位，右侧保持完整阅读上下文。</p>
            </div>
            {statistics.map(({ label, value, icon: Icon }) => (
              <div key={label} className="flex flex-col justify-center border-l border-[var(--border)] px-5">
                <Icon className="h-4 w-4 text-[var(--primary)]" />
                <strong className="mt-3 text-2xl text-[var(--foreground)]">{value}</strong>
                <span className="mt-1 text-xs text-[var(--muted-foreground)]">{label}</span>
              </div>
            ))}
          </section>

          {loading ? (
            <div className="grid min-h-0 flex-1 place-items-center rounded-3xl border border-[var(--border)] bg-[var(--card)]">
              <div className="text-center"><div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" /><p className="mt-3 text-sm text-[var(--muted-foreground)]">正在载入公告...</p></div>
            </div>
          ) : error ? (
            <div className="grid min-h-0 flex-1 place-items-center rounded-3xl border border-[var(--border)] bg-[var(--card)] text-center" role="alert">
              <div><AlertTriangle className="mx-auto h-10 w-10 text-amber-500" /><p className="mt-3 font-semibold text-[var(--foreground)]">{error}</p><button type="button" onClick={() => void fetchAnnouncements()} className="mt-4 rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-[var(--primary-foreground)]">重新加载</button></div>
            </div>
          ) : announcements.length === 0 ? (
            <div className="grid min-h-0 flex-1 place-items-center rounded-3xl border border-dashed border-[var(--border)] bg-[var(--card)] text-sm text-[var(--muted-foreground)]">暂无公告</div>
          ) : (
            <section className="grid min-h-0 flex-1 grid-cols-[390px_minmax(0,1fr)] gap-5">
              <aside className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)] shadow-sm">
                <div className="border-b border-[var(--border)] p-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
                    <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索公告标题或内容" className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] pl-9 pr-3 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--primary)]" />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-[var(--background)] p-1">
                    {([['all', '全部'], ['important', '重要 / 置顶']] as const).map(([value, label]) => (
                      <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${filter === value ? "bg-[var(--card)] text-[var(--primary)] shadow-sm" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}>{label}</button>
                    ))}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {filtered.length === 0 ? (
                    <p className="px-4 py-12 text-center text-sm text-[var(--muted-foreground)]">没有匹配的公告</p>
                  ) : filtered.map(item => {
                    const active = selected?.id === item.id;
                    return (
                      <button key={item.id} type="button" onClick={() => chooseAnnouncement(item.id)} className={`mb-1 w-full rounded-2xl border px-4 py-4 text-left transition ${active ? "border-[var(--primary)]/35 bg-[var(--primary)]/8 shadow-sm" : "border-transparent hover:border-[var(--border)] hover:bg-[var(--background)]"}`} aria-current={active ? "true" : undefined}>
                        <div className="flex items-center gap-2">
                          <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold ${item.priority === "urgent" ? "bg-rose-500/10 text-rose-500" : item.priority === "important" ? "bg-amber-500/10 text-amber-500" : "bg-[var(--primary)]/10 text-[var(--primary)]"}`}>{priorityLabel(item.priority)}</span>
                          {item.is_pinned && <Pin className="h-3.5 w-3.5 text-amber-500" />}
                          <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">{shortDate(item.created_at)}</span>
                        </div>
                        <div className="mt-2 flex items-start gap-2">
                          <h2 className={`line-clamp-2 flex-1 text-sm font-bold leading-6 ${active ? "text-[var(--primary)]" : "text-[var(--foreground)]"}`}>{item.title}</h2>
                          {readerMode === "authenticated" && (
                            <span className={`mt-1 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${item.isRead ? "bg-emerald-500/10 text-emerald-500" : "bg-[var(--primary)]/10 text-[var(--primary)]"}`}>{item.isRead ? "已读" : "未读"}</span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--muted-foreground)]">{previewText(item)}</p>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <article className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)] shadow-sm" data-testid="announcement-reading-pane">
                {selected && (
                  <>
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="announcement-longform-scroll">
                      <div className="mx-auto max-w-4xl px-9 py-8">
                        {readerMode === "public" && (
                          <div className="mb-6 flex items-start gap-2 rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-xs leading-5 text-amber-600" data-testid="announcement-readonly-notice">
                            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{readOnlyReason}</span>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${selected.priority === "urgent" ? "bg-rose-500/10 text-rose-500" : selected.priority === "important" ? "bg-amber-500/10 text-amber-500" : "bg-[var(--primary)]/10 text-[var(--primary)]"}`}>{priorityLabel(selected.priority)}</span>
                          {selected.is_pinned && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-500"><Pin className="h-3 w-3" /> 置顶</span>}
                          {readerMode === "authenticated" && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${selected.isRead ? "bg-emerald-500/10 text-emerald-500" : "bg-[var(--primary)]/10 text-[var(--primary)]"}`} data-testid="announcement-read-status">
                              {selected.isRead && <Check className="h-3 w-3" />}{selected.isRead ? "已阅读" : "尚未确认"}
                            </span>
                          )}
                        </div>
                        <h2 className="mt-5 text-3xl font-bold leading-tight text-[var(--foreground)]">{selected.title}</h2>
                        <div className="mt-4 flex items-center gap-5 border-b border-[var(--border)] pb-5 text-xs text-[var(--muted-foreground)]">
                          <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" /> {formatFullDate(selected.created_at)}</span>
                          {selected.updated_at && selected.updated_at !== selected.created_at && <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" /> 已更新</span>}
                          {readerMode === "authenticated" && selected.readAt && <span>确认于 {formatFullDate(selected.readAt)}</span>}
                        </div>
                        {selected.image_url && <img src={selected.image_url} alt={selected.title} className="mt-7 max-h-[420px] w-full rounded-2xl border border-[var(--border)] object-cover" />}
                        {selected.summary && <p className="mt-7 rounded-2xl border-l-4 border-[var(--primary)] bg-[var(--primary)]/6 px-5 py-4 text-base font-semibold leading-7 text-[var(--foreground)]">{selected.summary}</p>}
                        <div className="mt-7 whitespace-pre-wrap break-words text-[15px] leading-8 text-[var(--text-secondary)]">{selected.content}</div>
                        {selected.link_url && (
                          <a href={selected.link_url} target="_blank" rel="noopener noreferrer" className="mt-8 inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-[var(--primary-foreground)]">
                            {selected.link_text || "查看详情"}<ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex min-h-[72px] shrink-0 items-center gap-3 border-t border-[var(--border)] px-6 py-3 text-xs text-[var(--muted-foreground)]">
                      <span className="shrink-0">公告编号 {selected.id.slice(0, 8)}</span>
                      <span className="mx-auto font-semibold" data-testid="announcement-position">第 {selectedIndex + 1} / {filtered.length} 条</span>
                      <button data-testid="announcement-previous" type="button" onClick={() => { const previous = filtered[selectedIndex - 1]; if (previous) chooseAnnouncement(previous.id); }} disabled={selectedIndex <= 0} className="inline-flex h-9 items-center gap-1 rounded-xl border border-[var(--border)] px-3 font-semibold text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft className="h-4 w-4" /> 上一条</button>
                      <button data-testid="announcement-next" type="button" onClick={() => { const next = filtered[selectedIndex + 1]; if (next) chooseAnnouncement(next.id); }} disabled={selectedIndex < 0 || selectedIndex >= filtered.length - 1} className="inline-flex h-9 items-center gap-1 rounded-xl border border-[var(--border)] px-3 font-semibold text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-30">下一条 <ChevronRight className="h-4 w-4" /></button>
                      {readerMode === "authenticated" && !selected.isRead ? (
                        <button data-testid="announcement-center-mark-read" type="button" onClick={() => void markSelectedRead()} disabled={readingId === selected.id} className="inline-flex h-9 min-w-28 items-center justify-center gap-1.5 rounded-xl bg-[var(--primary)] px-4 font-bold text-[var(--primary-foreground)] shadow-sm disabled:cursor-wait disabled:opacity-60"><Check className="h-4 w-4" />{readingId === selected.id ? "保存中..." : "知道了"}</button>
                      ) : readerMode === "authenticated" ? (
                        <span className="inline-flex h-9 min-w-28 items-center justify-center gap-1.5 rounded-xl bg-emerald-500/10 px-4 font-bold text-emerald-500"><Check className="h-4 w-4" />已阅读</span>
                      ) : null}
                    </div>
                    {actionError && <div className="shrink-0 border-t border-rose-500/20 bg-rose-500/8 px-6 py-2.5 text-xs font-semibold text-rose-500" role="alert" data-testid="announcement-read-error">{actionError}</div>}
                  </>
                )}
              </article>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

export default function AnnouncementsPage() {
  return <Suspense fallback={<AnnouncementsPageFallback />}><AnnouncementsPageContent /></Suspense>;
}
