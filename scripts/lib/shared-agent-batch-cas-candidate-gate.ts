import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SHARED_AGENT_BATCH_CAS_VERSION = "20261010140000";
export const SHARED_AGENT_BATCH_CAS_FILE = `supabase/migrations/${SHARED_AGENT_BATCH_CAS_VERSION}_shared_agent_batch_cas.sql`;
export const SHARED_AGENT_BATCH_CAS_FUNCTIONS = [
  "public.apply_agent_reorder_cas_v1(jsonb)",
  "public.apply_coze_agent_import_cas_v1(jsonb)",
] as const;

export type CandidateContract = {
  liveCatalogChecks?: {
    migrationLedger?: { requiredMigrations?: Array<{ version: string; file: string; sha256: string }> };
    functionSecurityGroups?: Array<{
      id?: string;
      ownerRelation?: string;
      ownerMustMatchRelationOwner?: boolean;
      securityDefinerRequired?: boolean;
      searchPath?: string[];
      requiredNonOwnerExecuteGrantees?: string[];
      allowedEffectiveExecutePrincipals?: string[];
      superuserInherentPrivilegeExcluded?: boolean;
      forbiddenExecutePrincipals?: string[];
      functions?: string[];
    }>;
  };
  rpcs?: Array<{ name: string; arguments: string[] }>;
};

function sameUniqueMembers(actual: string[] | undefined, expected: readonly string[]): boolean {
  if (!actual || new Set(actual).size !== actual.length) return false;
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function sharedAgentBatchCasMigrationHash(): string {
  return createHash("sha256").update(readFileSync(SHARED_AGENT_BATCH_CAS_FILE)).digest("hex");
}

export function assertSharedAgentBatchCasCandidateCaptured(contract: CandidateContract): void {
  const failures: string[] = [];
  const expectedHash = sharedAgentBatchCasMigrationHash();
  const migrations = contract.liveCatalogChecks?.migrationLedger?.requiredMigrations || [];
  const candidateMigrations = migrations.filter((entry) => entry.version === SHARED_AGENT_BATCH_CAS_VERSION);
  const migration = candidateMigrations[0];
  if (candidateMigrations.length !== 1) failures.push("unique required migration 20261010140000");
  if (!migration) failures.push("required migration 20261010140000");
  else {
    if (migration.file !== SHARED_AGENT_BATCH_CAS_FILE) failures.push("migration file");
    if (migration.sha256 !== expectedHash) failures.push("migration sha256");
  }

  const candidateSecurityGroups = (contract.liveCatalogChecks?.functionSecurityGroups || [])
    .filter((group) => group.id === "shared-agent-batch-cas");
  const securityGroup = candidateSecurityGroups[0];
  if (candidateSecurityGroups.length !== 1) failures.push("unique function security group");
  if (!securityGroup) failures.push("function security group");
  else {
    if (securityGroup.ownerRelation !== "public.agents") failures.push("dynamic owner relation");
    if (securityGroup.ownerMustMatchRelationOwner !== true) failures.push("owner must match relation owner");
    if (securityGroup.securityDefinerRequired !== true) failures.push("SECURITY DEFINER");
    if (JSON.stringify(securityGroup.searchPath) !== JSON.stringify(["public", "pg_temp"])) failures.push("search_path");
    if (!sameUniqueMembers(securityGroup.requiredNonOwnerExecuteGrantees, ["service_role"])) failures.push("service_role-only grant");
    if (!sameUniqueMembers(securityGroup.allowedEffectiveExecutePrincipals, ["relation_owner", "service_role"])) {
      failures.push("allowed effective execute principals");
    }
    if (securityGroup.superuserInherentPrivilegeExcluded !== true) failures.push("superuser inherent privilege excluded");
    if (!sameUniqueMembers(securityGroup.forbiddenExecutePrincipals, ["PUBLIC", "anon", "authenticated"])) {
      failures.push("forbidden execute principals");
    }
    if (!sameUniqueMembers(securityGroup.functions, SHARED_AGENT_BATCH_CAS_FUNCTIONS)) failures.push("exact function signatures");
  }

  for (const name of ["apply_agent_reorder_cas_v1", "apply_coze_agent_import_cas_v1"]) {
    const matchingRpcs = (contract.rpcs || []).filter((entry) => entry.name === name);
    const rpc = matchingRpcs[0];
    if (matchingRpcs.length !== 1 || !rpc || JSON.stringify(rpc.arguments) !== JSON.stringify(["p_entries"])) {
      failures.push(`unique rpc ${name}(p_entries)`);
    }
  }

  assert.equal(failures.length, 0,
    `SHARED_AGENT_BATCH_CAS_CANDIDATE_NOT_IN_RELEASE_CONTRACT:${failures.join(",")}`);
}
