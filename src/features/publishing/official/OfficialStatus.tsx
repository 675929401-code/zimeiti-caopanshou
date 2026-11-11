"use client";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useOfficialPublishing } from "./useOfficialPublishing";
import styles from "../PublishingWorkbench.module.css";

export function OfficialStatus({ compact = false }: { compact?: boolean }) {
  const api = useOfficialPublishing(); const status = api.status;
  return <div className={styles.panel} data-official-publishing-status=""><div className={styles.panelHeading}><div><h3>抖音 · 官方授权与发布接力</h3><p>{api.loading ? "正在读取官方通道状态…" : status?.message || "官方通道状态尚未核验"}</p></div><button type="button" className={styles.smallButton} disabled={!!api.workRef.current.busy} onClick={() => void api.perform("刷新官方状态", api.refresh)}><RefreshCw size={13} />核对状态</button></div><div className={styles.panelBody}>
    {status && <div className={styles.inline}><span className={styles.badge}>{status.configured ? "受控配置已登记" : "待管理员登记配置"}</span><span className={styles.badge}>{status.authorizationEnabled ? "授权入口已开放" : "授权尚未开放"}</span><span className={styles.badge}>{status.executionEnabled ? "提交准入已开放" : "提交尚未开放"}</span><span className={styles.badge}>已绑定 {api.bindings.filter(item => item.status === "active").length} 个抖音账号</span></div>}
    <p className={styles.hint}>先注册或登录 AiToEarn，由管理员在受控配置中登记接入信息，再由每位会员授权自己的抖音账号。官方接力会生成手机确认入口，须在抖音中继续操作；仅创建任务不表示作品已发布。</p>
    {status && <div className={styles.actions}><a href={status.environment === "domestic" ? status.links.domesticKeys : status.links.internationalKeys} target="_blank" rel="noopener noreferrer">注册 / 登录官方账户与 Key 管理 <ExternalLink size={13} /></a><a href={status.links.keyGuide} target="_blank" rel="noopener noreferrer">接入指南</a><a href={status.links.publishingGuide} target="_blank" rel="noopener noreferrer">官方发布说明</a>{!compact && <a href={status.links.pricing} target="_blank" rel="noopener noreferrer">官方计费说明</a>}</div>}
    {api.error && <p className={styles.warning} role="alert">{api.error}</p>}
    {api.pending && <div className={styles.warning}><div><strong>有一笔官方提交需要核对</strong><p>只查询原任务和原请求，不重新创建发布。</p><button type="button" disabled={!!api.workRef.current.busy} onClick={() => void api.perform("核对原官方提交", api.recover)}>核对原官方提交</button></div></div>}
  </div></div>;
}
