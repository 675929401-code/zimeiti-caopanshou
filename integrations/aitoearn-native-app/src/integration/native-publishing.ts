import { z } from 'zod'
import { NativePreparedPublishSchema, type NativePreparePublish, type NativePreparedPublish } from '@host-publishing/native-operations-contract'
import { PublishingCenterSchema, type PublishingCenter } from '@host-publishing/publishing-contract'
import { PublishingV2ActionSchema, PublishingV2AttemptSchema, PublishingV2EventRecordSchema, PublishingV2MutationSchema, PublishingV2PageSchema, type PublishingV2Action, type PublishingV2DraftInput, type PublishingV2Target } from '@host-publishing/publishing-v2-contract'
import { PublishingV3ActionSchema, PublishingV3MutationSchema, PublishingV3OperationSchema, PublishingV3PageSchema, PublishingV3UserActionSchema, type PublishingV3Action, type PublishingV3Operation } from '@host-publishing/publishing-v3-contract'
import { buildNativePluginPlatformConfig, prepareNativePluginContent, validateNativePublishingMedia } from '@host-publishing/publishing-native'
import { createPublishingPluginRunner, inspectPublishingPlugin, publishingPluginMessage, type PublishingPluginParams } from '@host-publishing/publishing-plugin'
import type { NativePlanFiles } from './native-publish-plan'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { nativeBffFetch } from './host-transport'
import { nativeSha256 } from './native-assets'

const envelopeSchema = z.object({ code: z.union([z.literal(0), z.string()]), data: z.unknown(), message: z.string(), operationId: z.string().uuid().optional(), outcome: z.string().optional() }).passthrough()
async function data(path: string, method = 'GET', body?: unknown) {
  const owner = assertHostSession().user.id; const revision = getHostSessionRevision()
  const response = await nativeBffFetch(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
  const result = envelopeSchema.parse(await response.json()); assertHostSession(owner, revision)
  if (result.code !== 0) { const failure = new Error(result.message || '原提交结果待核对，请勿重复发起'); Object.assign(failure, { code: result.code, operationId: result.operationId, unknown: result.outcome === 'unknown' }); throw failure }
  return result.data
}
const v2 = async (action: PublishingV2Action) => PublishingV2MutationSchema.parse(await data('publishing/v2', 'POST', PublishingV2ActionSchema.parse(action)))
const v3 = async (action: PublishingV3Action) => PublishingV3MutationSchema.parse(await data('publishing/v3', 'POST', PublishingV3ActionSchema.parse(action)))
const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepare'), requestKey: z.string().max(160), planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal('browser'), manifestId: z.string().uuid(), requestKey: z.string().max(160), attemptId: z.string().uuid().optional(), report: PublishingV2ActionSchema.optional() }).strict(),
  z.object({ kind: z.literal('official'), manifestId: z.string().uuid(), requestKey: z.string().max(160), operationId: z.string().uuid().optional() }).strict(),
])
export type NativePendingPublish = z.infer<typeof pendingSchema>
const listeners = new Set<() => void>()
export function subscribeNativePending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function readNativePending(): NativePendingPublish | null { const key = hostStorageKey('pending-publish'); if (!key) return null; try { const raw = localStorage.getItem(key); return raw ? pendingSchema.parse(JSON.parse(raw)) : null } catch { throw new Error('原提交标记格式待核对，请保留浏览器数据并联系管理员；不会创建新任务') } }
function remember(value: NativePendingPublish | null) { assertHostSession(); const key = hostStorageKey('pending-publish'); if (!key) throw new Error('主站会员会话已停止'); if (value) localStorage.setItem(key, JSON.stringify(pendingSchema.parse(value))); else localStorage.removeItem(key); for (const listener of listeners) listener() }
export async function readNativePublishingCenter() { return PublishingCenterSchema.parse(await data('publishing/center')) }
export async function prepareNativePublishing(plan: NativePreparePublish) {
  const existing = NativePreparedPublishSchema.nullable().parse(await data(`publishing/prepare?requestKey=${encodeURIComponent(plan.requestKey)}`))
  const pending = readNativePending()
  if (existing) { if (pending?.kind === 'prepare' && pending.requestKey === plan.requestKey) remember(null); return existing }
  if (pending) throw new Error('有一笔原准备或原提交尚未核对，暂不创建新的执行快照')
  remember({ kind: 'prepare', requestKey: plan.requestKey, planHash: plan.planHash })
  const result = NativePreparedPublishSchema.parse(await data('publishing/prepare', 'POST', plan)); remember(null)
  return result
}
async function originalAttempt(requestKey: string) { const page = PublishingV2PageSchema.parse(await data(`publishing/v2?resource=attempts&requestKey=${encodeURIComponent(requestKey)}&pageSize=1`)); return page.items.map(item => PublishingV2AttemptSchema.parse(item)).find(item => item.requestKey === requestKey) }
async function originalReport(attemptId: string) { const page = PublishingV2PageSchema.parse(await data(`publishing/v2?resource=events&attemptId=${attemptId}&eventKind=browser_report&pageSize=1`)); return page.items.map(item => PublishingV2EventRecordSchema.parse(item)).find(item => item.kind === 'browser_report') }
async function originalOperation(requestKey: string) { const page = PublishingV3PageSchema.parse(await data(`publishing/v3?resource=operations&requestKey=${encodeURIComponent(requestKey)}&pageSize=1`)); return page.items.map(item => PublishingV3OperationSchema.parse(item)).find(item => item.requestKey === requestKey) }

