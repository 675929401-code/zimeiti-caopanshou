import { z } from 'zod'
import { NativePreparePublishSchema, NativePreparedPublishSchema, nativePreparePlanCanonical, type NativePreparePublish, type NativePreparedPublish } from '@/lib/native-operations-contract'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { nativeSha256 } from './native-assets'
import { isDefiniteNativePrepareRejection, prepareNativePublishing } from './native-publishing'
import { studioRequest } from './studio-api'

const markerSchema = z.object({ kind: z.literal('studio-legacy-plan'), owner: z.string().uuid(), plan: NativePreparePublishSchema, manifestId: z.string().uuid().optional() }).strict()
export type StudioLegacyPending = z.infer<typeof markerSchema>
const listeners = new Set<() => void>(), inFlight = new Set<string>()
export function subscribeStudioLegacyPending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function readStudioLegacyPending(): StudioLegacyPending | null {
  const key = hostStorageKey('studio-legacy-plan'); if (!key) return null
  try { const raw = localStorage.getItem(key); if (!raw) return null; const value = markerSchema.parse(JSON.parse(raw)); if (value.owner !== assertHostSession().user.id) throw new Error('owner changed'); return value }
  catch { throw new Error('原发布计划需要核对，请保留浏览器数据；不会从当前内容重新创建发布') }
}
function remember(value: StudioLegacyPending | null) {
  const owner = assertHostSession().user.id, key = hostStorageKey('studio-legacy-plan')
  if (!key || value && value.owner !== owner) throw new Error('会员身份已变化，请重新核对原发布')
  if (value) localStorage.setItem(key, JSON.stringify(markerSchema.parse(value))); else localStorage.removeItem(key)
  for (const listener of listeners) listener()
}
function canonical(value: unknown): string {
  const sorted = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sorted) : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)])) : entry
  return JSON.stringify(sorted(value))
}
async function checkPlan(plan: NativePreparePublish) {
  const digest = await nativeSha256(new Blob([nativePreparePlanCanonical(plan)], { type: 'text/plain' }))
  if (digest !== plan.planHash || plan.requestKey !== `native-plan:${plan.planHash}`) throw new Error('原发布计划摘要不一致，请核对原记录')
}
/** Check the complete execution content, not merely the receipt IDs. */
export function verifyStudioLegacyPrepared(input: NativePreparePublish, raw: unknown, manifestId?: string): NativePreparedPublish {
  const plan = NativePreparePublishSchema.parse(input), result = NativePreparedPublishSchema.parse(raw)
  if (!result.connectionCurrent || manifestId && result.manifestId !== manifestId || result.groups.length !== plan.groups.length || new Set(result.groups.map(group => group.key)).size !== result.groups.length) throw new Error('原发布准备与确认的通道或分组不一致，已停止恢复')
  const draftIds = new Set<string>(), batchIds = new Set<string>(), intentIds = new Set<string>()
  for (const expected of plan.groups) {
    const actual = result.groups.find(group => group.key === expected.key)
    if (!actual || canonical(actual.draft.payload) !== canonical(expected.draft) || actual.draft.archived || draftIds.has(actual.draft.id)) throw new Error('原发布内容与确认快照不一致，已停止恢复')
    draftIds.add(actual.draft.id)
    if (expected.draft.targets.length) {
      const batch = actual.batch, targets = expected.draft.targets
      if (!batch || batchIds.has(batch.id) || batch.draftId !== actual.draft.id || batch.draftVersion !== actual.draft.revision || batch.targetIds.length !== targets.length || new Set(batch.targetIds).size !== targets.length || targets.some(target => !batch.targetIds.includes(target.id)) || batch.accountSnapshots.length !== targets.length || targets.some(target => batch.accountSnapshots.filter(account => account.id === target.accountId && account.platform === target.platform).length !== 1)) throw new Error('原浏览器目标或账号集合不一致，已停止恢复')
      batchIds.add(batch.id)
    } else if (actual.batch) throw new Error('原准备包含未确认的浏览器批次')
    if (actual.officialTargets.length !== expected.officialTargets.length || new Set(actual.officialTargets.map(target => target.targetId)).size !== actual.officialTargets.length) throw new Error('原官方发布目标集合不一致')
    for (const target of expected.officialTargets) {
      const found = actual.officialTargets.find(value => value.targetId === target.id)
      const { id: _, ...content } = target; void _
      const payload = { ...content, draftId: actual.draft.id, draftVersion: actual.draft.revision }
      if (!found || found.intent.archived || intentIds.has(found.intent.id) || canonical(found.intent.payload) !== canonical(payload)) throw new Error('原官方账号、内容、素材或时间与确认快照不一致')
      intentIds.add(found.intent.id)
    }
  }
  return result
}
export async function prepareStudioLegacyPlan(input: NativePreparePublish, current: () => void): Promise<NativePreparedPublish> {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  if (inFlight.has(owner)) throw new Error('原发布准备正在核对，请等待结果')
  inFlight.add(owner)
  const guard = () => { assertHostSession(owner, revision); current() }
  try {
    const plan = NativePreparePublishSchema.parse(input); guard(); await checkPlan(plan); guard()
    const prior = readStudioLegacyPending()
    if (prior && (prior.plan.requestKey !== plan.requestKey || prior.plan.planHash !== plan.planHash)) throw new Error('请先核对上一笔发布，不能创建新计划')
    const existing = await studioRequest(`publishing/prepare?requestKey=${encodeURIComponent(plan.requestKey)}`); guard()
    if (existing !== null) { const prepared = verifyStudioLegacyPrepared(plan, existing, prior?.manifestId); remember({ kind: 'studio-legacy-plan', owner, plan, manifestId: prepared.manifestId }); return prepared }
    if (prior) throw new Error('原发布准备尚未查询到，保留原请求，不会重复提交')
    remember({ kind: 'studio-legacy-plan', owner, plan }); guard()
    let response: NativePreparedPublish
    try { response = await prepareNativePublishing(plan, guard) }
    catch (reason) {
      if (isDefiniteNativePrepareRejection(reason)) {
        guard(); const found = await studioRequest(`publishing/prepare?requestKey=${encodeURIComponent(plan.requestKey)}`); guard()
        const marker = readStudioLegacyPending()
        if (found === null && marker && !marker.manifestId && marker.plan.requestKey === plan.requestKey && marker.plan.planHash === plan.planHash) { remember(null); Object.assign(reason as Error, { prepareNotCreated: true }) }
      }
      throw reason
    }
    const prepared = verifyStudioLegacyPrepared(plan, response); guard()
    remember({ kind: 'studio-legacy-plan', owner, plan, manifestId: prepared.manifestId }); return prepared
  } finally { inFlight.delete(owner) }
}
/** Recovery reads only the original manifest. It never repeats a prepare POST. */
export async function recoverStudioLegacyPending(current: () => void = () => {}): Promise<{ plan: NativePreparePublish; prepared: NativePreparedPublish } | null> {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  if (inFlight.has(owner)) throw new Error('原发布准备正在核对，请等待结果')
  inFlight.add(owner)
  const guard = () => { assertHostSession(owner, revision); current() }
  try {
    const pending = readStudioLegacyPending(); if (!pending) return null
    guard(); await checkPlan(pending.plan); guard()
    const raw = await studioRequest(`publishing/prepare?requestKey=${encodeURIComponent(pending.plan.requestKey)}`); guard()
    if (raw === null) throw new Error('原发布准备尚未查询到，不会从当前编辑重新创建发布')
    const prepared = verifyStudioLegacyPrepared(pending.plan, raw, pending.manifestId)
    remember({ ...pending, manifestId: prepared.manifestId }); return { plan: pending.plan, prepared }
  } finally { inFlight.delete(owner) }
}
/** Called only after every original target has a known execution result or existing acceptance. */
export function completeStudioLegacyPlan(current: () => void = () => {}) {
  current(); const owner = assertHostSession().user.id
  if (inFlight.has(owner)) throw new Error('原发布计划仍在核对，暂不能结束恢复')
  const marker = readStudioLegacyPending(); if (marker && marker.owner !== owner) throw new Error('原发布计划归属已变化')
  remember(null)
}
