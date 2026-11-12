"use client";
/* The authorization QR is an ephemeral, schema-validated image from the current session. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { PublishingStudioController } from "./types";
import { dateText, StudioDialog } from "./StudioPrimitives";
import { platformName } from "./StudioPresentation";
import { PUBLISHING_PLUGIN_DOWNLOADS } from "@/lib/publishing-native";
import styles from "./Studio.module.css";

const qrPattern = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export function AuthorizationDialog({ work }: { work: PublishingStudioController }) {
  const auth = work.authorization, flow = work.authorizationFlow;
  const [choices, setChoices] = useState<string[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const [pollStartedAt] = useState(() => Date.now());
  const [autoCheckStopped, setAutoCheckStopped] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false), [failedQr, setFailedQr] = useState<string | null>(null);
  const [showPluginGuide, setShowPluginGuide] = useState(false);
  const latest = useRef(work), closed = useRef(false);
  const hasAuthorizationError = flow?.phase === "error";
  const authorizationId = auth?.sessionId, authorizationState = auth?.state, authorizationExpiresAt = auth?.expiresAt;
  useEffect(() => { latest.current = work; }, [work]);
  useEffect(() => {
    if (!authorizationId || !authorizationState || !["pending", "prepared"].includes(authorizationState) || hasAuthorizationError) return;
    const sessionId = authorizationId;
    const deadline = Math.min(pollStartedAt + 5 * 60_000, authorizationExpiresAt ? Date.parse(authorizationExpiresAt) : Infinity);
    let disposed = false;
    let timer: number | undefined;
    const active = () => !disposed && !closed.current && document.visibilityState === "visible" && latest.current.authorization?.sessionId === sessionId && ["pending", "prepared"].includes(latest.current.authorization.state) && latest.current.authorizationFlow?.phase !== "error";
    const schedule = () => {
      window.clearTimeout(timer);
      if (!active()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { setAutoCheckStopped(true); return; }
      timer = window.setTimeout(async () => {
        if (!active()) return;
        if (Date.now() >= deadline) { setAutoCheckStopped(true); return; }
        // This GET synchronizes the existing authorization session; it may persist its returned status.
        if (!latest.current.busy) await latest.current.refreshAuthorization();
        schedule();
      }, Math.min(5000, remaining));
    };
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => { disposed = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [authorizationId, authorizationState, authorizationExpiresAt, hasAuthorizationError, pollStartedAt]);
  useEffect(() => {
    if (!auth?.expiresAt) return;
    const remaining = Date.parse(auth.expiresAt) - Date.now();
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, Math.min(remaining + 50, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [auth?.expiresAt]);
  if (!auth && !flow) return null;
  const platform = auth?.platform || flow!.platform;
  const browser = !auth && flow?.transport === "browser_plugin";
  const complete = auth?.state === "completed";
  const expired = auth?.state === "expired" || !!auth?.expiresAt && Date.parse(auth.expiresAt) <= clock;
  const terminal = auth?.state === "expired" || auth?.state === "failed";
  const selecting = auth?.state === "requires_selection" && !expired;
  const selectedChoices = choices.filter(id => auth?.choices.some(choice => choice.id === id));
  const pending = !!auth && ["pending", "prepared"].includes(auth.state) && !expired;
  const busy = !!work.busy;
  const error = flow?.error || (flow?.phase === "error" ? work.error : null);
  const qr = pending && auth?.url && auth.url.length <= 1024 ** 2 && qrPattern.test(auth.url) ? auth.url : undefined;
  const link = pending && auth?.url?.startsWith("https://") ? auth.url : undefined;
  const busyText = flow?.phase === "checking" ? "正在核对平台授权结果…" : flow?.phase === "selecting" ? "正在连接所选账号…" : "正在准备授权入口…";
  const status = complete ? "账号已连接" : expired ? "本次授权已到期" : auth?.state === "failed" ? "本次授权未完成" : auth?.state === "unknown" ? "授权结果待核对" : selecting ? "选择要连接的账号" : qr ? "使用平台 App 扫码授权" : link ? "前往平台完成授权" : error ? "连接尚未完成" : "正在准备平台授权";
  const close = () => { closed.current = true; work.closeAuthorization(); };
  const openPlatform = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!link) return;
    event.preventDefault();
    const popup = window.open("about:blank", "_blank");
    if (!popup) { setPopupBlocked(true); return; }
    popup.opener = null;
    popup.location.replace(link);
    setPopupBlocked(false);
  };
  return <StudioDialog title={`连接${platformName(work, platform)}账号`} testId="studio-authorization" description={complete ? "授权已完成，账号列表已同步更新。" : "请确认登录的是你要发布作品的账号，并阅读平台授权页面列出的权限。"} onClose={close} footer={<>
    <button type="button" className={styles.button} data-testid="studio-authorization-close" data-studio-focus="true" onClick={close}>{complete ? "完成" : "稍后继续"}</button>
    {!complete && (terminal ? <button type="button" className={styles.primaryButton} disabled={busy} data-testid="studio-authorization-restart" onClick={() => void work.connectAccount(platform, "official_api")}>重新发起授权</button> : <button type="button" className={styles.primaryButton} disabled={busy || selecting && selectedChoices.length === 0} data-testid="studio-authorization-refresh" onClick={() => void (selecting ? work.selectAuthorization(selectedChoices) : auth ? work.refreshAuthorization() : work.connectAccount(platform, flow?.transport))}>{busy ? <><Loader2 size={15} className={styles.spin} />{flow?.phase === "selecting" ? "正在连接…" : "正在核对…"}</> : selecting ? `连接所选账号${selectedChoices.length ? `（${selectedChoices.length}）` : ""}` : <><RefreshCw size={15} />{browser ? "重新连接浏览器账号" : expired || auth?.state === "unknown" || error ? "重新核对授权状态" : auth ? "我已完成授权，核对结果" : "重试并核对授权"}</>}</button>)}
  </>}>
    <div className={styles.authorizationStatus} role="status" aria-live="polite">{complete && <CheckCircle2 size={24} />}<strong>{busy ? busyText : status}</strong></div>
    {error && <div className={styles.authorizationError} role="alert" data-testid="studio-authorization-error">{error}</div>}
    {browser && <div className={styles.fieldHint} data-testid="studio-plugin-download">
      <p>未检测到发布插件。下载并安装官方 AiToEarn 扩展，在 Authorize Only 中允许本网站，然后回到这里重新连接。</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "10px 0" }}>
        <a href={PUBLISHING_PLUGIN_DOWNLOADS.direct} download={`aitoearn-extension-v${PUBLISHING_PLUGIN_DOWNLOADS.version}.crx`} className={styles.primaryButton} data-testid="studio-plugin-download-direct"><Download size={15} />直接下载插件 v{PUBLISHING_PLUGIN_DOWNLOADS.version}</a>
        <a href={PUBLISHING_PLUGIN_DOWNLOADS.guide} className={styles.button} data-testid="studio-plugin-guide">查看安装教程</a>
        <button type="button" className={styles.button} onClick={() => setShowPluginGuide(value => !value)}>{showPluginGuide ? "收起安装步骤" : "快速安装步骤"}</button>
      </div>
      {showPluginGuide && <div style={{ lineHeight: 1.8 }}>
        <p>1. 下载后打开 <code>chrome://extensions</code>，开启右上角“开发者模式”。</p>
        <p>2. 把下载的 `.crx` 文件拖入扩展页面，按 Chrome 提示确认安装。</p>
        <p>3. 打开扩展，选择 Authorize Only，允许来源 <code>{typeof window !== "undefined" ? window.location.origin : "本站"}</code>。</p>
        <p>4. 回到本弹窗，点“重新连接浏览器账号”。</p>
        <p style={{ wordBreak: "break-all" }}>文件校验 SHA-256：<code>{PUBLISHING_PLUGIN_DOWNLOADS.sha256}</code></p>
      </div>}
    </div>}
    {busy && !auth && <div className={styles.authorizationWaiting}><Loader2 size={26} className={styles.spin} /><p>正在连接平台，请稍候。关闭窗口后仍可继续核对这次授权。</p></div>}
    {!busy && !auth && !error && <p className={styles.fieldHint}>尚未取得授权入口，请核对这次授权后继续。</p>}
    {qr && <div className={styles.authorizationQr}>{failedQr === qr ? <p role="alert">二维码未能显示，请核对授权状态后再试。</p> : <img data-testid="studio-authorization-qr" src={qr} alt={`${platformName(work, platform)}账号授权二维码`} onError={() => setFailedQr(qr)} />}<p>打开{platformName(work, platform)} App 扫一扫，按提示确认授权。</p>{auth?.expiresAt && <small>有效至 {dateText(auth.expiresAt)}</small>}</div>}
    {link && <div className={styles.authorizationLink}><a data-testid="studio-authorization-link" href={link} target="_blank" rel="noopener noreferrer" className={styles.primaryButton} onClick={openPlatform}><ExternalLink size={16} />打开平台授权页面</a><p>在新标签页完成授权后，回到这里核对结果。</p>{popupBlocked && <div className={styles.authorizationError} role="alert">浏览器阻止了新窗口。请允许弹出窗口后重试，或<a href={link} data-testid="studio-authorization-current-tab">在当前标签页打开授权页面</a>；完成后返回发布工作台继续核对。</div>}</div>}
    {!complete && expired && <p className={styles.fieldHint}>{terminal ? "授权入口已失效。点击重新发起授权，取得新的二维码或授权页面。" : "二维码或链接已停止展示。请先核对这次授权是否已经完成，再按返回结果继续。"}</p>}
    {auth?.state === "unknown" && <p className={styles.fieldHint}>平台尚未确认这次授权的结果。请先核对原授权，避免重复发起。</p>}
    {pending && !qr && !link && !busy && <p className={styles.fieldHint}>平台尚未返回可用的授权入口。请核对这次授权后继续。</p>}
    {pending && !error && <p className={styles.fieldHint} data-testid="studio-authorization-auto-check">{autoCheckStopped ? "自动核对已暂停，你可以点击下方按钮继续核对原授权。" : "保持本窗口打开，扫码后的授权结果会自动更新，无需刷新网页。"}</p>}
    {selecting && <div className={styles.authorizationAccounts}>{auth!.choices.map(choice => <label className={styles.checkboxLabel} key={choice.id}><input type="checkbox" checked={choices.includes(choice.id)} disabled={busy} onChange={event => setChoices(previous => event.target.checked ? [...previous, choice.id] : previous.filter(id => id !== choice.id))} />{choice.name}</label>)}</div>}
    {complete && <p className={styles.fieldHint}>现在可以在“新建发布”中选择这个账号。授权不代表作品已发布。</p>}
  </StudioDialog>;
}
