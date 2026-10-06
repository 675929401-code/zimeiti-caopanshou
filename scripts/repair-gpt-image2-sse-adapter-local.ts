import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

type JsonRecord = Record<string, unknown>;

const APPLY = process.argv.includes("--apply");
const MODEL_ID = "pending-cover-model-gpt-image-2-image-2-1k";
const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const OUTPUT_FILE = path.resolve(".codex-evidence/gpt-image2-three-groups-live/sse-adapter-repair.json");

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

async function main() {
  const runtime = JSON.parse((await readFile(RUNTIME_CONFIG, "utf8")).replace(/^\uFEFF/u, "")) as JsonRecord;
  const ownerConnection = runtime.ownerConnection as pg.ClientConfig | undefined;
  assert.ok(ownerConnection, "Local owner connection is unavailable");
  assert.equal(ownerConnection.host, "127.0.0.1", "Local database host required");
  assert.equal(ownerConnection.database, "zimeiti_local", "Local database required");

  const db = new pg.Client(ownerConnection);
  await db.connect();
  try {
    const result = await db.query<JsonRecord>(`
      select id,model_name,provider,api_endpoint,api_key,is_active,is_hidden,api_protocol_config
        from public.cover_models
       where id=$1
    `, [MODEL_ID]);
    assert.equal(result.rows.length, 1, "GPT Image 2 image-2-1k group is missing");
    const row = result.rows[0];
    const protocol = objectValue(row.api_protocol_config);
    assert.equal(row.model_name, "gpt-image-2", "Unexpected model family");
    assert.equal(new URL(String(row.api_endpoint || "")).hostname, "token.secure-skill.com", "Unexpected provider endpoint");
    assert.ok(String(row.api_key || "").trim(), "Stored group credential is missing");
    assert.equal(protocol.provider_group_name, "image-2-1k", "Unexpected provider group");
    assert.equal(protocol.protocol, "secure_skill_images", "Unexpected image protocol");

    const nextProtocol: JsonRecord = {
      ...protocol,
      adapter_contract: "secure_skill_images_v2_sse",
      response_transport: "json_or_sse",
      activation_state: "pending_repair_canary",
      catalog_visibility: "visible_pending",
    };
    delete nextProtocol.activation_failure_code;
    delete nextProtocol.public_unavailable_reason;

    if (APPLY) {
      await db.query("begin");
      try {
        await db.query(`
          update public.cover_models
             set is_active=false,
                 is_hidden=false,
                 api_protocol_config=$2::jsonb,
                 updated_at=now()
           where id=$1
        `, [MODEL_ID, JSON.stringify(nextProtocol)]);
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
    }

    const evidence = {
      checkedAt: new Date().toISOString(),
      localOnly: true,
      applied: APPLY,
      modelId: MODEL_ID,
      credentialConfigured: true,
      endpointHost: "token.secure-skill.com",
      providerGroup: "image-2-1k",
      previousAdapterContract: String(protocol.adapter_contract || ""),
      nextAdapterContract: "secure_skill_images_v2_sse",
      responseTransport: "json_or_sse",
      activeAfterWrite: false,
      hiddenAfterWrite: false,
      publicationState: "pending_repair_canary",
      providerRequests: 0,
      paidGenerationRequests: 0,
      databaseWrites: APPLY ? 1 : 0,
    };
    await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await writeFile(OUTPUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "GPT_IMAGE2_SSE_ADAPTER_REPAIR_FAILED");
  process.exitCode = 1;
});
