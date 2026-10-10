begin;

set local lock_timeout = '10s';

-- Both RPCs accept an explicit user id and therefore must execute under one
-- environment-independent, authoritative owner. Derive that owner from the
-- protected request table instead of hard-coding a bootstrap/superuser role.
do $owner_alignment$
declare
  v_table_owner name;
  v_signature text;
  v_grantee_oid oid;
  v_grantee_name name;
begin
  select pg_get_userbyid(relation.relowner)
    into v_table_owner
    from pg_class relation
   where relation.oid = 'public.image_generation_requests'::regclass;

  if v_table_owner is null then
    raise exception 'IMAGE_REQUEST_TABLE_OWNER_NOT_FOUND' using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)',
    'public.reconcile_stale_image_generation_request_atomic(text,text,integer)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'IMAGE_SECURITY_DEFINER_FUNCTION_NOT_FOUND:%', v_signature using errcode = '55000';
    end if;

    execute format('alter function %s owner to %I', v_signature, v_table_owner);
    execute format('alter function %s security definer', v_signature);
    execute format('alter function %s set search_path = public, pg_temp', v_signature);

    -- Remove every direct EXECUTE grant except the derived owner and the
    -- application service role. Membership-based privileges are checked by
    -- the release verifier after this migration.
    for v_grantee_oid, v_grantee_name in
      select distinct acl.grantee,
             coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')::name
        from pg_proc procedure
        cross join lateral aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) acl
       where procedure.oid = to_regprocedure(v_signature)
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee <> procedure.proowner
         and coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC') <> 'service_role'
    loop
      if v_grantee_oid = 0 then
        execute format('revoke all on function %s from public', v_signature);
      else
        execute format('revoke all on function %s from %I', v_signature, v_grantee_name);
      end if;
    end loop;

    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$owner_alignment$;

comment on function public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb) is
  'Table-owner SECURITY DEFINER claim for immutable image requests; direct EXECUTE is limited to service_role.';
comment on function public.reconcile_stale_image_generation_request_atomic(text,text,integer) is
  'Table-owner SECURITY DEFINER stale image reconciliation; direct EXECUTE is limited to service_role.';

notify pgrst, 'reload schema';
commit;
