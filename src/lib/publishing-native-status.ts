import { z } from "zod";
export const PublishingNativeStatusSchema = z.object({
  schemaReady: z.boolean(),
  provider: z.object({ configured: z.boolean(), environment: z.enum(["domestic", "international"]), routeExecutionEnabled: z.boolean(), bindingRequired: z.literal(true), credentialSource: z.enum(["environment", "secret_file", "dpapi", "missing"]).optional(), credentialIssue: z.enum(["unavailable", "ambiguous"]).nullable().optional() }).strict(),
  counts: z.object({ collections: z.number().int().nonnegative(), drafts: z.number().int().nonnegative(), groups: z.number().int().nonnegative(), schedules: z.number().int().nonnegative(), batches: z.number().int().nonnegative(), attempts: z.number().int().nonnegative() }).strict().nullable(),
  official: z.object({ schemaReady: z.boolean(), bindings: z.number().int().nonnegative(), assets: z.number().int().nonnegative(), operations: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict().nullable().optional(),
}).strict();
export type PublishingNativeStatus = z.infer<typeof PublishingNativeStatusSchema>;