/** Recovery can read original IDs or append the already captured safe report; it never claims/submits. */
export async function recoverNativePublish() {
  const pending = readNativePending(); if (!pending) return
  if (pending.kind === 'prepare') {
    const prepared = NativePreparedPublishSchema.nullable().parse(await data(`publishing/prepare?requestKey=${encodeURIComponent(pending.requestKey)}`))
    if (!prepared) throw new Error('原准备尚未查询到，继续保留请求标识，不会重新创建或发布')
    remember(null); return
  }
  if (pending.kind === 'browser') {
    const attempt = await originalAttempt(pending.requestKey)
    if (!attempt || pending.attemptId && pending.attemptId !== attempt.id) throw new Error('原执行尚未查明，标记继续保留，不会重新领取或调用插件')
    if (pending.report) { if (pending.report.action !== 'report' || pending.report.attemptId !== attempt.id) throw new Error('原报告与执行标识不匹配，请联系管理员核对'); await v2(pending.report) }
    const report = await originalReport(attempt.id)
    if (!report || typeof report.payload.success !== 'boolean') throw new Error('原插件执行没有明确报告，请核对平台原作品；不会重新调用插件')
    remember(null)
  } else {
    const operation = pending.operationId ? PublishingV3OperationSchema.parse((await v3({ action: 'reconcile', operationId: pending.operationId })).operation) : await originalOperation(pending.requestKey)
    if (!operation) throw new Error('原官方任务尚未查询到，请稍后核对；不会重新创建任务')
    remember({ ...pending, operationId: operation.id })
    const updated = (await v3({ action: 'reconcile', operationId: operation.id })).operation
    if (!updated || updated.outcome === 'unknown' || updated.dispatchState === 'unknown') throw new Error('原官方任务结果未知，继续保留核对标记')
    remember(null)
  }
}

