import assert from "node:assert/strict";
import fs from "node:fs";

import {
  WORKSPACE_MODEL_SURFACES,
  configuredAspectRatios,
  evaluateWorkspaceModelCompatibility,
  imageWorkspaceSurfaceFromRequest,
  isModelAssignedToWorkspace,
  normalizeWorkspaceModelAssignments,
  videoWorkspaceSurfaceFromRequest,
  withWorkspaceModelAssignment,
} from "../src/lib/workspace-model-policy";
import {
  parseImageModelSurfaceOrders,
  serializeImageModelSurfaceOrders,
} from "../src/lib/image-model-surface-order";
import { containsForbiddenPublicModelKey, toPublicModelDto } from "../src/lib/public-model-dto";

const baseVideo = {
  id: "fixture-i2v",
  name: "Fixture I2V",
  model_name: "fixture-i2v",
  provider: "fixture",
  protocol_type: "fixture-video",
  duration_seconds: 8,
  max_duration: 8,
  supports_image_input: true,
  requires_image: true,
  api_protocol_config: {
    duration_options: [8],
    resolution_options: ["720p"],
    default_resolution: "720p",
    aspect_ratios: ["16:9", "9:16"],
    supports_prompt: true,
    min_reference_images: 1,
    max_reference_images: 1,
    min_reference_audios: 0,
    max_reference_audios: 0,
  },
};

assert.deepEqual(WORKSPACE_MODEL_SURFACES.slice(0, 10).map((entry) => entry.id), [
  "image-workbench",
  "cover-studio",
  "storyboard-image",
  "free-canvas-image",
  "free-canvas-video",
  "film-studio-image",
  "film-studio-video",
  "storyboard-video",
  "commerce-video",
  "video-page",
]);
assert.deepEqual(WORKSPACE_MODEL_SURFACES.slice(10).map((entry) => entry.id), ["publish-center-image", "publish-center-video"]);
assert.equal(imageWorkspaceSurfaceFromRequest("publish-center-image"), "publish-center-image");
assert.equal(videoWorkspaceSurfaceFromRequest("publish-center-video"), "publish-center-video");

assert.equal(imageWorkspaceSurfaceFromRequest("image-workbench"), "image-workbench");
assert.equal(imageWorkspaceSurfaceFromRequest("cover-studio"), "cover-studio");
assert.equal(imageWorkspaceSurfaceFromRequest("storyboard-workbench"), "storyboard-image");
assert.equal(imageWorkspaceSurfaceFromRequest("free-canvas"), "free-canvas-image");
assert.equal(imageWorkspaceSurfaceFromRequest("short-drama-film-studio"), "film-studio-image");
assert.equal(videoWorkspaceSurfaceFromRequest("storyboard-workbench"), "storyboard-video");
assert.equal(videoWorkspaceSurfaceFromRequest("video-page"), "video-page");
assert.equal(videoWorkspaceSurfaceFromRequest("commerce-agent"), "commerce-video");
assert.equal(videoWorkspaceSurfaceFromRequest("free-canvas"), "free-canvas-video");
assert.equal(videoWorkspaceSurfaceFromRequest("short-drama-film-studio"), "film-studio-video");
assert.deepEqual(normalizeWorkspaceModelAssignments("video", ["video-page", "storyboard-workbench", "storyboard"]), ["ai-video", "storyboard"]);

const assignedVideo = {
  ...baseVideo,
  api_protocol_config: withWorkspaceModelAssignment("video", baseVideo, "storyboard-video", true),
};
assert.equal(isModelAssignedToWorkspace("video", assignedVideo, "storyboard-video"), true);
assert.equal(isModelAssignedToWorkspace("video", assignedVideo, "video-page"), false);
assert.equal(evaluateWorkspaceModelCompatibility("video", baseVideo, "storyboard-video").compatible, true);

const namedTextToVideoWithImageSupport = {
  ...baseVideo,
  name: "文生视频专用（支持参考图）",
  model_name: "fixture-t2v",
};
assert.equal(
  evaluateWorkspaceModelCompatibility("video", namedTextToVideoWithImageSupport, "storyboard-video").compatible,
  true,
  "display-name wording must not override the stored input contract",
);

