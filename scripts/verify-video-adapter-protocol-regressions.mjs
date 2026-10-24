import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

// Execute the real adapter and endpoint/audit helpers. Only provider I/O is
// replaced, so this verification cannot create a task or incur a charge.
const nativeRequire = createRequire(import.meta.url);
const calls = [];
let responseFactory = async () => Response.json({});
const cache = new Map();
const unrelated = new Proxy({}, {
  get: (_target, property) => property === "AUTODL_COMFYUI_WORKFLOW_PROTOCOL"
    ? "unrelated-fixture-protocol"
    : () => { throw new Error(`UNEXPECTED_PROTOCOL_MODULE:${String(property)}`); },
});

function load(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute);
  const loaded = { exports: {} };
  cache.set(absolute, loaded.exports);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolute,
  }).outputText;
  vm.runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    require: name => {
      if (name.startsWith("node:")) return nativeRequire(name);
      if ([
        "./video-provider-request-audit",
        "./video-autodl-comfyui-workflow",
        "./video-doubao-seedance-relay",
        "./video-seedance-relay",
        "./api-endpoints",
        "./video-prompt-timing",
      ].includes(name)) {
        return load(path.join(path.dirname(absolute), `${name}.ts`));
      }
      if (name === "./video-suanlicheng-material") {
        return {
          readSuanlichengMaterial: async () => ({ buffer: Buffer.from("fixture-image"), contentType: "image/png" }),
        };
      }
      return unrelated;
    },
    Request,
    Response,
    Headers,
    URL,
    FormData,
    Blob,
    AbortController,
    AbortSignal,
    DOMException,
    TextDecoder,
    TextEncoder,
    Buffer,
    setTimeout,
    clearTimeout,
    crypto: nativeRequire("node:crypto").webcrypto,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (input, init = {}) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const contentType = request.headers.get("content-type") || "";
      const body = request.method === "GET" || request.method === "HEAD"
        ? null
        : contentType.includes("application/json")
          ? await request.clone().json()
          : contentType.includes("multipart/form-data")
            ? Object.fromEntries([...(await request.clone().formData()).entries()].map(([key, value]) => [
              key,
              typeof value === "string" ? value : { name: value.name, size: value.size, type: value.type },
            ]))
            : null;
      const headers = Object.fromEntries(new Headers(input instanceof Request ? input.headers : init.headers).entries());
      calls.push({
        url: request.url,
        method: request.method.toUpperCase(),
        headers,
        body,
        bodyKind: contentType.includes("multipart/form-data") ? "multipart" : "json",
      });
      return responseFactory(request, init);
    },
  }, { filename: absolute });
  return loaded.exports;
}

const adapter = load("src/lib/video-adapter.ts");
const baseConfig = (protocolType, extra = {}) => ({
  id: `fixture-${protocolType}`,
  name: "fixture",
  provider: "fixture",
  api_endpoint: "https://relay.example/channel/v1",
  api_key: "fixture-only",
  protocol_type: protocolType,
  price_per_use: 0,
  duration_seconds: 8,
  supports_image_input: true,
  model_name: "fixture-video-model",
  ...extra,
});
const json = (value, status = 200) => async () => Response.json(value, { status });