export interface NativePublishUpdate {
  targetId: string
  state: 'publishing' | 'browser_reported' | 'published' | 'pending' | 'failed' | 'unknown'
  recordId?: string
  progress?: { stage: 'download' | 'upload' | 'publish' | 'complete' | 'error', progress: number }
  receipt?: { success: boolean, workId?: string, shareLink?: string }
  userAction?: { schemeUrl: string, shortLink: string, expiresAt?: string }
  message?: string
}
function entitlement(center: PublishingCenter, platform: 'xhs' | 'wxSph' | 'douyin') { const found = center.entitlements.find(item => item.platforms.includes(platform) && item.used < item.quota && Date.parse(item.expiresAt) > Date.now()); if (!found) throw new Error('此目标没有可用主站执行额度，请先核对套餐'); return found.id }
export async function assertNativeRemainingQuota(prepared: NativePreparedPublish, center: PublishingCenter) {
  const allowances = center.entitlements.map(item => ({ ...item, remaining: item.quota - item.used }))
  const reserve = (platform: 'xhs' | 'wxSph' | 'douyin') => { const found = allowances.find(item => item.platforms.includes(platform) && item.remaining > 0 && Date.parse(item.expiresAt) > Date.now()); if (!found) throw new Error('尚未领取的目标没有足够主站额度，请核对套餐；已完成原目标不会重发'); found.remaining-- }
  for (const group of prepared.groups) {
    if (group.batch) for (const target of group.draft.payload.targets) { const key = `native-claim:${group.batch.id}:${target.id}`; if (!await originalAttempt(key)) reserve(target.platform) }
    for (const target of group.officialTargets) if (!await originalOperation(`official-submit:${target.intent.id}:${target.intent.revision}`)) reserve('douyin')
  }
}
async function paramsFromSnapshot(snapshot: { draft: PublishingV2DraftInput, target: PublishingV2Target }, requestId: string, source: NativePlanFiles): Promise<PublishingPluginParams> {
  const { draft, target } = snapshot; const effective = (target.mediaIds || draft.media.filter(item => item.role !== 'cover').map(item => item.id)).map(id => draft.media.find(item => item.id === id)!)
  const cover = target.coverMediaId ? draft.media.find(item => item.id === target.coverMediaId) : target.mediaIds ? undefined : draft.media.find(item => item.role === 'cover')
  for (const item of [...effective, ...(cover ? [cover] : [])]) { const file = source.files.get(item.id); if (!file || file.size !== item.size || file.type !== item.type || !item.hash || await nativeSha256(file) !== item.hash) throw new Error('实际素材与领取时的不可变快照不一致，已停止执行') }
  const prepared = prepareNativePluginContent(target.platform, target.titleOverride ?? draft.title, target.bodyOverride ?? draft.body, target.topicsOverride ?? draft.topics)
  const errors = [...prepared.errors, ...validateNativePublishingMedia(target.platform, draft.contentType, effective, cover, target.scheduledAt)]; if (errors.length) throw new Error(errors.join('；'))
  const video = effective.find(item => item.role === 'video')
  const platformConfig = buildNativePluginPlatformConfig(target.platform, target.platform === 'xhs' ? { xhs: target.options } : target.platform === 'wxSph' ? { wxSph: target.options } : {}, video ? { width: video.width || 0, height: video.height || 0, duration: video.duration || 0, size: video.size } : undefined)
  const common = { platform: target.platform, title: prepared.title, desc: prepared.desc, topics: prepared.topics, ...(cover ? { cover: source.files.get(cover.id)! } : {}), ...(platformConfig ? { platformConfig } : {}), ...(target.scheduledAt ? { scheduledTime: Date.parse(target.scheduledAt) } : {}), requestId }
  return draft.contentType === 'video' && video ? { ...common, type: 'video', video: source.files.get(video.id)! } : { ...common, type: 'image', images: effective.map(item => source.files.get(item.id)!) }
}
async function officialUpdate(targetId: string, operation: PublishingV3Operation, update: (value: NativePublishUpdate) => void) {
  if (operation.outcome === 'unknown' || operation.dispatchState === 'unknown') { update({ targetId, state: 'unknown', recordId: operation.id, message: '原官方提交结果未知，请只核对原任务' }); return }
  if (operation.outcome === 'published' && operation.workLink) { update({ targetId, state: 'published', recordId: operation.id, receipt: { success: true, ...(operation.workId ? { workId: operation.workId } : {}), shareLink: operation.workLink } }); return }
  if (operation.outcome === 'failed' || operation.outcome === 'cancelled') { update({ targetId, state: 'failed', recordId: operation.id, message: '官方报告原任务未完成，请查看原记录' }); return }
  const action = operation.outcome === 'awaiting_user_action' ? PublishingV3UserActionSchema.parse(await data(`publishing/v3?resource=user-action&operationId=${operation.id}`)) : null
  update({ targetId, state: 'pending', recordId: operation.id, message: operation.outcome === 'queued' ? '官方队列已受理，到期仍需手机确认' : '官方任务已受理，仍需核对并完成手机接力', ...(action ? { userAction: { schemeUrl: action.schemeUrl, shortLink: action.shortLink, ...(action.expiresAt ? { expiresAt: action.expiresAt } : {}) } } : {}) })
}

