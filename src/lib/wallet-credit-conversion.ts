function decimalParts(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Invalid wallet conversion amount");
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return { digits: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
}

/** Convert a configured decimal rate exactly, including genuine fractions of a credit. */
export function wholeWalletCredits(yuan: number, creditsPerYuan: number, rounding: "floor" | "ceil") {
  if (creditsPerYuan <= 0) throw new RangeError("Invalid wallet conversion rate");
  const amount = decimalParts(yuan);
  const rate = decimalParts(creditsPerYuan);
  const scale = amount.scale + rate.scale;
  const divisor = BigInt(10) ** BigInt(Math.max(0, scale));
  const numerator = amount.digits * rate.digits * BigInt(10) ** BigInt(Math.max(0, -scale));
  const credits = (numerator + (rounding === "ceil" ? divisor - BigInt(1) : BigInt(0))) / divisor;
  if (credits > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Wallet conversion out of range");
  return Number(credits);
}
