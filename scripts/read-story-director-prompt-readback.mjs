import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = resolve(projectRoot, "../运行日志/三视觉资产十秒闭环-20261019/benchmark-research-20261020/ab-test-r1");
const ids = ["agent-1786843330392-emdjv2", "agent-1786633444187-594spj"];
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const redact = (value) => String(value || "").replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[REDACTED]");

const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const supabase = new URL(runtime.supabaseUrl);
const query = new URL("/rest/v1/agents", supabase);
query.searchParams.set("select", "id,name,model,model_id,system_prompt,is_active,deleted_at,config_revision,output_style,response_format");
query.searchParams.set("id", `in.(${ids.join(",")})`);
query.searchParams.set("order", "id.asc");
const response = await fetch(query, {
  headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` },
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`agents_read_http_${response.status}`);
const rows = await response.json();
if (!Array.isArray(rows) || rows.length !== 2) throw new Error(`agents_read_count_${Array.isArray(rows) ? rows.length : "invalid"}`);
const agents = rows.map((row) => {
  const prompt = String(row.system_prompt || "");
  return {
    id: String(row.id),
    name: String(row.name || ""),
    model: String(row.model || ""),
    modelId: String(row.model_id || ""),
    active: row.is_active === true,
    deleted: row.deleted_at,
    configRevision: Number(row.config_revision),
    promptSha256: sha256(prompt),
    promptLength: prompt.length,
    promptContainsDirectorMode: /director_mode|directorMode/iu.test(prompt),
    outputStyleSha256: sha256(JSON.stringify(row.output_style ?? null)),
    outputStyleKeys: row.output_style && typeof row.output_style === "object" ? Object.keys(row.output_style).sort() : [],
    directorMode: row.output_style?.director_mode ?? null,
    environmentAnchorPolicy: row.output_style?.environment_anchor_policy ?? null,
    onScreenTextPolicy: row.output_style?.on_screen_text_policy ?? null,
    visualAssetPolicy: row.output_style?.visual_asset_policy ?? null,
    qualityGate: row.output_style?.quality_gate ?? null,
    responseFormat: row.response_format,
  };
});
const modelQuery = new URL("/rest/v1/llm_models", supabase);
modelQuery.searchParams.set("select", "id,model_name,api_endpoint,provider,api_protocol_config,timeout,max_reply_tokens,max_context_tokens,deep_thinking_type,deduct_deep_think,is_active,is_hidden,user_access");
modelQuery.searchParams.set("id", `eq.${agents[0].modelId}`);
modelQuery.searchParams.set("limit", "1");
const modelResponse = await fetch(modelQuery, {
  headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` },
  signal: AbortSignal.timeout(10000),
});
const modelRows = modelResponse.ok ? await modelResponse.json() : [];
const model = Array.isArray(modelRows) && modelRows[0] ? modelRows[0] : null;
const modelReadback = model ? {
  id: String(model.id),
  modelName: String(model.model_name || ""),
  endpointHost: (() => { try { return new URL(String(model.api_endpoint || "")).hostname; } catch { return null; } })(),
  provider: model.provider,
  protocolType: model.api_protocol_config?.protocol || model.api_protocol_config?.type || null,
  protocolConfigKeys: model.api_protocol_config && typeof model.api_protocol_config === "object" ? Object.keys(model.api_protocol_config).sort() : [],
  outputTokenField: model.api_protocol_config?.output_token_field ?? null,
  thinkingStrategy: model.api_protocol_config?.thinking_strategy ?? null,
  endpointPath: model.api_protocol_config?.endpoint_path ?? null,
  timeoutSeconds: Number(model.timeout || 0),
  maxReplyTokens: Number(model.max_reply_tokens || 0),
  maxContextTokens: Number(model.max_context_tokens || 0),
  deepThinkingType: model.deep_thinking_type,
  deductDeepThink: model.deduct_deep_think,
  active: model.is_active === true,
  hidden: model.is_hidden === true,
  userAccess: model.user_access,
} : { readbackHttpStatus: modelResponse.status };
const runtimeVersion = await fetch("http://127.0.0.1:5000/api/version", { signal: AbortSignal.timeout(10000) }).then(async (res) => ({ httpStatus: res.status, body: await res.json().catch(() => null) })).catch((error) => ({ httpStatus: null, error: redact(error?.message || error) }));
const report = {
  schemaVersion: "storyboard_prompt_runtime_readback.v1",
  generatedAt: new Date().toISOString(),
  source: "local_supabase_rest_read_only",
  credentialPrinted: false,
  providerCalls: 0,
  paidGenerationRequests: 0,
  runtimeVersion,
  model: modelReadback,
  agents,
  verdict: {
    twoAgentsPresent: agents.length === 2,
    bothActive: agents.every((agent) => agent.active && !agent.deleted),
    modelBinding: agents.every((agent) => agent.model === "gpt-6.1-sol" && agent.modelId === agents[0].modelId),
    nonEmptyPrompts: agents.every((agent) => agent.promptLength > 0),
    distinctPrompts: new Set(agents.map((agent) => agent.promptSha256)).size === 2,
  },
};
await mkdir(evidenceDir, { recursive: true });
await writeFile(resolve(evidenceDir, "prompt-runtime-readback.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
