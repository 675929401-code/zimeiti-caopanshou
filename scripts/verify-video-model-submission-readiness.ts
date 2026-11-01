import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { resolveVideoCharge } from "@/lib/video-model-capabilities";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const generateRoute = read("src/app/api/video/generate/route.ts");
const modelsRoute = read("src/app/api/video/models/route.ts");
const workspaceModelsRoute = read("src/app/api/admin/workspace-models/route.ts");
const finalizer = read("src/lib/video-terminal-finalizer.ts");
const longHistoryRoute = read("src/app/api/digital-human/long-history/route.ts");
const longStatusRoute = read("src/app/api/digital-human/long-status/route.ts");
const mediaWorkerRuntime = read("src/lib/media-queue-worker-runtime.ts");
const storyboardAgentRoute = read("src/app/api/storyboard/agent/route.ts");
const digitalHumanLongCreate = read("src/lib/digital-human-long-create.ts");
const voiceDb = read("src/lib/voice-studio/db.ts");
const voiceCatalog = read("src/lib/voice-studio/catalog.ts");
const voicePricing = read("src/lib/vs/pricing.ts");

// Execute only real pure modules and AST-selected admission branches. No route,
// database, provider or environment-loader module is imported by this harness.
const pureSources = new Set([
  "src/lib/video-model-capabilities.ts", "src/lib/video-model-surface.ts",
  "src/lib/video-model-availability.ts", "src/lib/video-channel-health-circuit.ts",
  "src/lib/video-token-billing.ts", "src/lib/gaorui-video-contract-admission.ts",
  "src/lib/public-model-dto.ts", "src/lib/video-duration-behavior.ts",
  "src/lib/video-model-public-status.ts", "src/lib/model-retirement.ts",
  "src/lib/video-workspace-catalog.ts", "src/lib/gaorui-person-asset-admission.ts",
]);
const pureCache = new Map<string, unknown>();
function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
}
function run(source: string, scope: Record<string, unknown> = {}) {
  return vm.runInNewContext(compile(source), {
    URL, Buffer, process: { env: Object.freeze({}) },
    fetch() { throw new Error("NETWORK_FORBIDDEN"); },
    require(name: string) { throw new Error(`UNEXPECTED_IMPORT:${name}`); },
    ...scope,
  }, { timeout: 5000 });
}
function loadPure<T>(relative: string): T {
  assert.ok(pureSources.has(relative), `UNAPPROVED_PURE_SOURCE:${relative}`);
  if (pureCache.has(relative)) return pureCache.get(relative) as T;
  const fixtureModule = { exports: {} };
  pureCache.set(relative, fixtureModule.exports);
  run(read(relative), { module: fixtureModule, exports: fixtureModule.exports, require(name: string) {
    if (name === "node:crypto") return crypto;
    const dependency = name.startsWith("./") ? path.posix.join(path.posix.dirname(relative), `${name}.ts`)
      : name.startsWith("@/") ? `src/${name.slice(2)}.ts` : "";
    assert.ok(pureSources.has(dependency), `UNMOCKED_IMPORT:${relative}:${name}`);
    return loadPure(dependency);
  } });
  pureCache.set(relative, fixtureModule.exports);
  return fixtureModule.exports as T;
}
function ast(source: string) { return ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function nodes<T extends ts.Node>(rootNode: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node) { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); }
  visit(rootNode);
  return result;
}
function initializer(tree: ts.SourceFile, name: string) {
  const matches = nodes(tree, ts.isVariableDeclaration).filter(node => node.name.getText(tree) === name);
  assert.equal(matches.length, 1, `unique production declaration required:${name}`);
  assert.ok(matches[0].initializer, `production initializer required:${name}`);
  return matches[0].initializer;
}
function declaration(tree: ts.SourceFile, name: string) {
  const match = nodes(tree, ts.isFunctionDeclaration).find(node => node.name?.text === name)
    || nodes(tree, ts.isClassDeclaration).find(node => node.name?.text === name);
  assert.ok(match, `production function/class required:${name}`);
  return match.getText(tree).replace(/^export\s+/u, "");
}
const capability = loadPure<typeof import("@/lib/video-model-capabilities")>("src/lib/video-model-capabilities.ts");
const modelSurface = loadPure<typeof import("@/lib/video-model-surface")>("src/lib/video-model-surface.ts");
const admission = loadPure<typeof import("@/lib/video-model-availability")>("src/lib/video-model-availability.ts");
const dto = loadPure<typeof import("@/lib/public-model-dto")>("src/lib/public-model-dto.ts");
const visibility = loadPure<typeof import("@/lib/video-workspace-catalog")>("src/lib/video-workspace-catalog.ts");
const publicStatus = loadPure<typeof import("@/lib/video-model-public-status")>("src/lib/video-model-public-status.ts");
const personAdmission = loadPure<typeof import("@/lib/gaorui-person-asset-admission")>("src/lib/gaorui-person-asset-admission.ts");
const retirement = loadPure<typeof import("@/lib/model-retirement")>("src/lib/model-retirement.ts");
const token = loadPure<typeof import("@/lib/video-token-billing")>("src/lib/video-token-billing.ts");
const terminalAst = ast(finalizer);
const requirePrice = run([
  ...["VideoTerminalError", "asObject", "finiteMoney", "isExplicitlyFreeVideoModel", "requireVideoPriceSnapshot"]
    .map(name => declaration(terminalAst, name)),
  "requireVideoPriceSnapshot;",
].join("\n"), { ...capability, ...token }) as typeof import("@/lib/video-terminal-finalizer").requireVideoPriceSnapshot;
const publicAst = ast(modelsRoute);
const adminAst = ast(workspaceModelsRoute);
const adapterAst = ast(read("src/lib/video-adapter.ts"));
const registry = initializer(adapterAst, "VIDEO_PROTOCOL_SUBMITTERS");
assert.ok(ts.isObjectLiteralExpression(registry), "real protocol registry must remain an object");
function registryKey(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  assert.ok(ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression), "unsupported computed protocol registry key");
  const localName = name.expression.text;
  const imports = adapterAst.statements.filter(ts.isImportDeclaration).flatMap(statement => {
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.filter(binding => binding.name.text === localName).map(binding => ({ statement, binding }));
  });
  assert.equal(imports.length, 1, `unique pure constant import required:${localName}`);
  const { statement, binding } = imports[0];
  assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
  const constantModule = path.posix.join('src/lib', `${statement.moduleSpecifier.text}.ts`);
  assert.equal(constantModule, 'src/lib/video-autodl-comfyui-workflow.ts', 'unknown computed registry constant module');
  const constantAst = ast(read(constantModule));
  const value = initializer(constantAst, binding.propertyName?.text || binding.name.text);
  assert.ok(ts.isStringLiteral(value), 'computed protocol constant must remain a pure string literal');
  return value.text;
}
const registeredProtocolNames = registry.properties.map(property => {
  assert.ok(ts.isPropertyAssignment(property), "protocol registry requires named entries");
  return registryKey(property.name);
});
const isRegistered = run(`${declaration(adapterAst, "isRegisteredVideoProtocol")}; isRegisteredVideoProtocol;`, {
  VIDEO_PROTOCOL_SUBMITTERS: Object.fromEntries(registeredProtocolNames.map(name => [name, null])),
}) as (value: unknown) => boolean;
const autodlProtocol = initializer(ast(read('src/lib/video-autodl-comfyui-workflow.ts')), 'AUTODL_COMFYUI_WORKFLOW_PROTOCOL');
assert.ok(ts.isStringLiteral(autodlProtocol));
assert.equal(isRegistered(autodlProtocol.text), true, 'actual computed AUTODL protocol remains registered');
assert.equal(isRegistered('gaorui_video'), true, 'identifier registry entry remains registered');
assert.equal(isRegistered('fixture-unknown-protocol'), false, 'unknown protocol is never registered');
const rankedCall = initializer(publicAst, "rankedModels");
assert.ok(ts.isCallExpression(rankedCall) && ts.isArrowFunction(rankedCall.arguments[0]));
const rankedBody = rankedCall.arguments[0].body;
assert.ok(ts.isBlock(rankedBody));
const priceStart = rankedBody.statements.findIndex(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => item.name.getText(publicAst) === "priceSnapshotReady"));
const generationEnd = rankedBody.statements.findIndex(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => item.name.getText(publicAst) === "generationReady"));
assert.ok(priceStart >= 0 && generationEnd > priceStart, "complete production public admission block required");
const publicAdmissionSource = rankedBody.statements.slice(priceStart, generationEnd + 1).map(node => node.getText(publicAst)).join("\n");
const rankedReturn = rankedBody.statements.find(ts.isReturnStatement)?.expression;
assert.ok(rankedReturn && ts.isObjectLiteralExpression(rankedReturn));
const readiness = rankedReturn.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(publicAst) === "readinessMessage");
assert.ok(readiness && ts.isPropertyAssignment(readiness));
const readinessInitializerSource = readiness.initializer.getText(publicAst);
const common = { ...admission, ...publicStatus, ...personAdmission, ...capability, ...token,
  requireVideoPriceSnapshot: requirePrice, isRegisteredVideoProtocol: isRegistered };
