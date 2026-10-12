#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { stableJson, DATABASE_SEMANTIC_SECTIONS } from "./lib/database-semantic-catalog.mjs";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const PROJECT_ROOT = process.cwd();
const SCRIPT_PATH = "scripts/verify-image-workbench-live-e2e.mjs";
const DEFAULT_ORIGIN = process.env.BASE_URL || process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";
const DEFAULT_MODEL_NAME = "Nano Banana 2";
const DEFAULT_PROMPT = "白色背景上的青色马克杯，商品摄影，画面简洁，柔和棚拍光线，无文字。";
const SUPPORTED_RESOLUTION_ARGUMENTS = new Set(["1K", "2K", "4K"]);
const SUPPORTED_ASPECT_RATIO_ARGUMENTS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);
const RUN_ID = /^[a-zA-Z0-9_-]{6,100}$/u;
const SAFE_ID = /^[a-zA-Z0-9._:-]{4,180}$/u;
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5002",
  "http://127.0.0.1:5010",
]);
const LOCAL_DATABASE_TARGET = "127.0.0.1:54322/zimeiti_local";
const READINESS_CHECKERS = [
  "scripts/apply-image-request-snapshot-v2-local.mjs",
  "scripts/apply-image-rpc-owner-alignment-local.mjs",
  "scripts/apply-image-provider-receipts-local.mjs",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const roundMoney = (value) => Number(Number(value).toFixed(6));


// Explicit reviewed authority projection; canonical SQL bodies are checked again before admission.
const PAID_AUTHORITY_FUNCTIONS = [
  {
    "migration": "20261012010000_image_provider_delivery.sql",
    "name": "public.finalize_image_provider_delivery",
    "signature": "public.finalize_image_provider_delivery(text,text,text)",
    "identityArguments": "p_record_id text, p_user_id text, p_provider_url text",
    "result": "jsonb",
    "language": "plpgsql",
    "prokind": "f",
    "provolatile": "v",
    "proparallel": "u",
    "prosecdef": true,
    "proisstrict": false,
    "proleakproof": false,
    "proconfig": [
      "search_path=public, pg_temp"
    ],
    "ownerEqualsTableOwner": "public.image_generation_requests",
    "sourceBodyLfSha256": "5471382e173ff0a2c967596cbf0709f92df09bc67269dd757196d1a4db9b5546",
    "executeAcl": {
      "allowedNonSuperuserRoles": [
        "actual function owner",
        "service_role"
      ],
      "public": false,
      "anon": false,
      "authenticated": false,
      "directUnknownRoles": false,
      "inheritedOtherRoles": false
    }
  },
  {
    "migration": "20261012010000_image_provider_delivery.sql",
    "name": "public.mark_image_provider_source_expired",
    "signature": "public.mark_image_provider_source_expired(text,text,text)",
    "identityArguments": "p_record_id text, p_user_id text, p_provider_url text",
    "result": "jsonb",
    "language": "plpgsql",
    "prokind": "f",
    "provolatile": "v",
    "proparallel": "u",
    "prosecdef": true,
    "proisstrict": false,
    "proleakproof": false,
    "proconfig": [
      "search_path=public, pg_temp"
    ],
    "ownerEqualsTableOwner": "public.image_generation_requests",
    "sourceBodyLfSha256": "8ae80c7c04e739c1c22e322a8ae4d9d35ad93837860edf5c58cbf97725bdb8ff",
    "executeAcl": {
      "allowedNonSuperuserRoles": [
        "actual function owner",
        "service_role"
      ],
      "public": false,
      "anon": false,
      "authenticated": false,
      "directUnknownRoles": false,
      "inheritedOtherRoles": false
    }
  },
  {
    "migration": "20261012011000_h3_provider_delivery.sql",
    "name": "public.autodl_h3_provider_delivery_url_valid",
    "signature": "public.autodl_h3_provider_delivery_url_valid(text,text)",
    "identityArguments": "p_url text, p_upstream_task_id text",
    "result": "boolean",
    "language": "sql",
    "prokind": "f",
    "provolatile": "i",
    "proparallel": "u",
    "prosecdef": false,
    "proisstrict": true,
    "proleakproof": false,
    "proconfig": [
      "search_path=public, pg_temp"
    ],
    "ownerEqualsTableOwner": "public.video_tasks",
    "sourceBodyLfSha256": "17f5fa459b27a691f3485768c29f005216cd7d9e65aad0e3d6377926a92fffe1",
    "executeAcl": {
      "public": true,
      "note": "Pure parameter-only invoker; check full actual ACL and owner separately."
    }
  },
  {
    "migration": "20261012011000_h3_provider_delivery.sql",
    "name": "public.autodl_h3_provider_delivery_v1_ready",
    "signature": "public.autodl_h3_provider_delivery_v1_ready()",
    "identityArguments": "",
    "result": "boolean",
    "language": "sql",
    "prokind": "f",
    "provolatile": "s",
    "proparallel": "u",
    "prosecdef": false,
    "proisstrict": false,
    "proleakproof": false,
    "proconfig": [
      "search_path=public, pg_temp"
    ],
    "ownerEqualsTableOwner": "public.video_tasks",
    "sourceBodyLfSha256": "641a2f909f377b91d9a5a2cb1b8cb2e537a05cb4082a95734c2ddbe90a8a8b2e",
    "executeAcl": {
      "allowedNonSuperuserRoles": [
        "actual function owner",
        "service_role"
      ],
      "public": false,
      "anon": false,
      "authenticated": false,
      "directUnknownRoles": false,
      "inheritedOtherRoles": false
    }
  },
  {
    "migration": "20261012011000_h3_provider_delivery.sql",
    "name": "public.autodl_h3_finalize_video_provider_url",
    "signature": "public.autodl_h3_finalize_video_provider_url(uuid,text,text,text,text,text,text,bigint,text,numeric,numeric,bigint)",
    "identityArguments": "p_job_id uuid, p_public_task_id text, p_video_task_internal_id text, p_user_id text, p_model_id text, p_upstream_task_id text, p_owner text, p_lease_token bigint, p_result_asset_url text, p_price_yuan numeric, p_cost_price numeric, p_response_ms bigint",
    "result": "jsonb",
    "language": "plpgsql",
    "prokind": "f",
    "provolatile": "v",
    "proparallel": "u",
    "prosecdef": true,
    "proisstrict": false,
    "proleakproof": false,
    "proconfig": [
      "search_path=public, pg_temp"
    ],
    "ownerEqualsTableOwner": "public.video_tasks",
    "sourceBodyLfSha256": "de2695ffee8abf7bdeef47b65614456892db8c8a05462492dfa5af5c703bcf25",
    "executeAcl": {
      "allowedNonSuperuserRoles": [
        "actual function owner",
        "service_role"
      ],
      "public": false,
      "anon": false,
      "authenticated": false,
      "directUnknownRoles": false,
      "inheritedOtherRoles": false
    }
  },
  {
    "migration": "20261012012000_image_ephemeral_delivery.sql",
    "name": "public.complete_image_ephemeral_delivery",
    "signature": "public.complete_image_ephemeral_delivery(text,text,text,text,text,text,text,jsonb)",
    "identityArguments": "p_record_id text, p_user_id text, p_client_trace_id text, p_payload_fingerprint text, p_dispatch_receipt_sha256 text, p_submission_receipt_sha256 text, p_billing_reference_id text, p_metadata jsonb",
    "result": "jsonb",
    "language": "plpgsql",
    "prokind": "f",
    "provolatile": "v",
    "proparallel": "u",
    "prosecdef": true,
    "proisstrict": false,
    "proleakproof": false,
    "proconfig": [
      "search_path=public, pg_temp"
    ],
    "ownerEqualsTableOwner": "public.image_generation_requests",
    "sourceBodyLfSha256": "0bf19490bfaea19eafed120c40dae9c468a8e2680fa3759f9b027d8ec85e41ef",
    "executeAcl": {
      "allowedNonSuperuserRoles": [
        "actual function owner",
        "service_role"
      ],
      "public": false,
      "anon": false,
      "authenticated": false,
      "directUnknownRoles": false,
      "inheritedOtherRoles": false
    }
  },
  {
    "migration": "20261012013000_image_model_validation_receipt_publication.sql",
    "name": "public.publish_image_model_validation_receipt",
    "signature": "public.publish_image_model_validation_receipt(text,text,text,text,boolean,boolean,text,bigint,text,jsonb)",
    "identityArguments": "p_validation_id text, p_user_id text, p_configuration_hash text, p_model_snapshot_hash text, p_expected_active boolean, p_expected_hidden boolean, p_verified_key text, p_verified_size bigint, p_verified_type text, p_evidence jsonb",
    "result": "jsonb",
    "language": "plpgsql",
    "prokind": "f",
    "provolatile": "v",
    "proparallel": "u",
    "prosecdef": true,
    "proisstrict": false,
    "proleakproof": false,
    "proconfig": [
      "search_path=public, pg_temp"
    ],
    "ownerEqualsTableOwner": "public.cover_models",
    "sourceBodyLfSha256": "a937300687350dd91372c5c28ffe52563db06d71ada00c1088784b37e4492737",
    "executeAcl": {
      "allowedNonSuperuserRoles": [
        "actual function owner",
        "service_role"
      ],
      "public": false,
      "anon": false,
      "authenticated": false,
      "directUnknownRoles": false,
      "inheritedOtherRoles": false
    }
  }
];
const PAID_SEMANTIC_SHA = '227558bab22aa71f31baa736d46e15223138ac40a1290c3bc6bb3d19ea57c5f3';
const HASH64 = /^[a-f0-9]{64}$/u;

export function assertPaidDatabaseReadiness(index, evidence, sourcePlan, options, runtime, now=Date.now(), expectedSemanticSha=PAID_SEMANTIC_SHA) {
  const fail=(value,code)=>assert.ok(value,`PAID_DATABASE_${code}`);
  fail(index.kind==='application-paid-canary-database-readiness.v1' && index.schemaVersion===1,'INDEX_SCHEMA');
  const age=now-Date.parse(index.createdAt); fail(Number.isFinite(age) && age>=-60000 && age<=1800000,'INDEX_STALE');
  fail(index.databaseWrites===0 && index.providerCalls===0,'INDEX_EFFECTS');
  const id=index.identity;
  fail(id && HASH64.test(id.fingerprint) && id.fingerprint===options.values['expected-database-identity'],'IDENTITY');
  fail(`${id.configuredHost}:${id.serverPort}/${id.databaseName}`===options.values['expected-database-target'],'TARGET');
  fail(!/restore|isolated|scratch/iu.test(id.databaseName),'RESTORE_NOT_APPLICATION');
  fail(index.cluster && index.runtime?.applicationDatabaseFingerprint===id.fingerprint && HASH64.test(index.runtime.configurationFileSha256),'RUNTIME_DATABASE');
  for(const key of ['sourceVersion','buildId']) fail(index.runtime[key]===runtime[key] && index.runtime[key]===options.values[key==='sourceVersion'?'expected-source-version':'expected-build-id'],'RUNTIME_DRIFT');
  fail(sourcePlan.ok===true && sourcePlan.mode==='plan' && sourcePlan.readinessScope==='source-only' && Array.isArray(sourcePlan.migrations) && sourcePlan.migrations.length>0 && sourcePlan.invalid?.length===0,'SOURCE_PLAN');
  const expectedCount=sourcePlan.migrations.length;
  fail(new Set(sourcePlan.migrations.map(row=>row.version)).size===expectedCount,'SOURCE_PLAN_UNIQUE');
  const policy=evidence.databaseContract;
  fail(policy?.contractVersion===evidence.contractVersion && typeof policy.contractVersion==='string' && policy.contractVersion.length>0,'CURRENT_CONTRACT');
  const requiredMigrations=policy.liveCatalogChecks?.migrationLedger?.requiredMigrations;
  fail(Array.isArray(requiredMigrations) && requiredMigrations.length>0,'REQUIRED_MIGRATIONS');
  for(const required of requiredMigrations) fail(sourcePlan.migrations.some(row=>row.version===required.version && row.sha256===required.sha256),'REQUIRED_MIGRATION_SOURCE_HASH');
  fail(index.manifestSha256===sourcePlan.manifestSha256,'MANIFEST');
  const status=evidence.status;
  fail(status.ok===true && status.mode==='status' && status.manifestSha256===index.manifestSha256 && status.migrationCount===expectedCount && status.invalid?.length===0 && status.hashDrifts?.length===0,'STATUS');
  fail(status.database?.targetIdentityVerified===true && status.database.appliedCount===expectedCount && status.database.pendingCount===0,'LEDGER');
  for(const key of ['configuredHost','databaseName','serverPort','fingerprint']) fail(String(status.database.targetIdentity?.[key])===String(id[key]),'STATUS_IDENTITY');
  fail(Array.isArray(status.migrations) && status.migrations.length===expectedCount && new Set(status.migrations.map(x=>x.version)).size===expectedCount,'LEDGER_UNIQUE');
  for(const migration of sourcePlan.migrations) fail(status.migrations.some(row=>row.version===migration.version && row.sha256===migration.sha256 && row.valid===true && row.applied===true),'LEDGER_SOURCE_HASH');
  fail(typeof index.liveCatalogEvidence?.path==='string' && index.liveCatalogEvidence.path.length>0 && index.liveCatalogEvidence.path.length<=4096 && HASH64.test(index.liveCatalogEvidence.sha256),'LIVE_CATALOG_REFERENCE');
  const live=evidence.liveCatalog;
  fail(live?.kind==='application-paid-canary-live-catalog.v1','LIVE_CATALOG_SCHEMA');
  const liveTime=Date.parse(live.createdAt), indexTime=Date.parse(index.createdAt), liveAge=now-liveTime;
  fail(Number.isFinite(liveAge) && liveAge>=-60000 && liveAge<=1800000 && liveTime<=indexTime && indexTime-liveTime<=1800000,'LIVE_CATALOG_STALE');
  for(const key of ['configuredHost','databaseName','serverPort','fingerprint']) fail(String(live.identity?.[key])===String(id[key]),'LIVE_CATALOG_IDENTITY');
  fail(live.cluster===index.cluster && live.manifestSha256===index.manifestSha256 && live.databaseWrites===0 && live.providerCalls===0,'LIVE_CATALOG_TARGET');
  for(const key of ['sourceVersion','buildId']) fail(live.runtime?.[key]===index.runtime[key],'LIVE_CATALOG_RUNTIME');
  const output=live.output;
  fail(output?.ok===true && output.liveCatalogChecked===true && output.contractVersion===policy.contractVersion && output.databaseWrites===0 && output.paidModelCalls===0,'LIVE_CATALOG_RESULT');
  const catalog=output.liveCatalog;
  fail(catalog?.identity?.database===id.databaseName && String(catalog.identity.serverPort)===String(id.serverPort),'LIVE_CATALOG_DATABASE');
  if(Object.hasOwn(id,'serverAddress')) fail(catalog.identity.serverAddress===id.serverAddress,'LIVE_CATALOG_SERVER_ADDRESS');
  fail(Array.isArray(catalog.ledger) && catalog.ledger.length===requiredMigrations.length && new Set(catalog.ledger.map(row=>row.version)).size===requiredMigrations.length,'LIVE_CATALOG_LEDGER');
  for(const migration of requiredMigrations) fail(catalog.ledger.some(row=>row.version===migration.version && String(row.hash).toLowerCase()===migration.sha256),'LIVE_CATALOG_LEDGER_SOURCE_HASH');
  const expectedEdges=policy.liveCatalogChecks.functionDependencyEdges, actualEdges=catalog.functionDependencyEdges;
  fail(Array.isArray(expectedEdges) && expectedEdges.length>0 && Array.isArray(actualEdges) && actualEdges.length===expectedEdges.length && new Set(actualEdges.map(edge=>JSON.stringify([edge.caller,edge.callee]))).size===expectedEdges.length,'LIVE_CATALOG_EDGES');
  for(const expected of expectedEdges) {
    const edge=actualEdges.find(row=>row.caller===expected.caller && row.callee===expected.callee);
    fail(edge && edge.ownerRelation===expected.ownerRelation && edge.callerExists===true && edge.calleeExists===true && typeof edge.callerOwner==='string' && edge.callerOwner.length>0 && edge.callerOwner===edge.relationOwner,'LIVE_CATALOG_EDGE_OWNER');
    fail(edge.callerSecurityDefiner===true && edge.calleeSecurityDefiner===true && stableJson(edge.calleeSearchPath)===stableJson(['search_path=public, pg_temp']),'LIVE_CATALOG_EDGE_SECURITY');
    fail(edge.callerExecute===true && edge.callerSchemaUsage===true && edge.serviceExecute===true,'LIVE_CATALOG_EDGE_PERMISSIONS');
  }
  const semantic=evidence.semantic, core={...semantic};delete core.contractSha256;
  fail(semantic.kind==='database-semantic-contract' && semantic.schemaVersion===1 && semantic.profile==='public-runtime-contract.v1' && sha256(stableJson(core))===semantic.contractSha256,'SEMANTIC_CONTRACT');
  const snapshot=semantic.snapshot;
  fail(snapshot?.profile===semantic.profile && snapshot.sha256===sha256(stableJson(snapshot.sections)),'SEMANTIC_ROOT');
  fail(Object.keys(snapshot.sections).length===DATABASE_SEMANTIC_SECTIONS.length && DATABASE_SEMANTIC_SECTIONS.every(x=>snapshot.sections[x.name]),'SEMANTIC_SECTIONS');
  for(const section of Object.values(snapshot.sections)) fail(Array.isArray(section.objects) && section.rows===section.objects.length && new Set(section.objects.map(x=>x.key)).size===section.rows && section.objects.every(x=>HASH64.test(x.sha256)) && sha256(stableJson(section.objects))===section.sha256,'SEMANTIC_SECTION');
  fail(snapshot.sha256===expectedSemanticSha && index.expectedSemanticSha256===expectedSemanticSha && semantic.migrationManifestSha256===index.manifestSha256 && semantic.sourceDatabase===id.databaseName,'SEMANTIC_EXPECTED');
  const a=evidence.authority;
  fail(a.targetFingerprint===id.fingerprint && a.targetDatabaseName===id.databaseName && a.systemIdentifier===index.cluster && a.manifestSha256===index.manifestSha256 && a.applied===expectedCount && a.pending===0 && a.databaseWrites===0 && a.providerCalls===0 && a.rollbackAcknowledged===true,'AUTHORITY_TARGET');
  fail(a.serviceSchemaUsage===true && Array.isArray(a.roleUniverse) && a.roleUniverse.length===a.totalRoleCount && new Set(a.roleUniverse.map(r=>r.oid)).size===a.roleUniverse.length && a.roleUniverseSha256===sha256(JSON.stringify(a.roleUniverse)),'ROLE_UNIVERSE');
  const roles=a.roleUniverse.filter(r=>r.rolsuper===false);
  fail(roles.length===a.nonSuperuserRoleCount && ['service_role','anon','authenticated'].every(name=>roles.some(r=>r.rolname===name)),'REQUIRED_ROLES');
  fail(a.selectedSignatureCount===7 && a.functions?.length===7 && new Set(a.functions.map(f=>f.signature)).size===7,'FUNCTION_UNIQUE');
  for(const expected of PAID_AUTHORITY_FUNCTIONS) {
    const row=a.functions.find(f=>f.signature===expected.signature);fail(row,'FUNCTION_MISSING');
    for(const key of ['result','language','prokind','provolatile','proparallel','prosecdef','proisstrict','proleakproof','proconfig']) fail(stableJson(row[key])===stableJson(expected[key]),'FUNCTION_METADATA');
    fail(row.identity_arguments===expected.identityArguments && row.bodyLfSha256===expected.sourceBodyLfSha256 && row.protectedTable===expected.ownerEqualsTableOwner && row.owner_oid===row.table_owner_oid && row.owner_name===row.table_owner_name && row.ownerMatchesExpectedTable===true,'FUNCTION_BODY_OWNER');
    const owner=a.roleUniverse.find(r=>r.oid===row.owner_oid);fail(owner && owner.rolname===row.owner_name && owner.rolsuper===row.owner_superuser,'OWNER_ROLE');
    const publicPredicate=expected.executeAcl.public===true;
    fail(Array.isArray(row.directAcl) && row.directAcl.length>0 && row.directAcl.every(acl=>acl.grantor_oid===row.owner_oid && acl.privilege_type==='EXECUTE' && (publicPredicate ? (acl.grantee_name==='PUBLIC' || acl.grantee_oid===row.owner_oid) : (acl.grantee_oid===row.owner_oid || acl.grantee_name==='service_role'))),'DIRECT_ACL');
    fail(row.directAcl.some(acl=>acl.grantee_name===(publicPredicate?'PUBLIC':'service_role') && acl.privilege_type==='EXECUTE' && acl.is_grantable===false),'SERVICE_OR_PUBLIC_ACL');
    fail(row.effective?.length===roles.length && new Set(row.effective.map(r=>r.role_oid)).size===roles.length,'EFFECTIVE_UNIVERSE');
    for(const role of roles) {
      const effective=row.effective.find(r=>r.role_oid===role.oid);
      fail(effective && effective.role_name===role.rolname && effective.execute===(publicPredicate || role.oid===row.owner_oid || role.rolname==='service_role'),'EFFECTIVE_EXECUTE');
      if(role.rolname==='service_role') fail(effective.public_schema_usage===true,'SERVICE_SCHEMA');
    }
  }
  const probe=index.applicationProbe;
  fail(probe?.ok===true && probe.state==='ready' && probe.contractVersion===evidence.contractVersion,'APPLICATION_PROBE');
  for(const key of ['missingTables','missingColumns','missingRpcs','missingRpcArguments','forbiddenRpcsPresent']) fail(Array.isArray(probe[key]) && probe[key].length===0,'APPLICATION_PROBE_MISSING');
  return {verified:true,identity:{...id},manifestSha256:index.manifestSha256,semanticSha256:snapshot.sha256,migrationCount:expectedCount,dependencyEdges:actualEdges.length,authorityFunctions:7,applicationProbeReady:true,databaseWrites:0,providerCalls:0};
}

export async function assertPaidCanonicalFunctionSources() {
  for(const expected of PAID_AUTHORITY_FUNCTIONS) {
    const sql=(await fs.readFile(path.join(PROJECT_ROOT,'supabase/migrations',expected.migration),'utf8')).replace(/\r\n/gu,'\n');
    const name=expected.name.replace('public.','');
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    const match=new RegExp('CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public[.])?'+escaped+'\\s*\\([\\s\\S]*?\\bAS\\s+(\\$[A-Za-z_0-9]*\\$)([\\s\\S]*?)\\1','iu').exec(sql);
    assert.ok(match && sha256(match[2])===expected.sourceBodyLfSha256,'PAID_DATABASE_CANONICAL_FUNCTION_DRIFT');
  }
}

export async function readPaidDatabaseReadiness(options,runtime) {
  async function readBounded(file,expected,max=32*1024*1024) {
    assert.match(String(expected||''),HASH64,'PAID_DATABASE_FILE_PIN_REQUIRED');
    const stat=await fs.lstat(file);assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size>0 && stat.size<=max,'PAID_DATABASE_FILE_INVALID');
    const bytes=await fs.readFile(file);assert.ok(bytes.length===stat.size && bytes.length<=max,'PAID_DATABASE_FILE_CHANGED_OR_OVERSIZED');assert.equal(sha256(bytes),expected,'PAID_DATABASE_FILE_SHA');return JSON.parse(bytes.toString('utf8'));
  }
  const file=path.resolve(options.values['database-readiness']);
  const index=await readBounded(file,options.values['database-readiness-sha256'],256*1024);
  const evidence={};
  for(const [key,ref] of [['status','statusEvidence'],['semantic','semanticEvidence'],['authority','authorityEvidence'],['liveCatalog','liveCatalogEvidence']]) {
    assert.ok(index[ref]?.path && index[ref].path.length<=4096,'PAID_DATABASE_REFERENCE_REQUIRED');
    evidence[key]=await readBounded(path.resolve(path.dirname(file),index[ref].path),index[ref].sha256);
  }
  evidence.databaseContract=JSON.parse(await fs.readFile(path.join(PROJECT_ROOT,'deploy/policies/database-contract.v1.json'),'utf8'));
  evidence.contractVersion=evidence.databaseContract.contractVersion;
  await assertPaidCanonicalFunctionSources();
  const result=spawnSync(process.execPath,['scripts/db-migration-release.mjs','plan'],{cwd:PROJECT_ROOT,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,'PAID_DATABASE_SOURCE_PLAN_FAILED');
  const sourcePlan=JSON.parse(result.stdout);
  return {...assertPaidDatabaseReadiness(index,evidence,sourcePlan,options,runtime),indexSha256:options.values['database-readiness-sha256']};
}

// Shared by the four paid harnesses only; these checks never grant spending permission.
export function parsePaidHarnessArgs(args, allowed) {
  const values = {}, flags = new Set(), seen = new Set();
  const common = new Set(['actor-role','user-id','expected-source-version','expected-build-id','max-charge','remaining-budget','database-readiness','database-readiness-sha256','expected-database-target','expected-database-identity']);
  for (const arg of args) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/u.exec(arg);
    assert.ok(match && (common.has(match[1]) || allowed.includes(match[1])), 'HARNESS_UNKNOWN_ARGUMENT');
    assert.ok(!seen.has(match[1]), 'HARNESS_DUPLICATE_ARGUMENT'); seen.add(match[1]);
    if (match[2] === undefined) { assert.ok(['execute','help','self-test','health-only','reconcile'].includes(match[1]), 'HARNESS_ARGUMENT_VALUE_REQUIRED'); flags.add(match[1]); }
    else { assert.ok(!['execute','help','self-test','health-only','reconcile'].includes(match[1]), 'HARNESS_FLAG_WITH_VALUE'); assert.ok(match[2].trim(), 'HARNESS_ARGUMENT_EMPTY'); values[match[1]] = match[2].trim(); }
  }
  const actorRole = values['actor-role'] || 'student';
  assert.ok(['student','admin'].includes(actorRole), 'HARNESS_ACTOR_ROLE_INVALID');
  for(const key of ['database-readiness-sha256','expected-database-identity']) if(values[key]) assert.match(values[key],HASH64,'HARNESS_DATABASE_PIN_INVALID');
  if(values['expected-database-target']) assert.match(values['expected-database-target'],/^[A-Za-z0-9.-]+:[1-9][0-9]*\/[A-Za-z0-9_]+$/u,'HARNESS_DATABASE_TARGET_INVALID');
  if (values['user-id']) assert.match(values['user-id'], /^[a-f0-9-]{36}$/iu, 'HARNESS_USER_ID_INVALID');
  if (actorRole === 'admin') assert.ok(values['user-id'], 'HARNESS_ADMIN_EXACT_USER_REQUIRED');
  const maxCharge = values['max-charge'] === undefined ? null : Number(values['max-charge']);
  const remainingBudget = values['remaining-budget'] === undefined ? null : Number(values['remaining-budget']);
  for (const number of [maxCharge,remainingBudget]) if (number !== null) assert.ok(Number.isFinite(number) && number > 0 && number <= 20, 'HARNESS_BUDGET_INVALID');
  if (maxCharge !== null && remainingBudget !== null) assert.ok(maxCharge <= remainingBudget, 'HARNESS_ALLOCATION_EXCEEDS_REMAINING');
  if (flags.has('execute')) {
    for (const key of ['user-id','expected-source-version','expected-build-id','max-charge','remaining-budget','database-readiness','database-readiness-sha256','expected-database-target','expected-database-identity']) assert.ok(values[key], 'HARNESS_EXECUTE_PREREQUISITE_REQUIRED');
  }
  return { values, flags, actorRole, userId:values['user-id'] || '', maxCharge, remainingBudget };
}

