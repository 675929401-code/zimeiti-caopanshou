import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { gaoruiVideoCreateContractAdmission } from "../src/lib/gaorui-video-contract-admission";
import { videoOperatorSubmissionAdmission } from "../src/lib/video-model-availability";
import { containsForbiddenPublicModelKey, toPublicModelDto } from "../src/lib/public-model-dto";
import { pollVideoTask, submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

// Exercise the actual early route block, not a second implementation of its gate.
const routeSource = readFileSync("src/app/api/video/generate/route.ts", "utf8");
const tree = ts.createSourceFile("route.ts", routeSource, ts.ScriptTarget.Latest, true);
const post = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "POST");
assert.ok(post?.body);
const outerTry = post.body.statements.find(ts.isTryStatement);
assert.ok(outerTry);
const statements = [...outerTry.tryBlock.statements];
const declares = (node: ts.Statement, name: string) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => item.name.getText(tree) === name);
const start = statements.findIndex(node => declares(node, "selectedProtocolConfig"));
const end = statements.findIndex(node => declares(node, "protocolParameterIssue"));
assert.ok(start >= 0 && end > start);
const guard = statements.slice(start, end).map(node => node.getText(tree)).join("\n");
assert.match(guard, /videoOperatorSubmissionAdmission\(selectedProtocolConfig, selectedModel\)/u);
const guardOffset = routeSource.indexOf(guard.slice(0, 80));
assert.ok(guardOffset >= 0);
for (const call of ["await bridgeGeneratedImageForVideoProvider(", "await bridgeVideoProviderAsset(", "await reserveVideoGenerationTask(", "await acquireProviderAdmission(", "await prepareGaoruiPersonVideoExecution("]) {
  const offset = routeSource.indexOf(call, guardOffset);
  assert.ok(offset > guardOffset + guard.length, `${call} must follow the early contract gate`);
}
const routeContext = {
  videoOperatorSubmissionAdmission,
  NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  exports: {} as { inspect: (selectedModel: VideoModelConfig) => Promise<Response> },
};
runInNewContext(ts.transpileModule(`export async function inspect(selectedModel: unknown) { ${guard}; return Response.json({ reachedParameterValidation: true }); }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { ...routeContext, Response });

const base: VideoModelConfig = {
  id: "offline-gaorui-contract", name: "Offline contract", provider: "gaorui", protocol_type: "gaorui_video",
  model_name: "seedance-2.0-fast", api_endpoint: "https://fixture.invalid/v1", api_key: "offline-only",
  price_per_use: 0.5, duration_seconds: 8, supports_image_input: true,
};
const params = { prompt: "Offline contract verification", duration: 8, resolutionTier: "720p", aspectRatio: "16:9" };
const calls: Array<{ method: string; path: string }> = [];
const checks: string[] = [];
const savedFetch = globalThis.fetch;
let pollStatus = "cancelled";

async function main() {
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    assert.ok(["https://fixture.invalid", "https://gaorui.cc"].includes(url.origin), "REAL_NETWORK_FORBIDDEN");
    assert.ok(url.pathname === "/v1/videos" || url.pathname === "/v1/videos/original-task");
    calls.push({ method: request.method, path: url.pathname });
    return Response.json(request.method === "GET" ? { status: pollStatus } : { id: "offline-create", status: "queued" });
  };
  try {
    for (const model_name of ["seedance-2.0", "seedance-2.5"]) {
      for (const flag of [undefined, false, true]) {
        const protocol = { protocol_family: "seedance_native_content" as const, max_reference_images: 1, ...(flag === undefined ? {} : { capability_contract_verified: flag }), duration_behavior: "requested_target" };
        const model = { ...base, model_name, api_endpoint: "https://gaorui.cc/v1", api_protocol_config: protocol };
        assert.equal(gaoruiVideoCreateContractAdmission(model).ready, true);
        assert.equal(videoOperatorSubmissionAdmission(protocol, model).ready, true);
        assert.equal((await routeContext.exports.inspect(model)).status, 200);
        const beforeCalls = calls.length;
        assert.equal((await submitVideoTask(model, params)).taskId, "offline-create");
        assert.equal(calls.length, beforeCalls + 1);
        const dto = toPublicModelDto("video", model, 0, { type: "video", capabilitiesVerified: flag !== false, available: true, generationReady: true, priceReady: true, maxReferenceImages: 1 });
        assert.equal(dto.capabilities.generationReady, true);
        assert.equal(dto.capabilities.maxReferenceImages, 1);
        assert.equal(containsForbiddenPublicModelKey(dto), false);
        checks.push(`${model_name}:${String(flag)}:binding-not-paid-proof`);
      }
      for (const patch of [{ api_endpoint: "https://gaorui.cc.evil.invalid/v1" }, { api_endpoint: "https://gaorui.cc/v1?query=1" }, { api_protocol_config: {} }]) {
        const model = { ...base, model_name, api_endpoint: "https://gaorui.cc/v1", api_protocol_config: { protocol_family: "seedance_native_content" as const }, ...patch };
        assert.equal(gaoruiVideoCreateContractAdmission(model).ready, false);
        assert.equal(videoOperatorSubmissionAdmission(model.api_protocol_config, model).code, "VIDEO_CONFIGURATION_PENDING");
        const count = calls.length; await assert.rejects(() => submitVideoTask(model, params)); assert.equal(calls.length, count);
        assert.equal((await routeContext.exports.inspect(model)).status, 422);
        checks.push(`${model_name}:invalid-binding-before-network`);
      }
    }
    for (const model_name of ["seedance-2.0-fast", "seedance-2.0-mini", "minimax-h3", "grok-imagine-video-1.5", "omni_flash_10s"]) {
      const model = { ...base, model_name };
      assert.equal(gaoruiVideoCreateContractAdmission(model).ready, true);
      assert.equal(videoOperatorSubmissionAdmission({}, model).ready, true);
      assert.equal((await routeContext.exports.inspect(model)).status, 200);
      checks.push(`${model_name}:existing-gate-unchanged`);
    }
    for (const protocol_type of ["secure_skill_seedance_video", "doubao_seedance", "other-video"]) {
      assert.equal(gaoruiVideoCreateContractAdmission({ protocol_type, model_name: "seedance-2.0" }).ready, true);
      checks.push(`${protocol_type}:same-name-not-blocked-by-gaorui-gate`);
    }
    for (pollStatus of ["expired", "cancelled", "canceled"]) {
      const response = await pollVideoTask({ ...base, model_name: "seedance-2.0" }, "original-task");
      assert.equal(response.taskId, "original-task");
      assert.equal(response.status, "failed");
      assert.equal(response.terminalState, pollStatus === "expired" ? undefined : "cancelled");
      checks.push(`old-normal-task:${pollStatus}:still-terminal`);
    }
    assert.equal(calls.filter(call => call.method === "POST").length, 6);
    console.log(JSON.stringify({ passed: true, checks: checks.length, cases: checks, realNetworkCalls: 0,
      simulatedPollCalls: calls.filter(call => call.method === "GET").length, simulatedCreateCalls: 6, databaseWrites: 0, billingReservations: 0,
      routeGuardRunsBeforeAssetBridgeAndReservation: true }));
  } finally {
    globalThis.fetch = savedFetch;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
