import { observeNativeRevisions, nativeExpectedRevisions } from './native-revisions'
import { z } from 'zod'
import { NativeAgentMemberStartSchema, type NativeAgentMemberStart } from '@host-publishing/native-agent-contract'
import { NativeAiActionDtoSchema } from '@host-publishing/native-ai-contract'
import type { TaskDetail } from '@/api/ai/ai.types'
import { nativeBffFetch } from './host-transport'
import { assertHostSession, getHostSessionRevision, hostStorageKey, subscribeHostSession } from './host-session'
import { NativeAgentEventSchema, NativeAgentPendingSchema, NativeAgentPlanningTurnSchema, nativeAgentResolved, type NativeAgentEvent, type NativeAgentPending } from './native-agent-protocol'

const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())
export function subscribeNativeAgentPending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
subscribeHostSession(changed)
export function readNativeAgentPending(): NativeAgentPending | null {
  const key = hostStorageKey('agent-pending'); if (!key || typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(key); if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('原任务恢复标记待核对，请保留浏览器记录') }
  const parsed = NativeAgentPendingSchema.safeParse(value)
  if (!parsed.success) throw new Error('原任务恢复标记待核对，请保留浏览器记录')
  return parsed.data
}
function savePending(value: NativeAgentPending | null) {
  const key = hostStorageKey('agent-pending'); if (!key) throw new Error('主站会话已停止')
  if (value) localStorage.setItem(key, JSON.stringify(NativeAgentPendingSchema.parse(value))); else localStorage.removeItem(key)
  changed()
}
async function data<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const actor = assertHostSession().user.id, revision = getHostSessionRevision()
  const response = await nativeBffFetch(path, { method, cache: 'no-store', ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
  const result: unknown = await response.json(); assertHostSession(actor, revision)
  const envelope = z.object({ code: z.union([z.literal(0), z.string()]), data: z.unknown(), message: z.string() }).passthrough().parse(result)
  if (!response.ok || envelope.code !== 0) throw new Error(envelope.message || '主站任务操作尚未确认，请读取原记录')
  return envelope.data as T
}
export async function readNativeAgentTask(id: string): Promise<TaskDetail> {
  const actor = assertHostSession().user.id, revision = getHostSessionRevision()
  z.string().uuid().parse(id)
  const value = await data<TaskDetail>('agent/tasks/' + id)
  if (!value || value.id !== id || value.userId !== actor || !Number.isSafeInteger(value.nativeRevision) || typeof value.nativeStatus !== 'string') throw new Error('主站任务记录格式待核对')
  if (value.nativeActions !== undefined) value.nativeActions = z.array(NativeAiActionDtoSchema).parse(value.nativeActions)
  if (value.nativePlanningTurns !== undefined) value.nativePlanningTurns = z.array(NativeAgentPlanningTurnSchema).parse(value.nativePlanningTurns)
  if (value.nativeWorkflowEvents !== undefined) {
    value.nativeWorkflowEvents = z.array(NativeAgentEventSchema).max(2000).parse(value.nativeWorkflowEvents)
    if (value.nativeWorkflowEvents.some(event => (event as NativeAgentEvent).taskId !== id || !(event as NativeAgentEvent).turnId)) throw new Error('草稿操作记录与原任务不一致，请重新查看原任务')
  }
  assertHostSession(actor, revision)
  observeNativeRevisions(value)
  const pending = readNativeAgentPending(); if (pending?.taskId === id && nativeAgentResolved(value.nativeStatus)) savePending(null)
  return new Proxy(value, { get(target, key, receiver) { assertHostSession(actor, revision); return Reflect.get(target, key, receiver) } })
}
export async function editNativeAgentTask(id: string, method: 'POST' | 'PATCH' | 'DELETE', suffix: string, payload: object, expectedRevision?: number) {
  const actor = assertHostSession().user.id, ownerRevision = getHostSessionRevision()
  expectedRevision ??= nativeExpectedRevisions(id).expectedRevision
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision! <= 0) throw new Error('任务读取时版本缺失，请先核对原记录')
  const task = await data<TaskDetail>('agent/tasks/' + z.string().uuid().parse(id) + suffix, method, { ...payload, expectedRevision })
  assertHostSession(actor, ownerRevision)
  return { code: 0 as const, get data() { assertHostSession(actor, ownerRevision); return task }, message: '', url: '' }
}
export async function recoverNativeAgentPending() {
  const pending = readNativeAgentPending(); if (!pending) return null
  const lookup = z.object({ taskId: z.string().uuid(), turn: z.object({ id: z.string().uuid(), taskId: z.string().uuid(), state: z.string(), revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string() }).passthrough() }).nullable()
    .parse(await data<unknown>('agent/turns?requestKey=' + encodeURIComponent(pending.requestKey)))
  if (!lookup) return { found: false as const, task: null }
  const task = await readNativeAgentTask(lookup.taskId)
  if (nativeAgentResolved(lookup.turn.state)) savePending(null)
  else savePending({ requestKey: pending.requestKey, taskId: lookup.taskId, turnId: lookup.turn.id })
  return { found: true as const, task }
}
export interface NativeAgentStreamCallbacks { afterSeq?: number, expectedTaskId?: string, expectedTurnId?: string, planningMode?: boolean, onEvent: (event: NativeAgentEvent) => void, onUnknown: (message: string) => void, onTaskId: (taskId: string) => void }
async function consume(response: Response, callbacks: NativeAgentStreamCallbacks, actor: string, revision: number, requestKey?: string) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('主站任务流未就绪，请读取原任务')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', resolved = false, state = 'running', currentTurn = callbacks.expectedTurnId
  try {
    while (true) {
      const chunk = await reader.read(); assertHostSession(actor, revision)
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length > 1024 * 1024) throw new Error('任务流数据格式待核对')
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length)
        const raw = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!raw) continue
        const event = NativeAgentEventSchema.parse(JSON.parse(raw)); assertHostSession(actor, revision)
        if (callbacks.expectedTaskId && event.taskId && event.taskId !== callbacks.expectedTaskId) throw new Error('原任务流身份不一致，请读取原记录')
        if (event.seq !== undefined && event.seq <= (callbacks.afterSeq ?? 0)) continue
        if (event.turnId) { if (currentTurn && currentTurn !== event.turnId) continue; currentTurn = event.turnId }
        if (event.taskId) {
          if (requestKey) savePending({ requestKey, taskId: event.taskId, ...(event.turnId ? { turnId: event.turnId } : {}) })
          callbacks.onTaskId(event.taskId)
        }
        if (event.nativeStatus) state = event.nativeStatus
        callbacks.onEvent(callbacks.planningMode ? { ...event, nativePlanning: true } : event)
        if (nativeAgentResolved(state)) { resolved = true; if (requestKey) savePending(null); return }
      }
    }
    if (!resolved) callbacks.onUnknown('连接已结束，原任务结果仍待核对；不会自动重发')
  } finally { await reader.cancel().catch(() => {}) }
}
export async function submitNativeAgentTurn(raw: NativeAgentMemberStart, callbacks: NativeAgentStreamCallbacks) {
  const input = NativeAgentMemberStartSchema.parse(raw), actor = assertHostSession().user.id, revision = getHostSessionRevision()
  if (readNativeAgentPending()) throw new Error('存在待核对原任务，请先读取原任务结果')
  savePending({ requestKey: input.requestKey })
  const controller = new AbortController()
  let acknowledge!: (id: string) => void, rejectAck!: (error: Error) => void
  const acknowledged = new Promise<string>((resolve, reject) => { acknowledge = resolve; rejectAck = reject })
  let acked = false
  const wrapped = { ...callbacks, planningMode: false, onTaskId(id: string) { if (!acked) { acked = true; acknowledge(id); callbacks.onTaskId(id) } } }
  const completion = (async () => {
    try {
      const response = await nativeBffFetch('agent/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal })
      assertHostSession(actor, revision)
      if (!response.ok) {
        if (response.status === 400 || response.status === 403) { await response.text(); assertHostSession(actor, revision); savePending(null) }
        if (response.status !== 400 && response.status !== 403) await response.body?.cancel()
        throw new Error('主站未确认本轮执行（HTTP ' + response.status + '），请核对原任务')
      }
      await consume(response, wrapped, actor, revision, input.requestKey)
    } catch (error) {
      try { assertHostSession(actor, revision) } catch { return }
      const message = error instanceof Error ? error.message : '原任务连接待核对'
      if (!acked) rejectAck(new Error(message)); callbacks.onUnknown(message)
    } finally { if (!acked) rejectAck(new Error('未取得任务确认，请使用原请求标识核对')) }
  })()
  const timeout = setTimeout(() => { if (!acked) rejectAck(new Error('任务确认暂未返回，请读取原请求，不会自动重发')) }, 15000)
  void acknowledged.finally(() => clearTimeout(timeout)).catch(() => {})
  return { abort: () => controller.abort(), acknowledged, completion }
}
export async function replayNativeAgentTask(taskId: string, afterSeq: number, callbacks: NativeAgentStreamCallbacks, signal?: AbortSignal) {
  const actor = assertHostSession().user.id, revision = getHostSessionRevision()
  const response = await nativeBffFetch('agent/tasks/' + z.string().uuid().parse(taskId) + '/stream?afterSeq=' + Math.max(0, Math.floor(afterSeq)), { cache: 'no-store', signal })
  await consume(response, callbacks, actor, revision)
}
