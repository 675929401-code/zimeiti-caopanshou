import { z } from 'zod'
import { PublishingV3AuthSessionSchema, PublishingV3OperationSchema, PublishingV3PageSchema } from '@host-publishing/publishing-v3-contract'
import type { ChannelAccountAuthStart } from '@/api/channels/channel.types'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { nativeBffFetch } from './host-transport'
const markerSchema = z.object({ requestKey: z.string().max(160), sessionId: z.string().uuid().optional() }).strict()
async function read(path: string, method = 'GET', body?: unknown) {
  const owner = assertHostSession().user.id; const revision = getHostSessionRevision()
  const response = await nativeBffFetch(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
  const value = z.object({ code: z.union([z.literal(0), z.string()]), data: z.unknown(), message: z.string() }).passthrough().parse(await response.json()); assertHostSession(owner, revision)
  if (value.code !== 0) throw new Error(value.message || '原官方授权结果待核对')
  return value.data
}
/** Persist local identifiers only. A lost response is recovered with GET, never a second auth POST. */
export async function startNativeAuthorization(): Promise<ChannelAccountAuthStart> {
  const key = hostStorageKey('official-auth'); if (!key) throw new Error('请先登录主站会员')
  const raw = localStorage.getItem(key)
  if (raw) {
    let marker: z.infer<typeof markerSchema>
    try { marker = markerSchema.parse(JSON.parse(raw)) } catch { throw new Error('原授权标记格式待核对，请保留浏览器数据') }
    let id = marker.sessionId
    if (!id) { const page = PublishingV3PageSchema.parse(await read(`publishing/v3?resource=operations&requestKey=${encodeURIComponent(marker.requestKey)}&pageSize=1`)); const operation = page.items.map(item => PublishingV3OperationSchema.parse(item)).find(item => item.kind === 'authorization'); if (!operation) throw new Error('原授权请求尚未查询到，暂不创建新授权，请稍后核对'); id = operation.subjectId }
    const session = PublishingV3AuthSessionSchema.parse(await read(`publishing/v3?resource=auth-session&id=${id}`))
    if (!['completed', 'failed', 'expired'].includes(session.state)) {
      if (!session.url) throw new Error('原授权尚未返回可打开入口，请核对原会话，不会新建授权')
      localStorage.setItem(key, JSON.stringify({ ...marker, sessionId: session.id }))
      return { sessionId: session.id, url: session.url, ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}), nativeRevision: session.revision }
    }
    localStorage.removeItem(key)
  }
  const marker = { requestKey: `native-auth:${crypto.randomUUID()}` }; localStorage.setItem(key, JSON.stringify(marker))
  const result = z.object({ sessionId: z.string().uuid(), url: PublishingV3AuthSessionSchema.shape.url, expiresAt: z.string().nullable().optional(), nativeRevision: z.number().int().positive() }).strict().parse(await read('v2/channels/accounts/auth/douyin', 'POST', marker))
  if (!result.url) throw new Error('原授权入口尚未返回，请稍后核对原会话')
  localStorage.setItem(key, JSON.stringify({ ...marker, sessionId: result.sessionId }))
  return { sessionId: result.sessionId, url: result.url, ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}), nativeRevision: result.nativeRevision }
}
export async function selectNativeAuthorization(sessionId: string, expectedRevision: number, accounts: { platformUid: string, account?: string }[]) {
  return read('v2/channels/accounts/auth/douyin/select', 'POST', { sessionId, expectedRevision, accounts, requestKey: `native-auth-select:${sessionId}:${expectedRevision}` })
}
export async function assignNativeAccountGroup(account: { id: string, nativeAccountKind?: 'browser' | 'official' | 'generic', nativeMetadataRevision?: number }, groupId: string) {
  if (account.nativeAccountKind === 'generic') throw new Error('官方绑定须使用独立授权分组入口')
  if (!z.string().uuid().safeParse(groupId).success) throw new Error('请选择真实账号分组')
  if (!account.nativeAccountKind || account.nativeMetadataRevision === undefined) throw new Error('账号归属版本尚未加载，请刷新后再移动分组')
  return read('metadata', 'POST', { action: 'save-account', accountKind: account.nativeAccountKind, accountId: account.id, groupId, rank: 0, expectedRevision: account.nativeMetadataRevision })
}
