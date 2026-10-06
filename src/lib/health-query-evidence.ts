export type ExactCountQueryResult = {
  count: number | null;
  error?: unknown;
};

export type ExactCountEvidence =
  | { available: true; count: number }
  | { available: false; count: null; reason: "query_error" | "invalid_count" };

export function readExactCountEvidence(result: ExactCountQueryResult): ExactCountEvidence {
  if (result.error) {
    return { available: false, count: null, reason: "query_error" };
  }

  if (!Number.isSafeInteger(result.count) || (result.count as number) < 0) {
    return { available: false, count: null, reason: "invalid_count" };
  }

  return { available: true, count: result.count as number };
}
