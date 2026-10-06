#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ORIGIN = "https://n.lconai.com";
const TARGETS = new Map([
  ["claude-opus-5-5", "3af4f2e6-a51f-44f6-ad17-9e6412147c81"],
  ["claude-sonnet-5-5", "1cd040b5-c3ea-4217-bfe2-8c3f059554af"],
]);

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  return String(args.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

function responseText(body) {
  if (!Array.isArray(body?.content)) return "";
  return body.content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("")
    .trim();
}

function safeError(body) {
  const error = body?.error && typeof body.error === "object" ? body.error : null;
  return error ? {
    type: typeof error.type === "string" ? error.type : null,
    code: typeof error.code === "string" ? error.code : null,
    message: typeof error.message === "string" ? error.message.slice(0, 500) : null,
  } : null;
}

async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute-paid-diagnostic"), "EXPLICIT_PAID_DIAGNOSTIC_CONFIRMATION_REQUIRED");
  const targetName = argumentValue(args, "model");
  const targetId = TARGETS.get(targetName);
  assert.ok(targetId, "SUPPORTED_MODEL_ARGUMENT_REQUIRED");

  const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const database = new pg.Client({
    ...runtime.ownerConnection,
    application_name: `codex-lconai-${targetName}-native-diagnostic`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });

  let row;
  try {
    await database.connect();
    const result = await database.query(
      `SELECT id::text,model_name,api_endpoint,api_key,api_protocol_config,
              input_cost_per_million,output_cost_per_million
         FROM public.llm_models
        WHERE id=$1`,
      [targetId],
    );
    assert.equal(result.rowCount, 1, "TARGET_MODEL_NOT_FOUND");
    row = result.rows[0];
  } finally {
    await database.end().catch(() => undefined);
  }
  assert.equal(row.model_name, targetName, "TARGET_MODEL_NAME_MISMATCH");
  assert.equal(row.api_endpoint, ORIGIN, "PRIMARY_ORIGIN_REQUIRED");
  assert.equal(row.api_protocol_config?.protocol, "anthropic_messages", "ANTHROPIC_MESSAGES_PROTOCOL_REQUIRED");
  const credential = resolveProviderSecret(row.api_key).trim();
  assert.ok(credential.length >= 8, "TARGET_SECRET_UNRESOLVABLE");

  const expected = `NATIVE_OK_${crypto.randomUUID().replaceAll("-", "")}`;
  const startedAt = Date.now();
  let response;
  let body;
  let transportError = null;
  try {
    response = await fetch(`${ORIGIN}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: targetName,
        max_tokens: 64,
        messages: [{ role: "user", content: `Return exactly ${expected} and no additional text.` }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    transportError = error?.name === "TimeoutError" ? "timeout" : "transport_error";
  }

  const output = responseText(body);
  const usage = body?.usage && typeof body.usage === "object" ? {
    inputTokens: Number(body.usage.input_tokens || 0),
    outputTokens: Number(body.usage.output_tokens || 0),
    cacheReadInputTokens: Number(body.usage.cache_read_input_tokens || 0),
  } : null;
  const estimatedSupplierCost = usage
    ? ((usage.inputTokens * Number(row.input_cost_per_million))
      + (usage.outputTokens * Number(row.output_cost_per_million))) / 1_000_000
    : null;
  const report = {
    passed: response?.ok === true && output === expected,
    checkedAt: new Date().toISOString(),
    modelId: targetId,
    modelName: targetName,
    endpoint: `${ORIGIN}/v1/messages`,
    protocol: "anthropic_messages",
    requestCount: 1,
    retryCount: 0,
    paidGenerationRequests: response?.ok ? 1 : 0,
    httpStatus: response?.status || null,
    transportError,
    providerError: safeError(body),
    instructionFollowed: output === expected,
    outputLength: output.length,
    outputSha256: output ? crypto.createHash("sha256").update(output).digest("hex") : null,
    usage,
    estimatedSupplierCost,
    secretReturned: false,
    productionWrites: 0,
  };
  const evidencePath = path.resolve(
    `.codex-evidence/lconai-workbook-onboarding-20261005/${targetName}-native-diagnostic.json`,
  );
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.passed, true, "LCONAI_NATIVE_DIAGNOSTIC_FAILED");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
