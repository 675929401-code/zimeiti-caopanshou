#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const TARGET_IDS = ["gemini-3-0-pro-image-chA", "gemini-3-1-flash-image-chA"];
const PROVIDER_ORIGIN = "https://token.secure-skill.com";
const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const outputArgument = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length) || "";

assert.ok(outputArgument, "OUTPUT_REQUIRED");
const outputPath = path.resolve(outputArgument);
const evidenceRoot = `${path.resolve(".codex-evidence")}${path.sep}`;
assert.ok(outputPath.startsWith(evidenceRoot) && outputPath.endsWith(".json"), "IMMUTABLE_EVIDENCE_PATH_REQUIRED");
await fs.access(outputPath).then(() => assert.fail("OUTPUT_ALREADY_EXISTS"), () => undefined);

function modelIds(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return rows
    .map((entry) => typeof entry === "string" ? entry : String(entry?.id || entry?.model || entry?.name || ""))
    .filter(Boolean);
}

const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_REQUIRED");
const database = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-secure-skill-image-access-readonly" });
await database.connect();

const probes = [];
try {
  await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const result = await database.query(
    "SELECT id::text,model_name,api_endpoint,api_key,api_protocol_config FROM public.cover_models WHERE id=ANY($1::text[]) ORDER BY id",
    [TARGET_IDS],
  );
  assert.equal(result.rowCount, TARGET_IDS.length, "TARGET_MODELS_MISSING");
  for (const row of result.rows) {
    const credential = resolveProviderSecret(row.api_key).trim();
    assert.ok(credential.length >= 8, `${row.id}:CREDENTIAL_UNAVAILABLE`);
    const response = await fetch(`${PROVIDER_ORIGIN}/v1/models`, {
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    const ids = response.ok ? modelIds(body) : [];
    probes.push({
      id: row.id,
      configuredModelName: row.model_name,
      endpointOrigin: new URL(String(row.api_endpoint || "")).origin,
      configuredProtocol: String(row.api_protocol_config?.protocol || ""),
      status: response.status,
      modelCount: response.ok ? ids.length : null,
      configuredModelExact: ids.includes(row.model_name),
      recommendedPublicAliasPresent: row.id === "gemini-3-1-flash-image-chA"
        ? ids.includes("nano-banana-2")
        : ids.includes("nano-banana-pro"),
      relatedModels: ids.filter((id) => /(?:gemini.*image|nano.*banana)/iu.test(id)).sort(),
    });
  }
  await database.query("ROLLBACK");
} finally {
  await database.end().catch(() => undefined);
}

const report = {
  schema: "secure_skill_image_model_access_readonly.v1",
  checkedAt: new Date().toISOString(),
  providerOrigin: PROVIDER_ORIGIN,
  documentation: "https://token.secure-skill.com/docs#flow-images",
  readOnly: true,
  paidGenerationRequests: 0,
  credentialsPersisted: false,
  probes,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
