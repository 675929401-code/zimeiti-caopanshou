#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const password = String(process.env.LOCAL_ADMIN_STEP_UP_PASSWORD || "");
const confirmed = process.argv.includes("--confirm-local-soft-white-theme");
const STEP_UP_COOKIE = "zimeiti_admin_step_up";

assert.match(origin, /^http:\/\/127\.0\.0\.1(?::(?:5000|5002|5010))?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(confirmed, "CONFIRM_LOCAL_SOFT_WHITE_THEME_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
assert.ok(password, "LOCAL_ADMIN_STEP_UP_PASSWORD_REQUIRED");

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
let unlocked = false;
let stepUpToken = "";

async function json(response) {
  return response.json().catch(() => ({}));
}

function cookieValue(setCookie, cookieName) {
  const match = String(setCookie || "").match(new RegExp(`(?:^|,\\s*)${cookieName}=([^;]+)`, "u"));
  return match?.[1] || "";
}

function readStepUpToken(responseHeaders) {
  const setCookies = typeof responseHeaders.getSetCookie === "function"
    ? responseHeaders.getSetCookie()
    : [responseHeaders.get("set-cookie") || ""];
  for (const setCookie of setCookies) {
    const value = cookieValue(setCookie, STEP_UP_COOKIE);
    if (value) return value;
  }
  return "";
}

try {
  const identityResponse = await fetch(`${origin}/api/auth/me`, { headers, cache: "no-store" });
  const identity = await json(identityResponse);
  assert.ok(identityResponse.ok && identity?.user?.role === "admin", "LOCAL_ADMIN_ROLE_REQUIRED");

  const unlockResponse = await fetch(`${origin}/api/admin/access-control/unlock`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password, mode: "auto" }),
  });
  const unlock = await json(unlockResponse);
  assert.ok(unlockResponse.ok, String(unlock.error || "LOCAL_ADMIN_STEP_UP_FAILED"));
  stepUpToken = readStepUpToken(unlockResponse.headers);
  assert.ok(stepUpToken, "LOCAL_ADMIN_STEP_UP_COOKIE_REQUIRED");
  unlocked = true;

  const publishResponse = await fetch(`${origin}/api/settings/admin?scope=brand`, {
    method: "POST",
    headers: { ...headers, "x-admin-step-up": stepUpToken, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ theme: "soft-white", theme_mode: "light" }),
  });
  const publish = await json(publishResponse);
  assert.ok(publishResponse.ok, String(publish.error || "LOCAL_THEME_PUBLISH_FAILED"));
  assert.deepEqual(publish.settings, { theme: "soft-white", theme_mode: "light" }, "LOCAL_THEME_WRITE_RECEIPT_MISMATCH");

  const appearanceResponse = await fetch(`${origin}/api/settings/appearance?verify=${encodeURIComponent(publish.publishedAt || "")}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });
  const appearance = await json(appearanceResponse);
  assert.ok(appearanceResponse.ok, "LOCAL_APPEARANCE_READ_FAILED");
  assert.equal(appearance.authority?.authoritative, true, "LOCAL_APPEARANCE_NOT_AUTHORITATIVE");
  assert.equal(appearance.settings?.theme, "soft-white", "LOCAL_PUBLIC_THEME_MISMATCH");
  assert.equal(appearance.settings?.theme_mode, "light", "LOCAL_PUBLIC_THEME_MODE_MISMATCH");

  console.log(JSON.stringify({
    status: "PASS",
    origin,
    theme: appearance.settings.theme,
    themeMode: appearance.settings.theme_mode,
    publishedAt: appearance.authority.publishedAt,
    auditedApiWrite: true,
    directDatabaseWrites: 0,
    deploymentWrites: 0,
  }, null, 2));
} finally {
  if (unlocked) {
    await fetch(`${origin}/api/admin/access-control/unlock`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUpToken },
    }).catch(() => undefined);
  }
}
