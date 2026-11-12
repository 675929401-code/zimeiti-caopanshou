import type { MobileTopBarProps } from '../types'
/**
 * MobileTopBar - 移动端顶部栏
 * 左侧 Logo + 文字，右侧根据登录状态显示用户头像或菜单图标
 */
import { Menu } from 'lucide-react'
import { useTransClient } from '@/app/i18n/client'
import { NativeHostBrandLogo } from '@/integration/host-branding-client'
import { BrandWordmark } from '@/app/layout/shared'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useUserStore } from '@/store/user'
import { getOssUrl } from '@/utils/oss'

export function MobileTopBar({ onOpen }: MobileTopBarProps) {
  const { t } = useTransClient('common')
  const isAuthenticated = useUserStore(state => state.isAuthenticated)
  const userInfo = useUserStore(state => state.userInfo)

  const isLoggedIn = isAuthenticated && !!userInfo

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-between h-14 px-4 bg-background border-b border-border" data-testid="mobile-topbar">
      {/* Root anchor intentionally leaves the native Next basePath. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="flex min-w-0 items-center gap-2" data-testid="mobile-topbar-logo">
        <NativeHostBrandLogo size={32} />
        <BrandWordmark size="mobile" />
      </a>

      <div className="flex items-center gap-2">
        {isLoggedIn ? (
          <button
            onClick={onOpen}
            data-testid="mobile-topbar-menu-btn"
            className="flex items-center rounded-lg p-1.5 text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <Avatar className="h-7 w-7 shrink-0 border border-border">
              <AvatarImage src={getOssUrl(userInfo.avatar) || ''} alt={userInfo.name || t('unknownUser')} />
              <AvatarFallback className="bg-muted-foreground font-semibold text-background text-xs">
                {userInfo.name?.charAt(0)?.toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
          </button>
        ) : (
          <button
            onClick={onOpen}
            data-testid="mobile-topbar-menu-btn"
            className="flex items-center justify-center w-10 h-10 rounded-lg text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <Menu size={24} />
          </button>
        )}
      </div>
    </div>
  )
}
