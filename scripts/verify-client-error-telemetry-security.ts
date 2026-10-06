import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

interface Finding {
  scope: "scoped" | "global";
  message: string;
}

const projectRoot = process.cwd();
const findings: Finding[] = [];

function source(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), "utf8");
}

function check(scope: Finding["scope"], condition: boolean, message: string): void {
  if (!condition) findings.push({ scope, message });
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function collectSourceFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(resolve(projectRoot, directory), { withFileTypes: true })) {
    const absolutePath = join(resolve(projectRoot, directory), entry.name);
    const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      result.push(...collectSourceFiles(relativePath));
      continue;
    }
    if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) result.push(relativePath);
  }
  return result;
}

const errorBoundary = source("src/app/error.tsx");
const telemetryClient = source("src/lib/client-error-telemetry.ts");
const telemetryRoute = source("src/app/api/client-error-report/route.ts");
const internalRoute = source("src/app/api/admin/security-events/internal/route.ts");
const adminRoute = source("src/app/api/admin/security-events/route.ts");
const reliableEventContract = source("src/lib/security-event-reliability-contracts.ts");
const reliableEventService = source("src/lib/server/security-event-reliability.ts");
const reliableEventProducer = source("src/lib/server/security-event-producer.ts");
const adminGovernance = source("src/lib/admin-governance.ts");
const proxy = source("src/proxy.ts");

