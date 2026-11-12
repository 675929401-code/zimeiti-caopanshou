import { create } from 'zustand'
import { getHostSession, hostStorageKey, loadHostSession, subscribeHostSession } from '@/integration/host-session'
import { useAccountStore } from '../account'

/** Safe main-site projection; no upstream credentials are held or persisted. */
export interface UserInfo { id: string; _id: string; name: string; avatar?: string; role?: string; mail?: string; phone?: string; createdAt?: string; status?: number; updateTime?: string }
interface UserState {
  isAuthenticated: boolean; userInfo?: Partial<UserInfo>; isAddAccountPorxy: boolean; lang: string
  creditsBalance: number; creditsLoading: boolean; creditsInitialized: boolean
  seedanceCreditsBalance: number; seedanceCreditsAvailableBalance: number; seedanceCreditsLoading: boolean; seedanceCreditsInitialized: boolean
  cashCents: number; sidebarCollapsed: boolean; defaultPlanId?: string; hasEverLoggedIn: boolean; _hasHydrated: boolean
}
const initial: UserState = { isAuthenticated: false, userInfo: undefined, isAddAccountPorxy: false, lang: 'zh-CN', creditsBalance: 0, creditsLoading: false, creditsInitialized: false, seedanceCreditsBalance: 0, seedanceCreditsAvailableBalance: 0, seedanceCreditsLoading: false, seedanceCreditsInitialized: false, cashCents: 0, sidebarCollapsed: false, hasEverLoggedIn: false, _hasHydrated: false }
function savePreference(key: string, value: unknown) { const name = hostStorageKey(`preference:${key}`); if (name && typeof window !== 'undefined') localStorage.setItem(name, JSON.stringify(value)) }
export const useUserStore = create<UserState & {
  setLang(value: string): void; setIsAddAccountPorxy(value: boolean): void; appInit(): Promise<void>; getUserInfo(): Promise<Partial<UserInfo> | undefined>
  fetchCreditsBalance(): Promise<void>; fetchSeedanceCreditsBalance(): Promise<void>; setSidebarCollapsed(value: boolean): void; setDefaultPlanId(value: string | undefined): void
}>((set, get) => ({
  ...initial,
  setLang: lang => { set({ lang }); savePreference('lang', lang) },
  setIsAddAccountPorxy: isAddAccountPorxy => set({ isAddAccountPorxy }),
  async appInit() { await loadHostSession(); await useAccountStore.getState().accountInit() },
  async getUserInfo() { await loadHostSession(); return get().userInfo },
  async fetchCreditsBalance() { set({ creditsLoading: true }); try { await loadHostSession() } finally { set({ creditsLoading: false }) } },
  async fetchSeedanceCreditsBalance() { set({ seedanceCreditsLoading: true }); try { await loadHostSession() } finally { set({ seedanceCreditsLoading: false }) } },
  setSidebarCollapsed: sidebarCollapsed => { set({ sidebarCollapsed }); savePreference('sidebarCollapsed', sidebarCollapsed) },
  setDefaultPlanId: defaultPlanId => { set({ defaultPlanId }); savePreference('defaultPlanId', defaultPlanId) },
}))
subscribeHostSession(() => {
  const session = getHostSession()
  if (!session) { useUserStore.setState({ ...initial, _hasHydrated: true }); return }
  const preferences: Partial<UserState> = {}
  if (typeof window !== 'undefined') {
    for (const field of ['sidebarCollapsed', 'defaultPlanId'] as const) {
      try { const key = hostStorageKey(`preference:${field}`); const raw = key ? localStorage.getItem(key) : null; const value = raw ? JSON.parse(raw) : undefined; if (field === 'sidebarCollapsed' && typeof value === 'boolean') preferences.sidebarCollapsed = value; if (field === 'defaultPlanId' && typeof value === 'string') preferences.defaultPlanId = value } catch { /* Invalid UI preference is ignored. */ }
    }
  }
  useUserStore.setState({ ...preferences, isAuthenticated: true, userInfo: { id: session.user.id, _id: session.user.id, name: session.user.displayName, role: session.user.role, ...(session.user.avatarUrl ? { avatar: session.user.avatarUrl } : {}) }, creditsBalance: session.wallet.credits, cashCents: session.wallet.cashCents, creditsInitialized: true, seedanceCreditsBalance: session.wallet.credits, seedanceCreditsAvailableBalance: session.wallet.credits, seedanceCreditsInitialized: true, hasEverLoggedIn: true, _hasHydrated: true })
})
