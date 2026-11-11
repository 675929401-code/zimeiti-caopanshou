import "server-only";
import { compileCoverAnalysisMessages, compileCoverAnalysisInputTemplate, coverAnalysisDependencySnapshot } from "../cover-workbench-prompts";
import { CoverPrepareInputSchema, type CoverPrepareInput } from "../cover-workbench-contract";
import { assertCoverAnalysisMessageBudget } from "./cover-analysis-message-preparation";
import { CoverStyleStoreError, coverStyleHash, runtimeCoverStyle, type CoverStyleCatalog, type CoverStyleRuntime, type CoverWorkflowRelease } from "./cover-style-config";
import { createDefaultCoverWorkflowRelease } from "./cover-style-defaults";

export type CoverAdminPreviewMode = "script" | "product" | "reference" | "compose";
export const COVER_ADMIN_PREVIEW_TEXT = "以前总把工作拖到最后，现在每天先做十分钟，终于开始行动。";

/** Synthetic bindings only: this function never reads an asset or a provider. */
export function coverAdminPreviewMaterials(mode: CoverAdminPreviewMode, styleKey = "cartoon", text = COVER_ADMIN_PREVIEW_TEXT): CoverPrepareInput {
  const assets = mode === "reference" || mode === "compose" ? [
    { assetId: "00000000-0000-4000-8000-000000000001", role: mode === "compose" ? "identity_subject" : "style_reference", imageNumber: 1 },
    ...(mode === "compose" ? [{ assetId: "00000000-0000-4000-8000-000000000002", role: "background_canvas", imageNumber: 2 }] : []),
  ] : [];
  return CoverPrepareInputSchema.parse({ clientRequestId: "admin_compiler_preview", materialRevision: 1, text, styleKey,
    ...(mode === "product" ? { contentKind: "product" } : {}), ...(mode === "compose" ? { imageMode: "compose" } : {}), assets, outputRatio: "3:4" });
}

export function compileCoverAdminPreview(materials: CoverPrepareInput, workflow: CoverWorkflowRelease, style?: CoverStyleRuntime,
  limits: { maxContextTokens?: number; maxReplyTokens?: number } = {}) {
  const messages = compileCoverAnalysisMessages(materials, [], style, workflow);
  const template = compileCoverAnalysisInputTemplate(materials, [], style, workflow);
  // Text separators used only to display the preview are not provider input.
  const textUnits = template.systemPrompt.length + (template.parts
    ? template.parts.reduce((total, part) => total + (part.type === "text" ? part.text.length : 0), 0) : template.userMessage.length);
  try { assertCoverAnalysisMessageBudget(textUnits, materials.assets.length, limits); }
  catch { throw new CoverStyleStoreError("COVER_WORKFLOW_CONTEXT_EXCEEDED", "共用规则、风格规则与材料超过分析上下文预算，请缩短规则或材料", 422); }
  return { messages, template, textUnits };
}

/** Estimate PostgreSQL JSONB separator expansion, retaining a fixed margin. */
export function assertCoverPrivateSnapshotBudget(value: unknown, reservedBytes = 0) {
  const json = JSON.stringify(value); let inside = false, escaped = false, separators = 0;
  for (const char of json) {
    if (inside) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') inside = false; }
    else if (char === '"') inside = true; else if (char === "," || char === ":") separators++;
  }
  if (Buffer.byteLength(json, "utf8") + separators + 512 + reservedBytes > 131_072)
    throw new CoverStyleStoreError("COVER_WORKFLOW_SNAPSHOT_EXCEEDED", "完整私有规则快照超过保存预算，请缩短分析或生图规则", 422);
}

function publicationSnapshotCore(materials: CoverPrepareInput, workflow: CoverWorkflowRelease, runtime?: CoverStyleRuntime) {
  const snapshot = coverAnalysisDependencySnapshot(materials, runtime, workflow);
  // Match preparation's existing omission of the third promptPack copy.
  const { promptPack, ...identity } = snapshot;
  return { frozenWorkflowRuntime: workflow, ...(runtime ? { frozenStyleRuntime: runtime, style: runtime.style } : {}),
    promptDependencies: runtime ? { ...identity, promptPackFingerprint: coverStyleHash(promptPack) } : snapshot };
}

/** Pure store guard. It must not import the store, database or model gateway. */
export function validateCoverWorkflowPublication(catalog: CoverStyleCatalog): void {
  const current = catalog.workflow?.current;
  const workflow = catalog.workflow ? catalog.workflow.releases.find(release => release.releaseId === current?.releaseId) : createDefaultCoverWorkflowRelease();
  if (!workflow) throw new CoverStyleStoreError("COVER_WORKFLOW_UNAVAILABLE", "共用拆解规则尚未发布", 409);
  assertCoverPrivateSnapshotBudget(publicationSnapshotCore(coverAdminPreviewMaterials("product"), workflow), 16_384);
  for (const mode of ["product", "reference", "compose"] as const) compileCoverAdminPreview(coverAdminPreviewMaterials(mode), workflow);
  for (const entry of catalog.entries.filter(item => item.enabled && item.current)) {
      const release = entry.releases.find(item => item.releaseId === entry.current!.releaseId);
      if (!release) throw new CoverStyleStoreError("COVER_STYLE_RELEASE_INVALID", "风格版本无法核对", 409);
      const runtime = runtimeCoverStyle(release, entry.current!.publishedAt);
      const materials = coverAdminPreviewMaterials("script", entry.styleKey);
      assertCoverPrivateSnapshotBudget(publicationSnapshotCore(materials, workflow, runtime), 16_384);
      compileCoverAdminPreview(materials, workflow, runtime);
  }
}