const endpointSource = declaration(publicAst, "hasLocallyValidVideoEndpoint");
const baseModel = { id: "fixture-model", name: "Fixture video", model_name: "grok-imagine-video-1.0",
  provider: "gaorui", protocol_type: "gaorui_video", api_endpoint: "https://fixture.invalid/v1", api_key: "fixture-only",
  is_active: true, is_hidden: false, price_per_use: 1.2, cost_price: 0.8, duration_seconds: 5, api_protocol_config: {} };
function publicAdmission(model: Record<string, unknown>, compatible = true) {
  return run(`${endpointSource}\n${publicAdmissionSource}\n({ available, priceReady, generationReady, compatibilityCode, capabilitiesVerified,
    readinessMessage: ${readinessInitializerSource} });`, {
    ...common, m: model, protocolConfig: model.api_protocol_config, billingUnit: "per_use", tokenPricing: null,
    resolutionTier: "720p", durationCapabilities: { defaultDuration: 5 }, requestedSurface: "storyboard-workbench",
    surfaceCompatibility: { compatible, issues: [] },
  }) as { available: boolean; priceReady: boolean; generationReady: boolean; compatibilityCode: string; capabilitiesVerified: boolean; readinessMessage: string };
}
function adminAdmission(model: Record<string, unknown>, compatible = true) {
  const names = ["active", "hidden", "configured", "priceReady", "operatorAdmission", "capabilitiesVerified", "billingAdmission", "publishable", "catalogDisplayable", "visibleNow"];
  return run(`${declaration(adminAst, "videoPriceReady")}\n${names.map(name => `const ${name} = ${initializer(adminAst, name).getText(adminAst)};`).join("\n")}\n({publishable,catalogDisplayable,visibleNow});`, {
    ...common, model, surface: { kind: "video" }, protocol: model.api_protocol_config,
    compatibility: { compatible }, assigned: true,
  }) as { publishable: boolean; catalogDisplayable: boolean; visibleNow: boolean };
}
function verifyPublicCopyAndAdmissions() {
  const privateDiagnostic = "fixture-private-admin-acceptance-detail";
  for (const [name, patch, compatible, expected, code] of [
    ["ready", {}, true, true, ""],
    ["missing price", { price_per_use: undefined }, true, false, "VIDEO_PRICE_UNCONFIGURED"],
    ["missing cost", { cost_price: undefined }, true, false, "VIDEO_PRICE_UNCONFIGURED"],
    ["no credential", { api_key: "" }, true, false, "VIDEO_CONFIGURATION_PENDING"],
    ["unknown creation contract", { model_name: "seedance-2.0" }, true, false, "VIDEO_CAPABILITIES_UNVERIFIED"],
    ["capabilities unknown", { api_protocol_config: { capability_contract_verified: false } }, true, false, "VIDEO_CAPABILITIES_UNVERIFIED"],
    ["paused", { api_protocol_config: { generation_paused: true } }, true, false, "VIDEO_MODEL_SUBMISSION_PAUSED"],
    ["inactive", { is_active: false }, true, false, "VIDEO_MODEL_INACTIVE"],
    ["surface incompatible", {}, false, false, "VIDEO_CONFIGURATION_PENDING"],
    ["token settlement pending", { api_protocol_config: { provider_billing_unit: "token" } }, true, false, "VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED"],
  ] as const) {
    const model = { ...baseModel, ...patch };
    const actual = publicAdmission(model, compatible);
    assert.equal(actual.generationReady, expected, `${name}: public submission admission`);
    assert.equal(actual.available, expected, `${name}: availability`);
    assert.equal(actual.compatibilityCode, code, `${name}: fixed public reason`);
    assert.equal(visibility.isVisibleInPublicWorkspace({ surfaceCompatible: compatible, maxReferenceImages: 1 }, "storyboard-video"), true,
      `${name}: catalog display is independent from submission`);
    const admin = adminAdmission(model, compatible);
    assert.equal(admin.publishable, expected, `${name}: real admin publishability`);
    assert.equal(admin.visibleNow, true, `${name}: assigned catalog entry remains visible`);
    const safe = dto.toPublicModelDto("video", model, 0, { ...actual,
      readinessMessage: privateDiagnostic, availabilityMessage: privateDiagnostic, verificationNotice: privateDiagnostic,
      activationReady: false, activationReason: privateDiagnostic });
    assert.ok(!JSON.stringify(safe).includes(privateDiagnostic), `${name}: admin acceptance diagnostic leaked`);
    assert.equal(safe.capabilities.readinessMessage, publicStatus.publicVideoModelCompatibilityMessage(code));
    assert.equal(safe.capabilities.verificationNotice || "", "");
    assert.equal(Object.hasOwn(safe.capabilities, "activationReady"), false);
  }
  const retired = { ...baseModel, provider: retirement.RETIRED_MODEL_PROVIDER, is_active: false, is_hidden: true, api_key: "" };
  const surfaceMatches = run(`${declaration(publicAst, "modelMatchesSurface")}; modelMatchesSurface(row, "storyboard-workbench");`, {
    row: retired, RETIRED_MODEL_PROVIDER: retirement.RETIRED_MODEL_PROVIDER,
    AUTODL_H3_SELFHOST_PROTOCOL: "autodl_h3_selfhost", isDigitalHumanWorkspaceModel: modelSurface.isDigitalHumanWorkspaceModel,
  });
  assert.equal(surfaceMatches, false, "retired tombstones are excluded before public submission selection");
  assert.equal(adminAdmission(retired).publishable, false, "retired tombstone cannot be published");
  const adminVideos = run(`${initializer(adminAst, "videos").getText(adminAst)};`, {
    videoResult: { data: [baseModel, retired] }, RETIRED_MODEL_PROVIDER: retirement.RETIRED_MODEL_PROVIDER,
  }) as unknown[];
  assert.equal(adminVideos.length, 1, "admin video pool filters retired tombstones");
  assert.equal(publicAdmission(retired).generationReady, false);
  assert.equal(publicAdmission({ ...baseModel, protocol_type: "fixture-unknown-protocol" }).generationReady, false,
    "unregistered protocol cannot become publicly submittable");
  return true;
}
const currentCatalogContractsPassed = verifyPublicCopyAndAdmissions();

