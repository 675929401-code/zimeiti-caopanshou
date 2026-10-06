#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveProviderSecret } from "../src/lib/provider-secret.ts";

const argument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
};

const safeText = (value, limit = 500) => String(value || "")
  .replace(/https?:\/\/\S+/giu, "[url]")
  .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
  .slice(0, limit);

async function restRows(table, select, filters = {}) {
  const base = String(process.env.COZE_SUPABASE_URL || "").replace(/\/+$/u, "");
  const key = String(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || "");
  assert.match(base, /^http:\/\/127\.0\.0\.1:54321$/u, "LOCAL_SUPABASE_REQUIRED");
  assert.ok(key, "LOCAL_SERVICE_ROLE_REQUIRED");
  const url = new URL(`${base}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok && Array.isArray(body), `${table}:LOCAL_READ_FAILED:${response.status}`);
  return body;
}

export async function main() {
  assert.ok(process.argv.includes("--confirm-readonly-provider-status"), "EXPLICIT_READONLY_CONFIRMATION_REQUIRED");
  assert.equal(process.env.LOCAL_ACCEPTANCE_PREVIEW, "true", "LOCAL_ACCEPTANCE_PREVIEW_REQUIRED");
  const taskId = argument("task-id");
  const evidencePath = argument("evidence");
  assert.match(taskId, /^vt_[A-Za-z0-9]{8,100}$/u, "VIDEO_TASK_ID_REQUIRED");
  assert.ok(evidencePath, "EVIDENCE_PATH_REQUIRED");

  const [task] = await restRows(
    "video_tasks",
    "id,model_id,task_id_external,status,billing_state,price_charged,routing_snapshot",
    { id: `eq.${taskId}`, limit: "1" },
  );
  assert.ok(task?.task_id_external, "PROVIDER_TASK_ID_REQUIRED");
  const matchingTasks = await restRows(
    "video_tasks",
    "id,model_id,status,billing_state,price_charged",
    { task_id_external: `eq.${task.task_id_external}`, limit: "20" },
  );
  const [model] = await restRows(
    "video_models",
    "id,model_name,protocol_type,api_endpoint,api_key,api_protocol_config",
    { id: `eq.${task.model_id}`, limit: "1" },
  );
  assert.ok(model?.api_endpoint && model?.api_key, "VIDEO_MODEL_CONFIGURATION_REQUIRED");

  const base = String(model.api_endpoint).replace(/\/+$/u, "").replace(/\/v1\/?$/u, "");
  const pollTemplate = String(model.api_protocol_config?.poll_path || "/v1/videos/{id}");
  const pathname = pollTemplate.replace("{id}", encodeURIComponent(String(task.task_id_external)));
  const endpoint = `${base}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
  const credential = resolveProviderSecret(model.api_key);
  let response;
  let body;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    body = await response.json().catch(() => ({}));
  } finally {
    // Keep the credential scoped to this one request and never persist it.
  }

  const error = body?.error && typeof body.error === "object" ? body.error : {};
  const providerVideoUrl = String(body?.video_url || body?.url || body?.output?.video_url || body?.metadata?.video_url || "").trim();
  let providerVideoShape = null;
  if (providerVideoUrl) {
    try {
      const parsed = new URL(providerVideoUrl);
      providerVideoShape = {
        absolute: true,
        protocol: parsed.protocol,
        hostname: parsed.hostname.toLowerCase(),
        hasCredentials: Boolean(parsed.username || parsed.password),
        hasPort: Boolean(parsed.port),
        hasFragment: Boolean(parsed.hash),
        pathnameIsRoot: !parsed.pathname || parsed.pathname === "/",
        pathnameEndsWithContent: parsed.pathname.endsWith("/content"),
        pathnameHasExtension: /\.[A-Za-z0-9]{2,8}$/u.test(parsed.pathname),
      };
    } catch {
      providerVideoShape = { absolute: false, startsWithSlash: providerVideoUrl.startsWith("/") };
    }
  }
  const report = {
    checkedAt: new Date().toISOString(),
    localOnly: true,
    providerSubmissionRequests: 0,
    providerStatusRequests: 1,
    taskId,
    matchingLocalTaskCount: matchingTasks.length,
    matchingLocalTasks: matchingTasks.map((row) => ({
      id: String(row.id || ""),
      modelId: String(row.model_id || ""),
      status: String(row.status || ""),
      billingState: String(row.billing_state || ""),
      priceCharged: Number(row.price_charged || 0),
    })),
    modelId: String(model.id),
    upstreamModel: String(model.model_name || ""),
    protocolType: String(model.protocol_type || ""),
    endpointHost: new URL(base).hostname,
    requestFormat: String(model.api_protocol_config?.request_format || "json"),
    routingSnapshot: task.routing_snapshot && typeof task.routing_snapshot === "object" ? {
      modelId: safeText(task.routing_snapshot.modelId || task.routing_snapshot.model_id, 120),
      modelName: safeText(task.routing_snapshot.modelName || task.routing_snapshot.model_name, 120),
      protocolType: safeText(task.routing_snapshot.protocolType || task.routing_snapshot.protocol_type, 120),
      endpointHost: (() => {
        try { return new URL(String(task.routing_snapshot.apiEndpoint || task.routing_snapshot.api_endpoint || "")).hostname; }
        catch { return null; }
      })(),
      requestFormat: safeText(task.routing_snapshot.apiProtocolConfig?.request_format || task.routing_snapshot.api_protocol_config?.request_format, 80),
      credentialRefPresent: Boolean(task.routing_snapshot.credentialRef || task.routing_snapshot.credential_ref),
    } : null,
    localStatus: String(task.status || ""),
    localBillingState: String(task.billing_state || ""),
    localPriceCharged: Number(task.price_charged || 0),
    providerHttpStatus: response.status,
    providerStatus: safeText(body?.status, 80),
    providerProgress: Number.isFinite(Number(body?.progress)) ? Number(body.progress) : null,
    providerModel: safeText(body?.model, 120),
    providerCreatedAt: safeText(body?.created_at, 120) || null,
    providerCompletedAt: safeText(body?.completed_at, 120) || null,
    providerExpiresAt: safeText(body?.expires_at, 120) || null,
    providerErrorCode: safeText(error?.code || body?.code, 160) || null,
    providerErrorMessage: safeText(error?.message || body?.message, 500) || null,
    hasVideoUrl: Boolean(providerVideoUrl),
    providerVideoShape,
  };
  const target = path.resolve(evidencePath);
  assert.ok(target.startsWith(`${path.resolve(".codex-evidence")}${path.sep}`), "EVIDENCE_MUST_BE_LOCAL");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`).href) {
  await main();
}
