begin;

set local lock_timeout = '10s';

-- SECURITY DEFINER switches to the caller owner before entering the routing
-- function. Grant only these two dependency edges; preserve callee ownership.
do $dependency_execute$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_service_role oid := to_regrole('service_role');
  v_anon_role oid := to_regrole('anon');
  v_authenticated_role oid := to_regrole('authenticated');
  v_edge record;
  v_caller oid;
  v_callee oid;
  v_callee_owner oid;
begin
  select relation.relowner, pg_get_userbyid(relation.relowner)
    into v_table_owner_oid, v_table_owner
    from pg_class relation
   where relation.oid = to_regclass('public.video_tasks');

  if v_table_owner_oid is null or v_service_role is null
    or v_anon_role is null or v_authenticated_role is null then
    raise exception 'VIDEO_SNAPSHOT_DEPENDENCY_RUNTIME_IDENTITY_REQUIRED' using errcode = '55000';
  end if;

  for v_edge in
    select * from (values
      (
        'public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)',
        'public.reserve_video_generation_task_routing_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)'
      ),
      (
        'public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)',
        'public.reserve_queued_digital_video_task_routing_atomic(jsonb,jsonb,jsonb)'
      )
    ) as edges(caller_signature, callee_signature)
  loop
    v_caller := to_regprocedure(v_edge.caller_signature);
    v_callee := to_regprocedure(v_edge.callee_signature);
    if v_caller is null or v_callee is null then
      raise exception 'VIDEO_SNAPSHOT_DEPENDENCY_FUNCTION_MISSING' using errcode = '55000';
    end if;
    if not exists (
      select 1 from pg_proc p
       where p.oid = v_caller and p.proowner = v_table_owner_oid
         and p.prosecdef
         and p.proconfig = array['search_path=public, pg_temp']::text[]
    ) or not exists (
      select 1 from pg_proc p
       where p.oid = v_callee and p.prosecdef
         and p.proconfig = array['search_path=public, pg_temp']::text[]
         and has_schema_privilege(v_table_owner_oid, p.pronamespace, 'USAGE')
    ) then
      raise exception 'VIDEO_SNAPSHOT_DEPENDENCY_SECURITY_CONTEXT_MISMATCH' using errcode = '55000';
    end if;

    select p.proowner into v_callee_owner from pg_proc p where p.oid = v_callee;
    if exists (
      select 1 from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where p.oid = v_callee and acl.privilege_type = 'EXECUTE'
         and acl.grantee not in (v_callee_owner, v_table_owner_oid, v_service_role)
    ) or has_function_privilege(v_anon_role, v_callee, 'EXECUTE')
      or has_function_privilege(v_authenticated_role, v_callee, 'EXECUTE')
      or not has_function_privilege(v_service_role, v_callee, 'EXECUTE') then
      raise exception 'VIDEO_SNAPSHOT_DEPENDENCY_EXECUTE_BASELINE_MISMATCH' using errcode = '55000';
    end if;

    execute format('grant execute on function %s to %I', v_edge.callee_signature, v_table_owner);

    if not has_function_privilege(v_table_owner_oid, v_callee, 'EXECUTE')
      or exists (
        select 1 from pg_roles r
         where r.oid not in (v_callee_owner, v_table_owner_oid, v_service_role)
           and not r.rolsuper
           and has_function_privilege(r.oid, v_callee, 'EXECUTE')
      ) then
      raise exception 'VIDEO_SNAPSHOT_DEPENDENCY_EFFECTIVE_EXECUTE_MISMATCH' using errcode = '55000';
    end if;
  end loop;
end;
$dependency_execute$;

commit;
