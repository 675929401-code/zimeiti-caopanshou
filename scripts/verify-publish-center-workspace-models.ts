import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as imageOrder from "../src/lib/image-model-surface-order";
import * as videoOrder from "../src/lib/video-model-surface-order";
import * as policy from "../src/lib/workspace-model-policy";
import * as assignments from "../src/lib/workspace-model-assignment-settings";
import { isVideoCatalogDisplaySurface } from "../src/lib/video-workspace-catalog";
import { WORKSPACE_SURFACE_KIND } from "../src/lib/workspace-surface-contract";
import * as videoCapabilities from "../src/lib/video-model-capabilities";
import * as videoInput from "../src/lib/video-input-contract";
import * as videoAvailability from "../src/lib/video-model-availability";
import * as videoPublicStatus from "../src/lib/video-model-public-status";
import * as videoCatalog from "../src/lib/video-workspace-catalog";
import { getVideoTokenPublicPricing } from "../src/lib/video-token-billing";
import { isDigitalHumanWorkspaceModel } from "../src/lib/video-model-surface";
import { gaoruiVideoCreateContractAdmission } from "../src/lib/gaorui-video-contract-admission";

function syntax(file: string) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function declaration(tree: ts.SourceFile, name: string): ts.VariableDeclaration | ts.FunctionDeclaration {
  let found: ts.VariableDeclaration | ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(tree) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `${name}: production declaration required`);
  return found;
}
function evaluate<T>(source: string, globals: Record<string, unknown> = {}): T {
  const javascript = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  return runInNewContext(javascript, {
    ...globals, exports: {}, fetch: () => { throw new Error("NETWORK_FORBIDDEN"); },
  }) as T;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tabTree = syntax("src/components/admin/WorkspaceModelsAdminTab.tsx");
const routeTree = syntax("src/app/api/admin/workspace-models/route.ts");
const compatibilityTree = syntax("src/lib/server/platform-configuration-compatibility.ts");
const adminModelsTree = syntax("src/app/api/admin/models/route.ts");

const images = imageOrder.parseImageModelSurfaceOrders({ surfaces: {
  "image-workbench": { same: 10 }, "cover-studio": { same: 20 },
  "storyboard-workbench": { same: 30 }, "free-canvas": { same: 40 }, "film-studio": { same: 50 },
  "publish-center-image": { same: 60, " trim ": "12.6", invalid: -1 },
} });
const videos = videoOrder.parseVideoModelSurfaceOrders({ surfaces: {
  "ai-video": { same: 11 }, storyboard: { same: 21 }, "free-canvas": { same: 31 },
  "film-studio": { same: 41 }, "commerce-agent": { same: 51 }, "publish-center-video": { same: 61 },
} });
assert.deepEqual(images["publish-center-image"], { same: 60, trim: 13 });
assert.deepEqual(imageOrder.parseImageModelSurfaceOrders(imageOrder.serializeImageModelSurfaceOrders(images)), images);
assert.deepEqual(videoOrder.parseVideoModelSurfaceOrders(videoOrder.serializeVideoModelSurfaceOrders(videos)), videos);
for (const input of [undefined, null, "{invalid", {}, { surfaces: { "image-workbench": { same: 9 } } }]) {
  assert.deepEqual(imageOrder.parseImageModelSurfaceOrders(input)["publish-center-image"], {});
  assert.deepEqual(videoOrder.parseVideoModelSurfaceOrders(input)["publish-center-video"], {});
}
const imageLegacyAliases = { cover: "cover-studio", storyboard: "storyboard-workbench", canvas: "free-canvas", "short-drama-film-studio": "film-studio" } as const;
const videoLegacyAliases = { "video-page": "ai-video", "storyboard-workbench": "storyboard", canvas: "free-canvas", "short-drama-film-studio": "film-studio", "commerce-video": "commerce-agent" } as const;
for (const [input, expected] of Object.entries(imageLegacyAliases)) assert.equal(imageOrder.normalizeImageModelOrderSurface(input), expected);
for (const [input, expected] of Object.entries(videoLegacyAliases)) assert.equal(videoOrder.normalizeVideoModelOrderSurface(input), expected);
assert.equal(imageOrder.normalizeImageModelOrderSurface(" PUBLISH-CENTER-IMAGE "), "publish-center-image");
assert.equal(videoOrder.normalizeVideoModelOrderSurface(" PUBLISH-CENTER-VIDEO "), "publish-center-video");
assert.equal(imageOrder.normalizeImageModelOrderSurface("publish-center-video"), null);
assert.equal(videoOrder.normalizeVideoModelOrderSurface("publish-center-image"), null);

const mappingNames = ["imageOrderKey", "videoOrderKey", "imageOrderForSurface", "videoOrderForSurface"];
const mapping = evaluate<{
  imageOrderForSurface: (orders: typeof images, surface: policy.WorkspaceModelSurface, id: string) => number | null;
  videoOrderForSurface: (orders: typeof videos, surface: policy.WorkspaceModelSurface, id: string) => number | null;
}>(`${mappingNames.map(name => declaration(routeTree, name).getText(routeTree)).join("\n")}\n({${mappingNames.join(",")}});`);
const expectedOrders: Record<policy.WorkspaceModelSurface, number> = {
  "image-workbench": 10, "cover-studio": 20, "storyboard-image": 30, "free-canvas-image": 40, "film-studio-image": 50,
  "video-page": 11, "storyboard-video": 21, "free-canvas-video": 31, "film-studio-video": 41, "commerce-video": 51,
  "publish-center-image": 60, "publish-center-video": 61,
};
const bootstrapOrder = declaration(compatibilityTree, "orderFor") as ts.VariableDeclaration;
const orderFor = evaluate<(surface: policy.WorkspaceModelSurface) => Record<string, number>>(
  `(${bootstrapOrder.initializer!.getText(compatibilityTree)});`, { imageOrders: images, videoOrders: videos });
for (const surface of policy.WORKSPACE_MODEL_SURFACES) {
  assert.equal(WORKSPACE_SURFACE_KIND[surface.id], surface.kind);
  const actualOrder = surface.kind === "image"
    ? mapping.imageOrderForSurface(images, surface.id, "same") : mapping.videoOrderForSurface(videos, surface.id, "same");
  const missingOrder = surface.kind === "image"
    ? mapping.imageOrderForSurface(images, surface.id, "missing") : mapping.videoOrderForSurface(videos, surface.id, "missing");
  assert.equal(actualOrder, expectedOrders[surface.id]);
  assert.equal(missingOrder, null);
  assert.equal(orderFor(surface.id).same, expectedOrders[surface.id], `${surface.id}: bootstrap preserves its independent order`);
}
assert.equal(mapping.imageOrderForSurface(images, "publish-center-video", "same"), null);
assert.equal(mapping.videoOrderForSurface(videos, "publish-center-image", "same"), null);

const adminSurface = declaration(adminModelsTree, "workspaceSurface") as ts.VariableDeclaration;
for (const [surface, expected] of Object.entries({ "ai-video": "video-page", storyboard: "storyboard-video", "free-canvas": "free-canvas-video", "film-studio": "film-studio-video", "commerce-agent": "commerce-video", "publish-center-video": "publish-center-video" })) {
  assert.equal(evaluate(`(${adminSurface.initializer!.getText(adminModelsTree)});`, { surface }), expected);
}
const nav = declaration(tabTree, "NAV_ITEMS") as ts.VariableDeclaration;
const icons = Object.fromEntries(tabTree.statements.filter(ts.isImportDeclaration)
  .filter(node => node.moduleSpecifier.getText(tabTree) === '"lucide-react"')
  .flatMap(node => ts.isNamedImports(node.importClause!.namedBindings!)
    ? node.importClause!.namedBindings.elements.map(entry => [entry.name.text, () => null]) : []));
const navItems = plain(evaluate<Array<{ id: string; surfaceIds?: string[] }>>(`(${nav.initializer!.getText(tabTree)});`, icons));
assert.equal(new Set(navItems.map(item => item.id)).size, navItems.length);
assert.deepEqual(navItems.find(item => item.id === "publish-center")?.surfaceIds, ["publish-center-image", "publish-center-video"]);
assert.deepEqual(navItems.filter(item => item.id !== "publish-center").map(item => item.id), ["image", "cover", "storyboard", "video", "film", "commerce", "voice", "manju", "tools"]);
assert.match(tabTree.text, /type SurfaceId = WorkspaceModelSurface/u);
assert.match(tabTree.text, /<PlatformConfigurationReleasePanel[\s\S]*?kind="workspace-models"/u);

async function verifyPublicConsumers() {
  type Row = Record<string, unknown>;
  type PublicModel = { id: string; capabilities: Record<string, unknown> };
  const common = { provider: "fixture", is_hidden: false, is_active: true, cost_price: 0.1, selling_price: 0.2,
    api_key: "fixture-only", api_endpoint: "https://fixture.invalid/video", price_per_use: 0.2,
    duration_seconds: 8, max_duration: 8, supports_image_input: true, requires_image: true, protocol_type: "fixture-video",
    api_protocol_config: { duration_options: [8], resolution_options: ["720p"], aspect_ratios: ["16:9"], min_reference_images: 1, max_reference_images: 1 } };
  const rowsByTable: Record<string, Row[]> = {
    cover_models: [{ ...common, id: "image-a", name: "GPT Image", sort_order: 1 }, { ...common, id: "image-b", name: "Qwen Image", sort_order: 2 }, { ...common, id: "image-c", name: "Unavailable Image", sort_order: 3, is_active: false }],
    video_models: [{ ...common, id: "video-a", name: "Video A", sort_order: 1 }, { ...common, id: "video-b", name: "Video B", sort_order: 2 }, { ...common, id: "video-c", name: "Unavailable Video", sort_order: 3, is_active: false }],
  };
  const settings: Record<string, unknown> = {
    [assignments.WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY]: { surfaces: {
      "publish-center-image": { "image-a": true }, "publish-center-video": { "video-a": true },
      "image-workbench": { "image-a": true, "image-b": true }, "video-page": { "video-a": true, "video-b": true },
    } },
  };
  const db = { from(table: string) {
    assert.ok(table === "platform_settings" || Object.hasOwn(rowsByTable, table));
    const conditions: Array<[string, unknown]> = [];
    const query = {
      select() { return query; }, order() { return query; }, eq(key: string, value: unknown) { conditions.push([key, value]); return query; },
      async maybeSingle() { const key = conditions.find(([name]) => name === "setting_key")?.[1]; return { data: { setting_value: settings[String(key)] }, error: null }; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve({ data: (rowsByTable[table] || []).filter(row => conditions.every(([key, value]) => row[key] === value)), error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  function loadPublic(file: string) {
    const tree = syntax(file);
    const source = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join("\n");
    return evaluate<(request: Request) => Promise<{ status: number; body: { models: PublicModel[] } }>>(`${source}\nGET;`, {
      ...policy, ...assignments, ...imageOrder, ...videoOrder, ...videoCapabilities, ...videoInput,
      ...videoAvailability, ...videoPublicStatus, ...videoCatalog, getVideoTokenPublicPricing, isDigitalHumanWorkspaceModel, gaoruiVideoCreateContractAdmission,
      getSupabaseClient: () => db, URL,
      NextResponse: { json: (body: unknown, options?: { status?: number }) => ({ status: options?.status || 200, body }) },
      toPublicModelDto: (_kind: string, row: Row, _index: number, capabilities: Row) => ({ id: String(row.id), capabilities }),
      publicMediaBillingCapabilities: () => ({}), publicImageResolutionPrices: () => ({}),
      cleanImageModelText: (_row: Row, value: unknown) => String(value || ""),
      publicImageModelCapabilities: () => ({ defaultResolution: "1K", resolutionOptions: ["1K"] }),
      resolveImageResolutionPrice: (row: Row, _resolution: string, kind: string) => row[kind === "cost" ? "cost_price" : "selling_price"],
      ImageProviderBindingError: class extends Error {}, resolveImageProviderContract: () => ({ requestProtocol: "images_generations" }),
      inspectImageModelReadiness: () => ({ protocolBindingReady: true, canaryVerified: false }),
      readImagePublicationStates: async () => rowsByTable.cover_models.map(model => ({ model, configured: true, available: model.is_active === true })),
      isRegisteredVideoProtocol: (protocol: string) => protocol === "fixture-video", requireVideoPriceSnapshot() {},
      readGaoruiPersonAssetAdmission: () => ({ ready: true }), supportsConfirmedVideoCancellation: () => false, humanDurationCapabilities: () => ({}),
      RETIRED_MODEL_PROVIDER: "retired_configuration", AUTODL_H3_SELFHOST_PROTOCOL: "autodl_h3_selfhost",
      AUTODL_H3_SELFHOST_PROVIDER: "autodl_h3_selfhost", AUTODL_H3_SELFHOST_IMAGE_VERIFIED_RESOLUTION: "1K",
      AUTODL_H3_SELFHOST_IMAGE_VERIFIED_ASPECT_RATIOS: ["16:9"], AUTODL_H3_SELFHOST_IMAGE_VERIFIED_REQUEST_PIXEL_SIZES: {}, AUTODL_H3_SELFHOST_IMAGE_VERIFIED_OUTPUT_PIXEL_SIZES: {}, console,
    });
  }
  const imageGet = loadPublic("src/app/api/cover-models/route.ts");
  const videoGet = loadPublic("src/app/api/video/models/route.ts");
  async function read(get: typeof imageGet, surface: string) {
    const response = await get(new Request(`https://fixture.invalid/models?surface=${surface}`));
    assert.equal(response.status, 200);
    return plain(response.body.models);
  }
  const before = await Promise.all([read(imageGet, "publish-center-image"), read(videoGet, "publish-center-video"), read(imageGet, "image-workbench"), read(videoGet, "video-page")]);
  settings[imageOrder.IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY] = { surfaces: { "publish-center-image": { "image-b": 0, "image-a": 10 } } };
  settings[videoOrder.VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY] = { surfaces: { "publish-center-video": { "video-b": 0, "video-a": 10 } } };
  const after = await Promise.all([read(imageGet, "publish-center-image"), read(videoGet, "publish-center-video"), read(imageGet, "image-workbench"), read(videoGet, "video-page")]);
  assert.deepEqual(after[0].map(model => model.id), ["image-b", "image-a", "image-c"], "native image order overrides family grouping");
  assert.deepEqual(after[1].map(model => model.id), ["video-b", "video-a", "video-c"]);
  for (const index of [0, 1]) {
    const byId = (models: PublicModel[]) => [...models].sort((left, right) => left.id.localeCompare(right.id));
    assert.equal(after[index].length, 3, "unassigned and unavailable native models remain in the catalog");
    assert.deepEqual(byId(after[index]), byId(before[index]), "sorting preserves every model's admission and price capabilities");
    assert.equal(after[index].find(model => model.id.endsWith("-b"))?.capabilities.workspaceAssigned, false);
    assert.equal(after[index].find(model => model.id.endsWith("-c"))?.capabilities.generationReady, false);
  }
  assert.deepEqual(after[2], before[2], "image-workbench behavior remains unchanged");
  assert.deepEqual(after[3], before[3], "video-page behavior remains unchanged");
}

async function main() {
  await verifyPublicConsumers();
  let reads = 0;
  let manageAllowed = true;
  const staged: Array<Record<string, unknown>> = [];
  const image = { id: "image-a", name: "Fixture", supports_image_input: true, is_active: true, is_hidden: false,
    api_protocol_config: { resolution_options: ["1K"], aspect_ratios: ["16:9"] } };
  const video = { ...image, id: "video-a", protocol_type: "fixture", requires_image: true, duration_seconds: 8, max_duration: 8,
    api_protocol_config: { duration_options: [8], resolution_options: ["720p"], aspect_ratios: ["16:9"], min_reference_images: 1, max_reference_images: 1 } };
  const db = { from(table: string) {
    assert.ok(["cover_models", "video_models", "platform_settings"].includes(table));
    const rows = table === "cover_models" ? [image, { ...image, id: "hidden", is_hidden: true }] : [video];
    let id = "";
    const query = {
      select() { return query; }, eq(key: string, value: string) { if (key === "id") id = value; return query; },
      async maybeSingle() { reads++; return { data: table === "platform_settings" ? null : rows.find(row => row.id === id), error: null }; },
      async in(_key: string, ids: string[]) { reads++; return { data: rows.filter(row => ids.includes(row.id)), error: null }; },
    };
    return query;
  } };
  type FixtureResponse = { status: number; body: Record<string, unknown> };
  const json = (body: Record<string, unknown>, options?: { status?: number }): FixtureResponse => ({ status: options?.status || 200, body });
  const authorizationCalls: Array<{ capability: string; requireStepUp: boolean }> = [];
  const postFunctions = ["record", "definition", "authorizeWorkspaceWrite", "updateAssignment", "updateOrder", "POST"];
  const post = evaluate<(request: { json: () => Promise<Record<string, unknown>> }) => Promise<FixtureResponse>>(
    `${postFunctions.map(name => declaration(routeTree, name).getText(routeTree).replace(/^export\s+/u, "")).join("\n")}\nPOST;`, {
      ...policy, ...assignments, isVideoCatalogDisplaySurface, getSupabaseAdminClient: () => db,
      RETIRED_MODEL_PROVIDER: "retired_configuration", noStoreHeaders: {}, NextResponse: { json },
      authorizeAdminCapability: async (_request: unknown, capability: string, options: { requireStepUp?: boolean }) => {
        authorizationCalls.push({ capability, requireStepUp: options.requireStepUp === true });
        return manageAllowed ? { ok: true, actor: { userId: "fixture-admin" } } : { ok: false, response: json({ error: "denied" }, { status: 403 }) };
      },
      stageLegacyWorkspaceMutation: async (input: Record<string, unknown>) => { staged.push(plain(input)); return { release: { id: "fixture-candidate" } }; },
      console: { error() {} },
    });
  for (const [kind, surface, modelId] of [["image", "publish-center-image", "image-a"], ["video", "publish-center-video", "video-a"]] as const) {
    for (const body of [{ action: "assign", kind, surface, modelId, enabled: true }, { action: "reorder", kind, surface, modelIds: [modelId] }]) {
      const response = await post({ json: async () => body });
      assert.equal(response.status, 202);
      assert.equal(response.body.staged, true);
      assert.equal(response.body.published, false);
      assert.equal((staged.at(-1)?.mutation as Record<string, unknown>).surface, surface);
    }
  }
  const stagedCount = staged.length;
  for (const body of [
    { action: "assign", kind: "video", surface: "publish-center-image", modelId: "video-a", enabled: true },
    { action: "assign", kind: "image", surface: "publish-center-image", modelId: "hidden", enabled: true },
    { action: "reorder", kind: "video", surface: "publish-center-video", modelIds: ["video-a", "video-a"] },
  ]) assert.equal((await post({ json: async () => body })).status, 409);
  assert.equal(staged.length, stagedCount, "invalid requests never stage a candidate");
  manageAllowed = false;
  const previousReads = reads;
  assert.equal((await post({ json: async () => ({ action: "assign", kind: "image", surface: "publish-center-image", modelId: "image-a", enabled: true }) })).status, 403);
  assert.equal(reads, previousReads, "authorization denial precedes model reads");
  assert.equal(staged.length, stagedCount);
  assert.ok(authorizationCalls.every(call => call.capability === "models.manage" && call.requireStepUp));
  console.log(JSON.stringify({ passed: true, upstreamRequests: 0, databaseWrites: 0, fixtureStages: staged.length,
    checkedSurfaces: Object.keys(expectedOrders), independentOrderRoundtrip: true, bootstrapOrderPreserved: true,
    adminReorderMapping: true, sharedUiProjectAndReleasePanel: true, permissionAndHiddenGuards: true,
    actualPublicRoutesNativeOrder: true, nativeCatalogElementsAndAdmissionPreserved: true, adjacentCatalogsUnchanged: true }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