export function assertPaidActor(identity, options) {
  assert.equal(identity?.user?.id, options.userId, 'HARNESS_ACTOR_ID_MISMATCH');
  assert.equal(identity?.user?.role, options.actorRole, 'HARNESS_ACTOR_ROLE_MISMATCH');
  return { id:identity.user.id, role:identity.user.role, ordinaryMemberAdmissionVerified:options.actorRole === 'student', billingExempt:false };
}

export function assertPaidQuote(price, options) {
  assert.ok(Number.isFinite(price) && price > 0, 'HARNESS_QUOTE_INVALID');
  assert.ok(price <= options.maxCharge && options.maxCharge <= options.remainingBudget && options.remainingBudget <= 20, 'HARNESS_QUOTE_EXCEEDS_ALLOCATION');
  return price;
}

export function publicVideoQuote(model, seconds, resolution, options) {
  assert.ok(model?.capabilities?.available === true && model.capabilities.generationReady === true, 'HARNESS_VIDEO_NOT_READY');
  assert.ok(Number.isInteger(seconds) && seconds > 0 && model.capabilities.nativeDurations?.includes(seconds), 'HARNESS_DURATION_NOT_SUPPORTED');
  assert.ok(model.capabilities.resolutionOptions?.includes(resolution), 'HARNESS_RESOLUTION_NOT_SUPPORTED');
  const unit = model.capabilities.billingUnit;
  assert.ok(['per_use','output_second'].includes(unit), 'HARNESS_PRICE_UNIT_UNSUPPORTED');
  return assertPaidQuote(roundMoney(Number(model.publicPrice) * (unit === 'output_second' ? seconds : 1)), options);
}

export function projectImageDelivery(body) {
  const image = body?.images?.[0] || {};
  const mode = body?.deliveryMode || image.deliveryMode || (image.assetId ? 'legacy_owned' : null);
  assert.ok(['legacy_owned','provider_url','inline_ephemeral'].includes(mode), 'HARNESS_IMAGE_DELIVERY_UNKNOWN');
  const recordId = body?.recordId || image.recordId || null;
  if (mode !== 'legacy_owned') assert.match(String(recordId || ''), /^[a-f0-9]{64}$/u, 'HARNESS_IMAGE_RECORD_REQUIRED');
  const cashCharged = Number(body.cashCharged);
  assert.ok(Number.isFinite(cashCharged) && cashCharged >= 0, 'HARNESS_IMAGE_FEE_MISSING');
  return { deliveryMode:mode, recordId, assetId:image.assetId || body.assetId || null, cashCharged,
    billingReferenceId:body.billingReferenceId || null, generationCompleted:true,
    mediaAvailable:body.mediaAvailable === true || Boolean(image.url), canRecover:mode === 'inline_ephemeral' ? false : body.canRecover === true };
}

export function assertImageReceiptBinding(first, status) {
  assert.equal(status?.generationCompleted === true || status?.state === 'completed', true, 'HARNESS_IMAGE_NOT_COMPLETED');
  assert.equal(status.recordId, first.recordId, 'HARNESS_IMAGE_STATUS_RECORD_MISMATCH');
  assert.equal(status.deliveryMode, first.deliveryMode, 'HARNESS_IMAGE_STATUS_MODE_MISMATCH');
  assert.equal(Number(status.cashCharged), first.cashCharged, 'HARNESS_IMAGE_STATUS_CASH_MISMATCH');
  assert.ok(first.billingReferenceId && status.billingReferenceId === first.billingReferenceId, 'HARNESS_IMAGE_BILLING_REFERENCE_MISMATCH');
  if (first.deliveryMode === 'inline_ephemeral') {
    assert.equal(status.mediaAvailable, false, 'HARNESS_INLINE_PERSISTENT_MEDIA');
    assert.equal(status.canRecover, false, 'HARNESS_INLINE_RECOVERABLE');
    assert.ok(!status.images?.length && !status.url && !status.transientDelivery, 'HARNESS_INLINE_BYTES_ON_REPLAY');
  }
  return first;
}

export function assertPaidFinalPass({actor,expectedRole,completed,cashDelta,quote,newCashRows,generationPosts}) {
  assert.equal(actor.role,expectedRole,'HARNESS_FINAL_ACTOR_DRIFT');
  assert.equal(completed,true,'HARNESS_FINAL_NOT_COMPLETED');
  assert.equal(roundMoney(cashDelta),roundMoney(quote),'HARNESS_FINAL_CASH_DRIFT');
  assert.equal(newCashRows,1,'HARNESS_FINAL_LEDGER_COUNT');
  assert.equal(generationPosts,1,'HARNESS_FINAL_POST_COUNT');
  return true;
}

export async function readWorkbenchDeliveryReceipt(page, expected, userId) {
  assert.ok(typeof userId==='string' && userId.trim(),'HARNESS_RECEIPT_OWNER_REQUIRED');
  const actual=await page.evaluate(({recordId,userId})=>{
    const key=`app_state_image_workbench_prompt_cards_v1:user:${encodeURIComponent(userId.trim())}:receipts`;
    const text=sessionStorage.getItem(key);
    if(text) {
      const rows=JSON.parse(text); const receipt=Array.isArray(rows)?rows.find(row=>row.receipt?.recordId===recordId)?.receipt:null;
      if(receipt) return {recordId:receipt.recordId,deliveryMode:receipt.deliveryMode,cashCharged:receipt.cashCharged,billingReferenceId:receipt.billingReferenceId,
        generationCompleted:receipt.generationCompleted,mediaAvailable:receipt.mediaAvailable,canRecover:receipt.canRecover,
        containsMedia:/data:image\/|blob:/u.test(text)};
    }
    return null;
  },{recordId:expected.recordId,userId});
  assert.ok(actual && !actual.containsMedia,'HARNESS_PERSISTED_RECEIPT_MISSING_OR_BYTES');
  assertImageReceiptBinding(expected,actual);
  return actual;
}

