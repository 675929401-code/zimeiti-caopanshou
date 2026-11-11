"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PUBLISHING_COMMERCIAL_PLATFORMS as PUBLISHING_PLATFORMS,
  PublishingAdminActionSchema,
  PublishingAdminStateSchema,
  PublishingConfigInputSchema,
  type PublishingAdminAction,
  type PublishingAdminState,
} from "@/lib/publishing-contract";
import { safeLocalStorageGet } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import styles from "./PublishingAdminTab.module.css";
import PublishingNativeReadiness from "./PublishingNativeReadiness";
import PublishingCashPricing from "./PublishingCashPricing";

type ConfigInput = Extract<PublishingAdminAction, { action: "save-config" }>["config"];
type Props = { onDirtyChange?: (dirty: boolean) => void; accessEpoch?: string };
type ReadOptions = { replaceConfig?: boolean };

const linkLabels: Record<keyof ConfigInput["operatorLinks"], string> = {
  officialUrl: "服务官网", apiKeyUrl: "官方 API Key 与用量页", docsUrl: "发布流程与计费说明", contactUrl: "官方联系入口", pluginUrl: "官方插件安装入口",
};
const platformName = (key: string) => PUBLISHING_PLATFORMS.find((platform) => platform.key === key)?.name ?? key;
const dateText = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "尚未登记";
const moneyText = (cents: number) => (cents / 100).toLocaleString("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 });
const toLocalTime = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const configEditor = (config: PublishingAdminState["config"]): ConfigInput => ({
  expectedVersion: config.version, executionEnabled: config.executionEnabled, salesEnabled: config.salesEnabled,
  enabledPlatforms: [...config.enabledPlatforms], announcement: config.announcement, operatorLinks: { ...config.operatorLinks },
  procurementNotes: config.procurementNotes, procurementVerifiedAt: config.procurementVerifiedAt,
});
const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

class PublishingRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

async function requestPublishing(action?: PublishingAdminAction): Promise<unknown> {
  const token = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch("/api/admin/publishing", {
      method: action ? "POST" : "GET", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${token || ""}`, ...(action ? { "Content-Type": "application/json" } : {}) },
      ...(action ? { body: JSON.stringify(action) } : {}),
    });
    const payload: unknown = await response.json().catch(() => null);
    const body = record(payload);
    if (!response.ok || body?.ok === false) {
      const reason = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : `发布管理请求失败（HTTP ${response.status}）`;
      const code = typeof body?.code === "string" ? body.code : "";
      const needsStepUp = body?.adminStepUp === true || record(body?.adminStepUp)?.required === true || /STEP.?UP/.test(code);
      throw new PublishingRequestError(`${reason}${code ? `（${code}）` : ""}${needsStepUp ? "；请使用后台上方的敏感配置验证，完成后重新读取。" : ""}`, response.status, code);
    }
    return payload;
  } finally { window.clearTimeout(timer); }
}

export default function PublishingAdminTab({ onDirtyChange, accessEpoch = "" }: Props = {}) {
  const [snapshot, setSnapshot] = useState<PublishingAdminState | null>(null);
  const [config, setConfig] = useState<ConfigInput | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [pricingDirty, setPricingDirty] = useState(false);
  const [conflict, setConflict] = useState({ config: false });
  const [reading, setReading] = useState(false), [saving, setSaving] = useState<"config" | null>(null);
  const [notice, setNotice] = useState(""), [failed, setFailed] = useState(false), [uncertain, setUncertain] = useState(false);
  const dirtyRef = useRef({ config: false });
  const configRef = useRef<ConfigInput | null>(null);
  const accessGeneration = useRef(0);
  const readSequence = useRef(0), writeLock = useRef(false);
  const invalidateRead = useCallback(() => { readSequence.current++; }, []);
  const invalidateAccess = useCallback(() => { accessGeneration.current++; invalidateRead(); }, [invalidateRead]);
  const dirty = configDirty || pricingDirty;

  const replaceConfig = useCallback((next: ConfigInput) => { configRef.current = next; setConfig(next); dirtyRef.current.config = false; setConfigDirty(false); }, []);
  const updateConfig = (patch: Partial<ConfigInput>) => {
    if (!configRef.current) return;
    const next = { ...configRef.current, ...patch }; configRef.current = next; setConfig(next); dirtyRef.current.config = true; setConfigDirty(true);
  };
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const load = useCallback(async (options: ReadOptions = {}) => {
    const sequence = ++readSequence.current; setReading(true);
    try {
      const payload = await requestPublishing();
      const result = PublishingAdminStateSchema.safeParse(payload);
      if (!result.success) throw new Error("发布管理响应未通过共享合同校验，请检查服务端版本后重新读取。");
      if (sequence !== readSequence.current) return false;
      const latest = result.data; setSnapshot(latest); setFailed(false); setUncertain(false);
      if (options.replaceConfig || !dirtyRef.current.config) {
        replaceConfig(configEditor(latest.config)); setConflict((current) => ({ ...current, config: false }));
      } else if (configRef.current?.expectedVersion !== latest.config.version) {
        setConflict((current) => ({ ...current, config: true }));
        setNotice("服务配置已有新版本，当前未保存输入已保留。请核对最新状态，再使用“载入最新配置”继续修改。");
      }
      return true;
    } catch (error) {
      if (sequence === readSequence.current) {
        setFailed(true); setNotice(error instanceof Error ? error.message : "发布管理读取失败，请稍后重试。");
        if (error instanceof PublishingRequestError && [401, 403].includes(error.status)) setSnapshot(null);
      }
      return false;
    } finally { if (sequence === readSequence.current) setReading(false); }
  }, [replaceConfig]);

  useEffect(() => { invalidateAccess(); setSaving(null); setSnapshot(null); setConfig(null); configRef.current = null; dirtyRef.current.config = false; setConfigDirty(false); setNotice(""); setConflict({ config: false }); void load({ replaceConfig: true }); return invalidateAccess; }, [load, accessEpoch, invalidateAccess]);

  const save = async (action: Extract<PublishingAdminAction, { action: "save-config" }>) => {
    if (writeLock.current || !snapshot || reading || uncertain) return;
    const generation = accessGeneration.current;
    const parsed = PublishingAdminActionSchema.safeParse(action);
    if (!parsed.success) {
      setFailed(true); setNotice(`请检查填写内容：${parsed.error.issues.map((issue) => issue.message).join("；")}`); return;
    }
    const confirmation = `确认保存发布服务配置？\n外部执行：${action.config.executionEnabled ? "申请启用" : "关闭"}\n开放平台：${action.config.enabledPlatforms.map(platformName).join("、") || "无"}\n旧套餐销售设置保持不变；本操作不会设置现金单价或扣款。\n运行环境的执行准入仍由服务器控制。`;
    if (!window.confirm(confirmation)) return;
    writeLock.current = true; setSaving("config"); setNotice(""); setFailed(false);
    let accepted = false;
    try {
      await requestPublishing(parsed.data); if (generation !== accessGeneration.current) return; accepted = true;
      const verified = await load({ replaceConfig: true });
      if (generation !== accessGeneration.current) return;
      if (!verified) { setUncertain(true); setNotice("服务器已接受保存，但最新状态未能读回。编辑内容已保留，请读取最新状态核对后再继续。"); }
      else setNotice("服务配置已保存并读回；实际执行仍受运行环境准入控制。");
    } catch (error) {
      if (generation !== accessGeneration.current) return;
      setFailed(true);
      const isConflict = error instanceof PublishingRequestError && error.status === 409;
      const unknownResult = !(error instanceof PublishingRequestError) || error.status >= 500 || error.status === 408 || accepted;
      if (isConflict) {
        setConflict((current) => ({ ...current, config: true }));
        await load();
        if (generation !== accessGeneration.current) return;
        setFailed(true);
        setNotice(`${error instanceof Error ? error.message : "保存版本冲突"}。已重新读取最新状态，未保存输入仍保留；请核对并载入最新版本后修改。`);
      } else {
        setUncertain(unknownResult);
        setNotice(`${error instanceof Error ? error.message : "发布管理保存失败"}${unknownResult ? "。本次保存结果未知，请先读取最新状态核对，当前暂停写入。" : ""}`);
      }
    } finally { writeLock.current = false; if (generation === accessGeneration.current) setSaving(null); }
  };

  const resetConfig = () => {
    if (!snapshot || (configDirty && !window.confirm("确认放弃当前服务配置的未保存修改，并载入最新已保存配置？"))) return;
    replaceConfig(configEditor(snapshot.config)); setConflict((current) => ({ ...current, config: false }));
  };
  const disabled = reading || Boolean(saving) || !snapshot || !snapshot.schemaReady || uncertain;
  const runtimeReady = Boolean(snapshot?.config.runtimeExecutionEnabled);
  const taskStatus = (task: PublishingAdminState["tasks"][number]) => task.status === "awaiting_receipt" ? "等待浏览器回执" : task.status === "unknown" ? "结果未知，待核对" : task.reportedSuccess === true ? "浏览器报告成功" : task.reportedSuccess === false ? "浏览器报告失败" : "浏览器已回报";

  return <div className={styles.root} data-testid="publishing-admin">
    <header className={styles.header}><div><span className={styles.eyebrow}>发布服务 · 平台运营</span><h2>发布中心管理</h2><p>站方统一配置发布通道、采购与账号授权。供应商凭据、用量和运营诊断仅在管理端维护，会员工作台只显示自身现金余额。</p></div><button type="button" className={styles.button} disabled={reading || Boolean(saving)} onClick={() => { setNotice(""); void load(); }}>{reading ? "读取中…" : "读取最新状态"}</button></header>
    {notice && <p role={failed ? "alert" : "status"} className={styles.notice} data-error={failed}>{notice}</p>}
    {uncertain && <p className={styles.notice}>当前写入结果尚待核对，保存按钮已暂停。读取最新状态会保留未保存输入；涉及版本变化时，需要明确载入最新版本。</p>}

    <PublishingNativeReadiness accessEpoch={accessEpoch} />

    <section className={styles.panel} data-testid="publishing-service-config">
      <div className={styles.sectionHeading}><div><h3>服务状态与渠道</h3><p>发布执行与运行环境分别控制。此处管理通道准入，不创建会员套餐或发放额度。</p></div><span className={styles.badge}>配置 v{snapshot?.config.version ?? "—"}</span></div>
      <div className={styles.statusGrid}>
        <div className={styles.statusCard}><span>运行环境准入</span><strong>{snapshot ? runtimeReady ? "执行门禁已开放" : "执行门禁未开放" : "等待授权读取"}</strong><small>{snapshot ? runtimeReady ? "仍需管理员开启执行，并完成平台与插件配置。" : "需要服务端配置 PUBLISHING_EXTERNAL_EXECUTION_ENABLED。管理页开关不能改变此状态。" : "使用主站当前管理员身份读取真实状态。"}</small></div>
        <div className={styles.statusCard}><span>当前已保存配置</span><strong>{snapshot ? snapshot.config.executionEnabled ? "外部执行已启用" : "外部执行已关闭" : "等待授权读取"}</strong><small>{snapshot ? `开放平台：${snapshot.config.enabledPlatforms.map(platformName).join("、") || "无"}。` : "执行状态从主站实际配置读取。"}</small></div>
        <div className={styles.statusCard}><span>会员与发布通道</span><strong>按账号与通道逐次核验</strong><small>插件授权与官方 API 使用各自的连接准入。目录已列出不代表账号已授权或真实发布已验收。</small></div>
      </div>
      {!snapshot && <p className={styles.quietNotice}>{reading ? "正在读取管理员权限与发布配置…" : "配置暂不可读取。请按上方返回的实际原因处理后，读取最新状态。"}</p>}
      {snapshot && !snapshot.schemaReady && <p className={styles.notice}>发布数据结构尚未就绪，当前服务配置写入已暂停。请先按项目数据库流程核验并完成升级。</p>}
      {config && <form onSubmit={(event) => { event.preventDefault(); void save({ action: "save-config", config }); }}>
        <div className={styles.switchGrid}>
          <label className={styles.switch}><input data-testid="publishing-execution-toggle" type="checkbox" checked={config.executionEnabled} disabled={disabled || conflict.config} onChange={(event) => updateConfig({ executionEnabled: event.target.checked })} /><span><strong>允许外部执行</strong><small>管理员保存后仍需运行环境与平台授权共同放行。</small></span></label>
        </div>
        <fieldset className={styles.fieldset} disabled={disabled || conflict.config}><legend>开放发布平台</legend><div className={styles.platforms}>{PUBLISHING_PLATFORMS.map((platform) => <label key={platform.key} className={styles.platform} data-selected={config.enabledPlatforms.includes(platform.key)}><input type="checkbox" checked={config.enabledPlatforms.includes(platform.key)} onChange={(event) => updateConfig({ enabledPlatforms: event.target.checked ? [...config.enabledPlatforms, platform.key] : config.enabledPlatforms.filter((key) => key !== platform.key) })} />{platform.name}</label>)}</div></fieldset>
        <label className={styles.label}>会员可见服务说明<textarea rows={3} maxLength={2000} value={config.announcement} disabled={disabled || conflict.config} onChange={(event) => updateConfig({ announcement: event.target.value })} /><small>请说明当前开放状态、适用渠道和使用要求，避免承诺尚未接通的云端能力。</small></label>
        <div className={styles.actions}><button data-testid="publishing-config-save" type="submit" className={styles.primaryButton} disabled={disabled || !configDirty || conflict.config}>{saving === "config" ? "保存并核对中…" : "保存服务配置"}</button><button type="button" className={styles.button} disabled={reading || Boolean(saving) || !snapshot} onClick={resetConfig}>载入最新配置</button><span>{conflict.config ? "版本已变化，请核对后载入最新配置。" : configDirty ? "配置有未保存修改" : "编辑区与已读取配置一致"}</span></div>
      </form>}
    </section>

    <PublishingCashPricing accessEpoch={accessEpoch} onDirtyChange={setPricingDirty} />

    <details className={styles.panel} data-testid="publishing-plan-history"><summary>历史发布套餐记录 · 只读</summary><p className={styles.help}>保留旧方案及购买记录用于核对。本页不再新建、修改或销售次数套餐；现有账务记录保持原样。</p>{snapshot?.plans.length ? <div className={styles.planList}>{snapshot.plans.map(entry => <div className={styles.resource} key={entry.id}><strong>{entry.name}</strong><p>v{entry.version} · {moneyText(entry.priceCents)} · {entry.quota} 次 · {entry.validDays} 天</p><p>{entry.platforms.map(platformName).join("、")}</p><span className={styles.badge}>{entry.enabled ? "历史配置为启用" : "已停用"}</span></div>)}</div> : <p className={styles.empty}>{snapshot ? "没有历史套餐记录。" : "读取管理状态后显示。"}</p>}</details>

    <section className={styles.panel} data-testid="publishing-procurement">
      <div className={styles.sectionHeading}><div><h3>站方采购与官方资料</h3><p>三类资源分别核验；公开文档不等于已采购、已开通或已取得白标许可。本页不读取供应商余额，也不代发采购订单。</p></div><span className={styles.badge} data-tone="pending">商业条件需站方确认</span></div>
      <div className={styles.resourceGrid}>
        <article className={styles.resource} data-testid="publishing-procurement-api"><h4>发布 API 与用量</h4><p>站方统一管理 API Key 与发布调用额度。国内与国际站凭据分开；超额、商业用量及增购方式以供应商确认结果为准。</p><a className={styles.linkButton} href="https://aitoearn.cn/zh-CN/developer/api-keys" target="_blank" rel="noopener noreferrer">国内 API 控制台 ↗</a><a className={styles.linkButton} href="https://aitoearn.ai/developer/api-keys" target="_blank" rel="noopener noreferrer">国际 API 控制台 ↗</a><a className={styles.linkButton} href="https://docs.aitoearn.ai/zh/use/publish-flow" target="_blank" rel="noopener noreferrer">用量与人工增购说明 ↗</a></article>
        <article className={styles.resource} data-testid="publishing-procurement-credits"><h4>供应商 AI 积分与附加费用</h4><p>供应商的 AI 按需积分和个别平台附加费用，与发布 API 调用额度、主站现金账务分别核算。公开文档存在不同超额计价口径，本页不硬编码采购成本。</p><a className={styles.linkButton} href="https://aitoearn.ai/en/pricing" target="_blank" rel="noopener noreferrer">查看当前产品定价 ↗</a><a className={styles.linkButton} href="https://docs.aitoearn.ai/zh/use/api-key" target="_blank" rel="noopener noreferrer">凭据与区域说明 ↗</a></article>
        <article className={styles.resource} data-testid="publishing-procurement-plugin"><h4>浏览器插件与仅授权</h4><p>按当前教程安装扩展，选择 Authorize Only，授权主站实际来源。成员在自己的浏览器确认平台账号；本入口不要求购买第二份供应商订阅，插件商业条款仍须站方核实。</p><a className={styles.linkButton} href="https://docs.aitoearn.ai/zh/use/plugin-publish" target="_blank" rel="noopener noreferrer">仅授权安装教程 ↗</a></article>
      </div>
      <details className={styles.details}><summary>站方采购核验记录与公开链接配置{configDirty ? " · 有未保存修改" : ""}</summary>
        <p className={styles.help}>最后核验：{dateText(snapshot?.config.procurementVerifiedAt)}。请仅登记公开资料、非秘密采购结论和受控凭据流程的完成情况。</p>
        {config && <><div className={styles.fieldGrid}><label className={styles.label}>最后核验时间<input type="datetime-local" value={toLocalTime(config.procurementVerifiedAt)} disabled={disabled || conflict.config} onChange={(event) => updateConfig({ procurementVerifiedAt: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label></div>
          <label className={styles.label}>非秘密采购备注<textarea rows={3} maxLength={2000} value={config.procurementNotes} disabled={disabled || conflict.config} placeholder="例如采购联系结果、报价适用范围、尚待供应商确认的问题" onChange={(event) => { const result = PublishingConfigInputSchema.shape.procurementNotes.safeParse(event.target.value); if (!result.success) { setFailed(true); setNotice("采购备注只接收非秘密资料，请通过受控凭据流程登记凭据。"); return; } updateConfig({ procurementNotes: result.data }); }} /><small>不得填写 API Key、Cookie、Token 或账号密码。凭据正文只通过受控凭据流程登记。</small></label>
          <div className={styles.fieldGrid}>{(Object.keys(linkLabels) as Array<keyof ConfigInput["operatorLinks"]>).map((key) => <label key={key} className={styles.label}>{linkLabels[key]}<input type="url" value={config.operatorLinks[key] || ""} disabled={disabled || conflict.config} placeholder="公开 HTTPS 地址" onChange={(event) => updateConfig({ operatorLinks: { ...config.operatorLinks, [key]: event.target.value || null } })} /><small>只填写公开页面地址，地址中不得包含凭据。</small></label>)}</div>
          <div className={styles.actions}><button type="button" className={styles.primaryButton} disabled={disabled || !configDirty || conflict.config} onClick={() => void save({ action: "save-config", config })}>保存资料与服务配置</button><span>与上方服务开关、公告作为同一配置版本保存。</span></div></>}
      </details>
    </section>

    <section className={styles.panel} data-testid="publishing-usage-summary">
      <div className={styles.sectionHeading}><div><h3>发布记录摘要</h3><p>按每个发布目标统计任务，覆盖浏览器发布、抖音官方操作和工作台发布记录；浏览器回报仍需核对平台实际结果。</p></div><span className={styles.badge}>按目标统计</span></div>
      {snapshot?.stats?.sources?.studioSchemaReady === false && <p className={styles.notice}>工作台发布记录尚未读入，当前统计不包含该部分任务。</p>}
      {snapshot?.stats?.sources && <p className={styles.help}>历史浏览器 {snapshot.stats.sources.tasksV1} · 原版浏览器尝试 {snapshot.stats.sources.tasksV2} · 官方发布 {snapshot.stats.sources.tasksOfficial} · 工作台发布 {snapshot.stats.sources.tasksGeneric ?? 0}。登记账号：浏览器 {snapshot.stats.sources.accountsBrowser} · 抖音官方 {snapshot.stats.sources.accountsDouyin} · 其他官方 {snapshot.stats.sources.accountsOAuth}。下方表格保留最近的历史浏览器回执。</p>}
      {snapshot?.stats ? <><div className={styles.statsGrid}><div className={styles.stat}><span>历史套餐购买</span><strong>{snapshot.stats.purchases.toLocaleString("zh-CN")}</strong><small>笔</small></div><div className={styles.stat}><span>发布任务</span><strong>{snapshot.stats.tasks.toLocaleString("zh-CN")}</strong><small>个</small></div><div className={styles.stat}><span>登记账号</span><strong>{snapshot.stats.accounts.toLocaleString("zh-CN")}</strong><small>个</small></div></div>
        {snapshot.tasks.length ? <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th scope="col">任务标识</th><th scope="col">平台</th><th scope="col">回执状态</th><th scope="col">账号标识</th><th scope="col">创建时间</th></tr></thead><tbody>{snapshot.tasks.map((task) => <tr key={task.id}><td><code title={task.id}>{task.id.slice(0, 8)}</code></td><td>{platformName(task.platform)}</td><td>{taskStatus(task)}</td><td><code>{task.accountId.slice(0, 8)}</code></td><td>{dateText(task.createdAt)}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>当前没有可展示的任务回执。</p>}
      </> : <p className={styles.quietNotice}>{snapshot ? "当前账号没有账务摘要读取权限，统计数量与任务列表未读取。" : "授权状态读取后显示任务与用量摘要。"}</p>}
      <p className={styles.help}>本区域不读取会员文案正文、私有媒体或平台登录凭据。未知结果需先核对，避免重复执行。</p>
    </section>
    <p className={styles.footer}>服务配置使用版本校验。遇到权限不足、二次验证过期或版本冲突时，保留未保存输入并按服务端实际原因处理。</p>
  </div>;
}
