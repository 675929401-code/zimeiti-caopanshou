import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const TARGET_IDS = ["minimax-h3-chA", "omni-flash-10s-720p-ch3", "omni-flash-10s-1080p-ch3"] as const;

type VideoModelRow = {
  id: string;
  name: string;
  duration_seconds: number;
  max_duration: number;
  cost_price: number;
  price_per_use: number;
  is_active: boolean;
  is_hidden: boolean;
  api_protocol_config: Record<string, unknown> | null;
};

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function sqlLiteral(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rollbackSql(rows: VideoModelRow[]) {
  return [
    "BEGIN;",
    ...rows.map(row => `UPDATE public.video_models SET\n  name = ${sqlLiteral(row.name)},\n  duration_seconds = ${sqlLiteral(row.duration_seconds)},\n  max_duration = ${sqlLiteral(row.max_duration)},\n  cost_price = ${sqlLiteral(row.cost_price)},\n  price_per_use = ${sqlLiteral(row.price_per_use)},\n  is_active = ${sqlLiteral(row.is_active)},\n  is_hidden = ${sqlLiteral(row.is_hidden)},\n  api_protocol_config = ${sqlLiteral(JSON.stringify(row.api_protocol_config || {}))}::jsonb\nWHERE id = ${sqlLiteral(row.id)};`),
    "COMMIT;",
    "",
  ].join("\n");
}

function mergeConfig(current: Record<string, unknown> | null, next: Record<string, unknown>) {
  return { ...(current || {}), ...next };
}

async function main() {
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
  if (!key) throw new Error("缺少 Supabase 访问密钥");
  const client = createClient(required("COZE_SUPABASE_URL"), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client
    .from("video_models")
    .select("id,name,duration_seconds,max_duration,cost_price,price_per_use,is_active,is_hidden,api_protocol_config")
    .in("id", [...TARGET_IDS]);
  if (error) throw error;
  const rows = (data || []) as VideoModelRow[];
  const missing = TARGET_IDS.filter(id => !rows.some(row => row.id === id));
  if (missing.length > 0) throw new Error(`缺少目标模型：${missing.join(", ")}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  const backupDir = path.join("backups", `video-resolution-pricing-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  const backupJson = JSON.stringify(rows.sort((a, b) => a.id.localeCompare(b.id)), null, 2) + "\n";
  const digest = createHash("sha256").update(backupJson).digest("hex");
  await writeFile(path.join(backupDir, "video-models.before.json"), backupJson, "utf8");
  await writeFile(path.join(backupDir, "rollback.sql"), rollbackSql(rows), "utf8");
  await writeFile(path.join(backupDir, "manifest.json"), JSON.stringify({
    schema: "video_resolution_pricing_backup.v1",
    created_at: new Date().toISOString(),
    target_ids: TARGET_IDS,
    sha256: digest,
    apply_requested: APPLY,
    paid_generation_calls: 0,
  }, null, 2) + "\n", "utf8");

  const miniMax = rows.find(row => row.id === "minimax-h3-chA")!;
  const omni = rows.find(row => row.id === "omni-flash-10s-720p-ch3")!;
  const updates: Record<string, Partial<VideoModelRow>> = {
    "minimax-h3-chA": {
      name: "MiniMax H3 · 15秒 · 最高4K · 渠道A",
      duration_seconds: 15,
      max_duration: 15,
      cost_price: 1.5,
      price_per_use: 1.5,
      api_protocol_config: mergeConfig(miniMax.api_protocol_config, {
        supports_duration: false,
        duration_options: [15],
        min_duration: 15,
        max_duration: 15,
        min_submit_duration: 15,
        resolution_options: ["720p", "1080p", "4K"],
        default_resolution: "1080p",
        resolution: "1080p",
        resolution_cost_prices: { "720p": 1.2, "1080p": 1.5, "4K": 3 },
        resolution_prices: { "720p": 1.2, "1080p": 1.5, "4K": 3 },
      }),
    },
    "omni-flash-10s-720p-ch3": {
      name: "Omni Flash · 10秒 · 最高1080P · 渠道C",
      duration_seconds: 10,
      max_duration: 10,
      cost_price: 0.55,
      price_per_use: 0.55,
      is_active: true,
      is_hidden: false,
      api_protocol_config: mergeConfig(omni.api_protocol_config, {
        supports_duration: false,
        duration_options: [10],
        min_duration: 10,
        max_duration: 10,
        min_submit_duration: 10,
        resolution_options: ["720p", "1080p"],
        default_resolution: "1080p",
        resolution: "1080p",
        resolution_cost_prices: { "720p": 0.5, "1080p": 0.55 },
        resolution_prices: { "720p": 0.5, "1080p": 0.55 },
      }),
    },
  };

  if (!APPLY) {
    console.log(JSON.stringify({ mode: "dry-run", backupDir, updates }, null, 2));
    return;
  }

  const changed: string[] = [];
  try {
    for (const [id, update] of Object.entries(updates)) {
      const { error: updateError } = await client.from("video_models").update(update).eq("id", id);
      if (updateError) throw updateError;
      changed.push(id);
    }
  } catch (updateError) {
    for (const id of changed.reverse()) {
      const before = rows.find(row => row.id === id)!;
      const { id: _id, ...restore } = before;
      await client.from("video_models").update(restore).eq("id", id);
    }
    throw updateError;
  }

  const { data: verified, error: verifyError } = await client
    .from("video_models")
    .select("id,name,duration_seconds,max_duration,cost_price,price_per_use,is_active,is_hidden,api_protocol_config")
    .in("id", [...TARGET_IDS])
    .order("id");
  if (verifyError) throw verifyError;
  console.log(JSON.stringify({ mode: "applied", backupDir, verified }, null, 2));
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
