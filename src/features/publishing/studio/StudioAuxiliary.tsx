"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { FileImage, FileText, Film, Link2, Loader2, Plug, RefreshCw, Users } from "lucide-react";
import { AppScopedLink } from "@/components/app-scoped-link";
import type { PublishingStudioController, StudioPlatform } from "./types";
import { dateText, StudioDialog } from "./StudioPrimitives";
import { AccountMark, platformOrder } from "./StudioPresentation";
import { publishingPluginSetupHints, type PublishingPluginControl, type PublishingPluginState } from "./usePublishingPlugin";
import styles from "./Studio.module.css";

export function PluginStatusPanel({ state, version, onCheck }: { state: PublishingPluginState; version: string | null; onCheck: () => void }) {
  const labels: Record<PublishingPluginState, string> = { checking: "检测中…", present: "本站已授权", missing: "未检测到", unauthorized: "待授权", incompatible: "插件不可用" };
  const hint = state === "present" ? `版本 ${version}，平台登录状态会在连接或发布时核对。`
    : publishingPluginSetupHints[state];
  return <details className={styles.sidebarPlugin} data-state={state} data-testid="studio-plugin-status">
    <summary className={styles.sidebarPluginHead}><span className={styles.sidebarPluginIcon}><Plug size={14} /></span><span>发布插件</span><strong role="status">{labels[state]}</strong></summary>
    {hint && <p>{hint}</p>}
    <div className={styles.sidebarPluginActions}>
      <button type="button" data-testid="studio-plugin-recheck" onClick={onCheck} disabled={state === "checking"}><RefreshCw size={12} />重新检测</button>
      {state !== "present" && state !== "checking" && <AppScopedLink href="/plugin-guide" target="_blank" rel="noopener">安装与授权</AppScopedLink>}
    </div>
  </details>;
}

export function AccountsPanel({ work, plugin }: { work: PublishingStudioController; plugin: PublishingPluginControl }) {
  const [pluginTarget, setPluginTarget] = useState<{ key: string; name: string } | null>(null);
  const visiblePlatforms = [...work.platforms].sort((a, b) => platformOrder(a.key, b.key));
  function connectBrowser(platform: { key: string; name: string }) {
    if (plugin.state !== "present") setPluginTarget(platform);
    else void work.connectAccount(platform.key, "browser_plugin");
  }
  return <>
    {pluginTarget && <StudioDialog title={`用浏览器连接${pluginTarget.name}`} testId="studio-plugin-setup"
      description="插件在当前浏览器读取你已登录的平台账号。"
      onClose={() => setPluginTarget(null)}
      footer={plugin.state === "present"
        ? <button type="button" className={styles.primaryButton} onClick={() => { setPluginTarget(null); connectBrowser(pluginTarget); }}>读取浏览器账号</button>
        : <><AppScopedLink href="/plugin-guide" target="_blank" rel="noopener" className={styles.button}>安装与授权</AppScopedLink><button type="button" data-studio-focus className={styles.primaryButton} disabled={plugin.state === "checking"} onClick={() => void plugin.check()}><RefreshCw size={15} />重新检测</button></>}>
      <p role="status">{plugin.state === "present" ? `本站已授权。请在当前浏览器登录${pluginTarget.name}，再读取账号。` : publishingPluginSetupHints[plugin.state]}</p>
    </StudioDialog>}
    {work.workspace.loading ? (
      <div className={styles.loading}><Loader2 size={19} className={styles.spin} />正在读取发布服务…</div>
    ) : visiblePlatforms.length ? (
      <div className={styles.platformGrid}>
        {visiblePlatforms.map(platform => (
          <PlatformAccountCard key={platform.key} platform={platform} work={work} pluginState={plugin.state} onConnectBrowser={() => connectBrowser(platform)} />
        ))}
      </div>
    ) : (
      <div className={styles.emptyView}>
        <Users size={36} /><h2>暂未读取到可连接的平台</h2><p>重新读取后可查看平台和连接方式。</p>
        <button type="button" className={styles.button} onClick={() => void work.refreshAccounts()} disabled={!!work.busy}>
          <RefreshCw size={15} />重新读取
        </button>
      </div>
    )}
  </>;
}