const sourceVideoFixture = {
  model: { ...baseVideo, api_protocol_config: { ...baseVideo.api_protocol_config, requires_source_video: true, supports_source_video_input: true } },
  code: "STORYBOARD_SOURCE_VIDEO_REQUIRED",
} as const;

const extendedStoryboardInputFixtures = [
  {
    model: { ...baseVideo, supports_image_input: false, requires_image: false, api_protocol_config: { ...baseVideo.api_protocol_config, min_reference_images: 0, max_reference_images: 0 } },
    code: "STORYBOARD_IMAGE_INPUT_REQUIRED",
  },
  {
    model: { ...baseVideo, name: "Fixture 首尾帧", api_protocol_config: { ...baseVideo.api_protocol_config, requires_last_frame: true, max_reference_images: 2 } },
    code: "STORYBOARD_LAST_FRAME_REQUIRED",
  },
  sourceVideoFixture,
  {
    model: { ...baseVideo, api_protocol_config: { ...baseVideo.api_protocol_config, min_reference_audios: 1, max_reference_audios: 1, supports_audio_input: true } },
    code: "STORYBOARD_AUDIO_REQUIRED",
  },
  {
    model: { ...baseVideo, api_protocol_config: { ...baseVideo.api_protocol_config, min_reference_images: 2, max_reference_images: 3 } },
    code: "STORYBOARD_TOO_MANY_REQUIRED_IMAGES",
  },
] as const;

for (const fixture of extendedStoryboardInputFixtures) {
  const storyboard = evaluateWorkspaceModelCompatibility("video", fixture.model, "storyboard-video");
  assert.equal(storyboard.compatible, true, `${fixture.code}: storyboard collects the required inputs before submit`);
  const film = evaluateWorkspaceModelCompatibility("video", fixture.model, "film-studio-video");
  assert.equal(film.compatible, false, `${fixture.code}: film must retain its single-keyframe restriction`);
  assert.ok(film.issues.some((issue) => issue.code === fixture.code));
}

const incompatibleFixtures = [
  {
    model: { ...baseVideo, name: "照片说话数字人", api_protocol_config: { ...baseVideo.api_protocol_config, workspace_surfaces: ["digital-human"] } },
    code: "DEDICATED_DIGITAL_HUMAN_MODEL",
  },
] as const;

for (const fixture of incompatibleFixtures) {
  const result = evaluateWorkspaceModelCompatibility("video", fixture.model, "storyboard-video");
  assert.equal(result.compatible, false, `${fixture.code} must block storyboard assignment`);
  assert.ok(result.issues.some((issue) => issue.code === fixture.code), `${fixture.code} must be reported`);
}

const sourceVideoPage = evaluateWorkspaceModelCompatibility("video", sourceVideoFixture.model, "video-page");
assert.equal(sourceVideoPage.compatible, true, "source-video workflows belong on the full video page");
const sourceVideoCanvas = evaluateWorkspaceModelCompatibility("video", sourceVideoFixture.model, "free-canvas-video");
assert.equal(sourceVideoCanvas.compatible, false, "source-video-required models must stay out of canvas until it has a source-video input");
assert.ok(sourceVideoCanvas.issues.some((issue) => issue.code === "CANVAS_SOURCE_VIDEO_REQUIRED"));
assert.equal(evaluateWorkspaceModelCompatibility("video", baseVideo, "film-studio-video").compatible, true);
assert.equal(evaluateWorkspaceModelCompatibility("video", extendedStoryboardInputFixtures[0].model, "film-studio-video").compatible, false);
for (const surface of ["storyboard-video", "film-studio-video", "video-page"] as const) {
  const conflict = evaluateWorkspaceModelCompatibility("video", {
    ...baseVideo,
    api_protocol_config: { ...baseVideo.api_protocol_config, min_reference_images: 3, max_reference_images: 1 },
  }, surface);
  assert.equal(conflict.compatible, false, "declared input conflicts remain blocked on every surface");
  assert.ok(conflict.issues.some((issue) => issue.code === "VIDEO_IMAGE_LIMIT_CONFLICT"));
}

