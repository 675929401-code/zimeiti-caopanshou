import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const files = {
  protocol: await read("src/app/api/video/detect-protocol/route.ts"),
  catalog: await read("src/app/api/llm-models/route.ts"),
  llm: await read("src/app/api/llm/route.ts"),
  image: await read("src/app/api/image/generate/route.ts"),
  video: await read("src/app/api/video/generate/route.ts"),
  adminPage: await read("src/app/admin/page.tsx"),
  canvasPrompt: await read("src/components/admin/CanvasPromptPresetsTab.tsx"),
};

function before(source, earlier, later, message) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.ok(earlierIndex >= 0, `${message}: missing ${earlier}`);
  assert.ok(laterIndex >= 0, `${message}: missing ${later}`);
  assert.ok(earlierIndex < laterIndex, message);
}

const protocolGet = files.protocol.slice(
  files.protocol.indexOf("export async function GET"),
  files.protocol.indexOf("export async function POST"),
);
const protocolPost = files.protocol.slice(files.protocol.indexOf("export async function POST"));
for (const [name, source] of [["GET", protocolGet], ["POST", protocolPost]]) {
  assert.match(source, /authorizeAdminCapability\(req,\s*"models\.manage",\s*\{[\s\S]*?requireStepUp:\s*true/u, `${name} protocol route must require models.manage step-up`);
  assert.match(source, /if \(!authorization\.ok\) return authorization\.response;/u, `${name} protocol route must reuse the generic denial response`);
  assert.doesNotMatch(source, /requiredPermission\s*:/u, `${name} protocol route must not disclose a permission name itself`);
}
before(protocolPost, "authorizeAdminCapability", "await req.json()", "protocol POST must authorize before parsing configuration or contacting a provider");
before(protocolPost, "authorizeAdminCapability", "autoDetectVideoProtocol", "protocol POST must authorize before provider detection");

const adminCatalogBranch = files.catalog.slice(
  files.catalog.indexOf("if (adminConfigurationRequested)"),
  files.catalog.indexOf("const dbClient"),
);
assert.match(files.catalog, /searchParams\.get\("admin"\) === "1"/u, "full catalog mode must require an explicit admin=1 request");
assert.doesNotMatch(files.catalog, /isVerifiedAdminModelRequest/u, "an admin role alone must not widen the default catalog response");
assert.match(adminCatalogBranch, /const capabilityRequest = request instanceof NextRequest[\s\S]*?new NextRequest\(request\.url/u, "direct server catalog callers must be adapted before capability checks");
for (const permission of ["models.manage", "agents.manage"]) {
  assert.match(adminCatalogBranch, new RegExp(`authorizeAdminCapability\\(capabilityRequest,\\s*"${permission.replace(".", "\\.")}"[\\s\\S]*?requireStepUp:\\s*true`, "u"), `admin catalog must require ${permission} with step-up`);
}
assert.match(files.catalog, /select\(adminConfigurationRequested\s*\?\s*"\*"\s*:\s*"id, name, model_name/u, "explicit admin and public catalog projections must remain separate");
assert.match(files.catalog, /toPublicModelDto\("llm"/u, "ordinary members must keep the public DTO catalog");
before(files.catalog, "if (adminConfigurationRequested)", ".select(adminConfigurationRequested", "full model configuration must be gated before its database projection");
assert.match(files.adminPage, /fetch\("\/api\/llm-models\?admin=1",\s*\{\s*headers:\s*authHeaders\s*\}\)/u, "the administrator model editor must explicitly request the full DTO");
assert.match(files.canvasPrompt, /fetch\("\/api\/llm-models",\s*\{\s*headers\s*\}\)/u, "Canvas prompt presets must keep the sanitized default catalog");
assert.doesNotMatch(files.canvasPrompt, /\/api\/llm-models\?admin=1/u, "Canvas prompt presets must not request private model configuration");

assert.match(files.llm, /const capabilityRequest = request instanceof NextRequest[\s\S]*?new NextRequest\(request\.url/u, "direct server callers must be adapted to a NextRequest before capability authorization");
assert.match(files.llm, /clientProxyUrl\.trim\(\) \|\| adminInternalModelRequested \|\| adminSecurityBypassRequested/u, "LLM privileged trigger set is incomplete");
assert.match(files.llm, /authorizeAdminCapability\(capabilityRequest,\s*"models\.manage",\s*\{[\s\S]*?requireStepUp:\s*true/u, "LLM privileged branches must require models.manage step-up");
assert.match(files.llm, /if \(!_preSecurityBypassAuthorized\) \{\s*const securityBlock = await runSecurityChecks/u, "security checks may only be skipped after capability authorization");
assert.match(files.llm, /!_preSecurityBypassAuthorized && lastGuardText/u, "prompt-injection checks may only be skipped after capability authorization");
assert.match(files.llm, /else if \(_preModelControlsAuthorized && model\)/u, "raw internal model lookup must require the capability decision");
assert.match(files.llm, /if \(_preModelControlsAuthorized && clientProxyUrl\.trim\(\)\)/u, "client proxy override must require the capability decision");
assert.match(files.llm, /const currentAdmin = await authorizeAdminToken\(_preToken\)/u, "JWT role claims must be refreshed against current admin state");
before(files.llm, "authorizeAdminCapability(capabilityRequest", "runSecurityChecks(body", "LLM privilege authorization must precede security bypass and data/provider work");

assert.match(files.image, /adminValidation \|\| internalModelIdRequested/u, "image privileged trigger set is incomplete");
assert.match(files.image, /authorizeAdminCapability\(request,\s*"models\.manage",\s*\{[\s\S]*?requireStepUp:\s*true/u, "image validation/internal model path must require models.manage step-up");
assert.match(files.image, /if \(!modelAccess\.ok\) return modelAccess\.response;\s*privilegedModelOperationAuthorized = true;/u, "image diagnostic exemptions must derive from this request's capability decision");
assert.match(files.image, /if \(!privilegedModelOperationAuthorized && !requestedIdempotencyKey\)/u, "ordinary administrator image requests must still require an idempotency key");
assert.match(files.image, /if \(!privilegedModelOperationAuthorized && !requestedTraceId\)/u, "ordinary administrator image requests must still require a stable trace key");
assert.match(files.image, /privilegedModelOperationAuthorized \? availableModels\.find/u, "internal image model lookup must require this request's capability decision");
assert.match(files.image, /if \(!privilegedModelOperationAuthorized && !resumeDeliveryOnly\)/u, "ordinary administrator image requests must still enforce membership state");
assert.doesNotMatch(files.image, /const isAdmin = userRole === "admin"/u, "image business constraints must not derive exemptions from role alone");
assert.match(files.image, /if \(sellingPrice > 0\) \{[\s\S]*?executeCashDeduction\(\{/u, "ordinary administrator image requests must keep the paid balance and deduction path");
assert.match(files.image, /billingExempt:\s*sellingPrice === 0/u, "image billing exemption must derive from a zero published price, not administrator role");
before(files.image, "authorizeAdminCapability(request", "await writeImageTrace({\n      phase: \"requested\"", "image privilege authorization must precede trace, configuration, billing, and provider work");
before(files.image, "authorizeAdminCapability(request", "validationControl = await prepareImageGenerationValidation", "image validation must be gated before its control path");

assert.match(files.video, /adminValidationRequested \|\| healthRecoveryCanaryRequested \|\| healthOperatorRetest \|\| internalModelIdRequested/u, "video privileged trigger set is incomplete");
assert.match(files.video, /authorizeAdminCapability\(req,\s*"models\.manage",\s*\{[\s\S]*?requireStepUp:\s*true/u, "video validation/canary/internal model path must require models.manage step-up");
assert.match(files.video, /if \(!modelAccess\.ok\) return modelAccess\.response;\s*privilegedModelOperationAuthorized = true;/u, "video diagnostic exemptions must derive from this request's capability decision");
assert.match(files.video, /else if \(privilegedModelOperationAuthorized\)/u, "internal video model lookup must require this request's capability decision");
assert.match(files.video, /!adminValidationRequested && privilegedModelOperationAuthorized && !String\(model_id\)\.startsWith\("pm_"\)/u, "production internal model fallback must require this request's capability decision");
assert.match(files.video, /if \(!privilegedModelOperationAuthorized\) \{/u, "ordinary administrator video requests must still enforce membership state");
assert.doesNotMatch(files.video, /else if \(userRole === "admin"\)|userRole !== "admin"/u, "video business constraints must not derive exemptions from role alone");
assert.match(files.video, /const billingExempt = false;/u, "video generation must not exempt administrators from billing");
assert.match(files.video, /if \(price > 0\) \{[\s\S]*?reserveVideoGenerationTask\(\{/u, "ordinary administrator video requests must keep the paid balance and reservation path");
before(files.video, "authorizeAdminCapability(req", "await writeVideoTrace({\n      phase: \"requested\"", "video privilege authorization must precede trace, configuration, billing, and provider work");
before(files.video, "authorizeAdminCapability(req", "const context = await loadVideoAdminValidationContext", "video admin validation must be gated before private configuration reads");
before(files.video, "authorizeAdminCapability(req", "const authorization = authorizeVideoChannelRecoveryCanary", "video health canary must be gated before its legacy proof checks");

for (const [name, source] of Object.entries(files)) {
  assert.doesNotMatch(source, /requiredPermission\s*:/u, `${name} route must rely on centralized concealed denials`);
}

console.log("model/core configuration bypass permission contract: PASS");
console.log("network_calls=0 database_writes=0 provider_calls=0");
