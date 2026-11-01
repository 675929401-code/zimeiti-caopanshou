import type { StoryboardProject, StoryboardVisualAssetMode, StoryboardVisualAssetPlan } from "./storyboard-workbench";

type StoryboardCompileVisualAssetProject = Pick<StoryboardProject, "visualAssetPlan"> & {
  segments: Array<Pick<StoryboardProject["segments"][number], "visualAssetRefs">>;
};

type StoryboardCompileVisualAssetInput = {
  visualAssetMode: StoryboardVisualAssetMode;
  selectedVisualAssets: Array<Pick<StoryboardVisualAssetPlan["assets"][number], "id" | "role">>;
};

export function assertVisualAssetContract(
  project: StoryboardCompileVisualAssetProject,
  input: StoryboardCompileVisualAssetInput,
) {
  if (project.visualAssetPlan.mode !== input.visualAssetMode) {
    throw new Error(`视觉资产模式不一致：请求 ${input.visualAssetMode}，智能体返回 ${project.visualAssetPlan.mode}`);
  }
  const selectedById = new Map(input.selectedVisualAssets.map((asset) => [asset.id, asset]));
  const assetsById = new Map(project.visualAssetPlan.assets.map((asset) => [asset.id, asset]));
  if (input.visualAssetMode === "off" && (project.visualAssetPlan.assets.length || project.segments.some((segment) => segment.visualAssetRefs.length))) {
    throw new Error("视觉资产模式关闭时不得返回资产计划或分镜资产引用");
  }
  if (input.visualAssetMode === "selected") {
    const policy = project.visualAssetPlan.generationPolicy;
    if (!policy) {
      throw new Error("角色参考模式必须返回首轮三视图生成策略");
    }
    const actorAssets = project.visualAssetPlan.assets.filter((asset) => asset.role === "character" || asset.role === "pet");
    if (!actorAssets.length) {
      throw new Error("角色参考模式至少需要一项人物或宠物资产，并完成对应三视图");
    }
    const requiredIds = new Set(policy.initialRequiredAssetIds);
    if (actorAssets.some((asset) => !asset.referencePrompts.some((reference) => reference.kind === "turnaround"))) {
      throw new Error("角色参考模式中的人物或宠物必须提供三视图参考提示词");
    }
    if (actorAssets.some((asset) => !requiredIds.has(asset.id))) {
      throw new Error("角色参考模式中的人物或宠物必须列入首轮三视图生成清单");
    }
    if (actorAssets.length > policy.maxInitialImages) {
      throw new Error("首轮三视图数量超过生成上限，请减少角色资产或提高首轮上限");
    }
  }
  for (const asset of project.visualAssetPlan.assets) {
    const selected = selectedById.get(asset.id);
    if (selected && selected.role !== asset.role) {
      throw new Error(`视觉资产 ${asset.id} 的角色类型与用户选择不一致`);
    }
    if (input.selectedVisualAssets.length > 0 && !selected) {
      throw new Error(`智能体返回了未选择的视觉资产：${asset.id}`);
    }
  }
  for (const [segmentIndex, segment] of project.segments.entries()) {
    const seen = new Set<string>();
    for (const ref of segment.visualAssetRefs) {
      const key = `${ref.assetId}:${ref.role}`;
      if (seen.has(key)) throw new Error(`片段 ${segmentIndex + 1} 重复绑定视觉资产 ${ref.assetId}`);
      seen.add(key);
      const asset = assetsById.get(ref.assetId);
      if (!asset) throw new Error(`片段 ${segmentIndex + 1} 引用了不存在的视觉资产 ${ref.assetId}`);
      if (asset.role !== ref.role) throw new Error(`片段 ${segmentIndex + 1} 的资产 ${ref.assetId} 角色类型不一致`);
    }
  }
}
