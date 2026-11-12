/** Main-site session projection. No upstream login token or credential is represented here. */
import { NativeHostSessionSchema, type NativeHostSession } from '@host-publishing/native-operations-contract'
export type { NativeHostSession }

export const NATIVE_BASE_PATH = '/publish-center/native'
export const NATIVE_API_PATH = '/api/native-operations'
let current: NativeHostSession | null = null
let revision = 0
let bootstrap: Promise<NativeHostSession> | null = null
const listeners = new Set<() => void>()
const requests = new Set<AbortController>()
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function parseSession(value: unknown): NativeHostSession {
  const result = NativeHostSessionSchema.safeParse(value)
  if (!result.success) throw new Error('主站会话投影格式待核对')
  return result.data
}

export const getHostSession = () => current
export const getHostSessionRevision = () => revision
export const hostStorageKey = (key: string) => current ? `aitoearn-native.v1:${current.user.id}:${key}` : null
export function subscribeHostSession(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function clearHostSession() { current = null; revision++; bootstrap = null; for (const controller of requests) controller.abort(); requests.clear(); for (const listener of listeners) listener() }
export function trackHostRequest(controller: AbortController) { requests.add(controller); return () => { requests.delete(controller) } }
export function assertHostSession(expectedOwner?: string, expectedRevision?: number) { if (!current || expectedOwner && current.user.id !== expectedOwner || expectedRevision !== undefined && revision !== expectedRevision) throw new Error('主站登录身份已变化，已停止操作，请重新进入并核对原任务'); return current }

export async function loadHostSession(): Promise<NativeHostSession> {
  if (bootstrap) return bootstrap
  const generation = revision
  const request = (async () => {
    const response = await fetch(`${NATIVE_API_PATH}/session`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, redirect: 'error' })
    if (generation !== revision) throw new Error('原登录会话已失效，已忽略旧会话响应')
    if (response.status === 401 || response.status === 403) { clearHostSession(); throw new Error('主站登录已过期或无此功能权限，请回到主站核对') }
    if (!response.ok) throw new Error('主站会话暂不可读取，请稍后重试')
    const envelope: unknown = await response.json()
    if (generation !== revision) throw new Error('原登录会话已失效，已忽略旧会话响应')
    if (!record(envelope) || envelope.code !== 0) throw new Error('主站会话尚未就绪')
    const next = parseSession(envelope.data)
    if (current && current.user.id !== next.user.id) { clearHostSession(); if (typeof window !== 'undefined') window.location.reload(); throw new Error('检测到主站账号切换，正在清空原会话并重新进入') }
    if (current && current.csrfToken !== next.csrfToken) { clearHostSession(); if (typeof window !== 'undefined') window.location.reload(); throw new Error('主站会话或权限已更新，已停止旧请求并重新进入工作台') }
    current = next
    for (const listener of listeners) listener()
    return next
  })()
  bootstrap = request
  void request.finally(() => { if (bootstrap === request) bootstrap = null }).catch(() => {})
  return request
}

export function hostAssetPath(value: string) {
  if (value.startsWith(`${NATIVE_BASE_PATH}/`)) return value
  return /^\/(?:assets|images|favicon)(?:\/|\.)/.test(value) ? `${NATIVE_BASE_PATH}${value}` : value
}

export function navigateToHostLogin() {
  if (typeof window === 'undefined') return
  const destination = new URL('/', window.location.origin)
  destination.searchParams.set('login', '1')
  destination.searchParams.set('returnTo', `${NATIVE_BASE_PATH}/zh-CN`)
  window.location.assign(destination.href)
}
