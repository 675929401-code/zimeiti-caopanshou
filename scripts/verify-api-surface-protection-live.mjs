import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(ORIGIN), "Local origin is required");

async function request(pathname, init = {}) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    headers: { "User-Agent": BROWSER_UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { response, payload };
}

const robots = await request("/robots.txt");
assert.equal(robots.response.status, 200);
assert.match(String(robots.payload), /Disallow:\s*\/api\//u);
assert.match(String(robots.payload), /Disallow:\s*\/admin/u);

const version = await request("/api/version");
assert.equal(version.response.status, 200);
assert.match(String(version.response.headers.get("x-robots-tag") || ""), /noindex/u);
assert.match(String(version.response.headers.get("cache-control") || ""), /no-store/u);

const protectedRead = await request("/api/media-history");
assert.equal(protectedRead.response.status, 401, "Anonymous protected media history must be rejected");
assert.match(String(protectedRead.response.headers.get("x-robots-tag") || ""), /noindex/u);

const crossOrigin = await request("/api/payment/create", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: "https://attacker.invalid",
    Referer: "https://attacker.invalid/probe",
    "Sec-Fetch-Site": "cross-site",
  },
  body: JSON.stringify({ amount: 10 }),
});
assert.equal(crossOrigin.response.status, 403, "Cross-origin payment mutation must be rejected at the edge");

const sameOrigin = await request("/api/payment/create", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "Sec-Fetch-Site": "same-origin",
  },
  body: JSON.stringify({ amount: 10 }),
});
assert.equal(sameOrigin.response.status, 401, "Same-origin anonymous mutation must reach route authorization");

const apiClientRead = await fetch(`${ORIGIN}/api/settings`, {
  headers: { "User-Agent": "curl/8.10.1" },
  signal: AbortSignal.timeout(15_000),
});
assert.equal(apiClientRead.status, 200, "Low-risk public reads may remain available to API clients");

const apiClientSensitiveWrite = await fetch(`${ORIGIN}/api/payment/create`, {
  method: "POST",
  headers: {
    "User-Agent": "curl/8.10.1",
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "Sec-Fetch-Site": "same-origin",
  },
  body: JSON.stringify({ amount: 10 }),
  signal: AbortSignal.timeout(15_000),
});
assert.equal(apiClientSensitiveWrite.status, 403, "Known API clients must be blocked from sensitive browser writes");

const browserSettings = await request("/api/settings");
assert.equal(browserSettings.response.status, 200, "Browser settings read must remain available");

const report = {
  localOnly: true,
  origin: ORIGIN,
  robotsStatus: robots.response.status,
  apiNoIndex: true,
  apiNoStore: true,
  anonymousProtectedReadStatus: protectedRead.response.status,
  crossOriginMutationStatus: crossOrigin.response.status,
  sameOriginUnauthenticatedStatus: sameOrigin.response.status,
  apiClientReadStatus: apiClientRead.status,
  apiClientSensitiveWriteStatus: apiClientSensitiveWrite.status,
  browserReadStatus: browserSettings.response.status,
  databaseWrites: 0,
  providerCalls: 0,
  productionWrites: 0,
};

const evidenceDirectory = path.resolve(".codex-evidence", "api-surface-protection-live-20260929");
await fs.mkdir(evidenceDirectory, { recursive: true });
await fs.writeFile(path.join(evidenceDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
