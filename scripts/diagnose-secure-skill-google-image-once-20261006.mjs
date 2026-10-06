#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || "";
const modelId = argument("--model-id");
const promptFile = argument("--prompt-file");
const outputArgument = argument("--output");
const resolution = argument("--resolution") || "2K";
const aspectRatio = argument("--aspect-ratio") || "16:9";
assert.ok(process.argv.includes("--execute-paid-provider-probe"), "EXPLICIT_PAID_PROVIDER_PROBE_REQUIRED");
assert.match(modelId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u, "PRIVATE_IMAGE_MODEL_ID_REQUIRED");
assert.ok(promptFile && outputArgument, "PROMPT_AND_OUTPUT_REQUIRED");
assert.ok(["1K", "2K", "4K"].includes(resolution), "RESOLUTION_INVALID");
assert.ok(["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"].includes(aspectRatio), "ASPECT_RATIO_INVALID");

const output = path.resolve(outputArgument);
const evidenceRoot = `${path.resolve(".codex-evidence")}${path.sep}`;
assert.ok(output.startsWith(evidenceRoot) && output.endsWith(".json"), "IMMUTABLE_EVIDENCE_PATH_REQUIRED");
await fs.access(output).then(() => assert.fail("OUTPUT_ALREADY_EXISTS"), () => undefined);
const prompt = (await fs.readFile(path.resolve(promptFile), "utf8")).trim();
assert.ok(prompt.length >= 20 && prompt.length <= 8_000, "PROMPT_LENGTH_INVALID");

const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_REQUIRED");
assert.equal(runtime.ownerConnection?.port, 54322, "LOCAL_DATABASE_PORT_REQUIRED");
const database = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-secure-skill-google-image-diagnostic" });
await database.connect();
let row;
try {
  await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const result = await database.query(
    "SELECT id::text,model_name,provider,api_endpoint,api_key,api_protocol_config FROM public.cover_models WHERE id=$1",
    [modelId],
  );
  assert.equal(result.rowCount, 1, "IMAGE_MODEL_NOT_FOUND");
  row = result.rows[0];
  await database.query("ROLLBACK");
} finally {
  await database.end().catch(() => undefined);
}

assert.equal(row.provider, "secure_skill_chat", "SECURE_SKILL_PROVIDER_REQUIRED");
const endpoint = new URL(String(row.api_endpoint || ""));
assert.equal(endpoint.origin, "https://token.secure-skill.com", "SECURE_SKILL_PRIMARY_ENDPOINT_REQUIRED");
assert.equal(row.api_protocol_config?.protocol, "google_generate_content", "GOOGLE_GENERATE_CONTENT_PROTOCOL_REQUIRED");
const credential = resolveProviderSecret(row.api_key).trim();
assert.ok(credential.length >= 8, "PROVIDER_CREDENTIAL_UNAVAILABLE");

const requestUrl = new URL(`/v1beta/models/${encodeURIComponent(row.model_name)}:generateContent`, endpoint.origin);
const startedAt = Date.now();
const response = await fetch(requestUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": credential },
  body: JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio, imageSize: resolution },
    },
  }),
  redirect: "error",
  signal: AbortSignal.timeout(13 * 60_000),
});
const elapsedMs = Date.now() - startedAt;
const raw = await response.text();
let body = null;
try { body = JSON.parse(raw); } catch { body = null; }
const clean = (value) => String(value || "")
  .replace(/https?:\/\/[^\s"'<>]+/giu, "[URL_REDACTED]")
  .replace(/\bBearer\s+\S+/giu, "[CREDENTIAL_REDACTED]")
  .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[CREDENTIAL_REDACTED]")
  .replace(/\s+/gu, " ")
  .slice(0, 500);

const parts = Array.isArray(body?.candidates)
  ? body.candidates.flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
  : [];
let visualAsset = null;
for (const part of parts) {
  const inline = part?.inlineData || part?.inline_data;
  const data = typeof inline?.data === "string" ? inline.data.replace(/\s/gu, "") : "";
  const mimeType = String(inline?.mimeType || inline?.mime_type || "").toLowerCase();
  if (!data || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) continue;
  const bytes = Buffer.from(data, "base64");
  assert.ok(bytes.length > 0 && bytes.length <= 25 * 1024 * 1024, "INLINE_IMAGE_SIZE_INVALID");
  const extension = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
  const assetPath = output.replace(/\.json$/u, extension);
  await fs.writeFile(assetPath, bytes, { flag: "wx" });
  visualAsset = {
    file: path.relative(process.cwd(), assetPath),
    contentType: mimeType,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  break;
}

const structuredError = body?.error && typeof body.error === "object" ? body.error : null;
const report = {
  schema: "secure_skill_google_image_direct_diagnostic.v1",
  checkedAt: new Date().toISOString(),
  providerOrigin: endpoint.origin,
  documentation: "https://token.secure-skill.com/docs#flow-images",
  modelId,
  modelName: row.model_name,
  promptSource: path.relative(process.cwd(), path.resolve(promptFile)),
  promptSha256: createHash("sha256").update(prompt).digest("hex"),
  aspectRatio,
  resolution,
  requestProtocol: "google_generate_content",
  requestCount: 1,
  localPlatformBillingRequests: 0,
  httpStatus: response.status,
  success: response.ok && Boolean(visualAsset),
  elapsedMs,
  error: response.ok ? null : {
    code: clean(structuredError?.code || body?.code || ""),
    type: clean(structuredError?.type || body?.type || ""),
    message: clean(structuredError?.message || body?.message || body?.detail || raw),
  },
  response: {
    candidateCount: Array.isArray(body?.candidates) ? body.candidates.length : 0,
    partKinds: parts.map((part) => part?.inlineData || part?.inline_data ? "inline_image" : typeof part?.text === "string" ? "text" : "other"),
  },
  visualAsset,
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  modelName: report.modelName,
  httpStatus: report.httpStatus,
  success: report.success,
  elapsedMs: report.elapsedMs,
  error: report.error,
  visualAsset: report.visualAsset?.file || null,
  output,
}));
