import { z } from 'zod'
import { NativePlatformSchema } from './native-operations-contract'
import { NativeMediaSourceSchema } from './native-main-media-contract'
import { PublishingAuthorizationPlatformSchema } from './publishing-authorization-contract'
import { PublishingV2MediaSchema } from './publishing-v2-contract'
import { isPublishingSafeHttps } from './publishing-contract'
import { PublishingCashFundingSchema } from './publishing-cash-contract'

const id = z.string().uuid()
const revision = z.number().int().positive().max(2147483647)
const requestKey = z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const stamp = z.string().datetime({ offset: true })
const forbidden = /cookie|token|secret|password|authorization|credential|api.?key/i
export function isPublishingOptionValue(value: unknown, depth = 0): boolean {
  if (depth > 16) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return true
  if (typeof value === 'string') return value.length <= 10000
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => isPublishingOptionValue(item, depth + 1))
  return !!value && typeof value === 'object' && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) => !forbidden.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && isPublishingOptionValue(item, depth + 1))
}
export const PublishingOptionsSchema = z.record(z.string(), z.unknown()).refine(isPublishingOptionValue)
/** Public metadata contains provider validation rules; it grants no execution permission. */
export const PublishingPlatformMetadataSchema = z.object({
  editor: z.string().max(30).optional(), contentLimits: PublishingOptionsSchema.optional(),
  mediaRules: PublishingOptionsSchema.optional(), topic: PublishingOptionsSchema.optional(),
  optionSchema: z.record(z.string(), z.unknown()).optional(), defaultOption: PublishingOptionsSchema.optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
}).strip()
export type PublishingPlatformMetadata = z.infer<typeof PublishingPlatformMetadataSchema>

