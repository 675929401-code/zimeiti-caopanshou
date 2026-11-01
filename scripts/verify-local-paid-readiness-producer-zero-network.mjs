import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseReadinessArgs, consumerExpectations, capturePaidAuthority, fullSemanticReview, main } from './prepare-local-paid-canary-readiness.mjs';
import { semanticSnapshotFromRows, DATABASE_SEMANTIC_SECTIONS, sha256 } from './lib/database-semantic-catalog.mjs';

const output = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/paid-readiness-producer';
const checks = [];
const consumer = consumerExpectations(await fs.readFile('scripts/verify-image-workbench-live-e2e.mjs', 'utf8'));
assert.equal(consumer.functions.length, 7); assert.match(consumer.semanticSha256, /^[a-f0-9]{64}$/u);
checks.push('read-current-consumer-expectations-without-duplicating-pins');
assert.equal(parseReadinessArgs([`--output=${output}/fixture`]).finalize, false);
for (const args of [[`--output=${output}/fixture`, '--expected-semantic-sha256=' + 'a'.repeat(64)], ['--output=outside-evidence'], [`--output=${output}/fixture`, '--finalize'], [`--output=${output}/fixture`, '--output=again']]) assert.throws(() => parseReadinessArgs(args));
checks.push('no-semantic-pin-override-no-output-escape-no-unpinned-finalize');

const roles = [{ oid: '1', rolname: 'owner', rolsuper: false }, { oid: '2', rolname: 'service_role', rolsuper: false }, { oid: '3', rolname: 'unexpected_inherited_role', rolsuper: false }, { oid: '4', rolname: 'postgres', rolsuper: true }];
const calls = [];
const client = { query: async (sql, args) => {
  calls.push({ sql, args });
  assert.match(sql.trim(), /^select\b/iu, 'AUTHORITY_CAPTURE_MUST_ONLY_SELECT');
  if (sql.includes('rolinherit')) return { rows: roles };
  if (sql.includes('p.prosrc body')) return { rows: [{ oid: '9', identity_arguments: 'p text', result: 'jsonb', language: 'plpgsql', prokind: 'f', provolatile: 'v', proparallel: 'u', prosecdef: true, proisstrict: false, proleakproof: false, proconfig: ['search_path=public, pg_temp'], body: '\nbegin\r\nreturn null;\r\nend\n', owner_oid: '1', owner_name: 'owner', owner_superuser: false, table_owner_oid: '99', table_owner_name: 'different_owner' }] };
  if (sql.includes('aclexplode')) return { rows: [{ grantor_oid: '1', grantee_oid: '3', grantee_name: 'unexpected_inherited_role', privilege_type: 'EXECUTE', is_grantable: true }] };
  if (sql.includes('where not r.rolsuper')) return { rows: roles.filter(role => !role.rolsuper).map(role => ({ role_oid: role.oid, role_name: role.rolname, execute: true, public_schema_usage: false })) };
  if (sql.includes("has_schema_privilege('service_role'")) return { rows: [{ value: false }] };
  throw new Error('UNEXPECTED_CAPTURE_QUERY');
} };
const authority = await capturePaidAuthority(client, consumer.functions);
assert.equal(authority.functions.length, 7); assert.equal(authority.roleUniverse.length, 4);
assert.equal(authority.functions[0].ownerMatchesExpectedTable, false);
assert.equal(authority.functions[0].directAcl[0].grantee_name, 'unexpected_inherited_role');
assert.equal(authority.functions[0].effective.find(role => role.role_name === 'unexpected_inherited_role').execute, true);
assert.equal(authority.serviceSchemaUsage, false);
assert.equal(authority.functions[0].bodyLfSha256, sha256('\nbegin\nreturn null;\nend\n'));
checks.push('capture-retains-real-invalid-owner-acl-and-all-role-effective-results');
checks.push('body-hash-derived-from-returned-prosrc-with-lf-normalization');

const rows = Object.fromEntries(DATABASE_SEMANTIC_SECTIONS.map(section => [section.name, []]));
const before = semanticSnapshotFromRows(rows);
const afterRows = structuredClone(rows); afterRows.tables.push({ schema_name: 'public', object_name: 'new_table' });
const after = semanticSnapshotFromRows(afterRows);
const diff = fullSemanticReview(before, after, null, afterRows);
assert.equal(diff.differences.length, 1); assert.equal(diff.differences[0].kind, 'extra');
assert.equal(diff.differences[0].blocking, true); assert.equal(diff.pinUpdatePerformed, false);
assert.equal(diff.reviewDecision, 'PENDING_INDEPENDENT_REVIEW');
checks.push('full-strict-semantic-diff-reports-added-objects-requiring-review');
const savedToken = process.env.LOCAL_NAV_ADMIN_TOKEN;
delete process.env.LOCAL_NAV_ADMIN_TOKEN;
try { await assert.rejects(main([`--output=${output}/must-not-be-created`]), /CONTROLLED_LOCAL_ADMIN_WRAPPER_REQUIRED/u); }
finally { if (savedToken) process.env.LOCAL_NAV_ADMIN_TOKEN = savedToken; }
checks.push('main-stops-before-runtime-config-or-network-without-controlled-wrapper');
const source = await fs.readFile('scripts/prepare-local-paid-canary-readiness.mjs', 'utf8');
assert.match(source, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/u);
assert.match(source, /await client\.query\('ROLLBACK'\)/u);
assert.match(source, /if \(options\.finalize\) \{[\s\S]*?await readPaidDatabaseReadiness\([\s\S]*?await write\('readiness-index\.json'/u);
assert.doesNotMatch(source, /\b(?:INSERT INTO|UPDATE public|DELETE FROM|ALTER TABLE|CREATE TABLE)\b/iu);
checks.push('read-only-transaction-and-unchanged-canonical-reader-gate-final-index');
await fs.mkdir(output, { recursive: true });
const result = { ok: true, checks, catalogQueriesInMemory: calls.length, realNetworkCalls: 0, databaseConnections: 0, databaseWrites: 0, providerCalls: 0 };
await fs.writeFile(`${output}/zero-network.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