let passed = 0;
async function test(name, run) {
  calls.length = 0;
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

for (const terminalStatus of ["failed", "error", "cancelled", "canceled"]) {
  await test(`OpenAI-compatible submit preserves root terminal status ${terminalStatus}`, async () => {
    responseFactory = json({ id: "openai-task", status: terminalStatus, error: { message: "provider terminal" } });
    const result = await adapter.submitVideoTask(baseConfig("openai_compatible"), { prompt: "fixture" });
    assert.equal(result.status, "failed");
    assert.match(String(result.error), /provider terminal/u);
    assert.equal(calls.length, 1);
  });

  await test(`OpenAI-compatible poll preserves root terminal status ${terminalStatus}`, async () => {
    responseFactory = json({ id: "openai-task", status: terminalStatus, error: { message: "provider terminal" } });
    const result = await adapter.pollVideoTask(baseConfig("openai_compatible"), "openai-task");
    assert.equal(result.status, "failed");
    assert.match(String(result.error), /provider terminal/u);
    assert.equal(calls.length, 1);
  });
}

for (const protocolType of [
  "openai_compatible",
  "runway",
  "replicate",
  "secure_skill_doubao_seedance",
  "secure_skill_grok_video",
  "secure_skill_flow_jobs",
]) {
  await test(`${protocolType} treats poll HTTP 429 as retryable`, async () => {
    responseFactory = json({ error: { message: "rate limited" } }, 429);
    const config = protocolType === "runway"
      ? baseConfig(protocolType, { api_endpoint: "https://relay.example/runway/v1/image_to_video" })
      : protocolType === "replicate"
        ? baseConfig(protocolType, { api_endpoint: "https://relay.example/replicate/v1/predictions" })
        : baseConfig(protocolType);
    const result = await adapter.pollVideoTask(config, "poll-task");
    assert.equal(result.status, "processing");
    assert.match(String(result.error), /429/u);
    assert.match(String(result.error), /重试/u);
    assert.equal(calls.length, 1);
  });
}

await test("Runway polling stays on the configured relay and preserves its path prefix", async () => {
  responseFactory = json({ id: "runway-task", status: "RUNNING" });
  const config = baseConfig("runway", {
    api_endpoint: "https://relay.example/tenant/runway/v1/image_to_video",
  });
  const result = await adapter.pollVideoTask(config, "runway/task");
  assert.equal(result.status, "processing");
  const url = new URL(calls[0].url);
  assert.equal(url.host, "relay.example");
  assert.equal(url.pathname, "/tenant/runway/v1/tasks/runway%2Ftask");
  assert.doesNotMatch(calls[0].url, /api\.dev\.runwayml\.com/u);
});

await test("Runway honors an explicit configured poll_path", async () => {
  responseFactory = json({ id: "runway-task", status: "RUNNING" });
  const config = baseConfig("runway", {
    api_endpoint: "https://relay.example/tenant/runway/v1/image_to_video",
    api_protocol_config: { poll_path: "/custom/runway/tasks/{task_id}" },
  });
  await adapter.pollVideoTask(config, "configured-task");
  assert.equal(new URL(calls[0].url).pathname, "/custom/runway/tasks/configured-task");
});

await test("Replicate submit uses model_name and sends duration", async () => {
  responseFactory = json({ id: "replicate-task", status: "starting" });
  const config = baseConfig("replicate", {
    api_endpoint: "https://relay.example/tenant/replicate/v1/predictions",
    model_name: "owner/video-model:version-hash",
    duration_seconds: 12,
  });
  const result = await adapter.submitVideoTask(config, { prompt: "fixture", duration: 20, aspectRatio: "16:9" });
  assert.equal(result.taskId, "replicate-task");
  assert.equal(calls[0].body.version, "owner/video-model:version-hash");
  assert.equal(calls[0].body.input.duration, 20);
});

await test("Replicate polling appends the task to the configured submit endpoint", async () => {
  responseFactory = json({ id: "replicate-task", status: "processing" });
  const config = baseConfig("replicate", {
    api_endpoint: "https://relay.example/tenant/replicate/v1/predictions",
  });
  await adapter.pollVideoTask(config, "replicate-task");
  const url = new URL(calls[0].url);
  assert.equal(url.host, "relay.example");
  assert.equal(url.pathname, "/tenant/replicate/v1/predictions/replicate-task");
  assert.doesNotMatch(calls[0].url, /api\.replicate\.com/u);
});

await test("Secure Skill Grok accepts a configured 20 second capability", async () => {
  responseFactory = json({ id: "grok-task", status: "queued" });
  const config = baseConfig("secure_skill_grok_video", {
    api_endpoint: "https://relay.example/channel/v1",
    model_name: "grok-imagine-video-1.5",
    api_protocol_config: {
      duration_options: [5, 10, 15, 20],
      min_duration: 5,
      max_duration: 20,
    },
  });
  const result = await adapter.submitVideoTask(config, { prompt: "fixture", duration: 20, aspectRatio: "16:9" });
  assert.equal(result.taskId, "grok-task");
  assert.equal(calls[0].body.seconds, 20);
});

await test("Secure Skill still enforces a lower configured duration ceiling", async () => {
  responseFactory = json({ id: "grok-task", status: "queued" });
  const config = baseConfig("secure_skill_grok_video", {
    model_name: "grok-imagine-video-1.5",
    api_protocol_config: { min_duration: 5, max_duration: 15 },
  });
  await assert.rejects(
    adapter.submitVideoTask(config, { prompt: "fixture", duration: 20, aspectRatio: "16:9" }),
    error => error.name === "VideoParameterContractError" && error.status === 422 && error.parameter === "duration",
  );
  assert.equal(calls.length, 0, "Unsupported duration must not dispatch or silently clamp");
});

const secureSkillSubmitCases = [
  {
    protocolType: "secure_skill_enterprise_video",
    config: baseConfig("secure_skill_enterprise_video", { model_name: "video-2.0-fast" }),
    params: { prompt: "fixture", duration: 8, aspectRatio: "16:9" },
    location: "/channel/v1/videos/enterprise-location-task",
  },
  {
    protocolType: "secure_skill_seedance_video",
    config: baseConfig("secure_skill_seedance_video", { model_name: "seedance-2.5" }),
    params: { prompt: "fixture", duration: 8, aspectRatio: "16:9", resolutionTier: "720p" },
    location: "/channel/v1/videos/seedance-location-task",
  },
  {
    protocolType: "secure_skill_doubao_seedance",
    config: baseConfig("secure_skill_doubao_seedance", { model_name: "doubao-seedance-2-0-fast-260128" }),
    params: { prompt: "fixture", duration: 8, aspectRatio: "16:9", resolutionTier: "720p" },
    location: "/api/v3/contents/generations/tasks/doubao-location-task",
  },
  {
    protocolType: "secure_skill_flow_jobs",
    config: baseConfig("secure_skill_flow_jobs", { model_name: "omni" }),
    params: { prompt: "fixture", duration: 8, aspectRatio: "16:9" },
    location: "/channel/v1/jobs/flow-location-task",
  },
  {
    protocolType: "secure_skill_wan3_video",
    config: baseConfig("secure_skill_wan3_video", { model_name: "wan3.0" }),
    params: { prompt: "fixture", duration: 8, aspectRatio: "16:9", resolutionTier: "720p" },
    location: "/channel/v1/videos/tasks/wan3-location-task",
  },
];

for (const fixture of secureSkillSubmitCases) {
  const idempotencyKey = `video-${fixture.protocolType}-fixture`;
  await test(`${fixture.protocolType} accepts nested task acknowledgement with one idempotent POST`, async () => {
    responseFactory = json({ data: { task: { id: `${fixture.protocolType}-nested-task` } }, status: "queued" }, 202);
    const result = await adapter.submitVideoTask(fixture.config, { ...fixture.params, idempotencyKey });
    assert.equal(result.taskId, `${fixture.protocolType}-nested-task`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["x-idempotency-key"], idempotencyKey);
    if (fixture.protocolType === "secure_skill_wan3_video") {
      assert.equal(calls[0].headers["idempotency-key"], idempotencyKey);
    }
  });

  await test(`${fixture.protocolType} accepts a same-host Location acknowledgement with one POST`, async () => {
    responseFactory = async () => new Response(JSON.stringify({ status: "queued" }), {
      status: 202,
      headers: { "Content-Type": "application/json", Location: fixture.location },
    });
    const result = await adapter.submitVideoTask(fixture.config, { ...fixture.params, idempotencyKey });
    assert.match(result.taskId, /location-task$/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["x-idempotency-key"], idempotencyKey);
  });
}

for (const protocolType of [
  "secure_skill_video",
  "secure_skill_grok_video",
  "secure_skill_enterprise_video",
  "secure_skill_seedance_video",
  "secure_skill_doubao_seedance",
  "secure_skill_flow_jobs",
  "secure_skill_wan3_video",
]) {
  for (const terminalStatus of ["expired", "timeout", "timed_out", "rejected"]) {
    await test(`${protocolType} maps ${terminalStatus} to a terminal failure`, async () => {
      responseFactory = json({ id: "secure-terminal-task", status: terminalStatus, error: { message: terminalStatus } });
      const result = await adapter.pollVideoTask(baseConfig(protocolType), "secure-terminal-task");
      assert.equal(result.status, "failed");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "GET");
    });
  }
}

