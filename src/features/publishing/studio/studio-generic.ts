import { z } from 'zod'
import { PublishingGenericMutationSchema, PublishingStudioStoredDraftSchema, type PublishingGenericMutation } from '@/lib/publishing-generic-contract'
import type { PublishingCashFunding } from '@/lib/publishing-cash-contract'
import { publishingCashGenericContent } from '@/lib/publishing-cash-content'
import { assertStudioCashTarget } from './studio-cash'
import { NativePreparePublishSchema, type NativePreparePublish } from '@/lib/native-operations-contract'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { isDefiniteNativePrepareRejection } from './native-publishing'
import { studioRequest } from './studio-api'

const batchSchema = z.object({
  requestKey: z.string(), operationIds: z.array(z.string().uuid()), targetIds: z.array(z.string().uuid()).optional(),
  draftId: z.string().uuid().optional(), draftVersion: z.number().int().positive().optional(), profileRevision: z.number().int().positive().optional(),
}).strict()
const markerSchema = z.object({
  owner: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  legacyPending: z.boolean(), legacyPlan: NativePreparePublishSchema.optional(),
}).strict()
const currentSchema = markerSchema.extend({ batches: z.array(batchSchema).min(1).max(2) })
const originalSchema = markerSchema.extend(batchSchema.shape)
type Marker = z.infer<typeof currentSchema>
type Batch = z.infer<typeof batchSchema>
type ProfileInput = { draftId: string; draftVersion: number; profileRevision: number; targetIds: string[] }
const key = () => hostStorageKey('studio-generic-publish')!

export function readStudioGenericPending(): Marker | null {
  const raw = localStorage.getItem(key())
  if (!raw) return null
  const stored = z.union([currentSchema, originalSchema]).parse(JSON.parse(raw))
  if (stored.owner !== assertHostSession().user.id) throw new Error('原通用发布属于其他会员')
  if ('batches' in stored) return stored
  const { owner, contentHash, legacyPending, legacyPlan, ...batch } = stored
  return { owner, contentHash, legacyPending, legacyPlan, batches: [batch] }
}

function write(value: Marker) { localStorage.setItem(key(), JSON.stringify(currentSchema.parse(value))) }

function assertReceipt(result: PublishingGenericMutation, expectedOperationIds?: string[]) {
  const operations = new Map(result.operations.map(operation => [operation.id, operation]))
  if (!operations.size || !result.targets.length || operations.size !== result.operations.length || new Set(result.targets.map(target => target.id)).size !== result.targets.length) {
    throw new Error('原发布准备回执不完整，请保留原请求标识')
  }
  if (expectedOperationIds && (operations.size !== expectedOperationIds.length || expectedOperationIds.some(id => !operations.has(id)))) {
    throw new Error('原发布操作集合不匹配')
  }
  const ids = result.operations.flatMap(operation => operation.targetIds)
  if (ids.length !== result.targets.length || new Set(ids).size !== ids.length || result.targets.some(target => !operations.get(target.operationId)?.targetIds.includes(target.id))) {
    throw new Error('原发布目标回执不完整')
  }
}

function assertBatch(batch: Batch, result: PublishingGenericMutation) {
  assertReceipt(result, batch.operationIds.length ? batch.operationIds : undefined)
  const bindings = new Set(result.targets.map(target => target.bindingId))
  if (batch.targetIds && (result.targets.length !== batch.targetIds.length || batch.targetIds.some(id => !bindings.has(id)))) throw new Error('发布目标与最终确认的账号不一致')
  if (batch.draftId && result.draftId !== batch.draftId || batch.draftVersion && result.draftVersion !== batch.draftVersion || batch.profileRevision && result.profileRevision !== batch.profileRevision) {
    throw new Error('原发布回执与已确认的稿件版本不一致')
  }
}

async function lookupBatch(batch: Batch, current: () => void) {
  const value = await studioRequest('publishing/generic?resource=operation&requestKey=' + encodeURIComponent(batch.requestKey)); current()
  if (value === null) return null
  const result = PublishingGenericMutationSchema.parse(value)
  assertBatch(batch, result)
  return result
}

async function prepareBatch(marker: Marker, batch: Batch, current: () => void) {
  const { draftId, draftVersion, profileRevision, targetIds, requestKey } = batch
  if (!draftId || !draftVersion || !profileRevision || !targetIds?.length || batch.operationIds.length) throw new Error('原发布准备尚未查明，请保留原请求标识')
  const request = { action: 'prepare', requestKey, draftId, draftVersion, profileRevision, targetIds, contentHash: marker.contentHash }
  const result = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', request)); current()
  assertBatch(batch, result)
  batch.operationIds = result.operations.map(operation => operation.id)
  write(marker)
  return result
}

export async function prepareStudioGeneric(profiles: ProfileInput[], contentHash: string, legacyPlan: NativePreparePublish | undefined, current: () => void) {
  if (readStudioGenericPending()) throw new Error('存在待核对的原通用发布，请先恢复原任务')
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  const guard = () => { assertHostSession(owner, revision); current() }
  const marker: Marker = {
    owner, contentHash, legacyPending: !!legacyPlan, legacyPlan,
    batches: profiles.map(profile => ({ ...profile, requestKey: 'studio-publish:' + crypto.randomUUID(), operationIds: [] })),
  }
  guard(); write(marker)
  const results: PublishingGenericMutation[] = []
  for (const batch of marker.batches) {
    try { results.push(await prepareBatch(marker, batch, guard)) }
    catch (reason) {
      if (marker.batches.length === 1 && isDefiniteNativePrepareRejection(reason)) {
        guard()
        const found = await lookupBatch(batch, guard)
        if (found === null && readStudioGenericPending()?.batches[0]?.requestKey === batch.requestKey) {
          localStorage.removeItem(key())
          Object.assign(reason as Error, { prepareNotCreated: true })
        }
      }
      throw reason
    }
  }
  return results
}

