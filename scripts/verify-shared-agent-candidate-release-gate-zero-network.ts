import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHARED_AGENT_BATCH_CAS_FUNCTIONS,
  SHARED_AGENT_BATCH_CAS_VERSION,
  assertSharedAgentBatchCasCandidateCaptured,
  type CandidateContract,
} from "./lib/shared-agent-batch-cas-candidate-gate";

const current = JSON.parse(readFileSync("deploy/policies/database-contract.v1.json", "utf8")) as CandidateContract;
assert.doesNotThrow(
  () => assertSharedAgentBatchCasCandidateCaptured(current),
  "CURRENT_CONTRACT_MUST_CAPTURE_SHARED_AGENT_BATCH_CAS",
);

type ContractMutation = (candidate: CandidateContract) => void;

function requiredMigrations(candidate: CandidateContract) {
  const migrations = candidate.liveCatalogChecks?.migrationLedger?.requiredMigrations;
  assert.ok(migrations, "CURRENT_CONTRACT_MIGRATION_LEDGER_REQUIRED");
  return migrations;
}

function migrationIndex(candidate: CandidateContract): number {
  const index = requiredMigrations(candidate)
    .findIndex((entry) => entry.version === SHARED_AGENT_BATCH_CAS_VERSION);
  assert.notEqual(index, -1, "CURRENT_CONTRACT_1400_MIGRATION_REQUIRED");
  return index;
}

function securityGroups(candidate: CandidateContract) {
  const groups = candidate.liveCatalogChecks?.functionSecurityGroups;
  assert.ok(groups, "CURRENT_CONTRACT_FUNCTION_SECURITY_GROUPS_REQUIRED");
  return groups;
}

function securityGroupIndex(candidate: CandidateContract): number {
  const index = securityGroups(candidate).findIndex((group) => group.id === "shared-agent-batch-cas");
  assert.notEqual(index, -1, "CURRENT_CONTRACT_SHARED_AGENT_SECURITY_GROUP_REQUIRED");
  return index;
}

function securityGroup(candidate: CandidateContract) {
  return securityGroups(candidate)[securityGroupIndex(candidate)]!;
}

function rpcs(candidate: CandidateContract) {
  assert.ok(candidate.rpcs, "CURRENT_CONTRACT_RPCS_REQUIRED");
  return candidate.rpcs;
}

function rpcIndex(candidate: CandidateContract, name: string): number {
  const index = rpcs(candidate).findIndex((entry) => entry.name === name);
  assert.notEqual(index, -1, `CURRENT_CONTRACT_RPC_REQUIRED:${name}`);
  return index;
}

const rejectedMutations: string[] = [];
function expectBlocked(name: string, mutate: ContractMutation): void {
  const candidate = structuredClone(current);
  mutate(candidate);
  assert.throws(
    () => assertSharedAgentBatchCasCandidateCaptured(candidate),
    /SHARED_AGENT_BATCH_CAS_CANDIDATE_NOT_IN_RELEASE_CONTRACT/u,
    `MALICIOUS_CONTRACT_MUST_FAIL_CLOSED:${name}`,
  );
  rejectedMutations.push(name);
}

expectBlocked("migration-deleted", (candidate) => {
  requiredMigrations(candidate).splice(migrationIndex(candidate), 1);
});
expectBlocked("migration-file-tampered", (candidate) => {
  requiredMigrations(candidate)[migrationIndex(candidate)]!.file = "supabase/migrations/tampered.sql";
});
expectBlocked("migration-hash-tampered", (candidate) => {
  requiredMigrations(candidate)[migrationIndex(candidate)]!.sha256 = "0".repeat(64);
});
expectBlocked("migration-duplicated", (candidate) => {
  const migrations = requiredMigrations(candidate);
  const index = migrationIndex(candidate);
  migrations.splice(index, 0, structuredClone(migrations[index]!));
});

expectBlocked("function-security-group-deleted", (candidate) => {
  securityGroups(candidate).splice(securityGroupIndex(candidate), 1);
});
expectBlocked("function-signature-deleted", (candidate) => {
  securityGroup(candidate).functions = [SHARED_AGENT_BATCH_CAS_FUNCTIONS[0]];
});
expectBlocked("function-security-group-duplicated", (candidate) => {
  const groups = securityGroups(candidate);
  const index = securityGroupIndex(candidate);
  groups.splice(index, 0, structuredClone(groups[index]!));
});
expectBlocked("owner-relation-tampered", (candidate) => {
  securityGroup(candidate).ownerRelation = "public.users";
});
expectBlocked("owner-match-disabled", (candidate) => {
  securityGroup(candidate).ownerMustMatchRelationOwner = false;
});
expectBlocked("security-definer-disabled", (candidate) => {
  securityGroup(candidate).securityDefinerRequired = false;
});
expectBlocked("search-path-tampered", (candidate) => {
  securityGroup(candidate).searchPath = ["public"];
});
expectBlocked("required-execute-acl-expanded", (candidate) => {
  securityGroup(candidate).requiredNonOwnerExecuteGrantees = ["service_role", "authenticated"];
});
expectBlocked("allowed-effective-acl-expanded", (candidate) => {
  securityGroup(candidate).allowedEffectiveExecutePrincipals = ["relation_owner", "service_role", "authenticated"];
});
expectBlocked("forbidden-execute-acl-reduced", (candidate) => {
  securityGroup(candidate).forbiddenExecutePrincipals = ["PUBLIC", "anon"];
});
expectBlocked("superuser-inherent-privilege-not-excluded", (candidate) => {
  securityGroup(candidate).superuserInherentPrivilegeExcluded = false;
});

for (const name of ["apply_agent_reorder_cas_v1", "apply_coze_agent_import_cas_v1"]) {
  expectBlocked(`rpc-deleted:${name}`, (candidate) => {
    rpcs(candidate).splice(rpcIndex(candidate, name), 1);
  });
  expectBlocked(`rpc-arguments-tampered:${name}`, (candidate) => {
    rpcs(candidate)[rpcIndex(candidate, name)]!.arguments = ["p_entries", "p_force"];
  });
  expectBlocked(`rpc-duplicated:${name}`, (candidate) => {
    const entries = rpcs(candidate);
    const index = rpcIndex(candidate, name);
    entries.splice(index, 0, structuredClone(entries[index]!));
  });
}

console.log(JSON.stringify({
  passed: true,
  networkCalls: 0,
  databaseWrites: 0,
  paidCalls: 0,
  currentContractReady: true,
  maliciousContractsRejected: rejectedMutations.length,
  rejectedMutations,
}, null, 2));