await test("Secure Skill Flow completed without an asset remains processing", async () => {
  responseFactory = json({ id: "flow-asset-lag-task", status: "completed", progress: 100 });
  const result = await adapter.pollVideoTask(baseConfig("secure_skill_flow_jobs"), "flow-asset-lag-task");
  assert.equal(result.status, "processing");
  assert.equal(result.videoUrl, undefined);
  assert.equal(calls.length, 1);
});

const autodlWorkflowConfig = baseConfig("autodl_comfyui_workflow", {
  api_endpoint: "https://www.autodl.art/api/v1",
  model_name: "minimax_h3_lightx2v_no_pic",
  api_protocol_config: {
    workflow_id: "minimax_h3_lightx2v_no_pic",
    workflow_input_mode: "text",
    min_duration: 1,
    max_duration: 15,
    resolution_options: ["480p"],
    aspect_ratios: ["16:9"],
  },
});
const autodlParams = {
  prompt: "fixture",
  duration: 8,
  resolutionTier: "480p",
  aspectRatio: "16:9",
  idempotencyKey: "video-fixture-original-request",
};

await test("AutoDL workflow POST records provider dispatch and forwards the stable request key", async () => {
  responseFactory = json({ code: "Success", data: { task_id: "autodl-task", status: "QUEUED" } });
  const receipts = [];
  const result = await adapter.submitVideoTask(autodlWorkflowConfig, {
    ...autodlParams,
    onProviderRequest: async receipt => { receipts.push(receipt); },
  });
  assert.equal(result.taskId, "autodl-task");
  assert.equal(result.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-idempotency-key"], autodlParams.idempotencyKey);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].endpointHost, "www.autodl.art");
  assert.equal(receipts[0].submittedModel, null);
  assert.equal(receipts[0].submittedWorkflow, "minimax_h3_lightx2v_no_pic");
});

await test("AutoDL workflow lost acknowledgement stays unknown and is never replayed", async () => {
  responseFactory = async () => { throw new TypeError("fixture transport closed after dispatch"); };
  const receipts = [];
  const result = await adapter.submitVideoTask(autodlWorkflowConfig, {
    ...autodlParams,
    onProviderRequest: async receipt => { receipts.push(receipt); },
  });
  assert.equal(result.status, "processing");
  assert.equal(result.submissionOutcome, "unknown");
  assert.match(String(result.error), /不要重复生成/u);
  assert.equal(calls.length, 1);
  assert.equal(receipts.length, 1);
});

await test("AutoDL workflow HTTP 200 without task_id stays unknown", async () => {
  responseFactory = json({ code: "Success", data: { status: "QUEUED" } });
  const result = await adapter.submitVideoTask(autodlWorkflowConfig, autodlParams);
  assert.equal(result.status, "processing");
  assert.equal(result.submissionOutcome, "unknown");
  assert.equal(result.taskId, "");
  assert.equal(calls.length, 1);
});

await test("AutoDL workflow poll HTTP 429 remains processing", async () => {
  responseFactory = json({ message: "rate limited" }, 429);
  const result = await adapter.pollVideoTask(autodlWorkflowConfig, "autodl-task");
  assert.equal(result.status, "processing");
  assert.match(String(result.error), /429/u);
  assert.match(String(result.error), /重试/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

for (const terminalStatus of ["EXPIRED", "TIMEOUT", "TIMED_OUT", "REJECTED"]) {
  await test(`AutoDL workflow maps ${terminalStatus} to a terminal failure`, async () => {
    responseFactory = json({ code: "Success", data: { task_id: "autodl-task", status: terminalStatus } });
    const result = await adapter.pollVideoTask(autodlWorkflowConfig, "autodl-task");
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 1);
  });
}

await test("AutoDL workflow completed without an asset remains processing", async () => {
  responseFactory = json({ code: "Success", data: { task_id: "autodl-task", status: "COMPLETED", results: [] } });
  const result = await adapter.pollVideoTask(autodlWorkflowConfig, "autodl-task");
  assert.equal(result.status, "processing");
  assert.equal(result.videoUrl, undefined);
  assert.match(String(result.error), /等待/u);
  assert.equal(calls.length, 1);
});

const autodlH3Config = baseConfig("autodl_comfyui_h3", {
  api_endpoint: "https://www.autodl.art/api/v1",
  model_name: "minimax_h3_multimodal",
  api_protocol_config: { workflow_id: "minimax_h3_multimodal", max_reference_images: 9, max_reference_audios: 3 },
});
const autodlH3Params = {
  prompt: "fixture", duration: 8, resolutionTier: "720p", aspectRatio: "16:9",
  idempotencyKey: "video-autodl-h3-original-request",
};

await test("AutoDL H3 success uses one POST and records a submission receipt", async () => {
  responseFactory = json({ code: "Success", data: { task_id: "autodl-h3-task", status: "QUEUED" } });
  const result = await adapter.submitVideoTask(autodlH3Config, autodlH3Params);
  assert.equal(result.taskId, "autodl-h3-task");
  assert.equal(result.status, "queued");
  assert.equal(result.submissionReceipt?.receiptState, "response_received");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-idempotency-key"], autodlH3Params.idempotencyKey);
});

await test("AutoDL H3 transport loss is unknown with zero retry", async () => {
  responseFactory = async () => { throw new TypeError("fixture transport loss"); };
  const result = await adapter.submitVideoTask(autodlH3Config, autodlH3Params);
  assert.equal(result.submissionOutcome, "unknown");
  assert.equal(result.status, "processing");
  assert.equal(result.submissionReceipt?.receiptState, "transport_unavailable");
  assert.equal(calls.length, 1);
});

await test("AutoDL H3 HTTP 503 is unknown with zero retry", async () => {
  responseFactory = json({ code: "error", message: "temporary unavailable" }, 503);
  const result = await adapter.submitVideoTask(autodlH3Config, autodlH3Params);
  assert.equal(result.submissionOutcome, "unknown");
  assert.equal(result.status, "processing");
  assert.equal(result.submissionReceipt?.httpStatus, 503);
  assert.equal(calls.length, 1);
});

await test("AutoDL H3 HTTP 200 without task_id is unknown with zero retry", async () => {
  responseFactory = json({ code: "Success", data: { status: "QUEUED" } });
  const result = await adapter.submitVideoTask(autodlH3Config, autodlH3Params);
  assert.equal(result.submissionOutcome, "unknown");
  assert.equal(result.status, "processing");
  assert.equal(result.submissionReceipt?.httpStatus, 200);
  assert.equal(calls.length, 1);
});

await test("AutoDL H3 explicit HTTP 400 rejection is terminal and receipted", async () => {
  responseFactory = json({ code: "invalid_parameter", message: "invalid parameter" }, 400);
  const result = await adapter.submitVideoTask(autodlH3Config, autodlH3Params);
  assert.equal(result.status, "failed");
  assert.equal(result.submissionOutcome, undefined);
  assert.equal(result.submissionReceipt?.httpStatus, 400);
  assert.equal(calls.length, 1);
});

await test("NewAPI schema rejection performs exactly one provider POST", async () => {
  responseFactory = json({ error: { message: "unknown field ratio" } }, 400);
  const idempotencyKey = "video-newapi-original-request";
  const result = await adapter.submitVideoTask(baseConfig("newapi_video", {
    api_endpoint: "https://relay.example/openclaw/v1",
  }), {
    prompt: "fixture",
    duration: 8,
    aspectRatio: "16:9",
    idempotencyKey,
  });
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /unknown field ratio/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["idempotency-key"], idempotencyKey);
  assert.equal(calls[0].body.ratio, "16:9");
});

await test("NewAPI can explicitly omit aspect ratio for a model-specific schema", async () => {
  responseFactory = json({ id: "grok-provider-task", status: "queued" }, 200);
  const result = await adapter.submitVideoTask(baseConfig("newapi_video", {
    api_endpoint: "https://relay.example/openclaw/v1",
    model_name: "grok-video-3-pro",
    api_protocol_config: { omit_aspect_ratio: true },
  }), {
    prompt: "fixture",
    duration: 10,
    aspectRatio: "16:9",
    idempotencyKey: "video-newapi-grok-request",
  });
  assert.equal(result.status, "queued");
  assert.equal(result.taskId, "grok-provider-task");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.model, "grok-video-3-pro");
  assert.equal(calls[0].body.duration, 10);
  assert.equal(Object.hasOwn(calls[0].body, "ratio"), false);
  assert.equal(Object.hasOwn(calls[0].body, "aspect_ratio"), false);
});

await test("LConAI Seedance NewAPI uses the documented JSON fields", async () => {
  responseFactory = json({ id: "seedance-provider-task", status: "queued" }, 200);
  const result = await adapter.submitVideoTask(baseConfig("newapi_video", {
    api_endpoint: "https://n.lconai.com",
    model_name: "seedance-2-0-fast-720p-i2v",
    api_protocol_config: {
      request_format: "json",
      duration_field: "duration",
      aspect_ratio_field: "ratio",
      image_field: "images",
      resolution_field: "resolution",
      default_resolution: "720p",
      generate_audio: false,
    },
  }), {
    prompt: "fixture",
    imageUrl: "https://image.example/reference.png",
    duration: 8,
    aspectRatio: "16:9",
    idempotencyKey: "video-lconai-seedance-request",
  });
  assert.equal(result.taskId, "seedance-provider-task");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bodyKind, "json");
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(calls[0].body, {
    model: "seedance-2-0-fast-720p-i2v",
    prompt: "fixture",
    ratio: "16:9",
    duration: 8,
    resolution: "720p",
    images: ["https://image.example/reference.png"],
    generate_audio: false,
  });
});

