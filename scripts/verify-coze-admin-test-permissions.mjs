#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { parseOfficialCozeCodingEndpoint } from "../src/lib/coze-coding-endpoint-policy.mjs";

const read = (file) => fs.readFileSync(file, "utf8");
const integrationRoute = read("src/app/api/coze/test/route.ts");
const codingRoute = read("src/app/api/coze/test-coding/route.ts");
const authority = read("src/lib/server/admin-governance-authority.ts");
const adminAuth = read("src/lib/admin-auth.ts");
const endpointPolicy = read("src/lib/coze-coding-endpoint-policy.mjs");

function assertCapabilityBefore(route, capability, sensitiveMarker, label) {
  const authorizationIndex = route.indexOf(`authorizeAdminCapability(request, "${capability}"`);
  const sensitiveIndex = route.indexOf(sensitiveMarker);
  assert.ok(authorizationIndex >= 0, `${label}: missing ${capability} capability gate`);
  assert.ok(sensitiveIndex >= 0, `${label}: missing sensitive operation marker ${sensitiveMarker}`);
  assert.ok(authorizationIndex < sensitiveIndex, `${label}: ${capability} gate must run before sensitive work`);
}

assertCapabilityBefore(integrationRoute, "integrations.manage", "clearCozeConfigCache()", "coze integration test");
assert.match(
  integrationRoute,
  /authorizeAdminCapability\(request, "integrations\.manage", \{[\s\S]*?requireStepUp: true,[\s\S]*?operation: "coze_integration_connection_test"/u,
  "Coze integration test must require integrations.manage plus step-up",
);
assert.match(integrationRoute, /if \(!authorization\.ok\) return authorization\.response;/u);

assertCapabilityBefore(codingRoute, "models.manage", "await request.json()", "Coze coding test");
assertCapabilityBefore(codingRoute, "agents.manage", "await request.json()", "Coze coding test");
for (const capability of ["models.manage", "agents.manage"]) {
  assert.match(
    codingRoute,
    new RegExp(`authorizeAdminCapability\\(request, "${capability.replace(".", "\\.")}", \\{[\\s\\S]*?requireStepUp: true`, "u"),
    `Coze coding test must require ${capability} plus step-up`,
  );
}
assert.match(codingRoute, /if \(!modelAccess\.ok\) return modelAccess\.response;/u);
assert.match(codingRoute, /if \(!agentAccess\.ok\) return agentAccess\.response;/u);
assert.match(codingRoute, /parseOfficialCozeCodingEndpoint\(url\)/u);
assert.match(codingRoute, /fetch\(endpoint\.toString\(\), \{[\s\S]*?redirect: "error"/u, "Coze probe must not follow a redirect outside the approved host");
assert.doesNotMatch(codingRoute, /url\.includes\(["']coze\.(?:site|cn)["']\)/u, "substring host checks are bypassable and must not return");

assert.match(endpointPolicy, /endpoint\.protocol !== "https:"/u);
assert.match(endpointPolicy, /endpoint\.username \|\| endpoint\.password/u);
assert.match(endpointPolicy, /if \(endpoint\.port\) return null;/u);

const acceptedEndpoints = [
  "https://coze.cn/stream_run",
  "https://workflow.coze.cn/stream_run",
  "https://project.coze.site/stream_run",
  "https://PROJECT.COZE.SITE:443/stream_run?mode=test",
];
for (const candidate of acceptedEndpoints) {
  assert.ok(parseOfficialCozeCodingEndpoint(candidate) instanceof URL, `official Coze endpoint rejected: ${candidate}`);
}

const credentialBearingEndpoint = new URL("https://workflow.coze.cn/stream_run");
credentialBearingEndpoint.username = "fixture-user";
credentialBearingEndpoint.password = "fixture-password";

const rejectedEndpoints = [
  "https://coze.site.evil.example/stream_run",
  "https://evil.example/stream_run?target=coze.cn",
  "https://evilcoze.cn/stream_run",
  "http://workflow.coze.cn/stream_run",
  credentialBearingEndpoint.toString(),
  "https://workflow.coze.site:444/stream_run",
];
for (const candidate of rejectedEndpoints) {
  assert.equal(parseOfficialCozeCodingEndpoint(candidate), null, `unsafe Coze endpoint accepted: ${candidate}`);
}

for (const [label, route] of [
  ["Coze integration test", integrationRoute],
  ["Coze coding test", codingRoute],
]) {
  assert.doesNotMatch(route, /getTokenFromHeaders|verifyToken|verifyAdminToken/u, `${label}: stale JWT role checks must not authorize the route`);
  assert.doesNotMatch(route, /\.role\s*(?:===|!==)|role\s*!==\s*["']admin["']/u, `${label}: role claim must not replace capability authority`);
}

assert.match(authority, /const admin = await authorizeAdminToken\(token\);/u, "shared capability authority must revalidate the current admin account");
assert.match(authority, /const access = await readAdminAccessSnapshot\(admin\.actor\.userId\);/u, "shared capability authority must read the durable permission snapshot");
assert.match(adminAuth, /user = await dependencies\.findCurrentUser\(payload\.userId\);/u, "administrator authorization must reload the current user");
assert.match(adminAuth, /if \(user\.role !== "admin"\)/u, "administrator authorization must use the current database role");
assert.doesNotMatch(adminAuth, /if \(payload\.role !== "admin"\)/u, "administrator authorization must not trust a stale JWT role claim");
assert.match(
  authority,
  /function privilegedDenialDetails\([\s\S]*?access\.adminLevel === "super_admin" \? \{ requiredPermission: permissionKey \} : \{\}/u,
  "ordinary administrator denials must not disclose permission names",
);
assert.match(
  authority,
  /error: "当前管理员未获此项后台权限",[\s\S]*?code: "ADMIN_PERMISSION_DENIED"/u,
  "shared denial must retain the generic authorization response",
);

console.log(JSON.stringify({
  status: "PASS",
  scope: "coze-admin-test-capability-gates",
  routes: {
    "/api/coze/test": ["integrations.manage", "step-up"],
    "/api/coze/test-coding": ["models.manage", "agents.manage", "step-up"],
  },
  staleRoleClaimAuthorization: false,
  ordinaryDenialPermissionDisclosure: false,
  endpointPolicy: {
    acceptedCases: acceptedEndpoints.length,
    rejectedCases: rejectedEndpoints.length,
    httpsOnly: true,
    credentialsRejected: true,
    nonDefaultPortsRejected: true,
    redirectsFollowed: false,
  },
  providerCalls: 0,
  databaseReads: 0,
  databaseWrites: 0,
}, null, 2));
