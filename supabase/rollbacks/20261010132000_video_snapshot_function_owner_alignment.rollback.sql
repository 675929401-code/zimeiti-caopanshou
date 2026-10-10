begin;

set local lock_timeout = '10s';

-- Forward-repair-only rollback guard. Restoring a bootstrap/superuser owner or
-- widening EXECUTE would recreate the vulnerability. This guard deliberately
-- preserves the functions, video_tasks rows, and the 20261010132000 ledger row.
do $owner_alignment_guard$
declare
  v_table_owner oid;
  v_service_role oid := to_regrole('service_role');
  v_anon_role oid := to_regrole('anon');
  v_authenticated_role oid := to_regrole('authenticated');
  v_signature text;
  v_unexpected_effective_roles text;
begin
  select relation.relowner
    into v_table_owner
    from pg_class relation
   where relation.oid = 'public.video_tasks'::regclass;

  if v_table_owner is null or v_service_role is null or v_anon_role is null or v_authenticated_role is null then
    raise exception 'VIDEO_SNAPSHOT_OWNER_ALIGNMENT_RUNTIME_ROLE_REQUIRED' using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)',
    'public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)',
    'public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)'
  ] loop
    if to_regprocedure(v_signature) is null or exists (
      select 1
        from pg_proc procedure
       where procedure.oid = to_regprocedure(v_signature)
         and (procedure.proowner <> v_table_owner
           or not procedure.prosecdef
           or procedure.proconfig is distinct from array['search_path=public, pg_temp']::text[])
    ) then
      raise exception 'VIDEO_SNAPSHOT_SECURITY_DEFINER_OWNER_ALIGNMENT_REQUIRED:%', v_signature using errcode = '55000';
    end if;

    if exists (
      select 1
        from pg_proc procedure
        cross join lateral aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) acl
       where procedure.oid = to_regprocedure(v_signature)
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee not in (procedure.proowner, v_service_role)
    ) or not exists (
      select 1
        from pg_proc procedure
        cross join lateral aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) acl
       where procedure.oid = to_regprocedure(v_signature)
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee = v_service_role
         and not acl.is_grantable
    ) or has_function_privilege(v_anon_role, to_regprocedure(v_signature), 'EXECUTE')
      or has_function_privilege(v_authenticated_role, to_regprocedure(v_signature), 'EXECUTE')
      or not has_function_privilege(v_service_role, to_regprocedure(v_signature), 'EXECUTE') then
      raise exception 'VIDEO_SNAPSHOT_EXECUTE_ACL_REQUIRED:%', v_signature using errcode = '55000';
    end if;

    select string_agg(role_entry.rolname, ',' order by role_entry.rolname)
      into v_unexpected_effective_roles
      from pg_roles role_entry
     where role_entry.oid not in (v_table_owner, v_service_role)
       and not role_entry.rolsuper
       and has_function_privilege(role_entry.oid, to_regprocedure(v_signature), 'EXECUTE');
    if v_unexpected_effective_roles is not null then
      raise exception 'VIDEO_SNAPSHOT_UNEXPECTED_EFFECTIVE_EXECUTE:%:%', v_signature, v_unexpected_effective_roles
        using errcode = '55000';
    end if;
  end loop;
end;
$owner_alignment_guard$;

commit;
