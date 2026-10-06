import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storageRoot = path.resolve(appRoot, "..", "..", "..");
const runtimeFile = path.join(storageRoot, "运行数据", "自媒体操盘手", "local-data-20260902", "config", "runtime.json");
const migrationFile = path.join(appRoot, "supabase", "migrations", "20260924090000_restore_all_workspace_model_assignments.sql");
const evidenceDir = path.join(appRoot, ".codex-evidence", "model-ui-chat-closure-20260924");
const settingKeys = [
  "workspace_model_assignment_overrides_v1",
  "image_model_surface_orders_v1",
  "video_model_surface_orders_v1",
];

function extractSqlArray(sql, name) {
  const match = sql.match(new RegExp(`${name}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\]::text\\[\\];`, "u"));
  assert.ok(match, `MISSING_SQL_ARRAY_${name}`);
  return [...match[1].matchAll(/'([^']+)'/gu)].map((item) => item[1]);
}

function parseSetting(value) {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    const surfaces = parsed?.surfaces && typeof parsed.surfaces === "object" ? parsed.surfaces : parsed;
    return surfaces && typeof surfaces === "object" && !Array.isArray(surfaces) ? surfaces : {};
  } catch {
    return {};
  }
}

function assignedIds(value, surface) {
  return Object.entries(parseSetting(value)[surface] || {})
    .filter(([, enabled]) => enabled === true)
    .map(([id]) => id)
    .sort();
}

function orderedIds(value, surface) {
  return Object.entries(parseSetting(value)[surface] || {})
    .filter(([, order]) => Number.isFinite(Number(order)))
    .sort((left, right) => Number(left[1]) - Number(right[1]) || left[0].localeCompare(right[0]))
    .map(([id]) => id);
}

function sorted(values) {
  return [...values].sort();
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function main() {
  const execute = process.argv.includes("--execute");
  if (execute && !process.argv.includes("--confirm-local-workspace-model-restore")) {
    throw new Error("EXECUTE_REQUIRES_EXPLICIT_LOCAL_CONFIRMATION_FLAG");
  }

  const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  assert.equal(runtime.localOnly, true, "LOCAL_ONLY_RUNTIME_REQUIRED");
  const connectionString = [runtime.ownerDatabaseUrl, runtime.databaseUrl, runtime.ownerConnection]
    .find((value) => typeof value === "string" && value.trim()) || "";
  const target = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(target.hostname), "LOOPBACK_DATABASE_REQUIRED");
  assert.equal(target.port, "54322", "EXPECTED_LOCAL_DATABASE_PORT_54322");
  assert.equal(target.pathname.replace(/^\//u, ""), "zimeiti_local", "EXPECTED_LOCAL_DATABASE_NAME");

  const sql = fs.readFileSync(migrationFile, "utf8");
  const expected = {
    image: extractSqlArray(sql, "v_image_ids"),
    storyboardVideo: extractSqlArray(sql, "v_storyboard_video_ids"),
    videoPage: extractSqlArray(sql, "v_video_page_ids"),
    freeCanvasVideo: extractSqlArray(sql, "v_free_canvas_video_ids"),
    commerceVideo: extractSqlArray(sql, "v_commerce_video_ids"),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(expected).map(([key, ids]) => [key, new Set(ids).size])), {
    image: 7,
    storyboardVideo: 26,
    videoPage: 21,
    freeCanvasVideo: 32,
    commerceVideo: 8,
  });

  const client = new Client({ connectionString, application_name: "codex-workspace-model-restore-20260924" });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const beforeResult = await client.query(
      "SELECT setting_key, setting_value, updated_at FROM public.platform_settings WHERE setting_key = ANY($1::text[]) ORDER BY setting_key FOR UPDATE",
      [settingKeys],
    );
    const before = Object.fromEntries(beforeResult.rows.map((row) => [row.setting_key, row.setting_value]));
    await client.query(sql);
    const afterResult = await client.query(
      "SELECT setting_key, setting_value, updated_at FROM public.platform_settings WHERE setting_key = ANY($1::text[]) ORDER BY setting_key",
      [settingKeys],
    );
    const after = Object.fromEntries(afterResult.rows.map((row) => [row.setting_key, row.setting_value]));

    const assignment = after.workspace_model_assignment_overrides_v1;
    const imageOrder = after.image_model_surface_orders_v1;
    const videoOrder = after.video_model_surface_orders_v1;
    for (const surface of ["image-workbench", "cover-studio", "storyboard-image", "free-canvas-image", "film-studio-image"]) {
      assert.deepEqual(assignedIds(assignment, surface), sorted(expected.image), `${surface}_ASSIGNMENT_MISMATCH`);
    }
    assert.deepEqual(assignedIds(assignment, "storyboard-video"), sorted(expected.storyboardVideo));
    assert.deepEqual(assignedIds(assignment, "film-studio-video"), sorted(expected.storyboardVideo));
    assert.deepEqual(assignedIds(assignment, "video-page"), sorted(expected.videoPage));
    assert.deepEqual(assignedIds(assignment, "free-canvas-video"), sorted(expected.freeCanvasVideo));
    assert.deepEqual(assignedIds(assignment, "commerce-video"), sorted(expected.commerceVideo));
    for (const surface of ["image-workbench", "cover-studio", "storyboard-workbench", "free-canvas", "film-studio"]) {
      assert.deepEqual(orderedIds(imageOrder, surface), expected.image, `${surface}_ORDER_MISMATCH`);
    }
    assert.deepEqual(orderedIds(videoOrder, "storyboard"), expected.storyboardVideo);
    assert.deepEqual(orderedIds(videoOrder, "film-studio"), expected.storyboardVideo);
    assert.deepEqual(orderedIds(videoOrder, "ai-video"), expected.videoPage);
    assert.deepEqual(orderedIds(videoOrder, "free-canvas"), expected.freeCanvasVideo);
    assert.deepEqual(orderedIds(videoOrder, "commerce-agent"), expected.commerceVideo);

    if (!execute) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      console.log(JSON.stringify({
        mode: "dry-run",
        target: "127.0.0.1:54322/zimeiti_local",
        verifiedCounts: Object.fromEntries(Object.entries(expected).map(([key, ids]) => [key, ids.length])),
        settingsChanged: settingKeys.filter((key) => before[key] !== after[key]),
        providerCalls: 0,
        productionWrites: 0,
      }, null, 2));
      return;
    }

    fs.mkdirSync(evidenceDir, { recursive: true });
    const runId = timestamp();
    const beforeFile = path.join(evidenceDir, `${runId}-all-surfaces-before.json`);
    fs.writeFileSync(beforeFile, JSON.stringify({
      schema: "workspace_model_restore_before.v1",
      capturedAt: new Date().toISOString(),
      target: "127.0.0.1:54322/zimeiti_local",
      settings: Object.fromEntries(settingKeys.map((key) => [key, before[key] ?? null])),
      containsSecrets: false,
    }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });

    await client.query("COMMIT");
    transactionOpen = false;
    const report = {
      schema: "workspace_model_restore.v1",
      restoredAt: new Date().toISOString(),
      target: "127.0.0.1:54322/zimeiti_local",
      migration: path.basename(migrationFile),
      restoredCounts: Object.fromEntries(Object.entries(expected).map(([key, ids]) => [key, ids.length])),
      beforeFile: path.basename(beforeFile),
      resourcePoolMutations: 0,
      providerCalls: 0,
      productionWrites: 0,
      containsSecrets: false,
    };
    const reportFile = path.join(evidenceDir, `${runId}-all-surfaces-report.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ ...report, reportFile: path.basename(reportFile) }, null, 2));
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
