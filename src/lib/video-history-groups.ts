import { groupVideoHistory as groupByPolicy } from "./video-history-policy";

type HistoryItem = { id: string; createdAt: string; batchId?: string; batchTopic?: string; cardIndex?: number };
export type VideoHistoryGroup<T> = { key: string; label: string; items: T[] };

/** Legacy flat adapter; ordering and Beijing dates belong to the shared policy. */
export function groupVideoHistory<T extends HistoryItem>(history: readonly T[]): VideoHistoryGroup<T>[] {
  return groupByPolicy(history).flatMap(day => day.batches.map(batch => ({
    key: batch.batchId,
    label: `${day.label} · ${batch.batchTopic || (batch.batchId.startsWith("task:") ? "独立视频" : "视频批次")}`,
    items: batch.items,
  })));
}
