import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const SNAPSHOT_PATH = path.join("runtime-tools", "model-audit-20260919", "video_models.json");
const EVIDENCE_DIR = path.join(".codex-evidence", "model-resource-pool-audit-20260923");
const RETIRED_PROVIDER = "retired_configuration";
const AUTODL_KEEP_IDS = new Set([
  "minimax-h3-autodl-hosted-lightx2v-v5",
  "minimax-h3-autodl-hosted-image-audio-v2",
  "minimax-h3-autodl-hosted-text",
]);
const VIDEO_RETIRE_IDS = new Set([
  "minimax-h3-autodl-hosted",
  "minimax-h3-autodl-hosted-first-last",
  "minimax-h3-autodl-hosted-image-audio",
  "minimax-h3-autodl-hosted-image-audio-v2-15s",
  "minimax-h3-autodl-hosted-lightx2v-v5-15s",
  "minimax-h3-turbo-selfhost-pro6000",
  "grok-video-3-10s-ch1",
  "grok-video-3-10s-ch1-stable",
  "grok-video-3-15s-ch1b",
  "veo-3-1-fast-ch1",
]);
const COVER_RETIRE_IDS = new Set(["qwen-image-2512-hq-selfhost-pro6000"]);
const LANMAO_RESTORE_ID = "grok-imagine-1.0-super-720p-10s-ch4";
const LANMAO_TEMPLATE_ID = "grok-imagine-1.0-super-10s-ch4";
const TABLES = ["cover_models", "llm_models", "video_models"];

const db = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function stripObsoleteNotes(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .filter((line) => !line.includes("安全状态：新记录固定"))
    .join("\n")
    .trim();
}

function summary(table, rows) {
  const current = rows.filter((row) => String(row.provider || "") !== RETIRED_PROVIDER);
  return {
    table,
    physical_count: rows.length,
    resource_count: current.length,
    active_count: current.filter((row) => row.is_active === true).length,
    hidden_count: current.filter((row) => row.is_hidden === true).length,
    missing_key_count: current.filter((row) => !String(row.api_key || "").trim()).length,
  };
}

async function readTables() {
  const result = {};
  for (const table of TABLES) {
    const read = await db.from(table).select("*").order("id");
    if (read.error) throw read.error;
    result[table] = read.data || [];
  }
  return result;
}

async function retireOrDelete(table, id) {
  const existing = await db.from(table).select("id,provider").eq("id", id).maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) return { table, id, status: "already_absent" };
  if (existing.data.provider === RETIRED_PROVIDER) return { table, id, status: "already_tombstoned" };

  const deleted = await db.from(table).delete().eq("id", id);
  if (!deleted.error) return { table, id, status: "deleted" };
  if (deleted.error.code !== "23503") throw deleted.error;

  const common = { is_active: false, is_hidden: true, provider: RETIRED_PROVIDER, api_key: "", api_endpoint: "" };
  const patch = table === "video_models"
    ? { ...common, admin_notes: "模型接入配置已删除；此占位仅保留历史任务和账单关联。", api_protocol_config: {}, request_template: null, response_mapping: null }
    : common;
  const tombstone = await db.from(table).update(patch).eq("id", id);
  if (tombstone.error) throw tombstone.error;
  return { table, id, status: "tombstoned_for_history" };
}

async function activateAllCurrent(table, rows) {
  const ids = rows
    .filter((row) => String(row.provider || "") !== RETIRED_PROVIDER)
    .map((row) => String(row.id));
  for (let index = 0; index < ids.length; index += 100) {
    const updated = await db.from(table).update({ is_active: true, is_hidden: false }).in("id", ids.slice(index, index + 100));
    if (updated.error) throw updated.error;
  }
  return ids.length;
}

