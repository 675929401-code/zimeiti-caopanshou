import { wholeWalletCredits } from "./wallet-credit-conversion";

export const RECHARGE_MIN_YUAN = { cash: 10, credits: 100 } as const;
export const CASH_RECHARGE_STEP_YUAN = 10;
export const RECHARGE_MAX_YUAN = 50_000;

/** Applies to new member orders only. Existing payments settle against their original order. */
export function rechargeAmountError(type: keyof typeof RECHARGE_MIN_YUAN, amount: number | null): string | null {
  if (amount === null) return "请输入有效金额，最多保留两位小数";
  if (amount < RECHARGE_MIN_YUAN[type]) return `最低${RECHARGE_MIN_YUAN[type]}元起充`;
  if (amount > RECHARGE_MAX_YUAN) return "单笔充值金额不能超过5万元";
  if (type === "cash" && amount % CASH_RECHARGE_STEP_YUAN !== 0) return "现金充值金额须为10元的倍数";
  return null;
}
export function normalizeRechargeAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  if (cents <= 0 || !Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-8) return null;
  return cents / 100;
}

/** Amount is validated to whole fen before conversion. Work in fen to avoid binary rounding at whole-credit boundaries. */
export function rechargeCreditsForAmount(yuan: number, creditsPerYuan: number): number {
  return wholeWalletCredits(yuan, creditsPerYuan, "floor");
}
