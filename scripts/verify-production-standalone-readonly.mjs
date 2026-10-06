import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5010").replace(/\/$/u, "");
assert.equal(origin, "http://127.0.0.1:5010", "LOCAL_STANDALONE_ORIGIN_REQUIRED");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.ok(token, "NORMAL_LOCAL_ADMIN_SESSION_REQUIRED");

const meResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
let meBody = {};
try { meBody = await meResponse.json(); } catch { /* status is recorded below */ }
const currentUserId = String(meBody?.user?.id || meBody?.data?.id || meBody?.id || "");
const endpoints = [
  currentUserId ? `/api/credits?user_id=${encodeURIComponent(currentUserId)}` : "/api/credits?user_id=[missing]",
  "/api/video/history",
  "/api/cover-models",
  "/api/storyboard/projects",
  "/api/digital-human/long-history",
  "/api/digital-human/voices",
  "/api/image-workbench/history",
  "/api/extract/history",
  "/api/cover/history",
  "/api/media-history",
];
const results = [{ endpoint: "/api/auth/me", status: meResponse.status, code: String(meBody?.code || meBody?.error?.code || "") }];
for (const endpoint of endpoints) {
  try {
    const response = await fetch(`${origin}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    let code = "";
    try {
      const body = await response.clone().json();
      code = String(body?.code || body?.error?.code || "");
    } catch { /* response status is sufficient */ }
    results.push({ endpoint: endpoint.startsWith("/api/credits?") ? "/api/credits?user_id=[current]" : endpoint, status: response.status, code });
  } catch (error) {
    results.push({ endpoint: endpoint.startsWith("/api/credits?") ? "/api/credits?user_id=[current]" : endpoint, status: 0, code: error instanceof Error ? error.name : "FETCH_FAILED" });
  }
}

const report = {
  schema: "production-standalone-readonly.v1",
  observedAt: new Date().toISOString(),
  origin,
  authenticated: results.find((item) => item.endpoint === "/api/auth/me")?.status === 200,
  reads: results,
  writeRequests: 0,
  providerRequests: 0,
  pass: results.every((item) => item.status >= 200 && item.status < 300),
};
const out = path.resolve(".codex-evidence/production-standalone-rehearsal-20260904/fixed-runtime-readonly.json");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
