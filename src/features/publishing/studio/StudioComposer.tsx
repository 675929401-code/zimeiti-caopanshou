"use client";
import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, Plug, Plus, RefreshCw, Save, Send, Users } from "lucide-react";
import { AppScopedLink } from "@/components/app-scoped-link";
import { publishingPluginSetupHints, type PublishingPluginControl } from "./usePublishingPlugin";
import type { PublishingStudioController, StudioAccount } from "./types";
import { BusyLabel, CheckIcon, dateText, localDateTime } from "./StudioPrimitives";
import { AccountMark, ContentPreview, platformName, platformOrder, scheduleExplanation, targetMedia, timezoneLabel } from "./StudioPresentation";
import { MediaPanel, CommonContent } from "./StudioMediaEditor";
import { assertStudioTargetPreflight } from "./studio-draft";
import { studioTargetBlock } from "./studio-routing";
import { StudioTargetEditor } from "./StudioTargetEditor";
import styles from "./Studio.module.css";
const steps = [{ title: "准备作品", detail: "素材与公共内容" }, { title: "适配平台", detail: "账号与独立版本" }, { title: "安排发布", detail: "时间与发布确认" }];

export function StudioComposer({ work, plugin, step, onStep, onAccounts }: { work: PublishingStudioController; plugin: PublishingPluginControl; step: number; onStep(step: number): void; onAccounts(): void }) {
  const targetEditor = useRef<HTMLDivElement>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const selected = work.accounts.filter(account => account.selected);
  const pluginIssue = plugin.state === "present" ? null : publishingPluginSetupHints[plugin.state];
  const needsPlugin = selected.some(account => account.kind === "browser") && !!pluginIssue;
  const targetChecks = step >= 2 ? selected.map(account => {
    const platform = work.platforms.find(item => item.key === account.platform);
    let issue: string | null = null;
    try { assertStudioTargetPreflight(work.draft, account, platform, step === 3); }
    catch (error) {
      const prefix = account.name + "：";
      issue = error instanceof Error && !Array.isArray((error as { issues?: unknown }).issues)
        ? error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
        : "请核对该账号的平台参数";
    }
    return { account, issue, channelUnavailable: !!studioTargetBlock(account, platform), pluginIssue: account.kind === "browser" ? pluginIssue : null };
  }) : [];
  const target = selected.find(account => account.id === targetId) || selected[0];
  const prepared = work.draft.contentType === "text" ? !!work.draft.body.trim() : !!work.draft.media.length;
  const allowStep = (next: number) => next === 1 || (prepared && (next === 2 || selected.length > 0));
  const canSave = work.draft.media.length > 0 || !!work.draft.title.trim() || !!work.draft.body.trim();
  const saving = work.busy === "保存草稿";
  const savedTime = work.draftSave && new Date(work.draftSave.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const saveStatus = saving ? "正在保存…" : work.draftSave
    ? (work.draftSave.edited ? "有未保存修改" : "已保存 " + savedTime)
    : canSave ? "本次编辑尚未保存" : "添加内容后可保存草稿";
  const blocker = targetChecks.some(check => check.issue || check.pluginIssue);
  function focusAccount(id: string) {
    setTargetId(id);
    onStep(2);
    requestAnimationFrame(() => {
      targetEditor.current?.focus();
      targetEditor.current?.scrollIntoView({ block: "nearest" });
    });
  }
  return <div className={styles.composer}>
    <nav className={styles.steps} aria-label="发布准备步骤">{steps.map((item, index) => <button type="button" key={item.title} data-done={step > index + 1} data-testid={`studio-step-${index + 1}`} aria-current={step === index + 1 ? "step" : undefined} disabled={!!work.busy || !allowStep(index + 1)} onClick={() => onStep(index + 1)}><span className={styles.stepNumber}>{step > index + 1 ? <Check size={15} /> : `0${index + 1}`}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span>{index < 2 && <ArrowRight size={16} className={styles.stepArrow} />}</button>)}</nav>
    <div className={styles.composerColumns} data-step={step} data-empty={!prepared}>
      <section className={styles.activeEditor}>
        {(step === 2 || step === 3) && needsPlugin && <div className={styles.banner} data-tone="warning" data-testid="studio-plugin-required" role="status">
          <Plug size={17} /><span>{pluginIssue} 这次选中的浏览器账号需要插件。</span>
          <AppScopedLink href="/plugin-guide" target="_blank" rel="noopener" className={styles.smallButton}>安装与授权</AppScopedLink>
          <button type="button" className={styles.smallButton} disabled={plugin.state === "checking"} onClick={() => void plugin.check()}><RefreshCw size={13} />重新检测</button>
        </div>}
        {step === 1 && <><div className={styles.stepTitle}><h2>先把作品准备好</h2><p>{work.draft.contentType === "text" ? "从一段文字开始，下一步选择适合的平台。" : "选入作品后，再补充公共文案与封面。"}</p></div><div className={styles.composerTypes} aria-label="作品类型">{([{ key: "video", label: "视频" }, { key: "image", label: "图文" }, { key: "text", label: "文字" }] as const).map(item => <button type="button" data-testid={`studio-type-${item.key}`} key={item.key} aria-pressed={work.draft.contentType === item.key} disabled={!!work.busy || !!work.draft.media.length && work.draft.contentType !== item.key} onClick={() => work.patchDraft({ contentType: item.key })}>{item.label}</button>)}</div>{work.draft.contentType !== "text" && <MediaPanel work={work} />}{(prepared || work.draft.contentType === "text") && <CommonContent work={work} />}</>}
        {step >= 2 && !!targetChecks.length && <ul className={styles.targetChecklist} data-testid="studio-target-checklist">
          {targetChecks.map(({ account, issue, channelUnavailable, pluginIssue: accountPluginIssue }) => (
            <li key={account.id} data-issue={!!(issue || accountPluginIssue)} data-testid={"studio-early-check-" + account.id}>
              <div><strong>{platformName(work, account.platform)} · {account.name}</strong>
                <small>{account.status !== "ready" ? "该账号需要更新授权" : accountPluginIssue ? plugin.state === "checking" ? "正在检测浏览器插件" : "需要安装、启用或授权浏览器插件" : issue || "内容校验通过，提交前会核对平台状态"}</small></div>
              {account.status !== "ready" ? <button type="button" className={styles.smallButton} onClick={onAccounts}>管理账号</button>
                : accountPluginIssue ? <AppScopedLink href="/plugin-guide" target="_blank" rel="noopener" className={styles.smallButton}>插件设置</AppScopedLink>
                : issue && !channelUnavailable && !(step === 3 && issue.includes("计划时间")) && <button type="button" className={styles.smallButton} onClick={() => focusAccount(account.id)}>调整内容</button>}
            </li>
          ))}
        </ul>}
        {step === 2 && <><div className={styles.stepTitle}><div><h2>选择账号并调整各平台内容</h2><p>选择发布账号，再切换账号调整独立版本。</p></div><button type="button" className={styles.quietButton} onClick={onAccounts}><Plus size={15} />管理账号</button></div>{work.accounts.length ? <div className={styles.accountChoices}>{[...work.accounts].sort((a, b) => platformOrder(a.platform, b.platform)).map(account => <button type="button" key={account.id} className={styles.accountChip} data-testid={`studio-account-${account.id}`} aria-pressed={account.selected} disabled={!!work.busy} onClick={() => work.toggleAccount(account.id)}><AccountMark account={account} /><span>{account.name}<small>{platformName(work, account.platform)}</small></span>{account.selected && <Check size={14} className={styles.selectedCheck} />}</button>)}</div> : <div className={styles.accountEmpty}><Users size={24} /><div><strong>连接你的第一个账号</strong><p>连接后即可为这份作品选择目标。</p></div><button type="button" className={styles.smallButton} onClick={onAccounts}>连接账号</button></div>}{target ? <><div className={styles.targetTabs} role="tablist" aria-label="各账号内容版本">{selected.map(account => <button type="button" role="tab" aria-selected={target.id === account.id} data-testid={`studio-target-tab-${account.id}`} key={account.id} onClick={() => setTargetId(account.id)}><AccountMark account={account} /><span>{account.name}<small>{platformName(work, account.platform)}</small></span></button>)}</div><div ref={targetEditor} tabIndex={-1}><StudioTargetEditor key={target.id} work={work} account={target} inline onClose={() => undefined} /></div></> : <div className={styles.targetEmpty}>选择一个账号，查看它的内容要求与独立设置。</div>}</>}
        {step === 3 && <SchedulePanel work={work} selected={selected} onEdit={() => onStep(2)} />}
      </section>
      {(prepared || step > 1 || work.draft.contentType === "text") && <ContentPreview work={work} account={step > 1 ? target : undefined} accounts={step > 1 ? selected : []} activeId={target?.id} onSelect={setTargetId} />}
    </div>
    <footer className={styles.composerFooter}>
      <div className={styles.composerFooterStart}>
        {step > 1 && <button type="button" className={styles.quietButton} data-testid="studio-step-previous" disabled={!!work.busy} onClick={() => onStep(step - 1)}><ArrowLeft size={16} />上一步</button>}
        <span className={styles.fieldHint} data-testid="studio-draft-save-status" role="status">{saveStatus}</span>
      </div>
      <div className={styles.composerActions}>
        {step === 3 && (!work.quota.canPublish || blocker) && <span className={styles.publishBlockedHint} data-testid="studio-publish-blocked">{work.quota.reason || "请先处理所选账号的检查项"}</span>}
        <button type="button" className={styles.button} data-testid="studio-save-draft" onClick={() => void work.saveDraft()} disabled={!!work.busy || !work.session.authenticated || !canSave}>
          <BusyLabel busy={saving}><Save size={16} />保存发布草稿</BusyLabel>
        </button>
        {step < 3 ? <button type="button" className={styles.primaryButton} data-testid="studio-step-next" disabled={!!work.busy || !allowStep(step + 1)} onClick={() => onStep(step + 1)}>{step === 1 ? "选择平台账号" : "安排发布时间"}<ArrowRight size={17} /></button> : <button type="button" className={styles.primaryButton} data-testid="studio-publish-button" disabled={!!work.busy || work.pending || !selected.length || !prepared || !work.quota.canPublish || needsPlugin || blocker} onClick={() => void work.checkDraft()}><BusyLabel busy={!!work.busy}><Send size={16} />核对发布内容</BusyLabel></button>}
      </div>
    </footer>
  </div>;
}

function SchedulePanel({ work, selected, onEdit }: { work: PublishingStudioController; selected: StudioAccount[]; onEdit(): void }) {
  const schedule = !!work.draft.publishAt; const disabled = !!work.busy;
  return <><div className={styles.stepTitle}><h2>设置发布时间</h2><p>公共时间可统一设置，每个账号也能单独安排。</p></div><div className={styles.scheduleModes}><button type="button" aria-pressed={!schedule} disabled={disabled} onClick={() => work.patchDraft({ publishAt: undefined })}><Send size={20} /><span><strong>立即发起</strong><small>确认后进入各平台的发布流程</small></span>{!schedule && <Check size={16} />}</button><button type="button" aria-pressed={schedule} disabled={disabled} onClick={() => work.patchDraft({ publishAt: new Date(Date.now() + 3600000).toISOString() })}><Clock3 size={20} /><span><strong>指定时间</strong><small>按各平台实际排期能力执行</small></span>{schedule && <Check size={16} />}</button></div>{schedule && <label className={styles.field}><span className={styles.fieldLabel}>公共计划时间</span><input type="datetime-local" className={styles.input} data-testid="studio-common-schedule" disabled={disabled} value={localDateTime(work.draft.publishAt)} onChange={event => { if (event.target.value && Number.isFinite(Date.parse(event.target.value))) work.patchDraft({ publishAt: new Date(event.target.value).toISOString() }); }} /></label>}<p className={styles.timezone}>时间按当前设备时区显示：{timezoneLabel()}</p>
    <div className={styles.scheduleTargets}>{selected.map(account => { const value = work.draft.targetOverrides[account.id] || {}; const actualTime = value.publishAt === undefined ? work.draft.publishAt : value.publishAt; return <section key={account.id} className={styles.scheduleTarget}><div className={styles.scheduleTargetHeading}><AccountMark account={account} /><div><strong>{account.name}</strong><small>{platformName(work, account.platform)} · {account.kind === "browser" ? "浏览器插件" : "官方授权通道"}</small></div><span>{targetMedia(work, account).length} 个素材</span></div><div className={styles.scheduleTargetControls}><label className={styles.field}><span className={styles.fieldLabel}>该账号的发布时间</span><select className={styles.input} aria-label={`${account.name} 的时间方式`} disabled={disabled} value={value.publishAt === undefined ? "inherit" : value.publishAt === "" ? "now" : "schedule"} onChange={event => work.patchTarget(account.id, { publishAt: event.target.value === "inherit" ? undefined : event.target.value === "now" ? "" : new Date(Date.now() + 3600000).toISOString() })}><option value="inherit">沿用公共时间</option><option value="now">立即发起</option><option value="schedule">单独指定时间</option></select></label>{value.publishAt && <label className={styles.field}><span className={styles.fieldLabel}>独立计划时间</span><input type="datetime-local" className={styles.input} aria-label={`${account.name} 的计划时间`} disabled={disabled} value={localDateTime(value.publishAt)} onChange={event => { if (event.target.value && Number.isFinite(Date.parse(event.target.value))) work.patchTarget(account.id, { publishAt: new Date(event.target.value).toISOString() }); }} /></label>}</div><p>{actualTime ? `${dateText(actualTime)} · ${scheduleExplanation(account)}` : account.platform === "douyin" && account.kind !== "browser" ? "确认后进入官方接力，需在手机完成发布确认。" : "确认后发起发布，完成状态以平台回执为准。"}</p></section>; })}</div>
    <div className={styles.quotaSummary}><div><span>本次发布到</span><strong>{selected.length} 个账号</strong></div><div><span>现金余额</span><strong>{work.session.cashBalance === undefined ? work.session.loading ? "读取中…" : "暂不可读取" : `¥${work.session.cashBalance.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</strong></div><button type="button" className={styles.quietButton} onClick={onEdit}>调整发布目标<ArrowRight size={14} /></button></div>
    {!!work.checks.length && <div className={styles.finalChecks} data-testid="studio-checks"><h3>当前发布要求</h3>{work.checks.map(check => <div className={styles.checkRow} key={check.id}><CheckIcon status={check.status} /><div><strong>{check.label}</strong>{check.detail && <p>{check.detail}</p>}</div></div>)}</div>}<p className={styles.fieldHint}>下一步会汇总各账号的最终内容供你核对。确认后才传输素材并提交发布。</p>
  </>;
}
