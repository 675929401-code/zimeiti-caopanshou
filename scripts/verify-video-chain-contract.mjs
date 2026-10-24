import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const route = fs.readFileSync(path.join(root, "src/app/api/video/generate/route.ts"), "utf8");
const modelsRoute = fs.readFileSync(path.join(root, "src/app/api/video/models/route.ts"), "utf8");
const adminModelsRoute = fs.readFileSync(path.join(root, "src/app/api/admin/workspace-models/route.ts"), "utf8");
const adminModelsUi = fs.readFileSync(path.join(root, "src/components/admin/WorkspaceModelsAdminTab.tsx"), "utf8");
const workbench = fs.readFileSync(path.join(root, "src/components/storyboard-workbench.tsx"), "utf8");
const adapter = fs.readFileSync(path.join(root, "src/lib/video-adapter.ts"), "utf8");

const checks = [
  ["required image gate is fail-closed", route.includes("const inputViolation = validateVideoInputContract") && route.includes("error_code: inputViolation.code") && route.includes("task_submitted: false")],
  ["H3 public asset bridge is explicit", route.includes("isAutodlComfyuiHostedProtocol") && route.includes('providerType: "tencent_cos"') && route.includes("publicRead: true")],
  ["H3 bridge rejects non-public fallback", route.includes('result.provider !== "tencent_cos"') && route.includes("isPublicVideoAssetUrl(result.url)")],
  ["raw URL fallback removed", !route.includes("使用原始URL") && !route.includes("使用原始 URL")],
  ["all reference image fields reach submit", route.includes("effectiveReferenceImageUrls") && route.includes("imageUrls: effectiveReferenceImageUrls")],
  ["batch video freezes authorization and uses the same validation path", workbench.includes("runVideoBatch = useCallback(async (cardIds: string[], authorization: StoryboardBatchAuthorization)") && workbench.includes("prepareAndGenerateVideo(cardIds[index], authorization)") && workbench.includes("assertBatchSnapshotCurrent(current, cardId, \"videos\", batchAuthorization)") && workbench.includes("!hasValidatedImage(card)") && workbench.includes("generateVideo(cardId, batchAuthorization, true)") && workbench.includes("batchAuthorizationRef.current = authorization")],
  ["switching video model unlocks failed cards", workbench.includes("resetFailedVideoCardsForModelSwitch") && workbench.includes("failedVideoCards") && workbench.includes("videoTaskId: undefined")],
  ["adapter maps H3 reference inputs", adapter.includes("ref_image_") && adapter.includes("referenceImageUrl") && adapter.includes("imageUrls")],
  ["catalog keeps configured models available without an acceptance evidence gate", !modelsRoute.includes('from("video_channel_health")') && !modelsRoute.includes("evaluateVideoChannelCircuit(health)") && modelsRoute.includes("const generationReady = available") && !modelsRoute.includes("activationReady: model.activationReady") && modelsRoute.includes("generationReady: model.generationReady") && !route.includes("inspectVideoModelActivationReadiness")],
  ["workspace admin keeps acceptance evidence diagnostic only", adminModelsRoute.includes("inspectVideoModelActivationReadiness(activationBinding)") && !adminModelsRoute.includes("&& activation.ready") && adminModelsRoute.includes("activationReady: activation.ready")],
  ["assigned unready models stay visible but are clearly non-submittable", adminModelsRoute.includes("model.publishable || model.assigned") && adminModelsUi.includes("已添加，但当前不可提交") && adminModelsUi.includes("model.availabilityMessage")],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (failed.length) process.exit(1);
console.log(`video chain contract passed (${checks.length} checks)`);
