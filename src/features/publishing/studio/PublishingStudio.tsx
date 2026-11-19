"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CalendarDays, CircleAlert, FileImage, FileText, Film, FolderInput, History, Info, LayoutGrid, Loader2, Plus, RefreshCw, Send, Users, X } from "lucide-react";
import { AppScopedLink } from "@/components/app-scoped-link";
import { handlePlatformBrandLogoError, platformBrandLogoUrl, usePlatformBranding } from "@/hooks/use-platform-branding";
import { usePublishingStudio } from "./usePublishingStudio";
import type { PublishingStudioController, StudioHistoryItem } from "./types";
import { StudioDialog } from "./StudioPrimitives";
import { StudioComposer } from "./StudioComposer";
import { StudioHistoryPanel } from "./StudioHistoryPanel";
import { StudioCalendar } from "./StudioCalendar";
import { AccountsPanel, ImportDialog, PluginStatusPanel } from "./StudioAuxiliary";
import { usePublishingPlugin } from "./usePublishingPlugin";
import { StudioPublishDialogs } from "./StudioPublishDialogs";
import { historyStateGroup, historyStateLabel, platformName } from "./StudioPresentation";
import styles from "./Studio.module.css";
type View = "overview" | "compose" | "accounts" | "history" | "calendar";
const entries = [
  { key: "overview", label: "发布概览", icon: LayoutGrid },
  { key: "compose", label: "新建发布", icon: Plus },
  { key: "calendar", label: "排期日历", icon: CalendarDays },
  { key: "history", label: "发布记录", icon: History },
  { key: "accounts", label: "平台账号", icon: Users },
] as const;
const descriptions: Record<View, string> = { overview: "从同一个工作台准备作品，发到多个平台。", compose: "准备素材和文案，再为各账号检查发布要求。", calendar: "按日期查看发布安排，继续处理原任务。", history: "查看发布进度、平台回执与需要你继续处理的任务。", accounts: "管理创作账号与授权。使用浏览器插件前，请在当前浏览器登录对应平台。" };

