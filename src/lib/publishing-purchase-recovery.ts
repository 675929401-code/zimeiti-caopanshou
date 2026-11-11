import { z } from "zod";
import { PublishingPurchaseSchema, PublishingEntitlementSchema, PublishingSubmissionKeySchema } from "./publishing-contract";

export const PublishingPurchaseRecoverySchema = z.object({
  schemaReady: z.literal(true), purchaseKey: PublishingSubmissionKeySchema,
  found: z.boolean(), shouldPurchase: z.literal(false),
  purchase: PublishingPurchaseSchema.nullable(), entitlement: PublishingEntitlementSchema.nullable(),
}).strict().refine(value => value.found
  ? value.purchase !== null && value.entitlement !== null && value.entitlement.purchaseId === value.purchase.id && value.entitlement.planId === value.purchase.planId && value.entitlement.planVersion === value.purchase.planVersion
  : value.purchase === null && value.entitlement === null);
export type PublishingPurchaseRecovery = z.infer<typeof PublishingPurchaseRecoverySchema>;
