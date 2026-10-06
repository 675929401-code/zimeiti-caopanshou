type TrackedVideoCard = {
  localId: number;
  status: string;
  taskId: string;
  clientRequestId?: string;
  clientRequestFingerprint?: string;
  modelId: string;
  prompt: string;
  batchId: string;
};

const ACTIVE = new Set(['pending', 'queued', 'processing', 'generating', 'finalizing']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,160}$/u;
const prefix = (userId: string) => `video-task-checkpoint:v1:${userId}:`;

export function finishVideoTaskCheckpoint(storage: Storage, userId: string, requestId: string) {
  if (!identifier.test(requestId)) return;
  storage.setItem(prefix(userId) + requestId, JSON.stringify({ version: 1, userId, settled: true }));
}

export function requiresVideoTaskTracking(task: Pick<TrackedVideoCard, 'status' | 'clientRequestId' | 'clientRequestFingerprint'>): boolean {
  return ACTIVE.has(task.status) || (task.status !== 'completed' && task.status !== 'cancelled'
    && Boolean(task.clientRequestId && task.clientRequestFingerprint));
}

/** One key per original request, so another tab cannot replace the whole pending queue. */
export function persistVideoTaskCheckpoint<T extends TrackedVideoCard>(storage: Storage, userId: string, task: T) {
  const requestId = task.clientRequestId || task.taskId;
  if (!requestId) return;
  if (!identifier.test(requestId)) throw new Error('视频任务编号异常，原记录已保留');
  const key = prefix(userId) + requestId;
  if (!requiresVideoTaskTracking(task)) {
    finishVideoTaskCheckpoint(storage, userId, requestId);
    return;
  }
  const previous = JSON.parse(storage.getItem(key) || 'null');
  if (previous?.settled === true && previous.userId === userId) return;
  const value = JSON.stringify({ version: 1, userId, task });
  if (value.length > 1024 * 1024) throw new Error('视频任务内容过大，暂时无法保存追踪记录');
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error('无法保存视频任务追踪，本次尚未提交');
}

export function readVideoTaskCheckpoints<T extends TrackedVideoCard>(storage: Storage, userId: string): T[] {
  const tasks: T[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix(userId))) continue;
    const value = JSON.parse(storage.getItem(key) || 'null');
    if (value?.version === 1 && value.userId === userId && value.settled === true) continue;
    const task = value?.task;
    if (value?.version !== 1 || value.userId !== userId || !task || typeof task !== 'object'
      || !Number.isSafeInteger(task.localId) || task.localId < 1 || typeof task.prompt !== 'string'
      || typeof task.modelId !== 'string' || typeof task.batchId !== 'string' || typeof task.taskId !== 'string'
      || !identifier.test(task.clientRequestId || task.taskId) || !requiresVideoTaskTracking(task)) {
      throw new Error('未完成视频的追踪记录暂时无法读取，原记录已保留');
    }
    tasks.push(task as T);
  }
  return tasks;
}
