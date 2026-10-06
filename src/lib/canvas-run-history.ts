export const CANVAS_HISTORY_RETENTION_DAYS = 3;
export const CANVAS_HISTORY_MAX_RETENTION_DAYS = 5;
export const CANVAS_HISTORY_MAX_RECORDS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export function cleanCanvasRunHistory<T extends { startedAt: string }>(
  records: T[],
  now = Date.now(),
  requestedRetentionDays = CANVAS_HISTORY_RETENTION_DAYS,
) {
  const retentionDays = Math.min(
    CANVAS_HISTORY_MAX_RETENTION_DAYS,
    Math.max(1, Math.floor(requestedRetentionDays)),
  );
  const cutoff = now - retentionDays * DAY_MS;

  return records
    .filter((record) => {
      const startedAt = Date.parse(record.startedAt);
      return Number.isFinite(startedAt) && startedAt >= cutoff && startedAt <= now + DAY_MS;
    })
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, CANVAS_HISTORY_MAX_RECORDS);
}
