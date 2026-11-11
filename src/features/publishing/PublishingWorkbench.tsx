"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarDays, CheckCircle2, CircleAlert, CloudDownload, FolderOpen, History, Package, Plug, RefreshCw, Send, Settings, X } from "lucide-react";
import { SubPageHeader } from "@/components/sub-page-header";
import { AppScopedLink } from "@/components/app-scoped-link";
import { useApp } from "@/contexts/app-context";
import { resolveWorkbenchIdentity, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import { useNativePublishing } from "./native/useNativePublishing";
import { PublishEditor } from "./native/PublishEditor";
import { ContentLibrary } from "./native/ContentLibrary";
import { AccountManager } from "./native/AccountManager";
import { ScheduleBoard } from "./native/ScheduleBoard";
import { HistoryPanel } from "./native/HistoryPanel";
import { PluginSetup } from "./native/PluginSetup";
import { PlansView } from "./native/PlansView";
import styles from "./PublishingWorkbench.module.css";

const views = [{ key: "compose", label: "发布编辑", Icon: Send }, { key: "library", label: "内容库", Icon: FolderOpen }, { key: "accounts", label: "账号与分组", Icon: Plug }, { key: "calendar", label: "排期日历", Icon: CalendarDays }, { key: "history", label: "发布记录", Icon: History }, { key: "plans", label: "套餐与额度", Icon: Package }, { key: "settings", label: "安装与设置", Icon: Settings }] as const;
type View = typeof views[number]["key"];
const parseView = (value: string | null): View => views.some(item => item.key === value) ? value as View : "compose";

export function PublishingWorkbench() {
  const { state } = useApp(); const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <div className={`secondary-workbench ${styles.root}`} data-publishing-workbench=""><SubPageHeader title="发布中心" icon={<Send size={20} />} /><main className={styles.signedOut}><span className={styles.emptyIcon}><Send size={30} /></span><h2>让好作品，抵达更多人</h2><p>登录后整理图文与成片，保存内容集合、账号分组和浏览器执行计划。</p><AppScopedLink href="/" className={styles.primaryLink}>返回主页登录</AppScopedLink></main></div>;
  return <Suspense fallback={<div className={styles.root}><SubPageHeader title="发布中心" /><div className={styles.tableEmpty}>正在准备原生发布工作台…</div></div>}><NativeWorkbench key={identity.userId} identity={identity} /></Suspense>;
}

function NativeWorkbench({ identity }: { identity: WorkbenchIdentity }) {
  const params = useSearchParams(); const [view, setView] = useState<View>(() => parseView(params.get("tab"))); const work = useNativePublishing(identity);
  useEffect(() => { setView(parseView(params.get("tab"))); }, [params]);
  const navigate = (next: View) => { setView(next); const url = new URL(window.location.href); url.searchParams.set("tab", next); window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); };
  const remaining = work.center?.entitlements.filter(item => Date.parse(item.expiresAt) > Date.now()).reduce((sum, item) => sum + Math.max(0, item.quota - item.used), 0) || 0;
  return <div className={`secondary-workbench ${styles.root}`} data-publishing-workbench="" data-native-publishing="2"><SubPageHeader title="发布中心" subtitle="内容准备 · 多账号发布 · 浏览器执行" icon={<Send size={20} />} rightSlot={<div className={styles.headerActions}><button type="button" disabled={!!work.busy} onClick={() => void work.run("刷新工作台", work.refresh)} title="刷新工作台"><RefreshCw size={14} /></button><button type="button" className={styles.downloadButton} onClick={() => navigate("settings")}><CloudDownload size={17} />下载发布插件</button></div>} />
    <main className={styles.main}><section className={styles.overview}><div><span className={styles.eyebrow}>CONTENT PUBLISHING WORKSPACE</span><h2>作品准备好，发布就从这里开始</h2><p>整理内容与素材 → 选择平台账号 → 定制原生参数 → 核对并提交</p></div><div className={styles.overviewMeta}><div><small>我的内容</small><strong>{work.drafts.length}</strong></div><div><small>账号摘要</small><strong>{work.center?.accounts.length || 0}</strong></div><div><small>可用额度</small><strong>{remaining}<small style={{ display: "inline", fontSize: 11 }}> 次</small></strong></div></div></section>
      <nav className={styles.tabs} role="tablist" aria-label="发布中心视图">{views.map(({ key, label, Icon }) => <button type="button" role="tab" key={key} aria-selected={view === key} onClick={() => navigate(key)}><Icon size={14} />{label}</button>)}<span className={styles.serviceStatus}><i data-ready={!!work.center?.config.executionEnabled} />{work.loading ? "正在连接" : work.center?.config.executionEnabled ? "浏览器执行已开放" : "先准备，保存草稿"}</span></nav>
      {(work.error || work.notice) && <div className={work.error ? styles.error : styles.notice} role={work.error ? "alert" : "status"}>{work.error ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}<span>{work.error || work.notice}</span><button type="button" aria-label="关闭提示" onClick={() => { work.setError(""); work.setNotice(""); }}><X size={15} /></button></div>}
      {!work.loading && !work.ready && <div className={styles.warning}><CircleAlert size={17} /><span>内容工作台数据结构尚未就绪。可查看安装指南；写入与执行将在实际服务就绪后开放。</span></div>}
      {work.center && !work.center.access.allowed && <div className={styles.warning}>{work.center.access.message}</div>}
      {(work.pending || work.legacyPending || !work.pendingLoaded) && <div className={styles.warning}><History size={17} /><div><strong>有一笔原提交需要核对</strong><p>{work.legacyPending ? "检测到早期工作台待核对记录，已暂停新执行。请保留浏览器数据并核对原任务。" : work.pending?.report ? "浏览器报告已保留，可以同步原报告；不会重新发布。" : "原提交结果尚未明确，请查询原任务与平台作品；不会自动重发。"}</p></div>{work.pending && <button type="button" disabled={!!work.busy} onClick={() => void work.run("核对原提交", work.syncPending)}>核对原提交</button>}</div>}
      {view === "compose" && <PublishEditor work={work} onHistory={() => navigate("history")} onAccounts={() => navigate("accounts")} />}
      {view === "library" && <div style={{ marginTop: 20 }}><ContentLibrary work={work} onEdit={() => navigate("compose")} /><p className={styles.hint}>早期草稿和发布历史保留在原数据槽，原发布记录可在“发布记录 → 早期历史”只读查看。</p></div>}
      {view === "accounts" && <AccountManager work={work} openSetup={() => navigate("settings")} />}
      {view === "calendar" && <ScheduleBoard work={work} onEdit={() => navigate("compose")} />}
      {view === "history" && <HistoryPanel work={work} />}
      {view === "plans" && <PlansView work={work} />}
      {view === "settings" && <PluginSetup work={work} />}
    </main>
  </div>;
}