async function main() {
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  const snapshotById = new Map(snapshot.map((row) => [String(row.id), row]));
  const restoreIds = [...AUTODL_KEEP_IDS, LANMAO_RESTORE_ID];
  for (const id of restoreIds) {
    if (!snapshotById.has(id)) throw new Error(`RESTORE_SOURCE_MISSING:${id}`);
  }

  const before = await readTables();
  const plan = {
    mode: APPLY ? "apply" : "dry-run",
    restore_ids: restoreIds,
    retire_video_ids: [...VIDEO_RETIRE_IDS],
    retire_cover_ids: [...COVER_RETIRE_IDS],
    before: TABLES.map((table) => summary(table, before[table])),
    paid_generation_calls: 0,
    external_probe_calls: 0,
  };
  if (!APPLY) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const restoreRows = restoreIds.map((id) => {
    const row = structuredClone(snapshotById.get(id));
    row.is_active = true;
    row.is_hidden = false;
    row.admin_notes = stripObsoleteNotes(row.admin_notes);
    if (id === LANMAO_RESTORE_ID) {
      const liveTemplate = before.video_models.find((candidate) => candidate.id === LANMAO_TEMPLATE_ID);
      if (!liveTemplate || !String(liveTemplate.api_endpoint || "").trim() || !String(liveTemplate.api_key || "").trim()) {
        throw new Error(`LANMAO_TEMPLATE_UNAVAILABLE:${LANMAO_TEMPLATE_ID}`);
      }
      row.provider = "lanmao";
      row.protocol_type = "lanmao_video";
      row.api_endpoint = liveTemplate.api_endpoint;
      row.api_key = liveTemplate.api_key;
      row.api_protocol_config = liveTemplate.api_protocol_config || {};
      row.request_template = liveTemplate.request_template;
      row.response_mapping = liveTemplate.response_mapping;
      row.admin_notes = "蓝猫现有渠道配置；从同端点同协议的10秒模型恢复凭据与路由。";
    }
    return row;
  });
  const restored = await db.from("video_models").upsert(restoreRows, { onConflict: "id" });
  if (restored.error) throw restored.error;

  const retirementResults = [];
  for (const id of VIDEO_RETIRE_IDS) retirementResults.push(await retireOrDelete("video_models", id));
  for (const id of COVER_RETIRE_IDS) retirementResults.push(await retireOrDelete("cover_models", id));

  const afterRetirement = await readTables();
  const activated = {};
  for (const table of TABLES) activated[table] = await activateAllCurrent(table, afterRetirement[table]);
  const after = await readTables();

  const exactAutoDL = after.video_models
    .filter((row) => /autodl/iu.test(`${row.id} ${row.provider} ${row.api_endpoint}`) && String(row.provider || "") !== RETIRED_PROVIDER)
    .map((row) => ({ id: row.id, active: row.is_active, hidden: row.is_hidden, key_configured: Boolean(String(row.api_key || "").trim()) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const yunwuEndpointRows = after.video_models.filter((row) => {
    try { return new URL(String(row.api_endpoint || "")).hostname.toLowerCase() === "yunwu.ai"; } catch { return false; }
  });
  const lanmao = after.video_models.find((row) => row.id === LANMAO_RESTORE_ID);
  const evidence = {
    ...plan,
    completed_at: new Date().toISOString(),
    retirement_results: retirementResults,
    activated,
    after: TABLES.map((table) => summary(table, after[table])),
    exact_autodl_current: exactAutoDL,
    exact_autodl_matches_keep_list: exactAutoDL.length === AUTODL_KEEP_IDS.size && exactAutoDL.every((row) => AUTODL_KEEP_IDS.has(row.id)),
    actual_yunwu_endpoint_count: yunwuEndpointRows.length,
    lanmao_restored: lanmao ? {
      id: lanmao.id,
      provider: lanmao.provider,
      protocol_type: lanmao.protocol_type,
      endpoint_origin: new URL(lanmao.api_endpoint).origin,
      key_configured: Boolean(String(lanmao.api_key || "").trim()),
      active: lanmao.is_active,
      hidden: lanmao.is_hidden,
    } : null,
    secrets_in_evidence: false,
    paid_generation_calls: 0,
    external_probe_calls: 0,
  };
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(path.join(EVIDENCE_DIR, "retirement-correction-result.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
