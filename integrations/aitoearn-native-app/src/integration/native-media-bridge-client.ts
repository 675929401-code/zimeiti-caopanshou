import { createElement } from 'react'
import { z } from 'zod'
import { NativeMainMediaBridgeDtoSchema, NativeMainMediaBridgeMutationSchema, NativeMainMediaBridgeRequestSchema, type NativeMainMediaBridgeDto } from '@host-publishing/native-main-media-bridge-contract'
import { nativeMainMediaIdentity, nativeMainMediaReference, nativeMainMediaUuid, NativeOwnedMediaRefSchema, type NativeOwnedMediaRef } from '@host-publishing/native-main-media-contract'
import type { PubItem } from '@/components/PublishDialog/publishDialog.type'
import type { ConfirmOptions } from '@/utils/ui/confirm'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { nativeBffFetch } from './host-transport'
import { nativeAssetContentUrl, nativeSha256, readNativeAsset, type NativeAsset } from './native-assets'

const markerSchema = z.object({ version: z.literal(1), requestKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/), reference: NativeOwnedMediaRefSchema, mediaId: z.string().uuid(), bridgeId: z.string().uuid().optional() }).strict()
type Marker = z.infer<typeof markerSchema>
export interface NativeMainBridgeSelection { reference: NativeOwnedMediaRef, mediaId: string, file: { mime: string, size: number, sha256: string } }
interface Selected extends NativeMainBridgeSelection { fileName: string, accounts: string[] }
interface ClientDependencies { confirm?: (options: ConfirmOptions) => Promise<boolean> }
function failure(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
const exactReference = (left: NativeOwnedMediaRef, right: NativeOwnedMediaRef) => left.kind === right.kind && left.id === right.id
const key = (mediaId: string) => { const value = hostStorageKey(`main-media-bridge:${mediaId}`); if (!value) return failure('NATIVE_MAIN_BRIDGE_SESSION_REQUIRED', '请先进入当前主站会员会话'); return value }
function marker(mediaId: string): Marker | null {
  let value: string | null
  try { value = localStorage.getItem(key(mediaId)) } catch { return failure('NATIVE_MAIN_BRIDGE_STORAGE_UNAVAILABLE', '无法读取原素材上传记录，已停止上传；请恢复浏览器存储后核对原记录') }
  if (!value) return null
  try { return markerSchema.parse(JSON.parse(value)) } catch { return failure('NATIVE_MAIN_BRIDGE_STORAGE_INVALID', '原素材上传记录格式待核对，不能自动另建请求') }
}
function save(value: Marker) {
  let normalized = markerSchema.parse(value)
  try {
    const storage = key(value.mediaId), existing = localStorage.getItem(storage)
    if (existing) {
      const previous = markerSchema.parse(JSON.parse(existing))
      if (previous.requestKey !== normalized.requestKey || previous.mediaId !== normalized.mediaId || !exactReference(previous.reference, normalized.reference) || previous.bridgeId && normalized.bridgeId && previous.bridgeId !== normalized.bridgeId) throw new Error('ORIGINAL_MARKER_CHANGED')
      if (previous.bridgeId && !normalized.bridgeId) normalized = { ...normalized, bridgeId: previous.bridgeId }
    }
    const text = JSON.stringify(normalized); localStorage.setItem(storage, text); if (localStorage.getItem(storage) !== text) throw new Error('STORAGE_NOT_DURABLE')
  }
  catch { return failure('NATIVE_MAIN_BRIDGE_STORAGE_UNAVAILABLE', '未能保存原素材上传标识，已停止上传；请恢复浏览器存储后再确认') }
}
function matches(value: Marker, selected: NativeMainBridgeSelection) { if (value.mediaId !== selected.mediaId || !exactReference(value.reference, selected.reference)) return failure('NATIVE_MAIN_BRIDGE_INPUT_CHANGED', '这个媒体身份已有不同来源的上传记录，请核对原素材，不能替换后重发') }
function verify(bridge: NativeMainMediaBridgeDto, selected: NativeMainBridgeSelection, request: Marker) {
  if (bridge.requestKey !== request.requestKey || bridge.mediaId !== selected.mediaId || !exactReference(bridge.reference, selected.reference)) return failure('NATIVE_MAIN_BRIDGE_RECEIPT_INVALID', '原素材上传回执与当前作品不一致，已停止发布')
  if (bridge.file.mime !== selected.file.mime || bridge.file.size !== selected.file.size || bridge.file.sha256 !== selected.file.sha256) return failure('NATIVE_MAIN_BRIDGE_FILE_CHANGED', '实际文件与原上传快照不一致，请保留原记录并重新核对素材')
}
async function lookup(selected: NativeMainBridgeSelection, request: Marker): Promise<NativeMainMediaBridgeDto | null> {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  const query = request.bridgeId ? `bridgeId=${request.bridgeId}` : `requestKey=${encodeURIComponent(request.requestKey)}`
  const response = await nativeBffFetch(`media-bridge?${query}`, { method: 'GET', cache: 'no-store' })
  if (response.status === 404) { await response.body?.cancel(); assertHostSession(owner, revision); return null }
  const envelope: unknown = await response.json(); assertHostSession(owner, revision)
  if (!response.ok || !envelope || typeof envelope !== 'object' || !('code' in envelope) || envelope.code !== 0 || !('data' in envelope)) return failure('NATIVE_MAIN_BRIDGE_LOOKUP_UNAVAILABLE', '原素材上传状态暂不可读取，请只核对原记录，不会另建请求')
  const value = envelope.data
  if (!value || typeof value !== 'object' || !('bridge' in value)) return failure('NATIVE_MAIN_BRIDGE_RECEIPT_INVALID', '原素材上传回执格式待核对')
  if (value.bridge === null) return null
  const bridge = NativeMainMediaBridgeDtoSchema.parse(value.bridge); verify(bridge, selected, request)
  save({ ...request, bridgeId: bridge.id }); return bridge
}
async function submit(selected: NativeMainBridgeSelection, request: Marker) {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  save(request)
  const body = NativeMainMediaBridgeRequestSchema.parse({ requestKey: request.requestKey, reference: selected.reference, mediaId: selected.mediaId })
  const response = await nativeBffFetch('media-bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const envelope: unknown = await response.json(); assertHostSession(owner, revision)
  if (!response.ok || !envelope || typeof envelope !== 'object' || !('code' in envelope) || envelope.code !== 0 || !('data' in envelope)) return failure('NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN', '原素材上传结果尚未确认，已保留原请求标识；请点击发布后只核对原记录')
  const result = NativeMainMediaBridgeMutationSchema.parse(envelope.data); verify(result.bridge, selected, request); save({ ...request, bridgeId: result.bridge.id }); return result.bridge
}
function ready(bridge: NativeMainMediaBridgeDto | null) { return !!bridge && bridge.state === 'ready' && bridge.connectionCurrent && bridge.resultReference?.kind === 'provider_asset' && bridge.resultReference.mediaId === bridge.mediaId }
const resumable = (bridge: NativeMainMediaBridgeDto) => bridge.connectionCurrent && (bridge.state === 'prepared' && bridge.phase === null || ['uploading', 'confirming'].includes(bridge.state) && bridge.phase === 'put')

/** A plan may consume this fresh GET, but must never create or continue an upload itself. */
export async function readReadyNativeMainMediaBridgeAsset(selected: NativeMainBridgeSelection): Promise<NativeAsset> {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision(), request = marker(selected.mediaId)
  if (!request) return failure('NATIVE_MAIN_BRIDGE_REQUIRED', '这份主站作品需要先明确确认官方素材导入')
  matches(request, selected)
  const bridge = await lookup(selected, request)
  if (!bridge || !ready(bridge) || !bridge.resultReference) return failure('NATIVE_MAIN_BRIDGE_REQUIRED', bridge && !bridge.connectionCurrent ? '原素材属于已变化的官方连接，请先核对连接和原记录；不会自动另建上传' : '原素材上传尚未确认完成，请核对原记录后再准备发布')
  const { asset } = await readNativeAsset(nativeAssetContentUrl(bridge.resultReference.assetId)); assertHostSession(owner, revision)
  if (asset.mediaId !== selected.mediaId || asset.sha256 !== selected.file.sha256 || asset.size !== selected.file.size || asset.mime !== selected.file.mime || asset.state !== 'ready') return failure('NATIVE_MAIN_BRIDGE_RECEIPT_INVALID', '实际官方素材与主站作品快照不一致，已停止准备发布')
  return asset
}

/** Called only after the original PublishDialog's explicit publish confirmation. */
export async function confirmNativeOfficialMainMedia(items: PubItem[], dependencies: ClientDependencies = {}): Promise<void> {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision(), chosen = new Map<string, Selected>()
  for (const item of items) {
    const official = item.account.type === 'douyin' && item.account.nativeAccountKind === 'official'
    const generic = item.account.nativeAccountKind === 'generic'
    if (!official && !generic) continue
    if (!item.account.nativeRevision || item.account.nativeDisconnected || item.account.nativeConnectionCurrent === false || generic && item.account.nativeConnectionCurrent !== true) return failure('NATIVE_MAIN_BRIDGE_ACCOUNT_UNAVAILABLE', '请先核对当前官方账号绑定后再导入素材')
    const selections = item.params.video ? [item.params.video, ...(item.params.video.cover.ossUrl ? [item.params.video.cover] : [])] : item.params.images || []
    for (const entry of selections) {
      const reference = entry.ossUrl ? nativeMainMediaReference(entry.ossUrl, window.location.origin) : null
      if (!reference) continue
      const source = entry.file
      if (!source || !source.size || !['image/jpeg', 'image/png', 'video/mp4'].includes(source.type)) return failure('NATIVE_MAIN_BRIDGE_FORMAT_UNSUPPORTED', '官方素材导入接收实际 JPEG、PNG 或 MP4，请先重新选择兼容作品')
      const mediaId = nativeMainMediaUuid(await nativeSha256(new Blob([nativeMainMediaIdentity(owner, reference)], { type: 'text/plain' })))
      const file = { mime: source.type, size: source.size, sha256: await nativeSha256(source) }; assertHostSession(owner, revision)
      const previous = chosen.get(mediaId), label = item.account.nickname || '当前官方账号'
      if (previous) { if (previous.file.mime !== file.mime || previous.file.size !== file.size || previous.file.sha256 !== file.sha256) return failure('NATIVE_MAIN_BRIDGE_FILE_CHANGED', '同一主站素材出现不同实际文件，请先核对后再导入'); if (!previous.accounts.includes(label)) previous.accounts.push(label); continue }
      chosen.set(mediaId, { reference, mediaId, file, fileName: entry.filename || '主站作品', accounts: [label] })
    }
  }
  if (!chosen.size) return
  const execute = async (mayWrite: boolean) => {
    const show = dependencies.confirm ?? (async (options: ConfirmOptions) => (await import('@/utils/ui/confirm')).confirm(options))
    const states: { selected: Selected, request: Marker | null, bridge: NativeMainMediaBridgeDto | null }[] = []
    for (const selected of chosen.values()) { const request = marker(selected.mediaId); if (request) matches(request, selected); states.push({ selected, request, bridge: request ? await lookup(selected, request) : null }) }
    assertHostSession(owner, revision)
    const pending = states.filter(state => !ready(state.bridge))
    if (!pending.length) return
    const blocked = !mayWrite || pending.some(state => state.request && (!state.bridge || !resumable(state.bridge)))
    const content = createElement('div', { className: 'space-y-3' },
      createElement('p', null, !mayWrite ? '当前浏览器无法保护多个页面的上传恢复，本页仅核对原记录。请使用支持的桌面浏览器继续素材导入。' : blocked ? '原上传结果需要核对。此次只读取原请求，不会重新签名或传输文件。' : '以下主站作品将导入官方素材库，用于当前所选账号；后续仍需核对账号和发布额度，抖音官方通道还需手机接力。'),
      createElement('ul', { className: 'max-h-[45vh] overflow-y-auto space-y-2' }, ...pending.map(({ selected, request, bridge }) => createElement('li', { key: selected.mediaId, className: 'rounded-md border border-border p-2 text-sm break-all' }, createElement('div', null, selected.fileName), createElement('div', { className: 'text-muted-foreground' }, `${(selected.file.size / 1024 ** 2).toFixed(2)} MiB · ${selected.accounts.join('、')}`), createElement('div', null, !request ? '尚未导入，等待本次明确确认' : !bridge ? '原请求尚未找到，保留原标识等待核对' : !bridge.connectionCurrent ? '官方连接已变化，保留历史记录' : bridge.phase === 'put' && resumable(bridge) ? '核对原上传结果，仅继续尚未领取的官方确认' : resumable(bridge) ? '可继续原上传尚未领取的步骤' : '原结果待核对，只读取原记录')))))
    const approved = await show({ title: blocked ? '核对原素材上传' : '确认官方素材导入', content, okText: blocked ? '只核对原记录' : pending.every(state => !!state.request) ? pending.some(state => state.bridge?.phase === 'put') ? '核对上传结果并继续确认' : '继续原上传' : '确认导入这些素材', cancelText: '返回编辑' })
    assertHostSession(owner, revision)
    if (!approved) return failure('NATIVE_MAIN_BRIDGE_CANCELLED', '已返回编辑，素材导入没有继续')
    if (blocked) {
      for (const state of pending) if (state.request) state.bridge = await lookup(state.selected, state.request)
      if (states.every(state => ready(state.bridge))) return
      if (!mayWrite) return failure('NATIVE_MAIN_BRIDGE_LOCK_UNAVAILABLE', '当前浏览器只能核对原上传记录，不能安全提交新的素材导入')
      return failure('NATIVE_MAIN_BRIDGE_PENDING', '原素材上传仍未确认完成，请保留原请求继续核对；发布准备已暂停')
    }
    for (const state of pending) {
      assertHostSession(owner, revision)
      const request: Marker = state.request ?? { version: 1, requestKey: `native-media-import:${crypto.randomUUID()}`, reference: state.selected.reference, mediaId: state.selected.mediaId }
      const bridge = await submit(state.selected, request)
      if (!ready(bridge)) return failure('NATIVE_MAIN_BRIDGE_PENDING', '原素材上传结果待核对，已停止后续素材与发布准备；请保留原请求标识')
    }
  }
  if (typeof navigator === 'undefined' || !navigator.locks?.request) { await execute(false); return }
  await navigator.locks.request(`aitoearn-native:main-media-bridge:${owner}`, { ifAvailable: true }, async lock => {
    if (!lock) return failure('NATIVE_MAIN_BRIDGE_BUSY', '另一个页面正在核对这位会员的素材上传，请回到原页面完成或核对原记录')
    assertHostSession(owner, revision)
    // Re-read every marker only after the cross-tab grant; no storage CAS can replace this lock.
    await execute(true)
  })
}
