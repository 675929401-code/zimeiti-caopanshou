import { gaoruiVideoCreateContractAdmission } from "../src/lib/gaorui-video-contract-admission";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as capabilities from "../src/lib/video-model-capabilities";
import * as inputContract from "../src/lib/video-input-contract";
import * as policy from "../src/lib/workspace-model-policy";
import * as assignments from "../src/lib/workspace-model-assignment-settings";
import * as order from "../src/lib/video-model-surface-order";
import * as publicDto from "../src/lib/public-model-dto";
import * as publicStatus from "../src/lib/video-model-public-status";
import * as catalog from "../src/lib/video-workspace-catalog";
import * as selection from "../src/lib/video-model-selection-state";
import * as storyboardSelection from "../src/lib/storyboard-video-model-selection";
import * as availability from "../src/lib/video-model-availability";
import { getVideoTokenPublicPricing } from "../src/lib/video-token-billing";
import { isDigitalHumanWorkspaceModel } from "../src/lib/video-model-surface";
import { RETIRED_MODEL_PROVIDER } from "../src/lib/model-retirement";

const common = {
  provider: "fixture-private-provider", protocol_type: "fixture-video", api_endpoint: "https://fixture-private.invalid/video",
  api_key: "fixture-private-key", price_per_use: 0.2, cost_price: 0.1, is_active: true, is_hidden: false,
  duration_seconds: 8, max_duration: 8,
};
const config = {
  workspace_surfaces: ["storyboard", "ai-video", "free-canvas", "film-studio", "commerce-agent"],
  supports_prompt: true, min_reference_images: 0, max_reference_images: 0, min_reference_audios: 0, max_reference_audios: 0,
  duration_options: [8], resolution_options: ["720p"], default_resolution: "720p", aspect_ratios: ["16:9"],
};
function fixture(id: string, row: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return { ...common, id, name: id, model_name: id, supports_image_input: false, requires_image: false,
    ...row, api_protocol_config: { ...config, ...overrides } };
}
const rows = [
  fixture("text", {}, { workflow_input_mode: "text" }),
  fixture("image", { supports_image_input: true, requires_image: true }, { min_reference_images: 1, max_reference_images: 1 }),
  fixture("dual", { supports_image_input: true }, { max_reference_images: 1 }),
  fixture("frames", { supports_image_input: true }, { workflow_input_mode: "first_last_frame", min_reference_images: 2, max_reference_images: 2 }),
  fixture("image-audio", { supports_image_input: true, requires_image: true }, { workflow_input_mode: "multi_image_audio", min_reference_images: 1, max_reference_images: 1, min_reference_audios: 1, max_reference_audios: 1 }),
  fixture("source", {}, { supports_source_video_input: true, requires_source_video: true }),
  fixture("unknown", { supports_image_input: true, requires_image: true, duration_seconds: 30, max_duration: 30 }, {
    capability_contract_verified: false, generation_paused: true,
    min_reference_images: 1, max_reference_images: 30, min_reference_audios: 1, max_reference_audios: 3,
    supports_source_video_input: true, requires_source_video: true,
    duration_options: [30], resolution_options: ["4K"], default_resolution: "4K", aspect_ratios: ["21:9"],
  }),
  fixture("paused", { supports_image_input: true }, { max_reference_images: 1, generation_paused: true }),
  fixture("unassigned", {}, { workspace_surfaces: [] }),
  fixture("hidden", { is_hidden: true }),
  fixture("retired", { protocol_type: "autodl_comfyui_workflow" }),
  fixture("retired-provider", { provider: RETIRED_MODEL_PROVIDER }),
];

