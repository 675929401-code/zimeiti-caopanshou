#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const TARGET_IDS = ["gemini-3-0-pro-image-chA", "gemini-3-1-flash-image-chA"];
const CHANNEL_ORIGIN = "https://token.secure-skill.com";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/secure-skill-image-catalog-primary-readonly.json",
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
  const database = new pg.Client({ connectionString: databaseUrl, application_name: "codex-secure-skill-image-catalog-readonly" });
  await database.connect();
  try {
    const result = await database.query(
      "SELECT id::text,model_name,api_endpoint,api_key FROM public.cover_models WHERE id=ANY($1::text[]) ORDER BY id",
      [TARGET_IDS],
    );
    assert.equal(result.rowCount, TARGET_IDS.length, "TARGET_MODELS_MISSING");
    const probes = [];
    for (const row of result.rows) {
      const key = resolveProviderSecret(row.api_key).trim();
      assert.ok(key.length >= 8, `${row.id}:SECRET_UNAVAILABLE`);
      const response = await fetch(`${CHANNEL_ORIGIN}/v1/models`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => null);
      const ids = response.ok ? idsFrom(body) : [];
      probes.push({
        id: row.id,
        configuredModelName: row.model_name,
        endpointMatchesPrimary: String(row.api_endpoint || "").replace(/\/+$/u, "") === CHANNEL_ORIGIN,
        status: response.status,
        modelCount: response.ok ? ids.length : null,
        configuredModelExact: ids.includes(row.model_name),
        related: ids.filter((id) => /gemini.*(?:3.*(?:pro|flash).*image)|nano.*banana/iu.test(id)).slice(0, 80),
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
    await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await database.end();
  }
}
