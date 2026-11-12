import type { MobileNavItemProps } from '../types'
/**
 * MobileNavItem - 移动端单个导航项
 */
import { FileText } from 'lucide-react'
import Link from 'next/link'
import { useTransClient } from '@/app/i18n/client'
import { useGetClientLng } from '@/hooks/useSystem'
import { cn } from '@/utils/className'

export function MobileNavItem({
  path,
  href,
  translationKey,
  icon,
  isActive,
  onClose,
  className,
}: MobileNavItemProps) {
  const { t } = useTransClient('route')
  const lng = useGetClientLng()
  const nativeConnected = !!href || ['/', '/draft-box', '/accounts', '/ai-social', '/tasks-history', '/agent-assets'].includes(path)
  if (!nativeConnected) return <div aria-disabled className="flex items-center gap-3 px-4 py-3 text-muted-foreground opacity-60" title="原生模块接入中">{icon}<span>{t(translationKey)} · 接入中</span></div>
  const fullPath = href ?? (path.startsWith('/') ? `/${lng}${path}` : `/${lng}/${path}`)

  return (
    <Link
      href={fullPath}
      onClick={onClose}
      data-testid={`mobile-nav-item-${translationKey}`}
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-lg text-base font-medium transition-all',
        'text-muted-foreground hover:bg-brand-cyan/10 hover:text-brand-cyan',
        isActive && 'bg-brand-cyan/10 text-brand-cyan',
        className,
      )}
    >
      <span className={cn('flex items-center justify-center', isActive && 'text-brand-cyan')}>
        {icon || <FileText size={20} />}
      </span>
      <span>{t(translationKey)}</span>
    </Link>
  )
}
