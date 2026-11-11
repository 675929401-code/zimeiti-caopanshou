"use client";
/* eslint-disable @next/next/no-img-element */
import { FileImage, Film } from "lucide-react";
import type { PublishingStudioController, StudioAccount, StudioMedia } from "./types";
import { effectiveStudioTargetContent } from "./studio-draft";
import styles from "./Studio.module.css";
export function AccountMark({ account }: { account: StudioAccount }) { return <span className={styles.accountMark}><span aria-hidden="true">{account.name.slice(0, 1)}</span>{account.avatar && <img src={account.avatar} alt="" onLoad={event => { event.currentTarget.hidden = false; }} onError={event => { event.currentTarget.hidden = true; }} />}</span>; }
export function platformName(work: PublishingStudioController, key: string) { return work.platforms.find(platform => platform.key === key)?.name || key; }
export function platformOrder(first: string, second: string) { const preferred = ["douyin", "KWAI", "wxSph", "xhs", "bilibili"]; const rank = (key: string) => { const index = preferred.indexOf(key); return index < 0 ? preferred.length : index; }; return rank(first) - rank(second); }
export function targetMedia(work: PublishingStudioController, account?: StudioAccount): StudioMedia[] { const ids = account ? work.draft.targetOverrides[account.id]?.mediaIds : undefined; return ids === undefined ? work.draft.media : ids.map(id => work.draft.media.find(media => media.id === id)).filter((media): media is StudioMedia => !!media); }
export function scheduleExplanation(account: StudioAccount) { return account.platform === "douyin" && account.kind !== "browser" ? "到期进入官方接力，仍需手机确认" : account.platform === "wxSph" ? "浏览器先提交，再由平台按计划处理" : account.kind === "browser" ? "浏览器计划到期后需在本机继续执行" : "按官方通道的排期能力处理"; }
export function timezoneLabel() { return Intl.DateTimeFormat().resolvedOptions().timeZone || "设备本地时区"; }

const HISTORY_STATE_LABELS: Record<string, string> = { success: "平台报告成功", succeeded: "平台报告成功", published: "平台报告已发布", completed: "已完成", failed: "发布未完成", rejected: "未通过", pending: "已受理，待核对", waiting: "等待官方处理", queued: "队列中", processing: "发布中", publishing: "平台处理中", running: "发布中", dispatching: "提交中", unknown: "结果待核对", awaiting_verification: "作品待核对", browser_reported: "浏览器报告成功，平台待核对", awaiting_user_action: "等待手机接力确认", requires_user_action: "等待平台确认", scheduled: "等待计划时间", planned: "浏览器计划待执行", platform_scheduled: "平台定时状态待核验", cancelled: "任务已取消", canceled: "任务已取消", accepted: "平台已受理" };
export function historyStateLabel(state: string, hasWorkLink = false) {
  if (state === "published") return hasWorkLink ? "平台报告已发布" : "平台状态待作品链接核验";
  return HISTORY_STATE_LABELS[state] || "状态待核对";
}

/** 发布记录分组：进行中 / 成功 / 失败 / 待核对。 */
export type StudioHistoryFilter = "all" | "progress" | "success" | "failed" | "verify";
export function historyStateGroup(state: string): Exclude<StudioHistoryFilter, "all"> {
  if (["pending", "waiting", "queued", "processing", "publishing", "running", "dispatching", "scheduled", "planned", "platform_scheduled", "awaiting_user_action", "requires_user_action", "accepted"].includes(state)) return "progress";
  if (["success", "succeeded", "published", "completed"].includes(state)) return "success";
  if (["failed", "rejected", "cancelled", "canceled"].includes(state)) return "failed";
  return "verify";
}

export function ContentPreview({ work, account, accounts = [], activeId, onSelect }: { work: PublishingStudioController; account?: StudioAccount; accounts?: StudioAccount[]; activeId?: string | null; onSelect?(id: string): void }) {
  const target = account ? work.draft.targetOverrides[account.id] : undefined;
  const media = targetMedia(work, account); const active = media[0];
  const { title, body, topics } = account ? effectiveStudioTargetContent(work.draft, account, work.platforms.find(platform => platform.key === account.platform)) : work.draft;
  const visibleTopics = topics.filter(topic => !body.includes(`#${topic}`));
  const platform = account ? work.platforms.find(item => item.key === account.platform) : undefined;
  const hasTitle = !account || platform?.contentLimits?.maxTitleLength !== 0;
  const maxTitle = typeof platform?.contentLimits?.maxTitleLength === "number" ? platform.contentLimits.maxTitleLength : null;
  const maxBody = typeof platform?.contentLimits?.maxBodyLength === "number" ? platform.contentLimits.maxBodyLength : null;
  const showCounters = account && ((maxTitle !== null && maxTitle > 0) || (maxBody !== null && maxBody > 0));
  return <aside className={styles.livePreview} aria-label="当前内容预览" data-testid="studio-content-preview">
    {accounts.length > 1 && <div className={styles.previewTabs} role="tablist" aria-label="预览账号">{accounts.map(item => <button type="button" role="tab" key={item.id} aria-selected={item.id === activeId} data-testid={`studio-preview-tab-${item.id}`} onClick={() => onSelect?.(item.id)}><AccountMark account={item} /><span>{item.name}</span></button>)}</div>}
    <div className={styles.previewHeading}><span>内容预览</span><small>{account ? platformName(work, account.platform) : "公共内容"}</small></div>
    <div className={styles.postPreview}><div className={styles.postAuthor}>{account ? <AccountMark account={account} /> : <span className={styles.accountMark}>{work.session.userName?.slice(0, 1) || "我"}</span>}<div><strong>{account?.name || work.session.userName || "你的创作账号"}</strong><small>{account ? "当前账号版本" : "选择账号后可单独调整"}</small></div></div>{work.draft.contentType !== "text" && (active ? <div className={styles.postMedia}>{active.url ? active.kind === "video" ? <video src={active.url} controls playsInline preload="metadata" poster={(target?.cover || work.draft.cover)?.url} /> : <img src={active.url} alt={active.name} /> : <Film size={32} />}{media.length > 1 && <span>{media.length} 个素材</span>}</div> : <div className={styles.postMediaEmpty}>{work.draft.contentType === "video" ? <Film size={35} strokeWidth={1.2} /> : <FileImage size={35} strokeWidth={1.2} />}<p>作品会显示在这里</p></div>)}<div className={styles.postContent}>{hasTitle && title && <h3>{title}</h3>}{body ? <p>{body}</p> : <p className={styles.previewPlaceholder}>写下作品的故事，让读者更了解你。</p>}{!!visibleTopics.length && <p className={styles.postTopics}>{visibleTopics.map(topic => `#${topic}`).join(" ")}</p>}</div></div>
    {showCounters && <div className={styles.previewCounters} data-testid="studio-preview-counters">{maxTitle !== null && maxTitle > 0 && <span data-over={title.length > maxTitle}>标题 {title.length}/{maxTitle}</span>}{maxBody !== null && maxBody > 0 && <span data-over={body.length > maxBody}>正文 {body.length}/{maxBody}</span>}</div>}
    <p className={styles.previewFootnote}>展示当前内容与素材，实际版式以平台发布后为准。</p>
  </aside>;
}
