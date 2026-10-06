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

function required(name) {
  if (!process.env[name]) throw new Error(`Missing env: ${name}`);
  return process.env[name];
}

loadEnv(process.env.ENV_FILE || path.resolve(process.cwd(), ".env.local"));

if (process.env.CONFIRM_RESTORE !== "YES") {
  console.error("Restore is blocked. Set CONFIRM_RESTORE=YES only after a current database snapshot has been taken.");
  process.exit(1);
}

const prefix = process.env.COS_RESTORE_PREFIX;
if (!prefix) {
  console.error("Missing COS_RESTORE_PREFIX, for example business-data/snapshots/2026-08-03T13-00-00-000Z");
  process.exit(1);
}

const bucket = required("COS_BUCKET");
const region = required("COS_REGION");
const cos = new COS({ SecretId: required("COS_SECRET_ID"), SecretKey: required("COS_SECRET_KEY") });
const supabase = createClient(required("COZE_SUPABASE_URL"), required("COZE_SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getJson(key) {
  const result = await cos.getObject({ Bucket: bucket, Region: region, Key: key });
  return JSON.parse(result.Body.toString("utf8"));
}

const manifest = await getJson(`${prefix}/manifest.json`);
const restoreTables = (process.env.SUPABASE_RESTORE_TABLES || manifest.tables.map((item) => item.table).join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

for (const table of restoreTables) {
  const rows = await getJson(`${prefix}/tables/${table}.json`);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(`skip ${table}: empty`);
    continue;
  }
  const { error } = await supabase.from(table).upsert(rows);
  if (error) throw new Error(`restore ${table} failed: ${error.message}`);
  console.log(`restored ${table}: ${rows.length}`);
}
