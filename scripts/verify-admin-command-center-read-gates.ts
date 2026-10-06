import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import {
  COMMAND_CENTER_VIEW_DEFINITIONS,
  commandCenterAuthorizedDrilldownUrl,
  commandCenterPermissionKeysForView,
  createCommandCenterViewReadGate,
  type CommandCenterSectionId,
} from "@/lib/admin-command-center-domain";
import {
  createCommandCenterGetHandler,
  type CommandCenterRouteDependencies,
} from "@/lib/server/admin-command-center-route-handler";

const allSections: readonly CommandCenterSectionId[] = [
  "business", "finance", "tasks", "models", "security", "operations", "governance",
];

async function main(): Promise<void> {
  for (const definition of COMMAND_CENTER_VIEW_DEFINITIONS) {
    const gate = createCommandCenterViewReadGate(definition.id);
    const reads: CommandCenterSectionId[] = [];
    await Promise.all(allSections.map((sectionId) => gate.read(
      sectionId,
      async () => { reads.push(sectionId); return "read"; },
      () => "skipped",
    )));
    assert.deepEqual(reads, definition.querySectionIds, `${definition.id}:QUERY_SECTION_READ_SET_DRIFTED`);
    assert.deepEqual(gate.querySectionIds, definition.querySectionIds, `${definition.id}:QUERY_SECTION_GATE_DRIFTED`);

    let snapshotReads = 0;
    let denialAudits = 0;
    const required = commandCenterPermissionKeysForView(definition.id);
    const dependencies: CommandCenterRouteDependencies = {
      authorize: async () => ({
        ok: true,
        actor: { userId: `fixture-${definition.id}`, username: "fixture", role: "admin", displayName: "合同测试" },
        user: {
          id: `fixture-${definition.id}`,
          username: "fixture",
          email: null,
          role: "admin",
          status: "active",
          is_active: true,
          display_name: "合同测试",
          member_status: null,
          credits: 0,
          cash_balance: 0,
          allowed_categories: null,
          session_id: null,
        },
        access: {
          authorityStatus: "ready",
          integrityValid: true,
          adminLevel: "admin",
          permissionKeys: required.slice(0, -1),
          revision: 1,
          checksum: "fixture",
          profileActive: true,
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
        stepUp: null,
        maintenanceLock: null,
      }),
      appendAudit: async () => { denialAudits += 1; return true; },
      readSnapshot: async () => { snapshotReads += 1; throw new Error("UNAUTHORIZED_READER_CALLED"); },
    };
    const response = await createCommandCenterGetHandler(dependencies)(
      new NextRequest(`http://127.0.0.1:5000/api/admin/command-center?hours=24&view=${definition.id}`),
    );
    assert.equal(response.status, 403, `${definition.id}:INCOMPLETE_PERMISSION_SET_MUST_BE_DENIED`);
    assert.equal(snapshotReads, 0, `${definition.id}:DENIED_VIEW_MUST_NOT_READ_SNAPSHOT`);
    assert.equal(denialAudits, 1, `${definition.id}:DENIAL_MUST_BE_AUDITED_ONCE`);
  }

  assert.equal(commandCenterAuthorizedDrilldownUrl("/admin?tab=users", ["users"]), "/admin?tab=users");
  assert.equal(commandCenterAuthorizedDrilldownUrl("/admin?tab=credits", ["users"]), null);
  assert.equal(commandCenterAuthorizedDrilldownUrl("https://evil.invalid/admin?tab=users", ["users"]), null);
  assert.equal(commandCenterAuthorizedDrilldownUrl("//evil.invalid/admin?tab=users", ["users"]), null);

  console.log(JSON.stringify({
    verifier: "admin-command-center-read-gates",
    views: COMMAND_CENTER_VIEW_DEFINITIONS.length,
    deniedSnapshotReads: 0,
    querySetsVerified: true,
    unauthorizedDrilldownsHidden: true,
    ok: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
