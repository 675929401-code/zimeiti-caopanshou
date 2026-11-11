"use client";
import { useEffect, useState } from "react";
import { PUBLISHING_PLUGIN_DOWNLOADS } from "@/lib/publishing-native";
import { PublishingNativeStatusSchema, type PublishingNativeStatus } from "@/lib/publishing-native-status";
import { safeLocalStorageGet } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import styles from "./PublishingAdminTab.module.css";

export default function PublishingNativeReadiness({ accessEpoch = "" }: { accessEpoch?: string }) {
  const [status, setStatus] = useState<PublishingNativeStatus | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [probing, setProbing] = useState(false);
  const [probeMessage, setProbeMessage] = useState("");
  async function probeConnection() {
    if (probing) return; setProbing(true); setProbeMessage("");
    try {
      const response = await fetch("/api/admin/publishing/connection", { method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN) || ""}` } });
      const value = await response.json();
      if (!response.ok || value.ok !== true) throw new Error(response.status === 428 ? "请先完成后台敏感配置验证，再检查连接。" : typeof value.message === "string" ? value.message : "连接状态暂不可确认，请稍后重新检查。");
      setProbeMessage(`官方鉴权只读检查通过 · 返回 ${Number(value.platformCount)} 个平台目录。实际发布仍以已接通的通道、账号授权与会员额度为准。`);
    } catch (error) { setProbeMessage(error instanceof Error ? error.message : "连接检查未完成"); }
    finally { setProbing(false); }
  }
  useEffect(() => {
    const controller = new AbortController(); setReading(true); setError(""); setStatus(null);
    void fetch("/api/admin/publishing/native", { cache: "no-store", signal: controller.signal, headers: { Authorization: `Bearer ${safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN) || ""}` } })
      .then(async response => { if (!response.ok) throw new Error("原生工作台状态暂不可读取，请检查后台权限后重试。"); return PublishingNativeStatusSchema.parse(await response.json()); })
      .then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError("原生工作台状态暂不可读取，请检查后台权限后重试。"); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [accessEpoch, refreshKey]);
  const downloads = [
    { title: "Chrome 商店", href: PUBLISHING_PLUGIN_DOWNLOADS.chrome, description: "优先使用官方商店安装及更新浏览器扩展。" },
    { title: "国内 CRX 下载", href: PUBLISHING_PLUGIN_DOWNLOADS.china, description: "官方源码列出的国内直链，安装方式以浏览器与官方教程为准。" },
    { title: "GitHub 固定版本备用", href: PUBLISHING_PLUGIN_DOWNLOADS.github, description: "固定 v2.1.0 备用文件，不代表当前最新扩展版本。" },
  ];
  return <section className={styles.panel} data-testid="publishing-native-readiness">
    <div className={styles.sectionHeading}><div><h3>发布通道与受控凭据</h3><p>插件连接与官方 API 分别核验；会员登录、现金和积分沿用主站。本页不接收或显示密钥正文。</p></div><button className={styles.button} type="button" disabled={reading} onClick={() => setRefreshKey(value => value + 1)}>{reading ? "读取中…" : "核对连接状态"}</button></div>
    {error && <p role="alert" className={styles.notice}>{error}</p>}
    <div className={styles.sectionHeading}><p>连接检查读取平台目录及受保护的发布选项，不会发帖、生成内容或占用会员发布次数。</p><button className={styles.button} type="button" disabled={probing || !status?.provider.configured} onClick={() => void probeConnection()}>{probing ? "正在核对鉴权…" : "验证官方 API 连接"}</button></div>
    {probeMessage && <p role="status" className={styles.notice}>{probeMessage}</p>}
    <div className={styles.statusGrid}>
      <div className={styles.statusCard}><span>既有发布核心数据</span><strong>{status ? status.schemaReady ? "既有结构可读取" : "等待数据库升级" : "待读取"}</strong><small>此项只核对既有草稿、分组和排期结构；不代表新通用通道、会员政策已完成数据库升级。</small></div>
      <div className={styles.statusCard}><span>浏览器发布连接</span><strong>实际浏览器中逐次核验</strong><small>连接和执行前读取扩展能力、站点授权与平台 UID；安装入口不能代替真实账号准入。</small></div>
      <div className={styles.statusCard}><span>官方 API 连接</span><strong>{status ? status.provider.configured ? status.provider.routeExecutionEnabled ? "已登记密钥 · 运行准入已开放" : "已登记密钥 · 等待开放准入" : "等待站方登记密钥" : "待读取"}</strong><small>会员只授权自己的平台账号，站方统一管理服务端凭据与供应商采购。</small></div>
    </div>
    <p className={styles.help}>凭据来源：{status?.provider.credentialSource === "environment" ? "服务环境变量" : status?.provider.credentialSource === "secret_file" ? "受控密钥文件" : status?.provider.credentialSource === "dpapi" ? "本机 DPAPI 加密登记" : "未检测到"}{status?.provider.credentialIssue === "ambiguous" ? "；多份登记待核对" : status?.provider.credentialIssue === "unavailable" ? "；受控配置暂不可读取" : ""}。生产凭据由受控服务环境注入；本机仅通过专用隐藏输入流程登记。</p>
    {status?.counts && <div className={styles.statsGrid}>{([
      ["内容集合", status.counts.collections], ["V2 草稿", status.counts.drafts], ["账号分组", status.counts.groups], ["本地计划", status.counts.schedules], ["发布批次", status.counts.batches], ["逐目标尝试", status.counts.attempts],
    ] as const).map(([label, value]) => <div className={styles.stat} key={label}><span>{label}</span><strong>{value.toLocaleString("zh-CN")}</strong><small>条 · 授权元数据</small></div>)}</div>}
    {status?.official && <div className={styles.statsGrid}>{([["官方账号绑定", status.official.bindings], ["官方上传素材", status.official.assets], ["官方操作记录", status.official.operations], ["结果待核对", status.official.unknown]] as const).map(([label,value]) => <div className={styles.stat} key={label}><span>{label}</span><strong>{status.official?.schemaReady ? value.toLocaleString("zh-CN") : "待初始化"}</strong><small>条 · 官方连接元数据</small></div>)}</div>}
    <details className={styles.details}><summary>浏览器插件安装入口</summary><div className={styles.resourceGrid}>{downloads.map(download => <article className={styles.resource} key={download.href}><h4>{download.title}</h4><p>{download.description}</p><a className={styles.linkButton} href={download.href} target="_blank" rel="noopener noreferrer">打开官方入口 ↗</a></article>)}</div></details>
    <p className={styles.help}>安装后打开扩展，选择 Authorize Only（仅授权），填入主站实际来源并确认，然后刷新发布中心。成员无需为此登录第二套 AiToEarn 网页账号。<a href={PUBLISHING_PLUGIN_DOWNLOADS.guide} target="_blank" rel="noopener noreferrer">查看官方图文教程 ↗</a></p>
    <p className={styles.help}>源码基于 AiToEarn MIT 固定提交 <a href={PUBLISHING_PLUGIN_DOWNLOADS.source} target="_blank" rel="noopener noreferrer">{PUBLISHING_PLUGIN_DOWNLOADS.commit.slice(0, 8)} ↗</a>。本地计划不等同于平台托管定时；浏览器报告不等同于平台最终发布凭证。</p>
  </section>;
}
