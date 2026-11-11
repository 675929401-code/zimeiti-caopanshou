import { z } from 'zod'
import { NativePlatformSchema } from '@/lib/native-operations-contract'
import { PublishingCashQuoteInputSchema } from '@/lib/publishing-cash-contract'
import { PublishingStudioPlanSchema } from '@/lib/publishing-studio-contract'
import { PublishingOptionsSchema } from '@/lib/publishing-generic-contract'
import { assertHostSession, hostStorageKey } from './host-session'
import { allDraftMedia, readStudioMedia } from './studio-draft'
import { nativeSha256 } from './native-assets'
import type { StudioAccount, StudioDraft, StudioMedia } from './types'

const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/)
const mediaSchema = z.object({ id, name: z.string(), kind: z.enum(['image', 'video']), size: z.number().int().positive(), width: z.number().optional(), height: z.number().optional(), duration: z.number().optional(), stage: z.enum(['local', 'main', 'provider']), url: z.string().optional(), nativeMediaEntryId: id.optional(), type: z.string(), sha256: hash, lastModified: z.number() }).strict()
const overrideSchema = z.object({ title: z.string().optional(), body: z.string().optional(), topics: z.array(z.string()).optional(), mediaIds: z.array(id).optional(), coverId: id.optional(), publishAt: z.string().optional(), options: PublishingOptionsSchema.optional(), providerOptions: PublishingOptionsSchema.optional() }).strict()
const markerSchema = z.object({ owner: id, contentHash: hash, quoteInput: PublishingCashQuoteInputSchema, accounts: z.array(z.object({ id, platform: NativePlatformSchema, name: z.string(), status: z.string(), kind: z.enum(['browser', 'official', 'generic']), revision: z.number().int().positive(), metadataRevision: z.number().int().nonnegative(), uid: z.string() }).strict()), draft: z.object({ contentType: z.enum(['text', 'image', 'video']), title: z.string(), body: z.string(), topics: z.array(z.string()), mediaIds: z.array(id), coverId: id.optional(), publishAt: z.string().optional(), sourceDraftId: id.optional(), sourceDraftVersion: z.number().optional(), sourceMetadataRevision: z.number().optional(), collectionId: id.optional(), studioDraftId: id.optional(), studioDraftVersion: z.number().optional(), targetOverrides: z.record(z.string(), overrideSchema) }).strict(), media: z.array(mediaSchema), resume: PublishingStudioPlanSchema.optional() }).strict()
export type StudioCashPending = z.infer<typeof markerSchema>
const key = () => hostStorageKey('studio-cash-publish')!
export function readStudioCashPending() { const raw = localStorage.getItem(key()); if (!raw) return null; const value = markerSchema.parse(JSON.parse(raw)); if (value.owner !== assertHostSession().user.id) throw new Error('原发布属于其他会员'); return value }
export function completeStudioCashPending() { if (readStudioCashPending()) localStorage.removeItem(key()) }
export async function rememberStudioCashPending(draft: StudioDraft, accounts: StudioAccount[], quoteInput: StudioCashPending['quoteInput'], contentHash: string, current: () => void, resume?: StudioCashPending['resume']) {
  const owner = assertHostSession().user.id
  if (readStudioCashPending()) throw new Error('请先核对原发布，不能另建提交')
  const media = await Promise.all(allDraftMedia(draft).map(async m => { if (!m.file) throw new Error('原文件未读取'); const sha256 = await nativeSha256(m.file); current(); return { id: m.id, name: m.name, kind: m.kind, size: m.size, width: m.width, height: m.height, duration: m.duration, stage: m.stage ?? 'local', ...(m.stage && m.stage !== 'local' ? { url: m.url } : {}), nativeMediaEntryId: m.nativeMediaEntryId, type: m.file.type, sha256, lastModified: m.file.lastModified } }))
  const { media: _, cover, targetOverrides, ...common } = draft; void _
  const marker = markerSchema.parse({ owner, contentHash, quoteInput, accounts: accounts.map(({ id, platform, name, status, kind, revision, metadataRevision, uid }) => ({ id, platform, name, status, kind, revision, metadataRevision, uid })), draft: { ...common, mediaIds: draft.media.map(m => m.id), coverId: cover?.id, targetOverrides: Object.fromEntries(Object.entries(targetOverrides).map(([id, { cover, ...value }]) => [id, { ...value, coverId: cover?.id }])) }, media, resume })
  current(); assertHostSession(owner); localStorage.setItem(key(), JSON.stringify(marker)); return marker
}
/** Rehydrate original immutable content, using the editor only as a same-byte file pool. */
export async function restoreStudioCashPending(marker: StudioCashPending, pool: StudioDraft, current: () => void): Promise<{ draft: StudioDraft; accounts: StudioAccount[] }> {
  const files = new Map<string, File>()
  for (const item of allDraftMedia(pool)) if (item.file) { files.set(`${await nativeSha256(item.file)}:${item.file.size}:${item.file.type}`, item.file); current() }
  const media = new Map<string, StudioMedia>()
  for (const source of marker.media) {
    let file = files.get(`${source.sha256}:${source.size}:${source.type}`)
    if (!file && source.stage !== 'local') file = (await readStudioMedia({ ...source, status: 'ready', originalFile: { sha256: source.sha256, type: source.type, size: source.size } })).file
    current(); if (!file) throw new Error(`请重新选择原文件“${source.name}”，再核对原发布；系统只接受相同内容`)
    if (await nativeSha256(file) !== source.sha256 || file.size !== source.size || file.type !== source.type) throw new Error('原发布素材摘要不匹配')
    current(); media.set(source.id, { ...source, file: new File([file], source.name, { type: source.type, lastModified: source.lastModified }), originalFile: { sha256: source.sha256, type: source.type, size: source.size }, status: 'ready' })
  }
  const get = (id: string) => { const value = media.get(id); if (!value) throw new Error('原发布素材引用不完整'); return value }
  const { mediaIds, coverId, targetOverrides, ...common } = marker.draft
  return { accounts: marker.accounts.map(a => ({ ...a, selected: true })), draft: { ...common, media: mediaIds.map(get), cover: coverId ? get(coverId) : undefined, targetOverrides: Object.fromEntries(Object.entries(targetOverrides).map(([id, { coverId, ...value }]) => [id, { ...value, cover: coverId ? get(coverId) : undefined }])) } as StudioDraft }
}
