"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CalendarDays, CircleAlert, FileImage, FileText, Film, FolderInput, History, Info, LayoutGrid, Loader2, Plus, RefreshCw, Save, Send, Users, X } from "lucide-react";
import { AppScopedLink } from "@/components/app-scoped-link";
import { handlePlatformBrandLogoError, platformBrandLogoUrl, usePlatformBranding } from "@/hooks/use-platform-branding";
import { usePublishingStudio } from "./usePublishingStudio";
import type { PublishingStudioController, StudioHistoryItem } from "./types";
import { BusyLabel, StudioDialog } from "./StudioPrimitives";
import { StudioComposer } from "./StudioComposer";
import { StudioHistoryPanel } from "./StudioHistoryPanel";
import { StudioCalendar } from "./StudioCalendar";
import { AccountsPanel, ImportDialog, PluginStatusPanel } from "./StudioAuxiliary";
import { usePublishingPlugin } from "./usePublishingPlugin";
import { StudioPublishDialogs } from "./StudioPublishDialogs";
import { AccountMark, historyStateLabel, platformName } from "./StudioPresentation";
import styles from "./Studio.module.css";
type View = "overview" | "compose" | "accounts" | "history" | "calendar";
const entries = [
  { key: "overview", label: "发布概览", icon: LayoutGrid },
  { key: "compose", label: "新建发布", icon: Plus },
  { key: "calendar", label: "排期日历", icon: CalendarDays },
  { key: "history", label: "发布记录", icon: History },
  { key: "accounts", label: "平台账号", icon: Users },
] as const;
const descriptions: Record<View, string> = { overview: "让每一份作品，有条不紊地抵达读者。", compose: "从作品到发布，一步一步准备好。", calendar: "按日期查看发布安排，继续处理原任务。", history: "查看发布进度、平台回执与需要你继续处理的任务。", accounts: "连接创作账号，按当前通道能力安排发布。" };

