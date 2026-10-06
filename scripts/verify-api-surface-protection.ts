import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import {
  checkRateLimit,
  getClientIP,
  getSecurityHeadersForHost,
  MAX_IP_SECURITY_RECORDS,
  MAX_RATE_LIMIT_BUCKETS,
  normalizeRateLimitPath,
  trackIPSecurityEvent,
  validateBrowserWriteSource,
} from "../src/lib/security-edge";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

assert.equal(normalizeRateLimitPath("POST", "/api/image/generate"), "/api/image/generate");
assert.equal(normalizeRateLimitPath("POST", "/api/video/tasks/one"), "/api/video");
assert.equal(normalizeRateLimitPath("DELETE", "/api/admin/users/user-a"), "/api/admin");

const rotatingPathIp = "198.51.100.240";
for (let index = 0; index < 60; index += 1) {
  assert.equal(
    checkRateLimit(rotatingPathIp, "POST", `/api/video/task-${index}`).allowed,
    true,
    `dynamic path ${index} should use the shared family allowance`,
  );
}
assert.equal(
  checkRateLimit(rotatingPathIp, "POST", "/api/video/task-over-limit").allowed,
  false,
  "rotating dynamic paths must not reset the API-family limit",
);

const firstBoundedIdentity = "203.0.113.1";
assert.equal(checkRateLimit(firstBoundedIdentity, "PATCH", "/api/bounded/item").allowed, true);
for (let index = 0; index < MAX_RATE_LIMIT_BUCKETS + 5; index += 1) {
  checkRateLimit(`bounded-fixture-${index}`, "PATCH", "/api/bounded/item");
}
for (let index = 0; index < 60; index += 1) {
  assert.equal(
    checkRateLimit(firstBoundedIdentity, "PATCH", "/api/bounded/item").allowed,
    true,
    "the oldest bucket must be evicted once the fixed capacity is reached",
  );
}
assert.equal(
  checkRateLimit(firstBoundedIdentity, "PATCH", "/api/bounded/item").allowed,
  false,
  "a recreated bucket must still enforce the normal route-family allowance",
);

const firstSecurityIdentity = "198.51.100.2";
assert.equal(trackIPSecurityEvent(firstSecurityIdentity, "high").banned, false);
for (let index = 0; index < MAX_IP_SECURITY_RECORDS + 5; index += 1) {
  trackIPSecurityEvent(`security-fixture-${index}`, "low");
}
for (let index = 0; index < 4; index += 1) {
  assert.equal(
    trackIPSecurityEvent(firstSecurityIdentity, "high").banned,
    false,
    "the oldest inactive security record must be evicted at fixed capacity",
  );
}
assert.equal(
  trackIPSecurityEvent(firstSecurityIdentity, "high").banned,
  true,
  "a recreated security record must still enforce the normal high-risk threshold",
);