function PlatformAccountCard({ platform, work, pluginState, onConnectBrowser }: {
  platform: StudioPlatform;
  work: PublishingStudioController;
  pluginState: PublishingPluginState;
  onConnectBrowser: () => void;
}) {
  const accounts = work.accounts.filter(account => account.platform === platform.key);
  const officialChannel = platform.channels?.some(channel => channel.transport === "official_api" && channel.connectionAllowed);
  const browserChannel = platform.channels?.some(channel => channel.transport === "browser_plugin" && channel.connectionAllowed);
  const browserOnly = !officialChannel && (browserChannel || (!platform.channels && platform.transport === "browser_plugin"));
  const canConnect = platform.connectionAllowed;
  const needsAuthorization = accounts.some(account => account.status !== "ready" || (account.kind === "browser" && pluginState !== "present" && pluginState !== "checking"));
  const hasOfficialConnection = accounts.some(account => account.kind !== "browser" && account.status === "ready");
  const state = needsAuthorization ? "attention" : hasOfficialConnection ? "connected" : accounts.length ? "saved" : "unconnected";
  const summary = accounts.length ? accounts.length + " 个账号" : canConnect ? "未连接" : platform.executionBlocked ? "尚未接入" : "不可用";

  const emptyTitle = !canConnect ? "连接通道" : browserOnly ? "浏览器插件" : "官方授权";
  const emptyDetail = !canConnect
    ? platform.executionBlocked ? "此平台的发布通道尚未接入" : platform.nativeReason || platform.reason || "暂未开放账号连接"
    : browserOnly ? "读取当前浏览器已登录的账号" : platform.key === "douyin" ? "授权后可用手机接力发布" : "在平台页面确认授权";

  const action = !canConnect ? "暂不可连接" : browserOnly
    ? pluginState === "present" ? "读取浏览器账号" : "设置浏览器插件"
    : accounts.length ? "添加账号" : "连接账号";
  const ActionIcon = browserOnly ? Plug : Link2;

  return (
    <section className={styles.platformCard} data-state={state} data-testid={'studio-platform-' + platform.key} aria-label={platform.name}>
      <header className={styles.platformCardHeader}>
        <span className={styles.accountMark} aria-hidden="true">{platform.name.slice(0, 1)}</span>
        <h2>{platform.name}</h2>
        <span className={styles.platformConnectionState}>{summary}</span>
      </header>

      {accounts.length ? (
        <ul className={styles.platformAccounts}>
          {accounts.map(account => {
            const browser = account.kind === "browser";
            const transport = browser ? "browser_plugin" : "official_api";
            const connectionAllowed = platform.channels?.find(channel => channel.transport === transport)?.connectionAllowed ?? canConnect;
            const channelLabel = browser ? "浏览器插件" : platform.key === "douyin" ? "官方授权 · 手机接力" : "官方授权";
            return (
              <li key={account.id} className={styles.platformAccount}>
                <AccountMark account={account} />
                <div className={styles.platformAccountText}>
                  <strong>{account.name}</strong>
                  <small>{channelLabel}</small>
                </div>
                {account.status === "ready" ? (
                  <span className={styles.accountConnectionBadge} data-tone={browser ? "muted" : "success"} title={browser ? "发布时核对平台登录状态" : undefined}>
                    {browser ? "已保存" : "已连接"}
                  </span>
                ) : (
                  <button type="button" className={styles.accountReconnect} disabled={!!work.busy || !connectionAllowed}
                    onClick={() => { if (browser) onConnectBrowser(); else void work.connectAccount(platform.key, transport); }}>
                    {browser ? "重新读取" : "重新授权"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.platformAccount}>
          <span className={styles.platformChannelIcon} aria-hidden="true">{browserOnly ? <Plug size={17} /> : <Link2 size={17} />}</span>
          <div className={styles.platformAccountText}><strong>{emptyTitle}</strong><small>{emptyDetail}</small></div>
        </div>
      )}

      <footer className={styles.platformCardFooter}>
        <button type="button" className={styles.platformCardAction} data-testid={'studio-connect-' + platform.key}
          disabled={!!work.busy || !canConnect}
          onClick={() => {
            if (!canConnect) return;
            if (browserOnly) onConnectBrowser();
            else void work.connectAccount(platform.key, officialChannel ? "official_api" : undefined);
          }}>
          <ActionIcon size={15} />{action}
        </button>
        {officialChannel && browserChannel && (
          <button type="button" className={styles.platformCardSecondary} data-testid={'studio-connect-browser-' + platform.key}
            disabled={!!work.busy} onClick={onConnectBrowser}>
            <Plug size={15} />使用浏览器插件
          </button>
        )}
      </footer>
    </section>
  );
}


export function ImportDialog({ work }: { work: PublishingStudioController }) { const [kind, setKind] = useState<"media" | "draft">("media"); return <StudioDialog title="导入已有内容" description="选择后才会放入本次发布稿。导入草稿会替换当前编辑内容。" onClose={work.closeImport} testId="studio-import-dialog" wide footer={<button type="button" className={styles.button} onClick={work.closeImport}>取消导入</button>}><div className={styles.importTabs}><button type="button" className={styles.smallButton} aria-pressed={kind === "media"} disabled={work.importLoading || !!work.busy} onClick={() => { setKind("media"); void work.loadImport("media"); }}><FileImage size={14} />我的作品</button><button type="button" className={styles.smallButton} aria-pressed={kind === "draft"} disabled={work.importLoading || !!work.busy} onClick={() => { setKind("draft"); void work.loadImport("draft"); }}><FileText size={14} />发布草稿</button></div>{work.error && !work.importError && <div className={styles.banner} data-tone="error" role="alert">{work.error}</div>}{work.importLoading ? <div className={styles.loading} role="status"><Loader2 size={19} className={styles.spin} />正在读取可导入内容…</div> : work.importError ? <div className={styles.banner} data-tone="error" role="alert"><span>{work.importError}</span><button type="button" className={styles.smallButton} onClick={() => void work.loadImport(kind)}><RefreshCw size={14} />重新读取</button></div> : work.importItems.length ? <div className={styles.importGrid}>{work.importItems.map(item => <button type="button" className={styles.importItem} key={item.id} disabled={!!work.busy} onClick={() => void work.importItem(item.id)}><div className={styles.importPreview}>{item.thumbnail ? <img src={item.thumbnail} alt="" /> : item.kind === "video" ? <Film size={28} /> : item.kind === "draft" ? <FileText size={28} /> : <FileImage size={28} />}</div><strong>{item.title || "未命名内容"}</strong><small>{item.kind === "video" ? "视频" : item.kind === "draft" ? "发布草稿" : "图片"}{item.createdAt ? ` · ${dateText(item.createdAt)}` : ""}</small></button>)}</div> : <div className={styles.dialogEmpty}>没有可导入的{kind === "draft" ? "发布草稿" : "作品"}。你也可以直接选择本地文件。</div>}</StudioDialog>; }
