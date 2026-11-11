import { z } from 'zod'
import {
  PublishingAuthorizationActionSchema,
  PublishingAuthorizationBindingSchema,
  PublishingAuthorizationMutationSchema,
  PublishingAuthorizationOperationSchema,
  PublishingAuthorizationPageSchema,
  PublishingAuthorizationPlatformSchema,
  PublishingAuthorizationSessionSchema,
} from '@/lib/publishing-authorization-contract'
import type { PublishingAuthorizationAction, PublishingAuthorizationPlatform, PublishingAuthorizationSession } from '@/lib/publishing-authorization-contract'
import { isPublishingSafeHttps } from '@/lib/publishing-contract'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { nativeBffFetch } from './host-transport'

const markerSchema = z.object({ requestKey: z.string().min(1).max(160), sessionId: z.string().uuid().optional(), selectionKey: z.string().max(160).optional() }).strict()
const mutationMarker = z.object({ requestKey: z.string().max(160), bindingId: z.string().uuid(), expectedRevision: z.number().int().positive(), action: z.enum(['disconnect', 'move-binding']), groupId: z.string().uuid().nullable().optional() }).strict()
const envelope = z.object({ code: z.union([z.literal(0), z.string()]), data: z.unknown(), message: z.string(), operationId: z.string().uuid().optional() }).passthrough()
class NativeOAuthReadError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly operationId?: string) { super(message) }
}
// These closed errors occur before a new external dispatch; uncertain outcomes retain their marker.
const definitelyRejected = (reason: unknown) => reason instanceof NativeOAuthReadError && !reason.operationId && [400, 409].includes(reason.status) && ['PUBLISH_AUTH_INPUT_INVALID', 'PUBLISH_AUTH_NOT_CONFIGURED', 'PUBLISH_AUTH_PLATFORM_UNAVAILABLE', 'PUBLISH_AUTH_REVISION_CONFLICT', 'PUBLISH_AUTH_GROUP_CHANGED', 'PUBLISH_AUTH_RESTART_REQUIRED', 'PUBLISH_AUTH_SELECTION_INVALID'].includes(reason.code)
export const isNativeOAuthPlatform = (platform: string): platform is PublishingAuthorizationPlatform => PublishingAuthorizationPlatformSchema.safeParse(platform).success
export function safeNativeAuthorizationUrl(value?: string) {
  return value && isPublishingSafeHttps(value) ? value : undefined
}
function storageKey(platform: PublishingAuthorizationPlatform) {
  const key = hostStorageKey(`oauth:${platform}`)
  if (!key) throw new Error('请先登录主站会员')
  return key
}
function readMarker(key: string) {
  const raw = localStorage.getItem(key)
  if (!raw) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('原授权恢复标记待核对，请保留浏览器数据') }
  const parsed = markerSchema.safeParse(value)
  if (!parsed.success) throw new Error('原授权恢复标记待核对，请保留浏览器数据')
  return parsed.data
}
async function read(path: string, body?: PublishingAuthorizationAction) {
  const owner = assertHostSession().user.id
  const revision = getHostSessionRevision()
  const response = await nativeBffFetch(`authorizations${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(PublishingAuthorizationActionSchema.parse(body)) } : {})
  const value = envelope.parse(await response.json())
  assertHostSession(owner, revision)
  if (!response.ok || value.code !== 0) throw new NativeOAuthReadError(value.message || '授权结果暂不可确认，请核对原操作', String(value.code), response.status, value.operationId)
  return value.data
}
async function operationByKey(requestKey: string) {
  const page = PublishingAuthorizationPageSchema(PublishingAuthorizationOperationSchema).parse(await read(`?resource=operations&requestKey=${encodeURIComponent(requestKey)}&pageSize=1`))
  const operation = page.items[0]
  if (operation && operation.requestKey !== requestKey) throw new Error('原授权操作归属不匹配')
  return operation
}
export async function readNativeOAuthSession(id: string) {
  const session = PublishingAuthorizationSessionSchema.parse(await read(`?resource=session&id=${z.string().uuid().parse(id)}`))
  if (session.id !== id) throw new Error('原授权会话不匹配')
  return session
}
export function canRestartNativeOAuth(session: PublishingAuthorizationSession) {
  return session.state === 'failed' || session.state === 'expired' || session.state === 'requires_selection' && !session.continuationReady && session.connectionCurrent
}
/** Only local IDs are persisted. Lost acknowledgements are recovered by GET, never another POST. */
export async function startNativeOAuth(platform: PublishingAuthorizationPlatform, group?: { id: string, revision: number }, restart = false) {
  const owner = assertHostSession().user.id
  const revision = getHostSessionRevision()
  const key = storageKey(platform)
  const prior = readMarker(key)
  if (prior) {
    let sessionId = prior.sessionId
    if (!sessionId) {
      const operation = await operationByKey(prior.requestKey)
      assertHostSession(owner, revision)
      if (!operation?.sessionId || operation.kind !== 'start') throw new Error('原授权请求尚未确认，暂不新建授权；请稍后只读核对')
      sessionId = operation.sessionId
    }
    const session = await readNativeOAuthSession(sessionId)
    assertHostSession(owner, revision)
    if (session.platform !== platform) throw new Error('原授权平台不匹配')
    if (readMarker(key)?.requestKey !== prior.requestKey) throw new Error('授权流程已变化，请核对当前会话')
    localStorage.setItem(key, JSON.stringify({ ...prior, sessionId }))
    if (!restart || !canRestartNativeOAuth(session)) return session
  }
  const marker = { requestKey: `native-oauth:${crypto.randomUUID()}` }
  localStorage.setItem(key, JSON.stringify(marker))
  let response: unknown
  try { response = await read('', { action: 'start', platform, requestKey: marker.requestKey, ...(group ? { groupId: group.id, expectedGroupRevision: group.revision } : {}) }) }
  catch (reason) {
    assertHostSession(owner, revision)
    if (definitelyRejected(reason) && readMarker(key)?.requestKey === marker.requestKey) localStorage.removeItem(key)
    throw reason
  }
  const result = PublishingAuthorizationMutationSchema.parse(response)
  assertHostSession(owner, revision)
  if (result.operation.kind !== 'start' || result.operation.requestKey !== marker.requestKey || !result.session || result.operation.sessionId !== result.session.id || result.session.platform !== platform) throw new Error('授权已提交，入口尚待核对；不会自动重建请求')
  if (readMarker(key)?.requestKey !== marker.requestKey) throw new Error('授权流程已变化，请核对当前会话')
  localStorage.setItem(key, JSON.stringify({ ...marker, sessionId: result.session.id }))
  return result.session
}
export async function selectNativeOAuth(session: PublishingAuthorizationSession, choiceIds: string[]) {
  if (session.state !== 'requires_selection' || !session.connectionCurrent || !session.continuationReady) throw new Error('授权续传已失效或会话不可选择，请只读核对并明确重新授权')
  if (!choiceIds.length || new Set(choiceIds).size !== choiceIds.length || choiceIds.some(id => !session.choices.some(choice => choice.id === id))) throw new Error('只能选择本次会话明确返回的账号')
  const owner = assertHostSession().user.id
  const revision = getHostSessionRevision()
  const key = storageKey(session.platform)
  const marker = readMarker(key)
  if (!marker || marker.sessionId !== session.id) throw new Error('原授权请求标识缺失，请核对原会话')
  if (marker.selectionKey) {
    const operation = await operationByKey(marker.selectionKey)
    assertHostSession(owner, revision)
    if (!operation || operation.kind !== 'select' || operation.sessionId !== session.id) throw new Error('原账号选择结果尚未确认，请勿重复提交')
    return readNativeOAuthSession(session.id)
  }
  const requestKey = `native-oauth-select:${crypto.randomUUID()}`
  localStorage.setItem(key, JSON.stringify({ ...marker, selectionKey: requestKey }))
  let response: unknown
  try { response = await read('', { action: 'select', sessionId: session.id, expectedRevision: session.revision, choiceIds, requestKey }) }
  catch (reason) {
    assertHostSession(owner, revision)
    if (definitelyRejected(reason) && readMarker(key)?.selectionKey === requestKey) localStorage.setItem(key, JSON.stringify(marker))
    throw reason
  }
  const result = PublishingAuthorizationMutationSchema.parse(response)
  assertHostSession(owner, revision)
  if (result.operation.kind !== 'select' || result.operation.requestKey !== requestKey || result.operation.sessionId !== session.id || result.session && result.session.id !== session.id) throw new Error('原账号选择操作不匹配，请核对原会话')
  return result.session ?? readNativeOAuthSession(session.id)
}
/** Resolve exactly the bindings named by this completed session, including pagination. */
export async function readNativeOAuthBindings(session: PublishingAuthorizationSession) {
  if (session.state !== 'completed' || !session.connectionCurrent || !session.bindingIds.length) throw new Error('会话尚无已确认的本站绑定')
  const owner = assertHostSession().user.id
  const revision = getHostSessionRevision()
  const expected = new Set(session.bindingIds)
  if (expected.size !== session.bindingIds.length) throw new Error('本次授权绑定标识重复，请核对原会话')
  const found = []
  for (let page = 1; ; page++) {
    const result = PublishingAuthorizationPageSchema(PublishingAuthorizationBindingSchema).parse(await read(`?resource=bindings&platform=${session.platform}&page=${page}&pageSize=100`))
    assertHostSession(owner, revision)
    found.push(...result.items.filter(binding => expected.has(binding.id) && binding.platform === session.platform && binding.connectionCurrent && binding.status === 'active'))
    if (page * result.pageSize >= result.total || found.length === expected.size) break
  }
  if (new Set(found.map(binding => binding.id)).size !== expected.size) throw new Error('本次授权完成，但部分绑定尚未读取；请核对原会话')
  return found
}
export async function mutateNativeOAuthBinding(action: Extract<PublishingAuthorizationAction, { action: 'disconnect' | 'move-binding' }>) {
  const owner = assertHostSession().user.id
  const revision = getHostSessionRevision()
  const key = hostStorageKey(`oauth-binding:${action.action}:${action.bindingId}`)!
  const raw = localStorage.getItem(key)
  if (raw) {
    const prior = mutationMarker.parse(JSON.parse(raw))
    const operation = await operationByKey(prior.requestKey)
    assertHostSession(owner, revision)
    if (!operation || operation.bindingId !== action.bindingId || operation.kind !== (action.action === 'disconnect' ? 'disconnect_binding' : 'move_binding') || operation.dispatchState !== 'settled' || !operation.connectionCurrent) throw new Error('原账号操作结果待核对，暂不重复提交')
    localStorage.removeItem(key)
    if (prior.action !== action.action || prior.expectedRevision !== action.expectedRevision || prior.groupId !== (action.action === 'move-binding' ? action.groupId : undefined)) throw new Error('原账号操作已恢复，请重新读取当前账号后再确认新操作')
    return operation
  }
  localStorage.setItem(key, JSON.stringify({ requestKey: action.requestKey, bindingId: action.bindingId, expectedRevision: action.expectedRevision, action: action.action, ...(action.action === 'move-binding' ? { groupId: action.groupId } : {}) }))
  let response: unknown
  try { response = await read('', action) }
  catch (reason) {
    assertHostSession(owner, revision)
    if (definitelyRejected(reason)) localStorage.removeItem(key)
    throw reason
  }
  const result = PublishingAuthorizationMutationSchema.parse(response)
  assertHostSession(owner, revision)
  if (result.operation.requestKey !== action.requestKey || result.operation.bindingId !== action.bindingId || result.operation.kind !== (action.action === 'disconnect' ? 'disconnect_binding' : 'move_binding') || !result.operation.connectionCurrent) throw new Error('原账号操作不匹配，请核对原操作')
  if (result.operation.dispatchState !== 'settled') throw new Error('原账号操作结果待核对，暂不重复提交')
  localStorage.removeItem(key)
  return result.operation
}

/** Clear only an exactly resolved session, after the UI has read every named binding. */
export function finishNativeOAuthSession(session: PublishingAuthorizationSession) {
  if (session.state !== 'completed') return
  const key = storageKey(session.platform)
  if (readMarker(key)?.sessionId === session.id) localStorage.removeItem(key)
}

export async function recoverNativeOAuthBinding(bindingId: string) {
  const owner = assertHostSession().user.id
  const revision = getHostSessionRevision()
  for (const kind of ['move-binding', 'disconnect'] as const) {
    const key = hostStorageKey(`oauth-binding:${kind}:${z.string().uuid().parse(bindingId)}`)!
    const raw = localStorage.getItem(key)
    if (!raw) continue
    let prior: z.infer<typeof mutationMarker>
    try { prior = mutationMarker.parse(JSON.parse(raw)) } catch { throw new Error('原账号操作恢复标记待核对，请保留浏览器数据') }
    const operation = await operationByKey(prior.requestKey)
    assertHostSession(owner, revision)
    if (!operation || operation.bindingId !== bindingId || operation.kind !== (kind === 'disconnect' ? 'disconnect_binding' : 'move_binding') || operation.dispatchState !== 'settled') throw new Error('原账号操作结果尚未确认，请稍后只读核对')
    localStorage.removeItem(key)
  }
}
