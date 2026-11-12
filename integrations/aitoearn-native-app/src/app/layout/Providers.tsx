/** Original native theme and global UI, with main-site session ownership. */
'use client'
import { NativePendingRecovery } from '@/integration/NativePendingRecovery'
import { NativeHostBrandingDocument } from '@/integration/host-branding-client'
import { ThemeProvider } from 'next-themes'
import { createContext, useContext, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/shallow'
import LoginDialog from '@/app/layout/LoginDialog'
import SettingsModal from '@/app/layout/SettingsModal'
import { WechatBrowserOverlay } from '@/components/common/WechatBrowserOverlay'
import { PluginPublishingFloatButton } from '@/components/Plugin'
import NotificationCenter from '@/components/ui/NotificationCenter'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { useLoginDialogStore } from '@/store/login-dialog'
import { usePlatformMetadataStore } from '@/store/platformMetadata'
import { useSettingsModalStore } from '@/store/settingsModal'
import { useUserStore } from '@/store/user'
import { clearHostSession, loadHostSession, navigateToHostLogin } from '@/integration/host-session'
const PublicRouteContext = createContext(false)
export function usePublicRoute() { return useContext(PublicRouteContext) }
export function Providers({ children, lng }: { children: React.ReactNode, lng: string }) {
  const [initializing, setInitializing] = useState(true)
  const [error, setError] = useState('')
  const isAuthenticated = useUserStore(state => state.isAuthenticated)
  const { settingsVisible, settingsDefaultTab, closeSettings } = useSettingsModalStore()
  const { appInit, setLang } = useUserStore(useShallow(state => ({ appInit: state.appInit, setLang: state.setLang })))
  useEffect(() => { let active = true; appInit().then(() => { if (!active) return; setError(''); return usePlatformMetadataStore.getState().ensureLoaded(lng) }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '主站会话暂不可读取') }).finally(() => { if (active) setInitializing(false) }); return () => { active = false } }, [appInit, lng])
  useEffect(() => { setLang(lng) }, [lng, setLang])
  useEffect(() => { const changed = (event: StorageEvent) => { if (event.key === 'auth_token' || event.key === 'auth_user' || event.key === null) { clearHostSession(); void loadHostSession().catch(() => {}) } }; window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed) }, [])
  useEffect(() => { const verify = () => { void loadHostSession().catch(() => { useLoginDialogStore.getState().openLoginDialog({ fromGuard: true }) }) }; window.addEventListener('focus', verify); const timer = setInterval(verify, 60000); return () => { window.removeEventListener('focus', verify); clearInterval(timer) } }, [])
  return <PublicRouteContext.Provider value={false}><ThemeProvider attribute="class" storageKey="aitoearn-native.theme.v1" defaultTheme="light" forcedTheme="light" enableSystem={false} disableTransitionOnChange><NativeHostBrandingDocument /><Toaster position="top-center" richColors /><NotificationCenter /><LoginDialog />{isAuthenticated ? <><NativePendingRecovery /><PluginPublishingFloatButton /><WechatBrowserOverlay /><SettingsModal open={settingsVisible} onClose={closeSettings} defaultTab={settingsDefaultTab} />{children}</> : <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-background text-foreground">{initializing ? <><Loader2 className="h-7 w-7 animate-spin" /><p className="text-sm text-muted-foreground">正在核对主站会员会话…</p></> : <><p>{error || '主站会员登录已过期，请重新登录。'}</p><div className="flex gap-3"><Button variant="outline" onClick={() => window.location.reload()}><RefreshCw className="mr-2 h-4 w-4" />重新核对</Button><Button onClick={navigateToHostLogin}>前往主站登录</Button></div></>}</div>}</ThemeProvider></PublicRouteContext.Provider>
}
