const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Start of the oldest retained Asia/Shanghai calendar day, expressed in UTC. */
export function beijingCalendarDayWindowStart(now: Date | number = new Date(), retainedDays = 3) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const days = Number.isSafeInteger(retainedDays) && retainedDays > 0 ? retainedDays : 3;
  const beijing = new Date(nowMs + BEIJING_OFFSET_MS);
  const oldestBeijingMidnightAsUtc = Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate() - (days - 1),
  ) - BEIJING_OFFSET_MS;
  return new Date(oldestBeijingMidnightAsUtc).toISOString();
}

export function isWithinBeijingCalendarDayWindow(value: string | number | Date, now: Date | number = new Date(), retainedDays = 3) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp >= Date.parse(beijingCalendarDayWindowStart(now, retainedDays));
}