await test("LConAI Grok NewAPI uses one documented multipart POST", async () => {
  responseFactory = json({ id: "grok-provider-task", status: "queued" }, 200);
  const idempotencyKey = "video-lconai-grok-request";
  const result = await adapter.submitVideoTask(baseConfig("newapi_video", {
    api_endpoint: "https://n.lconai.com",
    model_name: "grok-video-3-pro",
    api_protocol_config: {
      request_format: "multipart",
      duration_field: "seconds",
      size_field: "size",
      size_value_source: "aspect_ratio",
      image_field: "input_reference",
      duration_options: [10],
    },
  }), {
    prompt: "fixture",
    imageUrl: "https://image.example/reference.png",
    duration: 10,
    aspectRatio: "16:9",
    inputOwnerId: "fixture-owner",
    idempotencyKey,
  });
  assert.equal(result.taskId, "grok-provider-task");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bodyKind, "multipart");
  assert.equal(calls[0].headers["idempotency-key"], idempotencyKey);
  assert.equal(Object.hasOwn(calls[0].headers, "content-type"), false);
  assert.equal(calls[0].body.model, "grok-video-3-pro");
  assert.equal(calls[0].body.prompt, "fixture");
  assert.equal(calls[0].body.size, "16:9");
  assert.equal(calls[0].body.seconds, "10");
  assert.deepEqual(calls[0].body.input_reference, { name: "reference.png", size: 13, type: "image/png" });
});

