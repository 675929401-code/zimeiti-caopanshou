import { mergeStoryboardHistory, type StoryboardHistoryItem, type StoryboardLocalVideoEntry } from "./storyboard-local-video-cache";

/** Legacy browser records did not record whether their card index was zero or one based. */
export function mergeStoryboardInlineHistory<T extends StoryboardHistoryItem & { mediaAvailable?: boolean; taskLabel?: string }>(
  remote: readonly T[], local: readonly StoryboardLocalVideoEntry[],
) {
  const authoritative = new Map(remote.map(item => [item.taskId, item]));
  return mergeStoryboardHistory(remote, local).map(item => {
    const task = authoritative.get(item.taskId);
    if (task) return { ...item, cardIndex: task.cardIndex };
    // A local-only record remains usable when its bytes were verified, but its
    // unversioned segment index cannot safely be merged into a different task.
    return { ...item, cardIndex: undefined, mediaAvailable: item.localAvailable,
      taskLabel: "分镜工作台·本机记录" };
  });
}
