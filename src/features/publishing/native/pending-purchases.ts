export interface PendingPublishingPurchase { planKey: string; planId: string; planVersion: number; requestKey: string }

/** Preserve the existing owner-scoped v1 storage format for lost-response recovery. */
export function parsePendingPublishingPurchases(raw: string | null): PendingPublishingPurchase[] {
  const value: unknown = JSON.parse(raw ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("购买恢复记录无法读取，请保留浏览器数据并核对原订单");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("购买恢复记录过多，请联系管理员核对");
  const result: PendingPublishingPurchase[] = [];
  for (const [planKey, requestKey] of entries) {
    const match = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):([1-9]\d{0,8})$/iu.exec(planKey);
    if (!match || typeof requestKey !== "string" || !/^purchase:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(requestKey)) throw new Error("购买恢复记录格式异常，请保留原记录并联系管理员");
    if (result.some(item => item.requestKey === requestKey)) throw new Error("购买恢复标识重复，请联系管理员核对原订单");
    result.push({ planKey, planId: match[1], planVersion: Number(match[2]), requestKey });
  }
  return result;
}
export function pendingPublishingPurchaseMap(items: PendingPublishingPurchase[]): Record<string, string> {
  return Object.fromEntries(items.map(item => [item.planKey, item.requestKey]));
}
/** Do not queue a second confirmation behind a purchase from another tab. */
export function withPublishingPurchaseLock<T>(ownerId: string, operation: () => Promise<T>, locks: Pick<LockManager, "request"> | null | undefined = typeof navigator === "undefined" ? undefined : navigator.locks): Promise<T> {
  if (!ownerId || !locks) return Promise.reject(new Error("当前浏览器无法保护跨页面购买，请使用支持 Web Locks 的桌面浏览器核对订单"));
  return locks.request(`publishing.purchase.v1:${ownerId}`, { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock) throw new Error("另一个页面正在处理购买或核对，请等待原页面结果");
    return operation();
  });
}
