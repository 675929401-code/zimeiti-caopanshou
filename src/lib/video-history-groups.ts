type HistoryItem = { id: string; createdAt: string; batchId?: string; batchTopic?: string; cardIndex?: number };
export type VideoHistoryGroup<T> = { key: string; label: string; items: T[] };

const timestamp = (value: string): number => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

/** Mix batches and individual jobs by recency, preserving shot order inside a batch. */
export function groupVideoHistory<T extends HistoryItem>(history: readonly T[]): VideoHistoryGroup<T>[] {
  const groups = new Map<string, { batch: boolean; latest: T; time: number; items: T[] }>();
  for (const item of history) {
    const batch = Boolean(item.batchId);
    const key = batch ? `batch:${item.batchId}` : `task:${item.id}`;
    const time = timestamp(item.createdAt);
    const existing = groups.get(key);
    if (!existing) groups.set(key, { batch, latest: item, time, items: [item] });
    else {
      existing.items.push(item);
      if (time > existing.time) { existing.latest = item; existing.time = time; }
    }
  }
  const dailyBatches = new Map<string, number>();
  return [...groups.entries()].sort(([, left], [, right]) => right.time - left.time).map(([key, group]) => {
    const date = new Date(group.time);
    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let label = group.time ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "时间未记录";
    if (group.batch) {
      const number = (dailyBatches.get(dateKey) || 0) + 1;
      dailyBatches.set(dateKey, number);
      const dateLabel = group.time ? `${date.getMonth() + 1}月${date.getDate()}日` : "时间未记录";
      label = `${dateLabel}_第${number}批_${group.latest.batchTopic || "未命名"}`;
    }
    const order = (item: T) => Number.isInteger(item.cardIndex) && item.cardIndex! >= 0 ? item.cardIndex! : Number.MAX_SAFE_INTEGER;
    return { key, label, items: [...group.items].sort((left, right) => order(left) - order(right)) };
  });
}