export async function waitForImageDecoded(locator, {timeout=120000}={}) {
  assert.ok(Number.isFinite(timeout) && timeout>0,'HARNESS_IMAGE_TIMEOUT_INVALID');
  const deadline=Date.now()+timeout;
  const remaining=()=>{const value=deadline-Date.now();assert.ok(value>0,'HARNESS_IMAGE_DECODE_TIMEOUT');return value;};
  await locator.waitFor({state:'visible',timeout:remaining()});
  await locator.scrollIntoViewIfNeeded({timeout:remaining()});
  return locator.evaluate((image,budget)=>new Promise((resolve,reject)=>{
    let settled=false,decoding=false,frame;
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);cancelAnimationFrame(frame);
      image.removeEventListener('load',check);image.removeEventListener('error',onError);
      if(error)reject(Error(error));
      else resolve({complete:image.complete,width:image.naturalWidth,height:image.naturalHeight});
    };
    const onError=()=>finish('HARNESS_IMAGE_LOAD_FAILED');
    const check=()=>{
      if(settled)return;
      if(!image.isConnected)return finish('HARNESS_IMAGE_DETACHED');
      if(image.complete && image.naturalWidth===0 && (image.currentSrc||image.getAttribute('src')))return finish('HARNESS_IMAGE_LOAD_FAILED');
      if(!decoding && image.complete && image.naturalWidth>0 && image.naturalHeight>0){
        decoding=true;const source=image.currentSrc||image.src;
        Promise.resolve().then(()=>image.decode()).then(()=>{
          decoding=false;
          if(settled)return;
          if(source===(image.currentSrc||image.src) && image.complete && image.naturalWidth>0 && image.naturalHeight>0)finish();
        },()=>{decoding=false;if(!settled && source===(image.currentSrc||image.src))finish('HARNESS_IMAGE_DECODE_FAILED');});
      }
    };
    const tick=()=>{check();if(!settled)frame=requestAnimationFrame(tick);};
    const timer=setTimeout(()=>finish('HARNESS_IMAGE_DECODE_TIMEOUT'),budget);
    image.addEventListener('load',check);image.addEventListener('error',onError);
    tick();
  }),remaining(),{timeout:remaining()});
}

export function makePaidPostGuard(expected, count = { attempts:0, forwarded:0 }) {
  return async route => {
    count.attempts += 1;
    try {
      const request = route.request();
      assert.equal(request.method(), 'POST', 'HARNESS_METHOD_DRIFT');
      assert.equal(count.forwarded, 0, 'HARNESS_SECOND_GENERATION_BLOCKED');
      const body = request.postDataJSON();
      for (const [key,value] of Object.entries(expected)) assert.deepEqual(body[key], value, `HARNESS_REQUEST_DRIFT_${key}`);
      count.forwarded += 1;
      await route.continue();
    } catch (error) { await route.abort('blockedbyclient'); throw error; }
  };
}

export function safeHarnessEvidence(value, key = '') {
  if (/^(?:prompt|src|url|videoUrl|storageUrl|imageUrl|image_url|providerUrl|apiEndpoint|provider|providerProtocol|api_key|secret|rawBody|rawResponse|responseBody|base64|token|cookie|stack|error|message|consoleErrors|pageErrors|runnerError|responseUrl|currentSrc)$/iu.test(key)) return undefined;
  if (Array.isArray(value)) return value.map(item => safeHarnessEvidence(item)).filter(item => item !== undefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,safeHarnessEvidence(v,k)]).filter(([,v])=>v !== undefined));
  if (typeof value === 'string' && /(?:data:image\/|blob:|https?:\/\/[^\s]+|Bearer\s|eyJ[A-Za-z0-9_-]+\.)/u.test(value)) return '[REDACTED]';
  return value;
}

export function safeHarnessErrorCode(_error) {
  // Untrusted server errors may be uppercase too. Never echo arbitrary messages.
  return 'HARNESS_FAILURE_STOPPED';
}

export function makeWorkbenchPaidPostHandler({diagnostics,isArmed,expected,checkFresh}) {
  let occupied=false;
  const guarded=makePaidPostGuard(expected);
  return async route=>{
    diagnostics.generationPostAttempts += 1;
    if(!isArmed() || occupied) {
      diagnostics.duplicateGenerationPostsBlocked += 1;
      await route.abort('blockedbyclient');return;
    }
    // Admission is synchronous and permanent for this run, including uncertain failure.
    occupied=true;
    try { await checkFresh(route); await guarded(route); diagnostics.generationPostsContinued += 1; }
    catch(error) { await route.abort('blockedbyclient').catch(()=>undefined);throw error; }
  };
}

export function captureImageRequest(report, request) {
  const rawBody = request.postData() || "";
  const projection = sanitizedRequestProjection(parseJson(rawBody, {}), rawBody);
  if (!report.request) {
    report.request = projection;
    report.forwarding = { stage:"captured-before-guard", state:"not-forwarded", providerDispatchCount:"unknown" };
  }
  return projection;
}

// Only the image registration uses this boundary; shared paid handlers retain their contract.
export function makeImagePaidRouteBoundary(handler, report) {
  let resolveFailure;
  const failure = new Promise(resolve => { resolveFailure = resolve; });
  return { failure, handler:async route => {
    try {
      if (route.request().method() === 'POST') captureImageRequest(report, route.request());
      await handler({
        request:() => route.request(),
        abort:(...args) => route.abort(...args),
        continue:async (...args) => {
          report.forwarding = { stage:"continue", state:"unknown", providerDispatchCount:"unknown" };
          await route.continue(...args);
          report.forwarding = { stage:"after-continue", state:"forwarded", providerDispatchCount:"unknown" };
        },
      });
    } catch {
      if (!report.routeFailure) {
        report.routeFailure = { errorCode:"IMAGE_ROUTE_HANDLER_FAILED", stage:report.forwarding?.stage || "before-guarded", forwardingState:report.forwarding?.state || "unknown" };
        resolveFailure(report.routeFailure);
      }
    }
  } };
}

export async function awaitImageGenerationResponse({page, click, failure}) {
  const response = page.waitForResponse(candidate => candidate.request().method() === "POST"
    && pathnameOnly(candidate.url()) === "/api/image/generate", { timeout:720_000 });
  response.catch(() => undefined);
  const stopped = failure.then(() => { throw new Error("IMAGE_ROUTE_HANDLER_FAILED"); });
  stopped.catch(() => undefined);
  const clicking = Promise.resolve().then(click);
  clicking.catch(() => undefined);
  await Promise.race([clicking, stopped]);
  return await Promise.race([response, stopped]);
}

export function assertDecodedImageAspect(metadata, aspectRatio) {
  assert.ok(Number.isInteger(metadata?.width) && metadata.width > 0 && Number.isInteger(metadata?.height) && metadata.height > 0, "HARNESS_DOWNLOADED_IMAGE_DIMENSIONS_REQUIRED");
  if (aspectRatio === "1:1") assert.equal(metadata.width, metadata.height, "HARNESS_DOWNLOADED_IMAGE_NOT_SQUARE");
  return { width:metadata.width, height:metadata.height, aspectRatio, decodedBytesVerified:true };
}

export async function installPaidAuthCookie(context, origin, token) {
  assert.ok(typeof token === 'string' && token.trim(), 'HARNESS_EXISTING_AUTH_TOKEN_REQUIRED');
  assert.equal(new URL(origin).origin, origin, 'HARNESS_AUTH_COOKIE_ORIGIN_REQUIRED');
  await context.addCookies([{ name:'auth_token', value:token, url:origin, httpOnly:true, sameSite:'Lax' }]);
}

