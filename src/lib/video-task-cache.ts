/**
 * 视频任务本地缓存 — 1 小时 TTL
 *
 * 解决的问题：
 * - 页面刷新 → 任务状态丢失
 * - 切换窗口 → 回来内容没了
 * - 意外关闭 → 工作全丢
 *
 * 策略：
 * - localStorage 持久化（跨刷新、跨导航）
 * - 1 小时 TTL，过期自动清除，恢复默认 3 张空白卡片
 * - 用户主动清空时清除缓存
 * - 按用户 ID 隔离
 */

/* ── Types ── */

/** 可序列化的任务卡片（去掉运行时字段） */
export interface SerializableTaskCard {
  localId: number;
  prompt: string;
  negativePrompt: string;
  firstFrameUrl: string;
  lastFrameUrl: string;
  referenceImageUrl: string;
  status: "idle" | "pending" | "queued" | "processing" | "generating" | "completed" | "failed" | "cancelled";
  taskId: string;
  modelId: string;
  contentUrl: string;
  videoUrl: string;
  thumbnailUrl: string;
  errorMessage: string;
  submittedAt?: number;
  progress?: number;
  cardIndex: number;
  batchId: string;
  taskLabel?: string;
  theme?: string;
  batchTopic: string;
}

export interface VideoTaskCache {
  version: number;
  userId: string;
  savedAt: number; // timestamp
  tasks: SerializableTaskCard[];
  batchTopic: string;
  nextLocalId: number;
  currentCardCounter: number;
  currentBatchId: string;
}

/* ── Constants ── */

const CACHE_VERSION = 1;
const CACHE_KEY = "video_task_cache";
const TTL_MS = 60 * 60 * 1000; // 1 hour

/* ── Helpers ── */

function buildKey(userId: string): string {
  return `${CACHE_KEY}_${userId}`;
}

/**
 * 从 TaskCard 数组中提取可序列化的部分
 * 去掉 pollStuckCount、lastProgress 等运行时字段
 */
function serializeTasks(
  tasks: SerializableTaskCard[]
): SerializableTaskCard[] {
  return tasks.map((t) => ({
    localId: t.localId,
    prompt: t.prompt,
    negativePrompt: t.negativePrompt,
    firstFrameUrl: t.firstFrameUrl,
    lastFrameUrl: t.lastFrameUrl,
    referenceImageUrl: t.referenceImageUrl,
    status: t.status,
    taskId: t.taskId,
    modelId: t.modelId,
    contentUrl: t.contentUrl,
    videoUrl: t.videoUrl,
    thumbnailUrl: t.thumbnailUrl,
    errorMessage: t.errorMessage,
    submittedAt: t.submittedAt,
    progress: t.progress,
    cardIndex: t.cardIndex,
    batchId: t.batchId,
    taskLabel: t.taskLabel,
    theme: t.theme,
    batchTopic: t.batchTopic,
  }));
}

/* ── Public API ── */

/**
 * 保存视频任务到 localStorage
 */
export function saveVideoTaskCache(
  userId: string,
  tasks: SerializableTaskCard[],
  meta: {
    batchTopic: string;
    nextLocalId: number;
    currentCardCounter: number;
    currentBatchId: string;
  }
): void {
  if (typeof window === "undefined") return;
  if (!userId) return;

  try {
    const cache: VideoTaskCache = {
      version: CACHE_VERSION,
      userId,
      savedAt: Date.now(),
      tasks: serializeTasks(tasks),
      batchTopic: meta.batchTopic,
      nextLocalId: meta.nextLocalId,
      currentCardCounter: meta.currentCardCounter,
      currentBatchId: meta.currentBatchId,
    };
    const json = JSON.stringify(cache);
    // 容量保护：超过 2MB 不写入
    if (json.length > 2 * 1024 * 1024) {
      console.warn("[video-cache] 缓存数据过大，跳过写入");
      return;
    }
    localStorage.setItem(buildKey(userId), json);
  } catch {
    // localStorage 满或不可用时静默失败
  }
}

/**
 * 从 localStorage 恢复视频任务
 * 返回 null 表示无有效缓存（过期/不存在/版本不匹配）
 */
export function loadVideoTaskCache(
  userId: string
): VideoTaskCache | null {
  if (typeof window === "undefined") return null;
  if (!userId) return null;

  try {
    const raw = localStorage.getItem(buildKey(userId));
    if (!raw) return null;

    const cache = JSON.parse(raw) as VideoTaskCache;

    // 版本检查
    if (cache.version !== CACHE_VERSION) {
      clearVideoTaskCache(userId);
      return null;
    }

    // 用户隔离检查
    if (cache.userId !== userId) {
      clearVideoTaskCache(userId);
      return null;
    }

    // TTL 检查：超过 1 小时则清除
    if (Date.now() - cache.savedAt > TTL_MS) {
      clearVideoTaskCache(userId);
      return null;
    }

    // 数据完整性检查
    if (!Array.isArray(cache.tasks)) {
      clearVideoTaskCache(userId);
      return null;
    }

    return cache;
  } catch {
    return null;
  }
}

/**
 * 清除视频任务缓存（用户主动清空时调用）
 */
export function clearVideoTaskCache(userId: string): void {
  if (typeof window === "undefined") return;
  if (!userId) return;
  try {
    localStorage.removeItem(buildKey(userId));
  } catch {
    // ignore
  }
}

/**
 * 检查缓存是否包含有意义的任务（非全空白）
 */
export function hasActiveTasks(tasks: SerializableTaskCard[]): boolean {
  return tasks.some(
    (t) =>
      t.prompt.trim() !== "" ||
      t.firstFrameUrl !== "" ||
      t.lastFrameUrl !== "" ||
      t.referenceImageUrl !== "" ||
      t.videoUrl !== "" ||
      t.status === "pending" ||
      t.status === "queued" ||
      t.status === "processing" ||
      t.status === "generating"
  );
}