const imageModel = {
  id: "fixture-image",
  name: "Fixture Image",
  model_name: "fixture-image",
  supports_image_input: true,
  api_protocol_config: {
    resolution_options: ["1K", "2K"],
    aspect_ratios: ["16:9", "9:16", "1:1"],
  },
};
assert.equal(evaluateWorkspaceModelCompatibility("image", imageModel, "storyboard-image").compatible, true);
const assignedImage = {
  ...imageModel,
  api_protocol_config: withWorkspaceModelAssignment("image", imageModel, "storyboard-image", true),
};
assert.equal(isModelAssignedToWorkspace("image", assignedImage, "storyboard-image"), true);

const imageOrders = parseImageModelSurfaceOrders({
  version: 1,
  surfaces: { "storyboard-workbench": { alpha: 20, beta: 10 } },
});
assert.deepEqual(imageOrders["storyboard-workbench"], { alpha: 20, beta: 10 });
assert.deepEqual(parseImageModelSurfaceOrders(serializeImageModelSurfaceOrders(imageOrders)), imageOrders);

const sourceChecks = [
  ["src/app/api/video/generate/route.ts", "MODEL_NOT_ASSIGNED_TO_WORKSPACE"],
  ["src/app/api/image/generate/route.ts", "IMAGE_MODEL_NOT_ASSIGNED_TO_WORKSPACE"],
  ["src/app/api/admin/workspace-models/route.ts", "stageLegacyWorkspaceMutation"],
  ["src/app/api/admin/models/route.ts", "stageLegacyWorkspaceMutation"],
  ["src/app/admin/page.tsx", "workspace-models"],
  ["src/components/free-canvas-shell.tsx", "surface=free-canvas"],
  ["src/features/film-studio-project/film-studio-production-panel.tsx", "surface=film-studio"],
  ["src/commerce/server/models.ts", "surface=commerce-agent"],
] as const;
for (const [file, needle] of sourceChecks) {
  assert.ok(fs.readFileSync(file, "utf8").includes(needle), `${file} must contain ${needle}`);
}

