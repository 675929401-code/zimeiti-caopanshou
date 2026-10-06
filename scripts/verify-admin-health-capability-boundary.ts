import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const route = readFileSync(resolve("src/app/api/health/route.ts"), "utf8");

const getStart = route.indexOf("export async function GET(req: NextRequest)");
const postStart = route.indexOf("export async function POST(req: NextRequest)");
assert.notEqual(getStart, -1, "health GET handler must exist");
assert.notEqual(postStart, -1, "health POST handler must exist");

const getHandler = route.slice(getStart, postStart);
const postHandler = route.slice(postStart);

const livenessIndex = getHandler.indexOf("const isLivenessProbe");
const internalIndex = getHandler.indexOf("const isInternal = isAuthorizedInternalHealthRequest(req.headers)");
const readCapabilityIndex = getHandler.indexOf("authorizeAdminCapability(req, 'logs.view'");
const firstProtectedReadIndex = Math.min(
  ...[getHandler.indexOf(".from('system_logs')"), getHandler.indexOf("runHealthChecks()")]
    .filter((index) => index >= 0),
);

assert.ok(livenessIndex >= 0, "public liveness branch must remain explicit");
assert.ok(internalIndex > livenessIndex, "internal health authorization must run after public liveness");
assert.ok(readCapabilityIndex > internalIndex, "administrator health data must require a capability after internal bypass");
assert.ok(firstProtectedReadIndex > readCapabilityIndex, "health/log evidence must not be read before logs.view authorization");
assert.match(
  getHandler,
  /if \(!isInternal\) \{[\s\S]*?authorizeAdminCapability\(req, 'logs\.view', \{[\s\S]*?requireStepUp: false,[\s\S]*?\}\);[\s\S]*?concealedHealthDetailsDenial\(authorization\.response\)/u,
  "non-internal GET must require logs.view and use a concealed denial",
);
assert.match(getHandler, /\? 'system_logs_read'\s*: 'system_health_read'/u);
assert.doesNotMatch(getHandler, /authorizeAdminToken|verifyToken/u, "GET must not retain role-only authorization");

const postBodyIndex = postHandler.indexOf("const body = await req.json()");
const postCapabilityIndex = postHandler.indexOf("authorizeAdminCapability(req, 'logs.view'");
assert.ok(postCapabilityIndex >= 0, "non-internal diagnostic POST must require logs.view");
assert.ok(postCapabilityIndex < postBodyIndex, "POST authorization must happen before parsing or executing an action");
assert.match(
  postHandler,
  /if \(!isInternal\) \{[\s\S]*?authorizeAdminCapability\(req, 'logs\.view', \{[\s\S]*?operation: 'system_health_diagnose',[\s\S]*?requireStepUp: false,[\s\S]*?concealedHealthDetailsDenial\(authorization\.response\)/u,
  "diagnostic details must use the same concealed logs.view boundary",
);
assert.match(
  postHandler,
  /if \(action === 'fix'\) \{[\s\S]*?authorizeAdminCapability\(req, 'security\.manage', \{[\s\S]*?operation: 'health_manual_fix',[\s\S]*?requireStepUp: true,/u,
  "manual repair must retain security.manage step-up",
);
assert.match(
  postHandler,
  /if \(action === 'log'\) \{[\s\S]*?authorizeAdminCapability\(req, 'security\.manage', \{[\s\S]*?operation: 'system_log_create',[\s\S]*?requireStepUp: true,/u,
  "manual system-log creation must require security.manage step-up",
);
assert.doesNotMatch(postHandler, /authorizeAdminToken|verifyToken/u, "POST must not retain role-only authorization");

const concealmentStart = route.indexOf("function concealedHealthDetailsDenial");
assert.notEqual(concealmentStart, -1, "health denial concealment helper must exist");
const concealmentEnd = route.indexOf("// Lazy init", concealmentStart);
const concealment = route.slice(concealmentStart, concealmentEnd);
assert.match(concealment, /response\.status === 403/u);
assert.match(concealment, /code: 'ADMIN_PERMISSION_DENIED'/u);
assert.doesNotMatch(concealment, /requiredPermission|permissionKey/u, "health denial must not disclose permission names");
assert.doesNotMatch(route, /requiredPermission/u, "health route must not disclose raw permission keys");

console.log(JSON.stringify({
  ok: true,
  publicProbe: "liveness",
  internalProbe: "x-internal-health-check",
  readPermission: "logs.view",
  sensitiveWrites: ["health_manual_fix", "system_log_create"],
  denialCode: "ADMIN_PERMISSION_DENIED",
}, null, 2));
