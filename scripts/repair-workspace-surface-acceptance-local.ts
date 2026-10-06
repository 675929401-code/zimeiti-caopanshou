import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const MIGRATION_EVIDENCE = ".codex-evidence/workspace-model-routing-20260920/migration-applied.json";
const APPLY = process.argv.includes("--apply");

type Change = {
  table: "cover_models" | "video_models";
  id: string;
  before: string[];
  after: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueCandidates(change: Change): Array<string[] | null> {
  const legacy = (values: string[]) => values.map((value) => {
    if (value === "ai-video") return "video-page";
    if (value === "storyboard") return "storyboard-workbench";
    return value;
  });
  const candidates: Array<string[] | null> = [
    change.before,
    legacy(change.before),
    change.after,
    legacy(change.after),
    ["ai-video", "storyboard"],
    ["video-page", "storyboard-workbench"],
    ["ai-video"],
    ["video-page"],
    ["storyboard"],
    ["storyboard-workbench"],
    ["digital-human"],
    [],
    null,
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const runtime = JSON.parse(fs.readFileSync(RUNTIME_CONFIG, "utf8")) as {
    localOnly?: boolean;
    databasePort?: number;
    databaseName?: string;
    ownerConnection?: Record<string, unknown>;
  };
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");

  const migration = JSON.parse(fs.readFileSync(MIGRATION_EVIDENCE, "utf8")) as { changes?: Change[] };
  const changes = (migration.changes || []).filter((change) => change.table === "video_models");
  assert.ok(changes.length > 0, "VIDEO_MIGRATION_EVIDENCE_REQUIRED");

  const {
    inspectVideoModelActivationReadiness,
    preserveVideoAcceptanceForWorkspaceSurfaceUpdate,
  } = await import("../src/lib/model-activation-gate");
  const { workspaceModelAssignments } = await import("../src/lib/workspace-model-policy");
  const db = new Client({ ...runtime.ownerConnection, query_timeout: 20_000 });
  await db.connect();
  const repaired: Array<{ id: string; priorWorkspaceSurfaces: string[] | null }> = [];
  const alreadyReady: string[] = [];
  const unresolved: Array<{ id: string; reason: string }> = [];

  try {
    await db.query("BEGIN");
    for (const change of changes) {
      const selected = await db.query("SELECT * FROM video_models WHERE id = $1 FOR UPDATE", [change.id]);
      assert.equal(selected.rowCount, 1, `MODEL_NOT_FOUND:${change.id}`);
      const row = selected.rows[0] as Record<string, unknown>;
      const currentConfig = record(row.api_protocol_config);
      assert.deepEqual(workspaceModelAssignments("video", row), change.after, `WORKSPACE_ASSIGNMENT_DRIFT:${change.id}`);
      if (inspectVideoModelActivationReadiness(row as never).ready) {
        alreadyReady.push(change.id);
        continue;
      }

      let acceptedBinding: Record<string, unknown> | null = null;
      let acceptedSurfaces: string[] | null = null;
      for (const candidate of uniqueCandidates(change)) {
        const candidateConfig = { ...currentConfig };
        if (candidate === null) delete candidateConfig.workspace_surfaces;
        else candidateConfig.workspace_surfaces = candidate;
        const binding = { ...row, api_protocol_config: candidateConfig };
        if (inspectVideoModelActivationReadiness(binding as never).ready) {
          acceptedBinding = binding;
          acceptedSurfaces = candidate;
          break;
        }
      }
      if (!acceptedBinding) {
        unresolved.push({ id: change.id, reason: "NO_MATCHING_PRE_MIGRATION_ACCEPTANCE_BINDING" });
        continue;
      }

      const repairedConfig = preserveVideoAcceptanceForWorkspaceSurfaceUpdate(acceptedBinding as never, currentConfig);
      const readbackBinding = { ...row, api_protocol_config: repairedConfig };
      assert.equal(inspectVideoModelActivationReadiness(readbackBinding as never).ready, true, `REPAIR_READBACK_FAILED:${change.id}`);
      repaired.push({ id: change.id, priorWorkspaceSurfaces: acceptedSurfaces });
      if (APPLY) {
        const updated = await db.query(
          "UPDATE video_models SET api_protocol_config = $2::jsonb WHERE id = $1 RETURNING api_protocol_config",
          [change.id, JSON.stringify(repairedConfig)],
        );
        assert.equal(updated.rowCount, 1, `REPAIR_WRITE_FAILED:${change.id}`);
        assert.equal(inspectVideoModelActivationReadiness({ ...row, api_protocol_config: updated.rows[0].api_protocol_config } as never).ready,
          true, `REPAIR_DATABASE_READBACK_FAILED:${change.id}`);
      }
    }
    if (APPLY) await db.query("COMMIT");
    else await db.query("ROLLBACK");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }

  const report = {
    at: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    target: "127.0.0.1:54322/zimeiti_local",
    providerRequests: 0,
    databaseWrites: APPLY ? repaired.length : 0,
    repaired,
    alreadyReady,
    unresolved,
  };
  const evidenceDir = path.resolve(".codex-evidence/workspace-model-routing-20260920");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, APPLY ? "acceptance-repair-applied.json" : "acceptance-repair-plan.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    mode: report.mode,
    target: report.target,
    providerRequests: 0,
    databaseWrites: report.databaseWrites,
    repaired: repaired.length,
    alreadyReady: alreadyReady.length,
    unresolved,
  }, null, 2));
}

void main().catch((error) => {
  console.error("WORKSPACE_ACCEPTANCE_REPAIR_FAILED", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