const workspaceAdminRoute = fs.readFileSync("src/app/api/admin/workspace-models/route.ts", "utf8");
assert.equal(
  workspaceAdminRoute.match(/readImagePublicationStates\(db\)/gu)?.length,
  1,
  "workspace catalog must batch-read image publication state instead of issuing one RPC per model",
);
const workspaceMutations = workspaceAdminRoute.slice(workspaceAdminRoute.indexOf("async function updateAssignment"));
assert.doesNotMatch(workspaceMutations, /platform_settings"\)\.upsert/u, "workspace mutations must not bypass the versioned control plane");
assert.equal(workspaceMutations.match(/stageLegacyWorkspaceMutation/gu)?.length, 2, "assignment and reorder must stage versioned candidates");
assert.match(workspaceMutations, /staged:\s*true,\s*published:\s*false/u, "workspace mutation response must not imply immediate publication");
const compatibilitySource = fs.readFileSync("src/lib/server/platform-configuration-compatibility.ts", "utf8");
assert.match(compatibilitySource, /stageLegacyWorkspaceMutation[\s\S]*?createMutationCandidate\(input\.actorId, "workspace-models"/u, "workspace mutations must create auditable release candidates");

const publicVideoCatalogRoute = fs.readFileSync("src/app/api/video/models/route.ts", "utf8");
const publicImageCatalogRoute = fs.readFileSync("src/app/api/cover-models/route.ts", "utf8");
const videoGenerateRoute = fs.readFileSync("src/app/api/video/generate/route.ts", "utf8");
const imageGenerateRoute = fs.readFileSync("src/app/api/image/generate/route.ts", "utf8");
assert.match(publicVideoCatalogRoute, /isWorkspaceModelAssigned/u, "video workspaces must use their explicit assignment list");
assert.match(publicImageCatalogRoute, /isWorkspaceModelAssigned/u, "image workspaces must use their explicit assignment list");
assert.match(videoGenerateRoute, /isWorkspaceModelAssigned/u, "video submissions must recheck explicit workspace assignment");
assert.match(imageGenerateRoute, /isWorkspaceModelAssigned/u, "image submissions must recheck explicit workspace assignment");
assert.match(publicVideoCatalogRoute, /isVisibleInPublicWorkspace/u, "public video workspaces must use the catalog display policy");
assert.match(publicVideoCatalogRoute, /baseAvailable && surfaceCompatibility\?\.compatible !== false/u, "retaining incompatible catalog entries must not relax generation admission");
assert.match(workspaceMutations, /!compatibility\.compatible && !isVideoCatalogDisplaySurface\(input\.surface\)/u, "only the two video catalogues may assign incompatible display entries");
assert.match(publicImageCatalogRoute, /publicImageCatalogPriority/u, "image catalog priority must be explicit and regression tested");

// Check the existing shared configuration contract and real public DTO serializer.
const configuredRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
assert.deepEqual(configuredAspectRatios({ aspect_ratios: [" 16:9 ", "1:1", "16:9"], supported_aspect_ratios: ["9:16"] }), ["16:9", "1:1"]);
assert.deepEqual(configuredAspectRatios({ aspect_ratios: [], supported_aspect_ratios: ["9:16"] }), [], "explicit empty primary array retains priority");
const catalogFixture = { ...imageModel, name: "Fixture Image", provider: "fixture-private-provider", api_key: "fixture-private-key", api_endpoint: "https://fixture-private.invalid", selling_price: 0.1 };
function serializedCatalog(config: Record<string, unknown>) {
  const row = { ...catalogFixture, api_protocol_config: { ...config, secret: "fixture-config-secret" } };
  const serialized = JSON.parse(JSON.stringify(toPublicModelDto("cover", row, 0, {
    type: "image", aspectRatios: configuredAspectRatios(config),
    provider: catalogFixture.provider, api_key: catalogFixture.api_key, secret: "fixture-config-secret",
  })));
  assert.equal(containsForbiddenPublicModelKey(serialized), false);
  assert.deepEqual(Object.keys(serialized).sort(), ["avatarUrl", "capabilities", "displayName", "id", "publicPrice", "variantLabel"]);
  for (const privateValue of [catalogFixture.provider, catalogFixture.api_key, catalogFixture.api_endpoint, "fixture-config-secret", "api_protocol_config"]) {
    assert.equal(JSON.stringify(serialized).includes(privateValue), false, "public catalog must not expose private configuration");
  }
  return serialized;
}
assert.deepEqual(serializedCatalog({ aspect_ratios: configuredRatios }).capabilities.aspectRatios, configuredRatios, "actual cover DTO retains configured ratios in order");
assert.deepEqual(serializedCatalog({ supported_aspect_ratios: [" 9:16 ", "1:1", "9:16"] }).capabilities.aspectRatios, ["9:16", "1:1"], "supported ratio fallback uses shared normalization");
assert.deepEqual(serializedCatalog({ aspect_ratios: [], supported_aspect_ratios: ["16:9"] }).capabilities.aspectRatios, [], "public DTO respects explicit empty primary ratios");
assert.deepEqual(serializedCatalog({}).capabilities.aspectRatios, [], "unknown ratios must stay unknown");
assert.match(publicImageCatalogRoute, /aspectRatios: configuredAspectRatios\(imageProtocolConfig\(model\)\)\.filter/u, "public route must project configured ratios through its validation filter");
assert.ok(publicImageCatalogRoute.indexOf("aspectRatios: [...AUTODL_H3_SELFHOST_IMAGE_VERIFIED_ASPECT_RATIOS]") > publicImageCatalogRoute.indexOf("aspectRatios: configuredAspectRatios"), "verified AUTODL capabilities retain final override priority");

console.log(JSON.stringify({
  passed: true,
  upstreamRequests: 0,
  databaseWrites: 0,
  checkedSurfaces: WORKSPACE_MODEL_SURFACES.map((entry) => entry.id),
  rejectedStoryboardCapabilities: incompatibleFixtures.map((entry) => entry.code),
  submissionGates: ["image-capability-and-assignment", "video-capability-and-assignment"],
  adminRouting: true,
  configuredImageAspectRatios: true,
  actualPublicDtoSerialization: true,
  publicDtoSecretsAbsent: true,
}, null, 2));
