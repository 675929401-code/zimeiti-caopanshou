import type { NativePreparePublish, NativePreparedPublish } from '@/lib/native-operations-contract'
import type { PublishingStudioStoredDraft } from '@/lib/publishing-generic-contract'
import { publishingCashDigest, publishingCashV2Content, publishingCashV3Content, publishingCashGenericContent, type PublishingCashContent } from '@/lib/publishing-cash-content'
import { PublishingCashQuoteInputSchema } from '@/lib/publishing-cash-contract'
import type { StudioAccount, StudioReview } from './types'

/** Convert only original server snapshots to a cash review. The current editor is never consulted. */
export async function legacyStudioCashInput(input: { prepared?: NativePreparedPublish; plan?: NativePreparePublish; generic?: PublishingStudioStoredDraft; remainingIds: string[]; accounts: StudioAccount[] }, current: () => void) {
  const targets: StudioReview['targets'] = [], priced: Array<{ accountId: string; accountKind: StudioAccount['kind']; accountRevision: number; contentDigest: string }> = []
  const append = async (accountId: string, kind: StudioAccount['kind'], content: PublishingCashContent, names: string[], coverName?: string, uid?: string, revision?: number) => {
    if (!input.remainingIds.includes(accountId)) return
    const account = input.accounts.find(a => a.id === accountId && a.kind === kind && a.platform === content.platform)
    if (!account || account.status !== 'ready' || uid !== undefined && account.uid !== uid || revision !== undefined && account.revision !== revision) throw new Error('原发布账号身份或授权已变化，请核对原任务')
    const digest = await publishingCashDigest(content); current()
    priced.push({ accountId, accountKind: kind, accountRevision: account.revision, contentDigest: digest })
    targets.push({ accountId, accountName: account.name, platform: content.platform, title: content.title, body: content.body, topics: content.topics, options: content.options, mediaNames: names, coverName, publishAt: content.publishAt ?? undefined, transport: kind === 'browser' ? 'browser_plugin' : 'official_api', quota: 1 })
  }
  if (input.prepared) for (const group of input.prepared.groups) {
    const draft = group.draft.payload
    for (const id of group.batch?.targetIds ?? []) { const target = draft.targets.find(t => t.id === id), account = group.batch?.accountSnapshots.find(a => a.id === target?.accountId); if (!target || !account) throw new Error('原发布目标集合不完整'); await append(target.accountId, 'browser', publishingCashV2Content(draft, target), (target.mediaIds ?? draft.media.filter(m => m.role !== 'cover').map(m => m.id)).map(id => draft.media.find(m => m.id === id)!.fileName), draft.media.find(m => m.id === (target.coverMediaId ?? (!target.mediaIds ? draft.media.find(m => m.role === 'cover')?.id : undefined)))?.fileName, account.platformAccountId) }
    for (const { intent } of group.officialTargets) { const target = intent.payload; await append(target.bindingId, 'official', publishingCashV3Content(draft, target), target.mediaIds.map(id => draft.media.find(m => m.id === id)!.fileName), draft.media.find(m => m.id === (target.coverMediaId ?? (!target.mediaIds ? draft.media.find(m => m.role === 'cover')?.id : undefined)))?.fileName, undefined, target.bindingRevision) }
  }
  else if (input.plan) for (const group of input.plan.groups) {
    for (const target of group.draft.targets) await append(target.accountId, 'browser', publishingCashV2Content(group.draft, target), (target.mediaIds ?? group.draft.media.filter(m => m.role !== 'cover').map(m => m.id)).map(id => group.draft.media.find(m => m.id === id)!.fileName), group.draft.media.find(m => m.id === (target.coverMediaId ?? (!target.mediaIds ? group.draft.media.find(m => m.role === 'cover')?.id : undefined)))?.fileName)
    for (const target of group.officialTargets) await append(target.bindingId, 'official', publishingCashV3Content(group.draft, target), target.mediaIds.map(id => group.draft.media.find(m => m.id === id)!.fileName), group.draft.media.find(m => m.id === (target.coverMediaId ?? (!target.mediaIds ? group.draft.media.find(m => m.role === 'cover')?.id : undefined)))?.fileName, undefined, target.bindingRevision)
  }
  if (input.generic) for (const target of input.generic.profile.targets.filter(t => t.accountKind === 'generic')) await append(target.accountId, 'generic', publishingCashGenericContent(input.generic, target), target.mediaIds.map(id => input.generic!.media.find(m => m.id === id)!.fileName), input.generic.media.find(m => m.id === target.coverMediaId)?.fileName, undefined, target.accountRevision)
  if (priced.length !== input.remainingIds.length || new Set(priced.map(t => t.accountId)).size !== priced.length) throw new Error('原发布剩余账号集合不完整，不能重新报价')
  const reviewHash = await publishingCashDigest(priced); current()
  return { input: PublishingCashQuoteInputSchema.parse({ schemaVersion: 1, reviewHash, targets: priced }), targets }
}
