import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

type JsonRecord = Record<string, unknown>;

const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const TARGET_PROTOCOLS = ["dashscope_video_retalk", "dashscope_wan_s2v"] as const;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sanitize(row: JsonRecord) {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    protocolType: String(row.protocol_type || ""),
    active: row.is_active === true,
    hidden: row.is_hidden === true,
    endpointHost: new URL(String(row.api_endpoint || "https://invalid.local")).host,
    supportsRemoteCancel: objectValue(row.api_protocol_config).supports_remote_cancel === true,
    credentialFingerprint: createHash("sha256").update(String(row.api_key || "")).digest("hex"),
  };
}

function comparable(row: JsonRecord) {
  const rest = { ...row };
  const rawConfig = rest.api_protocol_config;
  delete rest.updated_at;
  delete rest.api_protocol_config;
  return {
    ...rest,
    api_protocol_config: { ...objectValue(rawConfig), supports_remote_cancel: false },
  };
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--apply");
  assert.deepEqual(unknown, [], `Unknown arguments: ${unknown.join(", ")}`);

  const runtime = JSON.parse((await readFile(RUNTIME_CONFIG, "utf8")).replace(/^\uFEFF/u, "")) as JsonRecord;
  const supabaseUrl = String(runtime.supabaseUrl || "");
  const serviceRoleKey = String(runtime.serviceRoleKey || "");
  assert.equal(new URL(supabaseUrl).origin, "http://127.0.0.1:54321", "Only the isolated local database is permitted");
  assert.ok(serviceRoleKey.length >= 16, "Local service role key is unavailable");

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const beforeResult = await db.from("video_models").select("*").in("protocol_type", [...TARGET_PROTOCOLS]).order("id");
  if (beforeResult.error) throw beforeResult.error;
  const before = (beforeResult.data || []) as JsonRecord[];
  assert.ok(before.length >= TARGET_PROTOCOLS.length, "DashScope video models are missing");
  for (const protocol of TARGET_PROTOCOLS) {
    assert.ok(before.some((row) => row.protocol_type === protocol), `Missing protocol: ${protocol}`);
  }

  const changed: JsonRecord[] = before
    .filter((row) => objectValue(row.api_protocol_config).supports_remote_cancel !== true)
    .map((row): JsonRecord => ({
      ...row,
      api_protocol_config: { ...objectValue(row.api_protocol_config), supports_remote_cancel: true },
    }));

  const evidenceDir = path.join(".codex-evidence", "dashscope-video-cancellation-capability-20261004");
  await mkdir(evidenceDir, { recursive: true });
  const report: JsonRecord = {
    mode: apply ? "applied" : "plan",
    database: "local-only",
    targetProtocols: TARGET_PROTOCOLS,
    changedIds: changed.map((row) => row.id),
    before: before.map(sanitize),
    providerRequests: 0,
    paidGenerationCalls: 0,
    secretValuesPrinted: false,
  };

  if (apply && changed.length > 0) {
    for (const row of changed) {
      const write = await db.from("video_models")
        .update({ api_protocol_config: row.api_protocol_config })
        .eq("id", row.id);
      if (write.error) throw write.error;
    }
  }

  const afterResult = await db.from("video_models").select("*").in("protocol_type", [...TARGET_PROTOCOLS]).order("id");
  if (afterResult.error) throw afterResult.error;
  const after = (afterResult.data || []) as JsonRecord[];
  if (apply) {
    assert.equal(after.length, before.length, "DashScope model count changed unexpectedly");
    for (const row of after) {
      assert.equal(objectValue(row.api_protocol_config).supports_remote_cancel, true, `${row.id} was not updated`);
      const previous = before.find((candidate) => candidate.id === row.id);
      assert.ok(previous, `${row.id} did not exist before update`);
      assert.equal(stable(comparable(row)), stable(comparable(previous)),
        `${row.id} changed outside the cancellation capability flag`);
    }
  }

  report.after = after.map(sanitize);
  report.nonTargetFieldsUnchanged = apply;
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    failed: true,
    message: error instanceof Error ? error.message : String(error),
    providerRequests: 0,
    paidGenerationCalls: 0,
    secretValuesPrinted: false,
  }));
  process.exitCode = 1;
});
