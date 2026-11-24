import { z } from "zod";

export const PublishingDynamicFieldSchema = z.enum(["tid", "categoryId", "location_id", "boardId", "privacy_level", "community_id", "reply_to_tweet_id"]);
export type PublishingDynamicField = z.infer<typeof PublishingDynamicFieldSchema>;
export const publishingDynamicFieldPlatform: Record<PublishingDynamicField, string> = {
  tid: "bilibili",
  categoryId: "youtube",
  location_id: "threads",
  boardId: "pinterest",
  privacy_level: "tiktok",
  community_id: "twitter",
  reply_to_tweet_id: "twitter",
};

export function publishingDynamicOptionsFilter(field: PublishingDynamicField) {
  if (field === "location_id") return z.object({ keyword: z.string().trim().min(2).max(100) }).strict();
  if (field === "community_id") return z.object({ query: z.string().trim().min(2).max(100) }).strict();
  if (field === "categoryId") return z.object({ regionCode: z.string().regex(/^[A-Z]{2}$/).optional() }).strict();
  return z.object({}).strict();
}

export interface PublishingOptionValue {
  value: string;
  label: string;
  disabled?: boolean;
  children?: PublishingOptionValue[];
}

const optionValue: z.ZodType<PublishingOptionValue> = z.lazy(() => z.object({
  value: z.string().min(1).max(500),
  label: z.string().min(1).max(1000),
  disabled: z.boolean().optional(),
  children: z.array(optionValue).max(1000).optional(),
}).strip());

export const PublishingDynamicOptionsSchema = z.object({
  field: z.string().max(100),
  valueType: z.string().max(100),
  items: z.array(optionValue).max(1000),
});