// Execute the actual public route with only the data and external-service edges
// replaced. No server, database client, credential resolver or provider is used.
let reads = 0;
const db = { from(table: string) {
  assert.ok(["video_models", "platform_settings"].includes(table));
  const conditions: Array<[string, unknown]> = [];
  const query = {
    select() { return query; }, eq(key: string, value: unknown) { conditions.push([key, value]); return query; },
    order() { return query; }, maybeSingle: async () => ({ data: conditions.some(([key, value]) => key === "setting_key" && value === assignments.WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY)
      ? { setting_value: { surfaces: Object.fromEntries(policy.WORKSPACE_MODEL_SURFACES.filter(surface => surface.kind === "video").map(surface => [surface.id, Object.fromEntries(rows.filter(row => row.id !== "unassigned").map(row => [row.id, true]))])) } } : null, error: null }),
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      reads++;
      return Promise.resolve({ data: rows.filter(row => conditions.every(([key, value]) => (row as Record<string, unknown>)[key] === value)), error: null }).then(resolve, reject);
    },
  };
  return query;
} };
const routeSource = readFileSync("src/app/api/video/models/route.ts", "utf8");
const tree = ts.createSourceFile("route.ts", routeSource, ts.ScriptTarget.Latest, true);
const sourceWithoutImports = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join("\n");
const context = {
  gaoruiVideoCreateContractAdmission, ...capabilities, ...inputContract, ...policy, ...assignments, ...order, ...publicDto, ...publicStatus, ...catalog, ...availability,
  getVideoTokenPublicPricing, isDigitalHumanWorkspaceModel,
  getSupabaseClient: () => db,
  isRegisteredVideoProtocol: (protocol: unknown) => protocol === "fixture-video" || protocol === "gaorui_video",
  readGaoruiPersonAssetAdmission: () => ({ ready: true }), supportsConfirmedVideoCancellation: () => false,
  humanDurationCapabilities: () => ({}), requireVideoPriceSnapshot: () => ({}),
  AUTODL_H3_SELFHOST_PROTOCOL: "autodl_h3_selfhost",
  RETIRED_MODEL_PROVIDER,
  NextResponse: { json: (body: unknown, options?: { status?: number }) => ({ status: options?.status || 200, json: async () => body }) },
  exports: {} as { GET?: (request: Request) => Promise<{ status: number; json: () => Promise<{ models: publicDto.PublicModelDto[] }> }> },
  console, URL,
};
runInNewContext(ts.transpileModule(sourceWithoutImports, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
assert.equal(typeof context.exports.GET, "function");

async function readCatalog(surface: string) {
  const response = await context.exports.GET!(new Request(`https://fixture.invalid/api/video/models?surface=${surface}`));
  assert.equal(response.status, 200);
  return (await response.json()).models;
}
function byName(models: publicDto.PublicModelDto[], name: string) {
  const model = models.find(model => model.displayName === name);
  assert.ok(model, `${name} retained in catalogue`);
  return model;
}

async function main() {
  const storyboard = await readCatalog("storyboard-workbench");
  const video = await readCatalog("video-page");
  const expectedNames = rows.slice(0, 8).map(row => row.name).sort();
  assert.deepEqual(storyboard.map(model => model.displayName).sort(), expectedNames);
  assert.deepEqual(video.map(model => model.displayName).sort(), expectedNames);
  for (const models of [storyboard, video]) for (const name of ["text", "image", "dual", "frames", "image-audio", "source"]) {
    assert.equal(byName(models, name).capabilities.generationReady, true, `${name}: supported inputs are a per-card gate, not a catalog ban`);
  }
  for (const models of [storyboard, video]) {
    for (const name of ["unknown", "paused"]) assert.equal(byName(models, name).capabilities.generationReady, false);
    assert.equal(byName(models, "unknown").capabilities.capabilitiesVerified, false);
    assert.equal(byName(models, "unknown").capabilities.compatibilityCode, "VIDEO_MODEL_SUBMISSION_PAUSED");
    assert.equal(byName(models, "unknown").capabilities.maxDuration, 30, "diagnostic acceptance flag must not erase configured timing");
    assert.deepEqual(byName(models, "unknown").capabilities.resolutionOptions, ["4K"]);
    assert.equal(byName(models, "unknown").publicPrice, common.price_per_use, "unknown status must preserve its configured price");
    assert.equal(publicDto.containsForbiddenPublicModelKey(models), false);
    for (const privateText of ["fixture-private-provider", "fixture-private-key", "fixture-private.invalid"]) assert.equal(JSON.stringify(models).includes(privateText), false);
  }
  const film = await readCatalog("film-studio");
  assert.deepEqual(film.map(model => model.displayName).sort(), ["dual", "image", "paused"]);
  const canvas = await readCatalog("free-canvas");
  assert.equal(canvas.some(model => model.displayName === "source"), false);
  const commerce = await readCatalog("commerce-agent");
  assert.deepEqual(commerce.map(model => model.displayName), ["unknown"], "commerce retains its existing five-image compatibility filter");
  assert.equal(byName(commerce, "unknown").capabilities.generationReady, false);

  // The same input contract used by submission still rejects absent mandatory
  // frames/audio/source video; catalogue retention never supplies those inputs.
  for (const name of ["frames", "image-audio", "source"]) {
    const row = rows.find(row => row.name === name)!;
    const contract = inputContract.getVideoInputContract(row);
    assert.ok(inputContract.validateVideoInputContract(contract, { prompt: "fixture", imageUrl: name === "source" ? "" : "https://fixture.invalid/image.png" }), `${name} must reject incomplete input`);
  }
  const labels = ["文生视频", "图生视频", "文生 / 图生视频", "首尾帧", "图+音频", "视频编辑", "视频编辑"];
  for (let index = 0; index < labels.length; index++) {
    const row = rows[index];
    const input = inputContract.getVideoInputContract(row);
    assert.equal(selection.videoModelInputLabel({ id: row.id, ...input, workflowInputMode: input.mode, capabilitiesVerified: index !== 6 }), labels[index]);
  }
  assert.equal(selection.videoModelInputHint({ id: "dual", supportsImageInput: true, maxReferenceImages: 1, minReferenceImages: 0, supportsPrompt: true }), "支持文生和图生视频");
  assert.equal(selection.videoModelInputHint({ id: "unknown", capabilitiesVerified: false, supportsImageInput: true }), "支持图生视频", "unknown model must not expose review copy or invent an input capability");
  assert.equal(selection.videoModelInputLabel({ id: "dual-extras", supportsImageInput: true, maxReferenceImages: 1, minReferenceImages: 0, supportsPrompt: true, supportsAudioInput: true, maxReferenceAudios: 1, supportsSourceVideoInput: true }), "文生 / 图生视频 · 可选音频 · 可选源视频");
  assert.equal(selection.reconcileVideoModelSelection("original-model", [{ id: "replacement", available: true, generationReady: true }]), "original-model");
  assert.equal(storyboardSelection.resolveStoryboardInitialVideoModelId("original-model", []), "original-model");
  assert.equal(selection.reconcileVideoModelSelection("unknown", [{ id: "unknown", available: false, generationReady: false }, { id: "other", available: true, generationReady: true }]), "unknown");
  assert.equal(storyboardSelection.resolveStoryboardInitialVideoModelId("unknown", []), "unknown");
  assert.deepEqual(selection.boundVideoTaskModel({ modelId: "original-model", modelName: "Seedance 2.0 · 高瑞（能力核对中）", supportsRemoteCancel: false }, [{ id: "original-model", name: "Current model", supportsRemoteCancel: true }]), {
    id: "original-model", name: "Seedance 2.0 · 高瑞", supportsRemoteCancel: false,
  }, "restored task display omits operational notes without replacing its original model or cancellation contract");
  for (const code of ["STORYBOARD_AUDIO_REQUIRED", "PRIVATE_PROVIDER_URL=https://secret.invalid"]) {
    const dto = publicDto.toPublicModelDto("video", rows[0], 0, { compatibilityCode: code, readinessMessage: "PRIVATE_ADMIN_REASON", availabilityMessage: "PRIVATE_PROVIDER_REASON", verificationNotice: "PRIVATE_ENDPOINT", capabilitiesVerified: true });
    assert.equal(JSON.stringify(dto).includes("PRIVATE_"), false);
    assert.equal(dto.capabilities.compatibilityCode, publicStatus.publicVideoModelCompatibilityCode(code));
  }
  const pageSource = readFileSync("src/app/video/page.tsx", "utf8");
  const boardSource = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
  assert.match(pageSource, /const selectable = model\.available && model\.generationReady/u);
  assert.match(pageSource, /if \(!selectedModel \|\| selectedModel\.generationReady === false\) return;[\s\S]*?setDuration/u, "unknown saved selection must not reset duration/resolution/fees");
  assert.match(pageSource, /selectedModelSubmissionUnavailable \? null : <div/u, "unknown selected model hides global capability controls without operational copy");
  assert.match(pageSource, /cardCapabilitiesUnverified \? null : <fieldset/u, "unknown draft hides only new-input controls and preserves their saved state");
  for (const source of [pageSource, boardSource]) {
    assert.doesNotMatch(source, /能力待核验|能力核对中|配置待验收/u, "customer pages cannot render operational review descriptions");
  }
  assert.match(pageSource, /!requiresVideoTaskTracking\(task\) && !task\.taskId && selectedModelSubmissionUnavailable/u, "submitted tasks keep their immutable historical input/result display");
  assert.match(boardSource, /selectedVideoModel && selectedVideoModel\.generationReady !== false\s*\? resolveStoryboardVideoSelection/u, "unknown saved storyboard parameters must not be coerced");
  assert.match(boardSource, /model\.generationReady !== false && <span className="sbw-model-tier"/u, "unknown storyboard card cannot show a placeholder resolution");
  assert.match(pageSource, /if \(selectable\) setSelectedModelId\(model\.id\)/u);
  assert.match(boardSource, /disabled=\{Boolean\(selectionIssue\)\}/u);
  assert.match(boardSource, /if \(selectionIssue\) \{[\s\S]*?return;[\s\S]*?patchRun/u);
  assert.match(pageSource, /supportsGenerateAudioToggle === true,[\s\S]*?task\.generateAudio/u);
  assert.match(pageSource, /submittedGenerateAudio !== undefined \? \{ generate_audio: submittedGenerateAudio \} : \{\}/u);
  assert.doesNotMatch(boardSource, /generate_audio\s*:/u);

  // A missing or accidentally asserted configuration flag cannot supply an
  // unknown model's creation schema. Run the actual catalogue on both surfaces.
  const normalNames: string[] = [];
  for (const model_name of ["seedance-2.0", "seedance-2.5"]) {
    for (const verified of [undefined, false, true]) {
      const name = `normal-${model_name}-${String(verified)}`;
      normalNames.push(name);
      rows.push(fixture(name, { provider: "gaorui", protocol_type: "gaorui_video", model_name, supports_image_input: true }, {
        max_reference_images: 1,
        ...(verified === undefined ? {} : { capability_contract_verified: verified }),
      }));
    }
  }
  for (const surface of ["storyboard-workbench", "video-page"]) {
    const models = await readCatalog(surface);
    for (const name of normalNames) {
      const model = byName(models, name);
      assert.equal(model.capabilities.capabilitiesVerified, !name.endsWith("-false"));
      assert.equal(model.capabilities.generationReady, false);
      assert.equal(model.capabilities.compatibilityCode, "VIDEO_CONFIGURATION_PENDING");
      assert.equal(model.capabilities.maxReferenceImages, 1);
      assert.equal(model.capabilities.maxDuration, 8);
      assert.equal(model.publicPrice, common.price_per_use);
    }
  }
  for (const model_name of ["seedance-2.0", "seedance-2.5"]) rows.push(fixture(`bound-${model_name}`,
    { provider: "gaorui", protocol_type: "gaorui_video", model_name, api_endpoint: "https://gaorui.cc/v1", supports_image_input: true },
    { protocol_family: "seedance_native_content", workflow_input_mode: "flexible_image", max_reference_images: 1, capability_contract_verified: false }));
  for (const surface of ["storyboard-workbench", "video-page"]) {
    const models = await readCatalog(surface);
    for (const name of ["bound-seedance-2.0", "bound-seedance-2.5"]) {
      const model = byName(models, name);
      assert.equal(model.capabilities.capabilitiesVerified, false);
      assert.equal(model.capabilities.generationReady, true);
      assert.equal(model.capabilities.maxReferenceImages, 1);
      assert.equal(model.capabilities.showFirstFrame, true); assert.equal(model.capabilities.showReferenceImages, false);
      assert.equal(model.capabilities.firstFrameRatioPolicy, name.endsWith("2.5") ? "adaptive" : undefined);
    }
  }
  console.log(JSON.stringify({ passed: true, upstreamRequests: 0, databaseWrites: 0, fixtureCatalogReads: reads, catalogMatrix: expectedNames, unboundCreateContractsGated: normalNames, labels, preservedOtherSurfaceFilters: true, publicReasonsWhitelisted: true, selectionPreserved: true }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
