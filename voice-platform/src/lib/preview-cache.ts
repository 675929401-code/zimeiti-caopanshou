// 试听音频 IndexedDB 缓存（避免重复调用火山 API）

const DB_NAME = 'zhiyin_workshop';
const STORE_NAME = 'voice_previews';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

interface CachedPreview {
  speakerId: string;
  audioUrl: string;        // blob URL 或火山返回的 URL
  duration: number;
  text: string;
  category: string;
  cachedAt: number;        // 时间戳
  expiresAt: number;       // 过期时间戳
  source: 'local' | 'remote'; // local=blob URL（持久），remote=火山URL（短期）
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'speakerId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedPreview(speakerId: string): Promise<CachedPreview | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(speakerId);
      req.onsuccess = () => {
        const data = req.result as CachedPreview | undefined;
        if (!data) return resolve(null);
        // 检查过期
        if (data.expiresAt < Date.now()) {
          resolve(null);
        } else {
          resolve(data);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCachedPreview(preview: Omit<CachedPreview, 'cachedAt' | 'expiresAt'>): Promise<void> {
  try {
    const db = await openDB();
    const now = Date.now();
    const data: CachedPreview = {
      ...preview,
      cachedAt: now,
      expiresAt: now + TTL_MS,
    };
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(data);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // 静默失败
  }
}

/**
 * 加载试听音频（带缓存）
 * 流程：IndexedDB → 火山 API
 */
export async function loadPreview(
  speakerId: string,
  category?: string
): Promise<{ audioUrl: string; duration: number; text: string; fromCache: boolean }> {
  // 1. 先查缓存
  const cached = await getCachedPreview(speakerId);
  if (cached) {
    return {
      audioUrl: cached.audioUrl,
      duration: cached.duration,
      text: cached.text,
      fromCache: true,
    };
  }

  // 2. 缓存未命中，调用 API
  const res = await fetch('/voice-platform/api/voices/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speakerId, category }),
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(data.message || '试听生成失败');
  }

  const { audioUrl, duration, text } = data.data;

  // 3. 写缓存
  await setCachedPreview({
    speakerId,
    audioUrl,
    duration,
    text,
    category: category || '__default__',
    source: 'remote',
  });

  return { audioUrl, duration, text, fromCache: false };
}

/**
 * 清除所有过期缓存
 */
export async function clearExpiredPreviews(): Promise<number> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      let cleared = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const value = cursor.value as CachedPreview;
          if (value.expiresAt < Date.now()) {
            cursor.delete();
            cleared++;
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(cleared);
      tx.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}
