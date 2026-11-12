"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { FileImage, FileText, Film, Link2, Loader2, Plug, RefreshCw, Users } from "lucide-react";
import type { PublishingStudioController, StudioPlatform } from "./types";
import { dateText, StudioDialog } from "./StudioPrimitives";
import { AccountMark, platformOrder } from "./StudioPresentation";
import { PUBLISHING_PLUGIN_DOWNLOADS } from "@/lib/publishing-native";
import type { PublishingPluginState } from "./usePublishingPlugin";
import styles from "./Studio.module.css";

export function PluginStatusPanel({ state, onCheck }: { state: PublishingPluginState; onCheck: () => void }) {
  const label = state === "checking" ? "检测中…" : state === "present" ? "已就绪" : state === "unauthorized" ? "待授权" : "未安装";
  return <div className={styles.sidebarPlugin} data-state={state} data-testid="studio-plugin-status">
    <div className={styles.sidebarPluginHead}><span className={styles.sidebarPluginIcon}><Plug size={14} /></span><span>发布插件</span><strong>{label}</strong></div>
    <p>{state === "present" ? "浏览器类平台可以连接。" : state === "checking" ? "正在检测当前浏览器。" : state === "unauthorized" ? "请在插件中选择仅授权本站，然后重新检测。" : "浏览器类平台需要安装插件后才能连接。"}</p>
    <div className={styles.sidebarPluginActions}>
      {state === "missing" && <a href={PUBLISHING_PLUGIN_DOWNLOADS.direct} download={`aitoearn-extension-v${PUBLISHING_PLUGIN_DOWNLOADS.version}.crx`}>下载最新版</a>}
      <button type="button" onClick={onCheck} disabled={state === "checking"}><RefreshCw size={12} />重新检测</button>
    </div>
  </div>;
}

export function AccountsPanel({ work, pluginState }: { work: PublishingStudioController; pluginState: PublishingPluginState }) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const chosen = work.platforms.find(item => item.key === connecting);
  const platformUsesBrowser = (platform: StudioPlatform | undefined) =>
    platform?.channels?.some(channel => channel.transport === "browser_plugin" && channel.connectionAllowed)
    ?? platform?.transport === "browser_plugin";
  const connect = (platformKey: string, transport?: "browser_plugin" | "official_api") => {
    const platform = work.platforms.find(item => item.key === platformKey);
    if (pluginState === "missing" && (transport === "browser_plugin" || (!transport && platformUsesBrowser(platform)))) {
      window.location.assign(PUBLISHING_PLUGIN_DOWNLOADS.guide);
      return;
    }
    void work.connectAccount(platformKey, transport);
  };
  const visiblePlatforms = [...work.platforms]
    .filter(platform => platform.connectionAllowed && (platform.channels?.some(channel => channel.publishAllowed) ?? platform.available))
    .sort((a, b) => platformOrder(a.key, b.key));
  return <>
    {visiblePlatforms.length ? <div className={styles.platformGrid}>{visiblePlatforms.map(platform => {
      const accounts = work.accounts.filter(account => account.platform === platform.key);
      const needsAuthorization = accounts.some(account => account.status !== "ready");
      const connectableChannels = platform.channels?.filter(channel => channel.connectionAllowed) ?? [];
      const canConnect = platform.connectionAllowed;
      const browserOnly = connectableChannels.length > 0 && connectableChannels.every(channel => channel.transport === "browser_plugin");
      const notDeveloped = platform.executionBlocked === true;
      return <section className={styles.platformCard} data-state={accounts.length ? needsAuthorization ? "attention" : "connected" : "unconnected"} data-multi={accounts.length > 1 ? "true" : "false"} data-testid={`studio-platform-${platform.key}`} key={platform.key}>
        <div className={styles.platformCardHeader}><span className={styles.accountMark}>{platform.name.slice(0, 1)}</span><h2>{platform.name}</h2><span className={styles.platformConnectionState}>{accounts.length ? `${accounts.length} 个账号` : canConnect ? "未连接" : notDeveloped ? "尚未接入" : "暂不可连接"}</span></div>
        <div className={styles.platformCardBody}>
          {accounts.length ? <div className={styles.platformAccounts}>{accounts.map(account => {
            const transport = account.kind === "browser" ? "browser_plugin" : "official_api";
            const connectionAllowed = platform.channels?.find(channel => channel.transport === transport)?.connectionAllowed ?? platform.connectionAllowed;
            return <div key={account.id} className={styles.platformAccount}><AccountMark account={account} /><div><strong>{account.name}</strong><small>{account.kind !== "browser" ? platform.key === "douyin" ? "官方授权 · 手机接力" : "官方授权" : "浏览器发布"}</small><span className={styles.accountConnectionBadge} data-ready={account.status === "ready"}>{account.status === "ready" ? "已连接" : "授权需更新"}</span></div>{account.status !== "ready" && <button type="button" className={styles.accountReconnect} disabled={!!work.busy || !connectionAllowed} onClick={() => void work.connectAccount(platform.key, transport)}>重新授权</button>}</div>;
          })}</div> : <div className={styles.platformCardEmpty}><span>尚未连接账号</span><small>{canConnect ? "连接后在这里管理账号与授权" : notDeveloped ? "该平台发布通道尚未接入" : platform.nativeReason || platform.reason || "该平台暂不可连接"}</small></div>}
        </div>
        <div className={styles.platformCardFooter}>
          <button type="button" className={`${accounts.length ? styles.button : styles.primaryButton} ${styles.platformCardAction}`} data-testid={`studio-connect-${platform.key}`} disabled={!!work.busy || !canConnect} onClick={() => { if (!canConnect) return; if (pluginState === "missing" && browserOnly) { window.location.assign(PUBLISHING_PLUGIN_DOWNLOADS.guide); return; } if (connectableChannels.length > 1) setConnecting(platform.key); else connect(platform.key, connectableChannels.length === 1 ? connectableChannels[0].transport : undefined); }}><Link2 size={15} />{accounts.length ? "添加另一个账号" : canConnect ? "连接账号" : "暂不可连接"}</button>
        </div>
      </section>;
    })}</div> : <div className={styles.emptyView}><Users size={36} /><h2>暂未读取到可连接的平台</h2><p>请刷新账号，按发布服务返回的实际能力继续。</p><button type="button" className={styles.button} onClick={() => void work.refreshAccounts()} disabled={!!work.busy}><RefreshCw size={15} />重新读取</button></div>}
    {chosen && !work.authorization && !work.authorizationFlow && <StudioDialog title={`连接${chosen.name}账号`} testId="studio-connect-channel" description="选择连接方式。授权其他账号会追加到列表，同一账号重新授权会更新连接。" onClose={() => setConnecting(null)} footer={<button type="button" className={styles.button} data-studio-focus="true" onClick={() => setConnecting(null)}>暂不连接</button>}>
      <div className={styles.channelChoices}>{chosen.channels?.map(channel => <div key={channel.transport} className={styles.channelChoice}><h3>{channel.transport === "browser_plugin" ? "浏览器仅授权" : "官方授权与手机接力"}</h3><p>{channel.transport === "browser_plugin" ? "先安装并启用 AiToEarn 扩展，允许本网站使用，再登录要发布的抖音账号。发布时需要保持浏览器打开。" : "用抖音 App 扫码授权。提交作品后，还需要在手机端继续确认发布。"}</p>{channel.reason && <p className={styles.fieldHint}>{channel.reason}</p>}<button type="button" className={styles.button} data-testid={`studio-connect-channel-${channel.transport}`} disabled={!!work.busy || !channel.connectionAllowed} onClick={() => { setConnecting(null); connect(chosen.key, channel.transport); }}>{channel.transport === "browser_plugin" ? "连接浏览器账号" : "开始官方授权"}</button></div>)}</div>
    </StudioDialog>}
  </>;
}



