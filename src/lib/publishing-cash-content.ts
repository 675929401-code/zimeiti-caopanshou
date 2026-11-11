import { z } from 'zod'
import { PublishingCommercialPlatformSchema } from './publishing-contract'
import type { PublishingV2DraftInput, PublishingV2Target } from './publishing-v2-contract'
import type { PublishingV3IntentInput } from './publishing-v3-contract'
import type { PublishingStudioStoredDraft, PublishingTargetProfile } from './publishing-generic-contract'

const media = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().safe(), mime: z.string().min(1).max(120), role: z.enum(['image', 'video', 'cover']) }).strict()
export const PublishingCashContentSchema = z.object({
  schemaVersion: z.literal(1), contentType: z.enum(['text', 'image', 'video']), platform: PublishingCommercialPlatformSchema,
  title: z.string().max(10000), body: z.string().max(100000), topics: z.array(z.string()).max(100),
  options: z.record(z.string(), z.unknown()), publishAt: z.string().datetime({ offset: true }).nullable(),
  media: z.array(media).max(100), cover: media.nullable(),
}).strict()
export type PublishingCashContent = z.infer<typeof PublishingCashContentSchema>

/** One deterministic JSON representation for browser and server, without File/URL identities. */
export function publishingCashCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(publishingCashCanonical).join(',')}]`
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${publishingCashCanonical(v)}`).join(',')}}`
  }
  throw new Error('发布报价内容包含无法核验的数据')
}
export async function publishingCashDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(publishingCashCanonical(value))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('')
}
function selection(draft: { media: Array<{ id: string; hash?: string; size: number; type: string; role: string }> }, ids: string[], coverId?: string) {
  const get = (id: string, cover = false) => {
    const item = draft.media.find(m => m.id === id)
    if (!item || !item.hash) throw new Error('原素材缺少可核验摘要，请重新选择同一文件')
    return media.parse({ sha256: item.hash, size: item.size, mime: item.type, role: cover ? 'cover' : item.role })
  }
  return { media: ids.map(id => get(id)), cover: coverId ? get(coverId, true) : null }
}
type CashDraft = Pick<PublishingV2DraftInput, 'contentType' | 'title' | 'body' | 'topics' | 'media'>
export function publishingCashV2Content(draft: CashDraft, target: PublishingV2Target): PublishingCashContent {
  const ids = target.mediaIds ?? draft.media.filter(m => m.role !== 'cover').map(m => m.id)
  const coverId = target.coverMediaId ?? (target.mediaIds ? undefined : draft.media.find(m => m.role === 'cover')?.id)
  const options = target.platform === 'wxSph' ? { ...target.options, postFlag: target.options.postFlag ?? 0 } : target.platform === 'douyin' ? { ...target.options, privacyLevel: target.options.privacyLevel ?? 'public' } : target.options
  return PublishingCashContentSchema.parse({ schemaVersion: 1, platform: target.platform, contentType: draft.contentType,
    title: target.titleOverride ?? draft.title, body: target.bodyOverride ?? draft.body, topics: target.topicsOverride ?? draft.topics,
    options, publishAt: target.scheduledAt, ...selection(draft, ids.filter(id => id !== coverId), coverId),
  })
}
export function publishingCashV3Content(draft: CashDraft, intent: Pick<PublishingV3IntentInput, 'titleOverride' | 'bodyOverride' | 'topicsOverride' | 'options' | 'publishAt' | 'mediaIds' | 'coverMediaId'>): PublishingCashContent {
  return PublishingCashContentSchema.parse({ schemaVersion: 1, platform: 'douyin', contentType: draft.contentType,
    title: intent.titleOverride ?? draft.title, body: intent.bodyOverride ?? draft.body, topics: intent.topicsOverride ?? draft.topics,
    options: { short_title: '', cover_tsp: 0, download_type: 1, private_status: 0, ...intent.options }, publishAt: intent.publishAt, ...selection(draft, intent.mediaIds, intent.coverMediaId),
  })
}
export function publishingCashGenericContent(draft: Pick<PublishingStudioStoredDraft, 'contentType' | 'media'>, target: PublishingTargetProfile): PublishingCashContent {
  return PublishingCashContentSchema.parse({ schemaVersion: 1, platform: target.platform, contentType: draft.contentType,
    title: target.title, body: target.body, topics: target.topics, options: target.options, publishAt: target.publishAt,
    ...selection(draft, target.mediaIds, target.coverMediaId),
  })
}