/** All fourteen target profiles are persisted with the exact immutable native draft version. */
export const PublishingTargetProfileSchema = z.object({
  id, accountId: id, accountKind: z.enum(['browser', 'official', 'generic']), platform: NativePlatformSchema,
  accountRevision: revision, title: z.string().max(10000), body: z.string().max(100000),
  topics: z.array(z.string().trim().min(1).max(100)).max(100),
  mediaIds: z.array(id).max(100), coverMediaId: id.optional(),
  publishAt: stamp.nullable(), options: PublishingOptionsSchema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.mediaIds).size !== value.mediaIds.length) ctx.addIssue({ code: 'custom', message: '目标素材不得重复' })
  const kind = value.platform === 'xhs' || value.platform === 'wxSph' ? 'browser' : value.platform === 'douyin' ? 'official' : 'generic'
  if (value.accountKind !== kind && !(value.platform === 'douyin' && value.accountKind === 'browser')) ctx.addIssue({ code: 'custom', message: '账号连接类型与平台不一致' })
})
export type PublishingTargetProfile = z.infer<typeof PublishingTargetProfileSchema>
export const PublishingDraftProfileSchema = z.object({
  schemaVersion: z.literal(1), targets: z.array(PublishingTargetProfileSchema).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.targets.map(item => item.id)).size !== value.targets.length || new Set(value.targets.map(item => item.accountId)).size !== value.targets.length) ctx.addIssue({ code: 'custom', message: '发布目标或账号不得重复' })
})
export type PublishingDraftProfile = z.infer<typeof PublishingDraftProfileSchema>
export const PublishingStudioStoredDraftSchema = z.object({
  schemaVersion: z.literal(1), contentType: z.enum(['text', 'image', 'video']),
  title: z.string().max(10000), body: z.string().max(100000), topics: z.array(z.string().trim().min(1).max(100)).max(100),
  media: z.array(PublishingV2MediaSchema).max(100), coverMediaId: id.optional(), publishAt: stamp.nullable(),
  sources: z.array(z.object({ mediaId: id, source: NativeMediaSourceSchema, mediaEntryId: id.optional() }).strict()).max(100),
  profile: PublishingDraftProfileSchema,
}).strict().superRefine((value, ctx) => {
  const media = new Set(value.media.map(item => item.id))
  if (media.size !== value.media.length || value.sources.length !== value.media.length || new Set(value.sources.map(item => item.mediaId)).size !== media.size || value.sources.some(item => !media.has(item.mediaId))) ctx.addIssue({ code: 'custom', message: '素材来源必须与素材池逐一对应' })
  if (value.coverMediaId && !media.has(value.coverMediaId) || value.profile.targets.some(target => target.mediaIds.some(item => !media.has(item)) || target.coverMediaId && !media.has(target.coverMediaId))) ctx.addIssue({ code: 'custom', message: '账号素材必须引用所保存的素材池' })
  if (value.contentType === 'text' && value.media.length || value.contentType === 'image' && value.media.some(item => item.role === 'video')) ctx.addIssue({ code: 'custom', message: '素材类型与稿件类型不一致' })
})
export type PublishingStudioStoredDraft = z.infer<typeof PublishingStudioStoredDraftSchema>
export const PublishingProfileSaveSchema = z.object({
  action: z.literal('save-draft'), requestKey, id: id.optional(), expectedRevision: z.number().int().nonnegative(),
  draft: PublishingStudioStoredDraftSchema,
}).strict()
export const PublishingGenericActionSchema = z.discriminatedUnion('action', [
  PublishingProfileSaveSchema,
  z.object({ action: z.literal('prepare'), requestKey, draftId: id, draftVersion: revision, profileRevision: revision, targetIds: z.array(id).min(1).max(100), contentHash: hash }).strict(),
  z.object({ action: z.literal('execute'), requestKey, operationId: id, expectedRevision: revision, snapshotHash: hash, funding: PublishingCashFundingSchema.optional() }).strict(),
  z.object({ action: z.literal('reconcile'), operationId: id, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('change-task'), requestKey, targetId: id, expectedRevision: revision, change: z.enum(['cancel', 'reschedule', 'publish_now']), publishAt: stamp.optional() }).strict().superRefine((value, ctx) => {
    if ((value.change === 'reschedule') !== (value.publishAt !== undefined)) ctx.addIssue({ code: 'custom', message: '改期必须提供新的发布时间' })
  }),
])
export type PublishingGenericAction = z.infer<typeof PublishingGenericActionSchema>
export const PublishingGenericQuerySchema = z.discriminatedUnion('resource', [
  z.object({ resource: z.literal('status') }).strict(),
  z.object({ resource: z.literal('operation'), id: id.optional(), requestKey: requestKey.optional() }).strict().refine(value => (value.id !== undefined) !== (value.requestKey !== undefined)),
  z.object({ resource: z.literal('records'), page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30), from: stamp.optional(), to: stamp.optional(), platform: PublishingAuthorizationPlatformSchema.optional() }).strict(),
  z.object({ resource: z.literal('record'), id }).strict(),
  z.object({ resource: z.literal('profile'), draftId: id, draftVersion: revision }).strict(),
  z.object({ resource: z.literal('drafts'), page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) }).strict(),
  z.object({ resource: z.literal('options'), bindingId: id, option: z.string().min(1).max(100).optional(), query: z.string().max(500).optional() }).strict(),
])
export type PublishingGenericQuery = z.infer<typeof PublishingGenericQuerySchema>
export const PublishingGenericTargetStateSchema = z.enum(['prepared', 'queued', 'publishing', 'published', 'failed_known', 'cancelled', 'unknown', 'blocked'])
export const PublishingGenericTargetSchema = z.object({
  id, operationId: id, bindingId: id, platform: PublishingAuthorizationPlatformSchema, revision,
  state: PublishingGenericTargetStateSchema, title: z.string().max(10000), publishAt: stamp,
  accountName: z.string().max(240), connectionCurrent: z.boolean(),
  workLink: z.string().refine(isPublishingSafeHttps).nullable(), errorCode: z.string().max(100).nullable(),
  availableActions: z.array(z.enum(['refresh', 'cancel', 'reschedule', 'publish_now'])),
  createdAt: stamp, updatedAt: stamp,
}).strict()
export const PublishingGenericOperationSchema = z.object({
  id, kind: z.enum(['publish', 'task_change']), requestKey, snapshotHash: hash,
  revision, state: z.enum(['prepared', 'dispatching', 'submitted', 'succeeded', 'partial', 'failed_known', 'unknown', 'blocked']),
  connectionCurrent: z.boolean(), grantUsed: z.boolean(), targetIds: z.array(id),
  errorCode: z.string().max(100).nullable(), createdAt: stamp, updatedAt: stamp,
}).strict()
export const PublishingGenericMutationSchema = z.object({
  ok: z.literal(true), operations: z.array(PublishingGenericOperationSchema), targets: z.array(PublishingGenericTargetSchema),
  draftId: id.optional(), draftVersion: revision.optional(), profileRevision: revision.optional(), metadataRevision: revision.optional(),
  alreadyFulfilled: z.boolean(),
}).strict()
export type PublishingGenericMutation = z.infer<typeof PublishingGenericMutationSchema>
export type PublishingGenericOperation = z.infer<typeof PublishingGenericOperationSchema>
export type PublishingGenericTarget = z.infer<typeof PublishingGenericTargetSchema>