const previousTrustedCf = process.env.TRUST_CF_CONNECTING_IP;
delete process.env.TRUST_CF_CONNECTING_IP;
assert.equal(getClientIP(new Request("https://zyuani8.com/api/version", { headers: {
  "x-real-ip": "203.0.113.9",
  "cf-connecting-ip": "198.51.100.222",
  "x-forwarded-for": "198.51.100.111, 203.0.113.9",
} })), "203.0.113.9", "untrusted CF headers must not override the proxy-observed peer");
assert.equal(getClientIP(new Request("https://zyuani8.com/api/version", { headers: {
  "x-forwarded-for": "198.51.100.111, 10.0.0.8",
} })), "10.0.0.8", "the rightmost proxy-chain value wins instead of a client-supplied public value");
assert.equal(getClientIP(new Request("https://zyuani8.com/api/version", { headers: {
  "x-real-ip": "not-an-ip",
  "x-forwarded-for": "also-invalid, ::::::::",
} })), "unknown", "invalid identity headers cannot create attacker-controlled limiter keys");
assert.equal(getClientIP(new Request("https://zyuani8.com/api/version", { headers: {
  "x-real-ip": "2001:0DB8:0:0:0:0:0:1",
} })), "2001:db8::1", "IPv6 identity keys must be canonicalized");
process.env.TRUST_CF_CONNECTING_IP = "1";
assert.equal(getClientIP(new Request("https://zyuani8.com/api/version", { headers: {
  "x-real-ip": "203.0.113.9",
  "cf-connecting-ip": "198.51.100.222",
} })), "198.51.100.222", "Cloudflare identity is used only after an explicit trust opt-in");
if (previousTrustedCf === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
else process.env.TRUST_CF_CONNECTING_IP = previousTrustedCf;

const sameOrigin = validateBrowserWriteSource("POST", headers({
  host: "zyuani8.com",
  origin: "https://zyuani8.com",
  "sec-fetch-site": "same-origin",
  "user-agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
}));
assert.deepEqual(sameOrigin, { allowed: true, browserRequest: true });

const sameHostReferer = validateBrowserWriteSource("PATCH", headers({
  host: "zyuani8.com",
  referer: "https://zyuani8.com/admin?tab=theme",
  "user-agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
}));
assert.deepEqual(sameHostReferer, { allowed: true, browserRequest: true });

assert.equal(validateBrowserWriteSource("POST", headers({
  host: "zyuani8.com",
  origin: "https://attacker.example",
  "sec-fetch-site": "cross-site",
  "user-agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
})).allowed, false);

assert.equal(validateBrowserWriteSource("DELETE", headers({
  host: "zyuani8.com",
  "x-forwarded-host": "other.coze.site",
  origin: "https://other.coze.site",
  "user-agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
})).allowed, false, "a broad sibling subdomain is not a trusted browser source");

assert.equal(validateBrowserWriteSource("POST", headers({
  host: "zyuani8.com",
  "sec-fetch-site": "same-origin",
  "user-agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
})).allowed, false, "browser writes without Origin or Referer must fail closed");
assert.equal(validateBrowserWriteSource("POST", headers({
  host: "zyuani8.com",
  cookie: "auth_token=fixture",
})).allowed, false, "cookie-authenticated writes cannot omit browser source evidence");

assert.deepEqual(validateBrowserWriteSource("POST", headers({
  host: "127.0.0.1:5000",
  "user-agent": "undici",
})), { allowed: true, browserRequest: false }, "server callers continue to route-level key/signature checks");

const apiHeaders = getSecurityHeadersForHost("zyuani8.com", "/api/video/history");
assert.match(apiHeaders["X-Robots-Tag"], /noindex/u);
assert.equal(apiHeaders["Cache-Control"], undefined);
const adminHeaders = getSecurityHeadersForHost("zyuani8.com", "/admin");
assert.match(adminHeaders["X-Robots-Tag"], /noarchive/u);
assert.equal(adminHeaders["Cache-Control"], "private, no-store, max-age=0");
assert.equal(getSecurityHeadersForHost("zyuani8.com", "/")["X-Robots-Tag"], undefined);

const proxySource = readFileSync(resolve(process.cwd(), "src/proxy.ts"), "utf8");
assert.match(proxySource, /validateBrowserWriteSource\(method, request\.headers\)/u);
assert.doesNotMatch(proxySource, /originHost\.endsWith\("\.coze\.site"\)/u);
assert.match(proxySource, /EXACT_WHITELIST_PATHS\.includes\(pathname\)/u);
assert.doesNotMatch(proxySource, /WHITELIST_PATHS\.some\(\(p\) => pathname\.startsWith\(p\)\)/u);
const robotsSource = readFileSync(resolve(process.cwd(), "src/app/robots.ts"), "utf8");
for (const path of ["/api/", "/admin/", "/media-history", "/storyboard-workbench"]) {
  assert.ok(robotsSource.includes(`'${path}'`), `robots policy must cover ${path}`);
}
const nginxSource = readFileSync(resolve(process.cwd(), "deploy/nginx/agent-hub.vnext.conf.example"), "utf8");
assert.match(nginxSource, /server_tokens off;/u);
assert.match(nginxSource, /POST:\/api\/payment\/create\$/u);
assert.match(nginxSource, /POST:\/api\/payment\/refund\$/u);
assert.match(nginxSource, /api\/\(chat\|llm\|extract\|image\|video\|cover/u);
assert.doesNotMatch(nginxSource, /\$proxy_add_x_forwarded_for/u);
assert.match(nginxSource, /proxy_set_header CF-Connecting-IP "";/u);

const browserUserAgent = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36";

async function verifyAllowedProxyFlows(): Promise<void> {
  const paymentCallback = await proxy(new NextRequest("https://zyuani8.com/api/payment/notify", {
    method: "POST",
    headers: {
      host: "zyuani8.com",
      origin: "https://payment-provider.example",
      "user-agent": "payment-provider/1.0",
    },
  }));
  assert.equal(paymentCallback.headers.get("x-middleware-next"), "1", "signed payment callbacks must reach their route verifier");

  const internalWrite = await proxy(new NextRequest("https://zyuani8.com/api/settings/admin", {
    method: "POST",
    headers: {
      host: "zyuani8.com",
      "user-agent": "undici",
      "x-internal-key": "route-verifies-this-fixture",
    },
  }));
  assert.equal(internalWrite.headers.get("x-middleware-next"), "1", "server writes without browser metadata must reach route-level authorization");

  const browserWrite = await proxy(new NextRequest("https://zyuani8.com/api/settings/ui-preferences", {
    method: "PUT",
    headers: {
      host: "zyuani8.com",
      origin: "https://zyuani8.com",
      "sec-fetch-site": "same-origin",
      "user-agent": browserUserAgent,
    },
  }));
  const browserWriteBody = await browserWrite.json() as { code?: string };
  assert.equal(browserWrite.status, 401, "same-origin browser writes must pass source validation and reach authorization");
  assert.equal(browserWriteBody.code, "AUTH_REQUIRED", "anonymous same-origin writes must be rejected by the capability gate, not browser-source validation");

  for (const path of [
    "/api/video/stream?taskId=fixture&modelId=fixture",
    "/api/video/proxy-download?taskId=fixture&media_ticket=fixture",
  ]) {
    const mediaRead = await proxy(new NextRequest(`https://zyuani8.com${path}`, {
      method: "GET",
      headers: { host: "zyuani8.com", "user-agent": browserUserAgent },
    }));
    assert.equal(mediaRead.headers.get("x-middleware-next"), "1", `${path} must reach its owner/ticket verifier`);
    assert.equal(mediaRead.headers.get("X-Accel-Buffering"), "no", `${path} must remain unbuffered`);
  }
}

void verifyAllowedProxyFlows().then(() => {
  console.log("PASS dynamic paths share bounded API-family rate-limit buckets");
  console.log("PASS limiter identity storage is bounded and proxy identity headers fail closed");
  console.log("PASS browser writes require exact same-host Origin/Referer");
  console.log("PASS same-origin browser writes pass source validation and reach the admin capability gate");
  console.log("PASS payment callbacks and internal server writes reach route-level verification");
  console.log("PASS SSE and authenticated media reads remain unbuffered and reachable");
  console.log("PASS private surfaces emit noindex/noarchive while the public landing page remains indexable");
  console.log("PASS Nginx hides its version and rate-limits paid API families before Next.js");
  process.exit(0);
}).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
