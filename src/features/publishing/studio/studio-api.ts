import { z } from 'zod'
import { NativePlatformSchema } from '@/lib/native-operations-contract'
import { PublishingStudioBootstrapSchema } from '@/lib/publishing-studio-contract'
import { PublishingV2DraftSchema, PublishingV2PageSchema } from '@/lib/publishing-v2-contract'
import { NATIVE_OFFICIAL_API_PLATFORMS } from '@/lib/publishing-native'
import { PublishingPlatformMetadataSchema, PublishingGenericTargetSchema } from '@/lib/publishing-generic-contract'
import { assertHostSession, getHostSessionRevision } from './host-session'
import { nativeBffFetch } from './host-transport'
import type { StudioAccount, StudioPlatform, StudioHistoryItem, StudioImportItem, StudioRecordAction, StudioHistoryQuery } from './types'

const envelope = z.object({ code: z.union([z.literal(0), z.string()]), data: z.unknown(), message: z.string(), outcome: z.string().optional(), operationId: z.string().uuid().optional() }).passthrough()
export class StudioRequestError extends Error { constructor(readonly code: string, message: string, readonly status?: number, readonly unknown?: boolean, readonly operationId?: string) { super(message) } }
export async function studioRequest(path: string, method = 'GET', body?: unknown) {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  const request = () => nativeBffFetch(path, { method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  let response: Response
  try { response = await request() } catch {
    await new Promise(resolve => setTimeout(resolve, 600))
    try { response = await request() } catch { throw new StudioRequestError('NETWORK_UNAVAILABLE', '网络连接中断，请检查本地发布服务后刷新重试') }
  }
  const value = envelope.parse(await response.json()); assertHostSession(owner, revision)
  if (!response.ok || value.code !== 0) throw new StudioRequestError(String(value.code), value.message || '主站服务暂不可确认，请核对原记录', response.status, value.outcome === 'unknown', value.operationId)
  return value.data
}
const accountSchema = z.object({ id: z.string().uuid(), type: NativePlatformSchema, uid: z.string(), nickname: z.string(), avatar: z.string().optional(), status: z.number(), nativeAccountKind: z.enum(['browser', 'official', 'generic']), nativeRevision: z.number().int().positive(), nativeMetadataRevision: z.number().int().nonnegative().optional(), nativeConnectionState: z.string().optional() }).passthrough()
const platformSchema = z.object({ platform: NativePlatformSchema, name: z.string().optional(), nativeConnectionAllowed: z.boolean(), nativePublishAllowed: z.boolean(), nativeExecutionBlocked: z.boolean().optional(), nativeReason: z.string(), channels: z.array(z.object({ transport: z.enum(['browser_plugin','official_api']), connectionAllowed: z.boolean(), publishAllowed: z.boolean(), reason: z.string() }).strict()).optional() }).passthrough()
function memberPlatformStatus(connection: boolean, publishing: boolean) {
  return !connection ? { reasonCode: 'connection_unavailable' as const, reason: '此通道暂时无法连接账号，请稍后重试或联系管理员' } : !publishing ? { reasonCode: 'execution_unavailable' as const, reason: '可以先连接账号和整理作品，发布服务开放后即可提交' } : { reasonCode: 'ready' as const, reason: '请核对发布账号、作品内容和发布时间' }
}
export async function readStudioWorkspace() {
  const [bootstrap, accountData, platformData] = await Promise.all([studioRequest('studio/bootstrap'), studioRequest('v2/channels/accounts'), studioRequest('v2/channels/platforms')])
  return {
    bootstrap: PublishingStudioBootstrapSchema.parse(bootstrap),
    accounts: z.object({ list: z.array(accountSchema) }).parse(accountData).list.map((item): StudioAccount => ({ id: item.id, platform: item.type, name: item.nickname, avatar: item.avatar, status: item.status === 1 ? 'ready' : 'unavailable', selected: false, kind: item.nativeAccountKind, revision: item.nativeRevision, metadataRevision: item.nativeMetadataRevision ?? 0, uid: item.uid })),
    platforms: z.array(platformSchema).parse(platformData).map((item): StudioPlatform => ({ ...PublishingPlatformMetadataSchema.parse(item), channels: item.channels?.map(channel => ({ ...channel, ...memberPlatformStatus(channel.connectionAllowed, channel.publishAllowed), ...(channel.transport === 'browser_plugin' && item.platform === 'xhs' && channel.publishAllowed ? { reason: '小红书插件定时尚不稳定，建议立即发布，并在平台核对作品' } : {}) })), transport: item.platform === 'xhs' || item.platform === 'wxSph' ? 'browser_plugin' : 'official_api', key: item.platform, name: item.name?.trim() && item.name.trim() !== item.platform ? item.name.trim() : NATIVE_OFFICIAL_API_PLATFORMS.find(platform => platform.platform === item.platform)?.name || item.platform, available: item.nativePublishAllowed, connectionAllowed: item.nativeConnectionAllowed, executionBlocked: item.nativeExecutionBlocked === true, nativeReason: typeof item.nativeReason === 'string' && item.nativeReason.trim() ? item.nativeReason.trim() : undefined, ...memberPlatformStatus(item.nativeConnectionAllowed, item.nativePublishAllowed) })),
  }
}
export async function readStudioImport(kind: 'media' | 'draft'): Promise<StudioImportItem[]> {
  if (kind === 'draft') {
    const page = PublishingV2PageSchema.parse(await studioRequest('publishing/v2?resource=drafts&pageSize=50'))
    if (!page.schemaReady) throw new Error('发布草稿存储尚未就绪')
    const legacy: StudioImportItem[] = page.items.map(value => PublishingV2DraftSchema.parse(value)).filter(value => !value.archived).map(value => ({ id: value.id, title: value.payload.title || '未命名草稿', kind: 'draft', storage: 'legacy', revision: value.revision, createdAt: value.updatedAt }))
    try {
      const drafts = z.object({ items: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive(), title: z.string(), updatedAt: z.string() }).passthrough()) }).parse(await studioRequest('publishing/generic?resource=drafts&pageSize=100'))
      return [...drafts.items.map((value): StudioImportItem => ({ id: value.id, title: value.title || '未命名稿件', kind: 'draft', storage: 'studio', revision: value.revision, createdAt: value.updatedAt })), ...legacy]
    } catch (error) { if (error instanceof StudioRequestError && error.code === 'NATIVE_OFFICIAL_SCHEMA_NOT_READY') return legacy; throw error }
  }
  const result = z.object({ list: z.array(z.object({ id: z.string(), filename: z.string(), url: z.string(), type: z.enum(['video', 'image']), createdAt: z.string().optional(), nativeAvailability: z.string() }).passthrough()) }).parse(await studioRequest('history/assets?pageSize=50'))
  return result.list.filter(value => value.nativeAvailability === 'ready' && value.url).map(value => ({ id: value.id, title: value.filename || '主站作品', kind: value.type, url: value.url, createdAt: value.createdAt }))
}
const historySchema = z.object({ id: z.string().uuid(), title: z.string().optional(), accountType: z.string(), nativeOutcome: z.string(), nativeReportedSuccess: z.boolean().optional(), nativeEvidence: z.string().optional(), nativeReportSource: z.string().optional(), nativeTransport: z.string().optional(), nativeRevision: z.number().int().positive().optional(), nativeConnectionCurrent: z.boolean().optional(), createdAt: z.string().optional(), workLink: z.string().optional(), publishTime: z.string().optional(), status: z.number().optional() }).passthrough()
export function projectStudioHistory(input: unknown): StudioHistoryItem {
  const value = historySchema.parse(input), state = value.nativeOutcome === 'browser_reported' && value.nativeReportedSuccess === false ? 'failed' : value.nativeOutcome === 'published' && !value.workLink ? 'awaiting_verification' : value.nativeOutcome
  const availableActions: StudioRecordAction[] = ['refresh']
  if (value.nativeTransport === 'local_plan' && state === 'planned' && value.nativeRevision && value.publishTime && Date.parse(value.publishTime) <= Date.now()) availableActions.push('resume')
  if (value.nativeTransport === 'official_api' && state === 'awaiting_user_action') availableActions.push('user_action')
  if (value.nativeReportSource !== 'browser_reported' && value.nativeRevision && value.nativeConnectionCurrent !== false && state !== 'unknown') {
    if (['waiting', 'pending', 'queued', 'platform_scheduled', 'awaiting_user_action', 'planned'].includes(state)) availableActions.push('cancel')
    const leadTime = !value.publishTime || Date.parse(value.publishTime) - Date.now() > 600000
    if (['waiting', 'pending', 'queued', 'planned'].includes(state) && leadTime) { availableActions.push('reschedule'); if (value.nativeTransport === 'official_api') availableActions.push('publish_now') }
  }
  return { id: value.id, title: value.title || '发布内容', platform: value.accountType, state, createdAt: value.createdAt, url: value.workLink, evidence: value.nativeEvidence, revision: value.nativeRevision, transport: value.nativeTransport, publishAt: value.publishTime, availableActions }
}
export async function readStudioHistory(): Promise<StudioHistoryItem[]> {
  return z.array(z.unknown()).parse(await studioRequest('v2/channels/publish/records')).map(projectStudioHistory)
}
export function projectStudioGenericRecord(input: unknown): StudioHistoryItem {
  const value = PublishingGenericTargetSchema.parse(input)
  return { id: value.id, operationId: value.operationId, title: value.title || '发布内容', platform: value.platform, accountName: value.accountName, state: value.state, createdAt: value.createdAt, publishAt: value.publishAt, revision: value.revision, transport: 'generic_api', url: value.workLink ?? undefined, evidence: value.state === 'published' ? 'provider_reported' : undefined, message: value.errorCode ?? undefined, availableActions: value.availableActions }
}
/** Explicit history navigation only. Each source page remains owner scoped. */
export async function readStudioHistoryPage(query: StudioHistoryQuery = {}) {
  const parameters = new URLSearchParams({ page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 30), ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) })
  const page = z.object({ items: z.array(z.object({ source: z.enum(['legacy', 'generic']), value: z.unknown() }).strict()), page: z.number().int().positive(), pageSize: z.number().int().positive(), total: z.number().int().nonnegative() }).strict().parse(await studioRequest(`studio/history?${parameters}`))
  return { ...page, items: page.items.map(item => item.source === 'generic' ? projectStudioGenericRecord(item.value) : projectStudioHistory(item.value)), hasMore: page.page * page.pageSize < page.total }
}
