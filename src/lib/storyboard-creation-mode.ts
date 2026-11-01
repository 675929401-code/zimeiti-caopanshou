import type { StoryboardExecutionMode } from "./storyboard-chain-contract";

export const STORYBOARD_CREATION_MODE_OPTIONS = ["普通模式", "角色参考模式", "串联模式"] as const;

/** Display aliases belong to intake; visualAssetPlan still owns only role assets. */
export function storyboardExecutionModeFromIntake(input: { visual_asset_mode?: unknown }): StoryboardExecutionMode | undefined {
  const value = typeof input.visual_asset_mode === "string" ? input.visual_asset_mode.trim() : "";
  if (["普通模式", "ordinary", "off"].includes(value)) return "ordinary";
  if (["角色参考模式", "角色参考图模式", "参考图模式", "reference", "selected"].includes(value)) return "reference";
  if (["串联模式", "连续串联模式", "chained"].includes(value)) return "chained";
  return undefined;
}
