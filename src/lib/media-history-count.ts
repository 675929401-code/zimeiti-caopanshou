export interface MediaHistoryCountSummary {
  count: number | null;
  exact: boolean;
  windowLimit: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

export function summarizeMediaHistoryCount(
  payload: unknown,
  fallbackWindowLimit = 20,
): MediaHistoryCountSummary {
  const body = isRecord(payload) ? payload : {};
  const pagination = isRecord(body.pagination) ? body.pagination : {};
  const windowLimit = nonNegativeInteger(pagination.limit) || Math.max(1, fallbackWindowLimit);
  const exactTotal = nonNegativeInteger(body.totalCount);
  const compatibleTotal = pagination.totalKnown === true
    ? nonNegativeInteger(body.total)
    : null;
  const total = exactTotal ?? compatibleTotal;

  if (total !== null) {
    return { count: total, exact: true, windowLimit };
  }

  return {
    count: Array.isArray(body.items) ? body.items.length : null,
    exact: false,
    windowLimit,
  };
}
