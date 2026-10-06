const CJK_RE = /[\u3400-\u9fff]/gu;
const MOJIBAKE_MARK_RE = /[\u0080-\u009f�]|(?:Ã|Â|â|å|æ|ç|è|é|ä|ö|ü|ï|ð|þ)/gu;

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function suspiciousScore(value: string): number {
  const mojibakeMarks = countMatches(value, MOJIBAKE_MARK_RE);
  const questionRuns = countMatches(value, /\?{3,}/gu) * 2;
  const brokenPunctuation = countMatches(value, /(?:Â¥|ï¼|â€|â€™|â€œ|â€�|ã€)/gu) * 2;
  return mojibakeMarks + questionRuns + brokenPunctuation;
}

function decodeLatin1AsUtf8(value: string): string | null {
  try {
    const bytes = new Uint8Array(Array.from(value, (char) => char.charCodeAt(0) & 0xff));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function isLikelyMojibake(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return suspiciousScore(value) >= 2;
}

/**
 * Repairs the common failure mode where UTF-8 Chinese was read back as latin1/Windows-1252.
 * It is deliberately conservative: valid Chinese text is returned unchanged.
 */
export function repairLikelyMojibake(value: unknown): string {
  if (value == null) return "";
  const original = String(value);
  if (!original) return "";

  const originalSuspicious = suspiciousScore(original);
  if (originalSuspicious === 0) return original;

  const repaired = decodeLatin1AsUtf8(original);
  if (!repaired || repaired === original) return original;

  const originalCjk = countMatches(original, CJK_RE);
  const repairedCjk = countMatches(repaired, CJK_RE);
  const repairedSuspicious = suspiciousScore(repaired);

  if (repairedCjk > originalCjk && repairedSuspicious < originalSuspicious) {
    return repaired;
  }
  if (repairedSuspicious + 3 < originalSuspicious) {
    return repaired;
  }
  return original;
}

export function normalizeDisplayText(value: unknown, fallback = ""): string {
  const repaired = repairLikelyMojibake(value).replace(/\s+/gu, " ").trim();
  if (!repaired) return fallback;
  if (/\?{3,}/u.test(repaired)) return fallback || repaired.replace(/\?{3,}/gu, "未知");
  return repaired;
}
