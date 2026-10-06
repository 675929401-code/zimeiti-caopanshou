import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function main(){
  const source=await fs.readFile('src/commerce/server/configuration-admin.ts','utf8');
  const route=await fs.readFile('src/app/api/admin/commerce/releases/route.ts','utf8');
  const migration=await fs.readFile('supabase/migrations/20260925154500_commerce_release_publish_cas.sql','utf8');
  const rollback=await fs.readFile('supabase/rollbacks/20260925154500_commerce_release_publish_cas.rollback.sql','utf8');
  const checks:Array<{name:string;passed:true}>=[];const check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push({name,passed:true});};
  check('every publish mode requires the exact difference preview token',source.includes("if(!expectedPreviewSha256||expectedPreviewSha256!==preview.previewSha256)")&&!source.includes('if(!migrationBaseline&&(!expectedPreviewSha256'));
  check('migration baseline API forwards the preview token',/publish-migration-baseline[^]*previewSha256/u.test(route));
  check('application passes candidate and current CAS identities into the RPC',['p_expected_candidate_sha','p_expected_current_id','p_expected_current_sha'].every(value=>source.includes(value)));
  check('database locks candidate and current release rows',/WHERE id = p_release_id\s+FOR UPDATE/u.test(migration)&&/WHERE is_current = true AND status = 'published'[^]*FOR UPDATE/u.test(migration));
  check('database rejects a changed candidate manifest',migration.includes('COMMERCE_RELEASE_CANDIDATE_CHANGED')&&migration.includes('v_release.manifest_sha256 IS DISTINCT FROM p_expected_candidate_sha'));
  check('database rejects first-publish and replacement pointer races',migration.includes('p_expected_current_id IS NULL')&&migration.includes('COMMERCE_RELEASE_CURRENT_CHANGED')&&migration.includes('v_current.id IS DISTINCT FROM p_expected_current_id'));
  check('legacy two-argument publish entry point is removed',migration.includes('DROP FUNCTION IF EXISTS public.publish_commerce_config_release_atomic(uuid, uuid)'));
  check('published release identity and manifest become immutable',migration.includes('commerce_release_immutable')&&migration.includes('NEW.manifest IS DISTINCT FROM OLD.manifest')&&migration.includes('NEW.validation_result IS DISTINCT FROM OLD.validation_result'));
  check('rollback is explicit and restores the previous function signature',rollback.includes('DROP FUNCTION IF EXISTS public.publish_commerce_config_release_atomic(uuid, uuid, text, uuid, text)')&&rollback.includes('p_release_id uuid'));
  const report={schemaVersion:'commerce-release-publish-cas/v1',passed:true,result:{total:checks.length,passed:checks.length,failed:0},safety:{databaseWrites:0,productionWrites:0,deployment:0,paidCalls:0},checks};
  await fs.mkdir('.codex-evidence/commerce-release-publish-cas',{recursive:true});await fs.writeFile('.codex-evidence/commerce-release-publish-cas/report.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report,null,2));
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
