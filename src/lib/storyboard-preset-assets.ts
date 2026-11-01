import { z } from "zod";

export const STORYBOARD_PRESET_SETTING_KEY = "storyboard_preset_asset_catalog.v1";
export const StoryboardPresetIdSchema = z.string().regex(/^preset-[a-z0-9][a-z0-9_-]{2,63}$/u);
export const StoryboardPresetDraftSchema = z.object({
  assetId: z.string().uuid(),
  role: z.enum(["character", "pet", "environment", "prop"]),
  name: z.string().trim().min(2).max(120),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
  customCategory: z.string().trim().max(40).default(""),
  prompt: z.string().trim().max(10_000).default(""),
}).strict();
const DraftSchema = StoryboardPresetDraftSchema.extend({ ownerId: z.string().min(1), savedAt: z.string().datetime() });
const PublishedSchema = DraftSchema.omit({ assetId: true, ownerId: true, savedAt: true }).extend({
  revision: z.number().int().positive(), storageKey: z.string().regex(/^storyboard-presets\/preset-[a-z0-9][a-z0-9_-]{2,63}\/[a-f0-9]{64}\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}\.(?:png|jpg|webp)$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive(), height: z.number().int().positive(),
  publishedAt: z.string().datetime(), publishedBy: z.string().min(1),
});
const EntrySchema = z.object({
  presetId: StoryboardPresetIdSchema, disabled: z.boolean().default(false),
  draft: DraftSchema.optional(), published: PublishedSchema.optional(),
});
export const StoryboardPresetCatalogSchema = z.object({
  schema: z.literal("storyboard_preset_asset_catalog.v1"), revision: z.number().int().nonnegative(),
  entries: z.array(EntrySchema).max(300),
  audit: z.array(z.object({ revision: z.number().int().positive(), presetId: StoryboardPresetIdSchema,
    action: z.enum(["draft", "publish", "disable"]), actorId: z.string().min(1), at: z.string().datetime(),
  })).max(1000),
}).superRefine((catalog, ctx) => {
  if (new Set(catalog.entries.map((entry) => entry.presetId)).size !== catalog.entries.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate preset identity" });
  }
  for (const entry of catalog.entries) {
    const published = entry.published;
    if (published && (!published.storageKey.startsWith(`storyboard-presets/${entry.presetId}/${published.sha256}/`) || !published.storageKey.endsWith(`/${published.sha256}.${published.mime === "image/jpeg" ? "jpg" : published.mime.slice(6)}`))) {
      ctx.addIssue({ code: "custom", message: "Preset material identity mismatch" });
    }
  }
});
export type StoryboardPresetCatalog = z.infer<typeof StoryboardPresetCatalogSchema>;
export type StoryboardPresetDraft = z.infer<typeof StoryboardPresetDraftSchema>;
export type StoryboardPresetEntry = StoryboardPresetCatalog["entries"][number];
export type StoryboardPresetPublic = Pick<NonNullable<StoryboardPresetEntry["published"]>, "revision" | "role" | "name" | "tags" | "customCategory" | "prompt"> & { presetId: string; previewUrl: string };
export function emptyStoryboardPresetCatalog(): StoryboardPresetCatalog {
  return { schema: "storyboard_preset_asset_catalog.v1", revision: 0, entries: [], audit: [] };
}
/** Classifier only, never an authorization decision. A preset URL requires a
 * descriptor resolved by the server; neither host nor signature proves status. */
export function isStoryboardPresetUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value, "https://storyboard.invalid");
    if (url.pathname === "/api/storyboard/presets" && url.searchParams.has("presetId")) return true;
    let path = url.pathname;
    for (let pass = 0; pass < 3; pass++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    return /(?:^|\/)storyboard-presets(?:\/|$)/u.test(path.replace(/\\/gu, "/"));
  } catch { return false; }
}
export class StoryboardPresetError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}
export function storyboardPresetPublicDto(entry: StoryboardPresetEntry, previewUrl: string): StoryboardPresetPublic {
  if (entry.disabled || !entry.published) throw new StoryboardPresetError("PRESET_NOT_AVAILABLE", "预设尚未发布或已停用", 404);
  const { revision, role, name, tags, customCategory, prompt } = entry.published;
  return { presetId: entry.presetId, revision, role, name, tags, customCategory, prompt, previewUrl };
}
