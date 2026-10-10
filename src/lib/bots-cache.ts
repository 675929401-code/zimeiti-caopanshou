/**
 * /api/bots 的内存缓存模块
 * 
 * 提供缓存读写 + 主动失效能力。
 * 排序/增删改等写操作后调用 invalidateBotsCache() 即可让下次请求拿到最新数据。
 */

import { sharedConfigurationEnabled } from "@/storage/database/configuration-source";

const CACHE_TTL_MS = 60 * 1000;

// 类型：Record<cacheKey, { data: any, expiresAt: number }>
const cache = new Map<string, { data: unknown; expiresAt: number }>();

/** 读取缓存，命中返回数据，未命中返回 null */
export function getBotsCache(key: string): unknown | null {
  // Shared configuration can be changed by another web process. A process-local
  // cache cannot observe that invalidation, so shared mode always reads the
  // authoritative configuration database.
  if (sharedConfigurationEnabled()) {
    cache.clear();
    return null;
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  // 过期条目顺手清理
  if (cached) cache.delete(key);
  return null;
}

/** 写入缓存 */
export function setBotsCache(key: string, data: unknown): void {
  if (sharedConfigurationEnabled()) {
    cache.clear();
    return;
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** 主动失效全部缓存（排序/增删改后调用） */
export function invalidateBotsCache(): void {
  cache.clear();
}
