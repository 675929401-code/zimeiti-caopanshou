#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const CHANNEL_ORIGIN = "https://n.lconai.com";
const TARGETS = [
  ["seedance-2-5-480p-i2v", "secret://lconai-seedance-2-5-480p-i2v"],
  ["seedance-2-0-fast-720p-i2v", "secret://lconai-seedance-2-0-fast-720p-i2v"],
  ["grok-video-3-pro", "secret://lconai-grok-video-3-pro"],
];
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/lconai-video-catalog-primary-readonly.json",
);

function idsFrom(body) {
  const values = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return values.map((entry) => typeof entry === "string" ? entry : String(entry?.id || entry?.model || entry?.name || "")).filter(Boolean);
}

export async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, "127.0.0.1", "LOCAL_DATABASE_REQUIRED");
  const database = new pg.Client({ connectionString: databaseUrl, application_name: "codex-lconai-primary-video-catalog-readonly" });
  await database.connect();
  try {
    const result = await database.query(
      `SELECT id::text,model_name,api_endpoint,api_key FROM public.video_models WHERE model_name = ANY($1::text[]) ORDER BY model_name`,
      [TARGETS.map(([modelName]) => modelName)],
    );
    assert.equal(result.rowCount, TARGETS.length, "TARGET_MODEL_COUNT_MISMATCH");
    const probes = [];
    for (const row of result.rows) {
      const expectedSecretRef = TARGETS.find(([modelName]) => modelName === row.model_name)?.[1];
      const key = resolveProviderSecret(row.api_key).trim();
      assert.ok(key.length >= 8, `${row.model_name}:SECRET_UNAVAILABLE`);
      let response;
      try {
        response = await fetch(`${CHANNEL_ORIGIN}/v1/models`, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        probes.push({
          modelName: row.model_name,
          configuredEndpoint: String(row.api_endpoint || "").replace(/\/+$/u, ""),
          secretReferenceMatches: row.api_key === expectedSecretRef,
          status: null,
          category: error?.name === "TimeoutError" ? "timeout" : "transport_error",
          targetExact: false,
        });
        continue;
      }
      const body = await response.json().catch(() => null);
      const ids = response.ok ? idsFrom(body) : [];
      probes.push({
        modelName: row.model_name,
        configuredEndpoint: String(row.api_endpoint || "").replace(/\/+$/u, ""),
        secretReferenceMatches: row.api_key === expectedSecretRef,
        status: response.status,
        category: response.ok ? "ok" : response.status === 401 || response.status === 403 ? "authorization_rejected" : "request_rejected",
        modelCount: response.ok ? ids.length : null,
        targetExact: ids.includes(row.model_name),
      });
    }
    const report = {
      readOnly: true,
      chargedGenerationRequests: 0,
      checkedAt: new Date().toISOString(),
      channelOrigin: CHANNEL_ORIGIN,
      probes,
    };
    await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
    await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await database.end();
  }
}
