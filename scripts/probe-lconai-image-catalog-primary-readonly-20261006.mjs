#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const TARGET_MODEL = "gemini-3.1-flash-image-4k";
const TARGET_ID = "pending-cover-model-1789087566193-f4a5f4f1190f";
const CHANNEL_ORIGIN = "https://n.lconai.com";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/lconai-image-catalog-primary-readonly.json",
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
  const database = new pg.Client({ connectionString: databaseUrl, application_name: "codex-lconai-primary-image-catalog-readonly" });
  await database.connect();
  try {
    const result = await database.query(
      "SELECT id::text,model_name,api_endpoint,api_key FROM public.cover_models WHERE id=$1",
      [TARGET_ID],
    );
    assert.equal(result.rowCount, 1, "TARGET_MODEL_MISSING");
    const row = result.rows[0];
    const key = resolveProviderSecret(row.api_key).trim();
    assert.ok(key.length >= 8, "TARGET_SECRET_UNAVAILABLE");
    const response = await fetch(`${CHANNEL_ORIGIN}/v1/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    const ids = response.ok ? idsFrom(body) : [];
    const related = ids.filter((id) => /gemini.*3[._-]?1.*flash.*image|nano.*banana.*2/iu.test(id)).slice(0, 50);
    const report = {
      readOnly: true,
      chargedGenerationRequests: 0,
      checkedAt: new Date().toISOString(),
      channelOrigin: CHANNEL_ORIGIN,
      configured: {
        id: row.id,
        modelName: row.model_name,
        endpointMatchesPrimary: String(row.api_endpoint || "").replace(/\/+$/u, "") === CHANNEL_ORIGIN,
      },
      catalog: {
        status: response.status,
        modelCount: response.ok ? ids.length : null,
        configuredModelExact: ids.includes(TARGET_MODEL),
        related,
      },
    };
    await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
    await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await database.end();
  }
}