await test("NewAPI polling transport reset remains retryable", async () => {
  responseFactory = async () => { throw new TypeError("fixture connection reset"); };
  const result = await adapter.pollVideoTask(baseConfig("newapi_video"), "newapi-task");
  assert.equal(result.status, "processing");
  assert.match(String(result.error), /重试/u);
  assert.equal(calls.length, 1);
});

await test("NewAPI completed result removes browser-only URL fragments", async () => {
  responseFactory = json({
    id: "newapi-task",
    status: "completed",
    progress: 100,
    video_url: "https://cdn.example.test/results/task.mp4#provider-metadata",
  });
  const result = await adapter.pollVideoTask(baseConfig("newapi_video"), "newapi-task");
  assert.equal(result.status, "success");
  assert.equal(result.videoUrl, "https://cdn.example.test/results/task.mp4");
  assert.equal(calls.length, 1);
});

for (const status of [400, 401, 403]) {
  await test(`NewAPI polling HTTP ${status} is a deterministic failure`, async () => {
    responseFactory = json({ error: { message: `fixture HTTP ${status}` } }, status);
    const result = await adapter.pollVideoTask(baseConfig("newapi_video"), "newapi-task");
    assert.equal(result.status, "failed");
    assert.match(String(result.error), new RegExp(String(status), "u"));
    assert.equal(calls.length, 1);
  });
}

