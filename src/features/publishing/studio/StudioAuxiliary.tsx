"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { FileImage, FileText, Film, Link2, Loader2, Plug, RefreshCw, Users } from "lucide-react";
import type { PublishingStudioController } from "./types";
import { dateText, StudioDialog } from "./StudioPrimitives";
import { AccountMark, platformOrder } from "./StudioPresentation";
import type { PublishingPluginState } from "./usePublishingPlugin";
import styles from "./Studio.module.css";

export function PluginStatusPanel({ state, onCheck }: { state: PublishingPluginState; onCheck: () => void }) {
  const label = state === "checking" ? "检测中…" : state === "present" ? "已检测到" : state === "unauthorized" ? "待授权" : "未检测到";
  return <div className={styles.sidebarPlugin} data-state={state} data-testid="studio-plugin-status">
    <div className={styles.sidebarPluginHead}><span className={styles.sidebarPluginIcon}><Plug size={14} /></span><span>发布插件</span><strong>{label}</strong></div>
    <div className={styles.sidebarPluginActions}><button type="button" data-testid="studio-plugin-recheck" onClick={onCheck} disabled={state === "checking"}><RefreshCw size={12} />{state === "checking" ? "检测中…" : "重新检测"}</button></div>
  </div>;
}

export function AccountsPanel({ work }: { work: PublishingStudioController }) {
  const visiblePlatforms = [...work.platforms].sort((a, b) => platformOrder(a.key, b.key));
  return <>
    {work.workspace.loading ? <div className={styles.loading}><Loader2 size={19} className={styles.spin} />正在读取发布服务…</div> : visiblePlatforms.length ? <div className={styles.platformGrid}>{visiblePlatforms.map(platform => {
      const accounts = work.accounts.filter(account => account.platform === platform.key && account.kind !== "browser");
      const needsAuthorization = accounts.some(account => account.status !== "ready");
      const officialChannel = platform.channels?.find(channel => channel.transport === "official_api" && channel.connectionAllowed);
      const canConnect = platform.connectionAllowed;
      const notDeveloped = platform.executionBlocked === true;
      return <section className={styles.platformCard} data-state={accounts.length ? needsAuthorization ? "attention" : "connected" : "unconnected"} data-multi={accounts.length > 1 ? "true" : "false"} data-testid={`studio-platform-${platform.key}`} key={platform.key}>
        <div className={styles.platformCardHeader}><span className={styles.accountMark}>{platform.name.slice(0, 1)}</span><h2>{platform.name}</h2><span className={styles.platformConnectionState}>{accounts.length ? `${accounts.length} 个账号` : canConnect ? "未连接" : notDeveloped ? "尚未接入" : "暂不可连接"}</span></div>
        <div className={styles.platformCardBody}>
          {accounts.length ? <div className={styles.platformAccounts}>{accounts.map(account => {
            const transport = "official_api";
            const connectionAllowed = platform.channels?.find(channel => channel.transport === transport)?.connectionAllowed ?? platform.connectionAllowed;
            return <div key={account.id} className={styles.platformAccount}><AccountMark account={account} /><div><strong>{account.name}</strong><small>{platform.key === "douyin" ? "官方授权 · 手机接力" : "官方授权"}</small><span className={styles.accountConnectionBadge} data-ready={account.status === "ready"}>{account.status === "ready" ? "已连接" : "授权需更新"}</span></div>{account.status !== "ready" && <button type="button" className={styles.accountReconnect} disabled={!!work.busy || !connectionAllowed} onClick={() => void work.connectAccount(platform.key, transport)}>重新授权</button>}</div>;
          })}</div> : <div className={styles.platformCardEmpty}><span>尚未连接账号</span><small>{canConnect ? "连接后在这里管理账号与授权" : notDeveloped ? "该平台发布通道尚未接入" : platform.nativeReason || platform.reason || "该平台暂不可连接"}</small></div>}
        </div>
        <div className={styles.platformCardFooter}>
          <button type="button" className={`${accounts.length ? styles.button : styles.primaryButton} ${styles.platformCardAction}`} data-testid={`studio-connect-${platform.key}`} disabled={!!work.busy || !canConnect} onClick={() => { if (canConnect) void work.connectAccount(platform.key, officialChannel ? "official_api" : undefined); }}><Link2 size={15} />{accounts.length ? "添加另一个账号" : canConnect ? "连接账号" : "暂不可连接"}</button>
        </div>
      </section>;
    })}</div> : <div className={styles.emptyView}><Users size={36} /><h2>暂未读取到可连接的平台</h2><p>请刷新账号，按发布服务返回的实际能力继续。</p><button type="button" className={styles.button} onClick={() => void work.refreshAccounts()} disabled={!!work.busy}><RefreshCw size={15} />重新读取</button></div>}
  </>;
}



export function ImportDialog({ work }: { work: PublishingStudioController }) { const [kind, setKind] = useState<"media" | "draft">("media"); return <StudioDialog title="导入已有内容" description="选择后才会放入本次发布稿。导入草稿会替换当前编辑内容。" onClose={work.closeImport} testId="studio-import-dialog" wide footer={<button type="button" className={styles.button} onClick={work.closeImport}>取消导入</button>}><div className={styles.importTabs}><button type="button" className={styles.smallButton} aria-pressed={kind === "media"} disabled={work.importLoading || !!work.busy} onClick={() => { setKind("media"); void work.loadImport("media"); }}><FileImage size={14} />我的作品</button><button type="button" className={styles.smallButton} aria-pressed={kind === "draft"} disabled={work.importLoading || !!work.busy} onClick={() => { setKind("draft"); void work.loadImport("draft"); }}><FileText size={14} />发布草稿</button></div>{work.importLoading ? <div className={styles.loading}><Loader2 size={19} className={styles.spin} />正在读取可导入内容…</div> : work.importItems.length ? <div className={styles.importGrid}>{work.importItems.map(item => <button type="button" className={styles.importItem} key={item.id} disabled={!!work.busy} onClick={() => void work.importItem(item.id)}><div className={styles.importPreview}>{item.thumbnail ? <img src={item.thumbnail} alt="" /> : item.kind === "video" ? <Film size={28} /> : item.kind === "draft" ? <FileText size={28} /> : <FileImage size={28} />}</div><strong>{item.title || "未命名内容"}</strong><small>{item.kind === "video" ? "视频" : item.kind === "draft" ? "发布草稿" : "图片"}{item.createdAt ? ` · ${dateText(item.createdAt)}` : ""}</small></button>)}</div> : <div className={styles.dialogEmpty}>没有可导入的{kind === "draft" ? "发布草稿" : "作品"}。你也可以直接选择本地文件。</div>}</StudioDialog>; }
