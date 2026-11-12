/** Thin public display contract; never a tenant or permission claim. */
export const NATIVE_PRODUCT_NAME = '发布中心'
export const NATIVE_PRODUCT_DESCRIPTION = '多平台内容发布与管理工作台'
export const HOST_PLATFORM_LOGO = '/brand/platform-logo-display-256.webp'
export const HOST_BRANDING_REFRESH_EVENT = 'platform-branding:refresh'

const PURPOSES = ['logo_square', 'logo_horizontal_light', 'logo_horizontal_dark', 'favicon', 'social_share', 'login_background', 'contact_wechat_qr_primary', 'contact_wechat_qr_secondary'] as const
type Purpose = typeof PURPOSES[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export interface HostBranding {
  displayScope: 'platform' | 'white_label'
  hostname: string
  source: 'published' | 'legacy'
  generation: number
  legacyLogoUrl?: string
  brand: {
    schema: 'platform-brand/v1'
    name: string
    description: string
    seo: { title: string, description: string }
  }
  assets: Partial<Record<Purpose, { url: string }>>
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isHostBrandAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/api/branding/assets/')) return false
  try {
    const url = new URL(value, 'https://brand.invalid')
    return url.origin === 'https://brand.invalid'
      && /^\/api\/branding\/assets\/[0-9a-f-]{36}$/iu.test(url.pathname)
      && !url.hash && !url.username && !url.password
  }
  catch { return false }
}

export function parseHostBrandingResponse(value: unknown, hostname: string): HostBranding | null {
  if (!record(value) || value.ok !== true || !record(value.branding)) return null
  const data = value.branding
  if (data.displayScope !== 'platform' && data.displayScope !== 'white_label') return null
  if (typeof data.hostname !== 'string' || data.hostname.toLowerCase() !== hostname.toLowerCase()) return null
  if (data.source !== 'published' && data.source !== 'legacy') return null
  if (!Number.isSafeInteger(data.generation) || Number(data.generation) < 0) return null
  if (data.revisionId !== null && (typeof data.revisionId !== 'string' || !UUID.test(data.revisionId))) return null
  if (data.revisionVersion !== null && (!Number.isSafeInteger(data.revisionVersion) || Number(data.revisionVersion) < 1)) return null
  if (data.publishedAt !== null && (typeof data.publishedAt !== 'string' || !Number.isFinite(Date.parse(data.publishedAt)))) return null
  const brand = data.brand
  if (!record(brand) || brand.schema !== 'platform-brand/v1' || typeof brand.name !== 'string' || !brand.name.trim() || brand.name.length > 80) return null
  if (typeof brand.description !== 'string' || !record(brand.seo) || typeof brand.seo.title !== 'string' || typeof brand.seo.description !== 'string') return null
  if (!record(brand.colors) || !record(brand.contact) || !record(brand.assetIds) || !record(data.assets)) return null
  for (const field of ['shortName', 'slogan', 'welcomeMessage']) {
    if (typeof brand[field] !== 'string') return null
  }
  for (const field of ['primary', 'accent']) {
    if (typeof brand.colors[field] !== 'string' || !/^#[0-9a-f]{6}$/iu.test(brand.colors[field])) return null
  }
  for (const field of ['name', 'wechat', 'phone', 'email']) {
    if (typeof brand.contact[field] !== 'string') return null
  }
  for (const [purpose, id] of Object.entries(brand.assetIds)) {
    if (!PURPOSES.includes(purpose as Purpose) || typeof id !== 'string' || !UUID.test(id)) return null
  }
  for (const [purpose, asset] of Object.entries(data.assets)) {
    if (!PURPOSES.includes(purpose as Purpose)) return null
    if (asset == null) continue
    if (!record(asset) || asset.purpose !== purpose || typeof asset.id !== 'string' || !UUID.test(asset.id) || !isHostBrandAssetUrl(asset.url)) return null
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(asset.mimeType))) return null
    if (['width', 'height', 'bytes'].some(field => !Number.isSafeInteger(asset[field]) || Number(asset[field]) <= 0)) return null
    if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(asset.sha256)) return null
    if (new URL(asset.url, 'https://brand.invalid').pathname !== `/api/branding/assets/${asset.id}`) return null
  }
  return data as unknown as HostBranding
}

export function hostBrandName(branding: HostBranding | null): string {
  return branding?.brand.name || NATIVE_PRODUCT_NAME
}

// The public API has already selected this Host's platform snapshot. Accept only
// stable public image URLs here; never signed links, credentials or script URLs.
function publicLegacyLogoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const source = value.trim()
  const relative = source.startsWith('/') && !source.startsWith('//')
  if (!relative && !/^https:\/\//iu.test(source)) return undefined
  try {
    const url = new URL(source, 'https://brand.invalid')
    if (url.username || url.password || url.hash || (relative && url.origin !== 'https://brand.invalid')) return undefined
    const secretMarkers = ['signature', 'sig', 'token', 'expires', 'credential', 'x-amz-', 'q-sign-']
    if ([...url.searchParams.keys()].some(key => secretMarkers.some(marker => key.toLowerCase().includes(marker)))) return undefined
    return relative ? `${url.pathname}${url.search}` : url.toString()
  }
  catch { return undefined }
}

export function hostBrandLogoUrl(branding: HostBranding | null): string | undefined {
  if (!branding) return undefined
  const source = branding.assets.logo_square?.url
    || branding.assets.logo_horizontal_light?.url
    || branding.assets.logo_horizontal_dark?.url
    || (branding.displayScope === 'platform' ? publicLegacyLogoUrl(branding.legacyLogoUrl) || HOST_PLATFORM_LOGO : undefined)
  if (!source || !isHostBrandAssetUrl(source)) return source
  const asset = new URL(source, 'https://brand.invalid')
  asset.searchParams.set('w', '256')
  return `${asset.pathname}${asset.search}`
}
