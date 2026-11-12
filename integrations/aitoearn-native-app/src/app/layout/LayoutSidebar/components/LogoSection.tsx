/**
 * LogoSection - 侧边栏 Logo 区域
 */

'use client'

import type { LogoSectionProps } from '../types'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { BrandWordmark } from '@/app/layout/shared'
import { NativeHostBrandLogo } from '@/integration/host-branding-client'
import { cn } from '@/utils/className'

export function LogoSection({ collapsed, onToggle }: LogoSectionProps) {
  return (
    <div
      className={cn(
        'mb-3 flex items-center',
        collapsed ? 'justify-center px-1 py-2' : 'justify-between gap-2 px-2 py-2',
      )}
    >
      {collapsed ? (
        // 保留可点击的主站入口，展开按钮仅占右下角，不覆盖 Logo。
        <div className="relative flex h-8 w-8 items-center justify-center">
          {/* 根锚点越过子应用 basePath，沿用当前主站会员会话。 */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            aria-label="返回主站应用广场"
            title="返回主站应用广场"
            className="flex h-8 w-8 items-center justify-center rounded-md transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            data-testid="sidebar-logo-link"
          >
            <NativeHostBrandLogo size={32} />
          </a>
          <button
            type="button"
            onClick={onToggle}
            aria-label="展开侧栏"
            title="展开侧栏"
            className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded border border-sidebar-border bg-sidebar text-muted-foreground/70 transition-colors hover:bg-brand-cyan/10 hover:text-brand-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            data-testid="sidebar-toggle-btn"
          >
            <PanelLeftOpen size={12} />
          </button>
        </div>
      ) : (
        <>
          {/* 根锚点越过子应用 basePath，沿用当前主站会员会话。 */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            aria-label="返回主站应用广场"
            title="返回主站应用广场"
            className="group/logo flex min-w-0 flex-1 items-center gap-2 rounded-md text-foreground no-underline hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            data-testid="sidebar-logo-link"
          >
            <NativeHostBrandLogo size={32} />
            <BrandWordmark as="h1" size="sidebar" />
          </a>
          <button
            type="button"
            onClick={onToggle}
            aria-label="收起侧栏"
            title="收起侧栏"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-none bg-transparent text-muted-foreground/70 transition-colors hover:bg-brand-cyan/10 hover:text-brand-cyan"
            data-testid="sidebar-toggle-btn"
          >
            <PanelLeftClose size={18} />
          </button>
        </>
      )}
    </div>
  )
}
