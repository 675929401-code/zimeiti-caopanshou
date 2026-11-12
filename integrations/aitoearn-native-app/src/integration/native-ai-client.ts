import { z } from 'zod'
import {
  NativeAiActionDtoSchema, NativeAiBatchDtoSchema, NativeAiBatchResultSchema, NativeAiBatchSnapshotSchema, NativeAiDecimal6Schema,
  NativeAiItemDtoSchema, nativeAiHash, type NativeAiActionDto, type NativeAiBatchResult, type NativeAiBatchSnapshot,
} from '@host-publishing/native-ai-contract'
import { assertHostSession, getHostSessionRevision, hostStorageKey, subscribeHostSession } from './host-session'
import { nativeBffFetch } from './host-transport'
import { NativeAgentPlanningTurnSchema } from './native-agent-protocol'

export type { NativeAiActionDto, NativeAiBatchSnapshot }
type PendingKind = 'prepare_action' | 'action_decision' | 'action_dispatch' | 'action_reconcile' | 'prepare_batch' | 'batch_decision' | 'batch_advance' | 'batch_reconcile' | 'plan_advance'
const pendingSchema = z.object({
  operation: z.string().min(1).max(240), kind: z.enum(['prepare_action', 'action_decision', 'action_dispatch', 'action_reconcile', 'prepare_batch', 'batch_decision', 'batch_advance', 'batch_reconcile', 'plan_advance']),
  requestKey: z.string().min(8).max(128), bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  actionId: z.string().uuid().optional(), batchId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(),
}).strict()
export type NativeAiPending = z.infer<typeof pendingSchema>
const envelopeSchema = z.object({ code: z.union([z.literal(0), z.string()]), data: z.unknown(), message: z.string() }).passthrough()
const id = z.string().uuid()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())
subscribeHostSession(changed)
export function subscribeNativeAiPending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

export class NativeAiClientError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message) }
}
export interface NativeAiClientDependencies {
  actor(): { owner: string, revision: number }
  assert(owner: string, revision: number): void
  storage(): Storage | undefined
  storageKey(key: string): string | null
  fetch(resource: string, options?: RequestInit): Promise<Response>
  randomId(): string
  changed(): void
}
const defaults: NativeAiClientDependencies = {
  actor: () => ({ owner: assertHostSession().user.id, revision: getHostSessionRevision() }),
  assert: (owner, revision) => { assertHostSession(owner, revision) },
  storage: () => typeof localStorage === 'undefined' ? undefined : localStorage,
  storageKey: hostStorageKey, fetch: nativeBffFetch, randomId: () => crypto.randomUUID(), changed,
}
function projection(value: unknown) {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const items = Array.isArray(raw.items) ? raw.items.map(item => {
    const row = item as Record<string, unknown>
    return NativeAiItemDtoSchema.parse(Object.fromEntries(Object.keys(NativeAiItemDtoSchema.shape).map(key => [key, row[key]])))
  }) : raw.items
  const result = NativeAiBatchResultSchema.parse({ batch: raw.batch, items, actions: raw.actions })
  return nativeAiBatchWorkflow(result)
}
export function nativeAiBatchWorkflow(result: NativeAiBatchResult) {
  const items = result.items.map(item => {
    const actions = result.actions.filter(action => item.actionIds.includes(action.id))
    const draft = actions.find(action => action.kind === 'save_draft' && action.state === 'succeeded')?.slots.flatMap(slot => slot.receipt?.resultRefs ?? []).find(ref => ref.kind === 'draft')
    return { ...item, draftId: draft?.id ?? null, workflowComplete: !!draft, requiresConfirmation: actions.some(action => action.state === 'proposed') }
  })
  const workflowComplete = items.every(item => item.workflowComplete)
  return { ...result, items, workflowComplete, status: workflowComplete ? 'completed' : result.batch.state === 'succeeded' ? 'requires_action' : result.batch.state }
}
export type NativeAiBatchProjection = ReturnType<typeof nativeAiBatchWorkflow>
const planningProjection = z.object({ id, nativePlanningTurns: z.array(NativeAgentPlanningTurnSchema), nativeActions: z.array(NativeAiActionDtoSchema) })
export type NativeAiPlanProjection = z.infer<typeof planningProjection>
const definitelyRejected = (error: unknown) => error instanceof NativeAiClientError && [400, 403, 409].includes(error.status) && ['NATIVE_AI_INPUT_INVALID', 'NATIVE_AI_RESOURCE_CHANGED', 'NATIVE_AI_RESOURCE_SCOPE_INVALID', 'NATIVE_AI_REVISION_CONFLICT', 'NATIVE_AI_QUOTE_EXPIRED', 'NATIVE_AI_BUDGET_EXCEEDED', 'NATIVE_CSRF_REJECTED', 'NATIVE_ACTOR_CHANGED', 'PUBLISH_ACCESS_DENIED'].includes(error.code)

