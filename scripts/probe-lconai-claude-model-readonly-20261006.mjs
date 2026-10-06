#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const PRIMARY_ORIGIN = "https://n.lconai.com";
const TARGETS = new Map([
  ["claude-opus-5-5", {
    id: "3af4f2e6-a51f-44f6-ad17-9e6412147c81",
    secretRef: "secret://lconai-claude-opus-5-5",
  }],
  ["claude-sonnet-5-5", {
    id: "1cd040b5-c3ea-4217-bfe2-8c3f059554af",
    secretRef: "secret://lconai-claude-sonnet-5-5",
  }],
]);

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  return String(args.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function catalogEntries(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.models)) return body.models;
  return [];
}

function modelId(entry) {
  return typeof entry === "string"
    ? entry.trim()
    : String(entry?.id || entry?.model || entry?.name || "").trim();
}

function safeMetadata(entry) {
  if (!entry || typeof entry !== "object") return null;
  const allowed = ["object", "owned_by", "type", "endpoint", "api_type", "mode", "supported_endpoint_types"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = entry[key];
    if (["string", "number", "boolean"].includes(typeof value)) return [[key, value]];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [[key, value]];
    return [];
  }));
}

function safeLocalRow(row, target) {
  return {
    id: row.id,
    name: row.name,
    modelName: row.model_name,
    apiEndpoint: normalizeOrigin(row.api_endpoint),
    proxyUrl: normalizeOrigin(row.proxy_url),
    secretReferenceMatches: row.api_key === target.secretRef,
    active: row.is_active === true,
    hidden: row.is_hidden === true,
    userAccess: row.user_access,
    deepThinkingType: Number(row.deep_thinking_type),
    maxContextTokens: Number(row.max_context_tokens),
    maxReplyTokens: Number(row.max_reply_tokens),
    protocolConfig: row.api_protocol_config || {},
  };
}

async function main(args = process.argv.slice(2)) {
  const targetName = argumentValue(args, "model");
  const target = TARGETS.get(targetName);
  assert.ok(target, "SUPPORTED_MODEL_ARGUMENT_REQUIRED");

  const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const database = new pg.Client({
    ...runtime.ownerConnection,
    application_name: `codex-lconai-${targetName}-catalog-readonly`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });

  let row;
  try {
    await database.connect();
    const result = await database.query(
      `SELECT id::text,name,model_name,api_endpoint,proxy_url,api_key,
              is_active,is_hidden,user_access,deep_thinking_type,
              max_context_tokens,max_reply_tokens,api_protocol_config
         FROM public.llm_models
        WHERE id=$1`,
      [target.id],
    );
    assert.equal(result.rowCount, 1, "TARGET_MODEL_NOT_FOUND");
    row = result.rows[0];
  } finally {
    await database.end().catch(() => undefined);
  }

  assert.equal(row.model_name, targetName, "TARGET_MODEL_NAME_MISMATCH");
  assert.equal(row.api_key, target.secretRef, "TARGET_SECRET_REFERENCE_MISMATCH");
  const credential = resolveProviderSecret(row.api_key).trim();
  assert.ok(credential.length >= 8, "TARGET_SECRET_UNRESOLVABLE");

  let response;
  let responseCategory = "ok";
  try {
    response = await fetch(`${PRIMARY_ORIGIN}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    responseCategory = error?.name === "TimeoutError" ? "timeout" : "transport_error";
  }

  const body = response ? await response.json().catch(() => null) : null;
  const entries = response?.ok ? catalogEntries(body) : [];
  const exact = entries.find((entry) => modelId(entry) === targetName);
  const report = {
    passed: response?.ok === true && Boolean(exact),
    checkedAt: new Date().toISOString(),
    readOnly: true,
    providerRequests: 1,
    paidGenerationRequests: 0,
    channelOrigin: PRIMARY_ORIGIN,
    nativeMessagesUrl: `${PRIMARY_ORIGIN}/v1/messages`,
    local: safeLocalRow(row, target),
    catalog: {
      status: response?.status || null,
      category: response
        ? response.status === 401 || response.status === 403
          ? "authorization_rejected"
          : response.status === 404
            ? "catalog_endpoint_missing"
            : response.status === 429
              ? "rate_limited"
              : response.ok
                ? "ok"
                : "request_rejected"
        : responseCategory,
      modelCount: response?.ok ? entries.length : null,
      targetExact: Boolean(exact),
      targetMetadataKeys: exact && typeof exact === "object" ? Object.keys(exact).sort() : [],
      targetMetadata: safeMetadata(exact),
    },
  };

  const evidencePath = path.resolve(
    `.codex-evidence/lconai-workbook-onboarding-20261005/${targetName}-catalog-readonly.json`,
  );
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.passed, true, "LCONAI_CLAUDE_CATALOG_CHECK_FAILED");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
