#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const route = fs.readFileSync(path.resolve(root, "src/app/api/health/route.ts"), "utf8");

assert.match(
  route,
  /import \{ authorizeAdminCapability \} from ['"]@\/lib\/server\/admin-governance-authority['"]/u,
  "health route must use the centralized admin capability gate",
);
assert.match(
  route,
  /const isInternal = isAuthorizedInternalHealthRequest\(req[.]headers\)/u,
  "health route must preserve the dedicated internal scheduler credential check",
);

const fixStart = route.indexOf("if (action === 'fix')");
const nextActionStart = route.indexOf("if (action === 'log')", fixStart);
assert.ok(fixStart >= 0 && nextActionStart > fixStart, "health fix action block must exist");

const fixBlock = route.slice(fixStart, nextActionStart);
assert.match(
  fixBlock,
  /if \(!isInternal\) \{[\s\S]*authorizeAdminCapability\(req, ['"]security[.]manage['"], \{[\s\S]*requireStepUp: true[\s\S]*\}\);[\s\S]*if \(!authorization[.]ok\) return authorization[.]response;/u,
  "non-internal health fixes must require security.manage and step-up",
);
assert.match(
  fixBlock,
  /operation: ['"]health_manual_fix['"]/u,
  "health fix authorization must use a dedicated audit operation",
);

const gateIndex = fixBlock.indexOf("authorizeAdminCapability");
const diagnosticIndex = fixBlock.indexOf("runHealthChecks()");
const writeIndex = fixBlock.indexOf("autoFix(checks, { allowSafeWrites: true })");
assert.ok(gateIndex >= 0, "health fix authorization gate must be present");
assert.ok(diagnosticIndex > gateIndex, "external authorization must run before fix diagnostics");
assert.ok(writeIndex > gateIndex, "external authorization must run before any safe-write repair");

console.log(JSON.stringify({
  passed: true,
  checks: [
    "centralized-capability-gate",
    "internal-scheduler-credential-preserved",
    "security.manage-required",
    "step-up-required",
    "dedicated-audit-operation",
    "gate-before-diagnostics",
    "gate-before-write",
  ],
}, null, 2));
