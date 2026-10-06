export type SingleByteRangeResult =
  | { kind: "none" }
  | { kind: "satisfiable"; start: number; end: number }
  | { kind: "unsatisfiable" };

export function parseSingleByteRange(
  headerValue: string | null,
  fileSize: number,
): SingleByteRangeResult {
  if (!headerValue) return { kind: "none" };
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return { kind: "unsatisfiable" };

  const match = /^bytes=(\d*)-(\d*)$/i.exec(headerValue.trim());
  if (!match || (!match[1] && !match[2])) return { kind: "unsatisfiable" };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable" };
    }
    return {
      kind: "satisfiable",
      start: Math.max(0, fileSize - suffixLength),
      end: fileSize - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= fileSize
  ) {
    return { kind: "unsatisfiable" };
  }

  return {
    kind: "satisfiable",
    start,
    end: Math.min(requestedEnd, fileSize - 1),
  };
}
