import { z } from "zod";
import type { StoryboardVisualAssetPlan } from "./storyboard-workbench";
import type { StoryboardVisualAssetWorkspace } from "./storyboard-visual-asset-workspace";
import { StoryboardDirectorAssetConfirmationSchema } from "./storyboard-director-asset-confirmation";
import { collectStoryboardDirectorReferenceBindings } from "./storyboard-director-reference-verification";

export const StoryboardDirectorIntakeStateSchema = z.object({
  phase: z.enum(["assets", "planned"]),
  sourceMessageId: z.string().max(200),
  confirmedAssets: z.array(StoryboardDirectorAssetConfirmationSchema).max(32).optional(),
  input: z.object({
    schema_version: z.literal("storyboard_director_input.v1"),
    segmented_script: z.string().min(1).max(100000),
    director_mode: z.enum(["high_energy", "cinematic", "lyrical"]),
    animation_style: z.string().min(1).max(500),
    aspect_ratio: z.enum(["16:9", "9:16"]),
    target_duration_seconds: z.union([z.literal(8), z.literal(10), z.literal(15)]),
    special_notes: z.string().max(10000),
    owner_gender: z.string().max(200).optional(),
    dog_breed: z.string().max(200).optional(),
    video_model_profile: z.string().max(200).optional(),
    visual_asset_mode: z.string().max(200).optional(),
  }).strict(),
}).strict();
export type StoryboardDirectorIntakeState = z.infer<typeof StoryboardDirectorIntakeStateSchema>;

/** This creates a lookup request, never a client-signed proof of generated media. */
export function buildStoryboardDirectorResumeCard(run: {
  id: string;
  directorIntake?: StoryboardDirectorIntakeState;
  visualAssetPlan?: StoryboardVisualAssetPlan;
  visualAssetWorkspace?: StoryboardVisualAssetWorkspace;
}): string {
  const intake = StoryboardDirectorIntakeStateSchema.parse(run.directorIntake);
  collectStoryboardDirectorReferenceBindings(run, intake.input);
  const input = intake.input;
  const keys = ["segmented_script", "director_mode", "animation_style", "aspect_ratio", "target_duration_seconds", "owner_gender", "dog_breed", "video_model_profile", "visual_asset_mode", "special_notes"] as const;
  return [
    "```director_assets_receipt",
    JSON.stringify({ projectId: run.id }),
    "```",
    ...keys.map(key => `${key}: ${input[key] ?? ""}`),
  ].join("\n");
}