/** Durable markers are owner-scoped and written before every POST. Recovery is GET only. */
export function createNativeAiClient(overrides: Partial<NativeAiClientDependencies> = {}) {
  const deps = { ...defaults, ...overrides }
  function pending(): NativeAiPending[] {
    const key = deps.storageKey('ai-pending'), storage = deps.storage()
    if (!key || !storage) return []
    const raw = storage.getItem(key)
    if (!raw) return []
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('原AI操作恢复记录待核对，请保留浏览器数据') }
    return z.array(pendingSchema).max(100).parse(parsed)
  }
  function store(records: NativeAiPending[]) {
    const key = deps.storageKey('ai-pending'), storage = deps.storage()
    if (!key || !storage) throw new Error('无法保存原操作恢复标识，尚未发送请求')
    storage.setItem(key, JSON.stringify(records)); deps.changed()
  }
  function clear(record: NativeAiPending) { store(pending().filter(item => item.requestKey !== record.requestKey)) }
  async function read(path: string, method = 'GET', body?: unknown) {
    const actor = deps.actor()
    const response = await deps.fetch(path, { method, cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const envelope = envelopeSchema.parse(await response.json()); deps.assert(actor.owner, actor.revision)
    if (!response.ok || envelope.code !== 0) throw new NativeAiClientError(envelope.message || '原AI操作尚未确认，请读取原记录', String(envelope.code), response.status)
    return envelope.data
  }
  async function mutate<T>(operation: string, kind: PendingKind, path: string, body: Record<string, unknown>, parse: (value: unknown) => T, identity: Pick<NativeAiPending, 'actionId' | 'batchId' | 'taskId' | 'expectedRevision'> = {}): Promise<T> {
    const actor = deps.actor(), bodyHash = await nativeAiHash(body); deps.assert(actor.owner, actor.revision)
    const records = pending()
    if (records.some(item => item.operation === operation)) throw new Error('存在待核对的原操作，请先读取原记录；不会自动重发')
    const marker = pendingSchema.parse({ operation, kind, requestKey: `native-ai:${deps.randomId()}`, bodyHash, ...identity })
    store([...records, marker]); deps.assert(actor.owner, actor.revision)
    try {
      const result = parse(await read(path, 'POST', { ...body, requestKey: marker.requestKey }))
      deps.assert(actor.owner, actor.revision); clear(marker)
      return result
    } catch (error) {
      deps.assert(actor.owner, actor.revision)
      if (definitelyRejected(error)) clear(marker)
      throw error
    }
  }
  const actionResult = (value: unknown) => NativeAiActionDtoSchema.parse(z.object({ action: NativeAiActionDtoSchema }).parse(value).action)
  const readAction = async (actionId: string) => actionResult(await read(`ai/actions/${id.parse(actionId)}`))
  const readBatch = async (batchId: string) => projection(await read(`ai/batches/${id.parse(batchId)}`))
  async function recover(marker: NativeAiPending): Promise<NativeAiActionDto | NativeAiBatchProjection | NativeAiPlanProjection | null> {
    const actor = deps.actor()
    let result: NativeAiActionDto | NativeAiBatchProjection | NativeAiPlanProjection | null = null
    if (marker.kind === 'prepare_action') {
      const value = z.object({ action: NativeAiActionDtoSchema.nullable() }).parse(await read(`ai/actions?requestKey=${encodeURIComponent(marker.requestKey)}`))
      result = value.action
    } else if (marker.kind === 'prepare_batch') {
      const value = await read(`ai/batches?requestKey=${encodeURIComponent(marker.requestKey)}`)
      result = value === null ? null : projection(value)
    } else if (marker.actionId) {
      const action = await readAction(marker.actionId)
      if (marker.kind === 'action_reconcile' || action.state !== 'proposed' && marker.kind === 'action_decision' || action.slots.some(slot => slot.dispatchId !== null) && marker.kind === 'action_dispatch') result = action
    } else if (marker.batchId) {
      const batch = await readBatch(marker.batchId)
      if (marker.kind !== 'batch_decision' || marker.expectedRevision !== undefined && batch.batch.revision > marker.expectedRevision) result = batch
    } else if (marker.kind === 'plan_advance' && marker.taskId) {
      const task = planningProjection.parse(await read(`agent/tasks/${id.parse(marker.taskId)}`))
      if (task.id !== marker.taskId) throw new Error('原规划任务身份待核对')
      if (task.nativePlanningTurns.some(turn => turn.state === 'succeeded')) result = task
    }
    deps.assert(actor.owner, actor.revision)
    if (result) clear(marker)
    return result
  }
  return {
    pending, recover, readAction, readBatch,
    async taskActions(taskId: string, page = 1) {
      return z.object({ items: z.array(NativeAiActionDtoSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() }).parse(await read(`ai/actions?taskId=${id.parse(taskId)}&page=${page}&pageSize=30`))
    },
    async batches(page = 1) {
      return z.object({ items: z.array(NativeAiBatchDtoSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() }).parse(await read(`ai/batches?page=${page}&pageSize=20`))
    },
    async plannerModels() {
      return z.array(z.object({ nativeModelId: z.string().optional(), name: z.string(), displayName: z.string().optional(), generationReady: z.boolean().optional(), nativeReason: z.string().optional() }).passthrough()).parse(await read('ai/models/chat?scene=web'))
    },
    async prepareBatch(snapshot: NativeAiBatchSnapshot) {
      const checked = NativeAiBatchSnapshotSchema.parse(snapshot)
      return mutate(`prepare-batch:${await nativeAiHash(checked)}`, 'prepare_batch', 'ai/batches', { snapshot: checked }, projection)
    },
    decideAction(action: NativeAiActionDto, decision: 'approve' | 'reject') {
      return mutate(`decision:${action.id}`, 'action_decision', `ai/actions/${id.parse(action.id)}/decision`, { proposalId: action.id, expectedRevision: action.revision, decision }, actionResult, { actionId: action.id, expectedRevision: action.revision })
    },
    dispatchAction(action: NativeAiActionDto) {
      return mutate(`dispatch:${action.id}`, 'action_dispatch', `ai/actions/${id.parse(action.id)}/dispatch`, { expectedRevision: action.revision }, actionResult, { actionId: action.id, expectedRevision: action.revision })
    },
    reconcileAction(action: NativeAiActionDto) {
      return mutate(`reconcile:${action.id}`, 'action_reconcile', `ai/actions/${id.parse(action.id)}/reconcile`, {}, actionResult, { actionId: action.id })
    },
    decideBatch(batch: NativeAiBatchProjection, decision: 'approve' | 'reject') {
      return mutate(`batch-decision:${batch.batch.id}`, 'batch_decision', `ai/batches/${id.parse(batch.batch.id)}/decision`, { expectedRevision: batch.batch.revision, manifestHash: batch.batch.manifestHash, decision }, projection, { batchId: batch.batch.id, expectedRevision: batch.batch.revision })
    },
    advanceBatch(batchId: string) { return mutate(`batch-advance:${batchId}`, 'batch_advance', `ai/batches/${id.parse(batchId)}/advance`, {}, projection, { batchId }) },
    reconcileBatch(batchId: string) { return mutate(`batch-reconcile:${batchId}`, 'batch_reconcile', `ai/batches/${id.parse(batchId)}/reconcile`, {}, projection, { batchId }) },
    async advancePlan(taskId: string) { return mutate(`plan-advance:${taskId}`, 'plan_advance', `agent/tasks/${id.parse(taskId)}/plan-advance`, {}, value => value, { taskId }) },
  }
}
export const nativeAiClient = createNativeAiClient()
export function nativePlanningSettings() {
  const key = hostStorageKey('ai-planning'), raw = key && typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  if (!raw) return { enabled: false, maxCredits: '' }
  try { return z.object({ enabled: z.boolean(), maxCredits: z.string().max(32) }).strict().parse(JSON.parse(raw)) } catch { return { enabled: false, maxCredits: '' } }
}
export function saveNativePlanningSettings(value: { enabled: boolean, maxCredits: string }) {
  assertHostSession()
  const key = hostStorageKey('ai-planning'); if (!key) throw new Error('主站会话已停止')
  localStorage.setItem(key, JSON.stringify(value)); changed()
}
export function nativePlanningBudget() { return NativeAiDecimal6Schema.parse(nativePlanningSettings().maxCredits) }
