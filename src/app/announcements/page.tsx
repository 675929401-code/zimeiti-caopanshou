"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BellRing,
  CalendarDays,
  ChevronRight,
  Clock3,
  ExternalLink,
  Megaphone,
  Pin,
  Search,
  ShieldAlert,
} from "lucide-react";
import { SubPageHeader } from "@/components/sub-page-header";
import type { AnnouncementRecord as Announcement } from "@/lib/announcement-domain";

type AnnouncementFilter = "all" | "important";

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
  const searchParams = useSearchParams();
  const requestedId = searchParams.get("id");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [selectedId, setSelectedId] = useState(requestedId || "");
  const [filter, setFilter] = useState<AnnouncementFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchAnnouncements = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/announcements", { cache: "no-store" });
      if (!response.ok) throw new Error(`ANNOUNCEMENTS_${response.status}`);
      const data = await response.json();
      const items = (Array.isArray(data.announcements) ? data.announcements : []) as Announcement[];
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
  }, [requestedId]);

  useEffect(() => { void fetchAnnouncements(); }, [fetchAnnouncements]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return announcements.filter(item => {
      if (filter === "important" && !item.is_pinned && !["important", "urgent"].includes(item.priority)) return false;
      if (!normalizedQuery) return true;
      return `${item.title} ${item.summary || ""} ${item.content}`.toLowerCase().includes(normalizedQuery);
    });
  }, [announcements, filter, query]);

  const selected = announcements.find(item => item.id === selectedId) || filtered[0] || null;
  const pinnedCount = announcements.filter(item => item.is_pinned).length;
  const importantCount = announcements.filter(item => ["important", "urgent"].includes(item.priority)).length;
  const statistics = [
    { label: "全部公告", value: announcements.length, icon: Megaphone },
    { label: "置顶", value: pinnedCount, icon: Pin },
    { label: "重要", value: importantCount, icon: ShieldAlert },
  ];

  const chooseAnnouncement = (id: string) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("id", id);
    window.history.replaceState({}, "", url);
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
                        <h2 className={`mt-2 line-clamp-2 text-sm font-bold leading-6 ${active ? "text-[var(--primary)]" : "text-[var(--foreground)]"}`}>{item.title}</h2>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--muted-foreground)]">{previewText(item)}</p>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <article className="min-h-0 overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--card)] shadow-sm" data-testid="announcement-reading-pane">
                {selected && (
                  <div className="mx-auto max-w-4xl px-9 py-8">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${selected.priority === "urgent" ? "bg-rose-500/10 text-rose-500" : selected.priority === "important" ? "bg-amber-500/10 text-amber-500" : "bg-[var(--primary)]/10 text-[var(--primary)]"}`}>{priorityLabel(selected.priority)}</span>
                      {selected.is_pinned && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-500"><Pin className="h-3 w-3" /> 置顶</span>}
                    </div>
                    <h2 className="mt-5 text-3xl font-bold leading-tight text-[var(--foreground)]">{selected.title}</h2>
                    <div className="mt-4 flex items-center gap-5 border-b border-[var(--border)] pb-5 text-xs text-[var(--muted-foreground)]">
                      <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" /> {formatFullDate(selected.created_at)}</span>
                      {selected.updated_at && selected.updated_at !== selected.created_at && <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" /> 已更新</span>}
                    </div>
                    {selected.image_url && <img src={selected.image_url} alt={selected.title} className="mt-7 max-h-[420px] w-full rounded-2xl border border-[var(--border)] object-cover" />}
                    {selected.summary && <p className="mt-7 rounded-2xl border-l-4 border-[var(--primary)] bg-[var(--primary)]/6 px-5 py-4 text-base font-semibold leading-7 text-[var(--foreground)]">{selected.summary}</p>}
                    <div className="mt-7 whitespace-pre-wrap break-words text-[15px] leading-8 text-[var(--text-secondary)]">{selected.content}</div>
                    {selected.link_url && (
                      <a href={selected.link_url} target="_blank" rel="noopener noreferrer" className="mt-8 inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-semibold text-[var(--primary-foreground)]">
                        {selected.link_text || "查看详情"}<ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    <div className="mt-10 flex items-center justify-between border-t border-[var(--border)] pt-5 text-xs text-[var(--muted-foreground)]">
                      <span>公告编号 {selected.id.slice(0, 8)}</span>
                      <button type="button" onClick={() => { const index = filtered.findIndex(item => item.id === selected.id); const next = filtered[index + 1]; if (next) chooseAnnouncement(next.id); }} disabled={filtered.findIndex(item => item.id === selected.id) >= filtered.length - 1} className="inline-flex items-center gap-1 font-semibold text-[var(--primary)] disabled:opacity-30">下一条 <ChevronRight className="h-4 w-4" /></button>
                    </div>
                  </div>
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
