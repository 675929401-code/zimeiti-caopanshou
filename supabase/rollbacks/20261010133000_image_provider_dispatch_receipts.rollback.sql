begin;

set local lock_timeout = '10s';

-- Provider receipts are financial/idempotency evidence. A rollback must not
-- delete their columns, functions, rows or migration-ledger history and must
-- not restore the pre-1330 unsafe stale reconciliation. This forward-repair
-- guard succeeds only while the safety contract is still intact.
do $provider_receipt_forward_repair_guard$
declare
  v_table_owner oid;
  v_service_role oid := to_regrole('service_role');
  v_anon_role oid := to_regrole('anon');
  v_authenticated_role oid := to_regrole('authenticated');
  v_signature text;
begin
  select relation.relowner into v_table_owner
    from pg_class relation
   where relation.oid = 'public.image_generation_requests'::regclass;
  if v_table_owner is null
     or not exists (
       select 1 from pg_attribute
        where attrelid = 'public.image_generation_requests'::regclass
          and attname = 'provider_dispatch_receipt' and not attisdropped
     )
     or not exists (
       select 1 from pg_attribute
        where attrelid = 'public.image_generation_requests'::regclass
          and attname = 'provider_submission_receipt' and not attisdropped
     )
     or not exists (
       select 1 from pg_constraint
        where conrelid = 'public.image_generation_requests'::regclass
          and conname = 'image_generation_requests_provider_receipt_order'
          and convalidated
     ) then
    raise exception 'IMAGE_PROVIDER_RECEIPT_FORWARD_REPAIR_REQUIRED' using errcode = '55000';
  end if;
  if v_service_role is null or v_anon_role is null or v_authenticated_role is null then
    raise exception 'IMAGE_PROVIDER_RECEIPT_RUNTIME_ROLE_REQUIRED' using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)',
    'public.reconcile_stale_image_generation_request_atomic(text,text,integer)',
    'public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb)',
    'public.record_image_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'IMAGE_PROVIDER_RECEIPT_FORWARD_REPAIR_REQUIRED:%', v_signature using errcode = '55000';
    end if;
    if exists (
      select 1 from pg_proc procedure
       where procedure.oid = to_regprocedure(v_signature)
         and (procedure.proowner <> v_table_owner
           or not procedure.prosecdef
           or procedure.proconfig is distinct from array['search_path=public, pg_temp']::text[]
           or (v_signature like '%reconcile_stale_image_generation_request_atomic%'
             and position('provider_evidence_present' in pg_get_functiondef(procedure.oid)) = 0)
           or (v_signature like '%record_image_provider_dispatch_receipt_atomic%'
             and (position('IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID' in pg_get_functiondef(procedure.oid)) = 0
               or position('requestProjection.referenceCount=' in pg_get_functiondef(procedure.oid)) = 0))
           or (v_signature like '%record_image_provider_submission_receipt_atomic%'
             and (position('IMAGE_PROVIDER_SUBMISSION_RECEIPT_INVALID' in pg_get_functiondef(procedure.oid)) = 0
               or position('providerAcknowledgementField=' in pg_get_functiondef(procedure.oid)) = 0)))
    ) or exists (
      select 1 from pg_proc procedure
       where procedure.oid = to_regprocedure(v_signature)
         and (has_function_privilege(v_anon_role, procedure.oid, 'EXECUTE')
           or has_function_privilege(v_authenticated_role, procedure.oid, 'EXECUTE')
           or not has_function_privilege(v_service_role, procedure.oid, 'EXECUTE')
           or exists (
             select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
              where acl.privilege_type = 'EXECUTE'
                and acl.grantee not in (procedure.proowner, v_service_role)
           )
           or exists (
             select 1 from pg_roles role
              where not role.rolsuper
                and role.oid not in (v_table_owner, v_service_role)
                and has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
           ))
    ) then
      raise exception 'IMAGE_PROVIDER_RECEIPT_SECURITY_ALIGNMENT_REQUIRED:%', v_signature using errcode = '55000';
    end if;
  end loop;

  if to_regprocedure('public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)') is null
     or has_function_privilege(v_service_role,
       'public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)'::regprocedure,
       'EXECUTE')
     or exists (
       select 1 from pg_proc procedure
        where procedure.oid = 'public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)'::regprocedure
          and (procedure.proowner <> v_table_owner
            or not procedure.prosecdef
            or procedure.proconfig is distinct from array['search_path=public, pg_temp']::text[]
            or exists (
              select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
               where acl.privilege_type = 'EXECUTE' and acl.grantee <> procedure.proowner
            )
            or exists (
              select 1 from pg_roles role
               where not role.rolsuper and role.oid <> v_table_owner
                 and has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
            ))
     ) then
    raise exception 'IMAGE_PROVIDER_RECEIPT_HELPER_ISOLATION_REQUIRED' using errcode = '55000';
  end if;
end;
$provider_receipt_forward_repair_guard$;

commit;
