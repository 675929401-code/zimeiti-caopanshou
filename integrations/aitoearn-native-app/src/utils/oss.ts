import { hostAssetPath } from '@/integration/host-session'
import { isUserProfileAvatarReference } from '@host-publishing/user-profile-avatar'
import { nativeMainMediaPath, nativeMainMediaReference } from '@host-publishing/native-main-media-contract'
// Original UI accepts only same-origin content references and its own static assets.
export function getOssUrl(value?: string) {
  if (!value) return ''
  if (isUserProfileAvatarReference(value)) return value
  const main = nativeMainMediaReference(value, typeof window === 'undefined' ? 'https://native.invalid' : window.location.origin)
  if (main) return nativeMainMediaPath(main)
  if (value.startsWith('blob:') || /^data:image\/(?:png|jpeg|webp|gif);base64,/.test(value)) return value
  if (value.startsWith('/api/native-operations/assets/') || value.startsWith('/publish-center/native/')) return value
  if (/^\/(?:assets|images|favicon)(?:\/|\.)/.test(value)) return hostAssetPath(value)
  // Avatar/media HTTPS URLs are display-only; transport never attaches main-site credentials.
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : '' } catch { return '' }
}

export interface OssThumbnailOptions {
  width?: number
  height?: number
  quality?: number
}

const DEFAULT_THUMBNAIL_QUALITY = 75
const UNSUPPORTED_THUMBNAIL_EXTENSIONS = new Set(['.svg', '.gif', '.mp4', '.mov', '.webm', '.m4v'])
const PROJECT_OSS_HOSTNAMES = new Set(['assets.aitoearn.cn', 'assets.aitoearn.ai'])

type OssStorageProvider = 'aliyun' | 'cloudflare'

function getNormalizedDimension(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return undefined

  return Math.ceil(value)
}

function getNormalizedQuality(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return DEFAULT_THUMBNAIL_QUALITY

  return Math.min(100, Math.max(1, Math.round(value)))
}

function getUrlExtension(url: URL) {
  const lastDotIndex = url.pathname.lastIndexOf('.')
  if (lastDotIndex < 0)
    return ''

  return url.pathname.slice(lastDotIndex).toLowerCase()
}

function isProjectOssUrl(url: URL) {
  if (PROJECT_OSS_HOSTNAMES.has(url.hostname))
    return true

  const ossUrl = process.env.NEXT_PUBLIC_OSS_URL
  if (!ossUrl)
    return false

  try {
    const ossBaseUrl = new URL(ossUrl)
    return url.origin === ossBaseUrl.origin
  }
  catch {
    return false
  }
}

function getOssStorageProvider(url: URL): OssStorageProvider {
  if (url.hostname === 'assets.aitoearn.cn')
    return 'aliyun'

  if (url.hostname === 'assets.aitoearn.ai')
    return 'cloudflare'

  return 'cloudflare'
}

function canUseOssThumbnail(url: URL) {
  if (!isProjectOssUrl(url))
    return false

  if (url.searchParams.has('x-oss-process') || url.pathname.includes('/cdn-cgi/image/'))
    return false

  return !UNSUPPORTED_THUMBNAIL_EXTENSIONS.has(getUrlExtension(url))
}

function buildAliyunOssThumbnailUrl(url: URL, width?: number, height?: number, quality?: number) {
  const resizeOptions = [
    width ? `w_${width}` : '',
    height ? `h_${height}` : '',
  ].filter(Boolean).join(',')

  const processValue = [
    `image/resize,${resizeOptions}`,
    `quality,q_${quality}`,
    'format,webp',
  ].join('/')

  const thumbnailUrl = new URL(url.toString())
  thumbnailUrl.searchParams.set('x-oss-process', processValue)
  return thumbnailUrl.toString()
}

export function getOssThumbnailUrl(path?: string, options: OssThumbnailOptions = {}) {
  const url = getOssUrl(path)
  if (!url)
    return ''

  const width = getNormalizedDimension(options.width)
  const height = getNormalizedDimension(options.height)
  if (!width && !height)
    return url

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  }
  catch {
    return url
  }

  if (!canUseOssThumbnail(parsedUrl))
    return url

  if (getOssStorageProvider(parsedUrl) !== 'aliyun')
    return url

  const quality = getNormalizedQuality(options.quality)
  return buildAliyunOssThumbnailUrl(parsedUrl, width, height, quality)
}

// Download helpers may only request an owner-scoped stable content path.
export function getOssProxyPath(value?: string) {
  if (!value) return ''
  const main = nativeMainMediaReference(value, typeof window === 'undefined' ? 'https://native.invalid' : window.location.origin)
  if (main) return nativeMainMediaPath(main)
  if (value.startsWith('/api/native-operations/assets/') || value.startsWith('blob:')) return value
  throw new Error('素材必须来自本站已确认的受控作品，请重新选择')
}
