export interface HealthErrorTrendResult {
  name: "错误趋势";
  status: "healthy" | "degraded" | "unhealthy";
  message: string;
  details: {
    errors: number | null;
    critical: number | null;
    windowHours: 24;
    availability: "available" | "unavailable";
    errorCode?: "SYSTEM_LOG_QUERY_FAILED";
  };
}

interface CountQueryResult {
  count: number | null;
  error?: unknown;
}

function isAvailableCount(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function unavailableHealthErrorTrend(): HealthErrorTrendResult {
  return {
    name: "错误趋势",
    status: "unhealthy",
    message: "错误趋势数据不可用，当前不能判定为零错误",
    details: {
      errors: null,
      critical: null,
      windowHours: 24,
      availability: "unavailable",
      errorCode: "SYSTEM_LOG_QUERY_FAILED",
    },
  };
}

export function classifyHealthErrorTrend(
  errorResult: CountQueryResult,
  criticalResult: CountQueryResult,
): HealthErrorTrendResult {
  if (
    errorResult.error
    || criticalResult.error
    || !isAvailableCount(errorResult.count)
    || !isAvailableCount(criticalResult.count)
  ) {
    return unavailableHealthErrorTrend();
  }

  const errors = errorResult.count;
  const critical = criticalResult.count;
  const details = { errors, critical, windowHours: 24 as const, availability: "available" as const };

  if (critical > 0) {
    return { name: "错误趋势", status: "unhealthy", message: `24小时内${critical}个严重错误`, details };
  }
  if (errors > 10) {
    return { name: "错误趋势", status: "degraded", message: `24小时内${errors}个错误`, details };
  }
  return { name: "错误趋势", status: "healthy", message: `24小时内${errors}个错误`, details };
}
