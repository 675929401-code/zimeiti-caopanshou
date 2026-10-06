#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const modelId = "pending-cover-model-gpt-image-2-official";
const reason = "上游明确返回无可用兼容账户，本次失败未扣费；请在后台更换该分组密钥或渠道后重新验收";
const outputDir = path.resolve(".codex-evidence/gpt-image2-official-status-20260922");

async function json(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, body?.error || `${pathname} failed with ${response.status}`);
  return body;
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PORT_5000_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  const identity = await json("/api/auth/me");
  assert.equal(identity.user?.role, "admin", "LOCAL_ADMIN_REQUIRED");

  const beforeList = await json("/api/admin/cover-models");
  const before = beforeList.models?.find((model) => model.id === modelId);
  assert.ok(before, "GPT_IMAGE2_OFFICIAL_GROUP_MISSING");
  assert.equal(before.api_key_configured, true, "GPT_IMAGE2_OFFICIAL_CREDENTIAL_MISSING");
  const nextConfig = {
    ...(before.api_protocol_config || {}),
    catalog_visibility: "visible_disabled",
    public_availability_code: "upstream_account_unavailable",
    activation_state: "failed_real_canary",
    activation_failure_code: "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE",
    public_unavailable_reason: reason,
    capability_evidence: "2026-09-22: platform validation received upstream 503 No available compatible accounts; no wallet, ledger, cash transaction, revenue, or asset was created",
  };

  await json("/api/admin/models", {
    method: "PUT",
    body: JSON.stringify({
      model_type: "drawing",
      id: modelId,
      api_protocol_config: nextConfig,
      is_active: false,
      is_hidden: false,
    }),
  });

  const [afterList, publicCatalog, validation] = await Promise.all([
    json("/api/admin/cover-models"),
    json("/api/cover-models?surface=storyboard-workbench"),
    json(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(modelId)}`),
  ]);
  const after = afterList.models?.find((model) => model.id === modelId);
  assert.ok(after, "GPT_IMAGE2_OFFICIAL_GROUP_READBACK_MISSING");
  assert.equal(after.is_active, false);
  assert.equal(after.is_hidden, false);
  assert.equal(after.api_key_configured, true);
  assert.equal(after.api_protocol_config?.public_unavailable_reason, reason);
  assert.equal(after.api_protocol_config?.activation_failure_code, "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE");
  assert.match(String(validation.publicModelId || ""), /^pm_[A-Za-z0-9_-]+$/u, "GPT_IMAGE2_OFFICIAL_PUBLIC_ID_MISSING");
  const publicModel = publicCatalog.models?.find((model) => model.id === validation.publicModelId);
  assert.ok(publicModel, "GPT_IMAGE2_OFFICIAL_PUBLIC_ENTRY_MISSING");
  assert.equal(publicModel.capabilities?.available, false);
  assert.equal(publicModel.capabilities?.availabilityMessage, reason);

  const report = {
    appliedAt: new Date().toISOString(),
    origin,
    modelId,
    publicId: validation.publicModelId,
    visible: true,
    selectable: false,
    reason,
    credentialConfigured: true,
    secretsPersistedInReport: false,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ success: true, ...report, report: path.join(outputDir, "report.json") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "GPT_IMAGE2_OFFICIAL_STATUS_UPDATE_FAILED");
    process.exitCode = 1;
  });
}
