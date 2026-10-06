/**
 * Retired browser conversation cache.
 *
 * Conversation history is owned by the authenticated server history API.
 * These compatibility exports deliberately clear the former localStorage key
 * and never serialize, restore, or merge message bodies from the browser.
 */

import type { Conversation } from "@/types/coze";
import { STORAGE_KEYS } from "@/lib/storage-keys";

function getCacheKey(): string {
  return STORAGE_KEYS.CONVERSATION_CACHE;
}

export function isBrowserConversationCacheEnabled(): false {
  return false;
}

export function clearConversationCache(): void {
  try {
    localStorage.removeItem(getCacheKey());
  } catch {
    // Browser storage may be unavailable. No cache value is trusted or read.
  }
}

export function saveConversationsToCache(
  _conversations: Conversation[],
  _userId: string,
): void {
  void _conversations;
  void _userId;
  clearConversationCache();
}

export function loadConversationsFromCache(_userId: string): null {
  void _userId;
  clearConversationCache();
  return null;
}

/** Preserve the server response as the only history source. */
export function mergeCacheWithServer(
  _cached: Conversation[],
  server: Conversation[],
): Conversation[] {
  void _cached;
  return [...server];
}

export function getCachedConversation(
  _convId: string,
  _userId: string,
): null {
  void _convId;
  void _userId;
  clearConversationCache();
  return null;
}
