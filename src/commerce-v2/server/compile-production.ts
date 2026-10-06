import "server-only";

import { randomUUID } from "node:crypto";

import { validateDirectorMaterialContract } from "../domain/director-material-contract";
import { parseProductionDraft } from "../domain/parse-draft";
import { compileProductionPlan } from "../domain/production-plan";
import { commerceV2DirectorDefinition } from "./director-registry";
import { commerceV2Sha256 } from "./hash";
import { canonicalizeProductionMaterials } from "./material-registry";
import { commerceV2Models } from "./model-catalog-adapter";

export async function compileCommerceV2Production(owner: string, rawDraft: unknown) {
  const draft = canonicalizeProductionMaterials(owner, parseProductionDraft(rawDraft));
  if (!draft.modelId) throw new Error("请选择模型后再核对生产计划");
  const director = draft.director
    ? commerceV2DirectorDefinition(draft.director.skillKey, draft.director.registryVersion, draft.director.promptVersion)
    : null;
  const model = (await commerceV2Models(draft.kind)).find((item) => item.id === draft.modelId);
  if (!model) throw new Error("模型已移除或不属于当前生产类型");
  const plan = compileProductionPlan({
    planId: randomUUID(),
    draft,
    model,
    configurationIssues: director ? validateDirectorMaterialContract(draft.materials, director.slots) : [],
  });
  return { draft, plan, planHash: commerceV2Sha256(plan) };
}
