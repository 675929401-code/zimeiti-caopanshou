import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

type JsonRecord = Record<string, unknown>;

const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const EVIDENCE_FILE = path.resolve(".codex-evidence/gpt-image2-three-groups-live/visible-disabled-groups.json");
const GROUPS = [
  {
    id: "pending-cover-model-gpt-image-2-image-2-1k",
    code: "UPSTREAM_RESPONSE_EVENT_ERROR",
    reason: "上游返回异常任务事件，当前分组已保留展示但暂停提交",
  },
  {
    id: "pending-cover-model-gpt-image-2-official",
    code: "UPSTREAM_NO_COMPATIBLE_ACCOUNT",
    reason: "上游暂无可用兼容账户，当前分组已保留展示但暂停提交",
  },
] as const;

function configOf(value: unknown): JsonRecord {
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
    await db.query("begin");
    const results: JsonRecord[] = [];
    try {
      for (const group of GROUPS) {
        const current = await db.query<JsonRecord>(`
          select id,name,model_name,is_active,is_hidden,api_protocol_config
            from public.cover_models
           where id=$1
           for update
        `, [group.id]);
        assert.equal(current.rows.length, 1, `Missing GPT Image 2 group: ${group.id}`);
        const row = current.rows[0];
        assert.equal(row.model_name, "gpt-image-2", `Unexpected model family: ${group.id}`);
        assert.equal(row.is_active, false, `Failed group must remain inactive: ${group.id}`);
        const nextConfig = {
          ...configOf(row.api_protocol_config),
          catalog_visibility: "visible_disabled",
          activation_state: "failed_real_canary",
          activation_failure_code: group.code,
          public_unavailable_reason: group.reason,
        };
        await db.query(`
          update public.cover_models
             set is_active=false,
                 is_hidden=false,
                 api_protocol_config=$2::jsonb,
                 updated_at=now()
           where id=$1
        `, [group.id, JSON.stringify(nextConfig)]);
        results.push({
          id: group.id,
          name: row.name,
          active: false,
          hidden: false,
          catalogVisibility: "visible_disabled",
          activationState: "failed_real_canary",
          failureCode: group.code,
          publicReason: group.reason,
        });
      }
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }

    const evidence = {
      checkedAt: new Date().toISOString(),
      localOnly: true,
      database: "zimeiti_local",
      databaseWrites: GROUPS.length,
      paidGenerationRequests: 0,
      providerRequests: 0,
      policy: "visible-but-server-blocked-after-failed-real-canary",
      groups: results,
    };
    await mkdir(path.dirname(EVIDENCE_FILE), { recursive: true });
    await writeFile(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "GPT_IMAGE2_VISIBLE_DISABLED_UPDATE_FAILED");
  process.exitCode = 1;
});
