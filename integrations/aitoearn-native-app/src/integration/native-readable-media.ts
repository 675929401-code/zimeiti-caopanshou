import { nativeMainMediaIdentity, nativeMainMediaPath, nativeMainMediaReference, nativeMainMediaUuid, type NativeOwnedMediaRef } from '@host-publishing/native-main-media-contract'
import { assertHostSession, getHostSessionRevision, trackHostRequest } from './host-session'
import { nativeSha256, readNativeAsset, type NativeAsset } from './native-assets'

export interface NativeReadableMetadata { width: number, height: number, duration?: number }
interface ReadableFile { mediaId: string, file: File, sha256: string, metadata: NativeReadableMetadata }
export type NativeReadablePublishingMedia =
  | ReadableFile & { kind: 'provider', asset: NativeAsset, source: { kind: 'provider_asset', assetId: string } }
  | ReadableFile & { kind: 'main', reference: NativeOwnedMediaRef, source: { kind: 'main_asset', reference: NativeOwnedMediaRef } }

function active(signal?: AbortSignal) { if (signal?.aborted) throw new Error('素材读取已停止，请重新选择当前会员的作品') }

/** Decode the actual bytes. A MIME header or an HTTP 200 is never sufficient evidence. */
export async function probeNativePublishingFile(file: File, signal?: AbortSignal): Promise<NativeReadableMetadata> {
  active(signal)
  if (file.type.startsWith('image/')) {
    const image = await createImageBitmap(file)
    try {
      active(signal)
      if (!image.width || !image.height) throw new Error('图片没有可核实的尺寸，请重新选择')
      return { width: image.width, height: image.height }
    }
    finally { image.close() }
  }
  if (file.type !== 'video/mp4') throw new Error('当前浏览器发布读取 JPG、PNG、WebP 图片和 MP4 成片')
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<NativeReadableMetadata>((resolve, reject) => {
      const element = document.createElement('video')
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); element.onloadedmetadata = null; element.onerror = null; element.removeAttribute('src'); element.load() }
      const abort = () => { finish(); reject(new Error('素材读取已停止，请重新选择当前会员的作品')) }
      const timer = setTimeout(() => { finish(); reject(new Error('视频元信息读取超时，请重新选择成片')) }, 15000)
      element.preload = 'metadata'
      element.onloadedmetadata = () => {
        const metadata = { width: element.videoWidth, height: element.videoHeight, duration: element.duration }
        finish()
        if (!metadata.width || !metadata.height || !Number.isFinite(metadata.duration) || metadata.duration <= 0) reject(new Error('无法核实成片尺寸与时长'))
        else resolve(metadata)
      }
      element.onerror = () => { finish(); reject(new Error('成片无法解码，请重新选择有效的 MP4 文件')) }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else element.src = url
    })
  }
  finally { URL.revokeObjectURL(url) }
}

function mainReadPath(reference: NativeOwnedMediaRef) {
  // A fixed owner-checked proxy streams the original video; no ticket URL or remote location is followed.
  return reference.kind === 'video_task'
    ? `/api/video/proxy?id=${encodeURIComponent(reference.id)}&source=origin&forCapture=1`
    : nativeMainMediaPath(reference)
}

async function mainFile(response: Response, reference: NativeOwnedMediaRef, current: () => void): Promise<File> {
  if (response.status === 410) throw new Error('这份主站素材已失效，原任务与费用回执仍保留；请重新选择可用作品')
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new Error('当前会员无法读取这份作品，可能归属已变化或作品不可用；请重新选择')
  if (response.status !== 200 || response.redirected || response.headers.get('X-Media-Fallback')) throw new Error('主站素材未完成交付或暂时不可读取，请核对原作品')
  const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase()
  const video = reference.kind === 'video_task'
  if (video ? mime !== 'video/mp4' : !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new Error('主站返回的不是可发布素材，已停止读取；请重新选择 JPG、PNG、WebP 或 MP4')
  const maximum = (video ? 1024 : 30) * 1024 ** 2
  const declared = response.headers.get('Content-Length')
  if (declared && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) throw new Error('素材大小不符合读取上限，请重新选择')
  if (!response.body) throw new Error('主站没有返回实际素材文件')
  const reader = response.body.getReader(), chunks: ArrayBuffer[] = []
  let size = 0, finished = false
  try {
    while (true) {
      current()
      const result = await reader.read()
      current()
      if (result.done) { finished = true; break }
      size += result.value.byteLength
      if (size > maximum) throw new Error('素材超过读取上限，请重新选择')
      chunks.push(new Uint8Array(result.value).buffer)
    }
  }
  finally { if (!finished) await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (!size || declared && Number(declared) !== size) throw new Error('主站素材文件为空或传输不完整，请重新读取原作品')
  const extension = video ? 'mp4' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  const name = `main-${reference.kind}-${reference.id.replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 180)
  return new File(chunks, `${name}.${extension}`, { type: mime, lastModified: 0 })
}

/** Source-aware read: main records never masquerade as uploaded provider assets. */
export async function readNativePublishingMedia(value: string, options: { signal?: AbortSignal } = {}): Promise<NativeReadablePublishingMedia> {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  if (typeof window === 'undefined') throw new Error('请在当前会员的浏览器工作台中读取素材')
  const controller = new AbortController(), release = trackHostRequest(controller)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const current = () => { active(controller.signal); assertHostSession(owner, revision) }
  try {
    current()
    const reference = nativeMainMediaReference(value, window.location.origin)
    if (!reference) {
      const result = await readNativeAsset(value)
      current()
      const metadata = await probeNativePublishingFile(result.file, controller.signal)
      current()
      if (result.asset.metadata.width && result.asset.metadata.width !== metadata.width || result.asset.metadata.height && result.asset.metadata.height !== metadata.height) throw new Error('实际素材尺寸与官方确认记录不一致，请重新选择')
      return { kind: 'provider', ...result, mediaId: result.asset.mediaId, sha256: result.asset.sha256, metadata, source: { kind: 'provider_asset', assetId: result.asset.id } }
    }
    const response = await fetch(mainReadPath(reference), { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin', headers: { Accept: reference.kind === 'video_task' ? 'video/mp4' : 'image/jpeg,image/png,image/webp', 'X-Native-Actor-Id': owner }, signal: controller.signal })
    current()
    const file = await mainFile(response, reference, current)
    current()
    const [sha256, identity, metadata] = await Promise.all([nativeSha256(file), nativeSha256(new Blob([nativeMainMediaIdentity(owner, reference)], { type: 'text/plain' })), probeNativePublishingFile(file, controller.signal)])
    current()
    return { kind: 'main', reference, source: { kind: 'main_asset', reference }, mediaId: nativeMainMediaUuid(identity), file, sha256, metadata }
  }
  finally { controller.abort(); release(); options.signal?.removeEventListener('abort', abort) }
}
