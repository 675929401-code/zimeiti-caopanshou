export type HttpByteRange = { start: number; end: number };

/** Parse one RFC 7233 byte range. Multipart ranges are intentionally rejected. */
export function parseSingleByteRange(
  value: string | null,
  size: number,
): HttpByteRange | null | "invalid" {
  if (!value) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || value.includes(",")) return "invalid";

  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) {
    return "invalid";
  }

  return { start, end: Math.min(requestedEnd, size - 1) };
}
