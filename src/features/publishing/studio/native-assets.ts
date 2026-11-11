import { z } from 'zod'
import { PublishingV3AssetSchema, PublishingV3OperationSchema } from '@/lib/publishing-v3-contract'
import { assertHostSession, getHostSession, getHostSessionRevision, hostStorageKey, subscribeHostSession, trackHostRequest } from './host-session'
import { nativeBffFetch } from './host-transport'

export interface NativeAsset { id: string, mediaId: string, fileName: string, mime: string, size: number, sha256: string, state: string, metadata: { width?: number, height?: number, duration?: number } }
const sourceFiles = new Map<string, File>()
const blobIds = new WeakMap<Blob, string>()
let activeOwner = ''
subscribeHostSession(() => { const owner = getHostSession()?.user.id || ''; if (owner !== activeOwner) { activeOwner = owner; sourceFiles.clear() } })
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i
export function nativeAssetId(value: string) {
  let url: URL
  try { url = new URL(value, typeof window === 'undefined' ? 'http://localhost' : window.location.origin) } catch { throw new Error('素材来源无效，请从本站作品重新选择') }
  if (typeof window !== 'undefined' && url.origin !== window.location.origin) throw new Error('素材必须来自本站当前会员的已确认作品')
  const match = /^\/api\/native-operations\/assets\/([^/]+)\/content$/.exec(url.pathname)
  if (!match || !uuid.test(match[1]) || url.search || url.hash) throw new Error('素材必须来自本站受控资产引用，请重新选择')
  return match[1]
}
export const nativeAssetContentUrl = (id: string) => { if (!uuid.test(id)) throw new Error('素材标识无效'); return `/api/native-operations/assets/${id}/content` }
export async function nativeSha256(file: Blob) { const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') }
async function envelope<T>(path: string, method: string, data?: unknown): Promise<T> {
  const owner = assertHostSession().user.id; const revision = getHostSessionRevision()
  const response = await nativeBffFetch(path, { method, ...(data ? { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } } : {}) })
  const value: unknown = await response.json()
  assertHostSession(owner, revision)
  if (!value || typeof value !== 'object' || !('code' in value) || value.code !== 0 || !('data' in value)) throw new Error(value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : '主站素材服务未完成，请核对原素材')
  return value.data as T
}
async function dispatchNativeAsset(blob: Blob, options: { onProgress?: (percent: number) => void, signal?: AbortSignal, assertCurrent?: () => void } = {}) {
  options.assertCurrent?.(); const session = assertHostSession(); const sessionRevision = getHostSessionRevision()
  if (!['image/jpeg', 'image/png', 'video/mp4'].includes(blob.type)) throw new Error('当前官方素材通道接收 JPEG、PNG 和 MP4，请重新选择兼容格式')
  if (blob.size <= 0 || blob.size > (blob.type === 'video/mp4' ? 100 : 20) * 1024 ** 2) throw new Error('图片须在 20 MiB 以内，MP4 须在 100 MiB 以内')
  let mediaId = blobIds.get(blob); if (!mediaId) { mediaId = crypto.randomUUID(); blobIds.set(blob, mediaId) }
  const extension = blob.type === 'video/mp4' ? '.mp4' : blob.type === 'image/png' ? '.png' : '.jpg'
  const fileName = blob instanceof File && blob.name ? blob.name : `media-${mediaId}${extension}`
  const file = blob instanceof File ? blob : new File([blob], fileName, { type: blob.type })
  const sha256 = await nativeSha256(file); assertHostSession(session.user.id, sessionRevision); options.assertCurrent?.()
  const markerKey = hostStorageKey(`studio-upload:${sha256}`)!
  const marker = { requestKey: `native-upload:${mediaId}:${sha256}`, mediaId, sha256, phase: 'sign' }; localStorage.setItem(markerKey, JSON.stringify(marker))
  const signed = await envelope<{ id: string, url: string, uploadUrl: string }>('assets/upload-sign', 'POST', { mediaId, fileName, mime: file.type, size: file.size, sha256, requestKey: `native-upload:${mediaId}:${sha256}` })
  if (!uuid.test(signed.id) || nativeAssetId(signed.url) !== signed.id) throw new Error('素材上传回执不符合本站合同')
  localStorage.setItem(markerKey, JSON.stringify({ ...marker, assetId: signed.id, phase: 'put' })); options.assertCurrent?.()
  const destination = new URL(signed.uploadUrl)
  if (destination.protocol !== 'https:' || destination.username || destination.password) throw new Error('上传目的地址不符合受控签名合同')
  // The temporary URL is consumed only in this function, never in UI state or persistence.
  const controller = new AbortController(); const release = trackHostRequest(controller)
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) controller.abort()
  try {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest(); const stop = () => xhr.abort(); controller.signal.addEventListener('abort', stop, { once: true })
      const finish = () => controller.signal.removeEventListener('abort', stop)
      xhr.open('PUT', destination.href); xhr.withCredentials = false; xhr.timeout = 120000; xhr.setRequestHeader('Content-Type', file.type)
      xhr.upload.onprogress = event => { if (event.lengthComputable) { try { assertHostSession(session.user.id, sessionRevision); options.assertCurrent?.(); options.onProgress?.(Math.round(event.loaded / event.total * 95)) } catch { xhr.abort() } } }
      xhr.onload = () => { finish(); if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error('素材传输尚未完成，请核对原上传')) }
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => { finish(); reject(new Error('素材传输已中断，未认定为上传完成')) }
      if (controller.signal.aborted) reject(new Error('素材上传已取消')); else xhr.send(file)
    })
    assertHostSession(session.user.id, sessionRevision); options.assertCurrent?.()
    localStorage.setItem(markerKey, JSON.stringify({ ...marker, assetId: signed.id, phase: 'confirm' }))
    const confirmed = await envelope<{ url: string }>(`assets/${signed.id}/confirm`, 'POST', { id: signed.id, requestKey: `native-confirm:${signed.id}` })
    if (nativeAssetId(confirmed.url) !== signed.id) throw new Error('官方确认后的素材标识不一致，请核对原上传')
    sourceFiles.set(signed.id, file); localStorage.setItem(markerKey, JSON.stringify({ ...marker, assetId: signed.id, phase: 'ready' })); options.onProgress?.(100); return confirmed.url
  } finally { release(); options.signal?.removeEventListener('abort', abort) }
}
export async function readNativeAsset(value: string): Promise<{ asset: NativeAsset, file: File }> {
  const id = nativeAssetId(value); const session = assertHostSession(); const version = getHostSessionRevision()
  const parsed = PublishingV3AssetSchema.safeParse(await envelope<unknown>(`assets/${id}`, 'GET'))
  if (!parsed.success) throw new Error('素材确认摘要格式待核对，请重新选择')
  const asset: NativeAsset = parsed.data
  if (asset.id !== id || !uuid.test(asset.mediaId) || asset.state !== 'ready' || !/^[a-f\d]{64}$/.test(asset.sha256)) throw new Error('素材尚未确认或已失效，请重新选择')
  let file = sourceFiles.get(id)
  if (!file) { const response = await nativeBffFetch(`assets/${id}/content`, { cache: 'no-store' }); if (!response.ok) throw new Error('当前会员无法读取该素材，请重新选择'); const blob = await response.blob(); file = new File([blob], asset.fileName, { type: blob.type || asset.mime }) }
  assertHostSession(session.user.id, version)
  if (file.size !== asset.size || file.type !== asset.mime || await nativeSha256(file) !== asset.sha256) throw new Error('实际素材与确认摘要不一致，已停止执行')
  assertHostSession(session.user.id, version); sourceFiles.set(id, file); return { asset, file }
}

