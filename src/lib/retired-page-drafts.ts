import { workbenchUserStorageKey } from './workbench-user-storage';

/** Remove only the retired input/card caches. Task history, auth and billing
 * request identities are separate records and must not be cleared here. */
export function clearRetiredPageDrafts(
  area: 'extract' | 'video',
  userId: string,
  local: Storage,
  session: Storage,
) {
  const bases = area === 'extract'
    ? ['extract_page_state', 'extract_state']
    : ['video_tasks', 'video_selected_model'];
  for (const storage of [local, session]) {
    const keys = new Set(bases.flatMap(base => [base, `app_state_${base}`,
      ...(userId ? [workbenchUserStorageKey(base, userId), `app_state_${workbenchUserStorageKey(base, userId)}`] : [])]));
    try {
      if (area === 'video' && userId) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key?.startsWith(`video-task-checkpoint:v1:${userId}:`)) keys.add(key);
        }
      }
      for (const key of keys) storage.removeItem(key);
    } catch { /* Browser storage restrictions must not block an empty editor. */ }
  }
}
