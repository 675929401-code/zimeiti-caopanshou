#!/usr/bin/env node

import assert from "node:assert/strict";

const baseUrl = process.env.RELEASE_HTTP_BASE_URL || "http://127.0.0.1:5000";
const localHeader = { "x-local-workbench": "ai-creation-studio-local" };
const forbiddenKeys = new Set([
  "api_key",
  "apiKey",
  "coze_coding_api_token",
  "coze_api_token",
  "coze_coding_api_token",
  "cover_workflow_token",
  "thinking_model_api_key",
  "extract_api_token",
  "xunhu_secret",
  "epay_key",
  "restore_token",
  "email_smtp_pass",
  "password_hash",
]);

function isSensitiveSettingName(value) {
  return /(?:token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key)/iu.test(String(value || ""));
}

function findForbidden(value, path = "$") {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...findForbidden(item, `${path}[${index}]`)));
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  if (isSensitiveSettingName(value.setting_key)) findings.push(`${path}.setting_key`);
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) findings.push(`${path}.${key}`);
    findings.push(...findForbidden(item, `${path}.${key}`));
  }
  return findings;
}

async function readJson(path, token, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned a non-JSON response`);
  }
  return { response, body };
}

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: localHeader,
  signal: AbortSignal.timeout(20_000),
});
if (!sessionResponse.ok) {
  console.log(JSON.stringify({
    status: "SKIPPED",
    reason: "local-admin-dev-session-unavailable",
    httpStatus: sessionResponse.status,
    checkedRoutes: 0,
  }));
  process.exitCode = 2;
} else {
  const session = await sessionResponse.json();
  assert.ok(session.token, "local admin session did not return a token");
  assert.equal(session.user?.role, "admin", "local session is not an administrator");

  const requests = [
    ["/api/admin/models", {}],
    ["/api/admin/video-models", {}],
    ["/api/admin/chat-models", {}],
    ["/api/admin/cover-models", {}],
    ["/api/admin/agents", {}],
    ["/api/admin/config", {}],
    ["/api/admin/services", {}],
    ["/api/admin/voice-services", {}],
    ["/api/admin/voice-config", {}],
    ["/api/settings", {}],
    ["/api/settings/admin", {}],
    ["/api/admin/manju-workbench/status", {}],
    ["/api/admin/sync/export", { method: "POST", body: "{}" }],
    ["/api/admin/sync/import", {
      method: "POST",
      body: JSON.stringify({ data: {}, mode: "overwrite" }),
    }, 409],
    ["/api/admin/sync/import", {
      method: "POST",
      body: JSON.stringify({ data: { video_models: [{ id: "fixture", api_key: "synthetic" }] }, mode: "merge" }),
    }, 400],
    ["/api/admin/backup", { method: "PUT", body: JSON.stringify({ action: "download" }) }, 405],
  ];

  const results = [];
  const failures = [];
  for (const [path, init, expectedStatus = 200] of requests) {
    try {
      const { response, body } = await readJson(path, session.token, init);
      const forbidden = findForbidden(body);
      const ok = response.status === expectedStatus && forbidden.length === 0;
      if (!ok) failures.push({ path, status: response.status, protectedFields: forbidden.length });
      results.push({ path, status: response.status, protectedFields: forbidden.length });
    } catch (error) {
      failures.push({ path, status: 0, protectedFields: -1, reason: error instanceof Error ? error.message : "request-failed" });
    }
  }

  console.log(JSON.stringify({ status: failures.length === 0 ? "PASS" : "BLOCKED", checkedRoutes: results.length, failures, results }, null, 2));
  assert.equal(failures.length, 0, `${failures.length} admin HTTP secret-boundary checks failed`);
}
