import { wholeWalletCredits } from "./wallet-credit-conversion";
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
