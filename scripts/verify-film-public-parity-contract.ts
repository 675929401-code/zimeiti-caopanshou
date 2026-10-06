import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AssembleProductionFinalRequestSchema,
  DeleteProductionTakeRequestSchema,
  GenerateProductionEntityImageRequestSchema,
  ProductionActionRequestSchema,
  ProductionTimelineClipSchema,
  SaveProductionTimelineRequestSchema,
  UpdateProductionTakeRequestSchema,
} from "../src/lib/short-drama/production-contracts";
import {
  resolveVideoStylePrompt,
  VIDEO_STYLES,
} from "../src/lib/short-drama/video-style-presets";

const root = process.cwd();
const shotId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const entityId = "33333333-3333-4333-8333-333333333333";

function clip(index: number) {
  return {
    id: `timeline-${String(index).padStart(4, "0")}`,
    shotId,
    assetId,
    enabled: true,
    startSeconds: 0,
    endSeconds: 5,
  };
}

const checks: string[] = [];
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks.push(name);
}

check("timeline clip accepts a valid owned-asset-shaped reference", ProductionTimelineClipSchema.safeParse(clip(1)).success);
check("timeline clip rejects a non-positive range", !ProductionTimelineClipSchema.safeParse({ ...clip(1), startSeconds: 5, endSeconds: 5 }).success);
check("timeline saves up to 240 clips", SaveProductionTimelineRequestSchema.safeParse({
  action: "save_timeline",
  expectedProjectRevision: 3,
  clips: Array.from({ length: 240 }, (_, index) => clip(index)),
}).success);
check("timeline rejects more than 240 clips", !SaveProductionTimelineRequestSchema.safeParse({
  action: "save_timeline",
  expectedProjectRevision: 3,
  clips: Array.from({ length: 241 }, (_, index) => clip(index)),
}).success);
check("TAKE update requires a managed field", !UpdateProductionTakeRequestSchema.safeParse({
  action: "update_take",
  shotId,
  assetId,
  expectedShotRevision: 1,
}).success);
check("TAKE update accepts selection rating and note", UpdateProductionTakeRequestSchema.safeParse({
  action: "update_take",
  shotId,
  assetId,
  expectedShotRevision: 1,
  selected: true,
  rating: 5,
  note: "主 TAKE",
}).success);
check("TAKE deletion rejects unknown fields", !DeleteProductionTakeRequestSchema.safeParse({
  action: "delete_take",
  shotId,
  assetId,
  expectedShotRevision: 1,
  hardDelete: true,
}).success);
check("final assembly accepts the exact edited timeline", AssembleProductionFinalRequestSchema.safeParse({
  action: "assemble_final",
  clientRequestId: "final-contract-0001",
  burnSubtitles: true,
  timeline: [clip(1)],
}).success);
check("action union dispatches timeline save", ProductionActionRequestSchema.safeParse({
  action: "save_timeline",
  expectedProjectRevision: 3,
  clips: [clip(1)],
}).success);
check("entity image generation accepts a revision guarded idempotent request", GenerateProductionEntityImageRequestSchema.safeParse({
  action: "generate_entity_image",
  entityId,
  expectedEntityRevision: 2,
  clientRequestId: "entity-contract-0001",
  modelId: "cover-contract-model",
  resolution: "1K",
  mode: "repaint",
  layout: "three_view",
}).success);
check("entity image generation rejects an invalid entity id", !GenerateProductionEntityImageRequestSchema.safeParse({
  action: "generate_entity_image",
  entityId: "not-an-entity",
  expectedEntityRevision: 2,
  clientRequestId: "entity-contract-0002",
  modelId: "cover-contract-model",
  mode: "generate",
}).success);
check("public baseline exposes exactly 39 visual styles", VIDEO_STYLES.length === 39);
check("visual style categories match 16 live-action 12 2D and 11 3D", [
  VIDEO_STYLES.filter((style) => style.category === "live-action").length,
  VIDEO_STYLES.filter((style) => style.category === "2d").length,
  VIDEO_STYLES.filter((style) => style.category === "3d").length,
].join(",") === "16,12,11");
check("style ids labels and persisted prompt values are unique", [
  new Set(VIDEO_STYLES.map((style) => style.id)).size,
  new Set(VIDEO_STYLES.map((style) => style.label)).size,
  new Set(VIDEO_STYLES.map((style) => style.promptValue)).size,
].every((count) => count === VIDEO_STYLES.length));
check("style preset resolves to a richer model prompt", resolveVideoStylePrompt(VIDEO_STYLES[0].promptValue).length > VIDEO_STYLES[0].promptValue.length);

