'use client'

import { useNativeHostBranding } from '@/integration/host-branding-client'
import { hostBrandName, NATIVE_PRODUCT_NAME } from '@/integration/host-branding-contract'
import { cn } from '@/utils/className'

export const BRAND_TITLE = NATIVE_PRODUCT_NAME
export interface BrandWordmarkProps {
  as?: 'h1' | 'span'
  size?: 'sidebar' | 'mobile'
  className?: string
}

export function BrandWordmark({ as: Component = 'span', size = 'sidebar', className }: BrandWordmarkProps) {
  const name = hostBrandName(useNativeHostBranding())
  return (
    <Component title={name} aria-label={name} className={cn('m-0 block min-w-0 truncate font-semibold leading-normal text-foreground', size === 'sidebar' ? 'text-[1.05rem]' : 'text-base', className)}>
      {name}
    </Component>
  )
}
