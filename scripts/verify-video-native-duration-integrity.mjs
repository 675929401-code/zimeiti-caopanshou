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


let passed=0;
for(const protocol of ['secure_skill_grok_video','secure_skill_video','secure_skill_enterprise_video','secure_skill_wan3_video','autodl_comfyui_h3']){
 const config=baseConfig(protocol,{api_protocol_config:{min_duration:5,min_submit_duration:5,max_duration:10,duration_options:[5,8,10],workflow_id:'fixture'}});
 for(const duration of [4,6,8.5,11,0,-1,Number.NaN]){const issue=adapter.validateVideoParameterContract(config,{prompt:'fixture',duration});assert.equal(issue?.parameter,'duration');await rejectsBeforeProvider(config,{duration},'duration');passed++;}
 calls.length=0;responseFactory=async()=>Response.json({id:'fixture-task',task_id:'fixture-task',status:'queued',data:{task_id:'fixture-task'}});await adapter.submitVideoTask(config,{prompt:'fixture',duration:8,aspectRatio:'16:9'});assert.equal(calls.length,1);assert.equal(calls[0].body.duration??calls[0].body.seconds,8);passed++;
}
const twenty=baseConfig('secure_skill_grok_video',{api_protocol_config:{min_duration:5,max_duration:20,duration_options:[5,10,15,20]}});calls.length=0;await adapter.submitVideoTask(twenty,{prompt:'fixture',duration:20});assert.equal(calls[0].body.seconds,20);passed++;
for(const [protocol,duration] of [['secure_skill_wan3_video',31],['autodl_comfyui_h3',11]]){const config=baseConfig(protocol,{api_protocol_config:{max_duration:40}});await rejectsBeforeProvider(config,{duration},'duration');passed++;}
for(const protocol of ['dashscope_video_retalk','dashscope_wan_s2v','volcengine_digital_human']){assert.equal(adapter.validateVideoParameterContract(baseConfig(protocol),{prompt:'fixture',duration:3.5,sourceVideoUrl:'https://fixture.invalid/source.mp4'}),null);passed++;}
console.log(JSON.stringify({passed,failed:0,scope:'Actual adapter shared prebilling contract and submitters with stubbed provider I/O; no real provider/DB',realProviderRequests:0,databaseWrites:0}));
