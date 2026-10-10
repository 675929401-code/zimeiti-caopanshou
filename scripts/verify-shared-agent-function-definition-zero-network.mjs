#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  expectedFunctionSemanticDescriptor,
  functionAclAssessment,
  functionSemanticHash,
  liveFunctionSemanticDescriptor,
} from "./lib/shared-agent-function-definition.mjs";

const source = await readFile("supabase/migrations/20261010140000_shared_agent_batch_cas.sql", "utf8");

for (const name of ["apply_agent_reorder_cas_v1", "apply_coze_agent_import_cas_v1"]) {
  const expected = expectedFunctionSemanticDescriptor(source, name);
  const bodyStart = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const asStart = source.indexOf("AS $$", bodyStart);
  const bodyEnd = source.indexOf("$$;", asStart + 5);
  const body = source.slice(asStart + 5, bodyEnd);
  const liveRow = {
    function_definition: `CREATE OR REPLACE FUNCTION public.${name}(p_entries jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$${body}$function$\n`,
    identity_arguments: "p_entries jsonb",
    result: "jsonb",
    language: "plpgsql",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    kind: "f",
    returns_set: false,
    security_definer: true,
    cost: 100,
    rows: 0,
    support: "-",
    config: ["search_path=public, pg_temp"],
  };
  const baseline = functionSemanticHash(expected);
  assert.equal(functionSemanticHash(liveFunctionSemanticDescriptor(liveRow)), baseline,
    `BASELINE_COMPLETE_DEFINITION_MUST_MATCH:${name}`);

  const malicious = [
    ["identity_arguments", "p_entries text"],
    ["result", "text"],
    ["language", "sql"],
    ["volatility", "s"],
    ["strict", true],
    ["parallel", "s"],
    ["leakproof", true],
    ["kind", "p"],
    ["returns_set", true],
    ["security_definer", false],
    ["cost", 7],
    ["rows", 10],
    ["support", "some_support_function"],
    ["config", ["search_path=public"]],
    ["function_definition", liveRow.function_definition.replace("RETURN v_result;", "RETURN '{}'::jsonb;")],
  ];
  for (const [field, value] of malicious) {
    const altered = { ...liveRow, [field]: value };
    assert.notEqual(functionSemanticHash(liveFunctionSemanticDescriptor(altered)), baseline,
      `MALICIOUS_FUNCTION_ATTRIBUTE_DRIFT_MUST_FAIL:${name}:${field}`);
  }
}

const allowedAcl = { service_execute: true, anon_execute: false, authenticated_execute: false };
for (const emptyRoles of [[], "[]", "{}"]) {
  assert.deepEqual(functionAclAssessment({ ...allowedAcl, unexpected_roles: emptyRoles }), {
    serviceExecute: true,
    anonExecute: false,
    authenticatedExecute: false,
    unexpectedRoles: [],
    serviceOnly: true,
  }, `EMPTY_ACL_RESULT_MUST_NOT_FALSE_NEGATIVE:${JSON.stringify(emptyRoles)}`);
}
for (const row of [
  { ...allowedAcl, unexpected_roles: ["rogue_role"] },
  { ...allowedAcl, unexpected_roles: '["rogue_role"]' },
  { ...allowedAcl, unexpected_roles: "{rogue_role}" },
  { ...allowedAcl, service_execute: false, unexpected_roles: [] },
  { ...allowedAcl, anon_execute: true, unexpected_roles: [] },
  { ...allowedAcl, authenticated_execute: true, unexpected_roles: [] },
  { ...allowedAcl, unexpected_roles: null },
]) {
  assert.equal(functionAclAssessment(row).serviceOnly, false,
    `UNEXPECTED_OR_MALFORMED_ACL_MUST_FAIL_CLOSED:${JSON.stringify(row)}`);
}

const readiness = await readFile("scripts/verify-shared-agent-batch-cas-readiness-local.mjs", "utf8");
const rollback = await readFile("scripts/verify-shared-agent-batch-cas-rollback-local.mjs", "utf8");
for (const verifier of [readiness, rollback]) {
  assert.match(verifier, /pg_get_functiondef\(p\.oid\) function_definition/u);
  assert.match(verifier, /pg_get_function_identity_arguments\(p\.oid\)/u);
  assert.match(verifier, /pg_get_function_result\(p\.oid\)/u);
  assert.match(verifier, /p\.provolatile volatility/u);
  assert.match(verifier, /p\.proisstrict strict/u);
  assert.match(verifier, /p\.proparallel parallel/u);
  assert.match(verifier, /jsonb_agg\(role_entry\.rolname::text/u);
  assert.match(verifier, /functionAclAssessment\(row\)/u);
  assert.doesNotMatch(verifier, /p\.prosrc/u);
}

console.log(JSON.stringify({
  passed: true,
  network: false,
  databaseConnections: 0,
  functions: 2,
  maliciousAttributeFixturesPerFunction: 15,
  aclFixtures: 10,
  covered: [
    "identity arguments and return type",
    "language, volatility, strict, parallel, leakproof, kind, set-returning",
    "security definer, cost, rows, support, complete proconfig",
    "function body extracted from normalized pg_get_functiondef",
  ],
}, null, 2));
