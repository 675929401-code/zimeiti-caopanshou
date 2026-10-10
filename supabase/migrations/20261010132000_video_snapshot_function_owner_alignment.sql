begin;

set local lock_timeout = '10s';

-- These RPCs accept caller-supplied task/user identity and mutate video_tasks.
-- Derive one authoritative owner from the protected table instead of assuming
-- that postgres, a bootstrap role, or a deployment identity owns the table.
do $owner_alignment$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_service_role oid := to_regrole('service_role');
  v_signature text;
  v_grantee_oid oid;
  v_grantee_name name;
  v_unexpected_effective_roles text;
begin
  select relation.relowner, pg_get_userbyid(relation.relowner)
    into v_table_owner_oid, v_table_owner
    from pg_class relation
   where relation.oid = 'public.video_tasks'::regclass;

  if v_table_owner_oid is null or v_table_owner is null then
    raise exception 'VIDEO_TASKS_TABLE_OWNER_NOT_FOUND' using errcode = '55000';
  end if;
  if v_service_role is null then
    raise exception 'VIDEO_SNAPSHOT_SERVICE_ROLE_NOT_FOUND' using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)',
    'public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)',
    'public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'VIDEO_SNAPSHOT_SECURITY_DEFINER_FUNCTION_NOT_FOUND:%', v_signature using errcode = '55000';
    end if;

    execute format('alter function %s owner to %I', v_signature, v_table_owner);
    execute format('alter function %s security definer', v_signature);
    execute format('alter function %s set search_path = public, pg_temp', v_signature);

    -- Remove every explicit EXECUTE grant except the derived table owner and
    -- service_role. This also handles environment-specific extra roles.
    for v_grantee_oid, v_grantee_name in
      select distinct acl.grantee,
             coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')::name
        from pg_proc procedure
        cross join lateral aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) acl
       where procedure.oid = to_regprocedure(v_signature)
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee not in (procedure.proowner, v_service_role)
    loop
      if v_grantee_oid = 0 then
        execute format('revoke all on function %s from public', v_signature);
      else
        execute format('revoke all on function %s from %I', v_signature, v_grantee_name);
      end if;
    end loop;

    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);

    -- Superusers have inherent PostgreSQL authority and cannot be denied with
    -- an ACL. Every ordinary role other than owner/service_role must have no
    -- effective EXECUTE, including privileges inherited through membership.
    select string_agg(role_entry.rolname, ',' order by role_entry.rolname)
      into v_unexpected_effective_roles
      from pg_roles role_entry
     where role_entry.oid not in (v_table_owner_oid, v_service_role)
       and not role_entry.rolsuper
       and has_function_privilege(role_entry.oid, to_regprocedure(v_signature), 'EXECUTE');
    if v_unexpected_effective_roles is not null then
      raise exception 'VIDEO_SNAPSHOT_UNEXPECTED_EFFECTIVE_EXECUTE:%:%', v_signature, v_unexpected_effective_roles
        using errcode = '55000';
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
    ) or not has_function_privilege(v_service_role, to_regprocedure(v_signature), 'EXECUTE') then
      raise exception 'VIDEO_SNAPSHOT_EXECUTE_ACL_ALIGNMENT_FAILED:%', v_signature using errcode = '55000';
    end if;
  end loop;
end;
$owner_alignment$;

comment on function public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text) is
  'Table-owner SECURITY DEFINER persistence for immutable video request snapshots; direct EXECUTE is limited to service_role.';
comment on function public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text) is
  'Table-owner SECURITY DEFINER reservation with immutable video request snapshot; direct EXECUTE is limited to service_role.';
comment on function public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text) is
  'Table-owner SECURITY DEFINER queued reservation with immutable video request snapshot; direct EXECUTE is limited to service_role.';

notify pgrst, 'reload schema';
commit;