function unresolved(result: PublishingGenericMutation) {
  return result.operations.some(operation => ['prepared', 'dispatching', 'unknown'].includes(operation.state))
}

function mergeResult(batch: PublishingGenericMutation, update: PublishingGenericMutation) {
  batch.operations = batch.operations.map(operation => update.operations.find(next => next.id === operation.id) || operation)
  batch.targets = batch.targets.map(target => update.targets.find(next => next.id === target.id) || target)
}

export async function executeStudioGeneric(batches: PublishingGenericMutation[], current: () => void, funding: PublishingCashFunding) {
  const profiles = new Set<PublishingGenericMutation>()
  for (const batch of batches) {
    assertReceipt(batch)
    const operations = batch.operations.filter(operation => operation.state === 'prepared' && !operation.grantUsed)
    if (!operations.length) continue
    const profile = await readStudioGenericOriginalDraft(batch, current)
    profiles.add(batch)
    for (const operation of operations) for (const id of operation.targetIds) {
      const target = batch.targets.find(value => value.id === id)
      const content = profile.profile.targets.find(value => value.accountId === target?.bindingId)
      if (!target || !content) throw new Error('原官方目标与内容不匹配')
      await assertStudioCashTarget(funding, content.accountId, 'generic', publishingCashGenericContent(profile, content)); current()
    }
  }
  for (const batch of profiles) {
    for (const operation of batch.operations) {
      current()
      if (operation.state !== 'prepared' || operation.grantUsed) continue
      const result = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', {
        action: 'execute', operationId: operation.id, requestKey: operation.requestKey, expectedRevision: operation.revision, snapshotHash: operation.snapshotHash, funding,
      })); current()
      assertReceipt(result, [operation.id])
      if (unresolved(result)) throw new Error('官方发布结果尚待核对，已保留原请求标识')
      mergeResult(batch, result)
    }
  }
  return batches.flatMap(batch => batch.targets)
}

export async function readStudioGenericOriginalDraft(prepared: PublishingGenericMutation, current: () => void) {
  const marker = readStudioGenericPending()
  const batch = marker?.batches.find(item => item.draftId === prepared.draftId && item.draftVersion === prepared.draftVersion) ?? (marker?.batches.length === 1 ? marker.batches[0] : undefined)
  const draftId = batch?.draftId ?? prepared.draftId, draftVersion = batch?.draftVersion ?? prepared.draftVersion
  if (!marker || !batch || !draftId || !draftVersion) throw new Error('原官方内容版本尚未读取，请核对原任务')
  const result = z.object({ id: z.string().uuid(), revision: z.number(), payload: PublishingStudioStoredDraftSchema }).passthrough().parse(await studioRequest(`publishing/generic?resource=profile&draftId=${draftId}&draftVersion=${draftVersion}`)); current()
  if (result.id !== draftId || result.revision !== draftVersion) throw new Error('原发布内容版本不匹配')
  return result.payload
}

/** Only the confirmed execution path can finish preparing a missing batch with its original key. */
export async function observeStudioGeneric(current: () => void, prepareMissing = false) {
  const marker = readStudioGenericPending(); if (!marker) return null
  if (marker.legacyPending && !marker.legacyPlan) throw new Error('原混合发布缺少剩余账号的确认快照，请联系站方核对原任务')
  const batches: PublishingGenericMutation[] = [], remainingIds: string[] = []
  const missing: Batch[] = []
  for (const batch of marker.batches) {
    const result = await lookupBatch(batch, current)
    if (!result) {
      if (batch.operationIds.length || !batch.profileRevision || !batch.targetIds?.length) throw new Error('原发布准备尚未查明，请保留原请求')
      missing.push(batch)
      remainingIds.push(...batch.targetIds)
      continue
    }
    if (!batch.operationIds.length) {
      batch.operationIds = result.operations.map(operation => operation.id)
      write(marker)
    }
    for (const operation of [...result.operations]) {
      if (operation.state === 'prepared' && !operation.grantUsed || ['succeeded', 'partial', 'failed_known', 'blocked'].includes(operation.state)) continue
      const observed = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', { action: 'reconcile', operationId: operation.id, expectedRevision: operation.revision })); current()
      assertReceipt(observed, [operation.id])
      if (unresolved(observed)) throw new Error('原官方结果仍待核对，发布已暂停')
      mergeResult(result, observed)
    }
    const ids = new Set(result.operations.filter(operation => operation.state === 'prepared' && !operation.grantUsed).flatMap(operation => operation.targetIds))
    remainingIds.push(...result.targets.filter(target => ids.has(target.id)).map(target => target.bindingId))
    batches.push(result)
  }
  if (prepareMissing) for (const batch of missing) batches.push(await prepareBatch(marker, batch, current))
  return { batches, remainingIds, legacyPlan: marker.legacyPending ? marker.legacyPlan : undefined }
}

export function completeStudioGeneric() { if (readStudioGenericPending()) localStorage.removeItem(key()) }