export async function writePaidTerminalReadback(outputDir, facts, io = fs) {
  const receipt = safeHarnessEvidence({ ...facts, kind:'paid-media-terminal-readback.v1',
    fullAcceptancePassed:false, downloadAcceptancePending:true });
  await io.writeFile(path.join(outputDir, 'terminal-readback.json'), JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
}

export async function capturePaidDownload(page, button, outputDir, kind = 'image', options = {}) {
  const io = options.io || fs;
  const timeoutMs = options.timeoutMs ?? 120000, cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000;
  const observe = promise => { const observed = Promise.resolve(promise); observed.catch(() => undefined); return observed; };
  const bounded = async (work, milliseconds, code) => {
    const operation = observe(Promise.resolve().then(work));
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer=setTimeout(() => reject(new Error(code)), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const temporary = path.join(outputDir, `download-${randomUUID()}.tmp`);
  let download, finished = false, primaryError, cleanupPromise;
  const cleanDownload = current => cleanupPromise ||= (async () => {
    let failed = false;
    for (const method of ['cancel', 'delete']) {
      try { await bounded(() => current[method](), cleanupTimeoutMs, 'HARNESS_DOWNLOAD_CLEANUP_TIMEOUT'); }
      catch { failed = true; }
    }
    return failed;
  })();
  try {
    // Attach rejection ownership before click can yield; either failure rejects the main combination.
    const waiting = observe(Promise.resolve().then(() => page.waitForEvent('download', { timeout:timeoutMs })));
    observe(waiting.then(current => { download=current; if (finished) return cleanDownload(current); }));
    const clicking = observe(Promise.resolve().then(() => button.click({ timeout:timeoutMs })));
    [download] = await bounded(() => Promise.all([waiting, clicking]), timeoutMs, 'HARNESS_DOWNLOAD_EVENT_TIMEOUT');
    const saved = observe(Promise.resolve().then(() => download.saveAs(temporary)));
    // saveAs can finish after its timeout; remove any late temporary copy as well.
    observe(saved.then(() => finished && bounded(() => io.rm(temporary, { force:true }), cleanupTimeoutMs, 'HARNESS_DOWNLOAD_CLEANUP_TIMEOUT')));
    await bounded(() => saved, timeoutMs, 'HARNESS_DOWNLOAD_SAVE_TIMEOUT');
    assert.equal(await bounded(() => download.failure(), timeoutMs, 'HARNESS_DOWNLOAD_FAILURE_TIMEOUT'), null, 'HARNESS_DOWNLOAD_FAILED');
    const stat=await io.stat(temporary); assert.ok(stat.size <= (kind==='image'?30:512)*1024*1024,'HARNESS_DOWNLOAD_TOO_LARGE');
    const bytes = await io.readFile(temporary); assert.ok(bytes.length > 1000, 'HARNESS_DOWNLOAD_EMPTY');
    let media;
    if(kind==='image') { const decoder=sharp(bytes,{limitInputPixels:40000000}); const metadata=await decoder.metadata(); await decoder.stats(); assert.ok(metadata.width>0 && metadata.height>0,'HARNESS_DOWNLOAD_DECODE'); media={width:metadata.width,height:metadata.height,format:metadata.format}; }
    else { assert.equal(bytes.subarray(4,8).toString('ascii'),'ftyp','HARNESS_VIDEO_DOWNLOAD_CONTAINER'); media={container:'mp4'}; }
    return { bytes:bytes.length, sha256:sha256(bytes), ...media, temporaryFileDeleted:true };
  } catch (error) { primaryError=error; throw error; }
  finally {
    finished=true;
    let cleanupFailed = download ? await cleanDownload(download) : false;
    try { await bounded(() => io.rm(temporary, { force:true }), cleanupTimeoutMs, 'HARNESS_DOWNLOAD_CLEANUP_TIMEOUT'); }
    catch { cleanupFailed=true; }
    if (cleanupFailed && !primaryError) throw new Error('HARNESS_DOWNLOAD_CLEANUP_FAILED');
  }
}

async function runPaidDownloadSelfTest() {
  let checks=0;
  const deferred=()=>{ let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
  const nextEvent=()=>new Promise(resolve=>setImmediate(resolve));
  const fixture=()=>{
    const files=new Map(), events=deferred();
    const bytes=Buffer.alloc(1200); bytes.write('ftyp',4,'ascii');
    const calls={cancel:0,delete:0,remove:0};
    const io={stat:async file=>({size:files.get(file).length}),readFile:async file=>files.get(file),
      rm:async file=>{calls.remove++;files.delete(file);}};
    const download={saveAs:async file=>{files.set(file,bytes);},failure:async()=>null,
      cancel:async()=>{calls.cancel++;},delete:async()=>{calls.delete++;}};
    const page={waitForEvent:(event,options)=>{assert.equal(event,'download');assert.equal(options.timeout,20);return events.promise;}};
    const options={io,timeoutMs:20,cleanupTimeoutMs:5};
    return {files,events,bytes,calls,io,download,page,options};
  };
  const success=fixture();
  const result=await capturePaidDownload(success.page,{click:async()=>success.events.resolve(success.download)},'/RAM','video',success.options);
  assert.equal(result.container,'mp4');checks++;assert.equal(result.bytes,1200);checks++;
  assert.equal(success.files.size,0);checks++;assert.equal(success.calls.cancel,1);checks++;assert.equal(success.calls.delete,1);checks++;
  const image=fixture(), pixels=Buffer.alloc(64*64*3);
  for(let i=0;i<pixels.length;i++) pixels[i]=(i*31+(i>>>3)*17+(i>>>9)*47)&255;
  const png=await sharp(pixels,{raw:{width:64,height:64,channels:3}}).png().toBuffer();
  image.download.saveAs=async file=>image.files.set(file,png);
  const decoded=await capturePaidDownload(image.page,{click:async()=>image.events.resolve(image.download)},'/RAM','image',image.options);
  assert.deepEqual([decoded.width,decoded.height,decoded.format],[64,64,'png']);checks++;assert.equal(image.files.size,0);checks++;
  const clickFailed=fixture();
  await assert.rejects(capturePaidDownload(clickFailed.page,{click:async()=>{throw new Error('CLICK_FAILED');}},'/RAM','video',clickFailed.options),/CLICK_FAILED/u);checks++;
  clickFailed.events.reject(new Error('LATE_EVENT_REJECTION'));await nextEvent();
  const eventFailed=fixture(), clicking=deferred();
  const failedEvent=capturePaidDownload(eventFailed.page,{click:()=>clicking.promise},'/RAM','video',eventFailed.options);
  const eventAssertion=assert.rejects(failedEvent,/EVENT_TIMEOUT/u);
  eventFailed.events.reject(new Error('EVENT_TIMEOUT'));await eventAssertion;checks++;
  clicking.reject(new Error('LATE_CLICK_REJECTION'));await nextEvent();
  const lateDownload=fixture();
  await assert.rejects(capturePaidDownload(lateDownload.page,{click:()=>{throw new Error('SYNC_CLICK_FAILED');}},'/RAM','video',lateDownload.options),/SYNC_CLICK_FAILED/u);checks++;
  lateDownload.events.resolve(lateDownload.download);await nextEvent();
  assert.equal(lateDownload.calls.cancel,1);checks++;assert.equal(lateDownload.calls.delete,1);checks++;
  const saveFailed=fixture();saveFailed.download.saveAs=async()=>{throw new Error('SAVE_FAILED');};
  await assert.rejects(capturePaidDownload(saveFailed.page,{click:async()=>saveFailed.events.resolve(saveFailed.download)},'/RAM','video',saveFailed.options),/SAVE_FAILED/u);checks++;
  assert.equal(saveFailed.calls.cancel,1);checks++;assert.equal(saveFailed.calls.delete,1);checks++;assert.equal(saveFailed.files.size,0);checks++;
  const saveLate=fixture(), saving=deferred();let lateFile;
  saveLate.download.saveAs=file=>{lateFile=file;return saving.promise;};
  await assert.rejects(capturePaidDownload(saveLate.page,{click:async()=>saveLate.events.resolve(saveLate.download)},'/RAM','video',saveLate.options),/HARNESS_DOWNLOAD_SAVE_TIMEOUT/u);checks++;
  saveLate.files.set(lateFile,saveLate.bytes);saving.resolve();await nextEvent();assert.equal(saveLate.files.size,0);checks++;
  const saveRejectLate=fixture(), savingReject=deferred();saveRejectLate.download.saveAs=()=>savingReject.promise;
  await assert.rejects(capturePaidDownload(saveRejectLate.page,{click:async()=>saveRejectLate.events.resolve(saveRejectLate.download)},'/RAM','video',saveRejectLate.options),/HARNESS_DOWNLOAD_SAVE_TIMEOUT/u);checks++;
  savingReject.reject(new Error('LATE_SAVE_REJECTION'));await nextEvent();
  const cleanup=fixture();cleanup.download.cancel=()=>new Promise(()=>{});cleanup.download.delete=async()=>{throw new Error('DELETE_FAILED');};
  await assert.rejects(capturePaidDownload(cleanup.page,{click:async()=>cleanup.events.resolve(cleanup.download)},'/RAM','video',cleanup.options),/HARNESS_DOWNLOAD_CLEANUP_FAILED/u);checks++;
  assert.equal(cleanup.files.size,0);checks++;
  const noEvent=fixture(), slowClick=deferred();
  await assert.rejects(capturePaidDownload(noEvent.page,{click:()=>slowClick.promise},'/RAM','video',noEvent.options),/HARNESS_DOWNLOAD_EVENT_TIMEOUT/u);checks++;
  noEvent.events.reject(new Error('LOSING_EVENT_REJECTION'));slowClick.reject(new Error('LOSING_CLICK_REJECTION'));await nextEvent();
  let persisted;
  await writePaidTerminalReadback('/RAM',{runId:'fixture',terminalStatus:'completed',prompt:'PRIVATE',url:'https://private.invalid',
    reusableSource:{recordId:'a'.repeat(64)},billing:{balanceDelta:.1}}, {writeFile:async(file,body,options)=>{assert.equal(options.flag,'wx');persisted={file,body};}});
  assert.equal(JSON.parse(persisted.body).fullAcceptancePassed,false);checks++;
  assert.equal(JSON.parse(persisted.body).downloadAcceptancePending,true);checks++;
  assert.equal(/PRIVATE|private.invalid/u.test(persisted.body),false);checks++;
  await assert.rejects(writePaidTerminalReadback('/RAM',{}, {writeFile:async()=>{throw new Error('IMMUTABLE_RECEIPT_EXISTS');}}),/IMMUTABLE_RECEIPT_EXISTS/u);checks++;
  const cookieCalls=[];
  await installPaidAuthCookie({addCookies:async cookies=>cookieCalls.push(cookies)},'http://127.0.0.1:5000','RAM_FIXTURE_TOKEN');
  assert.deepEqual(cookieCalls,[[{name:'auth_token',value:'RAM_FIXTURE_TOKEN',url:'http://127.0.0.1:5000',httpOnly:true,sameSite:'Lax'}]]);checks++;
  await assert.rejects(installPaidAuthCookie({addCookies:async()=>{throw new Error('UNREACHED');}},'http://127.0.0.1:5000',''));checks++;
  return checks;
}


export function runPaidReadinessSelfTest() {
  // Test-only RAM snapshot expectation; live reader never accepts an override.
  const fingerprint='b'.repeat(64), manifest='c'.repeat(64), now=Date.now();
  const databaseContract=JSON.parse(readFileSync(path.join(PROJECT_ROOT,'deploy/policies/database-contract.v1.json'),'utf8'));
  const requiredMigrations=databaseContract.liveCatalogChecks.migrationLedger.requiredMigrations;
  const runtime={sourceVersion:'R001006',buildId:'fixture-build'};
  const identity={configuredHost:'127.0.0.1',serverPort:'54322',databaseName:'zimeiti_local',fingerprint};
  const migrations=[...requiredMigrations.map(({version,sha256})=>({version,sha256})),...Array.from({length:174-requiredMigrations.length},(_,i)=>({version:String(i).padStart(14,'0'),sha256:sha256(String(i))}))];
  const sourcePlan={ok:true,mode:'plan',readinessScope:'source-only',manifestSha256:manifest,invalid:[],migrations};
  const expectedCount=migrations.length;
  const status={ok:true,mode:'status',manifestSha256:manifest,migrationCount:expectedCount,invalid:[],hashDrifts:[],database:{targetIdentityVerified:true,targetIdentity:identity,appliedCount:expectedCount,pendingCount:0},migrations:sourcePlan.migrations.map(m=>({...m,valid:true,applied:true}))};
  const sections=Object.fromEntries(DATABASE_SEMANTIC_SECTIONS.map(x=>[x.name,{rows:0,objects:[],exactExtras:x.exactExtras===true,sha256:sha256(stableJson([]))}]));
  const snapshot={profile:'public-runtime-contract.v1',sections,sha256:sha256(stableJson(sections))};
  const core={kind:'database-semantic-contract',schemaVersion:1,profile:snapshot.profile,sourceDatabase:identity.databaseName,migrationManifestSha256:manifest,snapshot};
  const semantic={...core,contractSha256:sha256(stableJson(core))};
  const roleUniverse=[{oid:'1',rolname:'owner',rolsuper:false},{oid:'2',rolname:'service_role',rolsuper:false},{oid:'3',rolname:'anon',rolsuper:false},{oid:'4',rolname:'authenticated',rolsuper:false},{oid:'5',rolname:'postgres',rolsuper:true}];
  const functions=PAID_AUTHORITY_FUNCTIONS.map(f=>({signature:f.signature,protectedTable:f.ownerEqualsTableOwner,identity_arguments:f.identityArguments,result:f.result,language:f.language,prokind:f.prokind,provolatile:f.provolatile,proparallel:f.proparallel,prosecdef:f.prosecdef,proisstrict:f.proisstrict,proleakproof:f.proleakproof,proconfig:f.proconfig,bodyLfSha256:f.sourceBodyLfSha256,owner_oid:'1',owner_name:'owner',owner_superuser:false,table_owner_oid:'1',table_owner_name:'owner',ownerMatchesExpectedTable:true,
    directAcl:[{grantor_oid:'1',grantee_oid:'1',grantee_name:'owner',privilege_type:'EXECUTE',is_grantable:true},{grantor_oid:'1',grantee_oid:f.executeAcl.public?'0':'2',grantee_name:f.executeAcl.public?'PUBLIC':'service_role',privilege_type:'EXECUTE',is_grantable:false}],
    effective:roleUniverse.filter(r=>!r.rolsuper).map(r=>({role_oid:r.oid,role_name:r.rolname,execute:f.executeAcl.public===true || r.oid==='1' || r.oid==='2',public_schema_usage:true}))}));
  const authority={targetFingerprint:fingerprint,targetDatabaseName:identity.databaseName,systemIdentifier:'cluster',manifestSha256:manifest,applied:expectedCount,pending:0,databaseWrites:0,providerCalls:0,rollbackAcknowledged:true,serviceSchemaUsage:true,roleUniverse,roleUniverseSha256:sha256(JSON.stringify(roleUniverse)),totalRoleCount:5,nonSuperuserRoleCount:4,selectedSignatureCount:7,functions};
  const index={kind:'application-paid-canary-database-readiness.v1',schemaVersion:1,createdAt:new Date(now).toISOString(),identity,cluster:'cluster',runtime:{...runtime,applicationDatabaseFingerprint:fingerprint,configurationFileSha256:'d'.repeat(64)},manifestSha256:manifest,expectedSemanticSha256:snapshot.sha256,databaseWrites:0,providerCalls:0,liveCatalogEvidence:{path:'live-catalog.json',sha256:'e'.repeat(64)},applicationProbe:{ok:true,state:'ready',contractVersion:databaseContract.contractVersion,missingTables:[],missingColumns:[],missingRpcs:[],missingRpcArguments:[],forbiddenRpcsPresent:[]}};
  const options={values:{'expected-database-target':'127.0.0.1:54322/zimeiti_local','expected-database-identity':fingerprint,'expected-source-version':runtime.sourceVersion,'expected-build-id':runtime.buildId}};
  const liveCatalog={kind:'application-paid-canary-live-catalog.v1',createdAt:index.createdAt,identity:{...identity},cluster:index.cluster,manifestSha256:manifest,runtime:{...runtime},databaseWrites:0,providerCalls:0,output:{ok:true,liveCatalogChecked:true,contractVersion:databaseContract.contractVersion,forwardMigrationCount:178,databaseWrites:0,paidModelCalls:0,liveCatalog:{identity:{database:identity.databaseName,serverPort:identity.serverPort},ledger:requiredMigrations.map(row=>({version:row.version,hash:row.sha256})),functionDependencyEdges:databaseContract.liveCatalogChecks.functionDependencyEdges.map(edge=>({...edge,callerExists:true,calleeExists:true,callerOwner:'owner',relationOwner:'owner',callerSecurityDefiner:true,calleeSecurityDefiner:true,calleeSearchPath:['search_path=public, pg_temp'],callerExecute:true,callerSchemaUsage:true,serviceExecute:true}))}}};
  const evidence={status,semantic,authority,liveCatalog,databaseContract,contractVersion:databaseContract.contractVersion};
  const verify=(i=index,e=evidence,plan=sourcePlan)=>assertPaidDatabaseReadiness(i,e,plan,options,runtime,now,snapshot.sha256);
  let checks=0;assert.equal(verify().verified,true);checks++;
  const clone=x=>structuredClone(x);
  const rejectsEvidence=(mutate,code)=>{const x=clone(evidence);mutate(x);assert.throws(()=>verify(index,x),new RegExp(`PAID_DATABASE_${code}`,'u'));checks++;};
  for(const mutate of [x=>delete x.liveCatalogEvidence,x=>x.liveCatalogEvidence.sha256='invalid',x=>x.liveCatalogEvidence.path='']) {const x=clone(index);mutate(x);assert.throws(()=>verify(x),/PAID_DATABASE_LIVE_CATALOG_REFERENCE/u);checks++;}
  for(const mutate of [x=>x.status.migrationCount=173,x=>x.status.database.appliedCount=173,x=>x.status.migrations.pop(),x=>x.authority.applied=173]) rejectsEvidence(mutate,'STATUS|LEDGER|AUTHORITY_TARGET');
  for(const mutate of [x=>x.liveCatalog.kind='old',x=>x.liveCatalog.createdAt=new Date(now-1800001).toISOString(),x=>x.liveCatalog.createdAt=new Date(now+1).toISOString(),x=>x.liveCatalog.manifestSha256='f'.repeat(64),x=>x.liveCatalog.identity.fingerprint='f'.repeat(64),x=>x.liveCatalog.identity.databaseName='other',x=>x.liveCatalog.identity.configuredHost='other',x=>x.liveCatalog.identity.serverPort='9999',x=>x.liveCatalog.cluster='other',x=>x.liveCatalog.runtime.buildId='old',x=>x.liveCatalog.databaseWrites=1,x=>x.liveCatalog.providerCalls=1,x=>x.liveCatalog.output.ok=false,x=>x.liveCatalog.output.liveCatalogChecked=false,x=>x.liveCatalog.output.contractVersion='old',x=>x.liveCatalog.output.databaseWrites=1,x=>x.liveCatalog.output.paidModelCalls=1,x=>x.liveCatalog.output.liveCatalog.identity.database='other',x=>x.liveCatalog.output.liveCatalog.identity.serverPort='9999']) rejectsEvidence(mutate,'LIVE_CATALOG_');
  for(const mutate of [x=>x.pop(),x=>x[1]=clone(x[0]),x=>x[0].hash='f'.repeat(64)]) rejectsEvidence(x=>mutate(x.liveCatalog.output.liveCatalog.ledger),'LIVE_CATALOG_LEDGER');
  for(const mutate of [x=>x.pop(),x=>x.push(clone(x[0])),x=>x[1]=clone(x[0])]) rejectsEvidence(x=>mutate(x.liveCatalog.output.liveCatalog.functionDependencyEdges),'LIVE_CATALOG_EDGES');
  for(const mutate of [x=>x.caller='other',x=>x.callee='other',x=>x.ownerRelation='other',x=>x.callerExists=false,x=>x.calleeExists=false,x=>x.callerOwner='',x=>x.callerOwner='other',x=>x.callerSecurityDefiner=false,x=>x.calleeSecurityDefiner=false,x=>x.calleeSearchPath=[],x=>x.calleeSearchPath.push('search_path=public, pg_temp'),x=>x.callerExecute=false,x=>x.callerSchemaUsage=false,x=>x.serviceExecute=false]) rejectsEvidence(x=>mutate(x.liveCatalog.output.liveCatalog.functionDependencyEdges[0]),'LIVE_CATALOG_EDGE_');
  for(const mutate of [x=>x.migrations=[],x=>x.migrations[1]=clone(x.migrations[0]),x=>x.migrations.find(row=>row.version===databaseContract.contractVersion).sha256='f'.repeat(64)]) {const x=clone(sourcePlan);mutate(x);assert.throws(()=>verify(index,evidence,x),/PAID_DATABASE_SOURCE_PLAN|PAID_DATABASE_REQUIRED_MIGRATION_SOURCE_HASH/u);checks++;}
  // A fully consistent old 173 bundle still lacks a current required migration.
  const oldPlan=clone(sourcePlan), oldEvidence=clone(evidence);
  oldPlan.migrations=oldPlan.migrations.filter(row=>row.version!==databaseContract.contractVersion);
  oldEvidence.status.migrationCount=oldEvidence.status.database.appliedCount=oldEvidence.authority.applied=oldEvidence.liveCatalog.output.forwardMigrationCount=oldPlan.migrations.length;
  oldEvidence.status.migrations=oldEvidence.status.migrations.filter(row=>row.version!==databaseContract.contractVersion);
  oldEvidence.liveCatalog.output.liveCatalog.ledger=oldEvidence.liveCatalog.output.liveCatalog.ledger.filter(row=>row.version!==databaseContract.contractVersion);
  assert.equal(oldPlan.migrations.length,173);checks++;
  assert.throws(()=>verify(index,oldEvidence,oldPlan),/PAID_DATABASE_REQUIRED_MIGRATION_SOURCE_HASH/u);checks++;
  for(const mutate of [x=>x.kind='original-local-A-upgrade-readiness-readonly.v2',x=>x.schemaVersion=2,x=>x.createdAt=new Date(now-1800001).toISOString(),x=>x.createdAt=new Date(now+60001).toISOString(),x=>x.identity.fingerprint='e'.repeat(64),x=>x.identity.databaseName='zimeiti_restore_fixture',x=>x.runtime.buildId='old',x=>x.runtime.applicationDatabaseFingerprint='e'.repeat(64),x=>x.manifestSha256='e'.repeat(64),x=>x.applicationProbe.state='unknown',x=>x.applicationProbe.missingRpcs=['missing'],x=>x.applicationProbe.forbiddenRpcsPresent=['old'],x=>x.applicationProbe.contractVersion='old',x=>x.providerCalls=1]) {const x=clone(index);mutate(x);assert.throws(()=>verify(x));checks++;}
  for(const mutate of [x=>x.status.database.appliedCount=169,x=>x.status.database.pendingCount=4,x=>x.status.database.targetIdentityVerified=false,x=>x.status.database.targetIdentity.fingerprint='e'.repeat(64),x=>x.status.migrations[0].sha256='e'.repeat(64),x=>x.status.migrations[1]=x.status.migrations[0],x=>x.status.migrations[0].applied=false,x=>x.status.hashDrifts=['drift'],x=>x.semantic.contractSha256='e'.repeat(64),x=>x.semantic.snapshot.sections.tables.sha256='e'.repeat(64),x=>x.authority.systemIdentifier='other',x=>x.authority.functions.pop(),x=>x.authority.functions[1]=x.authority.functions[0],x=>x.authority.functions[0].bodyLfSha256='e'.repeat(64),x=>x.authority.functions[0].owner_oid='2',x=>x.authority.functions[0].prosecdef=false,x=>x.authority.functions[0].directAcl.push({grantee_oid:'3',grantee_name:'anon',privilege_type:'EXECUTE'}),x=>x.authority.functions[0].effective[2].execute=true,x=>x.authority.functions[0].effective.pop(),x=>x.authority.serviceSchemaUsage=false,x=>x.authority.functions[0].effective[1].public_schema_usage=false,x=>x.authority.roleUniverseSha256='e'.repeat(64)]) {const x=clone(evidence);mutate(x);assert.throws(()=>verify(index,x));checks++;}
  assert.throws(()=>assertPaidDatabaseReadiness(index,evidence,sourcePlan,options,runtime,now));checks++; // live fixed snapshot pin rejects arbitrary synthetic root.
  return checks;
}

export async function runPaidHarnessSelfTest() {
  await assertPaidCanonicalFunctionSources();
  let checks=runPaidReadinessSelfTest()+1;
  checks += await runPaidDownloadSelfTest();
  const ok=(fn)=>{ fn(); checks++; };
  const bad=(fn)=>{assert.throws(fn);checks++;};
  const id='b5cccb94-1d77-4e14-9391-fb3e6f823486';
  const pins=['--execute',`--user-id=${id}`,'--actor-role=admin','--expected-source-version=R001006','--expected-build-id=test-build','--max-charge=1','--remaining-budget=20','--database-readiness=fixture.json','--database-readiness-sha256='+ 'a'.repeat(64),'--expected-database-target=127.0.0.1:54322/zimeiti_local','--expected-database-identity='+ 'b'.repeat(64)];
  const parse=args=>parsePaidHarnessArgs(args,['execute','self-test']);
  ok(()=>assert.equal(parse([]).actorRole,'student'));
  ok(()=>assert.equal(parse(pins).actorRole,'admin'));
  for(const key of ['user-id','expected-source-version','expected-build-id','max-charge','remaining-budget','database-readiness','database-readiness-sha256','expected-database-target','expected-database-identity']) bad(()=>parse(pins.filter(arg=>!arg.startsWith(`--${key}=`))));
  for(const args of [['--actor-role=admin'],['--max-charge=NaN'],['--max-charge=21'],['--max-charge=2','--remaining-budget=1'],['--bogus=1'],['--actor-role=student','--actor-role=admin'],['--execute=true']]) bad(()=>parse(args));
  const paid=parse(pins);
  ok(()=>assertPaidActor({user:{id,role:'admin'}},paid));
  bad(()=>assertPaidActor({user:{id,role:'student'}},paid));
  bad(()=>assertPaidActor({user:{id:'other',role:'admin'}},paid));
  const model={publicPrice:.1,capabilities:{available:true,generationReady:true,nativeDurations:[4],resolutionOptions:['720p'],billingUnit:'per_use'}};
  ok(()=>assert.equal(publicVideoQuote(model,4,'720p',paid),.1));
  ok(()=>assert.equal(publicVideoQuote({...model,capabilities:{...model.capabilities,billingUnit:'output_second'}},4,'720p',paid),.4));
  for(const [m,d,r] of [[model,5,'720p'],[model,4,'480p'],[{...model,publicPrice:2},4,'720p'],[{...model,capabilities:{...model.capabilities,generationReady:false}},4,'720p']]) bad(()=>publicVideoQuote(m,d,r,paid));
  for(const mode of ['provider_url','inline_ephemeral']) {
    const body={deliveryMode:mode,recordId:'a'.repeat(64),cashCharged:.1,billingReferenceId:'image:fixture',images:[{url:mode==='inline_ephemeral'?'data:image/png;base64,SECRET':'/api/media-history/content?recordId=fixture'}]};
    const receipt=projectImageDelivery(body);
    const status={...receipt,mediaAvailable:false,canRecover:false,images:[]};
    ok(()=>assertImageReceiptBinding(receipt,status));
    for(const change of [{recordId:'b'.repeat(64)},{cashCharged:2},{billingReferenceId:'other'},{deliveryMode:'other'}]) bad(()=>assertImageReceiptBinding(receipt,{...status,...change}));
    if(mode==='inline_ephemeral') for(const change of [{mediaAvailable:true},{canRecover:true},{images:[{url:'data:image/png;base64,SECRET'}]}]) bad(()=>assertImageReceiptBinding(receipt,{...status,...change}));
    ok(()=>assert.ok(!JSON.stringify(receipt).includes('SECRET')));
  }
  const final={actor:{role:'admin'},expectedRole:'admin',completed:true,cashDelta:.1,quote:.1,newCashRows:1,generationPosts:1};
  ok(()=>assertPaidFinalPass(final));
  for(const change of [{completed:false},{cashDelta:.2},{newCashRows:2},{generationPosts:2},{actor:{role:'student'}}]) bad(()=>assertPaidFinalPass({...final,...change}));
  ok(()=>assert.equal(projectImageDelivery({cashCharged:.1,images:[{assetId:'asset'}]}).deliveryMode,'legacy_owned'));
  bad(()=>projectImageDelivery({cashCharged:.1,images:[{url:'https://invalid'}]}));
  const count={attempts:0,forwarded:0}; let forwarded=0,aborted=0;
  const route=(body,method='POST')=>({request:()=>({method:()=>method,postDataJSON:()=>body}),continue:async()=>{forwarded++;},abort:async()=>{aborted++;}});
  const guard=makePaidPostGuard({surface:'video-page',model_id:'public',duration:4},count);
  await guard(route({surface:'video-page',model_id:'public',duration:4})); checks++;
  await assert.rejects(guard(route({surface:'video-page',model_id:'public',duration:4}))); checks++;
  for(const change of [{surface:'other'},{model_id:'other'},{duration:5}]) {
    await assert.rejects(makePaidPostGuard({surface:'video-page',model_id:'public',duration:4})(route({surface:'video-page',model_id:'public',duration:4,...change}))); checks++;
  }
  ok(()=>assert.equal(forwarded,1)); ok(()=>assert.equal(aborted,4));
  let releaseFresh; let freshCalls=0, actualForwards=0, actualAborts=0;
  const deferred=new Promise(resolve=>{releaseFresh=resolve;});
  const metrics=()=>({generationPostAttempts:0,generationPostsContinued:0,duplicateGenerationPostsBlocked:0});
  const mockRoute=()=>({request:()=>({method:()=> 'POST',postDataJSON:()=>({modelId:'public'})}),continue:async()=>{actualForwards++;},abort:async()=>{actualAborts++;}});
  const diagnostics=metrics();
  const actualHandler=makeWorkbenchPaidPostHandler({diagnostics,isArmed:()=>true,expected:{modelId:'public'},checkFresh:async()=>{freshCalls++;await deferred;}});
  const first=actualHandler(mockRoute()),second=actualHandler(mockRoute());
  assert.equal(freshCalls,1);checks++;assert.equal(actualAborts,1);checks++;
  releaseFresh();await Promise.all([first,second]);
  assert.equal(actualForwards,1);checks++;assert.equal(diagnostics.generationPostsContinued,1);checks++;
  const disarmed=makeWorkbenchPaidPostHandler({diagnostics:metrics(),isArmed:()=>false,expected:{modelId:'public'},checkFresh:async()=>{throw Error('UNREACHED');}});
  await disarmed(mockRoute());assert.equal(actualForwards,1);checks++;
  const broken=makeWorkbenchPaidPostHandler({diagnostics:metrics(),isArmed:()=>true,expected:{modelId:'public'},checkFresh:async()=>{throw Error('UPPERCASE_EXTERNAL_SECRET');}});
  await assert.rejects(broken(mockRoute()));checks++;await broken(mockRoute());assert.equal(actualForwards,1);checks++;
  for(const [expected,body] of [[{prompt:'intended'},{prompt:'other'}],[{image_ref:{schema:'generated_image_ref.v1',recordId:'a'.repeat(64)}},{image_ref:{schema:'generated_image_ref.v1',recordId:'b'.repeat(64)}}],[{image_storage_key:'owned/key'},{image_storage_key:'another/key'}]]) {
    const installed=makeWorkbenchPaidPostHandler({diagnostics:metrics(),isArmed:()=>true,expected,checkFresh:async()=>undefined});
    const wrong={...mockRoute(),request:()=>({method:()=> 'POST',postDataJSON:()=>body})};
    await assert.rejects(installed(wrong));assert.equal(actualForwards,1);checks++;
  }
  assert.equal(safeHarnessErrorCode(Error('UPPERCASE_EXTERNAL_SECRET')),'HARNESS_FAILURE_STOPPED');checks++;
  const safe=JSON.stringify(safeHarnessEvidence({prompt:'private',src:'blob:secret',responseBody:{base64:'secret'},recordId:'a'.repeat(64),cashCharged:.1,error:'PRIVATE',url:'https://secret?token=x'}));
  ok(()=>assert.ok(!/secret|private|PRIVATE/u.test(safe))); ok(()=>assert.ok(safe.includes('cashCharged')));
  // Actual image argv parser, not a keyword assertion.
  ok(()=>assert.equal(parseArgs(['--run-id=fixture01']).paid.actorRole,'student'));
  bad(()=>parseArgs(['--run-id=fixture01','--run-id=fixture02']));
  bad(()=>parseArgs(['--run-id=fixture01','--execute']));
  console.log(JSON.stringify({kind:'paid-harness-core-selftest',status:'PASS',checks,dbCalls:0,browserRuns:0,paidPosts:0}));
  return {checks};
}

async function acceptDirectWorkbench({page,body,report,options,token,identity,before,outputDir,prompt,aspectRatio,resolution}) {
  const receipt=projectImageDelivery(body);
  report.deliveryReceipt=receipt;
  assertPaidQuote(receipt.cashCharged,options.paid);
  assert.equal(receipt.cashCharged,report.billing.quotedPrice,'HARNESS_IMAGE_CHARGE_QUOTE_DRIFT');
  const card=page.locator('article').filter({has:page.getByLabel('第 1 张图片提示词',{exact:true})});
  const image=card.locator('img').first();
  report.rendered=await waitForImageDecoded(image);
  assert.ok(report.rendered.complete && report.rendered.width>0 && report.rendered.height>0,'HARNESS_IMAGE_NOT_DECODED');
  report.pageDownload=await capturePaidDownload(page,card.getByRole('button',{name:'下载图片',exact:true}),outputDir);
  report.decodedAspect=assertDecodedImageAspect(report.pageDownload,aspectRatio);
  const status=await getJson(options.origin,`/api/image/status?${new URLSearchParams({clientIdempotencyKey:report.request.clientIdempotencyKey,clientTraceId:report.request.clientTraceId})}`,token);
  assertImageReceiptBinding(receipt,status);
  assertProviderImageEvidence(status,report,prompt,aspectRatio,resolution,options.imageCount);
  report.deliveryReceipt=receipt;
  report.persistedReceiptBefore=await readWorkbenchDeliveryReceipt(page,receipt,identity.user.id);
  await page.reload({waitUntil:'domcontentloaded'});
  const restored=page.locator('article').filter({hasText:receipt.recordId});
  await restored.waitFor({state:'visible',timeout:45000});
  if(receipt.deliveryMode==='inline_ephemeral') assert.equal(await restored.locator('img').count(),0,'HARNESS_INLINE_MEDIA_AFTER_REFRESH');
  report.persistedReceiptAfter=await readWorkbenchDeliveryReceipt(page,receipt,identity.user.id);
  assert.equal(report.diagnostics.generationPostsContinued,1,'HARNESS_REFRESH_REPOST');
  const after=await readAccountEvidence(options.origin,token,identity.user.id);
  const rows=newRows(before.walletTransactions,after.walletTransactions);
  assert.equal(rows.length,1,'HARNESS_IMAGE_EXACTLY_ONE_CASH_ROW');
  assert.equal(rows[0].referenceId,receipt.billingReferenceId,'HARNESS_IMAGE_LEDGER_BINDING');
  assert.equal(roundMoney(before.cash-after.cash),receipt.cashCharged,'HARNESS_IMAGE_BALANCE_MISMATCH');
  assert.equal(before.credits,after.credits,'HARNESS_IMAGE_UNEXPECTED_CREDITS');
  assert.equal(before.reservedCredits,after.reservedCredits,'HARNESS_IMAGE_RESERVATION_NOT_RELEASED');
  assert.equal(after.imageAssetTotal,before.imageAssetTotal,'HARNESS_DIRECT_BACKUP_CREATED');
  assert.equal(report.diagnostics.nonGenerationMutations.some(item=>['/api/image-workbench/persist','/api/image-workbench/history'].includes(item.path)),false,'HARNESS_DIRECT_PERSIST_REQUEST');
  assert.equal(report.diagnostics.pageErrors.length,0,'HARNESS_PAGE_ERRORS');
  assertPaidFinalPass({actor:identity.user,expectedRole:options.paid.actorRole,completed:true,cashDelta:before.cash-after.cash,quote:receipt.cashCharged,newCashRows:rows.length,generationPosts:report.diagnostics.generationPostsContinued});
  report.billing.after=after; report.billing.cashDelta=receipt.cashCharged;
  report.records={recordId:receipt.recordId,requestState:status.state,deliveryMode:receipt.deliveryMode,mediaRecoverable:receipt.deliveryMode==='provider_url'};
  report.runtimeAfter=await runtimeIdentity(options); assert.deepEqual(report.runtimeAfter,report.runtime,'HARNESS_RUNTIME_CHANGED');
  report.status='passed'; report.completedAt=new Date().toISOString();
}

export function assertProviderImageEvidence(status,report,prompt,aspectRatio,resolution,imageCount) {
    const providerEvidence = status?.providerEvidence;
    assert.equal(providerEvidence?.ready, true, "IMAGE_PROVIDER_EVIDENCE_READBACK_REQUIRED");
    assert.match(String(providerEvidence?.actualPayloadSha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_WIRE_HASH_INVALID");
    assert.match(String(providerEvidence?.dispatchReceiptId || ""), /^[A-Za-z0-9_-]{8,128}$/u, "IMAGE_PROVIDER_DISPATCH_RECEIPT_ID_INVALID");
    assert.match(String(providerEvidence?.submissionReceiptId || ""), /^[A-Za-z0-9_-]{8,128}$/u, "IMAGE_PROVIDER_SUBMISSION_RECEIPT_ID_INVALID");
    assert.match(String(providerEvidence?.dispatchReceiptSha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_DISPATCH_RECEIPT_HASH_INVALID");
    assert.match(String(providerEvidence?.submissionReceiptSha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_SUBMISSION_RECEIPT_HASH_INVALID");
    assert.equal(providerEvidence?.transportState, "response_received", "IMAGE_PROVIDER_TRANSPORT_RECEIPT_NOT_CONFIRMED");
    assert.equal(providerEvidence?.providerProtocol, report.generation.providerProtocol, "IMAGE_PROVIDER_PROTOCOL_RECEIPT_MISMATCH");
    assert.ok(Number(providerEvidence?.actualPayloadBytes) > 0, "IMAGE_PROVIDER_WIRE_BYTES_INVALID");
    assert.ok(Number(providerEvidence?.responseStatus) >= 200 && Number(providerEvidence?.responseStatus) < 300, "IMAGE_PROVIDER_RESPONSE_STATUS_INVALID");
    assert.match(String(providerEvidence?.responseBodySha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_RESPONSE_HASH_INVALID");
    assert.equal(providerEvidence?.requestProjection?.userPromptSha256, sha256(prompt), "IMAGE_PROVIDER_USER_PROMPT_HASH_MISMATCH");
    assert.equal(providerEvidence?.requestProjection?.aspectRatio, aspectRatio, "IMAGE_PROVIDER_ASPECT_RATIO_RECEIPT_MISMATCH");
    assert.equal(providerEvidence?.requestProjection?.resolution, resolution, "IMAGE_PROVIDER_RESOLUTION_RECEIPT_MISMATCH");
    assert.equal(providerEvidence?.requestProjection?.imageCount, imageCount, "IMAGE_PROVIDER_IMAGE_COUNT_RECEIPT_MISMATCH");
    report.providerEvidence.readback = providerEvidence;
}

function argumentValue(args, prefix, fallback = "") {
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
}

export function parseArgs(args) {
  const paid = parsePaidHarnessArgs(args, ['run-id','origin','model-id','model-name','prompt','resolution','aspect-ratio','image-count','execute','help','self-test']);
  const promptExplicit = args.some((value) => value.startsWith("--prompt="));
  const resolutionExplicit = args.some((value) => value.startsWith("--resolution="));
  const aspectRatioExplicit = args.some((value) => value.startsWith("--aspect-ratio="));
  const imageCountExplicit = args.some((value) => value.startsWith("--image-count="));
  const fixedInputArgumentCount = [promptExplicit, resolutionExplicit, aspectRatioExplicit, imageCountExplicit]
    .filter(Boolean).length;
  const options = {
    paid,
    execute: false,
    runId: argumentValue(args, "--run-id="),
    origin: argumentValue(args, "--origin=", DEFAULT_ORIGIN).replace(/\/+$/u, ""),
    expectedSourceVersion: argumentValue(args, "--expected-source-version="),
    expectedBuildId: argumentValue(args, "--expected-build-id="),
    modelId: argumentValue(args, "--model-id="),
    modelName: argumentValue(args, "--model-name=", DEFAULT_MODEL_NAME),
    modelNameExplicit: args.some((value) => value.startsWith("--model-name=")),
    prompt: argumentValue(args, "--prompt=", DEFAULT_PROMPT),
    resolution: argumentValue(args, "--resolution="),
    aspectRatio: argumentValue(args, "--aspect-ratio="),
    imageCount: Number(argumentValue(args, "--image-count=", "1")),
    acceptanceProfile: fixedInputArgumentCount === 4 ? "fixed-prompt-adherence" : "smoke",
  };
  for (const argument of args) {
    if (argument === "--execute") options.execute = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--run-id=", "--origin=", "--expected-source-version=", "--expected-build-id=", "--model-id=", "--model-name=", "--prompt=", "--resolution=", "--aspect-ratio=", "--image-count="].some((prefix) => argument.startsWith(prefix))) continue;
    else if (/^--(?:actor-role|user-id|expected-source-version|expected-build-id|max-charge|remaining-budget|database-readiness|database-readiness-sha256|expected-database-target|expected-database-identity)=/u.test(argument) || argument === '--self-test') continue;
    else throw new Error('UNKNOWN_ARGUMENT');
  }
  assert.match(options.runId, RUN_ID, "UNIQUE_RUN_ID_REQUIRED");
  assert.ok(ALLOWED_ORIGINS.has(options.origin), "LOCAL_ACCEPTANCE_ORIGIN_REQUIRED");
  if (options.expectedSourceVersion) assert.match(options.expectedSourceVersion, SAFE_ID, "INVALID_EXPECTED_SOURCE_VERSION");
  if (options.expectedBuildId) assert.match(options.expectedBuildId, SAFE_ID, "INVALID_EXPECTED_BUILD_ID");
  if (options.modelId) assert.match(options.modelId, SAFE_ID, "INVALID_MODEL_ID");
  assert.ok(options.modelName.length <= 200, "INVALID_MODEL_NAME");
  assert.equal(fixedInputArgumentCount === 0 || fixedInputArgumentCount === 4, true, "FIXED_PROMPT_REQUIRES_PROMPT_RESOLUTION_ASPECT_RATIO_AND_IMAGE_COUNT");
  assert.ok(options.prompt.length > 0 && options.prompt.length <= 4_000 && !options.prompt.includes("\u0000"), "INVALID_PROMPT");
  if (options.acceptanceProfile === "fixed-prompt-adherence") {
    assert.equal(SUPPORTED_RESOLUTION_ARGUMENTS.has(options.resolution), true, "INVALID_RESOLUTION");
    assert.equal(SUPPORTED_ASPECT_RATIO_ARGUMENTS.has(options.aspectRatio), true, "INVALID_ASPECT_RATIO");
    assert.equal(options.imageCount, 1, "IMAGE_WORKBENCH_FIXED_SUITE_REQUIRES_ONE_IMAGE");
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    `  node ${SCRIPT_PATH} --run-id=<unique-id>`,
    `  node scripts/with-local-customer-session.mjs ${SCRIPT_PATH} --run-id=<unique-id> --execute [options]`,
    "",
    "Default mode is a zero-network, zero-generation plan. --execute requires an ordinary local member session.",
    "Before browser creation, --execute requires externally pinned current application DB A173/full semantic/function authority/REST readiness evidence.",
    "The one real generation POST is emitted only by clicking the AI生图工作台 page button; this verifier never submits it through fetch/API code.",
    "",
    "Options:",
    "  --expected-source-version=<value>  additionally lock the current sourceVersion",
    "  --expected-build-id=<value>        additionally lock the current Build ID",
    "  --model-id=<public-id>             choose one visible public image model",
    `  --model-name=<display-name>        fallback display-name match (default: ${DEFAULT_MODEL_NAME})`,
    "  --prompt=<exact-prompt>             fixed prompt-adherence prompt; requires the next three options",
    "  --resolution=<1K|2K|4K>            require an explicitly advertised resolution",
    "  --aspect-ratio=<ratio>              require an explicitly advertised aspect ratio",
    "  --image-count=1                     fixed image-workbench suite supports exactly one image",
    "",
    "Database readiness admits the browser flow; actual provider completion remains unverified until",
    "the redacted provider request-body hash and submission receipt are read back by owner-scoped status GET.",
  ].join("\n");
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function redactText(value, token = "") {
  let text = String(value || "");
  if (token) text = text.replaceAll(token, "[REDACTED_TOKEN]");
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, "$1?[REDACTED_QUERY]")
    .slice(0, 1200);
}

function pathnameOnly(url) {
  try { return new URL(url).pathname; } catch { return "invalid-url"; }
}

function securitySummary(value, tableOwner) {
  const executeGrantees = Array.isArray(value?.executeGrantees) ? value.executeGrantees.map(String) : [];
  const expectedGrantees = [String(tableOwner || ""), "service_role"].filter(Boolean).sort();
  return {
    owner: String(value?.owner || ""),
    ownerMatchesTable: Boolean(tableOwner) && value?.owner === tableOwner,
    securityDefiner: value?.securityDefiner === true,
    searchPathReady: Array.isArray(value?.searchPath)
      && value.searchPath.length === 1
      && value.searchPath[0] === "search_path=public, pg_temp",
    executeGrantees,
    executeAclExact: JSON.stringify([...executeGrantees].sort()) === JSON.stringify(expectedGrantees),
  };
}

function runReadinessChecker(script) {
  const startedAtMs = Date.now();
  const childEnvironment = { ...process.env };
  for (const key of [
    "R267_CUSTOMER_TOKEN",
    "LOCAL_NAV_READONLY_CUSTOMER",
    "LOCAL_NAV_ADMIN_TOKEN",
    "AUTH_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) delete childEnvironment[key];
  const result = spawnSync(process.execPath, [path.resolve(PROJECT_ROOT, script)], {
    cwd: PROJECT_ROOT,
    env: childEnvironment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const completedAtMs = Date.now();
  const body = parseJson(result.stdout, null);
  const checkedAtMs = Date.parse(String(body?.checkedAt || ""));
  return {
    script,
    exitCode: result.status,
    signal: result.signal || null,
    processError: result.error ? String(result.error.code || result.error.name || "checker-error") : null,
    fresh: Number.isFinite(checkedAtMs)
      && checkedAtMs >= startedAtMs - 1_000
      && checkedAtMs <= completedAtMs + 1_000,
    body,
  };
}

function localDatabaseReadiness() {
  const [snapshotResult, alignmentResult, receiptResult] = READINESS_CHECKERS.map(runReadinessChecker);
  const snapshot = snapshotResult.body;
  const alignment = alignmentResult.body;
  const receipt = receiptResult.body;
  const live = snapshot?.live;
  const snapshotSummary = {
    checker: snapshotResult.script,
    exitCode: snapshotResult.exitCode,
    signal: snapshotResult.signal,
    processError: snapshotResult.processError,
    checkedAt: snapshot?.checkedAt || null,
    fresh: snapshotResult.fresh,
    target: snapshot?.target || null,
    migration: {
      file: snapshot?.migration || null,
      sha256: snapshot?.migrationHash || null,
      ledgerPresent: snapshot?.ledgerPresent === true,
      ledgerHashMatches: snapshot?.ledgerHashMatches === true,
    },
    ownerAlignmentMigration: {
      file: snapshot?.ownerAlignment?.migration || null,
      sha256: snapshot?.ownerAlignment?.migrationHash || null,
      ledgerPresent: snapshot?.ownerAlignment?.ledgerPresent === true,
      ledgerHashMatches: snapshot?.ownerAlignment?.ledgerHashMatches === true,
    },
    liveSemantics: {
      acceptsV2: live?.acceptsV2 === true,
      acceptsHalfK: live?.acceptsHalfK === true,
      accepts3K: live?.accepts3K === true,
      validatesV2Integrity: live?.validatesV2Integrity === true,
      reconcilesV2: live?.reconcilesV2 === true,
    },
    claimFunction: securitySummary(live?.security, live?.tableOwner),
    reconciliationFunction: securitySummary(live?.reconciliationSecurity, live?.tableOwner),
    snapshotMigrationReady: snapshot?.snapshotMigrationReady === true,
    finalOwnerAlignmentReady: snapshot?.finalOwnerAlignmentReady === true,
    ready: snapshot?.ready === true,
  };
  const alignmentFunctions = Array.isArray(alignment?.live?.functions) ? alignment.live.functions : [];
  const alignmentSummary = {
    checker: alignmentResult.script,
    exitCode: alignmentResult.exitCode,
    signal: alignmentResult.signal,
    processError: alignmentResult.processError,
    checkedAt: alignment?.checkedAt || null,
    fresh: alignmentResult.fresh,
    target: alignment?.target || null,
    migration: {
      file: alignment?.migration || null,
      sha256: alignment?.migrationHash || null,
      ledgerPresent: alignment?.ledgerPresent === true,
      hashVerifiedByReadyResult: alignment?.ready === true,
    },
    functions: alignmentFunctions.map(item => ({
      signature: item.signature,
      ...securitySummary(item, alignment?.live?.tableOwner),
      privileges: item.privileges,
    })),
    ready: alignment?.ready === true,
  };
  const receiptFunctions = Array.isArray(receipt?.live?.functions) ? receipt.live.functions : [];
  const receiptSummary = {
    checker: receiptResult.script,
    exitCode: receiptResult.exitCode,
    signal: receiptResult.signal,
    processError: receiptResult.processError,
    checkedAt: receipt?.checkedAt || null,
    fresh: receiptResult.fresh,
    target: receipt?.target || null,
    migration: {
      file: receipt?.migration || null,
      sha256: receipt?.migrationHash || null,
      ledgerPresent: receipt?.ledgerPresent === true,
      ledgerHashMatches: receipt?.ledgerHashMatches === true,
    },
    columns: Array.isArray(receipt?.live?.columns) ? receipt.live.columns : [],
    receiptOrderConstraintValidated: receipt?.live?.receiptOrderConstraintValidated === true,
    functions: receiptFunctions.map(item => ({
      signature: item.signature,
      owner: item.owner,
      securityDefiner: item.securityDefiner === true,
      searchPath: item.searchPath,
      executeGrantees: item.executeGrantees,
      serviceRole: item.serviceRole === true,
      receiptAware: item.receiptAware === true,
      privileges: item.privileges,
    })),
    ready: receipt?.ready === true,
  };
  const ready = snapshotResult.exitCode === 0
    && alignmentResult.exitCode === 0
    && receiptResult.exitCode === 0
    && snapshotResult.fresh
    && alignmentResult.fresh
    && receiptResult.fresh
    && snapshot?.target === LOCAL_DATABASE_TARGET
    && alignment?.target === LOCAL_DATABASE_TARGET
    && receipt?.target === LOCAL_DATABASE_TARGET
    && snapshotSummary.migration.ledgerHashMatches
    && snapshotSummary.ownerAlignmentMigration.ledgerHashMatches
    && snapshotSummary.snapshotMigrationReady
    && snapshotSummary.finalOwnerAlignmentReady
    && snapshotSummary.ready
    && alignmentSummary.migration.ledgerPresent
    && alignmentSummary.ready
    && receiptSummary.migration.ledgerPresent
    && receiptSummary.migration.ledgerHashMatches
    && receiptSummary.ready;
  return {
    checkedImmediatelyBeforeBrowser: true,
    localTargetRequired: LOCAL_DATABASE_TARGET,
    snapshot: snapshotSummary,
    ownerAlignment: alignmentSummary,
    providerReceipts: receiptSummary,
    ready,
  };
}

export function publicModelProjection(model) {
  const resolutionPrices = {};
  const rawResolutionPrices = model?.capabilities?.resolutionPrices;
  if (Array.isArray(rawResolutionPrices)) {
    for (const entry of rawResolutionPrices) {
      const match = String(entry || "").match(/^\s*(1K|2K|4K)\s*=\s*(\d+(?:\.\d+)?)\s*$/u);
      if (match) resolutionPrices[match[1]] = Number(match[2]);
    }
  } else if (rawResolutionPrices && typeof rawResolutionPrices === "object") {
    for (const [key, value] of Object.entries(rawResolutionPrices)) {
      if (["1K", "2K", "4K"].includes(key) && Number.isFinite(Number(value))) resolutionPrices[key] = Number(value);
    }
  }
  return {
    id: String(model?.id || ""),
    displayName: String(model?.displayName || ""),
    variantLabel: String(model?.variantLabel || ""),
    publicPrice: Number(model?.publicPrice),
    available: model?.capabilities?.available !== false,
    priceReady: model?.capabilities?.priceReady !== false,
    aspectRatios: Array.isArray(model?.capabilities?.aspectRatios) ? model.capabilities.aspectRatios : [],
    resolutionOptions: Array.isArray(model?.capabilities?.resolutionOptions) ? model.capabilities.resolutionOptions : [],
    defaultResolution: String(model?.capabilities?.defaultResolution || ""),
    resolutionPrices,
  };
}

export function quotedModelPrice(model, resolution) {
  return Number(model?.resolutionPrices?.[resolution] ?? model?.publicPrice);
}

export function imageAspectSupport(model, options, aspectRatio) {
  if (model.aspectRatios.includes(aspectRatio)) return { aspectBasis:"catalog-advertised", advertisedAspectSupport:"supported" };
  assert.ok(options.acceptanceProfile === "smoke" && !options.aspectRatio && model.aspectRatios.length === 0 && aspectRatio === "1:1", "NO_AVAILABLE_PUBLIC_IMAGE_MODEL_SUPPORTS_REQUESTED_PARAMETERS");
  return { aspectBasis:"ui-default-with-catalog-unspecified", advertisedAspectSupport:"unknown" };
}

export function assertFreshImageModel(selected, current, options, resolution, aspectRatio, quotedPrice) {
  assert.ok(current?.available && current.priceReady && current.resolutionOptions.includes(resolution), "IMAGE_MODEL_DRIFT_BEFORE_FORWARD");
  assert.equal(quotedModelPrice(current,resolution),quotedPrice,"IMAGE_PRICE_DRIFT_BEFORE_FORWARD");
  assert.deepEqual(current,selected,"IMAGE_CATALOG_PROJECTION_DRIFT_BEFORE_FORWARD");
  return imageAspectSupport(current,options,aspectRatio);
}

export function modelSupportsRequestedImageParameters(model, resolution, aspectRatio) {
  return Boolean(
    model?.id
    && model.available === true
    && model.priceReady === true
    && Array.isArray(model.resolutionOptions)
    && model.resolutionOptions.includes(resolution)
    && Array.isArray(model.aspectRatios)
    && model.aspectRatios.includes(aspectRatio)
    && Number.isFinite(quotedModelPrice(model, resolution))
    && quotedModelPrice(model, resolution) >= 0
  );
}

export function selectPublicImageModel(publicModels, options) {
  if (options.acceptanceProfile === "fixed-prompt-adherence") {
    const eligible = publicModels.filter((model) => modelSupportsRequestedImageParameters(
      model,
      options.resolution,
      options.aspectRatio,
    ));
    if (options.modelId) return eligible.find((model) => model.id === options.modelId) || null;
    if (options.modelNameExplicit) {
      return eligible.find((model) => model.displayName === options.modelName)
        || eligible.find((model) => model.displayName.includes(options.modelName))
        || null;
    }
    return eligible[0] || null;
  }
  return (options.modelId ? publicModels.find((model) => model.id === options.modelId) : null)
    || publicModels.find((model) => model.displayName === options.modelName)
    || publicModels.find((model) => model.displayName.includes(options.modelName))
    || publicModels.find((model) => model.available && model.priceReady)
    || null;
}

function providerEvidenceReadbackContract() {
  return {
    requiredFor: "actual provider submission receipt readback",
    enforced: true,
    readbackStage: "after generation, from owner-scoped status GET",
    inspectedReadbacks: {
      generationResponse: {
        available: ["providerProtocol", "payloadFingerprint"],
        insufficientBecause: "payloadFingerprint hashes the platform request contract and routing bindings, not the serialized provider request body",
      },
      imageStatus: {
        available: ["actualPayloadSha256", "dispatchReceiptId", "submissionReceiptId", "responseBodySha256", "hashedProviderAcknowledgement"],
        ownerScoped: true,
      },
      imageTrace: {
        available: ["phase", "traceId", "modelId", "promptHash", "outputObjectLocator"],
        insufficientBecause: "the redacted runtime trace contains neither the provider request-body hash nor a provider response receipt",
      },
      accountHistory: {
        insufficientBecause: "history records the user request and delivered asset, not the server-to-provider dispatch evidence",
      },
    },
    note: "The UI request hash remains distinct from the immutable hash of the final serialized provider wire body.",
  };
}

async function getJson(origin, pathname, token = "") {
  const response = await fetch(`${origin}${pathname}`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `READ_ONLY_PREFLIGHT_FAILED:${pathname}:${response.status}`);
  return body;
}

export async function runtimeIdentity(options) {
  const runtimeVersion = await getJson(options.origin, "/api/version");
  assert.ok(runtimeVersion?.sourceVersion && runtimeVersion?.buildId, "RUNTIME_IDENTITY_INCOMPLETE");
  const [diskVersionText, diskBuildId, receiptText] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public/version.json"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "BUILD_ID"), "utf8").then((value) => value.trim()),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  const diskVersion = JSON.parse(diskVersionText);
  const receipt = JSON.parse(receiptText);
  const fingerprint = computeLocalBuildFingerprint(PROJECT_ROOT);
  const runningLatest = runtimeVersion.sourceVersion === diskVersion.sourceVersion
    && runtimeVersion.buildId === diskBuildId
    && receipt.buildId === diskBuildId
    && receipt.fingerprint === fingerprint.fingerprint
    && receipt.fileCount === fingerprint.fileCount;
  assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");
  if (options.expectedSourceVersion) assert.equal(runtimeVersion.sourceVersion, options.expectedSourceVersion, "EXPECTED_SOURCE_VERSION_MISMATCH");
  if (options.expectedBuildId) assert.equal(runtimeVersion.buildId, options.expectedBuildId, "EXPECTED_BUILD_ID_MISMATCH");
  return {
    sourceVersion: runtimeVersion.sourceVersion,
    buildId: runtimeVersion.buildId,
    diskSourceVersion: diskVersion.sourceVersion,
    sourceFingerprint: fingerprint.fingerprint,
    sourceFingerprintCurrent: true,
    runningLatest,
  };
}

async function readBalances(origin, token, userId) {
  const [cash, credits] = await Promise.all([
    getJson(origin, "/api/cash/balance", token),
    getJson(origin, `/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, token),
  ]);
  return {
    cash: Number(cash?.balance),
    credits: Number(credits?.credits),
    reservedCredits: Number(credits?.reservedCredits),
    memberStatus: String(credits?.memberStatus || ""),
  };
}

function walletTransactionProjection(row) {
  return {
    id: String(row?.id || ""),
    type: String(row?.type || ""),
    amount: Number(row?.amount),
    balanceAfter: Number(row?.balanceAfter),
    referenceId: row?.referenceId || null,
    createdAt: row?.createdAt || null,
  };
}

function assetProjection(file) {
  return {
    id: String(file?.id || ""),
    category: String(file?.file_category || ""),
    size: Number(file?.file_size),
    contentType: String(file?.content_type || ""),
    createdAt: file?.created_at || null,
  };
}

function historyProjection(history) {
  const records = Array.isArray(history?.records) ? history.records : [];
  return records.map((record) => ({
    id: String(record?.id || ""),
    createdAt: record?.createdAt ?? null,
    items: (Array.isArray(record?.items) ? record.items : []).map((item) => ({
      assetId: item?.assetId || null,
      historyRecordId: item?.historyRecordId || null,
      taskId: item?.taskId || null,
      operationId: item?.operationId || null,
      cashCharged: item?.cashCharged ?? null,
    })),
  }));
}

async function readAccountEvidence(origin, token, userId) {
  const [balances, transactions, assets, history] = await Promise.all([
    readBalances(origin, token, userId),
    getJson(origin, "/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50", token),
    getJson(origin, "/api/storage/files?category=image&limit=100&offset=0", token),
    getJson(origin, "/api/image-workbench/history?page=1", token),
  ]);
  const walletTransactions = (transactions?.data?.transactions || [])
    .filter((row) => row?.category === "cash")
    .map(walletTransactionProjection);
  return {
    ...balances,
    walletTransactions,
    walletTransactionTotal: Number(transactions?.data?.pagination?.cashTotal),
    imageAssets: (assets?.files || []).map(assetProjection),
    imageAssetTotal: Number(assets?.pagination?.total),
    imageHistory: historyProjection(history),
  };
}

async function observeJson(origin, pathname, token) {
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    return {
      available: true,
      httpStatus: response.status,
      ok: response.ok,
      body: await response.json().catch(() => null),
    };
  } catch (error) {
    return {
      available: false,
      httpStatus: null,
      ok: false,
      error: redactText(error),
    };
  }
}

function observationProjection(observation) {
  return {
    available: observation?.available === true,
    httpStatus: observation?.httpStatus ?? null,
    ok: observation?.ok === true,
    error: observation?.error || observation?.body?.error || null,
  };
}

async function readFailureAccountEvidence(origin, token, userId) {
  const [cash, credits, transactions, assets, history] = await Promise.all([
    observeJson(origin, "/api/cash/balance", token),
    observeJson(origin, `/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, token),
    observeJson(origin, "/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50", token),
    observeJson(origin, "/api/storage/files?category=image&limit=100&offset=0", token),
    observeJson(origin, "/api/image-workbench/history?page=1", token),
  ]);
  const walletTransactions = transactions.ok
    ? (transactions.body?.data?.transactions || []).filter((row) => row?.category === "cash").map(walletTransactionProjection)
    : [];
  return {
    cash: cash.ok ? Number(cash.body?.balance) : null,
    credits: credits.ok ? Number(credits.body?.credits) : null,
    reservedCredits: credits.ok ? Number(credits.body?.reservedCredits) : null,
    memberStatus: credits.ok ? String(credits.body?.memberStatus || "") : null,
    walletTransactions,
    walletTransactionTotal: transactions.ok ? Number(transactions.body?.data?.pagination?.cashTotal) : null,
    imageAssets: assets.ok ? (assets.body?.files || []).map(assetProjection) : [],
    imageAssetTotal: assets.ok ? Number(assets.body?.pagination?.total) : null,
    imageHistory: history.ok ? historyProjection(history.body) : [],
    observations: {
      cash: observationProjection(cash),
      credits: observationProjection(credits),
      transactions: observationProjection(transactions),
      assets: observationProjection(assets),
      history: observationProjection(history),
    },
  };
}

function statusProjection(observation) {
  const body = observation?.body;
  return {
    available: observation?.available === true,
    httpStatus: observation?.httpStatus ?? null,
    ok: observation?.ok === true,
    state: body?.state || null,
    rejectionState: body?.rejectionState || null,
    code: body?.code || null,
    canRecover: body?.canRecover ?? null,
    canResubmit: body?.canResubmit ?? null,
    sameKeyCanResubmit: body?.sameKeyCanResubmit ?? null,
    billingHeld: body?.billingHeld ?? null,
    billingReleaseState: body?.billingReleaseState || null,
    billingReconciliation: body?.billingReconciliation || null,
    billingReferenceId: body?.billingReferenceId || null,
    assetId: body?.assetId || null,
    providerEvidence: body?.providerEvidence || null,
    updatedAt: body?.updatedAt || null,
    error: observation?.error || body?.error || null,
  };
}

function newRows(before, after, key = "id") {
  const known = new Set(before.map((row) => String(row?.[key] || "")).filter(Boolean));
  return after.filter((row) => {
    const value = String(row?.[key] || "");
    return value && !known.has(value);
  });
}

function sanitizedRequestProjection(body, rawBody) {
  return {
    bodySha256: sha256(rawBody || JSON.stringify(body || {})),
    prompt: String(body?.prompt || ""),
    promptSha256: sha256(String(body?.prompt || "")),
    promptCharacters: String(body?.prompt || "").length,
    mode: body?.mode || null,
    modelId: body?.modelId || null,
    aspectRatio: body?.aspectRatio || null,
    resolution: body?.resolution || null,
    historySurface: body?.historySurface || null,
    referenceImageCount: Array.isArray(body?.referenceImageUrls) ? body.referenceImageUrls.length : 0,
    clientTraceId: body?.clientTraceId || null,
    clientIdempotencyKey: body?.clientIdempotencyKey || null,
    resumeDeliveryOnly: body?.resumeDeliveryOnly === true,
  };
}

function sanitizedGenerationResponse(body, status) {
  return {
    httpStatus: status,
    success: body?.success === true,
    status: body?.status || body?.state || null,
    code: body?.code || null,
    taskId: body?.taskId || null,
    traceId: body?.traceId || null,
    operationId: body?.operationId || null,
    assetId: body?.images?.[0]?.assetId || null,
    modelIdUsed: body?.modelIdUsed || null,
    resolution: body?.resolution || null,
    outputPixelSize: body?.outputPixelSize || null,
    imageCount: body?.imageCount ?? null,
    providerProtocol: body?.providerProtocol || null,
    payloadFingerprint: body?.payloadFingerprint || null,
    idempotencyReplayed: body?.idempotencyReplayed ?? null,
    cashCharged: body?.cashCharged ?? null,
    cashRemaining: body?.cashRemaining ?? null,
    error: body?.error || null,
  };
}

async function saveRenderedImage(responseBody, origin, token, outputDir) {
  const source = String(responseBody?.images?.[0]?.url || "");
  assert.ok(source, "GENERATED_IMAGE_URL_MISSING");
  const target = new URL(source, origin);
  const originUrl = new URL(origin);
  const response = await fetch(target, {
    method: "GET",
    headers: target.origin === originUrl.origin ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(90_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(response.ok && bytes.length > 1000, `GENERATED_IMAGE_READ_FAILED:${response.status}`);
  const metadata = await sharp(bytes).metadata();
  assert.ok(metadata.width && metadata.height && metadata.format, "GENERATED_IMAGE_DECODE_FAILED");
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
  const file = `generated-image.${extension}`;
  // Decoded bytes stay in RAM; explicit page download is independently tested.
  return {
    file,
    bytes: bytes.length,
    sha256: sha256(bytes),
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
  };
}

async function runExecute(options) {
  const token = String((options.paid.actorRole === 'admin' ? process.env.LOCAL_NAV_ADMIN_TOKEN : process.env.R267_CUSTOMER_TOKEN) || "").trim();
  const wrapperCustomer = options.paid.actorRole === 'admin' ? { id:options.paid.userId, role:'admin' } : parseJson(process.env.LOCAL_NAV_READONLY_CUSTOMER, null);
  assert.ok(token, "ORDINARY_CUSTOMER_TOKEN_REQUIRED_USE_WITH_LOCAL_CUSTOMER_SESSION");
  assert.ok(wrapperCustomer?.id && wrapperCustomer?.role === options.paid.actorRole, "LOCAL_READONLY_CUSTOMER_IDENTITY_REQUIRED");

  const outputDir = path.resolve(".codex-evidence/image-workbench-live-ui-only", options.runId);
  await fs.access(outputDir).then(() => assert.fail("OUTPUT_ALREADY_EXISTS"), () => undefined);
  await fs.mkdir(outputDir, { recursive: true });

  const report = {
    schema: "image_workbench_live_ui_only_e2e.v2",
    runId: options.runId,
    mode: "execute",
    acceptanceProfile: options.acceptanceProfile,
    startedAt: new Date().toISOString(),
    status: "running",
    requestedInputs: {
      promptSha256Only: true,
      promptSha256: sha256(options.prompt),
      resolution: options.resolution || null,
      aspectRatio: options.aspectRatio || null,
      imageCount: options.imageCount,
    },
    policy: {
      ordinaryMemberOnly: true,
      adminExemptionUsed: false,
      directGenerationApiCallsByHarness: 0,
      generationPostLimit: 1,
      automaticRetries: 0,
      observedAdditionalGenerationAttempts: 0,
      failureStatusReadMayReconcileStaleIntent: true,
      tokenPersisted: false,
      fullSensitiveUrlsPersisted: false,
    },
    diagnostics: {
      consoleErrors: [], pageErrors: [], networkErrors: [], nonGenerationMutations: [], uiObstructions: [],
      generationPostAttempts: 0, generationPostsContinued: 0, duplicateGenerationPostsBlocked: 0,
    },
    cleanup: { contextClosed: false, browserClosed: false, generatedRecordsDeleted: false, note: "Generated evidence is retained in the ordinary member account history." },
  };
  let browser;
  let context;
  let failure;
  try {
    report.runtime = await runtimeIdentity(options);
    report.databaseReadiness = await readPaidDatabaseReadiness(options.paid,report.runtime);
    report.providerEvidence = {requiredFor:"actual provider submission receipt readback", enforced:true};
    const identity = await getJson(options.origin, "/api/auth/me", token);
    assertPaidActor(identity,options.paid);
    assert.equal(String(identity?.user?.id || ""), String(wrapperCustomer.id), "CUSTOMER_IDENTITY_MISMATCH");
    report.actor = { userId: identity.user.id, role: identity.user.role };

    const catalog = await getJson(options.origin, "/api/cover-models?surface=image-workbench", token);
    const publicModels = Array.isArray(catalog?.models) ? catalog.models.map(publicModelProjection) : [];
    const selected = selectPublicImageModel(publicModels, options);
    assert.ok(selected?.id && selected.available && selected.priceReady, "VISIBLE_AVAILABLE_PUBLIC_IMAGE_MODEL_REQUIRED");
    assert.ok(Number.isFinite(selected.publicPrice) && selected.publicPrice >= 0, "PUBLIC_IMAGE_PRICE_REQUIRED");
    const resolution = options.acceptanceProfile === "fixed-prompt-adherence"
      ? options.resolution
      : selected.resolutionOptions.includes(selected.defaultResolution)
        ? selected.defaultResolution : selected.resolutionOptions[0] || "2K";
    const aspectRatio = options.acceptanceProfile === "fixed-prompt-adherence"
      ? options.aspectRatio
      : selected.aspectRatios.includes("1:1") ? "1:1" : selected.aspectRatios[0] || "1:1";
    if (options.acceptanceProfile === "fixed-prompt-adherence") {
      assert.equal(
        modelSupportsRequestedImageParameters(selected, resolution, aspectRatio),
        true,
        "NO_AVAILABLE_PUBLIC_IMAGE_MODEL_SUPPORTS_REQUESTED_PARAMETERS",
      );
    }
    const quotedPrice = quotedModelPrice(selected, resolution);
    assertPaidQuote(quotedPrice,options.paid);
    assert.ok(Number.isFinite(quotedPrice) && quotedPrice >= 0, "SELECTED_RESOLUTION_PRICE_REQUIRED");
    assert.ok(selected.resolutionOptions.includes(resolution), "IMAGE_ADVERTISED_RESOLUTION_REQUIRED");
    report.model = { ...selected, selectedResolution: resolution, selectedAspectRatio: aspectRatio, quotedPrice, ...imageAspectSupport(selected,options,aspectRatio) };

    const before = await readAccountEvidence(options.origin, token, identity.user.id);
    assert.ok(Number.isFinite(before.cash) && before.cash >= quotedPrice, "ORDINARY_MEMBER_CASH_BALANCE_INSUFFICIENT_FOR_ONE_IMAGE");
    report.billing = { before, quotedPrice, after: null, cashDelta: null, creditsDelta: null };
    const marker = `IMAGE_UI_ONLY_${options.runId}_${randomUUID()}`;
    const prompt = options.acceptanceProfile === "fixed-prompt-adherence"
      ? options.prompt
      : `${options.prompt} 验收标记：${marker}`;
    report.pageInput = {
      acceptanceProfile: options.acceptanceProfile,
      mode: "文生图",
      modelId: selected.id,
      modelDisplayName: selected.displayName,
      resolution,
      aspectRatio,
      prompt,
      promptSha256: sha256(prompt),
      promptCharacters: prompt.length,
      expectedCardCount: options.imageCount,
    };
    await fs.writeFile(path.join(outputDir, "dispatch.json"), `${JSON.stringify({
      schema: "image_workbench_ui_dispatch.v2",
      createdAt: new Date().toISOString(),
      runId: options.runId,
      runtime: report.runtime,
      actorRole: identity.user.role,
      ordinaryMemberAdmissionVerified: identity.user.role === "student",
      counterScope:"browser-generation-POST",providerDispatchCount:"unknown",
      selectedPublicModelId: selected.id,
      acceptanceProfile: options.acceptanceProfile,
      resolution,
      aspectRatio,
      imageCount: options.imageCount,
      promptSha256: report.pageInput.promptSha256,
      generationPostLimit: 1,
      automaticRetries: 0,
      submissionAuthority: "browser-page-click-only",
    }, null, 2)}\n`, { flag: "wx" });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: "block" });
    await context.addInitScript(({ authToken, authUser }) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.setItem("auth_user", JSON.stringify(authUser));
      sessionStorage.setItem("entered_app", "1");
    }, { authToken: token, authUser: identity.user });
    await context.addCookies([{ name: "auth_token", value: token, url: options.origin, httpOnly: true, sameSite: "Lax" }]);

    let clickArmed = false;
    const generationRequests = [];
    const postReceiptPromises = [];
    const paidPostHandler=makeWorkbenchPaidPostHandler({diagnostics:report.diagnostics,isArmed:()=>clickArmed,
      expected:{modelId:selected.id,resolution,aspectRatio,historySurface:'image-workbench',prompt},
      checkFresh:async()=>{
        report.forwarding = { stage:"before-guarded", state:"not-forwarded", providerDispatchCount:"unknown" };
        const fresh=await getJson(options.origin,'/api/cover-models?surface=image-workbench',token);
        const current=fresh.models?.map(publicModelProjection).find(item=>item.id===selected.id);
        assertFreshImageModel(selected,current,options,resolution,aspectRatio,quotedPrice);
      }});
    const routeBoundary = makeImagePaidRouteBoundary(paidPostHandler,report);
    await context.route("**/api/image/generate",routeBoundary.handler);

    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) {
        report.diagnostics.consoleErrors.push(redactText(message.text(), token));
      }
    });
    page.on("pageerror", (error) => report.diagnostics.pageErrors.push(redactText(error.message, token)));
    page.on("requestfailed", (request) => {
      if (pathnameOnly(request.url()) === "/api/image/generate" && report.diagnostics.duplicateGenerationPostsBlocked > 0) return;
      report.diagnostics.networkErrors.push({ method: request.method(), path: pathnameOnly(request.url()), failure: redactText(request.failure()?.errorText, token) });
    });
    page.on("response", (response) => {
      const request = response.request();
      const pathname = pathnameOnly(response.url());
      if (response.status() >= 400) report.diagnostics.networkErrors.push({ method: request.method(), path: pathname, status: response.status() });
      if (request.method() === "POST" && ["/api/image-workbench/persist", "/api/image-workbench/history"].includes(pathname)) {
        postReceiptPromises.push(response.json().then((body) => ({ path: pathname, status: response.status(), body })).catch(() => ({ path: pathname, status: response.status(), body: null })));
      }
    });
    page.on("request", (request) => {
      const method = request.method().toUpperCase();
      const pathname = pathnameOnly(request.url());
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && pathname !== "/api/image/generate") {
        report.diagnostics.nonGenerationMutations.push({ method, path: pathname });
      }
      if (method !== "POST" || pathname !== "/api/image/generate") return;
      generationRequests.push(captureImageRequest(report,request));
    });

    const navigation = await page.goto(`${options.origin}/image-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(navigation?.ok(), "IMAGE_WORKBENCH_NAVIGATION_FAILED");
    await page.locator("#image-workbench-model").waitFor({ state: "attached", timeout: 45_000 });
    const announcementClose = page.locator('button[aria-label="关闭系统公告"]');
    if (await announcementClose.isVisible().catch(() => false)) {
      await announcementClose.click();
      await announcementClose.waitFor({ state: "hidden", timeout: 10_000 });
      report.diagnostics.uiObstructions.push({
        type: "announcement-reader",
        action: "closed-through-page-ui-without-marking-read",
        generationPostsBeforeClose: report.diagnostics.generationPostAttempts,
      });
    }
    await page.locator("#image-workbench-model").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "文生图", exact: true }).click();
    await page.locator("#image-workbench-model").selectOption(selected.id);
    await page.getByRole("button", { name: resolution, exact: true }).click();
    await page.getByRole("button", { name: aspectRatio, exact: true }).click();
    while (await page.getByRole("button", { name: "删除生图卡片", exact: true }).count() > 1) {
      await page.getByRole("button", { name: "删除生图卡片", exact: true }).last().click();
    }
    assert.equal(
      await page.getByLabel(/第 \d+ 张图片提示词/u).count(),
      options.imageCount,
      "PAGE_IMAGE_CARD_COUNT_MISMATCH",
    );
    const promptInput = page.getByLabel("第 1 张图片提示词", { exact: true });
    await promptInput.fill(prompt);
    assert.equal(await promptInput.inputValue(), prompt, "PAGE_PROMPT_INPUT_MISMATCH");
    assert.equal(await page.locator("#image-workbench-model").inputValue(), selected.id, "PAGE_MODEL_INPUT_MISMATCH");
    await page.screenshot({ path: path.join(outputDir, "image-workbench-before-submit.png"), fullPage: true });
    const generateButton = page.getByRole("button", { name: /生成图片（1）/u });
    await generateButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await generateButton.isEnabled(), true, "PAGE_GENERATE_BUTTON_DISABLED");

    report.submission = { clickedAt: new Date().toISOString(), trigger: `page-button:生成图片（${options.imageCount}）`, uiOnly: true };
    clickArmed = true;
    const generationResponse = await awaitImageGenerationResponse({page,click:() => generateButton.click(),failure:routeBoundary.failure});
    const generationBody = await generationResponse.json().catch(() => null);
    report.generation = sanitizedGenerationResponse(generationBody, generationResponse.status());
    assert.equal(report.diagnostics.generationPostAttempts, 1, "GENERATION_POST_ATTEMPT_COUNT_MUST_BE_EXACTLY_ONE");
    assert.equal(report.diagnostics.generationPostsContinued, 1, "GENERATION_POST_NETWORK_COUNT_MUST_BE_EXACTLY_ONE");
    assert.equal(report.diagnostics.duplicateGenerationPostsBlocked, 0, "DUPLICATE_GENERATION_POST_DETECTED");
    assert.equal(generationRequests.length, 1, "GENERATION_REQUEST_CAPTURE_COUNT_INVALID");
    report.request = generationRequests[0];
    assert.equal(report.request.prompt, prompt, "REQUEST_PROMPT_MISMATCH");
    assert.equal(report.request.modelId, selected.id, "REQUEST_MODEL_MISMATCH");
    assert.equal(report.request.aspectRatio, aspectRatio, "REQUEST_ASPECT_RATIO_MISMATCH");
    assert.equal(report.request.resolution, resolution, "REQUEST_RESOLUTION_MISMATCH");
    assert.equal(report.request.historySurface, "image-workbench", "REQUEST_HISTORY_SURFACE_MISMATCH");
    assert.equal(report.request.resumeDeliveryOnly, false, "UNEXPECTED_DELIVERY_RESUME_SUBMISSION");
    assert.ok(report.request.clientTraceId && report.request.clientIdempotencyKey, "REQUEST_TRACE_AND_IDEMPOTENCY_REQUIRED");
    if (!generationResponse.ok()) {
      const statusQuery = new URLSearchParams({
        clientIdempotencyKey: report.request.clientIdempotencyKey,
        clientTraceId: report.request.clientTraceId,
      });
      const [after, statusObservation] = await Promise.all([
        readFailureAccountEvidence(options.origin, token, identity.user.id),
        observeJson(options.origin, `/api/image/status?${statusQuery}`, token),
      ]);
      const newWalletTransactions = newRows(before.walletTransactions, after.walletTransactions);
      const newAssets = newRows(before.imageAssets, after.imageAssets);
      const newHistoryRecords = newRows(before.imageHistory, after.imageHistory);
      const historyItems = newHistoryRecords.flatMap((record) => record.items || []);
      const status = statusProjection(statusObservation);
      const taskId = report.generation.taskId || historyItems.find((item) => item.taskId)?.taskId || null;
      const traceId = report.generation.traceId || report.request.clientTraceId || null;
      const operationId = report.generation.operationId || historyItems.find((item) => item.operationId)?.operationId || null;
      const assetId = report.generation.assetId || status.assetId || historyItems.find((item) => item.assetId)?.assetId || null;
      report.billing.after = after;
      report.billing.cashDelta = Number.isFinite(after.cash) ? roundMoney(before.cash - after.cash) : null;
      report.billing.creditsDelta = Number.isFinite(after.credits) ? roundMoney(before.credits - after.credits) : null;
      report.failureReadback = {
        capturedAt: new Date().toISOString(),
        generationHttpStatus: generationResponse.status(),
        method: "account GETs plus image status GET; status may reconcile a stale intent after the server threshold but cannot submit a provider generation",
        imageStatus: status,
        task: {
          taskId,
          traceId,
          state: status.state || report.generation.status || "http-rejected",
          zeroResidual: !taskId && !traceId && status.state === "not_found",
        },
        operation: {
          operationId,
          billingReferenceId: status.billingReferenceId,
          state: status.billingReleaseState || status.billingReconciliation
            || (newWalletTransactions.length > 0 ? "wallet-transaction-observed" : "no-wallet-operation-observed"),
          newHistoryOperationIds: historyItems.map((item) => item.operationId).filter(Boolean),
          zeroResidual: !operationId && !status.billingReferenceId && newWalletTransactions.length === 0,
        },
        asset: {
          assetId,
          totalBefore: before.imageAssetTotal,
          totalAfter: after.imageAssetTotal,
          totalDelta: Number.isFinite(after.imageAssetTotal) ? after.imageAssetTotal - before.imageAssetTotal : null,
          newAssets,
          newHistoryRecords,
          zeroResidual: after.observations.assets.ok && after.observations.history.ok
            && newAssets.length === 0 && newHistoryRecords.length === 0
            && after.imageAssetTotal === before.imageAssetTotal,
        },
        wallet: {
          cashBefore: before.cash,
          cashAfter: after.cash,
          cashDelta: report.billing.cashDelta,
          creditsBefore: before.credits,
          creditsAfter: after.credits,
          creditsDelta: report.billing.creditsDelta,
          transactionTotalBefore: before.walletTransactionTotal,
          transactionTotalAfter: after.walletTransactionTotal,
          transactionTotalDelta: Number.isFinite(after.walletTransactionTotal)
            ? after.walletTransactionTotal - before.walletTransactionTotal : null,
          newTransactions: newWalletTransactions,
          zeroResidual: after.observations.cash.ok && after.observations.credits.ok && after.observations.transactions.ok
            && newWalletTransactions.length === 0
            && after.walletTransactionTotal === before.walletTransactionTotal
            && report.billing.cashDelta === 0
            && report.billing.creditsDelta === 0,
        },
      };
      report.policy.observedAdditionalGenerationAttempts = Math.max(
        0,
        report.diagnostics.generationPostAttempts - 1,
      );
      assert.equal(report.diagnostics.generationPostAttempts, 1, "DELAYED_DUPLICATE_GENERATION_ATTEMPT_DETECTED");
      assert.equal(report.diagnostics.generationPostsContinued, 1, "DELAYED_GENERATION_POST_CONTINUATION_INVALID");
      assert.equal(report.diagnostics.duplicateGenerationPostsBlocked, 0, "DELAYED_DUPLICATE_GENERATION_POST_BLOCKED");
      throw new Error(`GENERATION_HTTP_${generationResponse.status()}`);
    }
    assert.equal(generationResponse.status(), 200, `GENERATION_HTTP_${generationResponse.status()}`);
    assert.equal(generationBody?.success, true, "GENERATION_NOT_SUCCESSFUL");
    assert.equal(generationBody?.status, "completed", "GENERATION_NOT_TERMINAL_COMPLETED");
    assert.equal(generationBody?.idempotencyReplayed, false, "GENERATION_MUST_NOT_BE_AN_IDEMPOTENT_REPLAY");
    assert.equal(generationBody?.traceId, report.request.clientTraceId, "TRACE_ID_MISMATCH");
    assert.equal(generationBody?.modelIdUsed, selected.id, "RESPONSE_MODEL_MISMATCH");
    assert.equal(generationBody?.resolution, resolution, "RESPONSE_RESOLUTION_MISMATCH");
    assert.equal(generationBody?.imageCount, options.imageCount, "RESPONSE_IMAGE_COUNT_MISMATCH");

    if (['provider_url','inline_ephemeral'].includes(generationBody.deliveryMode || generationBody.images?.[0]?.deliveryMode)) {
      await acceptDirectWorkbench({page,body:generationBody,report,options,token,identity,before,outputDir,prompt,aspectRatio,resolution});
      return;
    }

    const resultImage = page.locator("article").filter({ has: page.getByLabel("第 1 张图片提示词", { exact: true }) }).locator("img").first();
    await resultImage.waitFor({ state: "visible", timeout: 120_000 });
    const rendered = await resultImage.evaluate((image) => ({
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0, "GENERATED_IMAGE_NOT_RENDERED_IN_PAGE");
    report.rendered = rendered;
    await page.screenshot({ path: path.join(outputDir, "image-workbench-result.png"), fullPage: true });
    report.asset = await saveRenderedImage(generationBody, options.origin, token, outputDir);
    report.decodedAspect = assertDecodedImageAspect(report.asset,aspectRatio);

    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name: "一键下载", exact: true }).click();
    const download = await downloadPromise;
    const suggested = path.basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/gu, "_") || "image-workbench-download.zip";
    const downloadPath = path.join(outputDir, suggested);
    await download.saveAs(downloadPath);
    const downloadFailure = await download.failure();
    assert.equal(downloadFailure, null, `PAGE_DOWNLOAD_FAILED:${downloadFailure}`);
    const downloadBytes = await fs.readFile(downloadPath);
    assert.ok(downloadBytes.length > 1000, "PAGE_DOWNLOAD_EMPTY");
    report.pageDownload = { bytes: downloadBytes.length, sha256: sha256(downloadBytes) };
    await fs.rm(downloadPath,{force:true}); await download.delete();

    await page.getByRole("button", { name: "历史", exact: true }).click();
    const historyDialog = page.getByRole("dialog", { name: "生成历史" });
    await historyDialog.waitFor({ state: "visible", timeout: 45_000 });
    await historyDialog.getByText(prompt, { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    await page.screenshot({ path: path.join(outputDir, "image-workbench-history.png"), fullPage: true });

    const receipts = await Promise.all(postReceiptPromises);
    const persistReceipt = receipts.find((item) => item.path === "/api/image-workbench/persist");
    const historyWriteReceipt = receipts.find((item) => item.path === "/api/image-workbench/history");
    assert.ok(persistReceipt?.status === 200 && persistReceipt.body?.assetId && persistReceipt.body?.historyRecordId, "IMAGE_PERSIST_RECEIPT_MISSING");
    assert.ok(historyWriteReceipt?.status === 200 && historyWriteReceipt.body?.saved?.[0]?.id, "IMAGE_HISTORY_WRITE_RECEIPT_MISSING");
    const history = await getJson(options.origin, "/api/image-workbench/history?page=1", token);
    const persisted = history?.records?.find((record) => record?.items?.some((item) => item?.assetId === generationBody.images[0].assetId));
    assert.ok(persisted, "GENERATED_IMAGE_NOT_FOUND_IN_ACCOUNT_HISTORY");
    const persistedItem = persisted.items.find((item) => item.assetId === generationBody.images[0].assetId);
    assert.equal(persistedItem.prompt, prompt, "ACCOUNT_HISTORY_PROMPT_MISMATCH");
    const status = await getJson(options.origin, `/api/image/status?clientIdempotencyKey=${encodeURIComponent(report.request.clientIdempotencyKey)}&clientTraceId=${encodeURIComponent(report.request.clientTraceId)}`, token);
    assert.equal(status?.state, "completed", "IMAGE_REQUEST_RECORD_NOT_COMPLETED");
    assert.equal(status?.assetId, generationBody.images[0].assetId, "IMAGE_REQUEST_RECORD_ASSET_MISMATCH");
    assertProviderImageEvidence(status,report,prompt,aspectRatio,resolution,options.imageCount);
    report.records = {
      taskId: generationBody.taskId || null,
      traceId: generationBody.traceId || null,
      clientIdempotencyKey: report.request.clientIdempotencyKey,
      operationId: generationBody.operationId || null,
      imageAssetId: generationBody.images[0].assetId,
      conversationHistoryRecordId: persistReceipt.body.historyRecordId,
      imageWorkbenchHistoryId: persisted.id,
      historyWriteId: historyWriteReceipt.body.saved[0].id,
      requestState: status.state,
      deliveryReady: status.deliveryReady === true,
      idempotencyReplayed: generationBody.idempotencyReplayed,
    };

    const after = await readAccountEvidence(options.origin, token, identity.user.id);
    report.billing.after = after;
    report.billing.cashDelta = roundMoney(before.cash - after.cash);
    report.billing.creditsDelta = roundMoney(before.credits - after.credits);
    report.billing.responseCashCharged = Number(generationBody.cashCharged);
    report.billing.historyCashCharged = Number(persistedItem.cashCharged);
    report.billing.balanceMatchesResponse = report.billing.cashDelta === roundMoney(Number(generationBody.cashCharged));
    report.billing.historyMatchesResponse = roundMoney(Number(persistedItem.cashCharged)) === roundMoney(Number(generationBody.cashCharged));
    assert.equal(report.billing.balanceMatchesResponse, true, "CASH_BALANCE_DELTA_MISMATCH");
    assert.equal(report.billing.historyMatchesResponse, true, "HISTORY_BILLING_MISMATCH");
    assert.equal(report.billing.creditsDelta, 0, "IMAGE_GENERATION_MUST_NOT_CONSUME_CREDITS");
    assert.equal(report.diagnostics.pageErrors.length, 0, "PAGE_ERRORS_DETECTED");
    report.status = report.diagnostics.consoleErrors.length || report.diagnostics.networkErrors.length
      ? "passed-with-recorded-diagnostics" : "passed";
    report.runtimeAfter=await runtimeIdentity(options); assert.deepEqual(report.runtimeAfter,report.runtime,"HARNESS_RUNTIME_CHANGED");
    report.completedAt = new Date().toISOString();
  } catch (error) {
    failure = error;
    report.status = "failed-stopped-no-retry";
    report.failedAt = new Date().toISOString();
    report.errorCode=safeHarnessErrorCode(error);
    report.budgetDisposition="unknown-or-pending: retain full allocation; read original task only; no new key";
    report.error = redactText(error instanceof Error ? error.stack || error.message : String(error), token);
  } finally {
    if (context) {
      await context.close().then(() => { report.cleanup.contextClosed = true; }, (error) => {
        report.cleanup.contextCloseError = redactText(error, token);
      });
    }
    if (browser) {
      await browser.close().then(() => { report.cleanup.browserClosed = true; }, (error) => {
        report.cleanup.browserCloseError = redactText(error, token);
      });
    }
    report.policy.tokenPersisted = false;
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(safeHarnessEvidence(report), null, 2)}\n`, { flag: "wx" });
  }
  if (failure) throw failure;
  console.log(JSON.stringify({
    status: report.status,
    runtime: report.runtime,
    ordinaryMemberRole: report.actor.role,
    generationPosts: report.diagnostics.generationPostsContinued,
    automaticRetries: report.policy.automaticRetries,
    cashCharged: report.generation.cashCharged,
    historyRestored: Boolean(report.records.imageWorkbenchHistoryId),
    report: path.join(outputDir, "report.json"),
  }, null, 2));
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') return runPaidHarnessSelfTest();
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.execute) {
    const executeArguments = [
      `--run-id=${options.runId}`,
      ...(options.expectedSourceVersion ? [`--expected-source-version=${options.expectedSourceVersion}`] : []),
      ...(options.expectedBuildId ? [`--expected-build-id=${options.expectedBuildId}`] : []),
      ...(options.modelId ? [`--model-id=${options.modelId}`] : []),
      ...(!options.modelId && options.modelNameExplicit ? [`--model-name=${JSON.stringify(options.modelName)}`] : []),
      ...(options.acceptanceProfile === "fixed-prompt-adherence" ? [
        `--prompt=${JSON.stringify(options.prompt)}`,
        `--resolution=${options.resolution}`,
        `--aspect-ratio=${options.aspectRatio}`,
        `--image-count=${options.imageCount}`,
      ] : []),
      "--execute",
    ];
    const providerEvidence = providerEvidenceReadbackContract();
    console.log(JSON.stringify({
      mode: "plan",
      runId: options.runId,
      acceptanceProfile: options.acceptanceProfile,
      networkCalls: 0,
      databaseCalls: 0,
      generationPosts: 0,
      providerCalls: 0,
      paidCalls: 0,
      filesystemWrites: 0,
      requiredRole: options.paid.actorRole,
      counterScope:"browser-generation-POST",providerDispatchCount:"unknown",
      ordinaryMemberAdmissionVerified: false,
      adminExemptionAccepted: false,
      automaticRetries: 0,
      runtimeLock: options.expectedSourceVersion || options.expectedBuildId ? "explicit-and-runningLatest" : "runningLatest",
      executePreflight: "externally pinned actual application DB 173-ledger/full semantic/function authority/REST readiness evidence before paid submit",
      requestedInputs: {
        promptCharacters: options.prompt.length,
        promptSha256: sha256(options.prompt),
        resolution: options.resolution || null,
        aspectRatio: options.aspectRatio || null,
        imageCount: options.imageCount,
      },
      modelSelection: options.acceptanceProfile === "fixed-prompt-adherence"
        ? "dynamic public catalog selection; available+priceReady+exact advertised resolution+exact advertised aspect ratio"
        : "existing smoke selection behavior",
      providerEvidence,
      executeWillFailClosedBeforeBrowserClick: "unless externally pinned current application DB readiness succeeds",
      executeCommand: `node ${SCRIPT_PATH} ${executeArguments.filter(arg=>!arg.startsWith("--prompt=")).join(" ")} --actor-role=${options.paid.actorRole} --user-id=<exact-id> --max-charge=<allocated-yuan> --remaining-budget=<remaining-yuan> --database-readiness=<root-index-path> --database-readiness-sha256=<external-pin> --expected-database-target=<host:port/database> --expected-database-identity=<fingerprint>`,
      controlledSession: "existing selected-role session in RAM; do not create a session or bypass wrapper guard",
    }, null, 2));
    return;
  }
  await runExecute(options);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await main().catch(error=>{console.error(JSON.stringify({success:false,errorCode:safeHarnessErrorCode(error),automaticRetries:0}));process.exitCode=1;});
