"use client";
import { useState } from "react";
import Image from "next/image";
import { ExternalLink, Plug, RefreshCw } from "lucide-react";
import { useOfficialPublishing } from "./useOfficialPublishing";
import { OfficialStatus } from "./OfficialStatus";
import { dateLabel, SectionHeading, WorkbenchDialog } from "../native/WorkbenchUI";
import styles from "../PublishingWorkbench.module.css";
import own from "./OfficialPublishing.module.css";

const sessionLabels = { prepared: "授权已准备", pending: "等待官方授权", requires_selection: "请选择二级账号", completed: "授权完成", failed: "授权未完成", unknown: "授权状态待核对", expired: "授权已过期" };
export function OfficialAccounts() {
  const api = useOfficialPublishing(); const [open, setOpen] = useState(false); const [selected, setSelected] = useState<string[]>([]); const session = api.session; const busy = !!api.workRef.current.busy;
  return <div style={{ marginTop: 28 }}><SectionHeading title="官方 API 账号 · 抖音" action={<button type="button" className={styles.primaryButton} disabled={busy || !api.status?.authorizationEnabled || !api.status.schemaReady || !!session && ["prepared", "pending", "requires_selection", "unknown"].includes(session.state)} onClick={() => void api.perform("开始抖音官方授权", async () => { const result = await api.post({ action: "start-auth", platform: "douyin", requestKey: `auth:${crypto.randomUUID()}` }); if (!result.session) throw new Error("授权会话尚未返回，请核对原授权记录"); setSelected([]); setOpen(true); })}><Plug size={15} />授权抖音账号</button>}>官方绑定独立保存。浏览器插件的账号摘要不能作为官方 API 授权。</SectionHeading><OfficialStatus compact />
    {session && <div className={styles.notice} style={{ marginTop: 14 }}><div><strong>{sessionLabels[session.state]}</strong><p>授权创建于 {dateLabel(session.createdAt)}{session.expiresAt ? `，有效至 ${dateLabel(session.expiresAt)}` : "，有效期以官方页面为准"}</p></div><button type="button" onClick={() => { setSelected([]); setOpen(true); }}>查看授权进度</button><button type="button" disabled={busy} onClick={() => void api.perform("核对授权状态", async () => { await api.readSession(session.id); })}><RefreshCw size={13} />核对授权</button></div>}
    <div className={styles.accountGrid} style={{ marginTop: 16 }}>{api.bindings.map(binding => <article className={styles.accountTile} key={binding.id}><div className={styles.inline}><span className={styles.accountAvatar}>抖</span><div><h3>{binding.displayName}</h3><span className={styles.badge}>官方 API · {binding.status === "active" ? "已授权" : binding.status === "revoked" ? "授权已撤销" : "需核对"}</span></div></div><p className={styles.hint}>平台 UID：{binding.platformUid}</p><p className={styles.hint}>授权版本 v{binding.revision} · {dateLabel(binding.updatedAt)}</p></article>)}</div>
    {!api.bindings.length && <p className={styles.hint}>尚无已授权的抖音 API 账号。完成官方授权和必要的二级账号选择后，绑定会出现在这里。</p>}
    {api.more.bindings && <button type="button" disabled={busy} onClick={() => void api.perform("加载更多官方账号", () => api.load("bindings", true))}>加载更多官方账号</button>}
    {open && session && <WorkbenchDialog title="抖音官方账号授权" onClose={() => { if (!busy) setOpen(false); }} footer={<><button type="button" disabled={busy} onClick={() => setOpen(false)}>关闭进度（授权保留）</button><button type="button" disabled={busy} onClick={() => void api.perform("核对抖音授权", async () => { await api.readSession(session.id); })}>核对授权状态</button></>}>
      <p className={styles.badge}>{sessionLabels[session.state]}</p><p className={styles.hint}>在官方页面登录并确认授权。本站通过私有会话处理授权回调，不要求填写平台密码或 Cookie。</p>
      {session.url?.startsWith("data:image/") ? <div className={own.qr}><Image unoptimized src={session.url} alt="官方账号授权二维码" width={240} height={240} /></div> : session.url && <a className={styles.primaryLink} href={session.url} target="_blank" rel="noopener noreferrer">打开官方授权页面 <ExternalLink size={15} /></a>}
      {session.state === "requires_selection" && <div style={{ marginTop: 18 }}><h3>选择官方返回的二级账号</h3><div className={styles.targetList}>{session.selectableAccounts?.map(account => <label className={styles.targetCard} key={account.platformUid}><input type="checkbox" disabled={busy} checked={selected.includes(account.platformUid)} onChange={event => setSelected(previous => event.target.checked ? [...previous, account.platformUid] : previous.filter(id => id !== account.platformUid))} /><div><strong>{account.displayName}</strong><small>{account.platformUid}</small></div></label>)}</div><button type="button" className={styles.primaryButton} disabled={busy || !selected.length} onClick={() => void api.perform("确认授权账号选择", async () => { await api.post({ action: "select-auth", sessionId: session.id, expectedRevision: session.revision, accounts: (session.selectableAccounts || []).filter(item => selected.includes(item.platformUid)).map(item => ({ platformUid: item.platformUid, ...(item.account ? { account: item.account } : {}) })), requestKey: `auth-select:${session.id}:${session.revision}` }); await api.readSession(session.id); })}>确认所选账号</button></div>}
      {session.state === "unknown" && <p className={styles.warning}>原授权结果未知。请核对原会话，不会自动创建新的授权请求。</p>}{session.state === "completed" && <p className={styles.notice}>官方授权已完成，账号绑定已读取。可关闭进度并回到发布编辑器选择。</p>}
    </WorkbenchDialog>}
  </div>;
}
