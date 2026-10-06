import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import dotenv from "dotenv";

import {
  AUTODL_HOSTED_H3_CATALOG_SCHEMA,
  AUTODL_HOSTED_H3_WORKFLOWS,
  autoDLHostedH3BindingSha256,
  buildAutoDLHostedH3CatalogRecords,
} from "../src/lib/autodl-hosted-h3-workflow-catalog";
import { isActivationGatedVideoConfig } from "../src/lib/model-activation-gate";
import { AUTODL_COMFYUI_SECRET_REF } from "../src/lib/provider-secret";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const TARGET_IDS = new Set(AUTODL_HOSTED_H3_WORKFLOWS.map((spec) => spec.modelId));
const SELECT_FIELDS = [
  "id",
  "name",
  "model_name",
  "provider",
  "protocol_type",
  "api_endpoint",
  "price_per_use",
  "cost_price",
  "currency",
  "duration_seconds",
  "max_duration",
  "supports_image_input",
  "requires_image",
  "is_active",
  "is_hidden",
  "sort_order",
  "admin_notes",
  "api_protocol_config",
].join(",");

type Row = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Row)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function stableRows(rows: Row[]): string {
  return JSON.stringify(rows
    .map((row) => canonicalize(row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function sanitizedSummary(rows: ReturnType<typeof buildAutoDLHostedH3CatalogRecords>) {
  return rows.map((record) => ({
    id: record.id,
    workflow_id: record.model_name,
    provider: record.provider,
    protocol_type: record.protocol_type,
    secret_reference: record.api_key,
    is_active: record.is_active,
    is_hidden: record.is_hidden,
    duration: `1-${record.max_duration}s`,
    resolution_prices_cny_per_output_second:
      record.api_protocol_config.resolution_prices,
    adapter_compatibility: record.api_protocol_config.adapter_compatibility,
    official_contract_sha256: record.api_protocol_config.official_contract_sha256,
    binding_sha256: autoDLHostedH3BindingSha256(record),
  }));
}

async function main() {
  const createdAt = new Date().toISOString();
  const dryRunRecords = buildAutoDLHostedH3CatalogRecords({ createdAt });
  if (!APPLY) {
    console.log(JSON.stringify({
      mode: "dry-run",
      schema: AUTODL_HOSTED_H3_CATALOG_SCHEMA,
      paid_generation_calls: 0,
      network_metadata_calls: 0,
      database_writes: 0,
      legacy_models_modified: 0,
      models: sanitizedSummary(dryRunRecords),
    }, null, 2));
    return;
  }

  const db = getSupabaseAdminClient();
  const beforeResult = await db.from("video_models").select(SELECT_FIELDS).order("id");
  if (beforeResult.error) throw beforeResult.error;
  const before = (beforeResult.data || []) as Row[];
  const existingTargets = before.filter((row) => TARGET_IDS.has(String(row.id || "")));
  const unaffectedBefore = before.filter((row) => !TARGET_IDS.has(String(row.id || "")));
  const persistedById = new Map(existingTargets.map((row) => [String(row.id), row]));
  const records = buildAutoDLHostedH3CatalogRecords({ createdAt, persistedById });

  const stamp = createdAt.replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `autodl-hosted-h3-catalog-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(
    path.join(backupDir, "existing-targets.sanitized.json"),
    `${JSON.stringify(existingTargets, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(backupDir, "manifest.json"),
    `${JSON.stringify({
      schema: AUTODL_HOSTED_H3_CATALOG_SCHEMA,
      created_at: createdAt,
      target_ids: [...TARGET_IDS],
      secret_reference: AUTODL_COMFYUI_SECRET_REF,
      credentials_in_backup: false,
      paid_generation_calls: 0,
      state_change: "database_upsert_only",
    }, null, 2)}\n`,
    "utf8",
  );

  const upsertResult = await db.from("video_models").upsert(records, { onConflict: "id" });
  if (upsertResult.error) throw upsertResult.error;

  const afterResult = await db.from("video_models").select(SELECT_FIELDS).order("id");
  if (afterResult.error) throw afterResult.error;
  const after = (afterResult.data || []) as Row[];
  const verifiedTargets = after.filter((row) => TARGET_IDS.has(String(row.id || "")));
  const unaffectedAfter = after.filter((row) => !TARGET_IDS.has(String(row.id || "")));

  assert.equal(verifiedTargets.length, TARGET_IDS.size, "all isolated H3 workflow rows must exist");
  assert.equal(stableRows(unaffectedAfter), stableRows(unaffectedBefore), "non-target video models changed");
  for (const row of verifiedTargets) {
    assert.equal(row.provider, "autodl_comfyui_workflow");
    assert.equal(row.protocol_type, "autodl_comfyui_workflow");
    assert.equal(row.is_active, true);
    assert.equal(row.is_hidden, false);
    assert.equal(isActivationGatedVideoConfig(row.api_protocol_config), true);
  }

  const verifiedById = new Map(verifiedTargets.map((row) => [String(row.id), row]));
  const verifiedRecords = records.map((record) => ({
    ...record,
    ...(verifiedById.get(record.id) || {}),
  }));
  console.log(JSON.stringify({
    mode: "applied",
    schema: AUTODL_HOSTED_H3_CATALOG_SCHEMA,
    backup_dir: backupDir,
    paid_generation_calls: 0,
    network_metadata_calls: 0,
    legacy_models_modified: 0,
    models: sanitizedSummary(verifiedRecords as ReturnType<typeof buildAutoDLHostedH3CatalogRecords>),
  }, null, 2));
}

void main().catch((error) => {
  const candidate = error && typeof error === "object" ? error as Row : {};
  console.error(JSON.stringify({
    name: String(candidate.name || "Error"),
    message: String(candidate.message || error || "AutoDL H3 catalog configuration failed"),
    code: String(candidate.code || ""),
    paid_generation_calls: 0,
  }));
  process.exitCode = 1;
});
