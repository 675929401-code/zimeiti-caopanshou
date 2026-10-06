import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath: string) => readFileSync(resolve(relativePath), "utf8");

function handler(source: string, method: "GET" | "POST" | "PUT" | "DELETE") {
  const start = source.indexOf(`export async function ${method}`);
  assert.notEqual(start, -1, `${method} handler must exist`);
  const candidates = ["GET", "POST", "PUT", "DELETE"]
    .map((name) => source.indexOf(`export async function ${name}`, start + 1))
    .filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function assertConcealed(source: string, label: string) {
  assert.doesNotMatch(source, /requiredPermission/u, `${label} must not serialize permission names`);
}

const stats = read("src/app/api/stats/route.ts");
assert.match(stats, /const isAdminRequest = request\.nextUrl\.searchParams\.get\("admin"\) === "true"/u);
assert.match(stats, /\["billing\.view", "platform_statistics_billing_read"\]/u);
assert.match(stats, /\["members\.view", "platform_statistics_members_read"\]/u);
assert.match(stats, /if \(isAdminRequest\) \{[\s\S]*authorizeAdminCapability\(request, permission/u);
assertConcealed(stats, "platform stats");

const storage = read("src/app/api/storage/status/route.ts");
assert.match(storage, /authorizeAdminCapability\(request, "backups\.manage"/u);
assert.match(handler(storage, "GET"), /authorizeStorageManagement\(request, "storage_status_read", false\)/u);
assert.match(handler(storage, "POST"), /authorizeStorageManagement\(request, "storage_configuration_reload", true\)/u);
assert.match(handler(storage, "DELETE"), /authorizeStorageManagement\(request, "storage_object_delete", true\)/u);
assert.doesNotMatch(storage, /verifyToken|authorizeAdminToken/u);
assertConcealed(storage, "storage management");

const storyboardAgent = read("src/app/api/storyboard/agent/route.ts");
assert.match(handler(storyboardAgent, "GET"), /authorizeAdminCapability\(request, "prompts\.view", \{[\s\S]*requireStepUp: true/u);
assert.match(handler(storyboardAgent, "PUT"), /authorizeAdminCapability\(request, "prompts\.edit", \{[\s\S]*requireStepUp: true/u);
assert.doesNotMatch(storyboardAgent, /verifyToken|authorizeAdminToken/u);
assertConcealed(storyboardAgent, "storyboard prompt source");

const help = read("src/app/api/help/route.ts");
assert.match(handler(help, "GET"), /if \(previewSlug\) \{[\s\S]*authorizeAdminCapability\(request, "platform\.settings\.manage"/u);
assert.match(help, /else \{\s*viewer = await getViewer\(request\);\s*\}/u, "public help flow must remain independent");
assertConcealed(help, "help preview");

const announcements = read("src/app/api/announcements/route.ts");
assert.match(handler(announcements, "GET"), /if \(adminMode\) \{[\s\S]*authorizeAdminCapability\(request, "announcements\.manage"/u);
assert.match(handler(announcements, "GET"), /else \{\s*viewer = await getViewer\(request\);\s*\}/u, "public announcement delivery must remain independent");
assertConcealed(announcements, "announcement administration");

const conversations = read("src/app/api/conversations/route.ts");
assert.match(handler(conversations, "GET"), /authorizeAdminCapability\(request, "agents\.view", \{[\s\S]*requireStepUp: false/u);
assert.match(handler(conversations, "POST"), /authorizeAdminCapability\(request, "agents\.manage", \{[\s\S]*requireStepUp: true/u);
assert.doesNotMatch(conversations, /verifyToken|authorizeAdminToken|user\.role/u);
assertConcealed(conversations, "raw conversation administration");

const runtimeCatalog = read("src/app/api/tools/runtime-catalog/route.ts");
assert.match(runtimeCatalog, /if \(user\.role === "admin"\) \{[\s\S]*authorizeAdminCapability\(request, "models\.view"/u);
assert.match(runtimeCatalog, /canViewInternalModelMetadata = authorization\.ok/u);
assert.match(runtimeCatalog, /publicQuote\(sharedQuote, "视频提取", canViewInternalModelMetadata\)/u);
assertConcealed(runtimeCatalog, "runtime model metadata");

const bots = read("src/app/api/bots/route.ts");
assert.match(bots, /if \(payload\.role === "admin"\) \{[\s\S]*authorizeAdminCapability\(request, "internal_tools\.manage"[\s\S]*requireStepUp: true[\s\S]*isAdmin = authorization\.ok/u);
assert.match(bots, /category\.visibility === "private" \|\| category\.name\.trim\(\) === "自用"/u);
assert.match(bots, /if \(!isAdmin && agent\.user_access === "hidden"\) return false/u);
assertConcealed(bots, "hidden agent catalog");

const categories = read("src/app/api/categories/route.ts");
assert.match(categories, /if \(payload\.role === "admin"\) \{[\s\S]*authorizeAdminCapability\(request, "internal_tools\.manage"[\s\S]*requireStepUp: true[\s\S]*isAdmin = authorization\.ok/u);
assert.match(categories, /if \(!isAdmin && \(category\.visibility === "private" \|\| category\.name\.trim\(\) === "自用"\)\) return false/u);
assertConcealed(categories, "private agent categories");

console.log(JSON.stringify({
  ok: true,
  explicitAdminDenials: [
    "/api/stats?admin=true",
    "/api/storage/status",
    "/api/storyboard/agent",
    "/api/help?preview=...",
    "/api/announcements?admin=1",
    "/api/conversations",
  ],
  concealedOptionalMetadata: [
    "/api/tools/runtime-catalog",
    "/api/bots",
    "/api/categories",
  ],
}, null, 2));
