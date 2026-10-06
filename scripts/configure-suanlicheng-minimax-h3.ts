import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const API_ENDPOINT = process.env.SUANLICHENG_API_BASE || "https://pro.nat6.net/v1";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

const specs = [
  {
    id: "minimax-h3-768p-lc",
    name: "MiniMax H3 · 768P · 渠道LC",
    model_name: "MiniMax-H3 768P",
    api_key: required("SUANLICHENG_MINIMAX_H3_768P_KEY"),
    cost: 1.2,
    resolution: "768p",
    supportsAudio: true,
    sortOrder: 36,
  },
  {
    id: "minimax-h3-2k-lc",
    name: "MiniMax H3 · 2K · 渠道LC",
    model_name: "MiniMax-H3 2K",
    api_key: required("SUANLICHENG_MINIMAX_H3_2K_KEY"),
    cost: 1.9,
    resolution: "2K",
    supportsAudio: false,
    sortOrder: 37,
  },
] as const;

function recordFor(spec: typeof specs[number]) {
  return {
    id: spec.id,
    name: spec.name,
    model_name: spec.model_name,
    provider: "suanlicheng_video",
    protocol_type: "suanlicheng_video",
    api_endpoint: API_ENDPOINT.replace(/\/+$/u, ""),
    api_key: spec.api_key,
    price_per_use: spec.cost,
    cost_price: spec.cost,
    currency: "CNY",
    duration_seconds: 5,
    max_duration: 15,
    supports_image_input: true,
    requires_image: true,
    is_active: true,
    is_hidden: false,
    sort_order: spec.sortOrder,
    admin_notes: `渠道LC独立协议；成本价¥${spec.cost}/次；固定${spec.resolution}；不做跨模型或跨通道降级。`,
    api_protocol_config: {
      provider_code: "LC",
      material_path: "/v1/h3/materials",
      submit_path: "/v1/h3/videos/generations",
      poll_path: "/v1/h3/videos/generations/{id}",
      content_path: "/v1/h3/videos/generations/{id}/content",
      task: "multi_reference_to_video",
      duration_options: [5, 10, 15],
      min_duration: 5,
      max_duration: 15,
      frames_by_duration: { "5": 124, "10": 243, "15": 362 },
      resolution_options: [spec.resolution],
      default_resolution: spec.resolution,
      resolution: spec.resolution,
      resolution_prices: { [spec.resolution]: spec.cost },
      resolution_cost_prices: { [spec.resolution]: spec.cost },
      aspect_ratios: ["16:9", "9:16", "1:1"],
      supports_audio_reference: spec.supportsAudio,
      reject_degraded_output: true,
      no_fallback: true,
    },
  };
}

async function main() {
  const db = getSupabaseAdminClient();
  const ids = specs.map((spec) => spec.id);
  const { data: existing, error: existingError } = await db
    .from("video_models")
    .select("id,name,model_name,provider,protocol_type,api_endpoint,cost_price,price_per_use,duration_seconds,max_duration,supports_image_input,requires_image,is_active,is_hidden,sort_order,admin_notes,api_protocol_config")
    .in("id", ids);
  if (existingError) throw existingError;

  const stamp = new Date().toISOString().replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `suanlicheng-minimax-h3-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "existing.sanitized.json"), `${JSON.stringify(existing || [], null, 2)}\n`, "utf8");
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({
    schema: "suanlicheng_minimax_h3_config.v1",
    created_at: new Date().toISOString(),
    target_ids: ids,
    apply_requested: APPLY,
    credentials_in_backup: false,
    paid_generation_calls: 0,
  }, null, 2)}\n`, "utf8");

  const preview = specs.map((spec) => ({
    id: spec.id,
    name: spec.name,
    model_name: spec.model_name,
    channel: "LC",
    protocol_type: "suanlicheng_video",
    cost_price: spec.cost,
    price_per_use: spec.cost,
    resolution: spec.resolution,
    api_key_configured: true,
  }));
  if (!APPLY) {
    console.log(JSON.stringify({ mode: "dry-run", backupDir, models: preview }, null, 2));
    return;
  }

  for (const spec of specs) {
    const { error } = await db.from("video_models").upsert(recordFor(spec), { onConflict: "id" });
    if (error) throw error;
  }

  const { data: verified, error: verifyError } = await db
    .from("video_models")
    .select("id,name,model_name,provider,protocol_type,api_endpoint,cost_price,price_per_use,duration_seconds,max_duration,supports_image_input,requires_image,is_active,is_hidden,sort_order,admin_notes,api_protocol_config")
    .in("id", ids)
    .order("sort_order");
  if (verifyError) throw verifyError;
  console.log(JSON.stringify({
    mode: "applied",
    backupDir,
    models: (verified || []).map((model: Record<string, unknown>) => ({ ...model, api_key_configured: true })),
  }, null, 2));
}

void main().catch((error) => {
  const safeError = error && typeof error === "object"
    ? {
        name: String((error as { name?: unknown }).name || "DatabaseError"),
        message: String((error as { message?: unknown }).message || "配置写入失败"),
        code: String((error as { code?: unknown }).code || ""),
        details: String((error as { details?: unknown }).details || ""),
        hint: String((error as { hint?: unknown }).hint || ""),
      }
    : { name: "Error", message: String(error), code: "", details: "", hint: "" };
  console.error(JSON.stringify(safeError));
  process.exitCode = 1;
});
