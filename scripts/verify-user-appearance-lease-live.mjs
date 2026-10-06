import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const TOKEN = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const RUNTIME_PATH = String(
  process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH
    || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json",
);
const IP_A = "198.51.100.41";
const IP_B = "198.51.100.42";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

assert.ok(TOKEN, "LOCAL_NAV_ADMIN_TOKEN is required");
assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(ORIGIN), "Local origin is required");

const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
const supabase = new URL(runtime.supabaseUrl);
assert.equal(runtime.localOnly, true, "The acceptance runtime must be local-only");
assert.equal(supabase.origin, "http://127.0.0.1:54321", "The acceptance database must be local");

const serviceHeaders = {
  apikey: runtime.serviceRoleKey,
  Authorization: `Bearer ${runtime.serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function requestAppearance(method, ip, body) {
  const response = await fetch(`${ORIGIN}/api/auth/me`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "X-Real-IP": ip,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function rest(pathname, options = {}) {
  const response = await fetch(new URL(pathname, supabase), {
    ...options,
    headers: { ...serviceHeaders, ...(options.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  assert.ok(response.ok, `Local REST request failed: ${response.status}`);
  return payload;
}

const identity = await requestAppearance("GET", IP_A);
assert.equal(identity.response.status, 200, "Local administrator identity must be readable");
const userId = String(identity.payload?.user?.id || "");
assert.ok(userId, "Local administrator id is required");

const query = `/rest/v1/user_appearance_preferences?user_id=eq.${encodeURIComponent(userId)}&select=user_id,theme_key,mode_preference,ip_hash,expires_at,updated_at`;
const originalRows = await rest(query);
assert.ok(Array.isArray(originalRows) && originalRows.length <= 1, "Expected at most one appearance row");
const originalPreference = originalRows[0] || null;
const originalUsers = await rest(`/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=id,theme_preference`);
assert.equal(originalUsers.length, 1, "Expected one local administrator row");
const originalLegacyTheme = originalUsers[0].theme_preference ?? null;

let report;
try {
  const savedAt = Date.now();
  const saved = await requestAppearance("PUT", IP_A, {
    theme_preference: "stellar-blue",
    theme_mode_preference: "system",
  });
  assert.equal(saved.response.status, 200, `Appearance save failed: ${JSON.stringify(saved.payload)}`);
  assert.equal(saved.payload?.appearancePreference?.theme, "stellar-blue");
  assert.equal(saved.payload?.appearancePreference?.modePreference, "system");
  const expiresAtMs = Date.parse(String(saved.payload?.appearancePreference?.expiresAt || ""));
  assert.ok(Number.isFinite(expiresAtMs), "Appearance expiry must be present");
  assert.ok(
    Math.abs(expiresAtMs - (savedAt + SEVEN_DAYS_MS)) < 30_000,
    "Appearance lease must expire seven days after saving",
  );

  const sameIP = await requestAppearance("GET", IP_A);
  assert.equal(sameIP.response.status, 200);
  assert.equal(sameIP.payload?.user?.themePreferenceStatus, "active");
  assert.equal(sameIP.payload?.user?.themePreference, "stellar-blue");
  assert.equal(sameIP.payload?.user?.themeModePreference, "system");
  assert.ok(!JSON.stringify(sameIP.payload).includes("ip_hash"), "IP fingerprint must never be returned");

  const changedIP = await requestAppearance("GET", IP_B);
  assert.equal(changedIP.response.status, 200);
  assert.equal(changedIP.payload?.user?.themePreferenceStatus, "ip_changed");
  assert.equal(changedIP.payload?.user?.themePreference, null);
  assert.equal(changedIP.payload?.user?.themeModePreference, null);
  assert.ok(!JSON.stringify(changedIP.payload).includes("ip_hash"), "IP fingerprint must never be returned");

  const sameIPAgain = await requestAppearance("GET", IP_A);
  assert.equal(sameIPAgain.payload?.user?.themePreferenceStatus, "active");

  report = {
    localOnly: true,
    origin: ORIGIN,
    saveStatus: saved.response.status,
    sameIpStatus: sameIP.payload.user.themePreferenceStatus,
    changedIpStatus: changedIP.payload.user.themePreferenceStatus,
    leaseDays: Math.round(((expiresAtMs - savedAt) / 86_400_000) * 100) / 100,
    persistedTheme: sameIP.payload.user.themePreference,
    persistedMode: sameIP.payload.user.themeModePreference,
    plaintextIpReturned: false,
    productionWrites: 0,
  };
} finally {
  if (originalPreference) {
    await rest("/rest/v1/user_appearance_preferences?on_conflict=user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(originalPreference),
    });
  } else {
    await rest(`/rest/v1/user_appearance_preferences?user_id=eq.${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
  await rest(`/rest/v1/users?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ theme_preference: originalLegacyTheme }),
  });
}

const evidenceDirectory = path.resolve(".codex-evidence", "user-appearance-lease-live-20260929");
await fs.mkdir(evidenceDirectory, { recursive: true });
await fs.writeFile(path.join(evidenceDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
