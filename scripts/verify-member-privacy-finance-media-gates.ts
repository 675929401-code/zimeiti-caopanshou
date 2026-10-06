import assert from "node:assert/strict";
import fs from "node:fs";
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
  ["src/app/api/video/storage/[taskId]/route.ts", "findOwner(false)", "findOwner(true)"],
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
