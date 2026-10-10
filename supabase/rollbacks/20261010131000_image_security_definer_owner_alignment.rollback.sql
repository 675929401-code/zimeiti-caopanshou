begin;

set local lock_timeout = '10s';

-- Ownership alignment is an additive security repair. Returning either RPC
-- to a bootstrap/superuser owner would reintroduce the privilege drift, so a
-- code rollback deliberately verifies and retains this database invariant.
-- This forward-repair-only guard does not change the functions and does not
-- delete the 20261010131000 migration ledger entry.
do $owner_alignment_guard$
declare
  v_table_owner oid;
  v_service_role oid := to_regrole('service_role');
  v_anon_role oid := to_regrole('anon');
  v_authenticated_role oid := to_regrole('authenticated');
begin
  select relation.relowner
    into v_table_owner
    from pg_class relation
   where relation.oid = 'public.image_generation_requests'::regclass;

  if v_table_owner is null or exists (
    select 1
      from unnest(array[
        'public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)',
        'public.reconcile_stale_image_generation_request_atomic(text,text,integer)'
      ]) signature(value)
      left join pg_proc procedure on procedure.oid = to_regprocedure(signature.value)
     where procedure.oid is null
        or procedure.proowner <> v_table_owner
        or not procedure.prosecdef
        or procedure.proconfig is distinct from array['search_path=public, pg_temp']::text[]
  ) then
    raise exception 'IMAGE_SECURITY_DEFINER_OWNER_ALIGNMENT_REQUIRED' using errcode = '55000';
  end if;

  if v_service_role is null or v_anon_role is null or v_authenticated_role is null then
    raise exception 'IMAGE_SECURITY_DEFINER_RUNTIME_ROLE_REQUIRED' using errcode = '55000';
  end if;

  if exists (
    select 1
      from unnest(array[
        'public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)',
        'public.reconcile_stale_image_generation_request_atomic(text,text,integer)'
      ]) signature(value)
      join pg_proc procedure on procedure.oid = to_regprocedure(signature.value)
     where exists (
       select 1
         from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
        where acl.privilege_type = 'EXECUTE'
          and acl.grantee not in (procedure.proowner, v_service_role)
     )
        or not exists (
          select 1
            from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
           where acl.privilege_type = 'EXECUTE'
             and acl.grantee = v_service_role
             and not acl.is_grantable
        )
        or has_function_privilege(v_anon_role, procedure.oid, 'EXECUTE')
        or has_function_privilege(v_authenticated_role, procedure.oid, 'EXECUTE')
        or not has_function_privilege(v_service_role, procedure.oid, 'EXECUTE')
  ) then
    raise exception 'IMAGE_SECURITY_DEFINER_EXECUTE_ACL_REQUIRED' using errcode = '55000';
  end if;
end;
$owner_alignment_guard$;

commit;
