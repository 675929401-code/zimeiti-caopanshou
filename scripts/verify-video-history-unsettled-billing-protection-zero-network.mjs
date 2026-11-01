import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const previousPath='supabase/migrations/20261023090000_storyboard_video_archive_lifecycle.sql';
const migrationPath='supabase/migrations/20261030040000_video_history_unsettled_billing_protection.sql';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const previous=fs.readFileSync(previousPath,'utf8'),migration=fs.readFileSync(migrationPath,'utf8');
const OLD_SHA='81dfd58e29b53ef623386e547c8e0d99cf683a3f6817e6ec89c33fbd8faafd79';
const NEW_SHA='b9258ff96251b71b8f441a7cb8afb910c53f9422207d353269f18360ff0f7cec';
const removed="           OR (t.billing_state = 'provider_submitted' AND coalesce(t.completed_at, t.created_at) < v_cutoff)\n";
assert.equal(sha(previous),'76624eb2bba0ab107d33db383199d8bb81dbbce9119396a7bba99eed82c42f54','APPLIED_HISTORY_MIGRATION_BYTES_CHANGED');
const oldDeclaration=/CREATE OR REPLACE FUNCTION public\.purge_expired_video_history\([\s\S]*?\n\$\$;/u.exec(previous)?.[0];
assert.ok(oldDeclaration,'PREVIOUS_PURGE_DECLARATION_REQUIRED');
const oldBody=/AS \$\$([\s\S]*)\$\$;/u.exec(oldDeclaration)[1];
assert.equal(sha(oldBody),OLD_SHA,'PREVIOUS_ACTUAL_BODY_PIN_MISMATCH');
assert.equal(oldBody.split(removed).length,2,'ONE_PREVIOUS_PROVIDER_TIME_EXCEPTION_REQUIRED');

function checkContract(text){
  const ddl=/EXECUTE \$ddl\$\n([\s\S]*?)\n\$ddl\$;/u.exec(text)?.[1];assert.ok(ddl,'STATIC_FULL_FUNCTION_DDL_REQUIRED');
  const body=/AS \$function\$([\s\S]*)\$function\$;/u.exec(ddl)?.[1];assert.ok(body,'STATIC_FUNCTION_BODY_REQUIRED');
  assert.equal(body,oldBody.replace(removed,''),'ONLY_PROVIDER_TIME_EXCEPTION_MAY_BE_REMOVED');
  assert.equal(sha(body),NEW_SHA,'NEW_BODY_PIN_MISMATCH');
  assert.equal(ddl.split('AS $function$')[0],oldDeclaration.split('AS $$')[0],'SIGNATURE_DEFAULTS_LANGUAGE_SECURITY_MUST_NOT_CHANGE');
  assert.equal((text.match(/CREATE OR REPLACE FUNCTION/gu)||[]).length,1,'ONE_FUNCTION_ONLY');
  assert.doesNotMatch(text,/\b(?:GRANT|REVOKE|ALTER\s+(?:FUNCTION|TABLE|ROLE)|CREATE\s+(?:TABLE|TRIGGER|ROLE)|set_config)\b/iu,'NO_PERMISSION_SCHEMA_OR_RUNTIME_EXPANSION');
  assert.doesNotMatch(text,/'(?:postgres|zimeiti_owner)'/u,'OWNER_MUST_NOT_BE_GUESSED');
  for(const check of [
    'v_before.proowner IS NULL','SELECT 1 FROM pg_roles WHERE oid = v_before.proowner',
    "pg_get_function_identity_arguments(v_before.oid) IS DISTINCT FROM 'p_retention_days integer, p_limit integer'",
    "pg_get_function_arguments(v_before.oid) IS DISTINCT FROM 'p_retention_days integer DEFAULT 5, p_limit integer DEFAULT 500'",
    "v_before.prorettype IS DISTINCT FROM 'jsonb'::regtype","v_before.proretset IS DISTINCT FROM false","v_before.prokind IS DISTINCT FROM 'f'",
    "(SELECT lanname FROM pg_language WHERE oid = v_before.prolang) IS DISTINCT FROM 'plpgsql'",
    'v_before.prosecdef IS DISTINCT FROM true',"v_before.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]",
    "v_before.provolatile IS DISTINCT FROM 'v'","v_before.proparallel IS DISTINCT FROM 'u'",'v_before.proisstrict IS DISTINCT FROM false','v_before.proleakproof IS DISTINCT FROM false',
    `encode(sha256(convert_to(v_before.prosrc, 'UTF8')), 'hex') IS DISTINCT FROM '${OLD_SHA}'`,
    "has_function_privilege('service_role', v_before.oid, 'EXECUTE') IS DISTINCT FROM true",
    "has_function_privilege('anon', v_before.oid, 'EXECUTE') IS DISTINCT FROM false",
    "has_function_privilege('authenticated', v_before.oid, 'EXECUTE') IS DISTINCT FROM false",
    "aclexplode(coalesce(v_before.proacl, acldefault('f', v_before.proowner)))", "privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'",
    `encode(sha256(convert_to(v_after.prosrc, 'UTF8')), 'hex') IS DISTINCT FROM '${NEW_SHA}'`,
  ])assert.ok(text.includes(check),'REQUIRED_PRECONDITION_OR_POSTCONDITION:'+check);
  for(const field of ['proowner','proacl','proconfig','prolang','prorettype','proretset','prokind','prosecdef','provolatile','proparallel','proisstrict','proleakproof','proargnames','proargtypes','proargmodes'])assert.ok(text.includes(`v_after.${field} IS DISTINCT FROM v_before.${field}`),'METADATA_MUST_BE_PRESERVED:'+field);
  assert.ok(text.includes('v_after.pronargdefaults IS DISTINCT FROM v_before.pronargdefaults')&&text.includes('pg_get_expr(v_after.proargdefaults, 0) IS DISTINCT FROM pg_get_expr(v_before.proargdefaults, 0)'),'DEFAULTS_MUST_BE_PRESERVED');
  assert.ok(text.indexOf('VIDEO_HISTORY_BILLING_PROTECTION_PRECONDITION_FAILED')<text.indexOf('EXECUTE $ddl$'),'PRECONDITION_BEFORE_DDL');
  assert.ok(text.indexOf('VIDEO_HISTORY_BILLING_PROTECTION_POSTCONDITION_FAILED')>text.indexOf('$ddl$;'),'POSTCONDITION_AFTER_DDL');
  assert.match(text,/\bBEGIN;[\s\S]*\$migration\$;\nCOMMIT;\s*$/u,'ONE_TRANSACTION_REQUIRED');
  return body;
}
const body=checkContract(migration);
let rejectedMutations=0;
for(const mutate of [
  text=>text.replace("           OR t.billing_state IN",removed+"           OR t.billing_state IN"),
  text=>text.replace('t.billing_state IS NULL','false'),
  text=>text.replace('coalesce(p_retention_days, 5)','coalesce(p_retention_days, 3)'),
  text=>text.replace("'refunded', 'not_charged'","'refunded', 'not_charged', 'provider_submitted'"),
  text=>text.replace("AND coalesce(t.task_label, '') NOT LIKE '分镜工作台%'",'AND true'),
  text=>text.replace('FOR UPDATE SKIP LOCKED','FOR UPDATE'),
  text=>text.replace('v_after.proacl IS DISTINCT FROM v_before.proacl','false'),
  text=>text.replace("has_function_privilege('anon', v_before.oid, 'EXECUTE') IS DISTINCT FROM false",'false'),
]){assert.throws(()=>checkContract(mutate(migration)),'UNSAFE_MUTATION_MUST_FAIL');rejectedMutations++;}

// Evaluate the actual literal SQL billing whitelist in RAM. This is a contract
// test, not PostgreSQL execution or proof of DB permissions/transaction behavior.
const whitelist=/t\.billing_state IN \(([^)]+)\)/u.exec(body)[1].split(',').map(value=>{assert.match(value.trim(),/^'[a-z_]+'$/u);return value.trim().slice(1,-1);});
assert.deepEqual(whitelist,['settled','not_required','exempt','failed','cancelled','submission_failed','refunded','not_charged']);
const acceptsBilling=value=>value===null||whitelist.includes(value);
for(const ageDays of [6,30,365,1000]){
  assert.equal(acceptsBilling('provider_submitted'),false,'UNSETTLED_MUST_REMAIN_PROTECTED_REGARDLESS_OF_AGE:'+ageDays);
  for(const state of ['reserved','settlement_pending','reconciliation_required','unknown',''])assert.equal(acceptsBilling(state),false);
}
assert.equal(acceptsBilling(null),true,'LEGACY_NULL_BILLING_PRESERVED');for(const state of whitelist)assert.equal(acceptsBilling(state),true);
for(const unchanged of ["t.status IN ('completed', 'failed', 'cancelled', 'expired')",'coalesce(t.completed_at, t.created_at) < v_cutoff',"NOT LIKE 'digital-human:%'","NOT LIKE '分镜工作台%'",'public.digital_video_dispatch_jobs','public.digital_human_long_segments','LIMIT v_limit','FOR UPDATE SKIP LOCKED',"'deletedCount'","'deletedIds'","'cutoff'","'hasMore'"])assert.ok(body.includes(unchanged),'EXISTING_PROTECTION_PRESERVED:'+unchanged);
console.log(JSON.stringify({passed:true,kind:'video-history-unsettled-billing-protection-zero-network.v1',oldBodySha256:OLD_SHA,newBodySha256:NEW_SHA,removedExceptionCount:1,rejectedMutations,billingWhitelistEntries:whitelist.length,ownerAcl:'existing metadata captured and asserted unchanged; effective public/anon/auth denied and service admitted',evidence:'SQL bytes and RAM literal contract only; real PostgreSQL validation remains separate',databaseCalls:0,providerCalls:0}));