await test("NewAPI polling HTTP 429 remains retryable", async () => {
  responseFactory = json({ error: { message: "rate limited" } }, 429);
  const result = await adapter.pollVideoTask(baseConfig("newapi_video"), "newapi-task");
  assert.equal(result.status, "processing");
  assert.match(String(result.error), /429/u);
  assert.match(String(result.error), /重试/u);
  assert.equal(calls.length, 1);
});

const siliconFlowFixtures = [
  {
    protocolType: "siliconflow_kling",
    endpoint: "https://api.siliconflow.cn/v1/video/kling/v1/standard/generations",
  },
  {
    protocolType: "siliconflow_vidu",
    endpoint: "https://api.siliconflow.cn/v1/video/vidu/v1/generations",
  },
];

for (const fixture of siliconFlowFixtures) {
  const config = baseConfig(fixture.protocolType, { api_endpoint: fixture.endpoint });
  const idempotencyKey = `video-${fixture.protocolType}-original-request`;

  await test(`${fixture.protocolType} accepts a nested requestId acknowledgement with one idempotent POST`, async () => {
    responseFactory = json({ data: { requestId: `${fixture.protocolType}-task`, status: "queued" } });
    const result = await adapter.submitVideoTask(config, { prompt: "fixture", idempotencyKey });
    assert.equal(result.taskId, `${fixture.protocolType}-task`);
    assert.equal(result.status, "queued");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["x-idempotency-key"], idempotencyKey);
  });

  await test(`${fixture.protocolType} lost submit acknowledgement stays unknown and is never replayed`, async () => {
    responseFactory = async () => { throw new TypeError("fixture connection reset after dispatch"); };
    const result = await adapter.submitVideoTask(config, { prompt: "fixture", idempotencyKey });
    assert.equal(result.status, "processing");
    assert.equal(result.submissionOutcome, "unknown");
    assert.match(String(result.error), /不要重复生成/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["x-idempotency-key"], idempotencyKey);
    assert.equal(result.submissionReceipt.endpointHost, "api.siliconflow.cn");
    assert.equal(JSON.stringify(result.submissionReceipt).includes(idempotencyKey), false);
  });

  await test(`${fixture.protocolType} ambiguous HTTP 503 submit stays unknown with one POST`, async () => {
    responseFactory = json({ message: "temporary upstream failure" }, 503);
    const result = await adapter.submitVideoTask(config, { prompt: "fixture", idempotencyKey });
    assert.equal(result.status, "processing");
    assert.equal(result.submissionOutcome, "unknown");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
  });

  await test(`${fixture.protocolType} explicit HTTP 200 rejection fails without replay`, async () => {
    responseFactory = json({ error: { message: "invalid parameter fixture" } });
    const result = await adapter.submitVideoTask(config, { prompt: "fixture", idempotencyKey });
    assert.equal(result.status, "failed");
    assert.match(String(result.error), /invalid parameter/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
  });

  const statusCases = [
    { raw: "queued", expected: "queued" },
    { raw: "running", expected: "processing" },
    { raw: "failed", expected: "failed" },
    { raw: "expired", expected: "failed" },
    { raw: "timeout", expected: "failed" },
    { raw: "rejected", expected: "failed" },
  ];
  for (const statusCase of statusCases) {
    await test(`${fixture.protocolType} maps ${statusCase.raw} to ${statusCase.expected}`, async () => {
      responseFactory = json({ status: statusCase.raw, reason: "fixture terminal" });
      const result = await adapter.pollVideoTask(config, `${fixture.protocolType}-task`);
      assert.equal(result.status, statusCase.expected);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].url, `${fixture.endpoint}/${fixture.protocolType}-task`);
    });
  }

  await test(`${fixture.protocolType} completed without a URL remains processing`, async () => {
    responseFactory = json({ status: "succeeded", progress: 100, results: [] });
    const result = await adapter.pollVideoTask(config, `${fixture.protocolType}-task`);
    assert.equal(result.status, "processing");
    assert.equal(result.videoUrl, undefined);
    assert.match(String(result.error), /等待视频 URL/u);
    assert.equal(calls.length, 1);
  });

  await test(`${fixture.protocolType} completed with a URL succeeds`, async () => {
    const videoUrl = `https://assets.example/${fixture.protocolType}.mp4`;
    responseFactory = json({ status: "Succeed", progress: 100, results: [{ url: videoUrl }] });
    const result = await adapter.pollVideoTask(config, `${fixture.protocolType}-task`);
    assert.equal(result.status, "success");
    assert.equal(result.videoUrl, videoUrl);
    assert.equal(calls.length, 1);
  });

  await test(`${fixture.protocolType} polling transport reset remains retryable`, async () => {
    responseFactory = async () => { throw new TypeError("fixture connection reset"); };
    const result = await adapter.pollVideoTask(config, `${fixture.protocolType}-task`);
    assert.equal(result.status, "processing");
    assert.match(String(result.error), /重试/u);
    assert.equal(calls.length, 1);
  });

  for (const status of [429, 503]) {
    await test(`${fixture.protocolType} polling HTTP ${status} remains retryable`, async () => {
      responseFactory = json({ error: { message: "temporary fixture error" } }, status);
      const result = await adapter.pollVideoTask(config, `${fixture.protocolType}-task`);
      assert.equal(result.status, "processing");
      assert.match(String(result.error), new RegExp(String(status), "u"));
      assert.equal(calls.length, 1);
    });
  }
}

console.log(JSON.stringify({
  passed,
  failed: 0,
  realProviderRequests: 0,
  databaseWrites: 0,
}));