export function PublishingStudio({ initialTab = "overview" }: { initialTab?: string }) {
  const work = usePublishingStudio();
  const plugin = usePublishingPlugin();
  const viewport = useRef<HTMLDivElement>(null);
  const pageTitle = useRef<HTMLHeadingElement>(null);
  const branding = usePlatformBranding(), logo = platformBrandLogoUrl(branding, "square");
  const [view, setView] = useState<View>(entries.some(entry => entry.key === initialTab) ? initialTab as View : "overview");
  const [step, setStep] = useState(1);
  const [resetOpen, setResetOpen] = useState(false);
  const { loadHistory } = work;
  useEffect(() => { if (view === "history" && work.session.authenticated) void loadHistory(); }, [view, work.session.authenticated, loadHistory]);
  const hasDraft = !!(work.draft.media.length || work.draft.title.trim() || work.draft.body.trim());
  const navigate = (next: View) => {
    if (next === view) return;
    setView(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab"); else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    viewport.current?.scrollTo({ top: 0, behavior: "instant" });
    requestAnimationFrame(() => pageTitle.current?.focus({ preventScroll: true }));
  };
  const openImport = () => { navigate("compose"); setStep(1); void work.openImport(); };
  const start = (kind: "image" | "video" | "text") => { if (!hasDraft) work.patchDraft({ contentType: kind }); setStep(1); navigate("compose"); };
  return <div ref={viewport} className={styles.root} data-testid="publishing-studio" data-publishing-studio="true" data-studio-theme="light">
    <aside className={styles.sidebar} aria-label="发布门户导航">
      <div className={styles.portalIdentity} data-testid="studio-brand"><span className={styles.portalLogo} data-testid="studio-brand-logo" aria-hidden="true">{logo ? <img src={logo} alt="" onError={event => handlePlatformBrandLogoError(event, branding)} /> : branding.brand.name.slice(0,1)}</span><strong>发布工作台</strong></div>
      <AppScopedLink href="/" className={styles.returnMain} data-testid="studio-return-main"><ArrowLeft size={16} />返回主站</AppScopedLink>
      <nav className={styles.sideNav} aria-label="工作台功能">{entries.map(entry => <button type="button" key={entry.key} aria-current={view === entry.key ? "page" : undefined} className={styles.sideNavItem} data-testid={entry.key === "overview" || entry.key === "calendar" ? `studio-nav-${entry.key}` : `studio-${entry.key}-tab`} onClick={() => navigate(entry.key)}><entry.icon size={18} strokeWidth={1.7} /><span>{entry.label}</span>{entry.key === "compose" && hasDraft && <i className={styles.draftDot} aria-label="有本次编辑内容" />}</button>)}</nav>
      <div className={styles.sidebarBottom}><PluginStatusPanel state={plugin.state} version={plugin.version} onCheck={() => void plugin.check()} /><div className={styles.cashBalance} data-testid="studio-cash-footer"><div className={styles.cashBalanceHead}><span>现金余额</span><strong>{work.session.cashBalance !== undefined ? `¥${work.session.cashBalance.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : work.session.loading ? "读取中…" : "—"}</strong><AppScopedLink href="/recharge" className={styles.cashRecharge}>充值</AppScopedLink></div></div></div>
    </aside>
    <main className={styles.main}>
      <div className={styles.pageHeading}><div><h1 ref={pageTitle} tabIndex={-1}>{view === "overview" ? "发布概览" : entries.find(entry => entry.key === view)?.label}</h1><p>{descriptions[view]}</p>
        {view === "compose" && step < 3 && work.publishing?.executionEnabled === false && (
          <p className={styles.composeAvailability} data-testid="studio-publish-notice" data-execution="disabled" role="status">
            <Info size={14} aria-hidden="true" />当前仅可保存草稿，暂不能提交发布。
          </p>
        )}
      </div>{view === "accounts" && <AppScopedLink href="/plugin-guide" target="_blank" rel="noopener" className={styles.accountTopGuide} data-testid="studio-plugin-guide-link"><BookOpen size={14} />插件安装教程</AppScopedLink>}{(view === "history" || view === "compose") && <div className={styles.headingActions}>{view === "compose" && <><button type="button" className={styles.quietButton} onClick={() => setResetOpen(true)} disabled={!!work.busy || !hasDraft}>清空新建</button></>}{view === "history" && <button type="button" className={styles.button} disabled={!!work.busy || !work.session.authenticated || work.workspace.loading} onClick={() => void work.loadHistory()}><RefreshCw size={15} />刷新记录</button>}</div>}</div>
      {(work.error || work.notice || work.session.error) && <div className={styles.banner} data-tone={work.error || work.session.error ? "error" : "info"} role={work.error || work.session.error ? "alert" : "status"}>{work.error || work.session.error ? <CircleAlert size={17} /> : <Info size={17} />}<span>{work.error || work.session.error || work.notice}</span><button type="button" className={styles.iconButton} aria-label="关闭提示" onClick={work.dismissMessage}><X size={16} /></button></div>}
      {work.busy && <div className={styles.banner} data-tone="info" role="status" data-testid="studio-action-progress"><Loader2 size={17} className={styles.spin} /><span>{work.busy}…</span></div>}
      {work.pending && <div className={styles.banner} data-tone="warning"><History size={17} /><span>上一笔发布结果需要核对。核对完成后再继续新发布。</span><button type="button" className={styles.smallButton} disabled={!!work.busy} onClick={() => void work.recoverPending()}>核对原发布</button></div>}
      {work.session.loading || work.session.authenticated && work.workspace.loading && !work.workspace.ready ? <div className={styles.loading} role="status" data-testid="studio-workspace-loading"><Loader2 size={20} className={styles.spin} />正在读取发布服务…</div> : !work.session.authenticated ? <div className={styles.emptyView}><Send size={36} /><h2>登录后开始发布</h2><p>使用左侧“返回主站”登录，账号与现金余额会同步到这里。</p></div> : !work.workspace.ready ? <div className={styles.emptyView} data-testid="studio-workspace-error"><CircleAlert size={36} /><h2>发布信息暂未读取完成</h2><p>{work.workspace.error || "请重新读取，账号与作品信息会保留。"}</p><button type="button" className={styles.button} disabled={!!work.busy || work.workspace.loading} onClick={() => void work.refreshAccounts()}><RefreshCw size={15} />重新读取</button></div> : <>
        {view === "overview" && <Overview work={work} hasDraft={hasDraft} onStart={start} onContinue={() => navigate("compose")} onImport={openImport} onOpenDraft={id => { setStep(1); navigate("compose"); void work.importItem(id); }} onCalendar={() => navigate("calendar")} onHistory={() => navigate("history")} />}
        {view === "compose" && <StudioComposer work={work} plugin={plugin} step={step} onStep={setStep} onAccounts={() => navigate("accounts")} />}
        {view === "accounts" && <AccountsPanel work={work} plugin={plugin} />}
        {view === "history" && <StudioHistoryPanel work={work} onCompose={() => { setStep(1); navigate("compose"); }} />}
        {view === "calendar" && <StudioCalendar work={work} onCompose={() => { setStep(1); navigate("compose"); }} />}
      </>}
    </main>
    {work.importOpen && <ImportDialog work={work} />}
    <StudioPublishDialogs work={work} />
    {resetOpen && <StudioDialog title="清空当前编辑？" description="已保存的草稿与发布记录会保留，当前未保存内容和本地素材选择会清空。" onClose={() => setResetOpen(false)} footer={<><button type="button" data-studio-focus="true" className={styles.button} onClick={() => setResetOpen(false)}>保留编辑</button><button type="button" className={styles.primaryButton} onClick={() => { work.resetDraft(); setResetOpen(false); setStep(1); navigate("compose"); }}>清空并新建</button></>}><p>开始一份新的发布稿。</p></StudioDialog>}
  </div>;
}

function Overview({ work, hasDraft, onStart, onContinue, onImport, onOpenDraft, onCalendar, onHistory }: {
  work: PublishingStudioController;
  hasDraft: boolean;
  onStart(kind: "image" | "video" | "text"): void;
  onContinue(): void;
  onImport(): void;
  onOpenDraft(id: string): void;
  onCalendar(): void;
  onHistory(): void;
}) {
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [today] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); });
  const nearbyDay = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  const from = nearbyDay(-7).toISOString();
  const to = nearbyDay(2).toISOString();
  useEffect(() => {
    if (dashboardLoaded || !work.session.authenticated || !work.workspace.ready) return;
    setDashboardLoaded(true);
    void work.loadHistory({ from, to, completeRange: true });
    void work.loadImport("draft");
  }, [dashboardLoaded, from, to, work]);

  const historyReady = work.historyPage.range === from + "/" + to && !work.historyLoading && !work.historyPage.rangeError;
  const historyNote = work.historyPage.rangeError ? "读取失败，可前往发布记录重新查看。" : "正在读取发布安排…";
  const records = historyReady ? work.history : [];
  const tomorrow = nearbyDay(1).getTime();
  const timeValue = (value?: string) => value ? Date.parse(value) : NaN;
  const timeLabel = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const todayQueue = records.filter(item => {
    const time = timeValue(item.publishAt);
    return time >= today.getTime() && time < tomorrow && historyStateGroup(item.state) === "progress";
  }).sort((left, right) => timeValue(left.publishAt) - timeValue(right.publishAt));
  const needsAttention = records.filter(item => historyStateGroup(item.state) === "verify"
    || ["failed", "failed_known", "rejected", "blocked"].includes(item.state));
  const drafts = work.importItems.filter(item => item.kind === "draft").slice(0, 3);

  function renderQueue(items: StudioHistoryItem[], empty: string) {
    if (!items.length) return <p className={styles.dashEmpty}>{historyReady ? empty : historyNote}</p>;
    return <ul className={styles.dashList}>{items.slice(0, 4).map(item => (
      <li key={item.id}><button type="button" className={styles.dashRow} disabled={!!work.busy || !item.availableActions?.includes("refresh")} onClick={() => void work.refreshRecord(item.id)}>
        <span className={styles.dashCopy}><strong>{item.title || "未命名发布"}</strong><small>{item.accountName || platformName(work, item.platform)} {timeLabel(item.publishAt)}</small></span>
        <span className={styles.status} data-state={item.state}>{historyStateLabel(item.state, !!item.url)}</span>
      </button></li>
    ))}</ul>;
  }

  return <div className={styles.overview} data-testid="studio-overview">
    <div className={styles.overviewShortcuts}>
      {!hasDraft && <>
      <button type="button" className={styles.button} data-kind="video" onClick={() => onStart("video")}><Film size={16} />发布视频</button>
      <button type="button" className={styles.button} data-kind="image" onClick={() => onStart("image")}><FileImage size={16} />发布图文</button>
      <button type="button" className={styles.button} data-kind="text" onClick={() => onStart("text")}><FileText size={16} />发布文字</button>
      </>}
      <button type="button" className={styles.button} data-testid="studio-import-button" onClick={onImport} disabled={!!work.busy}><FolderInput size={16} />导入作品或草稿</button>
    </div>
    <section className={styles.dashboard} data-testid="studio-overview-dashboard">
      <article className={styles.dashCard}>
        <header className={styles.dashHead}><h3>继续草稿</h3>{hasDraft && <button type="button" onClick={onContinue}>继续编辑<ArrowRight size={13} /></button>}</header>
        {hasDraft && <button type="button" className={styles.dashDraft} onClick={onContinue}><span className={styles.dashDraftIcon}><FileText size={16} /></span><span className={styles.dashCopy}><strong>{work.draft.title || "尚未命名的作品"}</strong><small>当前编辑 · {work.draft.media.length} 个素材</small></span><ArrowRight size={14} /></button>}
        {!hasDraft && drafts.length > 0 && <ul className={styles.dashList}>{drafts.map(item => <li key={item.id}><button type="button" className={styles.dashRow} disabled={!!work.busy} onClick={() => onOpenDraft(item.id)}><span className={styles.dashCopy}><strong>{item.title}</strong><small>{timeLabel(item.createdAt)}</small></span><ArrowRight size={14} /></button></li>)}</ul>}
        {!hasDraft && !drafts.length && <p className={styles.dashEmpty}>{work.importLoading ? "正在读取草稿…" : work.importError || "还没有已保存的草稿。"}</p>}
      </article>
      <article className={styles.dashCard}>
        <header className={styles.dashHead}><h3>今天要发</h3><button type="button" onClick={onCalendar}>排期日历<ArrowRight size={13} /></button></header>
        {renderQueue(todayQueue, "今天没有待执行的排期。")}
      </article>
      <article className={styles.dashCard}>
        <header className={styles.dashHead}><h3>近期待你处理</h3><button type="button" onClick={onHistory}>发布记录<ArrowRight size={13} /></button></header>
        {renderQueue(needsAttention, "近一周没有需要处理的记录。")}
      </article>
    </section>
  </div>;
}
