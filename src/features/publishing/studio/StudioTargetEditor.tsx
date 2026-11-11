"use client";
/* Account covers retain their authenticated or local object URLs. */
/* eslint-disable @next/next/no-img-element */
import { useRef, useState } from "react";
import { ChevronDown, ImagePlus, RotateCcw } from "lucide-react";
import type { PublishingStudioController, StudioAccount, StudioTargetOverride } from "./types";
import { StudioDialog } from "./StudioPrimitives";
import { StudioTargetMedia } from "./StudioTargetMedia";
import { StudioLocationOptions } from "./StudioPlatformFields";
import { SchemaOptions } from "./StudioSchemaOptions";
import { genericPublishingFieldPolicy } from "@/lib/publishing-generic-validation";
import styles from "./Studio.module.css";
import { memberPlatformRestriction } from "./StudioMemberMessages";

export function StudioTargetEditor({ account, work, onClose, inline = false }: { account: StudioAccount; work: PublishingStudioController; onClose(): void; inline?: boolean }) {
  const value = work.draft.targetOverrides[account.id] || {}; const disabled = !!work.busy;
  const coverInput = useRef<HTMLInputElement>(null); const [advanced, setAdvanced] = useState(false);
  const cover = value.cover || work.draft.cover;
  const platform = work.platforms.find(item => item.key === account.platform);
  const fieldPolicy = genericPublishingFieldPolicy(account.platform);
  const patch = (update: StudioTargetOverride) => work.patchTarget(account.id, update);
  const maxTitle = typeof platform?.contentLimits?.maxTitleLength === "number" ? platform.contentLimits.maxTitleLength : undefined;
  const maxBody = typeof platform?.contentLimits?.maxBodyLength === "number" ? platform.contentLimits.maxBodyLength : undefined;
  const title = value.title ?? work.draft.title, body = value.body ?? work.draft.body;
  const hasError = work.checks.some(check => check.status === "error" && check.platform === account.platform) || !!work.error?.includes(account.name);
  const contents = <div className={styles.targetEditor} data-testid="studio-target-editor">
    <div className={styles.versionHeading}><div><h3>{platform?.name || account.platform}的内容版本</h3><p>公共内容会自动同步；单独调整后，仅用于当前账号。</p></div></div>
    {maxTitle !== 0 && <div className={styles.targetField}><label className={styles.field}><span className={styles.fieldLabel}>标题<small data-invalid={!!maxTitle && title.length > maxTitle}>{title.length}{maxTitle ? ` / ${maxTitle}` : " 字"}</small></span><input className={styles.input} data-testid="studio-target-title" value={title} disabled={disabled} onChange={event => patch({ title: event.target.value })} /></label><Inheritance changed={value.title !== undefined} label="标题" disabled={disabled} onRestore={() => patch({ title: undefined })} /></div>}
    {platform?.editor !== "none" && <div className={styles.targetField}><label className={styles.field}><span className={styles.fieldLabel}>{platform?.editor === "markdown" ? "正文 · Markdown" : "正文"}<small data-invalid={!!maxBody && body.length > maxBody}>{body.length}{maxBody ? ` / ${maxBody}` : " 字"}</small></span><textarea className={styles.textarea} data-testid="studio-target-body" value={body} disabled={disabled} onChange={event => patch({ body: event.target.value })} /></label><Inheritance changed={value.body !== undefined} label="正文" disabled={disabled} onRestore={() => patch({ body: undefined })} /></div>}
    {platform?.topic?.supported !== false && <div className={styles.targetField}><label className={styles.field}><span className={styles.fieldLabel}>话题<small>使用空格分隔</small></span><input className={styles.input} data-testid="studio-target-topics" value={(value.topics ?? work.draft.topics).join(" ")} disabled={disabled} onChange={event => patch({ topics: event.target.value.split(/[,，#]/u).join(" ").split(" ") })} onBlur={() => { if (value.topics !== undefined) patch({ topics: value.topics.map(topic => topic.trim()).filter(Boolean) }); }} /></label><Inheritance changed={value.topics !== undefined} label="话题" disabled={disabled} onRestore={() => patch({ topics: undefined })} /></div>}
    {platform?.topic?.supported === false && <div className={styles.unsupportedField}><p>这个平台当前不接收独立话题。</p>{(value.topics ?? work.draft.topics).length > 0 ? <button type="button" className={styles.smallButton} disabled={disabled} onClick={() => patch({ topics: [] })}>本账号不使用话题</button> : <span>本账号未附带话题</span>}</div>}
    {account.kind === "generic" && fieldPolicy.executionReason && <div className={styles.blockedOption} role="status"><p>{memberPlatformRestriction(account.platform)}</p></div>}
    {account.kind === "generic" && <SchemaOptions platform={account.platform} schema={platform?.optionSchema} value={value.providerOptions ?? platform?.defaultOption ?? {}} disabled={disabled} onChange={providerOptions => patch({ providerOptions })} forceOpen={hasError || Object.keys(fieldPolicy.blockedFields).some(key => value.providerOptions?.[key] !== undefined)} />}
    <StudioLocationOptions account={account} value={value} disabled={disabled} onChange={patch} title={title} />
    {work.draft.contentType !== "text" && <details className={styles.advancedSettings} open={advanced || hasError} onToggle={event => { if (!hasError) setAdvanced(event.currentTarget.open); }}><summary><span>素材与封面</span><small>{value.mediaIds !== undefined || value.cover ? "已单独调整" : "沿用公共内容"}</small><ChevronDown size={16} /></summary><StudioTargetMedia accountId={account.id} contentType={work.draft.contentType} media={work.draft.media} mediaIds={value.mediaIds} disabled={disabled} onChange={mediaIds => patch({ mediaIds })} /><div className={styles.field}><span className={styles.fieldLabel}>本账号封面</span><div className={styles.cover}><div className={styles.coverPreview}>{cover?.url ? <img src={cover.url} alt="该账号使用的封面" /> : <ImagePlus size={22} />}</div><div className={styles.coverCopy}><p>{value.cover ? "已单独设置" : "沿用公共封面"}</p><button type="button" className={styles.smallButton} disabled={disabled} onClick={() => coverInput.current?.click()}>选择封面</button>{value.cover && <button type="button" className={styles.quietButton} disabled={disabled} onClick={() => patch({ cover: undefined })}>恢复公共封面</button>}</div></div><input ref={coverInput} type="file" className={styles.hiddenInput} accept={account.platform === "douyin" ? "image/jpeg,image/png" : "image/jpeg,image/png,image/webp"} aria-label={`${account.name} 的封面`} onChange={event => { const file = event.target.files?.[0]; if (file) void work.setTargetCover(account.id, file); event.target.value = ""; }} /></div></details>}
    {!!platform?.rules?.length && <details className={styles.ruleDisclosure}><summary>查看{platform.name}发布要求</summary><div className={styles.platformRules}>{platform.rules.map(rule => <p key={rule}>{rule}</p>)}</div></details>}
  </div>;
  return inline ? contents : <StudioDialog title={`${account.name} · 单独调整`} description="未单独调整的项目随公共内容更新。" onClose={onClose} testId="studio-target-dialog" wide footer={<button type="button" className={styles.primaryButton} onClick={onClose}>完成调整</button>}>{contents}</StudioDialog>;
}

function Inheritance({ changed, label, disabled, onRestore }: { changed: boolean; label: string; disabled: boolean; onRestore(): void }) { return <div className={styles.inheritance}><span>{changed ? "已单独调整" : "沿用公共内容"}</span>{changed && <button type="button" disabled={disabled} onClick={onRestore}><RotateCcw size={12} />恢复公共{label}</button>}</div>; }
