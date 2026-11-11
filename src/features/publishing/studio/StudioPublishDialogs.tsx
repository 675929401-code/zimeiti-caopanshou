"use client";
import { useEffect, useState } from "react";
import { Send, ShieldCheck } from "lucide-react";
import type { PublishingStudioController } from "./types";
import { BusyLabel, dateText, fileSize, StudioDialog } from "./StudioPrimitives";
import { platformName } from "./StudioPresentation";
import { AuthorizationDialog } from "./StudioAuthorizationDialog";
import { StudioOptionsSummary } from "./StudioSchemaOptions";
import { genericPublishingFieldPolicy } from "@/lib/publishing-generic-validation";
import styles from "./Studio.module.css";
const cashText = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
const cashReason: Record<string, string> = {
  insufficient_balance: "可用现金不足，请充值后重新核对费用，或返回调整目标账号。",
  pricing_unavailable: "暂时无法确认本次费用，请稍后重新核对。",
  execution_disabled: "当前发布服务尚未开放，本次不会提交或扣款。",
  account_changed: "账号授权状态已变化，请返回核对账号后再发布。",
  access_denied: "当前账号没有发布权限，请联系站方处理。",
};
function PublishReviewDialog({ work }: { work: PublishingStudioController }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const review = work.review!;
  const quote = review.cashQuote;
  const expiresAt = quote ? Date.parse(quote.expiresAt) : NaN;
  const expired = !Number.isFinite(expiresAt) || now >= expiresAt;
  const pricesMatch = !!quote && quote.targets.length === review.targets.length && review.targets.every(target => quote.targets.filter(price => price.accountId === target.accountId && price.platform === target.platform && price.transport === target.transport).length === 1);
  const canConfirm = !!quote && quote.canExecute && quote.reasonCode === "ready" && pricesMatch && !expired;
  const reason = !quote ? "暂时无法确认本次费用，请返回重新检查。" : !pricesMatch ? "账号与费用信息已变化，请重新核对。" : expired ? "本次报价已过期。请重新核对费用后再确认发布。" : !quote.canExecute ? cashReason[quote.reasonCode] || "本次发布暂不能提交，请返回检查账号和内容。" : "";
  const recheck = () => { work.cancelReview(); void (review.recovery ? work.recoverPending() : work.checkDraft()); };
  return <StudioDialog title={review.recovery ? "确认剩余账号的发布费用" : "确认这次发布"} description="请核对各账号的最终内容、时间和费用。确认后将传输素材并提交发布。" testId="studio-confirm-dialog" onClose={work.cancelReview} wide footer={<>
    <button type="button" data-studio-focus="true" className={styles.button} data-testid="studio-confirm-cancel" onClick={work.cancelReview}>返回编辑</button>
    {(!quote || expired || !pricesMatch || quote.reasonCode === "insufficient_balance") && <button type="button" className={styles.button} data-testid="studio-confirm-recheck" disabled={!!work.busy} onClick={recheck}>重新核对费用</button>}
    <button type="button" className={styles.primaryButton} data-testid="studio-confirm-submit" disabled={!!work.busy || !canConfirm} onClick={() => { if (canConfirm && Date.now() < expiresAt) void work.publish(review.id); }}><BusyLabel busy={!!work.busy}><Send size={15} />确认并发布</BusyLabel></button>
  </>}>
    <dl className={styles.reviewList}><dt>发布内容</dt><dd>{review.title || "未命名内容"}</dd><dt>素材数量</dt><dd>{review.mediaCount} 个</dd><dt>发布时间</dt><dd>{review.scheduledAt ? dateText(review.scheduledAt) : "确认后立即发起"}</dd><dt>目标账号</dt><dd>{review.targets.length} 个</dd></dl>
    {quote && <section className={styles.reviewTarget} data-testid="studio-cash-quote" aria-label="本次发布现金费用"><dl className={styles.reviewList}><dt>本次费用合计</dt><dd data-testid="studio-cash-total"><strong>{cashText(quote.estimatedChargeCents)}</strong></dd><dt>可用现金</dt><dd data-testid="studio-cash-balance">{cashText(quote.availableBalanceCents)}</dd><dt>报价有效至</dt><dd data-testid="studio-cash-expires"><time dateTime={quote.expiresAt}>{new Date(quote.expiresAt).toLocaleString("zh-CN", { hour12: false })}</time>{expired ? " · 已过期" : ""}</dd></dl><p className={styles.fieldHint}>按目标账号开始执行时扣款。结果不明请先核对原任务，不会自动退款；可用现金已扣除其他任务暂占金额。</p></section>}
    {reason && <p className={styles.fieldHint} role="alert" data-testid="studio-cash-unavailable">{reason}</p>}
    <div className={styles.reviewTargets}>{review.targets.map(item => {
      const price = quote?.targets.find(target => target.accountId === item.accountId && target.platform === item.platform && target.transport === item.transport);
      return <section key={item.accountId} className={styles.reviewTarget}><div><strong>{item.accountName}</strong><span>{platformName(work, item.platform)} · {item.transport === "official_api" ? "官方授权通道" : "浏览器插件"}</span></div>
        {price && <p className={styles.reviewTopics} data-testid={`studio-cash-target-${item.accountId}`}>本账号费用：{cashText(price.chargeCents)}</p>}
        <p className={styles.reviewTopics}>发布时间：{item.publishAt ? dateText(item.publishAt) : "确认后立即发起"}</p><h3>{work.platforms.find(platform => platform.key === item.platform)?.contentLimits?.maxTitleLength === 0 ? "该平台不使用独立标题" : item.title || "无单独标题"}</h3><p>{item.body || "无正文"}</p>{!!item.topics.length && <p className={styles.reviewTopics}>{item.topics.map(topic => `#${topic}`).join(" ")}</p>}{item.mediaNames && <div className={styles.reviewMedia}>本账号素材 {item.mediaNames.length} 个<ol>{item.mediaNames.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}</ol></div>}{item.coverName && <p className={styles.reviewTopics}>封面：{item.coverName}</p>}{genericPublishingFieldPolicy(item.platform).allowedValues.visibility?.includes("PUBLIC") && <p className={styles.reviewTopics}>实际可见范围：公开</p>}{genericPublishingFieldPolicy(item.platform).allowedValues.video_state?.includes("PUBLISHED") && <p className={styles.reviewTopics}>此通道会提交发布，不保存为平台草稿。</p>}{item.options && <StudioOptionsSummary options={item.options} schema={work.platforms.find(platform => platform.key === item.platform)?.optionSchema} />}</section>;
    })}</div>
    <div className={styles.reviewNote}><ShieldCheck size={17} /><span>浏览器回报与平台最终结果分别记录；手机接力仍需在平台继续确认。遇到结果待核对，请查询原任务。</span></div>
  </StudioDialog>;
}
export function StudioPublishDialogs({work}: {work: PublishingStudioController}) {return <>
    {work.review && !work.bridgeConfirmation && <PublishReviewDialog key={work.review.id} work={work} />}
    {work.bridgeConfirmation && <StudioDialog title={work.bridgeConfirmation.title} description={work.bridgeConfirmation.message} testId="studio-transfer-confirm-dialog" onClose={() => work.confirmBridge(false)} footer={<><button type="button" data-studio-focus="true" className={styles.button} onClick={() => work.confirmBridge(false)}>取消传输</button><button type="button" className={styles.primaryButton} disabled={work.bridgeConfirmation.blocked} onClick={() => work.confirmBridge(true)}>{work.bridgeConfirmation.confirmLabel}</button></>}><div className={styles.historyList}>{work.bridgeConfirmation.items.map((item, index) => <div key={`${item.name}-${index}`}><strong>{item.name}</strong><p className={styles.fieldHint}>{fileSize(item.size)} · {item.accounts.join("、")}</p></div>)}</div></StudioDialog>}
    {(work.authorization || work.authorizationFlow) && <AuthorizationDialog key={work.authorization?.sessionId || work.authorizationFlow?.platform} work={work} />}
</>;}
