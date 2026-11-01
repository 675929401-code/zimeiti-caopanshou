import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import * as governance from "../src/lib/admin-governance";
import * as design from "../src/lib/admin-permission-design";
import * as coverage from "../src/lib/admin-permission-catalog-coverage";
import type { AdminCapabilityResult } from "../src/lib/server/admin-governance-authority";

// Execute the real route/authority bodies with only the database and identity
// boundary replaced. No live account, authorization, network or audit writes.
let level: "super_admin" | "admin" = "admin";
let grants: string[] = [];
let roleAllowed = true;
let integrity = true;
let stepUpStatus = "ready";
let maintenance = false;
const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
let fromCalls = 0;
let catalogMode: "reject" | "old" | "new" = "reject";
let catalogReads = 0;
const database = {
  rpc: async (name: string, args?: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "read_admin_access_snapshot") return { data: {
      authority_status: "ready", integrity_valid: integrity, admin_level: level,
      permission_keys: grants, revision: 7, profile_active: true,
    }, error: null };
    if (name === "read_admin_step_up_maintenance_lock") return { data: { status: "ready", enabled: maintenance }, error: null };
    if (name === "read_admin_step_up_session") return { data: { status: stepUpStatus, auth_method: "login_password" }, error: null };
    if (name === "append_admin_governance_audit") return { data: null, error: null };
    if (name === "set_admin_access_profile_atomic") return { data: { success: true, permission_keys: args?.p_permission_keys, revision: 8 }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  },
  from: (table: string) => {
    if (table === "admin_permission_catalog" && catalogMode !== "reject") {
      catalogReads++;
      return { select: () => ({ in: (_column: string, keys: string[]) => Promise.resolve({
        error: null, data: coverage.expectedAdminPermissionCatalogRows().filter((row) => keys.includes(row.permission_key)).map((row) => ({
          ...row, is_delegable: catalogMode === "old" && row.permission_key.startsWith("prompts.") ? false : row.is_delegable,
        })),
      }) }) };
    }
    fromCalls++;
    throw new Error("Sensitive table read was not expected");
  },
};
const bindings: Record<string, unknown> = {
  "server-only": {}, "node:crypto": crypto, "next/server": { NextRequest, NextResponse },
  "@/lib/admin-governance": governance,
  "@/lib/admin-permission-design": design,
  "@/lib/admin-permission-catalog-coverage": coverage,
  "@/storage/database/supabase-client": { getSupabaseAdminClient: () => database },
  "@/lib/admin-auth": { authorizeAdminToken: async () => roleAllowed
    ? { ok: true, actor: { userId: "fixture-admin" }, user: { role: "admin" } }
    : { ok: false, error: "Forbidden", code: "ADMIN_REQUIRED", status: 403 } },
  "@/lib/auth": { getTokenFromHeaders: () => "fixture-token", hashPassword: () => { throw new Error("No password writes"); }, logPasswordAudit: () => { throw new Error("No password writes"); } },
  "@/lib/admin-password-policy": { adminPasswordError: () => null },
};
function load(relativePath: string): Record<string, unknown> {
  const output = ts.transpileModule(readFileSync(relativePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const sandboxModule = { exports: {} };
  vm.runInNewContext(output, {
    module: sandboxModule, exports: sandboxModule.exports, console,
    require: (name: string) => {
      assert.ok(Object.hasOwn(bindings, name), `Unmocked dependency ${name}`);
      return bindings[name];
    },
    fetch: () => { throw new Error("Network is forbidden in this test"); },
  }, { filename: relativePath });
  return sandboxModule.exports;
}
async function main() {
const authority = load("src/lib/server/admin-governance-authority.ts") as {
  authorizeAdminCapability: (request: NextRequest, permission: string, options?: { requireStepUp?: boolean }) => Promise<AdminCapabilityResult>;
};
bindings["@/lib/server/admin-governance-authority"] = authority;
const self = load("src/app/api/admin/access-control/self/route.ts") as { GET: (request: NextRequest) => Promise<NextResponse> };
const control = load("src/app/api/admin/access-control/route.ts") as Record<"GET" | "POST" | "PATCH", (request: NextRequest) => Promise<NextResponse>>;
const request = new NextRequest("http://localhost/api/admin/access-control/self", { headers: { "x-admin-step-up": "fixture-unlock" } });
let cases = 0;
for (const key of design.ADMIN_OWNER_GRANTED_BUSINESS_PERMISSION_KEYS) {
  grants = [];
  maintenance = true;
  let result = await authority.authorizeAdminCapability(request, key);
  assert.equal(result.ok, false, `${key}: maintenance is not a permission grant`);
  if (!result.ok) assert.equal(result.response.status, 403);
  cases++;
  grants = design.normalizeDelegableAdminPermissionKeys([key]);
  maintenance = false;
  for (const status of ["missing", "invalid", "ready"]) {
    stepUpStatus = status;
    result = await authority.authorizeAdminCapability(request, key, { requireStepUp: false });
    assert.equal(result.ok, status === "ready", `${key}: step-up cannot be omitted by a caller`);
    if (!result.ok) assert.equal(result.response.status, 428);
    cases++;
  }
  grants = [];
  result = await authority.authorizeAdminCapability(request, key);
  assert.equal(result.ok, false, `${key}: revocation takes effect on next access snapshot`);
  cases++;
}
grants = governance.ADMIN_PERMISSION_KEYS; // Simulate a polluted ordinary profile.
maintenance = true;
for (const method of ["GET", "POST", "PATCH"] as const) {
  const response = await control[method](request);
  assert.equal(response.status, 403, `${method}: ordinary admin must not read or mutate owner grants`);
  cases++;
}
assert.equal(fromCalls, 0, "denial must precede account/audit/config table reads");
for (const permission of ["admin.accounts.manage", governance.adminRequirementForRequest("/api/admin/unknown-future-route", "POST")!.permission]) {
  const result = await authority.authorizeAdminCapability(request, permission);
  assert.equal(result.ok, false, "polluted profile must not grant owner control or unknown API access");
  cases++;
}
maintenance = false;
grants = ["members.view"];
let response = await self.GET(request);
assert.equal(response.status, 200);
let body = await response.json();
assert.equal(body.catalog.length, 31);
assert.equal(body.catalog.filter((item: { granted: boolean }) => item.granted).length, 1);
assert.equal(body.tabAccess["super-admin"], true);
assert.equal(body.managementPasswordSet, false);
assert.equal(fromCalls, 0);
for (const forbidden of ["administrators", "audits", "candidates", "checksum", "password"]) assert.equal(Object.hasOwn(body, forbidden), false);
cases++;
roleAllowed = false;
response = await self.GET(request);
assert.equal(response.status, 403);
cases++;
roleAllowed = true;
integrity = false;
response = await self.GET(request);
assert.equal(response.status, 503);
cases++;
integrity = true;
level = "super_admin";
grants = governance.ADMIN_PERMISSION_KEYS;
stepUpStatus = "ready";
const owner = await authority.authorizeAdminCapability(request, "admin.accounts.manage", { requireStepUp: true });
assert.equal(owner.ok, true);
cases++;
for (const mode of ["old", "new"] as const) {
  catalogMode = mode;
  const writesBefore = rpcCalls.filter((call) => call.name === "set_admin_access_profile_atomic").length;
  const saveRequest = new NextRequest("http://localhost/api/admin/access-control", {
    method: "PATCH", headers: { "x-admin-step-up": "fixture-unlock", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "permissions", userId: "fixture-target", permissionKeys: ["prompts.edit"], expectedRevision: 7 }),
  });
  const saveResponse = await control.PATCH(saveRequest);
  assert.equal(saveResponse.status, mode === "old" ? 503 : 200);
  const writesAfter = rpcCalls.filter((call) => call.name === "set_admin_access_profile_atomic").length;
  assert.equal(writesAfter - writesBefore, mode === "old" ? 0 : 1, "old database must fail before any profile write");
  if (mode === "new") {
    const write = rpcCalls.findLast((call) => call.name === "set_admin_access_profile_atomic")!;
    assert.equal(write.args?.p_expected_revision, 7);
    assert.deepEqual(write.args?.p_permission_keys, ["agents.view", "prompts.view", "prompts.edit"]);
  }
  cases++;
}
assert.ok(rpcCalls.some((call) => call.name === "append_admin_governance_audit" && call.args?.p_reason_code === "SUPER_ADMIN_REQUIRED"));
assert.ok(rpcCalls.some((call) => call.name === "append_admin_governance_audit" && call.args?.p_reason_code === "ADMIN_STEP_UP_REQUIRED"));
const migration = readFileSync("supabase/migrations/20261016030000_owner_granted_business_permissions.sql", "utf8");
assert.doesNotMatch(migration, /UPDATE\s+public\.(admin_access_profiles|admin_step_up_sessions)/iu, "policy migration must not restore grants or unlock sessions");
assert.match(migration, /permission_key = 'admin.accounts.manage'[\s\S]*is_delegable = false/u);
console.log(JSON.stringify({ status: "PASS", runtimeCases: cases, providerCalls: 0, liveWrites: 0, sensitiveTableReads: fromCalls, catalogFixtureReads: catalogReads, pendingDatabaseMigration: true }, null, 2));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
