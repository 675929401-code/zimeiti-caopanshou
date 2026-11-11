import { z } from 'zod'
import { PublishingGenericMutationSchema, PublishingProfileSaveSchema, PublishingStudioStoredDraftSchema, type PublishingStudioStoredDraft } from '@/lib/publishing-generic-contract'
import { nativeAssetPath } from '@/lib/native-operations-contract'
import { nativeMainMediaPath } from '@/lib/native-main-media-contract'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { nativeSha256 } from './native-assets'
import { readNativePublishingMedia } from './native-readable-media'
import { studioRequest } from './studio-api'
import type { StudioAccount, StudioDraft, StudioMedia, StudioPlatform } from './types'
import { PublishingStudioPlanContentSchema } from '@/lib/publishing-studio-contract'

export async function compileStudioStoredDraft(draft: StudioDraft, accounts: StudioAccount[], current: () => void, platforms: StudioPlatform[] = []): Promise<PublishingStudioStoredDraft> {
  const media: PublishingStudioStoredDraft['media'] = [], sources: PublishingStudioStoredDraft['sources'] = [], identities = new Map<string, string>()
  const selections = [...draft.media.map(value => ({ value, role: value.kind })), ...(draft.cover ? [{ value: draft.cover, role: 'cover' }] : []), ...accounts.flatMap(account => draft.targetOverrides[account.id]?.cover ? [{ value: draft.targetOverrides[account.id].cover!, role: 'cover' }] : [])]
  for (const selection of selections) {
    if (!selection.value.url) throw new Error('素材还未确认上传，无法保存稿件')
    const value = await readNativePublishingMedia(selection.value.url); current()
    identities.set(selection.value.id, value.mediaId)
    if (media.some(item => item.id === value.mediaId)) continue
    media.push({ id: value.mediaId, fileName: value.file.name, role: selection.role as 'video' | 'image' | 'cover', type: value.file.type, size: value.file.size, lastModified: 0, hash: value.sha256, ...value.metadata, ...(value.kind === 'main' ? { source: 'main_asset' as const, requiresReselection: false as const, reference: value.reference } : { source: 'local_file' as const, requiresReselection: true as const }) })
    sources.push({ mediaId: value.mediaId, source: value.source, ...(selection.value.nativeMediaEntryId ? { mediaEntryId: selection.value.nativeMediaEntryId } : {}) })
  }
  const mapped = (id: string) => { const value = identities.get(id); if (!value) throw new Error('目标素材映射不完整'); return value }
  return PublishingStudioStoredDraftSchema.parse({ schemaVersion: 1, contentType: draft.contentType, title: draft.title, body: draft.body, topics: draft.topics, media, sources, publishAt: draft.publishAt || null, ...(draft.cover ? { coverMediaId: mapped(draft.cover.id) } : {}), profile: { schemaVersion: 1, targets: accounts.map(account => {
    const override = draft.targetOverrides[account.id] || {}, cover = override.cover || draft.cover
    return { id: account.id, accountId: account.id, accountKind: account.kind, platform: account.platform, accountRevision: account.revision, title: override.title ?? draft.title, body: override.body ?? draft.body, topics: override.topics ?? draft.topics, mediaIds: (override.mediaIds ?? draft.media.map(m => m.id)).map(mapped), ...(cover ? { coverMediaId: mapped(cover.id) } : {}), publishAt: (override.publishAt ?? draft.publishAt) || null, options: account.kind === 'generic' ? override.providerOptions ?? platforms.find(p => p.key === account.platform)?.defaultOption ?? {} : override.options ?? {} }
  }) } })
}
/** A save is complete only when the full fourteen-platform profile is durable. */
export async function saveStudioDraft(draft: StudioDraft, accounts: StudioAccount[], current: () => void, platforms: StudioPlatform[] = []) {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision(), payload = await compileStudioStoredDraft(draft, accounts, current, platforms)
  const base = { action: 'save-draft', ...(draft.studioDraftId ? { id: draft.studioDraftId } : {}), expectedRevision: draft.studioDraftVersion ?? 0, draft: payload }
  const digest = await nativeSha256(new Blob([JSON.stringify(base)], { type: 'text/plain' })); current()
  const key = hostStorageKey(`studio-save-v2:${digest}`)!, existing = localStorage.getItem(key)
  let result: unknown
  if (existing) {
    const requestKey = z.string().regex(/^studio-save:[a-f\d-]{36}$/i).parse(existing)
    result = await studioRequest(`publishing/generic?resource=operation&requestKey=${encodeURIComponent(requestKey)}`); current()
    if (!result) throw new Error('原保存结果尚未确认，请保留请求标识，不会重复创建稿件')
  } else {
    const requestKey = `studio-save:${crypto.randomUUID()}`
    const action = PublishingProfileSaveSchema.parse({ ...base, requestKey })
    localStorage.setItem(key, requestKey); current()
    result = await studioRequest('publishing/generic', 'POST', action); current()
  }
  const value = PublishingGenericMutationSchema.parse(result); assertHostSession(owner, revision)
  if (!value.draftId || !value.draftVersion || !value.profileRevision) throw new Error('稿件保存缺少完整版本回执，请核对原请求')
  if (draft.studioDraftId && value.draftId !== draft.studioDraftId || value.draftVersion !== (draft.studioDraftVersion ?? 0) + 1) throw new Error('稿件版本回执与原请求不一致，请保留原保存标识')
  return { id: value.draftId, version: value.draftVersion, metadataRevision: value.profileRevision, payload }
}
export function restoreStudioStoredDraft(id: string, revision: number, payload: unknown): StudioDraft {
  const value = PublishingStudioStoredDraftSchema.parse(payload)
  const media = value.media.map((m): StudioMedia => { const mapping = value.sources.find(s => s.mediaId === m.id)!, source = mapping.source; return { id: m.id, name: m.fileName, kind: m.role === 'video' ? 'video' : 'image', size: m.size, width: m.width, height: m.height, duration: m.duration, nativeMediaEntryId: mapping.mediaEntryId, status: 'ready', stage: source.kind === 'provider_asset' ? 'provider' : 'main', url: source.kind === 'provider_asset' ? nativeAssetPath(source.assetId) : nativeMainMediaPath(source.reference) } })
  const find = (id?: string) => media.find(m => m.id === id)
  return { contentType: value.contentType, title: value.title, body: value.body, topics: value.topics, media: media.filter(m => value.media.find(a => a.id === m.id)?.role !== 'cover'), cover: find(value.coverMediaId), publishAt: value.publishAt ?? undefined, studioDraftId: id, studioDraftVersion: revision, targetOverrides: Object.fromEntries(value.profile.targets.map(target => [target.accountId, { title: target.title, body: target.body, topics: target.topics, mediaIds: target.mediaIds, cover: find(target.coverMediaId), publishAt: target.publishAt ?? '', ...(target.accountKind === 'generic' ? { providerOptions: target.options } : { options: target.options }) }])) }
}
export function restoreStudioLegacyDraft(input: unknown): StudioDraft {
  const value = PublishingStudioPlanContentSchema.parse(input), payload = value.draft.payload
  const media = payload.media.map((m): StudioMedia => {
    const mapping = value.metadata?.media.find(s => s.mediaId === m.id)
    const source = mapping ? ('source' in mapping ? mapping.source : { kind: 'provider_asset' as const, assetId: mapping.assetId }) : m.source === 'main_asset' && m.reference.kind !== 'image_gallery' ? { kind: 'main_asset' as const, reference: m.reference } : null
    return { id: m.id, name: m.fileName, kind: m.role === 'video' ? 'video' : 'image', size: m.size, width: m.width, height: m.height, duration: m.duration, nativeMediaEntryId: value.mediaEntryRefs.find(r => r.mediaId === m.id)?.mediaEntryId, originalFile: { sha256: m.hash, size: m.size, type: m.type }, status: source ? 'ready' : 'error', stage: source?.kind === 'provider_asset' ? 'provider' : source ? 'main' : 'local', ...(source ? { url: source.kind === 'provider_asset' ? nativeAssetPath(source.assetId) : nativeMainMediaPath(source.reference) } : { error: m.hash ? '请重新选择原文件；系统将核对内容摘要、大小和格式' : '原计划没有保存文件摘要，无法安全恢复执行；请另建并确认新稿' }) }
  })
  const commonCoverId = value.metadata?.coverMediaId ?? (payload.media.filter(m => m.role === 'cover').length === 1 ? payload.media.find(m => m.role === 'cover')?.id : undefined)
  return { contentType: payload.contentType, title: payload.title, body: payload.body, topics: [...payload.topics], media: media.filter(m => payload.media.find(a => a.id === m.id)?.role !== 'cover'), cover: media.find(m => m.id === commonCoverId), sourceDraftId: value.draft.id, sourceDraftVersion: value.draft.revision, sourceMetadataRevision: value.metadataRevision, collectionId: payload.collectionId ?? undefined, targetOverrides: Object.fromEntries(payload.targets.map(t => [t.accountId, { title: t.titleOverride, body: t.bodyOverride, topics: t.topicsOverride, mediaIds: t.mediaIds, cover: media.find(m => m.id === t.coverMediaId), publishAt: t.scheduledAt ?? '', options: t.platform === 'xhs' ? { xhs: t.options.declaration ? { userDeclarationBind: { origin: t.options.declaration } } : {} } : t.platform === 'wxSph' ? { wxSph: { poiInfo: t.options.poiInfo, activity: t.options.event, extLink: t.options.extLink, isOriginal: t.options.postFlag === 1 } } : {} }])) }
}
