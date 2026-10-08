#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { main as verifyMediaHistory } from "./verify-media-history-live-readonly.mjs";

const OUTPUT_DIR = path.resolve(".codex-evidence/media-history-live-readonly-20260929");
const FIXTURE_ASSET_ID = "c1deda9d-01f8-46df-bb6a-d04024e6ee07";
const FIXTURE_PREFIX = "media_history_fixture_";
const SNAPSHOT_CACHE_TTL_MS = 5_000;

function localDatabaseUrl() {
  const raw = String(process.env.DATABASE_URL || "").trim();
  assert.ok(raw, "LOCAL_DATABASE_URL_REQUIRED");
  const url = new URL(raw);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(url.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(url.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  return raw;
}

function acceptanceUserId() {
  const raw = String(process.env.LOCAL_NAV_READONLY_IDENTITY || "").trim();
  assert.ok(raw, "LOCAL_ADMIN_IDENTITY_REQUIRED_USE_WITH_LOCAL_ADMIN_SESSION");
  const identity = JSON.parse(raw);
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const userId = String(identity?.user?.id || "").trim();
  assert.ok(userId, "LOCAL_ADMIN_ID_REQUIRED");
  return userId;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function waitForSnapshotExpiry() {
  return new Promise(resolve => setTimeout(resolve, SNAPSHOT_CACHE_TTL_MS + 500));
}

export async function main(args = process.argv.slice(2)) {
  assert.deepEqual(args, [], "TEMPORARY_MEDIA_FIXTURE_ACCEPTS_NO_ARGUMENTS");
  const userId = acceptanceUserId();
  const recordId = `${FIXTURE_PREFIX}${randomUUID().replaceAll("-", "")}`;
  const clientKey = `${recordId}_key`;
  const client = new Client({
    connectionString: localDatabaseUrl(),
    application_name: "codex-media-history-temporary-fixture",
  });
  const cleanup = {
    schemaVersion: 1,
    checkedAt: "",
    localDatabase: "zimeiti_local",
    recordId,
    assetId: FIXTURE_ASSET_ID,
    inserted: false,
    deletedRows: 0,
    residueRows: -1,
    verifierPassed: false,
  };
  let connected = false;
  let report;
  let primaryError;
  const priorExitCode = process.exitCode;

  try {
    await client.connect();
    connected = true;
    const priorFixtures = await client.query(
      "select count(*)::integer as count from public.image_generation_requests where record_id like $1",
      [`${FIXTURE_PREFIX}%`],
    );
    assert.equal(priorFixtures.rows[0]?.count, 0, "PREVIOUS_MEDIA_HISTORY_FIXTURE_RESIDUE_FOUND");

    const asset = await client.query(
      `select f.id::text, f.user_id::text, f.storage_provider, f.storage_key, f.content_type
         from public.user_files f
         join public.users u on u.id::text = f.user_id::text
        where f.id::text = $1
          and f.user_id::text = $2
          and u.role = 'admin'
          and u.is_active = true
          and f.storage_provider = 'tencent_cos'
          and f.content_type like 'image/%'
          and nullif(trim(f.storage_key), '') is not null
        limit 1`,
      [FIXTURE_ASSET_ID, userId],
    );
    assert.equal(asset.rowCount, 1, "OWNED_DURABLE_IMAGE_FIXTURE_ASSET_REQUIRED");

    const inserted = await client.query(
      `insert into public.image_generation_requests (
         record_id, user_id, user_hash, client_idempotency_key, client_trace_id,
         payload_fingerprint, state, response, delivery_state, delivery_asset_id,
         request_snapshot, created_at, updated_at
       ) values ($1, $2, $3, $4, $4, $5, 'completed', '{}'::jsonb,
         'delivered', $6, null, now(), now())
       returning record_id`,
      [recordId, userId, sha256(userId), clientKey, sha256(`${recordId}:${FIXTURE_ASSET_ID}`), FIXTURE_ASSET_ID],
    );
    assert.equal(inserted.rowCount, 1, "TEMPORARY_MEDIA_HISTORY_FIXTURE_INSERT_FAILED");
    cleanup.inserted = true;

    // The route keeps a five-second per-account read cache. Let any snapshot
    // created by a previous read expire before exercising the browser contract.
    await waitForSnapshotExpiry();
    process.exitCode = undefined;
    report = await verifyMediaHistory([]);
    assert.equal(report?.ok, true, "MEDIA_HISTORY_DYNAMIC_FIXTURE_ACCEPTANCE_FAILED");
    assert.equal(report?.api?.dynamicCoverage?.completedImage, true, "COMPLETED_IMAGE_WAS_NOT_EXERCISED");
    assert.equal(report?.api?.dynamicCoverage?.completedVideo, true, "COMPLETED_VIDEO_WAS_NOT_EXERCISED");
    cleanup.verifierPassed = true;
    process.exitCode = priorExitCode;
  } catch (error) {
    primaryError = error;
  } finally {
    if (connected) {
      try {
        if (cleanup.inserted) {
          const deleted = await client.query(
            "delete from public.image_generation_requests where record_id = $1 returning record_id",
            [recordId],
          );
          cleanup.deletedRows = deleted.rowCount || 0;
        }
        const residue = await client.query(
          "select count(*)::integer as count from public.image_generation_requests where record_id = $1",
          [recordId],
        );
        cleanup.residueRows = residue.rows[0]?.count ?? -1;
      } catch (cleanupError) {
        primaryError ||= cleanupError;
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    cleanup.checkedAt = new Date().toISOString();
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(OUTPUT_DIR, "temporary-fixture-cleanup.json"),
      `${JSON.stringify(cleanup, null, 2)}\n`,
    );
  }

  assert.equal(cleanup.inserted, true, "TEMPORARY_MEDIA_HISTORY_FIXTURE_WAS_NOT_INSERTED");
  assert.equal(cleanup.deletedRows, 1, "TEMPORARY_MEDIA_HISTORY_FIXTURE_WAS_NOT_DELETED");
  assert.equal(cleanup.residueRows, 0, "TEMPORARY_MEDIA_HISTORY_FIXTURE_RESIDUE_FOUND");
  if (primaryError) throw primaryError;
  assert.equal(cleanup.verifierPassed, true, "MEDIA_HISTORY_FIXTURE_VERIFIER_DID_NOT_PASS");
  console.log(JSON.stringify({ ok: true, report: report?.acceptance, cleanup }, null, 2));
  return { ok: true, report, cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
