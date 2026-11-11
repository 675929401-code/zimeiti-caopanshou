import { z } from 'zod'
import { PublishingCommercialPlatformSchema as NativePlatformSchema } from './publishing-contract'

const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().nonnegative().max(2147483647)
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const price = z.number().int().min(1).max(100000000)
const requestKey = z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/)
export const PublishingCashAccountKindSchema = z.enum(['browser', 'official', 'generic'])
export const PublishingCashTransportSchema = z.enum(['browser_plugin', 'official_api'])
export const PublishingCashReasonSchema = z.enum(['ready', 'insufficient_balance', 'pricing_unavailable', 'execution_disabled', 'account_changed', 'access_denied'])
export const PublishingCashQuoteTargetInputSchema = z.object({
  accountId: id, accountKind: PublishingCashAccountKindSchema, accountRevision: revision.refine(v => v > 0), contentDigest: hash,
}).strict()
export const PublishingCashQuoteInputSchema = z.object({
  schemaVersion: z.literal(1), reviewHash: hash, targets: z.array(PublishingCashQuoteTargetInputSchema).min(1).max(100),
}).strict().superRefine((v, ctx) => {
  const keys = v.targets.map(t => `${t.accountKind}:${t.accountId}`)
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: '发布账号不可重复' })
})
export const PublishingCashQuoteProofSchema = z.object({
  input: PublishingCashQuoteInputSchema, pricingRevision: revision.refine(v => v > 0),
  windowStart: z.number().int().nonnegative().safe(), quoteHash: hash,
}).strict()
export const PublishingCashQuoteSchema = z.object({
  schemaVersion: z.literal(1), currency: z.literal('CNY'), pricingRevision: revision.refine(v => v > 0),
  quoteHash: hash, windowStart: z.number().int().nonnegative().safe(), expiresAt: z.string().datetime({ offset: true }), reviewHash: hash,
  availableBalanceCents: cents, estimatedChargeCents: cents, canExecute: z.boolean(), reasonCode: PublishingCashReasonSchema,
  targets: z.array(PublishingCashQuoteTargetInputSchema.extend({
    platform: NativePlatformSchema, transport: PublishingCashTransportSchema, priceVersionId: id, chargeCents: price,
  }).strict()).min(1).max(100),
}).strict()
export const PublishingCashQuoteResultSchema = z.object({ schemaReady: z.boolean(), quote: PublishingCashQuoteSchema.nullable(), reasonCode: PublishingCashReasonSchema }).strict()
export const PublishingCashFundingSchema = z.object({ kind: z.literal('cash'), proof: PublishingCashQuoteProofSchema }).strict()
export const PublishingCashAdmissionSchema = z.object({
  id, state: z.enum(['charged', 'refunded']), currency: z.literal('CNY'), chargeCents: price,
  quoteHash: hash, priceVersionId: id, chargedAt: z.string().datetime({ offset: true }), refundedAt: z.string().datetime({ offset: true }).nullable(),
}).strict()
const override = z.object({ platform: NativePlatformSchema, transport: PublishingCashTransportSchema, chargeCents: price }).strict()
export const PublishingCashPricingInputSchema = z.object({ expectedRevision: revision, defaultChargeCents: price, overrides: z.array(override).max(28) }).strict().superRefine((v, ctx) => {
  const keys = v.overrides.map(t => `${t.platform}:${t.transport}`)
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: '同一平台通道只能设置一个价格' })
})
export const PublishingCashPricingVersionSchema = z.object({
  id, revision: revision.refine(v => v > 0), currency: z.literal('CNY'), defaultChargeCents: price,
  overrides: z.array(override).max(28), createdAt: z.string().datetime({ offset: true }),
}).strict()
export const PublishingCashPricingStateSchema = z.object({ schemaReady: z.boolean(), current: PublishingCashPricingVersionSchema.nullable(), access: z.object({ canEdit: z.boolean() }).strict() }).strict()
export const PublishingCashPricingPreviewSchema = z.object({
  schemaReady: z.literal(true), current: PublishingCashPricingVersionSchema.nullable(), proposed: PublishingCashPricingInputSchema, previewHash: hash,
}).strict()
export const PublishingCashPricingSaveSchema = z.object({ action: z.literal('save'), requestKey, input: PublishingCashPricingInputSchema, previewHash: hash }).strict()
export const PublishingCashPricingActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), input: PublishingCashPricingInputSchema }).strict(), PublishingCashPricingSaveSchema,
])
export const PublishingCashPricingReceiptSchema = z.object({ requestKey, requestHash: hash, version: PublishingCashPricingVersionSchema }).strict()
export const PublishingCashPricingReceiptResultSchema = z.object({ schemaReady: z.boolean(), receipt: PublishingCashPricingReceiptSchema.nullable() }).strict()
export type PublishingCashQuoteInput = z.infer<typeof PublishingCashQuoteInputSchema>
export type PublishingCashQuote = z.infer<typeof PublishingCashQuoteSchema>
export type PublishingCashQuoteProof = z.infer<typeof PublishingCashQuoteProofSchema>
export type PublishingCashFunding = z.infer<typeof PublishingCashFundingSchema>
export type PublishingCashAdmission = z.infer<typeof PublishingCashAdmissionSchema>
export type PublishingCashPricingInput = z.infer<typeof PublishingCashPricingInputSchema>
export type PublishingCashPricingVersion = z.infer<typeof PublishingCashPricingVersionSchema>
export type PublishingCashPricingState = z.infer<typeof PublishingCashPricingStateSchema>
export type PublishingCashPricingPreview = z.infer<typeof PublishingCashPricingPreviewSchema>
export type PublishingCashPricingReceipt = z.infer<typeof PublishingCashPricingReceiptSchema>
export type PublishingCashPricingSave = z.infer<typeof PublishingCashPricingSaveSchema>
export type PublishingCashPricingAction = z.infer<typeof PublishingCashPricingActionSchema>

export function publishingCashQuoteProof(quote: PublishingCashQuote): PublishingCashQuoteProof {
  return PublishingCashQuoteProofSchema.parse({ input: { schemaVersion: 1, reviewHash: quote.reviewHash, targets: quote.targets.map(({ accountId, accountKind, accountRevision, contentDigest }) => ({ accountId, accountKind, accountRevision, contentDigest })) }, pricingRevision: quote.pricingRevision, windowStart: quote.windowStart, quoteHash: quote.quoteHash })
}
