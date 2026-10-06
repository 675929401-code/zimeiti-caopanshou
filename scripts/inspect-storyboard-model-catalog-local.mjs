import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
const headers = { Authorization: `Bearer ${token}` };

async function api(pathname) {
  const response = await fetch(`${origin}${pathname}`, { headers, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, body.error || `${pathname} returned ${response.status}`);
  return body;
}

async function optionalStepUpApi(pathname) {
  const response = await fetch(`${origin}${pathname}`, { headers, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      optionalReadUnavailable: true,
      status: response.status,
      code: String(body.code || "").slice(0, 80),
      stepUpRequired: body.code === "ADMIN_STEP_UP_REQUIRED" || /重新验证管理员密码/u.test(String(body.error || "")),
    };
  }
  return body;
}

const [admin, publicImages, publicVideos] = await Promise.all([
  api("/api/admin/workspace-models"),
  api("/api/cover-models?surface=storyboard-workbench"),
  api("/api/video/models?surface=storyboard-workbench"),
]);
const videoSurface = admin.surfaces?.find((surface) => surface.id === "storyboard-video");
const imageSurface = admin.surfaces?.find((surface) => surface.id === "storyboard-image");
assert.ok(videoSurface && imageSurface, "STORYBOARD_SURFACES_REQUIRED");
const workbookVideoIds = new Set([
  "seedance-2-5-480p-i2v-lconai",
  "seedance-2-0-fast-720p-i2v-lconai",
  "grok-video-3-pro-lconai",
]);

function adminProjection(model) {
  return {
    id: model.id,
    name: model.name,
    assigned: model.assigned === true,
    active: model.active === true,
    hidden: model.hidden === true,
    visibleNow: model.visibleNow === true,
    catalogDisplayable: model.catalogDisplayable === true,
    publishable: model.publishable === true,
    providerHost: model.providerHost || null,
    availabilityMessage: model.availabilityMessage || "",
    priceLabels: Array.isArray(model.priceLabels) ? model.priceLabels : [],
  };
}

function publicProjection(model) {
  const caps = model.capabilities && typeof model.capabilities === "object" ? model.capabilities : {};
  return {
    id: model.id,
    displayName: model.displayName || model.name,
    available: caps.available !== false,
    priceReady: caps.priceReady !== false,
    availabilityMessage: caps.availabilityMessage || "",
    workflowInputMode: caps.workflowInputMode || caps.referenceInputMode || "",
    durations: caps.nativeDurations || [],
    resolutions: caps.resolutionOptions || [],
    maxReferenceImages: caps.maxReferenceImages ?? null,
  };
}

const assignedVideos = videoSurface.models.filter((model) => model.assigned).map(adminProjection);
const assignedImages = imageSurface.models.filter((model) => model.assigned).map(adminProjection);
const workbookVideos = videoSurface.models.filter((model) => workbookVideoIds.has(String(model.id))).map(adminProjection);
const unavailableVideoAdminModels = assignedVideos.filter((model) =>
  !model.publishable || model.id === "veo-3-1-fast-chC",
);
const validationContexts = await Promise.all(unavailableVideoAdminModels.map(async (model) => {
  const context = await optionalStepUpApi(`/api/admin/video-models/validation?modelId=${encodeURIComponent(model.id)}`);
  if (context.optionalReadUnavailable) {
    return {
      id: model.id,
      displayName: model.name,
      status: context.status,
      code: context.code,
      stepUpRequired: context.stepUpRequired,
      note: "Validation context is intentionally omitted from this read-only catalog audit",
    };
  }
  return {
    id: model.id,
    displayName: context.model?.displayName || model.name,
    protocol: context.model?.protocol || null,
    upstreamModel: context.model?.upstreamModel || null,
    endpointHost: context.model?.endpointHost || null,
    readiness: context.readiness || null,
    capabilities: context.capabilities || null,
    minimumInput: context.minimumInput || null,
    restrictions: context.restrictions || [],
    restrictionEvidence: context.restrictionEvidence || [],
    recentError: context.recentError || null,
    existingTask: context.existingTask || null,
    minimumPrice: context.minimumPrice ?? null,
    billingUnit: context.billingUnit || null,
  };
}));
const report = {
  checkedAt: new Date().toISOString(),
  origin,
  databaseWrites: 0,
  providerRequests: 0,
  paidGenerationRequests: 0,
  storyboard: {
    adminVideoAssigned: assignedVideos.length,
    adminVideoPublishable: assignedVideos.filter((model) => model.publishable).length,
    publicVideoCount: publicVideos.models.length,
    publicVideoAvailable: publicVideos.models.filter((model) => model.capabilities?.available !== false).length,
    adminImageAssigned: assignedImages.length,
    adminImagePublishable: assignedImages.filter((model) => model.publishable).length,
    publicImageCount: publicImages.models.length,
    publicImageAvailable: publicImages.models.filter((model) => model.capabilities?.available !== false).length,
  },
  assignedVideos,
  workbookVideos,
  publicVideos: publicVideos.models.map(publicProjection),
  assignedImages,
  publicImages: publicImages.models.map(publicProjection),
  validationContexts,
};
const output = path.resolve(".codex-evidence/storyboard-model-catalog-r348/catalog.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  ...report.storyboard,
  unavailableVideoAdmin: unavailableVideoAdminModels,
  validationContexts,
  publicVideoModels: report.publicVideos,
  workbookVideos,
  gptImage2: assignedImages.filter((model) => /GPT Image 2/iu.test(model.name)),
  output,
}, null, 2));
