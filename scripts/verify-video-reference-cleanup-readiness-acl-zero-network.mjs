#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateFunctionAcl, normalizePgTextArray } from "./lib/video-reference-readiness-acl.mjs";

assert.deepEqual(process.argv.slice(2), [], "ZERO_NETWORK_REGRESSION_ACCEPTS_NO_ARGUMENTS");
assert.deepEqual(normalizePgTextArray("{}"), []);
assert.deepEqual(normalizePgTextArray("{service_role}"), ["service_role"]);
assert.deepEqual(normalizePgTextArray('{"role,with,commas",plain_role}'), ["role,with,commas", "plain_role"]);
assert.deepEqual(normalizePgTextArray([]), []);

const serviceRpc = evaluateFunctionAcl({
  service_execute: true,
  anon_execute: false,
  authenticated_execute: false,
  unexpected_roles: "{}",
}, true);
assert.equal(serviceRpc.serviceOnly, true, "EMPTY_POSTGRES_ARRAY_LITERAL_MUST_NOT_CAUSE_FALSE_NEGATIVE");
assert.deepEqual(serviceRpc.unexpectedRoles, []);

const ownerOnlyTrigger = evaluateFunctionAcl({
  service_execute: false,
  anon_execute: false,
  authenticated_execute: false,
  unexpected_roles: "{}",
}, false);
assert.equal(ownerOnlyTrigger.serviceOnly, true, "OWNER_ONLY_TRIGGER_ACL_MUST_PASS");

assert.equal(evaluateFunctionAcl({
  service_execute: true,
  anon_execute: false,
  authenticated_execute: false,
  unexpected_roles: "{reporting_role}",
}, true).serviceOnly, false, "UNEXPECTED_EFFECTIVE_ROLE_MUST_FAIL_CLOSED");
assert.equal(evaluateFunctionAcl({
  service_execute: true,
  anon_execute: true,
  authenticated_execute: false,
  unexpected_roles: "{}",
}, true).serviceOnly, false, "ANON_EXECUTE_MUST_FAIL_CLOSED");

const readinessSource = await readFile("scripts/verify-video-reference-cleanup-readiness-local.mjs", "utf8");
assert.match(readinessSource, /role_entry\.rolname::text/u, "SQL_MUST_RETURN_TEXT_ARRAY_NOT_NAME_ARRAY");
assert.match(readinessSource, /evaluateFunctionAcl\(row, contract\.serviceCallable\)/u);

console.log("video reference cleanup readiness ACL zero-network regression: PASS");