async function main() {
const sources = Object.fromEntries(await Promise.all([
  "src/features/film-studio-project/film-studio-entity-panel.tsx",
  "src/features/film-studio-project/film-studio-shot-panel.tsx",
  "src/features/film-studio-project/film-studio-production-panel.tsx",
  "src/features/film-studio-project/film-studio-project-workbench.tsx",
  "src/components/video-style-picker.tsx",
  "src/features/general-script/general-script-workbench.tsx",
  "src/features/upload-script/upload-script-workbench.tsx",
  "src/features/youcai-general-script/youcai-general-script.tsx",
  "src/features/youcai-upload-script/youcai-upload-script.tsx",
  "src/features/youcai-drama-script/youcai-drama-script-wizard.tsx",
  "src/app/api/short-drama/drama-script/route.ts",
  "src/lib/short-drama/general-script-storyboard-bridge.ts",
  "src/lib/short-drama/production-service.ts",
  "src/lib/short-drama/production-repository.ts",
  "src/app/api/image/generate/route.ts",
  "src/app/api/drama/projects/previews/route.ts",
  "src/app/api/short-drama/projects/[projectId]/production/route.ts",
  "src/app/api/short-drama/projects/[projectId]/route.ts",
  "src/features/youcai-film-studio/youcai-film-studio-portal.tsx",
].map(async (relative) => [relative, await readFile(path.join(root, relative), "utf8")] as const)));

check("entity editor persists image versions", sources["src/features/film-studio-project/film-studio-entity-panel.tsx"].includes("assetVersions"));
check("entity versions use private owned upload route", sources["src/features/film-studio-project/film-studio-entity-panel.tsx"].includes('/api/video/reference-upload'));
check("entity editor exposes model quote generation repaint and batch fill", ["generate_entity_image", "参考重绘", "批量补齐首图", "单次公开报价"].every((text) => sources["src/features/film-studio-project/film-studio-entity-panel.tsx"].includes(text)));
check("character and prop generation expose the public three-view layout", sources["src/features/film-studio-project/film-studio-entity-panel.tsx"].includes("三视图设定稿")
  && sources["src/lib/short-drama/production-service.ts"].includes("正面、侧面、背面三栏"));
check("entity generation is task first and does not auto retry unknown paid calls", sources["src/lib/short-drama/production-service.ts"].includes('stage: "entity_design"')
  && sources["src/lib/short-drama/production-service.ts"].includes("strictSingleSubmit: true")
  && sources["src/features/film-studio-project/film-studio-entity-panel.tsx"].includes("核对原请求"));
check("entity generation persists stable assets versions and settlements", ["persistEntityImageJob", "createSettlement", "assetVersions", "stableUri"].every((text) => sources["src/lib/short-drama/production-service.ts"].includes(text)));
check("production route dispatches entity image generation", sources["src/app/api/short-drama/projects/[projectId]/production/route.ts"].includes("generateProductionEntityImage"));
check("shot editor limits references to nine", /\.slice\(0,\s*9\)/.test(sources["src/features/film-studio-project/film-studio-shot-panel.tsx"])
  && /referenceAssetUris\.length\s*<\s*9/.test(sources["src/features/film-studio-project/film-studio-shot-panel.tsx"]));
check("image gateway preserves nine references", /\.slice\(0,\s*9\)/.test(sources["src/app/api/image/generate/route.ts"]));
check("production verifies and signs owned reference assets", sources["src/lib/short-drama/production-service.ts"].includes("signAutodlH3OwnedAssetRefForUser"));
check("TAKE deletion is soft deletion", sources["src/lib/short-drama/production-repository.ts"].includes("deleted_at: new Date().toISOString()"));
check("shot TAKE selection is revision guarded", sources["src/lib/short-drama/production-repository.ts"].includes('.eq("revision", expectedRevision)'));
check("timeline export performs real FFmpeg trim", sources["src/lib/short-drama/production-service.ts"].includes('action: "trim"'));
check("timeline is persisted in project source payload", sources["src/lib/short-drama/production-service.ts"].includes("productionTimelineUpdatedAt"));
check("production route dispatches all TAKE and timeline actions", ["updateProductionTake", "deleteProductionTake", "saveProductionTimeline"].every((name) => sources["src/app/api/short-drama/projects/[projectId]/production/route.ts"].includes(name)));
check("workbench exposes TAKE manager", sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes("film-takes-"));
check("workbench exposes editable timeline", sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes('data-testid="film-studio-timeline-editor"'));
check("storyboard supports selected-shot batch image and video generation", ["批量生图", "批量视频", "selectedShotIds", "startBatchGeneration"].every((text) => sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes(text)));
check("batch generation stops on unknown status and reuses original request ids", sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes("BATCH_STATUS_UNKNOWN")
  && sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes("继续核对原批量请求"));
check("project library defaults to submission time and loads owned durable previews", sources["src/features/youcai-film-studio/youcai-film-studio-portal.tsx"].includes('useState<ProjectSort>("created-desc")')
  && sources["src/features/youcai-film-studio/youcai-film-studio-portal.tsx"].includes("/api/drama/projects/previews"));
check("project preview endpoint is owner scoped and signs stable assets", sources["src/app/api/drama/projects/previews/route.ts"].includes('.eq("user_id", auth.userId)')
  && sources["src/app/api/drama/projects/previews/route.ts"].includes("storageManager.getSignedUrl"));
check("project library deletion is revision guarded and blocks active jobs", sources["src/features/youcai-film-studio/youcai-film-studio-portal.tsx"].includes("expectedRevision=${project.revision}")
  && sources["src/app/api/short-drama/projects/[projectId]/route.ts"].includes("assertNoActiveProjectJobs"));
check("production history is submission sorted with preview recovery and failed retry", [
  'data-testid="film-production-job-history"',
  "formatSubmittedAt",
  "retryFailedJob",
  "核对原任务",
].every((text) => sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes(text)));
check("history retry preserves one request id after unknown network status", sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes("retryRequestIdsRef")
  && sources["src/features/film-studio-project/film-studio-production-panel.tsx"].includes("HISTORY_RETRY_STATUS_UNKNOWN"));
check("style picker exposes grouped presets and custom input", ["VIDEO_STYLE_CATEGORIES", "optgroup", "自定义风格"].every((text) =>
  sources["src/components/video-style-picker.tsx"].includes(text)));
check("all script creation entries persist the selected style", [
  sources["src/features/general-script/general-script-workbench.tsx"],
  sources["src/features/upload-script/upload-script-workbench.tsx"],
  sources["src/features/youcai-general-script/youcai-general-script.tsx"],
  sources["src/features/youcai-upload-script/youcai-upload-script.tsx"],
  sources["src/features/youcai-drama-script/youcai-drama-script-wizard.tsx"],
].every((source) => source.includes("VideoStylePicker") && source.includes("animationStyle")));
check("drama script API preserves the selected visual style", sources["src/app/api/short-drama/drama-script/route.ts"].includes("animationStyle: task.input.animationStyle"));
check("storyboard and entity prompts receive the resolved visual style", sources["src/lib/short-drama/general-script-storyboard-bridge.ts"].includes("resolveVideoStylePrompt")
  && sources["src/lib/short-drama/production-service.ts"].includes("resolveVideoStylePrompt(animationStyle)"));
check("project script editor supports style changes and full-script copy", ["VideoStylePicker", "复制全本", "navigator.clipboard.writeText"].every((text) =>
  sources["src/features/film-studio-project/film-studio-project-workbench.tsx"].includes(text)));

console.log(JSON.stringify({
  status: "PASS",
  checks: checks.length,
  paidModelCalls: 0,
  databaseWrites: 0,
  scope: "public YouCai parity contracts for entity versions, 9 references, TAKE management, timeline persistence, FFmpeg export, durable previews, and retry history",
}, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
