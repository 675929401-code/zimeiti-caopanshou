/**
 * BottomSection - 底部功能区容器
 * 保留插件业务入口，账户区域只展示主站现金与积分。
 */

'use client'

import type { BottomSectionProps } from '../../types'
import { Wallet } from 'lucide-react'
import { useUserStore } from '@/store/user'
import { cn } from '@/utils/className'
import { PluginEntry } from './PluginEntry'

export function BottomSection({ collapsed }: BottomSectionProps) {
  const cashCents = useUserStore(state => state.cashCents)
  const credits = useUserStore(state => state.creditsBalance)
  const creditsLoading = useUserStore(state => state.creditsLoading)
  const creditsInitialized = useUserStore(state => state.creditsInitialized)
  const walletLoading = creditsLoading || !creditsInitialized
  const cashLabel = walletLoading ? '现金 加载中…' : `现金 ¥${(cashCents / 100).toFixed(2)}`
  const creditsLabel = walletLoading ? '积分 加载中…' : `积分 ${credits}`
  const walletLabel = `${cashLabel} · ${creditsLabel}`

  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-t border-sidebar-border pt-3',
        collapsed && 'items-center',
      )}
    >
      <PluginEntry collapsed={collapsed} />
      <div
        role="status"
        aria-live="polite"
        aria-busy={walletLoading}
        aria-label={walletLabel}
        title={walletLabel}
        data-testid="sidebar-wallet"
        className={cn(
          'flex items-center gap-3 rounded-lg py-2 text-sm text-muted-foreground',
          collapsed ? 'h-9 w-9 justify-center' : 'px-3',
        )}
      >
        <Wallet size={18} className="shrink-0" />
        {!collapsed && (
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{cashLabel}</span>
            <span className="text-[11px]">{creditsLabel}</span>
          </span>
        )}
      </div>
    </div>
  )
}

export { PluginEntry } from './PluginEntry'
