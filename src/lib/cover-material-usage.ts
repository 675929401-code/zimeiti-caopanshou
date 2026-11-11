import { z } from "zod";
import { resolveCoverMaterialBindings, type CoverMaterialBindingInput, type CoverMaterialCompositionRole } from "./cover-material-composition";

export const CoverMaterialUsageSchema = z.array(z.object({
  assetId: z.string().uuid(), imageNumber: z.number().int().min(1).max(99),
  role: z.enum(["identity_subject", "background_canvas", "style_reference"]),
  source: z.enum(["explicit_user", "ui_role"]),
  evidenceRefs: z.array(z.string().trim().min(1).max(100)).max(20),
}).strict()).max(6);
export type CoverMaterialUsage = z.infer<typeof CoverMaterialUsageSchema>;
type Evidence = { id: string; source: string; quote: string };
export class CoverMaterialUsageError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CoverMaterialUsageError"; }
}
const refuse = (code: string, message: string): never => { throw new CoverMaterialUsageError(code, message); };

/** Language is resolved by actual analysis. This only validates the current
 * source and exact number/asset binding; it never infers roles from keywords. */
export function validateCoverMaterialUsage(usage: CoverMaterialUsage, materials: CoverMaterialBindingInput, evidence: readonly Evidence[]) {
  const bindings = resolveCoverMaterialBindings(materials);
  const assigned = new Map<string, CoverMaterialCompositionRole>();
  for (const entry of usage) {
    const binding = bindings.images.find(image => image.assetId === entry.assetId && image.imageNumber === entry.imageNumber);
    if (!binding) refuse("COVER_MATERIAL_USAGE_BINDING_INVALID", "图片用途中的编号与当前素材不一致，请保留材料重新核对");
    if (assigned.has(entry.assetId)) return refuse("COVER_MATERIAL_ROLE_CONFLICT", `@图${entry.imageNumber}收到多个用途结论，请明确它用于保留外观、场景还是参考风格`);
    assigned.set(entry.assetId, entry.role);
    if (new Set(entry.evidenceRefs).size !== entry.evidenceRefs.length) refuse("COVER_MATERIAL_USAGE_EVIDENCE_INVALID", "图片用途引用了重复依据");
    if (entry.source === "ui_role") {
      if (entry.role !== binding!.role || entry.evidenceRefs.length) refuse("COVER_MATERIAL_USAGE_EVIDENCE_INVALID", "未明确指定用途的图片只能保留原用途提示");
      continue;
    }
    if (!entry.evidenceRefs.length) refuse("COVER_MATERIAL_USAGE_EVIDENCE_INVALID", "明确指定的图片用途需要引用当前用户原文");
    for (const reference of entry.evidenceRefs) {
      const quoted = evidence.find(item => item.id === reference);
      if (!quoted || quoted.source !== "text" || !quoted.quote.trim() || !materials.text.includes(quoted.quote)) refuse("COVER_MATERIAL_USAGE_EVIDENCE_INVALID", "图片用途必须引用当前用户原文，不能依据图片OCR、旧回复或其他材料改用途");
      const actualReferences = resolveCoverMaterialBindings({ ...materials, text: quoted!.quote }).references;
      if (!actualReferences.some(item => item.assetId === entry.assetId && item.imageNumber === entry.imageNumber)) refuse("COVER_MATERIAL_USAGE_EVIDENCE_INVALID", `@图${entry.imageNumber}的用途依据没有引用这张图片，不能引用相邻图片代替`);
    }
  }
  if (usage.length !== bindings.images.length || bindings.images.some(image => !assigned.has(image.assetId))) refuse("COVER_MATERIAL_USAGE_INCOMPLETE", "图片用途未覆盖全部材料，请保留输入核对每张图片后继续");
  return usage;
}

/** Change only verified roles. Order, asset IDs, stable numbers and original
 * material fields remain frozen; historical replies without usage stay valid. */
export function coverMaterialsWithUsage<T extends CoverMaterialBindingInput>(materials: T, usage?: CoverMaterialUsage): T {
  if (!usage) return materials;
  return { ...materials, assets: materials.assets.map(asset => ({ ...asset,
    role: usage.find(entry => entry.assetId === asset.assetId)?.role ?? asset.role })) };
}
