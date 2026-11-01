import type { StoryboardDirectorInput, StoryboardVerifiedAssetBinding } from "./storyboard-director-protocol";
import { hasStoryboardDirectorAssetConfirmation, storyboardDirectorCandidateMatchesDraft } from "./storyboard-director-asset-confirmation";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pure structure check shared by the browser and authenticated server. The
 * caller must first load the project under the current owner's identity and
 * separately verify every generated-history record. Model/user-provided
 * sources are never inputs to this function.
 */
export function collectStoryboardDirectorReferenceBindings(
  document: unknown,
  expectedInput: StoryboardDirectorInput,
): StoryboardVerifiedAssetBinding[] {
  if (!record(document) || !record(document.directorIntake) || !["assets", "planned"].includes(String(document.directorIntake.phase))
    || !record(document.directorIntake.input)) {
    throw new Error("请先完成本轮已声明角色的三视图资产，再从原项目复制续写卡。");
  }
  const intake = document.directorIntake;
  const savedInput = intake.input as Record<string, unknown>;
  const confirmations = intake.confirmedAssets;
  const inputFields: Array<keyof StoryboardDirectorInput> = [
    "schema_version", "segmented_script", "director_mode", "animation_style", "aspect_ratio", "target_duration_seconds",
    "special_notes", "visual_asset_mode", "video_model_profile", "owner_gender", "dog_breed",
  ];
  if (inputFields.some(key => savedInput[key] !== expectedInput[key])) {
    throw new Error("续写卡与原三视图项目的接收信息不一致，请使用原项目复制的完整续写卡。");
  }
  const plan = document.visualAssetPlan;
  const workspace = document.visualAssetWorkspace;
  if (!record(plan) || plan.mode !== "selected" || !Array.isArray(plan.assets)
    || !record(workspace) || !Array.isArray(workspace.candidates)) {
    throw new Error("角色参考资产尚未采用并保存，请先在原项目完成确认。");
  }
  const assets = plan.assets.filter((asset): asset is Record<string, unknown> => record(asset) && (asset.role === "character" || asset.role === "pet"));
  const candidates: unknown[] = workspace.candidates;
  // The plan owns the required roles. A story may declare only a character or
  // only a pet; do not manufacture the other role at the workbench gate.
  if (!assets.length) {
    throw new Error("参考模式必须先在计划中声明至少一项人物或宠物资产，并完成对应三视图。");
  }
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error("三视图资产标识重复，请在原项目重新核对。");
  return assets.map(asset => {
    const source = asset.source;
    const hasTurnaround = Array.isArray(asset.referencePrompts) && asset.referencePrompts.some(prompt => record(prompt)
      && prompt.kind === "turnaround" && typeof prompt.prompt === "string" && prompt.prompt.trim());
    if (!hasTurnaround || typeof asset.id !== "string" || !record(source) || source.kind !== "generated-image-history"
      || typeof source.assetId !== "string" || typeof source.historyRecordId !== "string" || !/^[a-f0-9]{64}$/u.test(source.historyRecordId)
      || source.assetId !== `generated_${source.historyRecordId}` || source.storageKey !== undefined) {
      throw new Error("人物或宠物三视图尚未生成并采用，不能用上传图片或提示词描述代替实际三视图。");
    }
    const candidate = candidates.find(value => record(value) && value.planId === asset.id
      && value.role === asset.role && value.assetId === source.assetId && value.historyRecordId === source.historyRecordId);
    if (!record(candidate) || candidate.source === "platform-preset"
      || candidate.storageKey !== undefined || intake.phase === "planned" && candidate.projectId !== document.id) {
      throw new Error("已采用的三视图与项目生成候选不匹配，请回到原项目重新确认并保存。");
    }
    if (intake.phase === "planned") {
      const draft = Array.isArray(workspace.drafts) ? workspace.drafts.find(value => record(value) && value.planId === asset.id && value.role === asset.role) : undefined;
      if (!record(draft) || typeof draft.prompt !== "string") throw new Error("角色提示词已改变，请生成并确认与当前提示词一致的三视图。");
      if (!storyboardDirectorCandidateMatchesDraft({ planId: String(candidate.planId), role: String(candidate.role), prompt: String(candidate.prompt || "") },
        { planId: String(draft.planId), role: String(draft.role), prompt: draft.prompt },
        { role: String(asset.role), identityLock: typeof asset.identityLock === "string" ? asset.identityLock : undefined })) throw new Error("三视图与当前角色提示词不一致，请重新生成并逐项确认。");
    }
    if (!hasStoryboardDirectorAssetConfirmation(confirmations, {
      planId: asset.id, sourceAssetId: source.assetId, historyRecordId: source.historyRecordId, role: asset.role as "character" | "pet",
    })) throw new Error(intake.phase === "planned"
      ? "已声明的角色三视图生成后仍需逐项点击“使用这张”并保存，才能继续制作分镜图与视频。"
      : "已声明的角色三视图生成后仍需逐项明确选择采用并保存，才能继续生成分镜提示词。");
    return {
      assetId: asset.id, sourceAssetId: source.assetId, role: asset.role as "character" | "pet", referenceKind: "turnaround",
      historyRecordId: source.historyRecordId,
    };
  });
}
