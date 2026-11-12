import type { StateStorage } from 'zustand/middleware'
import { hostStorageKey } from '@/integration/host-session'
class AppLocalStorage implements StateStorage {
  async getItem(name: string) { const key = hostStorageKey(name); return key && typeof window !== 'undefined' ? localStorage.getItem(key) : null }
  async setItem(name: string, value: string) { const key = hostStorageKey(name); if (key && typeof window !== 'undefined') localStorage.setItem(key, value) }
  async removeItem(name: string) { const key = hostStorageKey(name); if (key && typeof window !== 'undefined') localStorage.removeItem(key) }
  async clear() { /* Never clear another application or account storage. */ }
}
export const appLocalStorage = new AppLocalStorage()
