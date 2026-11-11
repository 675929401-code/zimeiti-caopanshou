import { z } from 'zod'
import { PublishingGenericMutationSchema, PublishingStudioStoredDraftSchema, type PublishingGenericMutation } from '@/lib/publishing-generic-contract'
import type { PublishingCashFunding } from '@/lib/publishing-cash-contract'
import { publishingCashGenericContent } from '@/lib/publishing-cash-content'
import { assertStudioCashTarget } from './studio-cash'
import { NativePreparePublishSchema, type NativePreparePublish } from '@/lib/native-operations-contract'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { isDefiniteNativePrepareRejection } from './native-publishing'
import { studioRequest } from './studio-api'

const markerSchema = z.object({ owner: z.string().uuid(), requestKey: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), operationIds: z.array(z.string().uuid()), targetIds: z.array(z.string().uuid()).optional(), draftId: z.string().uuid().optional(), draftVersion: z.number().int().positive().optional(), legacyPending: z.boolean(), legacyPlan: NativePreparePublishSchema.optional() }).strict()
const key = () => hostStorageKey('studio-generic-publish')!
export function readStudioGenericPending() { const value = localStorage.getItem(key()); if (!value) return null; const marker = markerSchema.parse(JSON.parse(value)); if (marker.owner !== assertHostSession().user.id) throw new Error('原通用发布属于其他会员'); return marker }
function write(value: z.infer<typeof markerSchema>) { localStorage.setItem(key(), JSON.stringify(markerSchema.parse(value))) }
function unresolved(result: PublishingGenericMutation) { return result.operations.some(op => ['prepared', 'dispatching', 'unknown'].includes(op.state)) }
function assertReceipt(result: PublishingGenericMutation, expectedOperationIds?: string[]) {
  if (!result.operations.length || !result.targets.length || new Set(result.operations.map(op => op.id)).size !== result.operations.length || new Set(result.targets.map(t => t.id)).size !== result.targets.length) throw new Error('原发布准备回执不完整，请保留原请求标识')
  if (expectedOperationIds && (result.operations.length !== expectedOperationIds.length || result.operations.some(op => !expectedOperationIds.includes(op.id)))) throw new Error('原发布操作集合不匹配')
  const ids = new Set(result.operations.flatMap(op => op.targetIds))
  if (ids.size !== result.targets.length || result.targets.some(t => !ids.has(t.id))) throw new Error('原发布目标回执不完整')
}
export async function prepareStudioGeneric(input: { draftId: string; draftVersion: number; profileRevision: number; targetIds: string[]; contentHash: string; legacyPending: boolean; legacyPlan?: NativePreparePublish }, current: () => void) {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision(), guard = () => { assertHostSession(owner, revision); current() }
  if (readStudioGenericPending()) throw new Error('存在待核对的原通用发布，请先恢复原任务')
  const marker = { owner: assertHostSession().user.id, requestKey: 'studio-publish:' + crypto.randomUUID(), contentHash: input.contentHash, draftId: input.draftId, draftVersion: input.draftVersion, operationIds: [] as string[], targetIds: [...input.targetIds], legacyPending: input.legacyPending, ...(input.legacyPlan ? { legacyPlan: input.legacyPlan } : {}) }
  write(marker); current()
  const { legacyPending: _, legacyPlan: __, ...request } = input; void _; void __
  let result: PublishingGenericMutation
  try { result = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', { action: 'prepare', requestKey: marker.requestKey, ...request })); guard(); assertReceipt(result) }
  catch (reason) {
    if (isDefiniteNativePrepareRejection(reason)) {
      guard(); const found = await studioRequest('publishing/generic?resource=operation&requestKey=' + encodeURIComponent(marker.requestKey)); guard()
      if (found === null && readStudioGenericPending()?.requestKey === marker.requestKey) { localStorage.removeItem(key()); Object.assign(reason as Error, { prepareNotCreated: true }) }
    }
    throw reason
  }
  if (result.targets.length !== input.targetIds.length || result.targets.some(t => !input.targetIds.includes(t.bindingId))) throw new Error('发布目标与最终确认的账号不一致')
  marker.operationIds = result.operations.map(op => op.id); write(marker)
  return result
}
export async function executeStudioGeneric(prepared: PublishingGenericMutation, current: () => void, funding?: PublishingCashFunding) {
  assertReceipt(prepared)
  if (!prepared.operations.some(op => op.state === 'prepared' && !op.grantUsed)) return prepared
  const profile = funding ? await readStudioGenericOriginalDraft(prepared, current) : null
  let result = prepared
  for (const operation of prepared.operations) {
    current()
    if (operation.state !== 'prepared' || operation.grantUsed) continue
    if (funding && profile) for (const id of operation.targetIds) { const target = prepared.targets.find(t => t.id === id), content = profile.profile.targets.find(t => t.accountId === target?.bindingId); if (!target || !content) throw new Error('原官方目标与内容不匹配'); await assertStudioCashTarget(funding, content.accountId, 'generic', publishingCashGenericContent(profile, content)); current() }
    result = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', { action: 'execute', operationId: operation.id, requestKey: operation.requestKey, expectedRevision: operation.revision, snapshotHash: operation.snapshotHash, ...(funding ? { funding } : {}) })); current(); assertReceipt(result, [operation.id])
    if (unresolved(result)) throw new Error('官方发布结果尚待核对，已保留原请求标识，请勿重复提交')
  }
  return result
}
export async function readStudioGenericOriginalDraft(prepared: PublishingGenericMutation, current: () => void) {
  const marker = readStudioGenericPending(), draftId = marker?.draftId ?? prepared.draftId, draftVersion = marker?.draftVersion ?? prepared.draftVersion
  if (!marker || !draftId || !draftVersion) throw new Error('原官方内容版本尚未读取，请联系站方核对原任务；不会换用当前稿件')
  const result = z.object({ id: z.string().uuid(), revision: z.number(), payload: PublishingStudioStoredDraftSchema }).passthrough().parse(await studioRequest(`publishing/generic?resource=profile&draftId=${draftId}&draftVersion=${draftVersion}`)); current()
  if (result.id !== draftId || result.revision !== draftVersion) throw new Error('原发布内容版本不匹配')
  if (!marker.draftId) write({ ...marker, draftId, draftVersion })
  return result.payload
}
/** Reconcile already acquired operations, but leave every unclaimed operation for explicit cash confirmation. */
export async function observeStudioGeneric(current: () => void) {
  const marker = readStudioGenericPending(); if (!marker) return null
  if (marker.legacyPending && !marker.legacyPlan) throw new Error('原混合发布缺少剩余账号的确认快照，请联系站方核对原任务；不会改用当前稿件')
  const found = await studioRequest('publishing/generic?resource=operation&requestKey=' + encodeURIComponent(marker.requestKey)); current()
  if (!found) throw new Error('原发布准备尚未查明，不会另建任务')
  const result = PublishingGenericMutationSchema.parse(found); assertReceipt(result, marker.operationIds.length ? marker.operationIds : undefined)
  if (marker.targetIds && (result.targets.length !== marker.targetIds.length || result.targets.some(t => !marker.targetIds!.includes(t.bindingId)))) throw new Error('原发布目标集合不匹配')
  for (const op of [...result.operations]) {
    if (op.state === 'prepared' && !op.grantUsed || ['succeeded', 'partial', 'failed_known', 'blocked'].includes(op.state)) continue
    const observed = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', { action: 'reconcile', operationId: op.id, expectedRevision: op.revision })); current(); assertReceipt(observed, [op.id])
    if (unresolved(observed)) throw new Error('原官方结果仍待核对，不会重新扣款或发布')
    result.operations = result.operations.map(value => observed.operations.find(next => next.id === value.id) || value)
    result.targets = result.targets.map(value => observed.targets.find(next => next.id === value.id) || value)
  }
  const ids = new Set(result.operations.filter(op => op.state === 'prepared' && !op.grantUsed).flatMap(op => op.targetIds))
  return { prepared: result, remainingIds: result.targets.filter(t => ids.has(t.id)).map(t => t.bindingId), legacyPlan: marker.legacyPending ? marker.legacyPlan : undefined }
}
export function completeStudioGeneric() { if (readStudioGenericPending()) localStorage.removeItem(key()) }
/** Resume only the original confirmed operations; consumed/unknown grants are never resent. */
export async function recoverStudioGeneric(current: () => void): Promise<NativePreparePublish | undefined> {
  const marker = readStudioGenericPending(); if (!marker) return
  const found = await studioRequest('publishing/generic?resource=operation&requestKey=' + encodeURIComponent(marker.requestKey)); current()
  if (!found) throw new Error('原准备结果尚未确认，不会另建发布任务')
  const result = PublishingGenericMutationSchema.parse(found); assertReceipt(result, marker.operationIds.length ? marker.operationIds : undefined)
  if (marker.targetIds && (result.targets.length !== marker.targetIds.length || result.targets.some(t => !marker.targetIds!.includes(t.bindingId)))) throw new Error('原发布目标集合与保存标记不一致')
  for (const op of result.operations) {
    if (['succeeded', 'blocked', 'failed_known'].includes(op.state)) continue
    const action = op.state === 'prepared' && !op.grantUsed ? { action: 'execute', operationId: op.id, requestKey: op.requestKey, expectedRevision: op.revision, snapshotHash: op.snapshotHash } : { action: 'reconcile', operationId: op.id, expectedRevision: op.revision }
    const observed = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', action)); current(); assertReceipt(observed, [op.id])
    if (unresolved(observed)) throw new Error('原官方结果仍然未知，请继续核对原记录')
  }
  if (marker.legacyPending) { if (!marker.legacyPlan) throw new Error('此旧混合提交缺少原剩余目标快照，请联系管理员核对，不会从当前编辑重建'); return marker.legacyPlan }
  completeStudioGeneric()
}
