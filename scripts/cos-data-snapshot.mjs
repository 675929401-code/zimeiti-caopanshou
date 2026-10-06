#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { createClient } from "@supabase/supabase-js";

function loadEnv(file) {
  if (!file || !fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(process.env.ENV_FILE || path.resolve(process.cwd(), ".env.local"));

const required = [
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
  "COS_BUCKET",
  "COS_REGION",
  "COZE_SUPABASE_URL",
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  process.exit(1);
}

const defaultTables = [
  "users",
  "agents",
  "categories",
  "llm_models",
  "conversations",
  "conversation_messages",
  "payment_orders",
  "payment_methods",
  "credit_transactions",
  "cash_transactions",
  "cash_debt_records",
  "balance_audit_log",
  "dead_letter_billing",
  "revenue_records",
  "platform_settings",
  "plugins",
  "skills",
  "user_files",
  "video_tasks",
  "video_models",
  "trial_plans",
  "trial_plan_agents",
  "user_trial_activations",
  "voice_models",
  "user_voices",
  "voice_billing_records",
  "voice_clone_licenses",
  "voice_favorites",
  "agent_favorites",
  "login_logs",
  "password_audit_log",
  "system_logs",
  "health_checks",
  "auto_fixes",
];

const tables = (process.env.SUPABASE_EXPORT_TABLES || defaultTables.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const dryRun = process.argv.includes("--dry-run");
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const prefix = process.env.COS_SNAPSHOT_PREFIX || `business-data/snapshots/${stamp}`;

const supabase = createClient(
  process.env.COZE_SUPABASE_URL,
  process.env.COZE_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

async function uploadJson(key, value) {
  const body = JSON.stringify(value, null, 2);
  if (dryRun) {
    console.log(`[dry-run] upload cos://${process.env.COS_BUCKET}/${key} (${Buffer.byteLength(body)} bytes)`);
    return;
  }
  await cos.putObject({
    Bucket: process.env.COS_BUCKET,
    Region: process.env.COS_REGION,
    Key: key,
    Body: body,
    ContentType: "application/json; charset=utf-8",
  });
  console.log(`uploaded cos://${process.env.COS_BUCKET}/${key}`);
}

async function exportTable(table) {
  const pageSize = Number(process.env.SUPABASE_EXPORT_PAGE_SIZE || 1000);
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase.from(table).select("*").range(from, to);
    if (error) {
      console.warn(`skip ${table}: ${error.message}`);
      return { table, ok: false, error: error.message, count: rows.length };
    }
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  await uploadJson(`${prefix}/tables/${table}.json`, rows);
  return { table, ok: true, count: rows.length };
}

const manifest = {
  created_at: now.toISOString(),
  bucket: process.env.COS_BUCKET,
  region: process.env.COS_REGION,
  prefix,
  source: "supabase",
  tables: [],
};

for (const table of tables) {
  manifest.tables.push(await exportTable(table));
}

await uploadJson(`${prefix}/manifest.json`, manifest);
console.log(JSON.stringify(manifest, null, 2));
