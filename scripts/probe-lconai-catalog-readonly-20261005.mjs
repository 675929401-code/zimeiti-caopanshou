#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const CHANNEL_ORIGIN = "https://s.lconai.com";
const TARGET_NAMES = new Set([
  "gpt-6.1-sol",
  "claude-opus-5-5",
  "seedance-2-5-480p-i2v",
  "seedance-2-0-fast-720p-i2v",
  "grok-video-3-pro",
]);
const EXPECTED_SECRET_REFS = new Map([
  ["gpt-6.1-sol", "secret://lconai-gpt-6-1-sol"],
  ["claude-opus-5-5", "secret://lconai-claude-opus-5-5"],
  ["seedance-2-5-480p-i2v", "secret://lconai-seedance-2-5-480p-i2v"],
  ["seedance-2-0-fast-720p-i2v", "secret://lconai-seedance-2-0-fast-720p-i2v"],
  ["grok-video-3-pro", "secret://lconai-grok-video-3-pro"],
]);
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/lconai-workbook-onboarding-20261005/catalog-probe-readonly.json",
);

function parseCatalog(body) {
  const candidates = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : [];
  return candidates
    .map((entry) => typeof entry === "string" ? entry : String(entry?.id || entry?.model || entry?.name || ""))
    .map((value) => value.trim())
    .filter(Boolean);
}

function catalogEntries(body) {
  return Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : [];
}

function safeTargetMetadata(body, targetName) {
  const target = catalogEntries(body).find((entry) => {
    const id = typeof entry === "string" ? entry : String(entry?.id || entry?.model || entry?.name || "");
    return id.trim() === targetName;
  });
  if (!target || typeof target !== "object") return null;
  const allowed = ["object", "owned_by", "type", "endpoint", "api_type", "mode"];
  return Object.fromEntries(allowed
    .filter((key) => ["string", "number", "boolean"].includes(typeof target[key]))
    .map((key) => [key, target[key]]));
}

function statusCategory(status) {
  if (status === 401 || status === 403) return "authorization_rejected";
  if (status === 404) return "catalog_endpoint_missing";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status >= 400) return "request_rejected";
  return "ok";
}

async function probe(row) {
  let key;
  try {
    key = resolveProviderSecret(row.api_key).trim();
  } catch {
    return {
      type: row.model_type,
      modelName: row.model_name,
      localId: row.id,
      endpointMatches: row.api_endpoint.replace(/\/+$/u, "") === CHANNEL_ORIGIN,
      secretReferenceMatches: row.api_key === EXPECTED_SECRET_REFS.get(row.model_name),
      localState: { active: row.is_active, hidden: row.is_hidden },
      catalog: { status: null, category: "secret_unresolvable", modelCount: null, targetExact: false },
    };
  }
  assert.ok(key.length >= 8, `${row.model_name}:RESOLVED_SECRET_INVALID`);
  let response;
  try {
    response = await fetch(`${CHANNEL_ORIGIN}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      type: row.model_type,
      modelName: row.model_name,
      localId: row.id,
      endpointMatches: row.api_endpoint.replace(/\/+$/u, "") === CHANNEL_ORIGIN,
      secretReferenceMatches: row.api_key === EXPECTED_SECRET_REFS.get(row.model_name),
      localState: { active: row.is_active, hidden: row.is_hidden },
      catalog: {
        status: null,
        category: error?.name === "TimeoutError" ? "timeout" : "transport_error",
        modelCount: null,
        targetExact: false,
      },
    };
  }
  const body = await response.json().catch(() => null);
  const ids = response.ok ? parseCatalog(body) : [];
  return {
    type: row.model_type,
    modelName: row.model_name,
    localId: row.id,
    endpointMatches: row.api_endpoint.replace(/\/+$/u, "") === CHANNEL_ORIGIN,
    secretReferenceMatches: row.api_key === EXPECTED_SECRET_REFS.get(row.model_name),
    localState: { active: row.is_active, hidden: row.is_hidden },
    catalog: {
      status: response.status,
      category: statusCategory(response.status),
      modelCount: response.ok ? ids.length : null,
      targetExact: ids.includes(row.model_name),
      targetMetadata: response.ok ? safeTargetMetadata(body, row.model_name) : null,
    },
  };
}

export async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(parsed.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(parsed.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-lconai-catalog-probe-readonly",
    statement_timeout: 10_000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT 'text'::text AS model_type,id::text,model_name,api_endpoint,api_key,is_active,is_hidden
         FROM public.llm_models
        WHERE model_name = ANY($1::text[])
       UNION ALL
       SELECT 'video'::text AS model_type,id::text,model_name,api_endpoint,api_key,is_active,is_hidden
         FROM public.video_models
        WHERE model_name = ANY($1::text[])
       ORDER BY model_type,model_name`,
      [[...TARGET_NAMES]],
    );
    assert.equal(result.rowCount, TARGET_NAMES.size, "LConAI_TARGET_ROW_COUNT_MISMATCH");
    const probes = [];
    for (const row of result.rows) probes.push(await probe(row));
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
    await client.end();
  }
}