export function PublishingStudio({ initialTab = "overview" }: { initialTab?: string }) {
  const work = usePublishingStudio();
  const plugin = usePublishingPlugin();
  const branding = usePlatformBranding(), logo = platformBrandLogoUrl(branding, "square");
  const [view, setView] = useState<View>(entries.some(entry => entry.key === initialTab) ? initialTab as View : "overview");
  const [step, setStep] = useState(1);
  const [resetOpen, setResetOpen] = useState(false);
  const { loadHistory } = work;
  useEffect(() => { if (view === "history" && work.session.authenticated) void loadHistory(); }, [view, work.session.authenticated, loadHistory]);
  const hasDraft = !!(work.draft.media.length || work.draft.title.trim() || work.draft.body.trim());
  const navigate = (next: View) => { setView(next); const url = new URL(window.location.href); if (next === "overview") url.searchParams.delete("tab"); else url.searchParams.set("tab", next); window.history.replaceState(null, "", `${url.pathname}${url.search}`); };
  const openImport = () => { navigate("compose"); setStep(1); void work.openImport(); };
  const start = (kind: "image" | "video" | "text") => { if (!hasDraft) work.patchDraft({ contentType: kind }); setStep(1); navigate("compose"); };
  return <div className={styles.root} data-testid="publishing-studio" data-publishing-studio="true" data-studio-theme="light">
    <aside className={styles.sidebar} aria-label="发布门户导航">
      <div className={styles.portalIdentity} data-testid="studio-brand"><span className={styles.portalLogo} data-testid="studio-brand-logo" aria-hidden="true">{logo ? <img src={logo} alt="" onError={event => handlePlatformBrandLogoError(event, branding)} /> : branding.brand.name.slice(0,1)}</span><strong>发布工作台</strong></div>
      <AppScopedLink href="/" className={styles.returnMain} data-testid="studio-return-main"><ArrowLeft size={16} />返回主站</AppScopedLink>
      <nav className={styles.sideNav} aria-label="工作台功能">{entries.map(entry => <button type="button" key={entry.key} aria-current={view === entry.key ? "page" : undefined} className={styles.sideNavItem} data-testid={entry.key === "overview" || entry.key === "calendar" ? `studio-nav-${entry.key}` : `studio-${entry.key}-tab`} onClick={() => navigate(entry.key)}><entry.icon size={18} strokeWidth={1.7} /><span>{entry.label}</span>{entry.key === "compose" && hasDraft && <i className={styles.draftDot} aria-label="有本次编辑内容" />}</button>)}</nav>
      <div className={styles.sidebarBottom}><PluginStatusPanel state={plugin.state} lastIssue={plugin.lastIssue} onCheck={() => void plugin.check()} /><div className={styles.cashBalance} data-testid="studio-cash-footer"><div className={styles.cashBalanceHead}><span>现金余额</span><strong>{work.session.cashBalance !== undefined ? `¥${work.session.cashBalance.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : work.session.loading ? "读取中…" : "—"}</strong><AppScopedLink href="/recharge" className={styles.cashRecharge}>充值</AppScopedLink></div></div></div>
    </aside>
    <main className={styles.main}>
      <div className={styles.pageHeading}><div>{view === "overview" && <span className={styles.pageEyebrow}>你的创作，正在发生</span>}<h1>{view === "overview" ? "从这里，发布好作品" : entries.find(entry => entry.key === view)?.label}</h1><p>{descriptions[view]}</p></div>{view === "accounts" && <AppScopedLink href="/plugin-guide" className={styles.accountTopGuide} data-testid="studio-plugin-guide-link"><BookOpen size={14} />插件安装教程</AppScopedLink>}<div className={styles.headingActions}>{view === "compose" && <><button type="button" className={styles.quietButton} onClick={() => setResetOpen(true)} disabled={!!work.busy || !hasDraft}>清空新建</button><button type="button" className={styles.button} onClick={() => void work.saveDraft()} disabled={!!work.busy || !work.session.authenticated || !hasDraft}><BusyLabel busy={work.busy === "save"}><Save size={16} />保存发布草稿</BusyLabel></button></>}{view === "history" && <button type="button" className={styles.button} disabled={!!work.busy || !work.session.authenticated || work.workspace.loading} onClick={() => void work.loadHistory()}><RefreshCw size={15} />刷新记录</button>}</div></div>
      {(work.error || work.notice || work.session.error) && <div className={styles.banner} data-error={!!(work.error || work.session.error)} role={work.error || work.session.error ? "alert" : "status"}><CircleAlert size={17} /><span>{work.error || work.session.error || work.notice}</span><button type="button" className={styles.iconButton} aria-label="关闭提示" onClick={work.dismissMessage}><X size={16} /></button></div>}
      {work.pending && <div className={styles.banner} data-error="true"><History size={17} /><span>上一笔发布结果需要核对。核对完成后再继续新发布。</span><button type="button" className={styles.smallButton} disabled={!!work.busy} onClick={() => void work.recoverPending()}>核对原发布</button></div>}
      {work.publishing && !work.publishing.executionEnabled && <div className={styles.publishNotice} data-testid="studio-publish-notice" data-execution="disabled" role="status"><Info size={17} /><span>发布执行已关闭，当前可整理内容与保存草稿，不会向外部平台提交作品。</span></div>}
      {work.session.loading || work.session.authenticated && work.workspace.loading && !work.workspace.ready ? <div className={styles.loading} role="status" data-testid="studio-workspace-loading"><Loader2 size={20} className={styles.spin} />正在读取发布服务…</div> : !work.session.authenticated ? <div className={styles.emptyView}><Send size={36} /><h2>登录后开始发布</h2><p>使用左侧“返回主站”登录，账号与现金余额会同步到这里。</p></div> : !work.workspace.ready ? <div className={styles.emptyView} data-testid="studio-workspace-error"><CircleAlert size={36} /><h2>发布信息暂未读取完成</h2><p>{work.workspace.error || "请重新读取，账号与作品信息会保留。"}</p><button type="button" className={styles.button} disabled={!!work.busy || work.workspace.loading} onClick={() => void work.refreshAccounts()}><RefreshCw size={15} />重新读取</button></div> : <>
        {view === "overview" && <Overview work={work} hasDraft={hasDraft} onStart={start} onContinue={() => navigate("compose")} onImport={openImport} onAccounts={() => navigate("accounts")} onCalendar={() => navigate("calendar")} onHistory={() => navigate("history")} />}
        {view === "compose" && <StudioComposer work={work} step={step} onStep={setStep} onAccounts={() => navigate("accounts")} />}
        {view === "accounts" && <AccountsPanel work={work} pluginState={plugin.state} />}
        {view === "history" && <StudioHistoryPanel work={work} onCompose={() => { setStep(1); navigate("compose"); }} />}
        {view === "calendar" && <StudioCalendar work={work} onCompose={() => { setStep(1); navigate("compose"); }} />}
      </>}
    </main>
    {work.importOpen && <ImportDialog work={work} />}
    <StudioPublishDialogs work={work} />
    {resetOpen && <StudioDialog title="清空当前编辑？" description="已保存的草稿与发布记录会保留，当前未保存内容和本地素材选择会清空。" onClose={() => setResetOpen(false)} footer={<><button type="button" data-studio-focus="true" className={styles.button} onClick={() => setResetOpen(false)}>保留编辑</button><button type="button" className={styles.primaryButton} onClick={() => { work.resetDraft(); setResetOpen(false); setStep(1); navigate("compose"); }}>清空并新建</button></>}><p>开始一份新的发布稿。</p></StudioDialog>}
  </div>;
}

function Overview({ work, hasDraft, onStart, onContinue, onImport, onAccounts, onCalendar, onHistory }: { work: PublishingStudioController; hasDraft: boolean; onStart(kind: "image" | "video" | "text"): void; onContinue(): void; onImport(): void; onAccounts(): void; onCalendar(): void; onHistory(): void }) {
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  useEffect(() => {
    if (dashboardLoaded || !work.session.authenticated || !work.workspace.ready) return;
    setDashboardLoaded(true);
    const now = Date.now();
    void work.loadHistory({ page: 1, pageSize: 100, from: new Date(now - 30 * 86_400_000).toISOString(), to: new Date(now + 30 * 86_400_000).toISOString() }).catch(() => undefined);
    void work.loadImport("draft").catch(() => undefined);
  }, [dashboardLoaded, work]);
  const [now] = useState(() => Date.now());
  const timeValue = (value?: string) => { const time = value ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : 0; };
  const timeLabel = (value?: string) => { const time = timeValue(value); return time ? new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : ""; };
  const stateLabel = (item: StudioHistoryItem) => historyStateLabel(item.state, !!item.url);
  const queue = work.history.filter(item => { const time = timeValue(item.publishAt); return time >= now - 60_000 && time <= now + 7 * 86_400_000; }).sort((left, right) => timeValue(left.publishAt) - timeValue(right.publishAt)).slice(0, 4);
  const recent = [...work.history].sort((left, right) => Math.max(timeValue(right.createdAt), timeValue(right.publishAt)) - Math.max(timeValue(left.createdAt), timeValue(left.publishAt))).slice(0, 4);
  const drafts = work.importItems.filter(item => item.kind === "draft").slice(0, 3);
  const readyAccounts = work.accounts.filter(account => account.status === "ready").length;
  const attentionAccounts = work.accounts.length - readyAccounts;
  return <div className={styles.overview} data-testid="studio-overview"><section className={styles.startSurface}><div className={styles.startCopy}><span className={styles.sectionKicker}>准备一份新发布</span><h2>让作品走向<br />更多人的日常。</h2><p>选入成片或图片，按平台调整内容，<br />安排一个合适的发布时间。</p></div><div className={styles.startChoices}>{hasDraft ? <div className={styles.currentDraft}><span className={styles.sectionKicker}>本次正在编辑</span><h3>{work.draft.title || "尚未命名的作品"}</h3><p>{work.draft.media.length} 个素材 · {work.accounts.filter(account => account.selected).length} 个已选账号</p><button type="button" className={styles.primaryButton} onClick={onContinue}>继续准备作品<ArrowRight size={17} /></button></div> : <><button type="button" className={styles.startChoice} data-kind="video" onClick={() => onStart("video")}><span className={styles.startChoiceIcon}><Film size={25} strokeWidth={1.4} /></span><span><strong>发布视频作品</strong><small>选入剪映导出的 MP4 成片</small></span><ArrowRight size={18} /></button><button type="button" className={styles.startChoice} data-kind="image" onClick={() => onStart("image")}><span className={styles.startChoiceIcon}><FileImage size={25} strokeWidth={1.4} /></span><span><strong>发布图文作品</strong><small>用图片与文字记录这一刻</small></span><ArrowRight size={18} /></button><button type="button" className={styles.startChoice} data-kind="text" onClick={() => onStart("text")}><span className={styles.startChoiceIcon}><FileText size={25} strokeWidth={1.4} /></span><span><strong>发布文字内容</strong><small>为支持文字的平台写一段新内容</small></span><ArrowRight size={18} /></button></>}<button type="button" className={styles.importEntry} data-testid="studio-import-button" onClick={onImport} disabled={!!work.busy}><FolderInput size={17} /><span>从已有作品或发布草稿导入</span><ArrowRight size={15} /></button></div></section><div className={`${styles.overviewBottom} ${styles.overviewJourney}`}><div className={styles.journeyNote}><span>01<span>准备作品<small>选素材、写公共文案</small></span></span><i /><span>02<span>适配平台<small>选账号、按平台微调</small></span></span><i /><span>03<span>安排发布<small>定时或立即，确认后执行</small></span></span></div></div>
    <section className={styles.dashboard} data-testid="studio-overview-dashboard">
      <article className={styles.dashCard}>
        <header className={styles.dashHead}><h3>本周发布队列</h3><button type="button" onClick={onCalendar}>排期日历<ArrowRight size={13} /></button></header>
        {queue.length ? <ul className={styles.dashList}>{queue.map(item => <li key={item.id}><button type="button" className={styles.dashRow} onClick={() => void work.refreshRecord(item.id)} disabled={!!work.busy}><span className={styles.dashPlatform}>{platformName(work, item.platform).slice(0, 1)}</span><span className={styles.dashCopy}><strong>{item.title || "未命名发布"}</strong><small>{item.accountName || platformName(work, item.platform)} · {timeLabel(item.publishAt)}</small></span><span className={styles.dashState} data-state={item.state}>{stateLabel(item)}</span></button></li>)}</ul> : <p className={styles.dashEmpty}>未来 7 天没有排期。准备一份新发布，或到排期日历查看更早安排。</p>}
      </article>
      <article className={styles.dashCard}>
        <header className={styles.dashHead}><h3>最近发布</h3><button type="button" onClick={onHistory}>发布记录<ArrowRight size={13} /></button></header>
        {recent.length ? <ul className={styles.dashList}>{recent.map(item => <li key={item.id}><button type="button" className={styles.dashRow} onClick={() => void work.refreshRecord(item.id)} disabled={!!work.busy}><span className={styles.dashPlatform}>{platformName(work, item.platform).slice(0, 1)}</span><span className={styles.dashCopy}><strong>{item.title || "未命名发布"}</strong><small>{platformName(work, item.platform)}{item.accountName ? ` · ${item.accountName}` : ""} · {timeLabel(item.createdAt || item.publishAt)}</small></span><span className={styles.dashState} data-state={item.state}>{stateLabel(item)}</span></button></li>)}</ul> : <p className={styles.dashEmpty}>还没有发布记录。确认发布后，平台回执会出现在这里。</p>}
      </article>
      <article className={styles.dashCard}>
        <header className={styles.dashHead}><h3>发布草稿</h3><button type="button" onClick={onImport}>导入作品<ArrowRight size={13} /></button></header>
        {hasDraft && <button type="button" className={styles.dashDraft} onClick={onContinue}><span className={styles.dashDraftIcon}><FileText size={16} /></span><span className={styles.dashCopy}><strong>{work.draft.title || "尚未命名的作品"}</strong><small>本次编辑 · {work.draft.media.length} 个素材 · {work.accounts.filter(account => account.selected).length} 个目标账号</small></span><ArrowRight size={14} /></button>}
        {drafts.length ? <ul className={styles.dashList}>{drafts.map(item => <li key={item.id}><div className={styles.dashRow}><span className={styles.dashDraftIcon}>{item.thumbnail ? <img src={item.thumbnail} alt="" /> : <FileText size={16} />}</span><span className={styles.dashCopy}><strong>{item.title || "未命名草稿"}</strong><small>已保存草稿{item.createdAt ? ` · ${timeLabel(item.createdAt)}` : ""}</small></span></div></li>)}</ul> : !hasDraft ? <p className={styles.dashEmpty}>没有已保存的发布草稿。新建发布或从已有作品导入。</p> : null}
      </article>
      <article className={styles.dashCard}>
        <header className={styles.dashHead}><h3>平台账号</h3><button type="button" onClick={onAccounts}>管理账号<ArrowRight size={13} /></button></header>
        {work.accounts.length ? <ul className={styles.dashList}>{work.accounts.slice(0, 4).map(account => <li key={account.id}><div className={styles.dashRow}><AccountMark account={account} /><span className={styles.dashCopy}><strong>{account.name}</strong><small>{platformName(work, account.platform)} · {account.kind === "browser" ? "浏览器通道" : "官方授权"}</small></span><span className={styles.dashAccountState} data-ready={account.status === "ready"}>{account.status === "ready" ? "已连接" : "需更新授权"}</span></div></li>)}</ul> : <p className={styles.dashEmpty}>还没有连接创作账号。连接后即可为作品选择发布平台。</p>}
        <p className={styles.dashMeta}>{work.accounts.length ? `${readyAccounts} 个账号可发布${attentionAccounts > 0 ? ` · ${attentionAccounts} 个需要重新授权` : ""}` : "支持 14 个官方平台与浏览器发布通道"}</p>
      </article>
    </section><p className={styles.overviewNote}>发布前会自动核对平台要求；确认后才传输素材并提交，未确认不会发出作品。发布记录与平台回执可在“发布记录”中随时核对。</p></div>;
}
