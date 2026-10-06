import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const migrationPath = path.join(process.cwd(), "scripts/migrations/20260821_autodl_h3_model_activation.sql");

async function main() {
  const sql = await readFile(migrationPath, "utf8");
  if (!sql.includes("activate_autodl_h3_selfhost_models_v1")
    || !sql.includes("minimax-h3-turbo-selfhost-pro6000")
    || !sql.includes("qwen-image-2512-hq-selfhost-pro6000")
    || !sql.includes("direct_verified_combinations")) {
    throw new Error("激活迁移文件未通过固定范围检查");
  }
  const sha256 = createHash("sha256").update(sql).digest("hex");
  if (!APPLY) {
    console.log(JSON.stringify({ mode: "dry-run", migration: path.basename(migrationPath), sha256, database_writes: 0 }, null, 2));
    return;
  }
  const db = getSupabaseAdminClient();
  const { error } = await db.rpc("exec_sql", { sql });
  if (error) throw new Error(`激活RPC迁移失败: ${error.message}`);
  console.log(JSON.stringify({
    mode: "migration-applied",
    migration: path.basename(migrationPath),
    sha256,
    target_model_rows_changed: 0,
    credentials_printed: false,
    paid_generation_calls: 0,
  }, null, 2));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 400),
    credentials_printed: false,
    paid_generation_calls: 0,
  }));
  process.exitCode = 1;
});
