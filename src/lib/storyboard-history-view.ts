import { isVideoHistoryProtected } from "./video-history-policy";

/** View-only storyboard history rules. Card indexes in this module are zero based. */
export type StoryboardRecordFilter = "all" | "playable" | "active" | "unavailable" | "failed";

export interface StoryboardHistoryRecord {
  taskId: string;
  batchId?: string;
  cardIndex?: number;
  status: string;
  createdAt: string;
  billingState?: string;
  mediaAvailable?: boolean;
  deliveryState?: string;
}

export interface StoryboardSegment<T extends StoryboardHistoryRecord = StoryboardHistoryRecord> {
  key: string;
  cardIndex: number | undefined;
  attempts: T[];
  latest: T;
}

const validCardIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Convert the persisted one-based history card number exactly once at its boundary. */
export function normalizeStoryboardHistoryCardIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value - 1 : undefined;
}

export function storyboardRecordState(
  item: StoryboardHistoryRecord,
  localAvailable = false,
): Exclude<StoryboardRecordFilter, "all"> {
  if (isVideoHistoryProtected(item)) return "active";
  if (item.status === "completed") {
    return localAvailable || (item.mediaAvailable !== false && item.deliveryState !== "expired")
      ? "playable" : "unavailable";
  }
  return "failed";
}

export function matchesStoryboardRecord(
  item: StoryboardHistoryRecord,
  filter: StoryboardRecordFilter,
  localAvailable = false,
): boolean {
  return filter === "all" || storyboardRecordState(item, localAvailable) === filter;
}

export function storyboardSegmentKey(item: StoryboardHistoryRecord): string {
  return validCardIndex(item.cardIndex) ? `segment:${item.cardIndex}` : `task:${item.taskId}`;
}

function compareAttempts(a: StoryboardHistoryRecord, b: StoryboardHistoryRecord): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  const timeDiff = (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
  if (timeDiff) return timeDiff;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** Repeated task snapshots are updates, not additional generation attempts. Last snapshot wins. */
function uniqueRecords<T extends StoryboardHistoryRecord>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [item.taskId, item])).values()];
}

export function groupStoryboardSegments<T extends StoryboardHistoryRecord>(
  items: readonly T[],
): StoryboardSegment<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of uniqueRecords(items)) {
    // JSON tuple boundaries prevent arbitrary batch IDs from colliding with segment keys.
    const key = JSON.stringify([item.batchId ?? null, storyboardSegmentKey(item)]);
    const attempts = groups.get(key);
    if (attempts) attempts.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, attempts]) => {
    attempts.sort(compareAttempts);
    const latest = attempts[attempts.length - 1];
    return {
      key,
      cardIndex: validCardIndex(latest.cardIndex) ? latest.cardIndex : undefined,
      attempts,
      latest,
    };
  }).sort((a, b) => {
    if (a.cardIndex !== undefined || b.cardIndex !== undefined) {
      if (a.cardIndex === undefined) return 1;
      if (b.cardIndex === undefined) return -1;
      if (a.cardIndex !== b.cardIndex) return a.cardIndex - b.cardIndex;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function chooseStoryboardAttempt<T extends StoryboardHistoryRecord>(
  segment: StoryboardSegment<T>,
  filter: StoryboardRecordFilter,
  selectionTaskId?: string,
  localAvailablePredicate: (item: T) => boolean = () => false,
): T | undefined {
  const matches = segment.attempts.filter((item) => matchesStoryboardRecord(item, filter, localAvailablePredicate(item)));
  return matches.find((item) => item.taskId === selectionTaskId) ?? matches[matches.length - 1];
}

/** Version numbers always refer to all attempts, including attempts hidden by a filter. */
export function versionNumber<T extends StoryboardHistoryRecord>(segment: StoryboardSegment<T>, taskId: string): number | undefined {
  const index = segment.attempts.findIndex((item) => item.taskId === taskId);
  return index < 0 ? undefined : index + 1;
}

export function statsStoryboardRecords<T extends StoryboardHistoryRecord>(
  items: readonly T[],
  localAvailablePredicate: (item: T) => boolean = () => false,
): Record<StoryboardRecordFilter, number> {
  const stats: Record<StoryboardRecordFilter, number> = { all: 0, playable: 0, active: 0, unavailable: 0, failed: 0 };
  for (const item of uniqueRecords(items)) {
    stats.all += 1;
    stats[storyboardRecordState(item, localAvailablePredicate(item))] += 1;
  }
  return stats;
}