/** Only immutable server-returned snapshots may reach the audited shared runner. */
export async function executeNativePublishing(prepared: NativePreparedPublish, sources: NativePlanFiles, update: (value: NativePublishUpdate) => void) {
  const owner = assertHostSession().user.id; const revision = getHostSessionRevision(); const current = () => { try { assertHostSession(owner, revision); return true } catch { return false } }
  if (readNativePending()) throw new Error('有一笔原提交需要核对，请先核对原任务，不会重新发布')
  if (!prepared.connectionCurrent) throw new Error('原准备使用的发布连接已变化，仅可核对原记录，不能继续执行')
  const runner = createPublishingPluginRunner()
  for (const group of prepared.groups) {
    if (group.batch) for (const target of group.draft.payload.targets) {
      assertHostSession(owner, revision)
      const requestKey = `native-claim:${group.batch.id}:${target.id}`
      const existing = await originalAttempt(requestKey)
      if (existing) { const report = await originalReport(existing.id); if (!report || typeof report.payload.success !== 'boolean') { remember({ kind: 'browser', manifestId: prepared.manifestId, requestKey, attemptId: existing.id }); update({ targetId: target.id, state: 'unknown', recordId: existing.id }); throw new Error('原目标已领取但无明确回执，暂停后续目标，不会再次调用插件') } update({ targetId: target.id, state: report.payload.success ? 'browser_reported' : 'failed', recordId: existing.id, receipt: { success: report.payload.success, ...(report.payload.workId ? { workId: report.payload.workId } : {}), ...(report.payload.shareLink ? { shareLink: report.payload.shareLink } : {}) } }); if (!report.payload.success) throw new Error('原目标报告未完成，原计划已暂停，不会自动重发'); continue }
      const account = group.batch.accountSnapshots.find(item => item.id === target.accountId); if (!account || target.platform === 'douyin') throw new Error('插件账号快照不完整')
      const detected = await inspectPublishingPlugin(target.platform); assertHostSession(owner, revision)
      if (detected.account.uid !== account.platformAccountId) throw new Error(`请先切换并读取 ${account.displayName} 对应的当前浏览器账号；已完成目标会保留并跳过`)
      // Material hash checks and platform constraints happen before quota claim as well as inside the runner.
      await paramsFromSnapshot({ draft: group.draft.payload, target }, 'native-preflight', sources)
      const center = await readNativePublishingCenter(); const entitlementId = entitlement(center, target.platform)
      remember({ kind: 'browser', manifestId: prepared.manifestId, requestKey })
      const claimed = await v2({ action: 'claim', batchId: group.batch.id, targetId: target.id, entitlementId, idempotencyKey: requestKey })
      if (!claimed.attempt || claimed.shouldExecute !== true) throw new Error('服务未返回新的执行许可，请核对原任务；不会调用插件')
      const attempt = claimed.attempt; remember({ kind: 'browser', manifestId: prepared.manifestId, requestKey, attemptId: attempt.id })
      const params = await paramsFromSnapshot(attempt.snapshot, `native:${attempt.id}`, sources)
      update({ targetId: target.id, state: 'publishing', recordId: attempt.id })
      let receipt
      try { receipt = await runner.executeNative({ attemptId: attempt.id, shouldExecute: true, platform: target.platform }, { platform: target.platform, uid: account.platformAccountId, account: detected.account.account, nickname: account.displayName }, params, progress => { if (current()) update({ targetId: target.id, state: 'publishing', recordId: attempt.id, progress }) }, current) }
      catch (reason) { if (current()) update({ targetId: target.id, state: 'unknown', recordId: attempt.id, message: publishingPluginMessage(reason) }); throw new Error(publishingPluginMessage(reason)) }
      assertHostSession(owner, revision)
      const report = PublishingV2ActionSchema.parse({ action: 'report', attemptId: attempt.id, idempotencyKey: `native-report:${attempt.id}`, success: receipt.success, ...(receipt.workId ? { workId: receipt.workId } : {}), ...(receipt.shareLink ? { shareLink: receipt.shareLink } : {}), ...(receipt.mediaMd5sum ? { mediaMd5sum: receipt.mediaMd5sum } : {}), ...(receipt.videoClipTaskId ? { videoClipTaskId: receipt.videoClipTaskId } : {}), ...(receipt.scheduledTime ? { scheduledTime: receipt.scheduledTime } : {}), ...(receipt.publishTime ? { publishTime: receipt.publishTime } : {}), ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}) })
      remember({ kind: 'browser', manifestId: prepared.manifestId, requestKey, attemptId: attempt.id, report }); await v2(report); remember(null)
      update({ targetId: target.id, state: receipt.success ? 'browser_reported' : 'failed', recordId: attempt.id, receipt })
      if (!receipt.success) throw new Error('浏览器报告原目标未完成，已暂停后续目标')
    }
    for (const target of group.officialTargets) {
      assertHostSession(owner, revision); const requestKey = `official-submit:${target.intent.id}:${target.intent.revision}`
      let operation = await originalOperation(requestKey)
      if (!operation) {
        const center = await readNativePublishingCenter(); const entitlementId = entitlement(center, 'douyin')
        remember({ kind: 'official', manifestId: prepared.manifestId, requestKey })
        try { const result = await v3({ action: 'submit', intentId: target.intent.id, intentRevision: target.intent.revision, entitlementId, requestKey }); operation = result.operation }
        catch (reason) { if (reason instanceof Error && 'operationId' in reason && typeof reason.operationId === 'string') remember({ kind: 'official', manifestId: prepared.manifestId, requestKey, operationId: reason.operationId }); throw reason }
        if (!operation) throw new Error('原官方任务回执缺失，请核对原任务，不要重发')
      }
      if (operation.outcome === 'unknown' || operation.dispatchState === 'unknown') remember({ kind: 'official', manifestId: prepared.manifestId, requestKey, operationId: operation.id }); else remember(null)
      await officialUpdate(target.targetId, operation, update)
      if (operation.outcome === 'unknown' || operation.dispatchState === 'unknown' || operation.outcome === 'failed' || operation.outcome === 'cancelled') throw new Error('原官方任务需要核对，已暂停后续目标')
    }
  }
}