/** A lost sign/PUT/confirm response is never repeated automatically. */
export async function uploadNativeAsset(blob: Blob, options: { onProgress?: (percent: number) => void, signal?: AbortSignal, assertCurrent?: () => void } = {}) {
  options.assertCurrent?.(); const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  const sha256 = await nativeSha256(blob); assertHostSession(owner, revision); options.assertCurrent?.()
  if (!navigator.locks?.request) throw new Error('当前浏览器不能保护跨页面上传，请使用支持的桌面浏览器')
  return navigator.locks.request(`aitoearn-studio:upload:${owner}:${sha256}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一个页面正在处理这份素材，请核对原上传')
    assertHostSession(owner, revision)
    const key = hostStorageKey(`studio-upload:${sha256}`)!, raw = localStorage.getItem(key)
    if (raw) {
      let prior: unknown
      try { prior = JSON.parse(raw) } catch { throw new Error('原上传标记无法读取，请保留浏览器数据核对') }
      const marker = z.object({ requestKey: z.string().min(8).max(160), mediaId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(['sign', 'put', 'confirm', 'ready']), assetId: z.string().uuid().optional() }).strict().parse(prior)
      if (marker.sha256 !== sha256) throw new Error('原上传标记与文件不匹配')
      let assetId = marker.assetId
      if (!assetId) {
        const found = z.object({ operation: PublishingV3OperationSchema, asset: PublishingV3AssetSchema.nullable(), uploadUrlRecoverable: z.literal(false) }).strict().nullable().parse(await envelope<unknown>(`assets/upload-sign?requestKey=${encodeURIComponent(marker.requestKey)}`, 'GET'))
        assertHostSession(owner, revision); options.assertCurrent?.()
        if (!found || found.operation.kind !== 'asset_sign' || found.operation.requestKey !== marker.requestKey || !found.asset || found.asset.mediaId !== marker.mediaId || found.asset.sha256 !== sha256 || found.asset.size !== blob.size || found.asset.mime !== blob.type) throw new Error('原素材上传尚未查明，请稍后核对原上传；不会另建上传请求')
        assetId = found.asset.id
        localStorage.setItem(key, JSON.stringify({ ...marker, assetId }))
        if (found.asset.state !== 'ready') throw new Error('原素材传输尚未确认，请保留当前页面并联系站方核对原上传；本次尚未发布')
      }
      const url = nativeAssetContentUrl(assetId)
      const result = await readNativeAsset(url)
      if (result.asset.sha256 !== sha256 || result.file.size !== blob.size || result.file.type !== blob.type) throw new Error('原素材与当前文件不一致，已停止上传')
      assertHostSession(owner, revision)
      return url
    }
    return dispatchNativeAsset(blob, options)
  })
}
