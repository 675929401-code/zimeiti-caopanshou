import { z } from 'zod'
import type { IDisplayMessage, IWorkflowStep } from '@/store/agent/agent.types'
import type { NativeAgentPlanningTurn } from '@/api/ai/ai.types'
import { NativeAiStateSchema, NativeAiToolSchema } from '@host-publishing/native-ai-contract'

export const NativeAgentPendingSchema = z.object({ requestKey: z.string().min(8).max(128), taskId: z.string().uuid().optional(), turnId: z.string().uuid().optional() }).strict()
export type NativeAgentPending = z.infer<typeof NativeAgentPendingSchema>
export const NativeAgentEventSchema = z.object({
  type: z.enum(['init', 'keep_alive', 'stream_event', 'assistant', 'user', 'status', 'done', 'error', 'native_tool_proposal', 'native_tool_result']),
  taskId: z.string().uuid().optional(), turnId: z.string().uuid().optional(), uuid: z.string().uuid().optional(), seq: z.number().int().positive().optional(),
  nativeStatus: z.string().max(80).optional(), content: z.string().optional(), message: z.unknown().optional(), code: z.string().optional(),
  nativePlanning: z.boolean().optional(),
}).passthrough()
export type NativeAgentEvent = z.infer<typeof NativeAgentEventSchema>
export const nativeAgentRunning = (state?: string) => ['prepared', 'running', 'streaming', 'cancel_requested'].includes(state || '')
export const nativeAgentResolved = (state?: string) => ['completed', 'failed', 'cancelled'].includes(state || '')
export const nativeAgentCanContinue = (state?: string) => nativeAgentResolved(state)
export function nativeAgentStatusLabel(state?: string) {
  const labels: Record<string, string> = { idle: '尚未开始', prepared: '已登记·等待执行', running: '主站任务运行中', streaming: '正在接收主站回复', cancel_requested: '已请求停止·等待核对', completed: '主站已确认本轮完成', cancelled: '主站已确认取消', failed: '主站已确认失败', unknown: '结果待核对·不会自动重发', awaiting_action: '建议操作等待您逐项确认' }
  return labels[state || ''] || '正在读取主站任务状态'
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const workflowData = z.object({
  proposalId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/u),
  kind: z.enum(['read_draft', 'save_draft']).optional(),
  state: z.string().max(80).optional(),
  executionRef: z.object({ draftId: z.string().uuid().optional(), revision: z.number().int().nonnegative().optional() }).passthrough().optional(),
}).passthrough()
/** Only persisted, sequenced tool events can supply workflow completion or a saved draft ID. */
function workflowAfter(current: IWorkflowStep[], event: NativeAgentEvent): IWorkflowStep[] {
  if (!event.turnId || event.seq === undefined || !['native_tool_proposal', 'native_tool_result'].includes(event.type)) return current
  const parsed = workflowData.safeParse(event.data); if (!parsed.success) return current
  const data = parsed.data, id = 'native-tool:' + event.turnId + ':' + data.proposalId
  const previous = current.find(step => step.id === id)
  if (event.type === 'native_tool_proposal') {
    if (previous || !data.kind || current.length >= 64) return current
    const stamp = typeof event.createdAt === 'string' ? Date.parse(event.createdAt) : 0
    return [...current, { id, type: 'tool_call', toolName: data.kind === 'read_draft' ? '读取草稿' : '保存新草稿',
      content: data.kind === 'read_draft' ? '正在读取您选择的草稿' : '正在保存新草稿', isActive: true, timestamp: Number.isFinite(stamp) ? stamp : 0 }]
  }
  if (!previous || previous.result) return current
  const succeeded = data.state === 'succeeded' || data.state === 'completed'
  const draftId = data.executionRef?.draftId
  let result: string | undefined, content = data.state === 'failed' ? '本次草稿操作未完成，请查看原任务' : '草稿操作结果仍待核对'
  if (succeeded && previous.toolName === '读取草稿') { result = '已读取草稿'; content = result }
  if (succeeded && previous.toolName === '保存新草稿' && draftId) {
    result = '已保存新草稿，草稿编号：' + draftId + (data.executionRef?.revision !== undefined ? '，版本：' + data.executionRef.revision : '')
    content = result
  }
  return current.map(step => step.id === id ? { ...step, content, result, isActive: false } : step)
}
function workflowStepsForHistory(events: unknown[], turnId: string): IWorkflowStep[] {
  let steps: IWorkflowStep[] = []
  const seen = new Set<number>()
  const ordered = events.slice(0, 2000).flatMap(value => { const parsed = NativeAgentEventSchema.safeParse(value); return parsed.success && parsed.data.turnId === turnId && parsed.data.seq !== undefined ? [parsed.data] : [] }).sort((a, b) => a.seq! - b.seq!)
  for (const event of ordered) { if (seen.has(event.seq!)) continue; seen.add(event.seq!); steps = workflowAfter(steps, event) }
  return steps.map(step => ({ ...step, isActive: false }))
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  const message = object(value)
  return Array.isArray(message.content) ? message.content.filter(item => object(item).type === 'text').map(item => String(object(item).text || '')).join('') : ''
}
export const NativeAgentPlanningTurnSchema = z.object({ turnId: z.string().uuid(), actionId: z.string().uuid(), state: NativeAiStateSchema, rawTextHash: z.string().regex(/^[a-f0-9]{64}$/), reply: z.string().max(24000), actionIds: z.array(z.string().uuid()), blockedCandidates: z.array(z.object({ index: z.number().int().nonnegative(), tool: NativeAiToolSchema, reason: z.string().max(1000) }).strict()), parseError: z.string().max(1000) }).strict()
export function nativeAgentHistory(messages: unknown, planningTurns: NativeAgentPlanningTurn[] = [], workflowEvents: unknown[] = []): IDisplayMessage[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((raw, index) => {
    const message = object(raw); if (message.type !== 'user' && message.type !== 'assistant') return []
    const planning = message.type === 'assistant' && typeof message.turnId === 'string' ? planningTurns.find(turn => turn.turnId === message.turnId) : undefined
    const workflowSteps = message.type === 'assistant' && typeof message.turnId === 'string' ? workflowStepsForHistory(workflowEvents, message.turnId) : []
    const text = planning ? planning.reply || planning.parseError || (planning.state === 'succeeded' ? '规划已完成，建议操作将在下方逐项展示。' : '原规划结果仍待核对；尚未执行建议操作。') : typeof message.content === 'string' ? message.content : textOf(message.message)
    if (!text && !workflowSteps.length) return []
    const role = message.type
    const id = typeof message.uuid === 'string' ? message.uuid : 'history:' + index + ':' + role
    return [{ id, role, content: text, status: 'done' as const, ...(workflowSteps.length ? { steps: [{ id: id + ':steps', content: text, workflowSteps, isActive: false }] } : {}), actions: [], publishFlows: [] }]
  })
}
export interface NativeAgentTranscript { base: IDisplayMessage[], prompt: string, requestKey: string, text: string, state: string, lastSeq: number, userId: string, assistantId: string, planning: boolean, workflowSteps: IWorkflowStep[] }
export function createNativeAgentTranscript(base: IDisplayMessage[], prompt: string, requestKey: string, planning = false): NativeAgentTranscript {
  return { base, prompt, requestKey, text: '', state: 'prepared', lastSeq: 0, userId: requestKey + ':user', assistantId: requestKey + ':assistant', planning, workflowSteps: [] }
}
export function reduceNativeAgentTranscript(current: NativeAgentTranscript, event: NativeAgentEvent): NativeAgentTranscript {
  if (event.seq !== undefined && event.seq <= current.lastSeq) return current
  const next = { ...current, lastSeq: event.seq ?? current.lastSeq }
  if (event.nativePlanning) next.planning = true
  if (event.turnId) next.assistantId = event.turnId
  if (event.type === 'user') { if (event.uuid) next.userId = event.uuid }
  if (event.type === 'stream_event') {
    const message = object(event.message), data = object(message.event), delta = object(data.delta)
    if (data.type === 'message_start') next.state = 'running'
    if (data.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') { next.text += delta.text; next.state = 'streaming' }
  }
  if (event.type === 'assistant') next.text = event.content ?? textOf(event.message)
  next.workflowSteps = workflowAfter(current.workflowSteps, event)
  if (event.nativeStatus) next.state = event.nativeStatus
  if (event.type === 'error' && !event.nativeStatus) next.state = 'unknown'
  return next
}
export function nativeAgentTranscriptMessages(value: NativeAgentTranscript): IDisplayMessage[] {
  const running = nativeAgentRunning(value.state)
  const visible = value.planning ? running ? '正在规划内容，完成后将展示可核对的建议操作。' : value.state === 'completed' ? '规划回复已完成，正在读取建议操作。' : nativeAgentStatusLabel(value.state) : value.text
  return [...value.base, { id: value.userId, role: 'user', content: value.prompt, status: 'done', actions: [], publishFlows: [] },
    { id: value.assistantId, role: 'assistant', content: visible, status: running ? value.text ? 'streaming' : 'pending' : value.state === 'completed' ? 'done' : 'error', errorMessage: running || value.state === 'completed' ? undefined : nativeAgentStatusLabel(value.state),
      ...(value.workflowSteps.length ? { steps: [{ id: value.assistantId + ':steps', content: visible, workflowSteps: value.workflowSteps.map(step => ({ ...step, isActive: running && step.isActive })), isActive: running }] } : {}), actions: [], publishFlows: [] }]
}

/** This phase has no server-issued action permit; model text cannot enable actions. */
export function nativeAgentActionsEnabled(): boolean { return false }
