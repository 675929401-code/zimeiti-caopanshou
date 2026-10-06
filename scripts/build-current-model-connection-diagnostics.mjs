import fs from "node:fs";
import path from "node:path";

const evidenceDir = path.join(process.cwd(), ".codex-evidence", "model-resource-pool-audit-20260923");
const audit = JSON.parse(fs.readFileSync(path.join(evidenceDir, "report.json"), "utf8"));
const correction = JSON.parse(fs.readFileSync(path.join(evidenceDir, "retirement-correction-result.json"), "utf8"));
const retired = new Set(correction.retire_video_ids || []);
const dedicatedProtocols = new Set([
  "volcengine_digital_human",
  "dashscope_video_retalk",
  "dashscope_wan_s2v",
]);

function classify(model) {
  if (model.probe?.exactIdentity === true) return "directory_exact_listed";
  if (dedicatedProtocols.has(String(model.protocol || ""))) {
    return "dedicated_api_generic_directory_not_applicable";
  }
  if (model.probe?.connectionOk === true) return "directory_reachable_model_not_listed";
  if ([401, 403].includes(Number(model.probe?.status))) return "auth_or_channel_failure";
  return "connection_unconfirmed";
}

const models = audit.models
  .filter((model) => model.kind === "video" && !retired.has(model.id))
  .map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    protocol: model.protocol,
    endpoint_origin: model.endpoint?.origin || "",
    active: true,
    hidden: false,
    credential_reference_configured: model.credentialReferenceConfigured === true,
    classification: classify(model),
    probe_status: Number(model.probe?.status) || 0,
    connection_ok: model.probe?.connectionOk === true,
    exact_identity: model.probe?.exactIdentity === true,
    generation_verified: false,
    historical_succeeded_at: model.historicalSucceededAt || null,
  }))
  .sort((left, right) => left.classification.localeCompare(right.classification) || left.id.localeCompare(right.id));

const counts = Object.fromEntries(
  [...new Set(models.map((model) => model.classification))]
    .map((classification) => [classification, models.filter((model) => model.classification === classification).length]),
);
const output = {
  generated_at: new Date().toISOString(),
  source_audit_generated_at: audit.generatedAt,
  current_video_resource_count: models.length,
  counts,
  interpretation: {
    directory_exact_listed: "免费目录通信通过且精确列出型号。",
    directory_reachable_model_not_listed: "目录可达但未列出型号；不能据此认定专用生成接口故障。",
    dedicated_api_generic_directory_not_applicable: "专用动作接口不提供通用 /models 目录；GET/目录探测不能作为故障证据。",
    auth_or_channel_failure: "免费目录探测返回 401/403；需内部复核凭据或渠道权限，但不会自动隐藏或停用模型。",
    connection_unconfirmed: "现有免费探测不足以确认通信；不会自动隐藏或停用模型。",
  },
  paid_generation_calls: 0,
  database_writes: 0,
  secrets_in_output: false,
  models,
};

const outputPath = path.join(evidenceDir, "current-video-connection-diagnostics.json");
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ outputPath, currentVideoModels: models.length, counts }, null, 2));
