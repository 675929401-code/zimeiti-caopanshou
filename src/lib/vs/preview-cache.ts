import { readBrowserWorkbenchIdentity } from '@/lib/workbench-user-storage';
import { resolveVoicePreviewText } from '@/lib/vs/preview-texts';
// 试听音频 IndexedDB 缓存（避免重复调用火山 API）

/**
 * 将 data URL（base64）转换为 Blob URL
 * Blob URL 在浏览器音频播放中比 data URL 更可靠：
 * 1. 不受 data URL 长度限制
 * 2. 浏览器原生支持更好，不会触发 onerror
 * 3. 解码由浏览器底层处理，不阻塞主线程
 */
function dataUrlToBlobUrl(dataUrl: string): string {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return dataUrl;
    const meta = dataUrl.slice(0, commaIdx);
    const base64 = dataUrl.slice(commaIdx + 1);
    const mimeMatch = meta.match(/data:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'audio/mp3';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    return URL.createObjectURL(blob);
  } catch {
    // 转换失败时回退到原始 data URL
    return dataUrl;
  }
}

/**
 * 确保音频 URL 是浏览器友好的格式
 * data: URL → Blob URL（更可靠）
 * http(s): URL → 原样返回
 */
function ensurePlayableUrl(url: string): string {
  if (url.startsWith('data:audio/')) {
    return dataUrlToBlobUrl(url);
  }
  return url;
}

const cacheSpeakerId=(speakerId:string,userId=readBrowserWorkbenchIdentity()?.userId||'')=>{if(!userId)throw new Error('请先登录后试听');return userId+':'+speakerId;};
const DB_NAME = 'zhiyin_workshop';
const STORE_NAME = 'voice_previews';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

/** 简单文本哈希（用于缓存失效检测，不需要密码学安全） */
function textHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return String(hash);
}

interface CachedPreview {
  speakerId: string;
  audioUrl: string;        // 可持久化的 data URL 或服务端 URL
  duration: number;
  text: string;
  textHash: string;        // 文本哈希，文本变化时缓存自动失效
  category: string;
  cachedAt: number;        // 时间戳
  expiresAt: number;       // 过期时间戳
  source: 'local' | 'remote'; // 缓存来源；blob URL 不跨页面保存
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // version 2: 清除旧缓存（修复试听文本截断导致缓存的截断音频）
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // 版本升级时删除旧 store，强制重新合成
      if (event.oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'speakerId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedPreview(speakerId: string,userId:string): Promise<CachedPreview | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      tx.oncomplete=()=>db.close();tx.onabort=()=>db.close();
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(cacheSpeakerId(speakerId,userId));
      req.onsuccess = () => {
        const data = req.result as CachedPreview | undefined;
        if (!data) return resolve(null);
        // 检查过期
        if (data.expiresAt < Date.now() || data.audioUrl.startsWith('blob:')) {
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

async function setCachedPreview(preview: Omit<CachedPreview, 'cachedAt' | 'expiresAt'>,userId:string): Promise<void> {
  try {
    const db = await openDB();
    const now = Date.now();
    const data: CachedPreview = {
      ...preview,
      speakerId: cacheSpeakerId(preview.speakerId,userId),
      cachedAt: now,
      expiresAt: now + TTL_MS,
    };
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(data);
    return new Promise((resolve) => {
      tx.oncomplete = () => {db.close();resolve();};
      tx.onerror = () => {db.close();resolve();};
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
  const ownerId=readBrowserWorkbenchIdentity()?.userId;
  if(!ownerId)throw new Error('请先登录后试听');
  const token=localStorage.getItem('auth_token');
  if(!token)throw new Error('请先登录后试听');
  const assertOwner=()=>{if(readBrowserWorkbenchIdentity()?.userId!==ownerId)throw new Error('账号已切换，请重新试听');};
  // 2. 确定 previewText（缓存校验需要）
  const previewText = resolveVoicePreviewText(category);
  const hash = textHash(previewText);

  // 1. 先查缓存（缓存存原始 data URL，返回时转为 Blob URL 确保可播放）
  const cached = await getCachedPreview(speakerId,ownerId);
  assertOwner();
  if (cached) {
    // 文本哈希不匹配 → 缓存失效（预览文本已更新），跳过缓存
    if (cached.textHash === hash) {
      return {
        audioUrl: ensurePlayableUrl(cached.audioUrl),
        duration: cached.duration,
        text: cached.text,
        fromCache: true,
      };
    }
    // 文本变了，清除旧缓存
    await clearCachedPreview(speakerId,ownerId);
    assertOwner();
  }

  // 2. 缓存未命中或已失效，调用 API
  const res = await fetch('/api/voice/preview', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ category: category || '__default__', speakerId, engine: 'volcano' }),
  });

  if (!res.ok) {
    // 429 限流：不清缓存，直接抛出友好错误
    if (res.status === 429) {
      throw new Error('429: 试听请求过于频繁，请稍后再试');
    }
    await res.json().catch(() => ({}));
    throw new Error('试听服务暂时不可用，请稍后重试');
  }

  const data = await res.json();
  assertOwner();

  // 服务未就绪时保持客户提示稳定，不暴露后台配置。
  if (data.useBrowserFallback) {
    throw new Error('试听服务暂时不可用，请稍后重试');
  }
  if (!data.success && !data.previewMode) {
    throw new Error('试听服务暂时不可用，请稍后重试');
  }

  // 解析响应：/api/voice/preview 返回 { data: TTSResponse }
  // TTSResponse = { success, data: { audioUrl, audioData, duration, ... }, message }
  let audioUrl = '';
  let duration = 0;
  let text = previewText;

  if (data.data) {
    // 嵌套 TTSResponse 结构
    const ttsData = data.data.data || data.data;
    audioUrl = ttsData.audioUrl || '';
    duration = ttsData.duration || 0;
    if (typeof ttsData.text === 'string' && ttsData.text.trim()) {
      text = ttsData.text.trim();
    }

    // base64 音频数据 → data URL
    if (!audioUrl && ttsData.audioData) {
      audioUrl = `data:audio/mp3;base64,${ttsData.audioData}`;
    }
  }

  if (!audioUrl) {
    throw new Error('试听合成未返回有效音频');
  }

  // 3. 写缓存（存原始 data URL，不存 Blob URL，因为 Blob URL 不跨页面持久化）
  await setCachedPreview({
    speakerId,
    audioUrl,
    duration,
    text,
    textHash: textHash(text),
    category: category || '__default__',
    source: 'remote',
  },ownerId);
  assertOwner();

  // 返回时转为 Blob URL，确保浏览器音频播放兼容性
  return { audioUrl: ensurePlayableUrl(audioUrl), duration, text, fromCache: false };
}

/**
 * 清除指定 speakerId 的缓存
 */
export async function clearCachedPreview(speakerId: string,userId=readBrowserWorkbenchIdentity()?.userId||''): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(cacheSpeakerId(speakerId,userId));
    return new Promise((resolve) => {
      tx.oncomplete = () => {db.close();resolve();};
      tx.onerror = () => {db.close();resolve();};
    });
  } catch {
    // 静默失败
  }
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
      tx.oncomplete = () => {db.close();resolve(cleared);};
      tx.onerror = () => {db.close();resolve(0);};
    });
  } catch {
    return 0;
  }
}
