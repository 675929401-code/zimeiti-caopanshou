"use client";
import { useEffect, useState } from "react";
import { CreditCard, Package } from "lucide-react";
import { api } from "@/lib/api-client";
import { PublishingActionSchema, PublishingMutationResponseSchema, type PublishingPlan } from "@/lib/publishing-contract";
import { workbenchUserStorageKey } from "@/lib/workbench-user-storage";
import { AppScopedLink } from "@/components/app-scoped-link";
import { PublishingPurchaseRecoverySchema } from "@/lib/publishing-purchase-recovery";
import { parsePendingPublishingPurchases, pendingPublishingPurchaseMap, withPublishingPurchaseLock, type PendingPublishingPurchase } from "./pending-purchases";
import type { NativePublishingState } from "./useNativePublishing";
import { dateLabel, EmptyState, moneyLabel, platformLabel, SectionHeading, WorkbenchDialog } from "./WorkbenchUI";
import styles from "../PublishingWorkbench.module.css";

export function PlansView({ work }: { work: NativePublishingState }) {
  const [purchase, setPurchase] = useState<PublishingPlan | null>(null);
  const [pending, setPending] = useState<PendingPublishingPurchase[]>([]);
  const [pendingReady, setPendingReady] = useState(false);
  const [pendingError, setPendingError] = useState("");
  const storageKey = workbenchUserStorageKey("publishing.pending-purchases.v1", work.identity.userId);
  useEffect(() => {
    const load = () => { try { setPending(parsePendingPublishingPurchases(localStorage.getItem(storageKey))); setPendingError(""); setPendingReady(true); } catch (error) { setPendingError(error instanceof Error ? error.message : "购买恢复记录暂不可读取"); setPendingReady(false); } };
    load(); window.addEventListener("storage", load); return () => window.removeEventListener("storage", load);
  }, [storageKey]);
  const clearConfirmed = (marker: PendingPublishingPurchase) => {
    work.assertOwner();
    const current = parsePendingPublishingPurchases(localStorage.getItem(storageKey));
    const remaining = current.filter(item => item.planKey !== marker.planKey || item.requestKey !== marker.requestKey);
    localStorage.setItem(storageKey, JSON.stringify(pendingPublishingPurchaseMap(remaining))); setPending(remaining);
  };
  const recover = (marker: PendingPublishingPurchase) => withPublishingPurchaseLock(work.identity.userId, async () => {
    work.assertOwner();
    const response = await api.get(`/api/publish-center?purchaseKey=${encodeURIComponent(marker.requestKey)}`, { token: work.identity.token, retries: 0 });
    work.assertOwner(); if (!response.success) throw new Error("原订单暂不可核对，已保留购买标识，请勿另建订单");
    const result = PublishingPurchaseRecoverySchema.parse(response.data);
    if (result.purchaseKey !== marker.requestKey) throw new Error("原订单返回标识不一致，已保留待核对记录");
    if (!result.found || !result.purchase || !result.entitlement) throw new Error("暂未查到原订单，已保留原标识；只能重试同一套餐版本，或联系管理员核对。");
    if (result.purchase.planId !== marker.planId || result.purchase.planVersion !== marker.planVersion) throw new Error("原标识对应其他套餐，请联系管理员核对，勿另建订单");
    clearConfirmed(marker); await work.refresh(); work.setNotice(`原订单已确认：${result.purchase.planName}，执行额度以当前权益记录为准。`);
  });
  const buy = (plan: PublishingPlan) => withPublishingPurchaseLock(work.identity.userId, async () => {
    if (!pendingReady || pendingError) throw new Error(pendingError || "正在核对购买恢复记录");
    if (!work.center?.config.salesEnabled || !work.center.access.allowed) throw new Error("套餐销售尚未开放");
    work.assertOwner();
    const existing = parsePendingPublishingPurchases(localStorage.getItem(storageKey)), planKey = `${plan.id}:${plan.version}`;
    if (existing.some(item => item.planKey !== planKey)) throw new Error("请先核对原购买订单，暂不能另建订单");
    const marker = existing.find(item => item.planKey === planKey) ?? { planKey, planId: plan.id, planVersion: plan.version, requestKey: `purchase:${crypto.randomUUID()}` };
    const next = [...existing.filter(item => item.planKey !== planKey), marker];
    localStorage.setItem(storageKey, JSON.stringify(pendingPublishingPurchaseMap(next))); setPending(next);
    const response = await api.post("/api/publish-center", PublishingActionSchema.parse({ action: "purchase", planId: plan.id, planVersion: plan.version, idempotencyKey: marker.requestKey }), { token: work.identity.token, retries: 0 });
    work.assertOwner(); if (!response.success) throw new Error(typeof response.error === "string" ? response.error : "原购买结果待核对，请勿另建订单");
    const result = PublishingMutationResponseSchema.parse(response.data);
    if (!result.purchase || !result.entitlement || result.purchase.planId !== plan.id || result.purchase.planVersion !== plan.version || result.entitlement.purchaseId !== result.purchase.id) throw new Error("原订单确认信息不完整，请保留购买标识并核对");
    clearConfirmed(marker); setPurchase(null); await work.refresh(); work.setNotice("套餐购买已确认，执行额度已到账。");
  });
  const recoveryNotice = <>{pendingError && <p role="alert" className={styles.hint}>{pendingError}</p>}{pending.length > 0 && <section className={styles.panel} aria-label="待核对购买订单"><h3>待核对购买订单</h3><p>核对只读取原订单。套餐更新或暂停销售后，仍可确认已经到账的原订单；结果未确认前请勿另建订单。</p>{pending.map(marker => <div key={marker.requestKey}><span>{work.center?.plans.find(plan => plan.id === marker.planId && plan.version === marker.planVersion)?.name || "历史发布套餐"} · 版本 {marker.planVersion}</span><button type="button" className={styles.primaryButton} disabled={!!work.busy} onClick={() => void work.run("核对原购买订单", () => recover(marker))}>核对原订单</button></div>)}</section>}</>;
  return <>{recoveryNotice}<SectionHeading title="套餐与执行额度" action={<div className={styles.wallet}><CreditCard size={16} />现金钱包<strong>¥{moneyLabel(work.center?.walletCash || 0)}</strong><AppScopedLink href="/recharge">前往充值</AppScopedLink></div>}>沿用主站现金钱包和原有发布套餐。每个目标平台账号受理一次执行消耗 1 次。</SectionHeading><div className={styles.entitlements}>{work.center?.entitlements.map(item => <article className={styles.entitlementCard} key={item.id}><strong>{item.planName}</strong><small>{item.platforms.map(platformLabel).join(" / ")}</small><p>{Date.parse(item.expiresAt) <= Date.now() ? "已到期" : `${Math.max(0, item.quota - item.used)} 次可用`} · 已用 {item.used}/{item.quota}</p><small>有效至 {dateLabel(item.expiresAt)}</small></article>)}</div><SectionHeading title="可选套餐">{work.center?.config.salesEnabled ? "购买前请核对平台、次数和有效期。" : "套餐销售尚未开放，可先整理内容与保存计划。"}</SectionHeading><div className={styles.planGrid}>{work.center?.plans.filter(item => item.enabled).map(plan => <article className={styles.planCard} key={`${plan.id}:${plan.version}`}><Package size={25} /><h3>{plan.name}</h3><p>{plan.description || "用于浏览器发布的执行额度。"}</p><div className={styles.price}>¥{moneyLabel(plan.priceCents / 100)}</div><ul><li>{plan.quota} 次执行额度</li><li>购买后 {plan.validDays} 天内有效</li><li>{plan.platforms.map(platformLabel).join(" / ")}</li></ul><button type="button" className={styles.primaryButton} disabled={!!work.busy || !pendingReady || !!pendingError || pending.some(item => item.planKey !== `${plan.id}:${plan.version}`) || !work.center?.config.salesEnabled || !work.center.access.allowed} onClick={() => setPurchase(plan)}>查看并确认购买</button></article>)}</div>{!work.center?.plans.some(item => item.enabled) && <div className={styles.panel}><EmptyState title="暂无在售套餐">运营方开售后会显示价格、额度和适用平台。</EmptyState></div>}<p className={styles.hint}>{work.center?.config.usageNotice}</p>
    {purchase && <WorkbenchDialog title="确认购买发布套餐" onClose={() => { if (!work.busy) setPurchase(null); }} footer={<><button type="button" disabled={!!work.busy} onClick={() => setPurchase(null)}>再看看</button>{(work.center?.walletCash || 0) < purchase.priceCents / 100 ? <AppScopedLink href="/recharge" className={styles.primaryLink}>余额不足，前往充值</AppScopedLink> : <button type="button" className={styles.primaryButton} disabled={!!work.busy} onClick={() => void work.run("确认购买套餐", () => buy(purchase))}>确认支付 ¥{moneyLabel(purchase.priceCents / 100)}</button>}</>}><h3>{purchase.name}</h3><dl className={styles.confirmList}><div><dt>本次支付</dt><dd>现金钱包 ¥{moneyLabel(purchase.priceCents / 100)}</dd></div><div><dt>执行额度</dt><dd>{purchase.quota} 次</dd></div><div><dt>有效期</dt><dd>购买后 {purchase.validDays} 天</dd></div><div><dt>适用平台</dt><dd>{purchase.platforms.map(platformLabel).join(" / ")}</dd></div></dl><p className={styles.hint}>购买使用原套餐版本和主站原子钱包操作。网络异常会保留同一订单标识，重试核对同一订单。</p></WorkbenchDialog>}
  </>;
}
