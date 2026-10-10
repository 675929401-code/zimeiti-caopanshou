begin;

set local lock_timeout = '10s';

-- Provider request hashes are financial/idempotency evidence. Rolling back by
-- deleting or weakening them would make an accepted upstream POST appear safe
-- to repeat. This rollback is intentionally a forward-repair guard.
do $video_provider_projection_forward_repair_guard$
declare
  v_table_owner oid;
  v_service_role oid := to_regrole('service_role');
  v_signature text;
  v_definition text;
  v_unexpected_roles text;
begin
  select relation.relowner into v_table_owner
    from pg_class relation
   where relation.oid = 'public.video_tasks'::regclass;
  if v_table_owner is null or v_service_role is null then
    raise exception 'VIDEO_PROVIDER_PROJECTION_FORWARD_REPAIR_REQUIRED' using errcode = '55000';
  end if;
  foreach v_signature in array array[
    'public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb)',
    'public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'VIDEO_PROVIDER_PROJECTION_FORWARD_REPAIR_REQUIRED:%', v_signature using errcode = '55000';
    end if;
    select pg_get_functiondef(procedure.oid) into v_definition
      from pg_proc procedure where procedure.oid = to_regprocedure(v_signature);
    if exists (
      select 1 from pg_proc procedure
       where procedure.oid = to_regprocedure(v_signature)
         and (procedure.proowner <> v_table_owner
           or not procedure.prosecdef
           or procedure.proconfig is distinct from array['search_path=public, pg_temp']::text[]
           or has_function_privilege('anon', procedure.oid, 'EXECUTE')
           or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
           or not has_function_privilege(v_service_role, procedure.oid, 'EXECUTE'))
    ) then
      raise exception 'VIDEO_PROVIDER_PROJECTION_SECURITY_REPAIR_REQUIRED:%', v_signature using errcode = '55000';
    end if;
    select string_agg(role_entry.rolname, ',' order by role_entry.rolname)
      into v_unexpected_roles
      from pg_roles role_entry
     where role_entry.oid not in (v_table_owner, v_service_role)
       and not role_entry.rolsuper
       and has_function_privilege(role_entry.oid, to_regprocedure(v_signature), 'EXECUTE');
    if v_unexpected_roles is not null then
      raise exception 'VIDEO_PROVIDER_PROJECTION_ACL_REPAIR_REQUIRED:%:%', v_signature, v_unexpected_roles using errcode = '55000';
    end if;
    if v_definition not like '%wireBodySha256%'
       or (v_signature like '%dispatch%' and (
         v_definition not like '%endpointPath%'
         or v_definition not like '%attemptOrdinal%'
         or v_definition not like '%dispatchIdentitySha256%'
         or v_definition not like '%VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT%'
         or v_definition not like '%VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT%'
         or v_definition not like '%raise exception ''VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT''%'
       ))
       or (v_signature like '%submission%' and (
         v_definition not like '%dispatchReceiptSha256%'
         or v_definition not like '%dispatchIdentitySha256s%'
         or v_definition not like '%dispatchAttemptCount%'
         or v_definition not like '%VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_V2_DISPATCH%'
       )) then
      raise exception 'VIDEO_PROVIDER_PROJECTION_SEMANTIC_REPAIR_REQUIRED:%', v_signature using errcode = '55000';
    end if;
  end loop;
end;
$video_provider_projection_forward_repair_guard$;

commit;
