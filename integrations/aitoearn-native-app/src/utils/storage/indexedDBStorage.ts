import type { StateStorage } from 'zustand/middleware'
import { hostStorageKey, getHostSessionRevision } from '@/integration/host-session'
class IndexedDBStorage implements StateStorage {
  async getItem(name: string): Promise<string | null> {
    const key = hostStorageKey(name); if (!key || typeof window === 'undefined' || typeof indexedDB === 'undefined') return null
    const version = getHostSessionRevision(); const idb = await import('idb-keyval'); const value = await idb.get<string>(key)
    return version === getHostSessionRevision() && hostStorageKey(name) === key ? value || null : null
  }
  async setItem(name: string, value: string) { const key = hostStorageKey(name); if (!key || typeof window === 'undefined' || typeof indexedDB === 'undefined') return; const version = getHostSessionRevision(); const idb = await import('idb-keyval'); if (version === getHostSessionRevision() && hostStorageKey(name) === key) await idb.set(key, value) }
  async removeItem(name: string) { const key = hostStorageKey(name); if (!key || typeof window === 'undefined' || typeof indexedDB === 'undefined') return; const idb = await import('idb-keyval'); await idb.del(key) }
  async clear() { /* No global IndexedDB/localStorage clearing. */ }
}
export const indexedDBStorage = new IndexedDBStorage()