export function ImportDialog({ work }: { work: PublishingStudioController }) { const [kind, setKind] = useState<"media" | "draft">("media"); return <StudioDialog title="导入已有内容" description="选择后才会放入本次发布稿。导入草稿会替换当前编辑内容。" onClose={work.closeImport} testId="studio-import-dialog" wide footer={<button type="button" className={styles.button} onClick={work.closeImport}>取消导入</button>}><div className={styles.importTabs}><button type="button" className={styles.smallButton} aria-pressed={kind === "media"} disabled={work.importLoading || !!work.busy} onClick={() => { setKind("media"); void work.loadImport("media"); }}><FileImage size={14} />我的作品</button><button type="button" className={styles.smallButton} aria-pressed={kind === "draft"} disabled={work.importLoading || !!work.busy} onClick={() => { setKind("draft"); void work.loadImport("draft"); }}><FileText size={14} />发布草稿</button></div>{work.importLoading ? <div className={styles.loading}><Loader2 size={19} className={styles.spin} />正在读取可导入内容…</div> : work.importItems.length ? <div className={styles.importGrid}>{work.importItems.map(item => <button type="button" className={styles.importItem} key={item.id} disabled={!!work.busy} onClick={() => void work.importItem(item.id)}><div className={styles.importPreview}>{item.thumbnail ? <img src={item.thumbnail} alt="" /> : item.kind === "video" ? <Film size={28} /> : item.kind === "draft" ? <FileText size={28} /> : <FileImage size={28} />}</div><strong>{item.title || "未命名内容"}</strong><small>{item.kind === "video" ? "视频" : item.kind === "draft" ? "发布草稿" : "图片"}{item.createdAt ? ` · ${dateText(item.createdAt)}` : ""}</small></button>)}</div> : <div className={styles.dialogEmpty}>没有可导入的{kind === "draft" ? "发布草稿" : "作品"}。你也可以直接选择本地文件。</div>}</StudioDialog>; }
