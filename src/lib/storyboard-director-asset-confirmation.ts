import { z } from "zod";
import type { StoryboardDirectorIntakeState } from "./storyboard-director-resume";
import type { StoryboardVisualAssetPlan } from "./storyboard-workbench";
import type { StoryboardVisualAssetWorkspace } from "./storyboard-visual-asset-workspace";
import { buildStoryboardThreeViewPrompt } from "./storyboard-visual-asset-three-view";

export const StoryboardDirectorAssetConfirmationSchema = z.object({
  planId: z.string().min(1).max(200),
  sourceAssetId: z.string().min(1).max(200),
  historyRecordId: z.string().regex(/^[a-f0-9]{64}$/u),
  role: z.enum(["character", "pet"]),
  confirmedAt: z.string().datetime({ offset: true }),
}).strict();
export type StoryboardDirectorAssetConfirmation = z.infer<typeof StoryboardDirectorAssetConfirmationSchema>;

type AssetRun = {
  id?: string;
  directorIntake?: StoryboardDirectorIntakeState;
  visualAssetPlan?: StoryboardVisualAssetPlan;
  visualAssetWorkspace?: StoryboardVisualAssetWorkspace;
};

export function storyboardDirectorCandidateMatchesDraft(
  candidate: { planId: string; role: string; prompt?: string },
  draft: { planId: string; role: string; prompt: string } | undefined,
  asset: { role: string; identityLock?: string } | undefined,
): boolean {
  if (!asset || !draft || draft.planId !== candidate.planId || draft.role !== candidate.role || draft.role !== asset.role
    || (asset.role !== "character" && asset.role !== "pet") || !draft.prompt.trim()) return false;
  const direct = buildStoryboardThreeViewPrompt(asset.role, undefined, draft.prompt, false);
  const referenced = buildStoryboardThreeViewPrompt(asset.role, undefined, draft.prompt, true);
  const locked = `${referenced}\n身份锁定：${asset.identityLock?.trim()}；除允许变化外保持一致。`;
  return [direct, referenced, locked].includes(candidate.prompt || "");
}

function generatedBinding(run: AssetRun, planId: string) {
  const asset = run.visualAssetPlan?.mode === "selected" ? run.visualAssetPlan.assets.find(item => item.id === planId) : undefined;
  const source = asset?.source;
  if (!asset || (asset.role !== "character" && asset.role !== "pet") || source?.kind !== "generated-image-history"
    || !/^[a-f0-9]{64}$/u.test(source.historyRecordId || "") || source.assetId !== `generated_${source.historyRecordId}` || source.storageKey !== undefined
    || !asset.referencePrompts.some(prompt => prompt.kind === "turnaround" && prompt.prompt.trim())) return undefined;
  const candidate = run.visualAssetWorkspace?.candidates.find(item => item.planId === planId && item.role === asset.role
    && item.assetId === source.assetId && item.historyRecordId === source.historyRecordId && item.source !== "platform-preset"
    && item.storageKey === undefined && (run.directorIntake?.phase !== "planned" || item.projectId === run.id));
  if (!candidate) return undefined;
  if (run.directorIntake?.phase === "planned") {
    const draft = run.visualAssetWorkspace?.drafts.find(item => item.planId === planId && item.role === asset.role);
    if (!storyboardDirectorCandidateMatchesDraft(candidate, draft, asset)) return undefined;
  }
  return { planId, sourceAssetId: source.assetId, historyRecordId: source.historyRecordId!, role: asset.role };
}

/** Prunes stale sources; explicit removal must also pass the removed plan ID. */
export function pruneStoryboardDirectorAssetConfirmations(run: AssetRun, removedPlanId?: string): StoryboardDirectorIntakeState | undefined {
  const intake = run.directorIntake;
  if (!intake || !["assets", "planned"].includes(intake.phase)) return intake;
  return { ...intake, confirmedAssets: (intake.confirmedAssets || []).filter(confirmation => {
    if (confirmation.planId === removedPlanId) return false;
    const binding = generatedBinding(run, confirmation.planId);
    return binding && binding.sourceAssetId === confirmation.sourceAssetId && binding.historyRecordId === confirmation.historyRecordId
      && binding.role === confirmation.role;
  }) };
}

/** Call only from explicit Apply, with the updated source and workspace, in the same saved transaction. */
export function confirmStoryboardDirectorAsset(run: AssetRun, planId: string, confirmedAt: string): StoryboardDirectorIntakeState | undefined {
  const intake = pruneStoryboardDirectorAssetConfirmations(run);
  if (!intake || !["assets", "planned"].includes(intake.phase)) return intake;
  const binding = generatedBinding(run, planId);
  if (!binding) throw new Error("请先生成该角色的三视图，再明确选择采用；上传图片与预设不能作为生成确认。");
  const confirmation = StoryboardDirectorAssetConfirmationSchema.parse({ ...binding, confirmedAt });
  return { ...intake, confirmedAssets: [...(intake.confirmedAssets || []).filter(item => item.planId !== planId), confirmation] };
}

export function hasStoryboardDirectorAssetConfirmation(confirmations: unknown, binding: {
  planId: string; sourceAssetId: string; historyRecordId: string; role: "character" | "pet";
}): boolean {
  if (!Array.isArray(confirmations)) return false;
  const parsed = confirmations.map(value => StoryboardDirectorAssetConfirmationSchema.safeParse(value));
  const matching = parsed.filter(result => result.success && result.data.planId === binding.planId);
  return matching.length === 1 && matching.some(result => result.success && result.data.sourceAssetId === binding.sourceAssetId
    && result.data.historyRecordId === binding.historyRecordId && result.data.role === binding.role);
}
