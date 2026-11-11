import 'server-only'
import type { AuthUser, getSupabase } from '@/lib/api-middleware'
import { PublishingCashQuoteInputSchema, PublishingCashQuoteResultSchema, type PublishingCashFunding } from '@/lib/publishing-cash-contract'
import { publishingCashCanonical, publishingCashDigest, publishingCashV2Content, type PublishingCashContent } from '@/lib/publishing-cash-content'
import { PublishingV2DraftInputSchema } from '@/lib/publishing-v2-contract'
import { PublishingError, publishingRuntimeEnabled } from './publishing-service'

type DB = ReturnType<typeof getSupabase>
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function publishingCashFailure(error: unknown): never {
  const text = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
  const code = /PUBLISH_CASH_[A-Z_]+|PUBLISH_(?:IDEMPOTENCY|REVISION)_CONFLICT|VIDEO_BUDGET_CASH_RESERVED|WALLET_INSUFFICIENT_BALANCE/.exec(text)?.[0] ?? 'PUBLISH_CASH_UNCONFIRMED'
  const messages: Record<string, string> = {
    PUBLISH_CASH_QUOTE_EXPIRED: '本次费用确认已过期，原稿和已准备素材已保留，请重新核对费用后继续',
    PUBLISH_CASH_QUOTE_CHANGED: '发布价格或账号已变化，请重新核对剩余目标费用',
    PUBLISH_CASH_ACCOUNT_CHANGED: '账号连接已变化，请重新选择账号并检查',
    PUBLISH_CASH_CONTENT_MISMATCH: '原发布内容与费用确认不一致，已停止扣款',
    PUBLISH_CASH_INSUFFICIENT: '可用现金余额不足，已暂停尚未执行的目标',
    VIDEO_BUDGET_CASH_RESERVED: '部分现金正在用于视频任务，可用余额不足，请完成充值或等待原任务结算',
    WALLET_INSUFFICIENT_BALANCE: '可用现金余额不足，已暂停尚未执行的目标',
    PUBLISH_CASH_PRICE_UNAVAILABLE: '发布费用暂时无法确认，请稍后重新检查',
    PUBLISH_CASH_REFUNDED: '原执行费用已退回，此许可不可再次执行',
    PUBLISH_IDEMPOTENCY_CONFLICT: '请求标识已用于其他内容，请核对原发布记录',
    PUBLISH_REVISION_CONFLICT: '原内容或费用已有新版本，请刷新后重新确认',
  }
  const uncertain = code === 'PUBLISH_CASH_UNCONFIRMED'
  throw new PublishingError(code, messages[code] ?? '发布费用状态暂不可确认，请核对原记录，勿重复提交', uncertain ? 503 : 409, uncertain)
}
export async function readPublishingCashQuote(user: AuthUser, db: DB, input: unknown) {
  const parsed = PublishingCashQuoteInputSchema.parse(input)
  const result = await db.rpc('quote_publish_cash', { p_actor: user.id, p_input: parsed } as never)
  if (result.error) {
    const code = String((result.error as { code?: string }).code)
    if (['42P01', '42703', '42883', 'PGRST202'].includes(code)) return PublishingCashQuoteResultSchema.parse({ schemaReady: false, quote: null, reasonCode: 'pricing_unavailable' })
    publishingCashFailure(result.error)
  }
  const value = PublishingCashQuoteResultSchema.parse(result.data)
  if (value.quote && (value.quote.reviewHash !== parsed.reviewHash || publishingCashCanonical(value.quote.targets.map(({ accountId, accountKind, accountRevision, contentDigest }) => ({ accountId, accountKind, accountRevision, contentDigest }))) !== publishingCashCanonical(parsed.targets))) {
    throw new PublishingError('PUBLISH_CASH_QUOTE_CHANGED', '费用回执与已选目标不一致，请重新检查', 409)
  }
  if (value.quote && !publishingRuntimeEnabled()) { value.quote.canExecute = false; value.quote.reasonCode = 'execution_disabled'; value.reasonCode = 'execution_disabled' }
  return value
}
export async function publishingCashContentProof(funding: PublishingCashFunding, accountId: string, kind: 'browser' | 'official' | 'generic', content: PublishingCashContent) {
  const target = funding.proof.input.targets.find(t => t.accountId === accountId && t.accountKind === kind)
  if (!target || target.contentDigest !== await publishingCashDigest(content)) throw new PublishingError('PUBLISH_CASH_CONTENT_MISMATCH', '实际发布内容与已确认费用不一致，已停止扣款', 409)
  return publishingCashCanonical(content)
}
export async function publishingCashV2Proof(user: AuthUser, db: DB, batchId: string, targetId: string, funding: PublishingCashFunding, scheduleId?: string) {
  const batch = await db.from('pub2_batches').select('draft_id,draft_version,target_ids').eq('user_id', user.id).eq('id', batchId).maybeSingle()
  if (batch.error) publishingCashFailure(batch.error)
  const batchRow = record(batch.data)
  if (!Array.isArray(batchRow.target_ids) || !batchRow.target_ids.includes(targetId)) throw new PublishingError('PUBLISH_V2_BATCH_NOT_FOUND', '原发布批次不存在', 404)
  const version = await db.from('pub2_draft_versions').select('payload').eq('user_id', user.id).eq('draft_id', String(batchRow.draft_id)).eq('version', Number(batchRow.draft_version)).maybeSingle()
  if (version.error) publishingCashFailure(version.error)
  const draft = PublishingV2DraftInputSchema.parse(record(version.data).payload), target = draft.targets.find(t => t.id === targetId)
  if (!target) throw new PublishingError('PUBLISH_V2_TARGET_NOT_FOUND', '原发布目标不存在', 404)
  if (scheduleId) {
    const schedule = await db.from('pub2_schedules').select('id').eq('user_id', user.id).eq('id', scheduleId).eq('draft_id', String(batchRow.draft_id)).eq('draft_version', Number(batchRow.draft_version)).eq('target_id', targetId).maybeSingle()
    if (schedule.error) publishingCashFailure(schedule.error)
    if (!schedule.data) throw new PublishingError('PUBLISH_V2_SCHEDULE_NOT_FOUND', '原计划不存在', 404)
  }
  return publishingCashContentProof(funding, target.accountId, 'browser', publishingCashV2Content(draft, scheduleId ? { ...target, scheduledAt: null } : target))
}
