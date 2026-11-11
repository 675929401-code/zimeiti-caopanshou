/** Public metadata only. Never import server prompt/configuration modules here. */
import { z } from "zod";

export const CoverStyleKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const CoverStyleVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);
export const CoverStylePublicSchema = z.object({
  styleKey: CoverStyleKeySchema,
  displayName: z.string().trim().min(1).max(60),
  description: z.string().trim().max(240),
  version: CoverStyleVersionSchema,
  order: z.number().int().min(0).max(100_000),
  // Omitted until an application-owned preview has been independently verified.
  previewUrl: z.string().url().optional(),
}).strict();
export type CoverStylePublic = z.infer<typeof CoverStylePublicSchema>;
export const CoverStylePublicCatalogSchema = z.object({ styles: z.array(CoverStylePublicSchema).max(40), revision: z.number().int().nonnegative() }).strict();
export type CoverStylePublicCatalog = z.infer<typeof CoverStylePublicCatalogSchema>;

export const COVER_BUILTIN_STYLE_METADATA: readonly CoverStylePublic[] = [
  { styleKey: "cartoon", displayName: "暖光叙事", description: "用自然情绪、人物关系与暖光场景表达内容。", version: "1.0.0", order: 0 },
  { styleKey: "funny-cartoon", displayName: "趣味反差", description: "用鲜明反应、具体反差与醒目标题表达内容。", version: "1.0.0", order: 1 },
];
