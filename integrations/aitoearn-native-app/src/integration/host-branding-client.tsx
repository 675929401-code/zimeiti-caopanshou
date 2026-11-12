'use client'

import type { CSSProperties, SyntheticEvent } from 'react'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  HOST_BRANDING_REFRESH_EVENT, HOST_PLATFORM_LOGO, hostBrandLogoUrl, hostBrandName,
  parseHostBrandingResponse,
} from './host-branding-contract'
import type { HostBranding } from './host-branding-contract'

const MAX_AGE = 60_000
const cache = new Map<string, { value: HostBranding | null, checkedAt: number }>()
const pending = new Map<string, Promise<HostBranding | null>>()
const subscribers = new Map<string, Set<(value: HostBranding | null) => void>>()

export async function getNativeHostBranding(force = false): Promise<HostBranding | null> {
  if (typeof window === 'undefined') return null
  const key = window.location.origin
  const hostname = window.location.hostname
  const cached = cache.get(key)
  if (!force && cached && Date.now() - cached.checkedAt < MAX_AGE) return cached.value
  const active = pending.get(key)
  if (active) return active
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  const request = (async () => {
    let value = cached?.value || null
    try {
      const response = await fetch('/api/branding', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error('Branding unavailable')
      const parsed = parseHostBrandingResponse(await response.json(), hostname)
      if (!parsed) throw new Error('Invalid public branding')
      value = parsed
    }
    catch { /* Keep only this origin's last verified public display snapshot. */ }
    cache.set(key, { value, checkedAt: Date.now() })
    subscribers.get(key)?.forEach(update => update(value))
    return value
  })().finally(() => {
    clearTimeout(timer)
    pending.delete(key)
  })
  pending.set(key, request)
  return request
}

export function useNativeHostBranding(): HostBranding | null {
  const [branding, setBranding] = useState<HostBranding | null>(null)
  useEffect(() => {
    const key = window.location.origin
    let active = true
    const update = (value: HostBranding | null) => { if (active) setBranding(value) }
    const listeners = subscribers.get(key) || new Set()
    listeners.add(update)
    subscribers.set(key, listeners)
    const refresh = () => { void getNativeHostBranding(true).then(update) }
    const stale = () => { void getNativeHostBranding().then(update) }
    const visible = () => { if (document.visibilityState === 'visible') stale() }
    stale()
    window.addEventListener('focus', stale)
    window.addEventListener(HOST_BRANDING_REFRESH_EVENT, refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      listeners.delete(update)
      if (!listeners.size) subscribers.delete(key)
      window.removeEventListener('focus', stale)
      window.removeEventListener(HOST_BRANDING_REFRESH_EVENT, refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return branding
}

export function handleNativeBrandLogoError(event: SyntheticEvent<HTMLImageElement>, branding: HostBranding | null) {
  const image = event.currentTarget
  if (branding?.displayScope === 'platform' && image.getAttribute('src') !== HOST_PLATFORM_LOGO) {
    image.src = HOST_PLATFORM_LOGO
  }
  else {
    image.hidden = true
    image.removeAttribute('src')
  }
}

export function NativeHostBrandLogo({ size = 32, className, style }: { size?: number, className?: string, style?: CSSProperties }) {
  const branding = useNativeHostBranding()
  const source = hostBrandLogoUrl(branding)
  if (!source) return null
  // Plain img deliberately preserves the host-root asset path across Next basePath.
  // eslint-disable-next-line @next/next/no-img-element
  return <img key={source} src={source} alt={hostBrandName(branding)} width={size} height={size} className={className} style={{ objectFit: 'contain', flexShrink: 0, ...style }} onError={event => handleNativeBrandLogoError(event, branding)} />
}

export function NativeHostBrandingDocument() {
  const branding = useNativeHostBranding()
  const pathname = usePathname()
  useEffect(() => {
    const name = hostBrandName(branding)
    const previousName = document.documentElement.dataset.nativeBrandName
    document.documentElement.dataset.nativeBrandName = name
    const icon = branding?.assets.favicon?.url || hostBrandLogoUrl(branding)
    const syncHead = () => {
      // Ignore our own writes; watch the head itself so Next may replace title
      // or streamed metadata nodes during SPA navigation without losing branding.
      observer.disconnect()
      try {
        const title = document.title
        if (title !== name && !title.startsWith(`${name} - `)) {
          const suffix = previousName && title.startsWith(`${previousName} - `)
            ? title.slice(previousName.length + 3)
            : title === previousName ? '' : title.includes(' - ') ? title.slice(title.indexOf(' - ') + 3) : ''
          document.title = suffix ? `${name} - ${suffix}` : name
        }
        for (const selector of ['meta[property="og:site_name"]', 'meta[name="application-name"]']) {
          const matches = document.head.querySelectorAll<HTMLMetaElement>(selector)
          if (!matches.length) {
            const meta = document.createElement('meta')
            if (selector.includes('og:')) meta.setAttribute('property', 'og:site_name')
            else meta.name = 'application-name'
            meta.content = name
            document.head.appendChild(meta)
          }
          else {
            matches.forEach(meta => { if (meta.content !== name) meta.content = name })
          }
        }
        let currentIcon: HTMLLinkElement | undefined
        document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
          if (icon && link.rel === 'icon' && link.getAttribute('href') === icon && !currentIcon) currentIcon = link
          else link.remove()
        })
        if (icon && !currentIcon) {
          const link = document.createElement('link')
          link.rel = 'icon'
          link.href = icon
          link.dataset.nativeHostBrand = 'true'
          document.head.appendChild(link)
        }
      }
      finally {
        observer.observe(document.head, {
          childList: true, characterData: true, subtree: true,
          attributes: true, attributeFilter: ['content', 'href', 'rel', 'property', 'name'],
        })
      }
    }
    const observer = new MutationObserver(syncHead)
    syncHead()
    return () => { observer.disconnect() }
  }, [branding, pathname])
  return null
}