check("scoped", !/x-internal-key/iu.test(errorBoundary), "error.tsx must not contain an internal-key header");
check("scoped", !/\/api\/admin\//u.test(errorBoundary), "error.tsx must not call an admin API");
check("scoped", !/error[.](?:message|stack)/u.test(errorBoundary), "error.tsx must not expose an error message or stack");
check("scoped", /reportClientRenderError\(digest\)/u.test(errorBoundary), "error.tsx must use the bounded telemetry helper");

check("scoped", /const CLIENT_ERROR_ENDPOINT = "\/api\/client-error-report"/u.test(telemetryClient), "client telemetry must use a relative same-origin endpoint");
check("scoped", /credentials: "omit"/u.test(telemetryClient), "client telemetry must omit browser credentials");
check("scoped", /referrerPolicy: "no-referrer"/u.test(telemetryClient), "client telemetry must suppress the referrer");
check("scoped", /keepalive: true/u.test(telemetryClient), "client telemetry must be best-effort during page teardown");
for (const forbidden of [
  /x-internal-key/iu,
  /authorization/iu,
  /document[.]cookie/u,
  /localStorage/u,
  /sessionStorage/u,
  /navigator[.]userAgent/u,
  /error[.](?:message|stack)/u,
]) {
  check("scoped", !forbidden.test(telemetryClient), `client telemetry contains forbidden data access: ${forbidden.source}`);
}

for (const requiredPattern of [
  /sec-fetch-site/u,
  /request[.]headers[.]get\("origin"\)/u,
  /request[.]headers[.]has\("authorization"\)/u,
  /request[.]headers[.]has\("cookie"\)/u,
  /content-type/u,
  /MAX_BODY_BYTES = 512/u,
  /MAX_REPORTS_PER_WINDOW = 5/u,
  /GLOBAL_REPORTS_PER_WINDOW = 100/u,
  /MAX_RATE_BUCKETS = 1_024/u,
  /new TextEncoder\(\)[.]encode\(rawBody\)[.]byteLength/u,
  /Cache-Control": "no-store"/u,
]) {
  check("scoped", requiredPattern.test(telemetryRoute), `client telemetry route is missing ${requiredPattern.source}`);
}
check("scoped", !/getSupabaseClient|[.]from\("security_events"\)|appendFile|writeFile|\bfs\b/u.test(telemetryRoute), "anonymous telemetry must not write the authoritative security table or local files");
check("scoped", !/request[.]json\(\)/u.test(telemetryRoute), "client telemetry must enforce a byte limit before JSON parsing");

check("scoped", /getServerSecret\("SECURITY_INTERNAL_KEY"\)/u.test(internalRoute), "internal route must use the dedicated server secret");
check("scoped", !/JWT_SECRET|agent-hub-(?:internal|secret)-key-2024/u.test(internalRoute), "internal route must not reuse JWT or development fallback secrets");
check("scoped", /safeCompareSecret\(internalKey, expectedKey\)/u.test(internalRoute), "internal route must compare credentials in constant time");
check("scoped", /request[.]headers[.]has\("origin"\)/u.test(internalRoute), "internal route must reject browser-originated requests");
check("scoped", /MAX_BODY_BYTES = 16_384/u.test(internalRoute), "internal route must bound its request body");
check("scoped", /parseReliableSecurityEvent\(parsedBody\)/u.test(internalRoute), "internal route must delegate to the strict reliable-event parser");
check(
  "scoped",
  /const ALLOWED_KEYS = new Set/u.test(reliableEventContract)
    && /RELIABLE_SECURITY_EVENT_TYPES/u.test(reliableEventContract)
    && /Object[.]keys\(result\)[.]some\(\(key\) => !ALLOWED_KEYS[.]has\(key\)\)/u.test(reliableEventContract),
  "reliable-event parser must reject unknown keys and restrict event types",
);
check("scoped", /import "server-only"/u.test(reliableEventService), "reliable-event persistence must stay server-only");
check(
  "scoped",
  /const \{ data, error \} = await client[.]rpc\(name, args\)/u.test(reliableEventService)
    && /if \(error\) throw new SecurityEventReliabilityError/u.test(reliableEventService)
    && /if \(result[.]success !== true\)/u.test(reliableEventService),
  "reliable-event persistence must fail closed on RPC or rejected insert results",
);
check(
  "scoped",
  /error instanceof SecurityEventReliabilityError/u.test(internalRoute)
    && /securityEventReliabilityErrorStatus\(error\)/u.test(internalRoute),
  "internal route must convert persistence failures into bounded non-success responses",
);
check("scoped", !/error[.]message/u.test(internalRoute), "internal route must not return raw server errors");
check("scoped", /import "server-only"/u.test(reliableEventProducer), "security-event producer must stay server-only");
check(
  "scoped",
  /getServerSecret\("SECURITY_INTERNAL_KEY"\)/u.test(reliableEventProducer)
    && !/JWT_SECRET|agent-hub-(?:internal|secret)-key-2024/u.test(reliableEventProducer)
    && !/JWT_SECRET|agent-hub-(?:internal|secret)-key-2024/u.test(proxy),
  "security-event delivery must fail closed instead of reusing JWT or development fallback secrets",
);
check(
  "scoped",
  /SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS = 3/u.test(reliableEventProducer)
    && /Idempotency-Key/u.test(reliableEventProducer)
    && /lifecycle[.]waitUntil\(completion\)/u.test(reliableEventProducer)
    && /scheduleSecurityEventDelivery\(lifecycle, event\)/u.test(proxy),
  "proxy producer must use lifecycle-backed bounded idempotent retries",
);
const credentialCheckIndex = internalRoute.indexOf("safeCompareSecret(internalKey, expectedKey)");
const bodyReadIndex = internalRoute.indexOf("request.text()");
check("scoped", credentialCheckIndex >= 0 && bodyReadIndex > credentialCheckIndex, "internal credentials must be verified before the body is read");

check("scoped", !/export async function POST/u.test(adminRoute), "admin security-events API must not expose a public POST");
check("scoped", countMatches(adminRoute, /startsWith\("Bearer "\)/gu) >= 1, "admin GET must independently require Bearer authentication");
check("scoped", countMatches(adminRoute, /payload[.]role !== "admin"/gu) >= 1, "admin GET must independently require the admin role");
check(
  "scoped",
  /\^\\\/api\\\/admin\\\/\(security-events\|guard-logs\|guard-rules\|login-logs\|password-audit\)/u.test(adminGovernance)
    && /permission: write \? "security[.]manage" : "security[.]view"/u.test(adminGovernance)
    && /requireStepUp: write/u.test(adminGovernance),
  "central policy must require security permission and step-up for DELETE",
);
check(
  "scoped",
  /adminRequirementForRequest\(pathname, method, request[.]nextUrl[.]searchParams\)/u.test(proxy)
    && /authorizeAdminCapability\(/u.test(proxy),
  "proxy must enforce the central admin capability policy before admin routes",
);
check(
  "scoped",
  /export async function DELETE\(\)/u.test(adminRoute)
    && /AUDIT_EVIDENCE_RETENTION_MANAGED/u.test(adminRoute)
    && /status: 405/u.test(adminRoute)
    && !/[.]delete\(\)/u.test(adminRoute),
  "DELETE must remain non-mutating and retention-managed even after authorization",
);

const sourceFiles = collectSourceFiles("src");
const allowedInternalCallers = new Set([
  "src/app/api/admin/security-events/internal/route.ts",
  "src/lib/server/security-event-producer.ts",
]);
const allowedInternalRouteReferences = new Set([
  ...allowedInternalCallers,
  // The proxy names the route in its exact recursion-prevention whitelist,
  // while delivery and credentials live in the server-only producer module.
  "src/proxy.ts",
  // The shared policy catalog names the exact route only to exempt it from the
  // browser/admin capability gate. It has no internal credential or fetch.
  "src/lib/admin-governance.ts",
]);

for (const file of sourceFiles) {
  const value = source(file);
  if (value.includes("agent-hub-internal-2024")) {
    findings.push({ scope: "global", message: `${file} still contains the exposed client secret literal` });
  }
  if (/x-internal-key/iu.test(value) && !allowedInternalCallers.has(file)) {
    findings.push({ scope: "global", message: `${file} uses x-internal-key outside the server-only allowlist` });
  }
  if (value.includes("/api/admin/security-events/internal") && !allowedInternalRouteReferences.has(file)) {
    findings.push({ scope: "global", message: `${file} calls the internal admin writer outside the server-only allowlist` });
  }

  if (/^\s*["']use client["'];/mu.test(value)) {
    for (const forbidden of [/x-internal-key/iu, /\/api\/admin\/security-events\/internal/u, /SECURITY_INTERNAL_KEY/u, /JWT_SECRET/u]) {
      if (forbidden.test(value)) {
        findings.push({ scope: "global", message: `${file} is a client module containing ${forbidden.source}` });
      }
    }
  }
}

check(
  "global",
  !/x-internal-key|fetch\(/iu.test(adminGovernance),
  "the shared admin policy may reference the internal route but must not carry credentials or call it",
);

const scopedFindings = findings.filter((finding) => finding.scope === "scoped");
const globalFindings = findings.filter((finding) => finding.scope === "global");

if (scopedFindings.length === 0) {
  console.log("PASS scoped client error telemetry and admin/internal authorization contract");
} else {
  console.error(`FAIL scoped contract: ${scopedFindings.length} finding(s)`);
  for (const finding of scopedFindings) console.error(`- ${finding.message}`);
}

if (globalFindings.length === 0) {
  console.log("PASS global client/internal-key separation gate");
} else {
  console.error(`FAIL global client/internal-key separation gate: ${globalFindings.length} finding(s)`);
  for (const finding of globalFindings) console.error(`- ${finding.message}`);
}

if (findings.length > 0) process.exitCode = 1;
