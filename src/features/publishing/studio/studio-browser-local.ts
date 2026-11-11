import { z } from 'zod'
import { BrowserLocalPlanSchema, browserLocalPlanCanonical, type BrowserLocalPlan } from '@/lib/publishing-browser-local-contract'
import { NativePreparedPublishSchema, type NativePreparedPublish } from '@/lib/native-operations-contract'
import { PublishingV2DraftInputSchema, PublishingV2TargetSchema, type PublishingV2Media } from '@/lib/publishing-v2-contract'
import type { StudioAccount, StudioDraft, StudioMedia } from './types'
import type { NativePlanFiles } from './native-publish-plan'
import { nativeSha256 } from './native-assets'
import { targetStudioMedia } from './studio-draft'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { studioRequest } from './studio-api'
import { isDefiniteNativePrepareRejection } from './native-publishing'

const hashText = (value: string) => nativeSha256(new Blob([value], { type: 'text/plain' }))
const uuidFrom = (hash: string) => `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** RAM files only. No upload, provider asset, filesystem path or POST in this builder. */
export async function buildStudioBrowserLocalPlan(draft: StudioDraft, accounts: StudioAccount[], current: () => void): Promise<{ plan: BrowserLocalPlan; files: NativePlanFiles }> {
  current()
  if (draft.contentType === 'text' || !accounts.length || accounts.some(account => account.kind !== 'browser' || !['xhs', 'wxSph', 'douyin'].includes(account.platform) || account.status !== 'ready')) throw new Error('本地文件计划只接受已连接的浏览器图文或视频账号')
  const fileMap = new Map<string, File>(), mediaMap = new Map<string, PublishingV2Media>()
  const read = async (item: StudioMedia, role: 'image' | 'video' | 'cover') => {
    if (!item.file || item.status !== 'ready' || item.file.size !== item.size) throw new Error('已读取的素材已变化或需要重新选择，请返回作品步骤核对')
    const sha256 = await nativeSha256(item.file); current()
    const existing = mediaMap.get(item.id)
    if (existing) { if (existing.hash !== sha256 || existing.size !== item.file.size || existing.type !== item.file.type || (existing.role === 'video') !== (role === 'video')) throw new Error('同一素材标识对应不同文件'); if (existing.role === 'cover' && role === 'image') existing.role = 'image'; return existing }
    const media: PublishingV2Media = { id: item.id, source: 'local_file', requiresReselection: true, role, fileName: item.file.name, size: item.file.size, type: item.file.type, lastModified: item.file.lastModified, hash: sha256, ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}), ...(item.duration ? { duration: item.duration } : {}) }
    fileMap.set(item.id, item.file); mediaMap.set(item.id, media); return media
  }
  const targets: BrowserLocalPlan['draft']['targets'] = []
  for (const account of accounts) {
    current(); const override = draft.targetOverrides[account.id] || {}, selected = targetStudioMedia(draft, account.id), cover = override.cover || draft.cover
    if (!selected.length || (draft.contentType === 'video' && selected.length !== 1)) throw new Error(`${account.name}需要选择图片或单个视频`)
    if (account.platform === 'douyin' && [...selected.filter(item => item.kind === 'image'), ...(cover ? [cover] : [])].some(item => item.file && !['image/jpeg', 'image/png'].includes(item.file.type))) throw new Error(`${account.name}使用的图片和封面须为 JPG 或 PNG，请在该账号的素材设置中更换`)
    for (const item of selected) await read(item, draft.contentType)
    if (cover) await read(cover, 'cover')
    const when = override.publishAt ?? draft.publishAt
    const scheduledAt = when ? new Date(when).toISOString() : null
    if (scheduledAt && Date.parse(scheduledAt) <= Date.now()) throw new Error('计划时间已过，请重新核对')
    const native = override.options || {}
    if (account.platform === 'douyin') {
      const values = native.douyin
      if (values && ((values.private_status ?? 0) !== 0 || (values.short_title ?? '') !== '' || (values.cover_tsp ?? 0) !== 0 || (values.download_type ?? 1) !== 1)) throw new Error('该抖音设置仅官方接口通道使用，请清除单独设置或切换通道；浏览器通道按公开发布核对')
    }
    const options = account.platform === 'xhs' ? native.xhs?.userDeclarationBind ? { declaration: native.xhs.userDeclarationBind.origin } : {} : account.platform === 'wxSph' ? { ...(native.wxSph?.poiInfo ? { poiInfo: native.wxSph.poiInfo } : {}), ...(native.wxSph?.activity ? { event: native.wxSph.activity } : {}), ...(native.wxSph?.extLink ? { extLink: native.wxSph.extLink } : {}), ...(native.wxSph?.isOriginal !== undefined ? { postFlag: native.wxSph.isOriginal ? 1 : 0 } : {}) } : { privacyLevel: 'public' }
    const content = { accountId: account.id, platform: account.platform, scheduledAt, titleOverride: override.title ?? draft.title, bodyOverride: override.body ?? draft.body, topicsOverride: override.topics ?? draft.topics, mediaIds: selected.map(item => item.id), ...(cover ? { coverMediaId: cover.id } : {}), options }
    const id = uuidFrom(await hashText(JSON.stringify(content))); current()
    targets.push(PublishingV2TargetSchema.parse({ id, ...content }))
  }
  const payload = PublishingV2DraftInputSchema.parse({ schemaVersion: 2, collectionId: draft.collectionId || null, contentType: draft.contentType, title: draft.title, body: draft.body, topics: draft.topics, media: [...mediaMap.values()], targets })
  const plan = BrowserLocalPlanSchema.parse({ requestKey: 'studio-browser:pending', planHash: '0'.repeat(64), accounts: accounts.map(({ id, platform, uid, revision, metadataRevision }) => ({ id, platform, uid, revision, metadataRevision })), draft: payload })
  plan.planHash = await hashText(browserLocalPlanCanonical(plan)); current(); plan.requestKey = `studio-browser:${plan.planHash}`
  return { plan, files: { files: fileMap, assets: new Map() } }
}

const markerSchema = z.object({ kind: z.literal('browser-local-prepare'), owner: z.string(), plan: BrowserLocalPlanSchema }).strict()
export type BrowserLocalPending = z.infer<typeof markerSchema>
const listeners = new Set<() => void>()
export function subscribeBrowserLocalPending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function readBrowserLocalPending(): BrowserLocalPending | null {
  const key = hostStorageKey('browser-local-prepare'); if (!key) return null
  try { const value = localStorage.getItem(key); if (!value) return null; const marker = markerSchema.parse(JSON.parse(value)); if (marker.owner !== assertHostSession().user.id) throw new Error('owner mismatch'); return marker }
  catch { throw new Error('原本地准备标记待核对，请保留浏览器数据；不会重新创建发布') }
}
function remember(value: BrowserLocalPending | null) {
  const owner = assertHostSession().user.id, key = hostStorageKey('browser-local-prepare'); if (!key || value && value.owner !== owner) throw new Error('会员身份变化，请重新核对原操作')
  if (value) localStorage.setItem(key, JSON.stringify(markerSchema.parse(value))); else localStorage.removeItem(key)
  for (const listener of listeners) listener()
}
function verifyPrepared(plan: BrowserLocalPlan, raw: unknown): NativePreparedPublish {
  const result = NativePreparedPublishSchema.parse(raw), group = result.groups[0]
  if (!result.connectionCurrent || result.groups.length !== 1 || !group || group.key !== plan.draft.contentType || group.officialTargets.length || !same(group.draft.payload, plan.draft) || !group.batch) throw new Error('原本地准备回执与确认内容不一致，已保留原请求等待核对')
  const batch = group.batch
  if (batch.draftId !== group.draft.id || batch.draftVersion !== group.draft.revision || batch.targetIds.length !== plan.draft.targets.length || new Set(batch.targetIds).size !== batch.targetIds.length || plan.draft.targets.some(target => !batch.targetIds.includes(target.id)) || batch.accountSnapshots.length !== plan.accounts.length || plan.accounts.some(account => batch.accountSnapshots.filter(item => item.id === account.id && item.platform === account.platform && item.platformAccountId === account.uid).length !== 1)) throw new Error('原准备的账号或目标集合不一致，暂不执行')
  return result
}
async function checkPlan(plan: BrowserLocalPlan) { BrowserLocalPlanSchema.parse(plan); if (await hashText(browserLocalPlanCanonical(plan)) !== plan.planHash || plan.requestKey !== `studio-browser:${plan.planHash}`) throw new Error('本地计划摘要已变化，请重新核对') }
const inFlight = new Set<string>()
export async function prepareStudioBrowserLocal(input: BrowserLocalPlan, current: () => void): Promise<NativePreparedPublish> {
  const owner = assertHostSession().user.id
  if (inFlight.has(owner)) throw new Error('本地准备正在核对，请等待原操作返回')
  inFlight.add(owner)
  try { return await prepareLocal(input, current) } finally { inFlight.delete(owner) }
}
async function prepareLocal(input: BrowserLocalPlan, current: () => void): Promise<NativePreparedPublish> {
  const owner = assertHostSession().user.id, revision = getHostSessionRevision(), plan = BrowserLocalPlanSchema.parse(input)
  const guard = () => { assertHostSession(owner, revision); current() }
  guard(); await checkPlan(plan); guard()
  const pending = readBrowserLocalPending()
  if (pending && pending.plan.requestKey !== plan.requestKey) throw new Error('有一笔本地准备尚待核对，不能创建新请求')
  const existing = await studioRequest(`studio/browser-plans?requestKey=${encodeURIComponent(plan.requestKey)}`); guard()
  if (existing !== null) { const value = verifyPrepared(plan, existing); remember({ kind: 'browser-local-prepare', owner, plan }); return value }
  if (pending) throw new Error('原准备尚未查询到，继续保留请求标识，不会重复提交')
  remember({ kind: 'browser-local-prepare', owner, plan }); guard()
  try { const response = await studioRequest('studio/browser-plans', 'POST', plan); guard(); return verifyPrepared(plan, response) }
  catch (reason) {
    if (isDefiniteNativePrepareRejection(reason)) {
      guard(); const found = await studioRequest(`studio/browser-plans?requestKey=${encodeURIComponent(plan.requestKey)}`); guard()
      if (found === null && readBrowserLocalPending()?.plan.requestKey === plan.requestKey) { remember(null); Object.assign(reason as Error, { prepareNotCreated: true }) }
    }
    throw reason
  }
}
export async function recoverBrowserLocalPending(current: () => void = () => {}): Promise<NativePreparedPublish | null> {
  const owner = assertHostSession().user.id
  if (inFlight.has(owner)) throw new Error('原本地准备正在核对，请稍后查看结果')
  inFlight.add(owner)
  try { return await recoverLocal(current) } finally { inFlight.delete(owner) }
}
async function recoverLocal(current: () => void): Promise<NativePreparedPublish | null> {
  const pending = readBrowserLocalPending(); if (!pending) return null
  const owner = assertHostSession().user.id, revision = getHostSessionRevision()
  await checkPlan(pending.plan); assertHostSession(owner, revision); current()
  const raw = await studioRequest(`studio/browser-plans?requestKey=${encodeURIComponent(pending.plan.requestKey)}`); assertHostSession(owner, revision); current()
  if (raw === null) throw new Error('原准备尚未查询到，不会重新创建或调用插件')
  return verifyPrepared(pending.plan, raw)
}
/** The controller calls this only after all original targets have known receipts. */
export function completeBrowserLocalPlan(current: () => void = () => {}) {
  const owner = assertHostSession().user.id
  current()
  if (inFlight.has(owner)) throw new Error('原本地计划仍在核对，暂不能结束恢复标记')
  const pending = readBrowserLocalPending()
  if (pending && pending.owner !== owner) throw new Error('当前计划归属已变化')
  remember(null)
}
