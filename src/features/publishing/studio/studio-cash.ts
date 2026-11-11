import { PublishingCashQuoteInputSchema, PublishingCashQuoteResultSchema, type PublishingCashFunding, type PublishingCashQuoteInput, type PublishingCashQuote } from '@/lib/publishing-cash-contract'
import { publishingCashDigest, publishingCashV2Content, publishingCashV3Content, publishingCashGenericContent, type PublishingCashContent } from '@/lib/publishing-cash-content'
import { PublishingV2TargetSchema, type PublishingV2Media } from '@/lib/publishing-v2-contract'
import { PublishingV3OptionsSchema } from '@/lib/publishing-v3-contract'
import { PublishingTargetProfileSchema } from '@/lib/publishing-generic-contract'
import type { StudioAccount, StudioDraft, StudioPlatform } from './types'
import { allDraftMedia, targetStudioMedia } from './studio-draft'
import { nativeSha256 } from './native-assets'
import { studioRequest } from './studio-api'

export class StudioCashRefreshRequired extends Error { constructor(message = '费用确认已过期，请核对原发布并重新确认尚未执行账号的费用') { super(message) } }
export function assertStudioCashFresh(funding: PublishingCashFunding) {
  if ((funding.proof.windowStart + 300) * 1000 <= Date.now()) throw new StudioCashRefreshRequired()
}
export async function assertStudioCashTarget(funding: PublishingCashFunding, accountId: string, accountKind: 'browser' | 'official' | 'generic', content: PublishingCashContent) {
  assertStudioCashFresh(funding)
  const target = funding.proof.input.targets.find(item => item.accountId === accountId && item.accountKind === accountKind)
  if (!target || await publishingCashDigest(content) !== target.contentDigest) throw new Error('执行内容与已确认费用不一致，已停止本次提交')
}

/** Real frozen bytes only; no upload/save/provider access occurs while obtaining a quote. */
export async function buildStudioCashInput(draft: StudioDraft, accounts: StudioAccount[], platforms: StudioPlatform[], reviewHash: string, current: () => void): Promise<PublishingCashQuoteInput> {
  const media: PublishingV2Media[] = []
  for (const item of allDraftMedia(draft)) {
    if (!item.file || item.file.size !== item.size) throw new Error('实际素材尚未读取，无法核对发布费用')
    const hash = await nativeSha256(item.file); current()
    media.push({ id: item.id, source: 'local_file', requiresReselection: true, fileName: item.name, size: item.size, type: item.file.type, lastModified: item.file.lastModified, hash, role: draft.media.some(m => m.id === item.id) ? item.kind : 'cover' })
  }
  const targets: PublishingCashQuoteInput['targets'] = []
  for (const account of accounts) {
    const override = draft.targetOverrides[account.id] || {}, cover = override.cover || draft.cover
    const selected = targetStudioMedia(draft, account.id), when = override.publishAt ?? draft.publishAt
    const fields = { titleOverride: override.title ?? draft.title, bodyOverride: override.body ?? draft.body, topicsOverride: override.topics ?? draft.topics, mediaIds: selected.map(m => m.id), ...(cover ? { coverMediaId: cover.id } : {}) }
    let content: PublishingCashContent
    if (account.kind === 'generic') {
      const profile = PublishingTargetProfileSchema.parse({ id: account.id, accountId: account.id, accountRevision: account.revision, accountKind: account.kind, platform: account.platform, title: fields.titleOverride, body: fields.bodyOverride, topics: fields.topicsOverride, mediaIds: fields.mediaIds, coverMediaId: cover?.id, options: override.providerOptions ?? platforms.find(p => p.key === account.platform)?.defaultOption ?? {}, publishAt: when ? new Date(when).toISOString() : null })
      content = publishingCashGenericContent({ contentType: draft.contentType, media }, profile)
    } else {
      if (draft.contentType === 'text') throw new Error('此账号通道不支持纯文字发布')
      const base = { contentType: draft.contentType, title: draft.title, body: draft.body, topics: draft.topics, media }
      if (account.kind === 'official') content = publishingCashV3Content(base, { ...fields, publishAt: when ? new Date(when).toISOString() : null, options: PublishingV3OptionsSchema.parse(override.options?.douyin ?? {}) })
      else {
        const native = override.options ?? {}
        const options = account.platform === 'xhs' ? native.xhs?.userDeclarationBind ? { declaration: native.xhs.userDeclarationBind.origin } : {} : account.platform === 'wxSph' ? { ...(native.wxSph?.poiInfo ? { poiInfo: native.wxSph.poiInfo } : {}), ...(native.wxSph?.activity ? { event: native.wxSph.activity } : {}), ...(native.wxSph?.extLink ? { extLink: native.wxSph.extLink } : {}), postFlag: native.wxSph?.isOriginal ? 1 : 0 } : { privacyLevel: 'public' }
        content = publishingCashV2Content(base, PublishingV2TargetSchema.parse({ id: account.id, accountId: account.id, platform: account.platform, ...fields, options, scheduledAt: when ? new Date(when).toISOString() : null }))
      }
    }
    const contentDigest = await publishingCashDigest(content); current()
    targets.push({ accountId: account.id, accountKind: account.kind, accountRevision: account.revision, contentDigest })
  }
  return PublishingCashQuoteInputSchema.parse({ schemaVersion: 1, reviewHash, targets })
}
export async function readStudioCashQuote(input: PublishingCashQuoteInput, current: () => void): Promise<PublishingCashQuote> {
  const request = PublishingCashQuoteInputSchema.parse(input)
  const result = PublishingCashQuoteResultSchema.parse(await studioRequest('studio/cash-quote', 'POST', request)); current()
  if (!result.quote) throw new Error(result.reasonCode === 'access_denied' ? '当前账号没有发布权限，请联系站方处理' : '本次费用暂不能确认，请稍后重试；尚未提交或扣款')
  const quote = result.quote
  if (quote.reviewHash !== request.reviewHash || quote.targets.length !== request.targets.length || quote.targets.some((target, index) => { const source = request.targets[index]; return target.accountId !== source.accountId || target.accountKind !== source.accountKind || target.accountRevision !== source.accountRevision || target.contentDigest !== source.contentDigest }) || quote.targets.reduce((sum, target) => sum + target.chargeCents, 0) !== quote.estimatedChargeCents || Date.parse(quote.expiresAt) !== (quote.windowStart + 300) * 1000) throw new Error('费用回执与本次账号内容不一致，请重新核对')
  return quote
}
