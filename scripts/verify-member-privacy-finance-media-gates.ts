import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import path from "node:path";
import { memberContentAccessDecision } from "../src/lib/member-content-access";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

assert.equal(
  memberContentAccessDecision({ userId: "member-a", role: "student" }, "member-a"),
  "owner",
  "ordinary members must retain access to their own media",
);
assert.equal(
  memberContentAccessDecision({ userId: "admin-a", role: "admin" }, "admin-a"),
  "owner",
  "an administrator must retain the ordinary owner path for their own media",
);
assert.equal(
  memberContentAccessDecision({ userId: "member-a", role: "student" }, "member-b"),
  "denied",
  "ordinary members must not gain cross-member media access",
);
assert.equal(
  memberContentAccessDecision({ userId: "admin-a", role: "admin" }, "member-b"),
  "admin_capability",
  "cross-member administrator access must enter the capability gate",
);

const authority = read("src/lib/server/member-content-authority.ts");
assert.match(authority, /authorizeAdminCapability\(request, "member_content\.view", \{/u);
assert.match(authority, /if \(decision === "owner"\) \{\s*return \{ ok: true, delegated: false/u);
assert.match(authority, /requireStepUp: options\.requireStepUp === true/u);

const voiceAuthorization = read("src/app/api/voice/nest/authorize/route.ts");
assert.match(voiceAuthorization, /authorizeAdminCapability\(request, 'members\.view'/u);
assert.match(voiceAuthorization, /authorizeAdminCapability\(request, 'billing\.view'/u);
assert.match(voiceAuthorization, /authorizeAdminCapability\(request, 'member_permissions\.manage', \{\s*requireStepUp: true/u);

const reconciliation = read("src/app/api/extract/reconciliation/route.ts");
assert.match(reconciliation, /requireReconciliationAccess\(request, "billing\.view", false\)/u);
assert.match(reconciliation, /requireReconciliationAccess\(request, "wallet\.adjust", true\)/u);

const credits = read("src/app/api/credits/route.ts");
assert.match(credits, /if \(payload\.userId !== userId\) \{[\s\S]*authorizeAdminCapability\(request, "members\.view"[\s\S]*authorizeAdminCapability\(request, "billing\.view"/u);
assert.match(credits, /if \(payload\.userId === userId\) \{\s*await recoverLlmCreditReservations\(userId\);\s*\}/u);
const crossUserGuardStart = credits.indexOf("if (payload.userId !== userId)");
const crossUserGuardEnd = credits.indexOf("\n  }", crossUserGuardStart);
const reservationRecovery = credits.indexOf("await recoverLlmCreditReservations(userId)");
assert.ok(crossUserGuardStart >= 0 && crossUserGuardEnd > crossUserGuardStart);
assert.ok(
  reservationRecovery > crossUserGuardEnd,
  "cross-user read-only balance access must not recover or mutate another member's reservations",
);

const passwordVerification = read("src/app/api/auth/verify-password/route.ts");
for (const [purpose, permission] of [
  ["admin_user_delete", "members.delete"],
  ["admin_user_account_recovery", "members.manage"],
  ["admin_cami_assignment", "cards.manage"],
] as const) {
  assert.match(passwordVerification, new RegExp(`${purpose}: ["']${permission.replace(".", "\\.")}["']`, "u"));
}
assert.match(passwordVerification, /authorizeAdminCapability\(request, sensitivePermission/u);

const mediaRoutes = [
  "src/app/api/file/route.ts",
  "src/app/api/video/access-ticket/route.ts",
  "src/app/api/video/proxy/route.ts",
  "src/app/api/video/proxy-download/route.ts",
  "src/app/api/video/export/route.ts",
  "src/app/api/video/storage/[taskId]/route.ts",
  "src/app/api/video/thumbnail/[taskId]/route.ts",
];
for (const routePath of mediaRoutes) {
  assert.match(
    read(routePath),
    /authorizeMemberContentAccess\(/u,
    `${routePath} must guard cross-member access with member_content.view`,
  );
}

for (const routePath of mediaRoutes.slice(1)) {
  const route = read(routePath);
  assert.match(
    route,
    /authorizeMemberContentDiscovery\(/u,
    `${routePath} must capability-gate cross-member task discovery before a broad lookup`,
  );
}

for (const [routePath, ownLookup, broadLookup] of [
  ["src/app/api/video/access-ticket/route.ts", "findTask(taskId, user.userId, false)", "findTask(taskId, user.userId, true)"],
  ["src/app/api/video/proxy/route.ts", "getCompletedVideoTask(taskId, currentUserId, false)", "getCompletedVideoTask(taskId, currentUserId, true)"],
  ["src/app/api/video/proxy-download/route.ts", "readTask(false)", "readTask(true)"],
  ["src/app/api/video/export/route.ts", "readTask(false)", "readTask(true)"],
  ["src/app/api/video/storage/[taskId]/route.ts", "findTask(false)", "findTask(true)"],
  ["src/app/api/video/thumbnail/[taskId]/route.ts", "findTask(false)", "findTask(true)"],
] as const) {
  const route = read(routePath);
  const ownLookupIndex = route.indexOf(ownLookup);
  const discoveryIndex = route.indexOf("authorizeMemberContentDiscovery(", ownLookupIndex);
  const broadLookupIndex = route.indexOf(broadLookup, discoveryIndex);
  assert.ok(
    ownLookupIndex >= 0 && discoveryIndex > ownLookupIndex && broadLookupIndex > discoveryIndex,
    `${routePath} must search the caller's own tasks first, capability-gate discovery, then query across members`,
  );
}

for (const routePath of [
  "src/app/api/file/route.ts",
  "src/app/api/video/proxy-download/route.ts",
  "src/app/api/video/export/route.ts",
]) {
  assert.match(
    read(routePath),
    /requireStepUp: true/u,
    `${routePath} must require step-up for a delegated download or export`,
  );
}
assert.match(
  read("src/app/api/file/route.ts"),
  /getSignedUrl\(key, contentAccess\.delegated \? 600 : 3600\)/u,
  "delegated file downloads must receive a shorter signed-URL lifetime without changing the owner path",
);
assert.match(
  read("src/app/api/video/access-ticket/route.ts"),
  /requireStepUp: scope === "download"/u,
);

console.log("member privacy, finance and media gates: OK");

// Exercise the exact storage authorization function with an in-memory query builder.
// A source-order check alone would miss a bypass inside the discovery branch.
async function verifyStorageDiscoveryExecution() {
  const source = read("src/app/api/video/storage/[taskId]/route.ts");
  const syntax = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = syntax.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "canAccessVideoTask");
  assert.ok(declaration);
  const js = ts.transpileModule(declaration.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let role = "admin", discoveryAllowed = false, contentAllowed = true;
  let rows: Array<{ id: string; user_id: string; task_id_external?: string }> = [];
  const events: string[] = [];
  const client = { from() {
    const filters: Record<string, string> = {};
    const result = () => rows.filter(row => Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value));
    const query = { select() { return query; }, eq(key: string, value: string) { filters[key] = value; return query; },
      order() { return query; }, async maybeSingle() { events.push(filters.user_id ? "own" : "broad"); return { data: result()[0] || null, error: null }; },
      async limit() { events.push(filters.user_id ? "own" : "broad"); return { data: result(), error: null }; } };
    return query;
  } };
  const context = { Response, NextResponse: { json: Response.json },
    authorizeVideoMediaRequest: async () => ({ ok: true, user: { userId: "actor", role } }),
    getSupabaseClient: () => client,
    authorizeMemberContentDiscovery: async () => { events.push("discovery"); return discoveryAllowed ? { ok: true } : { ok: false, response: Response.json({}, { status: 403 }) }; },
    authorizeMemberContentAccess: async (_request: Request, identity: unknown, owner: string) => { events.push(`content:${owner}`); return contentAllowed ? { ok: true, deliveryIdentity: identity } : { ok: false, response: Response.json({}, { status: 403 }) }; },
  };
  vm.createContext(context); vm.runInContext(js, context);
  const execute = (context as typeof context & { canAccessVideoTask: (request: Request, id: string) => Promise<{ task?: { id: string; user_id: string }; status?: number } | null> }).canAccessVideoTask;
  const request = new Request("http://fixture.local/api/video/storage/task");
  rows = [{ id: "task", user_id: "actor" }];
  assert.equal((await execute(request, "task"))?.task?.id, "task"); assert.deepEqual(events, ["own", "content:actor"]);
  events.length = 0; rows = [{ id: "task", user_id: "other" }];
  assert.equal((await execute(request, "task"))?.status, 403); assert.deepEqual(events, ["own", "own", "discovery"], "denied discovery must perform no broad query");
  events.length = 0; role = "student";
  assert.equal(await execute(request, "task"), null); assert.deepEqual(events, ["own", "own"], "ordinary member must never discover another member's task");
  events.length = 0; role = "admin"; discoveryAllowed = true;
  assert.equal((await execute(request, "task"))?.task?.user_id, "other"); assert.deepEqual(events, ["own", "own", "discovery", "broad", "content:other"]);
  events.length = 0; contentAllowed = false;
  assert.equal((await execute(request, "task"))?.status, 403); assert.equal(events.at(-1), "content:other", "discovery must not replace final content authorization");
  events.length = 0; contentAllowed = true; rows = [{ id: "one", user_id: "other", task_id_external: "external" }, { id: "two", user_id: "other", task_id_external: "external" }];
  assert.equal((await execute(request, "external"))?.status, 503); assert.ok(!events.some(event => event.startsWith("content:")), "ambiguous provider IDs must not pick an arbitrary owner's media");
  console.log("storage actual-function discovery fixtures: 6 passed; network/database writes: 0");
}
verifyStorageDiscoveryExecution().catch(error => { console.error(error); process.exitCode = 1; });