const configured = resolveVideoCharge({
  price_per_use: 1.2,
  cost_price: 0.8,
}, "1080p", 5);
const missingCost = resolveVideoCharge({ price_per_use: 1.2 }, "1080p", 5);
const nullCost = resolveVideoCharge({ price_per_use: 1.2, cost_price: null }, "1080p", 5);
const missingPrice = resolveVideoCharge({ cost_price: 0.8 }, "1080p", 5);

const assetBridge = generateRoute.indexOf("bridgeVideoProviderAsset(", generateRoute.indexOf("export async function POST"));
const reservation = generateRoute.indexOf("reserveVideoGenerationTask({");

const checks: Array<[string, boolean]> = [
  ["submission does not add a second acceptance-evidence gate", !generateRoute.includes("inspectVideoModelActivationReadiness({") && !generateRoute.includes('error_code: "MODEL_ACCEPTANCE_EVIDENCE_INCOMPLETE"')],
  ["input and protocol validation still precede provider bridging", generateRoute.indexOf("validateVideoInputContract(") < assetBridge],
  ["price reservation and provider bridging remain present", reservation > 0 && assetBridge > 0],
  ["public catalog reads supplier cost", modelsRoute.includes("price_per_use, cost_price, duration_seconds")],
  ["public catalog requires a complete price snapshot", modelsRoute.includes("requireVideoPriceSnapshot(m, resolutionTier, durationCapabilities.defaultDuration)")],
  ["public catalog does not evaluate internal acceptance evidence", !modelsRoute.includes("inspectVideoModelActivationReadiness({")],
  ["public generation readiness follows live availability", modelsRoute.includes("const generationReady = available") && modelsRoute.includes("generationReady: model.generationReady")],
  ["public DTO derives fixed status copy and removes internal acceptance diagnostics", currentCatalogContractsPassed],
  ["real public/admin admissions preserve price credential capability pause billing and display boundaries", currentCatalogContractsPassed],
  ["missing cost remains unknown", Number.isNaN(missingCost.costPrice)],
  ["null cost remains unknown", Number.isNaN(nullCost.costPrice)],
  ["missing sale price remains unknown", Number.isNaN(missingPrice.publicPrice)],
  ["configured paid quote is preserved", configured.publicPrice === 1.2 && configured.costPrice === 0.8],
  ["unknown sale price fails closed", finalizer.includes('"VIDEO_PRICE_CONFIGURATION_INVALID"') && finalizer.includes("!Number.isFinite(priceYuan)")],
  ["unknown supplier cost fails closed", finalizer.includes('"VIDEO_COST_CONFIGURATION_INVALID"') && finalizer.includes("!Number.isFinite(costPriceYuan)")],
  ["free mode requires an explicit marker", finalizer.includes("protocol.explicitly_free === true") && finalizer.includes('toLowerCase() === "free"')],
  ["long history GET does not start a worker", !longHistoryRoute.includes("startDigitalHumanLongWorker")],
  ["long status GET does not start a worker", !longStatusRoute.includes("startDigitalHumanLongWorker")],
  ["dedicated media process starts the long worker", mediaWorkerRuntime.includes("const long = startDigitalHumanLongWorker()")],
  ["storyboard agent prompt GET requires prompt-view capability and step-up", /export async function GET\(request:\s*(?:Request|NextRequest)\)[\s\S]*authorizeAdminCapability[\s\S]*prompts\.view[\s\S]*requireStepUp:\s*true/u.test(storyboardAgentRoute)],
  ["long digital-human submit enforces activation readiness", digitalHumanLongCreate.includes("inspectVideoModelActivationReadiness") && digitalHumanLongCreate.includes("MODEL_ACCEPTANCE_EVIDENCE_INCOMPLETE")],
  ["long digital-human submit rejects unknown cost", digitalHumanLongCreate.includes("!Number.isFinite(unitCharge.costPrice)") && digitalHumanLongCreate.includes("DIGITAL_HUMAN_LONG_COST_INVALID")],
  ["voice catalog uses a read-only SQLite connection", voiceCatalog.includes("getVoiceReadonlyDb") && voiceDb.includes("readonly: true")],
  ["voice pricing opens SQLite read-only", voicePricing.includes("readonly: true") && !voicePricing.includes("journal_mode = WAL")],
];

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(`${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`${checks.length}/${checks.length} checks passed`);
