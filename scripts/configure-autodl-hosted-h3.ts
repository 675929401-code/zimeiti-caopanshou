import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import { AUTODL_COMFYUI_SECRET_REF, resolveProviderSecret } from "../src/lib/provider-secret";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const MODEL_ID = "minimax-h3-autodl-hosted";
const WORKFLOW_ID = "minimax_h3_image_audio_to_video_v2";
const API_BASE = "https://www.autodl.art/api/v1";

const record = {
  id: MODEL_ID,
  name: "MiniMax H3 · AutoDL托管渠道（多图多音频）",
  model_name: WORKFLOW_ID,
  provider: "autodl_comfyui_h3",
  protocol_type: "autodl_comfyui_h3",
  api_endpoint: API_BASE,
  api_key: AUTODL_COMFYUI_SECRET_REF,
  price_per_use: 0.07,
  cost_price: 0.03,
  currency: "CNY",
  duration_seconds: 10,
  max_duration: 10,
  supports_image_input: true,
  requires_image: false,
  is_active: true,
  is_hidden: false,
  sort_order: 1,
  admin_notes: [
    "【内部渠道备注｜仅管理员可见】",
    "供应商：AutoDL.Art 托管 ComfyUI 工作流；工作流 ID：minimax_h3_image_audio_to_video_v2。",
    "计费口径：成本价字段填写默认 768p 的单秒成本 ¥0.03，不是 10 秒总成本；系统按实际提交时长结算。",
    "分档成本：480p ¥0.02/输出秒；768p ¥0.03/输出秒；1080p ¥0.10/输出秒（2026-09-05 官方普通时段）。",
    "默认参数：10 秒、768p；允许 1–10 秒整数；仅 16:9/9:16；最多 9 张参考图 + 3 段参考音频。",
    "10 秒参考总成本：480p ¥0.20；768p ¥0.30；1080p ¥1.00。",
    "并发说明：允许多任务异步提交/排队，但平台未公开真实同时 RUNNING 数与 SLA，实测前不得承诺 2/3 路真并发。",
    "运维说明：上游不支持远程取消；提交后仍可能产生费用；成功结果短链需立即转存。",
    "密钥说明：数据库只保存 secret:// 引用；服务器从 AUTODL_COMFYUI_API_KEY 环境变量读取，本机开发才回退 Windows DPAPI 文件。禁止在备注或数据库中粘贴明文令牌。",
  ].join("\n"),
  api_protocol_config: {
    workflow_id: WORKFLOW_ID,
    supports_duration: true,
    min_duration: 1,
    max_duration: 10,
    min_submit_duration: 1,
    duration_step: 1,
    resolution_options: ["480p", "768p", "1080p"],
    default_resolution: "768p",
    resolution: "768p",
    resolution_cost_prices: { "480p": 0.02, "768p": 0.03, "1080p": 0.10 },
    resolution_prices: { "480p": 0.05, "768p": 0.07, "1080p": 0.11 },
    billing_unit: "output_second",
    aspect_ratios: ["16:9", "9:16"],
    max_reference_images: 9,
    max_reference_audios: 3,
    supports_audio_input: true,
    workspace_surfaces: ["ai-video", "storyboard"],
    persist_result_immediately: true,
    supports_remote_cancel: false,
  },
};

async function assertReadOnlyContract() {
  const token = resolveProviderSecret(AUTODL_COMFYUI_SECRET_REF);
  const [metadataResp, authResp] = await Promise.all([
    fetch(`${API_BASE}/comfyui/workflows/${WORKFLOW_ID}`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${API_BASE}/comfyui/comfyui_workflow/result/codex_readonly_probe`, {
      headers: { Authorization: token, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }),
  ]);
  if (!metadataResp.ok) throw new Error(`AutoDL workflow metadata HTTP ${metadataResp.status}`);
  if (authResp.status === 401 || authResp.status === 403) throw new Error("AutoDL ComfyUI Token 无效或已过期");
  return { metadataStatus: metadataResp.status, authProbeStatus: authResp.status };
}

async function main() {
  const db = getSupabaseAdminClient();
  const { data: existing, error: existingError } = await db
    .from("video_models")
    .select("id,name,model_name,provider,protocol_type,api_endpoint,cost_price,price_per_use,duration_seconds,max_duration,supports_image_input,requires_image,is_active,is_hidden,sort_order,admin_notes,api_protocol_config")
    .eq("id", MODEL_ID)
    .maybeSingle();
  if (existingError) throw existingError;

  const stamp = new Date().toISOString().replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `autodl-hosted-h3-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "existing.sanitized.json"), `${JSON.stringify(existing || null, null, 2)}\n`, "utf8");
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({
    schema: "autodl_hosted_h3_config.v1",
    created_at: new Date().toISOString(),
    target_id: MODEL_ID,
    apply_requested: APPLY,
    provider_key_storage: AUTODL_COMFYUI_SECRET_REF,
    credentials_in_backup: false,
    paid_generation_calls: 0,
  }, null, 2)}\n`, "utf8");

  if (!APPLY) {
    console.log(JSON.stringify({ mode: "dry-run", backupDir, model: { ...record, api_key: AUTODL_COMFYUI_SECRET_REF } }, null, 2));
    return;
  }

  const contract = await assertReadOnlyContract();
  const { error } = await db.from("video_models").upsert(record, { onConflict: "id" });
  if (error) throw error;
  const { data: verified, error: verifyError } = await db
    .from("video_models")
    .select("id,name,model_name,provider,protocol_type,api_endpoint,cost_price,price_per_use,duration_seconds,max_duration,supports_image_input,requires_image,is_active,is_hidden,sort_order,admin_notes,api_protocol_config")
    .eq("id", MODEL_ID)
    .single();
  if (verifyError) throw verifyError;
  console.log(JSON.stringify({ mode: "applied", backupDir, readonlyContract: contract, model: verified, api_key_configured: true }, null, 2));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    paid_generation_calls: 0,
  }));
  process.exitCode = 1;
});
