import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

// Execute the real adapter with provider I/O replaced by an in-memory fixture.
// A rejected parameter contract must therefore leave `calls` empty.
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
      ].includes(name)) return load(path.join(path.dirname(absolute), `${name}.ts`));
      if (name === "./video-suanlicheng-material") {
        return { readSuanlichengMaterial: async () => ({ buffer: Buffer.from("fixture"), contentType: "image/png" }) };
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
    Buffer,
    setTimeout,
    clearTimeout,
    crypto: nativeRequire("node:crypto").webcrypto,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (input, init = {}) => {
      calls.push({
        url: String(input),
        method: String(init.method || "GET").toUpperCase(),
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      return responseFactory(input, init);
    },
  }, { filename: absolute });
  return loaded.exports;
}

const adapter = load("src/lib/video-adapter.ts");
const baseConfig = (protocolType, extra = {}) => ({
  id: `fixture-${protocolType}`,
  name: "fixture",
  provider: "fixture",
  api_endpoint: `https://provider.example/${protocolType}`,
  api_key: "fixture-only",
  protocol_type: protocolType,
  price_per_use: 1,
  duration_seconds: protocolType === "kling_official" ? 5 : 8,
  supports_image_input: true,
  model_name: "fixture-video-model",
  ...extra,
});

async function rejectsBeforeProvider(config, params, parameter) {
  calls.length = 0;
  await assert.rejects(
    adapter.submitVideoTask(config, { prompt: "fixture", ...params }),
    error => {
      assert.equal(error.name, "VideoParameterContractError");
      assert.equal(error.status, 422);
      assert.equal(error.code, "VIDEO_PARAMETER_UNSUPPORTED_BY_PROTOCOL");
      assert.equal(error.parameter, parameter);
      return true;
    },
  );
  assert.equal(calls.length, 0, "unsupported parameters must not dispatch a provider request");
}

for (const fixture of [
  [baseConfig("siliconflow_kling"), { duration: 8, resolutionTier: "1080p" }, "resolution"],
  [baseConfig("siliconflow_kling"), { duration: 8, generateAudio: false }, "generateAudio"],
  [baseConfig("kling_official"), { duration: 7 }, "duration"],
  [baseConfig("kling_official"), { duration: 5, resolutionTier: "720p" }, "resolution"],
  [baseConfig("kling_official"), { duration: 5, negativePrompt: "avoid text" }, "negativePrompt"],
  [baseConfig("kling_official"), { duration: 5, generateAudio: true }, "generateAudio"],
  [baseConfig("replicate"), { duration: 8, resolutionTier: "1080p" }, "resolution"],
  [baseConfig("replicate"), { duration: 8, negativePrompt: "avoid text" }, "negativePrompt"],
  [baseConfig("replicate"), { duration: 8, generateAudio: false }, "generateAudio"],
  [baseConfig("autodl_comfyui_workflow"), { duration: 8, negativePrompt: "avoid text" }, "negativePrompt"],
  [baseConfig("autodl_comfyui_workflow"), { duration: 8, generateAudio: false }, "generateAudio"],
  [baseConfig("autodl_comfyui_h3"), { duration: 8, negativePrompt: "avoid text" }, "negativePrompt"],
  [baseConfig("autodl_comfyui_h3"), { duration: 8, generateAudio: true }, "generateAudio"],
  [baseConfig("autodl_h3_selfhost"), { duration: 8, negativePrompt: "avoid text" }, "negativePrompt"],
  [baseConfig("autodl_h3_selfhost"), { duration: 8, generateAudio: false }, "generateAudio"],
  [baseConfig("kling_official"), { duration: 5, fps: 30 }, "fps"],
  [baseConfig("autodl_comfyui_h3"), { duration: 8, seed: "42" }, "seed"],
  [baseConfig("openai_compatible"), { fps: "24" }, "fps"],
  [baseConfig("runway"), { seed: 0 }, "seed"],
]) {
  await rejectsBeforeProvider(fixture[0], fixture[1], fixture[2]);
}

calls.length = 0;
responseFactory = async () => Response.json({ data: { requestId: "silicon-task", status: "queued" } });
await adapter.submitVideoTask(baseConfig("siliconflow_kling"), {
  prompt: "fixture",
  duration: 8,
  aspectRatio: "16:9",
  negativePrompt: "avoid text",
});
assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
  prompt: "fixture",
  duration: 8,
  aspect_ratio: "16:9",
  negative_prompt: "avoid text",
});

calls.length = 0;
responseFactory = async () => Response.json({ data: { task_id: "kling-task", task_status: "submitted" } });
await adapter.submitVideoTask(baseConfig("kling_official", {
  model_name: "kling-video-pro",
}), {
  prompt: "fixture",
  duration: 10,
  aspectRatio: "9:16",
});
assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
  prompt: "fixture",
  cfg_scale: 0.5,
  mode: "pro",
  duration: "10",
  aspect_ratio: "9:16",
});

calls.length = 0;
responseFactory = async () => Response.json({ id: "replicate-task", status: "starting" });
await adapter.submitVideoTask(baseConfig("replicate", {
  model_name: "owner/video-model:version",
  api_protocol_config: {
    duration_options: [6],
    resolution_field: "resolution",
    negative_prompt_field: "negative_prompt",
    supports_generate_audio_toggle: true,
    generate_audio_field: "generate_audio",
  },
}), {
  prompt: "fixture",
  duration: 6,
  aspectRatio: "1:1",
  resolutionTier: "1080p",
  negativePrompt: "avoid text",
  generateAudio: false,
});
assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
  version: "owner/video-model:version",
  input: {
    prompt: "fixture",
    aspect_ratio: "1:1",
    duration: 6,
    resolution: "1080p",
    negative_prompt: "avoid text",
    generate_audio: false,
  },
});

const routeSource = fs.readFileSync("src/app/api/video/generate/route.ts", "utf8");
assert.match(
  routeSource,
  /validateVideoParameterContract\([\s\S]*generateAudio,[\s\S]*fps: body\.fps,[\s\S]*seed: body\.seed,[\s\S]*userProvidedOptions/u,
  "route must validate every accepted option before billing",
);
assert.match(
  routeSource,
  /protocolParameterIssue\.acceptedValues[\s\S]*protocolParameterIssue\.status/u,
  "route must preserve the parameter contract's 422 response",
);

console.log(JSON.stringify({
  passed: 22,
  failed: 0,
  providerCallsForRejectedParameters: 0,
  realProviderRequests: 0,
  databaseWrites: 0,
}));
