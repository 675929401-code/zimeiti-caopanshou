import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";

const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const APPLY = process.argv.includes("--apply");

type ModelRow = Record<string, unknown> & {
  id: string;
  api_protocol_config?: Record<string, unknown> | null;
};

function safeConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  dotenv.config({ path: ".env.local", quiet: true });
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

  const {
    evaluateWorkspaceModelCompatibility,
    isModelAssignedToWorkspace,
    withWorkspaceModelAssignment,
    workspaceModelAssignments,
  } = await import("../src/lib/workspace-model-policy");
  const { preserveVideoAcceptanceForWorkspaceSurfaceUpdate } = await import("../src/lib/model-activation-gate");
  const { RETIRED_MODEL_PROVIDER } = await import("../src/lib/model-retirement");

  const db = new Client({ ...runtime.ownerConnection, query_timeout: 20_000 });
  await db.connect();
  const changes: Array<{
    table: "cover_models" | "video_models";
    id: string;
    name: string;
    before: string[];
    after: string[];
    reasons: string[];
  }> = [];

  try {
    const imageResult = await db.query("SELECT * FROM cover_models ORDER BY sort_order, id");
    const videoResult = await db.query("SELECT * FROM video_models ORDER BY sort_order, id");

    for (const raw of imageResult.rows as ModelRow[]) {
      if (raw.provider === RETIRED_MODEL_PROVIDER) continue;
      const before = workspaceModelAssignments("image", raw);
      let next = raw;
      const reasons: string[] = [];
      const defaultVisible = raw.is_active === true && raw.is_hidden === false;
      for (const surface of ["image-workbench", "cover-studio", "storyboard-image", "free-canvas-image", "film-studio-image"] as const) {
        const compatibility = evaluateWorkspaceModelCompatibility("image", next, surface);
        const currentlyAssigned = isModelAssignedToWorkspace("image", next, surface);
        if (defaultVisible && compatibility.compatible && !currentlyAssigned) {
          next = { ...next, api_protocol_config: withWorkspaceModelAssignment("image", next, surface, true) };
          reasons.push(`preserve_existing_visible_${surface}_catalog`);
        } else if (!compatibility.compatible && currentlyAssigned) {
          next = { ...next, api_protocol_config: withWorkspaceModelAssignment("image", next, surface, false) };
          reasons.push(`remove_incompatible_${surface}_assignment`);
        }
      }
      const after = workspaceModelAssignments("image", next);
      if (!sameJson(before, after)) changes.push({
        table: "cover_models",
        id: raw.id,
        name: String(raw.name || raw.model_name || raw.id),
        before,
        after,
        reasons,
      });
    }

    for (const raw of videoResult.rows as ModelRow[]) {
      if (raw.provider === RETIRED_MODEL_PROVIDER) continue;
      const before = workspaceModelAssignments("video", raw);
      let next = raw;
      const reasons: string[] = [];
      const defaultVisible = raw.is_active === true && raw.is_hidden === false;
      for (const surface of ["video-page", "storyboard-video", "free-canvas-video", "film-studio-video"] as const) {
        const compatibility = evaluateWorkspaceModelCompatibility("video", next, surface);
        const currentlyAssigned = isModelAssignedToWorkspace("video", next, surface);
        if (defaultVisible && compatibility.compatible && !currentlyAssigned) {
          next = { ...next, api_protocol_config: withWorkspaceModelAssignment("video", next, surface, true) };
          reasons.push(`preserve_existing_visible_${surface}_catalog`);
        } else if (!compatibility.compatible && currentlyAssigned) {
          next = { ...next, api_protocol_config: withWorkspaceModelAssignment("video", next, surface, false) };
          reasons.push(`remove_incompatible_${surface}_assignment`);
        }
      }
      const after = workspaceModelAssignments("video", next);
      if (!sameJson(before, after)) changes.push({
        table: "video_models",
        id: raw.id,
        name: String(raw.name || raw.model_name || raw.id),
        before,
        after,
        reasons,
      });
    }

    if (APPLY && changes.length > 0) {
      await db.query("BEGIN");
      try {
        for (const change of changes) {
          const table = change.table === "cover_models" ? "cover_models" : "video_models";
          const current = await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [change.id]);
          assert.equal(current.rowCount, 1, `MODEL_NOT_FOUND:${change.id}`);
          const config = safeConfig(current.rows[0]?.api_protocol_config);
          const expectedBefore = change.table === "cover_models"
            ? workspaceModelAssignments("image", { api_protocol_config: config })
            : workspaceModelAssignments("video", { api_protocol_config: config });
          assert.deepEqual(expectedBefore, change.before, `MODEL_CHANGED_DURING_MIGRATION:${change.id}`);
          let nextConfig: Record<string, unknown> = { ...config, workspace_surfaces: change.after };
          if (change.table === "video_models") {
            nextConfig = preserveVideoAcceptanceForWorkspaceSurfaceUpdate({
              ...current.rows[0],
              api_protocol_config: config,
            }, nextConfig);
          }
          const updated = await db.query(
            `UPDATE ${table} SET api_protocol_config = $2::jsonb WHERE id = $1 RETURNING api_protocol_config`,
            [change.id, JSON.stringify(nextConfig)],
          );
          assert.equal(updated.rowCount, 1, `MODEL_UPDATE_FAILED:${change.id}`);
          const readback = change.table === "cover_models"
            ? workspaceModelAssignments("image", { api_protocol_config: updated.rows[0]?.api_protocol_config })
            : workspaceModelAssignments("video", { api_protocol_config: updated.rows[0]?.api_protocol_config });
          assert.deepEqual(readback, change.after, `MODEL_READBACK_MISMATCH:${change.id}`);
        }
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    }

    const evidenceDir = path.resolve(".codex-evidence/workspace-model-routing-20260920");
    fs.mkdirSync(evidenceDir, { recursive: true });
    const report = {
      at: new Date().toISOString(),
      mode: APPLY ? "apply" : "dry-run",
      target: "127.0.0.1:54322/zimeiti_local",
      providerRequests: 0,
      databaseWrites: APPLY ? changes.length : 0,
      changes,
    };
    fs.writeFileSync(path.join(evidenceDir, APPLY ? "migration-applied.json" : "migration-plan.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      mode: report.mode,
      target: report.target,
      providerRequests: 0,
      databaseWrites: report.databaseWrites,
      changeCount: changes.length,
      imageChanges: changes.filter((item) => item.table === "cover_models").length,
      videoChanges: changes.filter((item) => item.table === "video_models").length,
      changes,
    }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("WORKSPACE_MODEL_ROUTING_MIGRATION_FAILED", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
