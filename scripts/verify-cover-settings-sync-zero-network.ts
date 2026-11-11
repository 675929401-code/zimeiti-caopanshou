import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as reserved from "../src/lib/server/platform-settings-reserved";

const key = "cover.style.catalog.v1";
const original = { id: "protected-row", setting_key: key, setting_value: "PRIVATE_RULE_SENTINEL", updated_at: "2026-01-01T00:00:00Z" };
let writes = 0, allowed = true, readFailed = false;
const rows = [original, { id: "ordinary-row", setting_key: "public_label", setting_value: "hello", updated_at: original.updated_at },
  { id: "secret-row", setting_key: "api_key", setting_value: "SECRET_SENTINEL", updated_at: original.updated_at },
  { id: "manju-row", setting_key: "manju.config.v1.test", setting_value: "PRIVATE_MANJU", updated_at: original.updated_at }];
const db = { from(table: string) {
  let ids: string[] | null = null;
  const query = { select: () => query, not: () => query,
    in: (_field: string, value: string[]) => { ids = value; return query; },
    eq: () => query,
    insert: () => { writes++; return query; }, update: () => { writes++; return query; },
    then(resolve: (result: unknown) => unknown) { return Promise.resolve({ data: table === "platform_settings" ? rows.filter(row => !ids || ids.includes(row.id)) : [], error: readFailed ? { code: "fixture" } : null }).then(resolve); } };
  return query;
} };
const next = { NextRequest: Request, NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
const mappings: Record<string, unknown> = {
  "next/server": next, "@/storage/database/supabase-client": { getSupabaseClient: () => db },
  "@/lib/server/platform-settings-reserved": reserved,
  "@/lib/server/platform-secret-settings": { isPlatformSecretSettingKey: (name: string) => name === "api_key" },
  "@/lib/server/platform-configuration-admin": { createPlatformConfigurationCandidate: () => { writes++; throw new Error("candidate forbidden"); }, previewPlatformConfigurationRelease: () => { throw new Error("candidate forbidden"); } },
  "@/storage/database/configuration-source": { sharedConfigurationEnabled: () => false },
  "@/lib/admin-auth": { verifyAdminToken: async () => allowed ? { role: "admin", userId: "fixture" } : null },
};
function load(file: string) {
  const container = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(compiled.outputText, { module: container, exports: container.exports, process: { env: {} }, console,
    require(id: string) { assert.ok(Object.hasOwn(mappings, id), id); return mappings[id]; } });
  return container.exports as { POST(request: Request): Promise<Response> };
}
const importRoute = load("src/app/api/admin/sync/import/route.ts"), exportRoute = load("src/app/api/admin/sync/export/route.ts");
const request = (data: unknown, authenticated = true) => new Request("http://fixture.invalid/api/admin/sync/import", {
  method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer fixture" } : {}) }, body: JSON.stringify({ data, mode: "merge" }),
});
const checks: string[] = [];
async function main() {
  const snapshot = JSON.stringify(rows);
  assert.equal((await importRoute.POST(request({}, false))).status, 401);
  allowed = false; assert.equal((await exportRoute.POST(request({}))).status, 403); allowed = true;
  checks.push("anonymous and rejected administrator cannot sync");
  for (const disguise of [{ setting_key: "ordinary_disguise" }, {}]) {
    const response = await importRoute.POST(request({ platform_settings: [{ id: original.id, setting_value: "changed", updated_at: "2099-01-01", ...disguise }] }));
    assert.ok([400, 409].includes(response.status)); assert.equal(writes, 0);
  }
  for (const protectedId of ["secret-row", "manju-row"]) {
    const response = await importRoute.POST(request({ platform_settings: [{ id: protectedId, setting_key: "ordinary_disguise", updated_at: "2099-01-01" }] }));
    assert.equal(response.status, 409); assert.equal(writes, 0);
  }
  checks.push("renamed or missing incoming key cannot overwrite protected target ID");
  assert.equal((await importRoute.POST(request({ platform_settings: [{ id: "new-id", setting_key: key, setting_value: "changed" }] }))).status, 400);
  assert.equal((await importRoute.POST(request({ platform_settings: [{ id: "ordinary-row", setting_key: "renamed", updated_at: "2099-01-01" }] }))).status, 409);
  checks.push("protected key creation and ordinary key renaming rejected before mutation");
  readFailed = true;
  assert.equal((await importRoute.POST(request({ platform_settings: [{ id: "ordinary-row", setting_key: "public_label" }] }))).status, 503);
  readFailed = false; assert.equal(writes, 0); assert.equal(JSON.stringify(rows), snapshot);
  checks.push("unavailable target lookup fails closed without candidate or business writes");
  const result = await exportRoute.POST(request({})); assert.equal(result.status, 200);
  const exported = await result.json();
  assert.deepEqual(exported.data.platform_settings.map((row: { setting_key: string }) => row.setting_key), ["public_label"]);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_RULE_SENTINEL|SECRET_SENTINEL|PRIVATE_MANJU/u);
  checks.push("generic export excludes all private reserved settings and secrets");
  console.log(JSON.stringify({ passed: true, checks, writes, networkCalls: 0, providerCalls: 0, evidence: "Actual import/export functions with isolated auth/database fixtures" }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
