begin;

set local lock_timeout = '10s';

-- Keep the existing receipt columns as the single evidence source. Version 2
-- request entries add a digest of the exact Request body bytes plus a small,
-- non-secret projection. Historical version 1 entries remain readable.
create or replace function public.record_video_provider_dispatch_receipt_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_receipt jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.video_tasks%rowtype;
  v_receipts jsonb;
  v_projection jsonb := p_receipt->'requestProjection';
  v_expected_attempt_ordinal integer;
begin
  if jsonb_typeof(p_receipt) is distinct from 'object'
     or p_receipt->>'schemaVersion' is distinct from '2'
     or coalesce(p_receipt->>'endpointHost', '') = ''
     or p_receipt->>'endpointHost' like '%://%'
     or length(coalesce(p_receipt->>'endpointPath', '')) not between 1 and 2048
     or coalesce(p_receipt->>'endpointPath', '') !~ '^/[^?#]*$'
     or coalesce(p_receipt->>'attemptOrdinal', '') !~ '^[1-9][0-9]*$'
     or (p_receipt->>'attemptOrdinal')::numeric not between 1 and 16
     or coalesce(p_receipt->>'dispatchIdentitySha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_receipt->>'routingConfigVersion', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_receipt->>'wireBodySha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_receipt->>'wireBodyBytes', '') !~ '^[0-9]+$'
     or (p_receipt->>'wireBodyBytes')::numeric not between 1 and 134217728
     or coalesce(p_receipt->>'requestContentType', '') not in ('application/json', 'multipart/form-data')
     or jsonb_typeof(v_projection) is distinct from 'object'
     or not (v_projection ?& array[
       'effectivePromptSha256','duration','resolution','aspectRatio',
       'referenceImageCount','referenceAudioCount','generateAudioState'
     ])
     or (v_projection->'effectivePromptSha256' <> 'null'::jsonb
       and coalesce(v_projection->>'effectivePromptSha256', '') !~ '^[0-9a-f]{64}$')
     or (v_projection->'duration' <> 'null'::jsonb and (
       jsonb_typeof(v_projection->'duration') is distinct from 'number'
       or (v_projection->>'duration')::numeric not between 0 and 86400
     ))
     or (v_projection->'resolution' <> 'null'::jsonb and (
       jsonb_typeof(v_projection->'resolution') is distinct from 'string'
       or v_projection->>'resolution' !~ '^[A-Za-z0-9][A-Za-z0-9._xX:-]{0,63}$'
     ))
     or (v_projection->'aspectRatio' <> 'null'::jsonb and (
       jsonb_typeof(v_projection->'aspectRatio') is distinct from 'string'
       or v_projection->>'aspectRatio' !~ '^[A-Za-z0-9][A-Za-z0-9._xX:-]{0,63}$'
     ))
     or coalesce(v_projection->>'referenceImageCount', '') !~ '^[0-9]+$'
     or (v_projection->>'referenceImageCount')::numeric not between 0 and 128
     or coalesce(v_projection->>'referenceAudioCount', '') !~ '^[0-9]+$'
     or (v_projection->>'referenceAudioCount')::numeric not between 0 and 128
     or coalesce(v_projection->>'generateAudioState', '') not in ('provided_true', 'provided_false', 'omitted')
     or p_receipt::text ~* '"(rawPrompt|rawBody|base64|authorization|apiKey|token|query|requestUrl)"[[:space:]]*:'
     or pg_column_size(p_receipt) > 8192 then
    raise exception 'VIDEO_PROVIDER_DISPATCH_RECEIPT_V2_INVALID' using errcode = '22023';
  end if;

  select * into v_task
    from public.video_tasks
   where id::text = trim(p_task_id)
     and user_id::text = trim(p_user_id)
   for update;
  if not found then
    raise exception 'VIDEO_PROVIDER_DISPATCH_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_task.request_fingerprint is distinct from lower(trim(p_request_fingerprint))
     or v_task.routing_snapshot is null
     or v_task.routing_snapshot_hash is distinct from p_receipt->>'routingConfigVersion'
     or v_task.status in ('completed', 'failed', 'cancelled', 'expired') then
    raise exception 'VIDEO_PROVIDER_DISPATCH_NOT_ALLOWED' using errcode = '23514';
  end if;

  v_receipts := coalesce(v_task.provider_dispatch_receipt, '{"schemaVersion":1,"requests":[]}'::jsonb);
  select count(*)::integer + 1
    into v_expected_attempt_ordinal
    from jsonb_array_elements(v_receipts->'requests') item
   where item->>'schemaVersion' = '2';
  if (p_receipt->>'attemptOrdinal')::integer is distinct from v_expected_attempt_ordinal then
    raise exception 'VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT' using errcode = '23505';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_receipts->'requests') item
     where item->>'schemaVersion' = '2'
       and item->>'wireBodySha256' = p_receipt->>'wireBodySha256'
  ) then
    raise exception 'VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT' using errcode = '23505';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_receipts->'requests') item
     where item->>'schemaVersion' = '2'
       and item->>'dispatchIdentitySha256' = p_receipt->>'dispatchIdentitySha256'
  ) then
    raise exception 'VIDEO_PROVIDER_DISPATCH_IDENTITY_CONFLICT' using errcode = '23505';
  end if;
  if jsonb_array_length(v_receipts->'requests') >= 16 then
    raise exception 'VIDEO_PROVIDER_DISPATCH_RECEIPT_LIMIT' using errcode = '54000';
  end if;
  v_receipts := jsonb_set(v_receipts, '{requests}', (v_receipts->'requests') || jsonb_build_array(p_receipt));

  update public.video_tasks
     set provider_dispatch_receipt = v_receipts,
         provider_dispatch_started_at = coalesce(provider_dispatch_started_at, clock_timestamp()),
         provider_reconciliation_state = case
           when provider_reconciliation_state = 'acknowledged' then provider_reconciliation_state
           else 'dispatch_recorded'
         end
   where id = v_task.id;
  return jsonb_build_object(
    'task_id', v_task.id,
    'dispatch_recorded', true,
    'wire_body_sha256', p_receipt->>'wireBodySha256',
    'dispatch_identity_sha256', p_receipt->>'dispatchIdentitySha256',
    'attempt_ordinal', (p_receipt->>'attemptOrdinal')::integer
  );
end
$$;

create or replace function public.record_video_provider_submission_receipt_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_outcome text,
  p_provider_task_id text,
  p_receipt jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.video_tasks%rowtype;
  v_receipts jsonb;
  v_event jsonb;
  v_provider_task_id text := nullif(trim(coalesce(p_provider_task_id, '')), '');
  v_dispatch_receipt_sha256 text;
  v_dispatch_wire_hashes jsonb;
  v_dispatch_identities jsonb;
  v_dispatch_attempt_count integer;
begin
  if p_outcome not in ('unknown', 'acknowledged')
     or (p_outcome = 'acknowledged' and v_provider_task_id is null)
     or jsonb_typeof(p_receipt) is distinct from 'object'
     or p_receipt->>'schemaVersion' is distinct from '1'
     or pg_column_size(p_receipt) > 8192 then
    raise exception 'VIDEO_PROVIDER_SUBMISSION_RECEIPT_INVALID' using errcode = '22023';
  end if;

  select * into v_task
    from public.video_tasks
   where id::text = trim(p_task_id)
     and user_id::text = trim(p_user_id)
   for update;
  if not found then
    raise exception 'VIDEO_PROVIDER_SUBMISSION_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_task.request_fingerprint is distinct from lower(trim(p_request_fingerprint))
     or v_task.provider_dispatch_started_at is null
     or v_task.provider_dispatch_receipt is null then
    raise exception 'VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_DISPATCH' using errcode = '23514';
  end if;

  v_dispatch_receipt_sha256 := encode(sha256(convert_to(v_task.provider_dispatch_receipt::text, 'UTF8')), 'hex');
  select coalesce(jsonb_agg(item.value->>'wireBodySha256' order by item.ordinality)
    filter (where item.value->>'schemaVersion' = '2'), '[]'::jsonb)
    into v_dispatch_wire_hashes
    from jsonb_array_elements(v_task.provider_dispatch_receipt->'requests') with ordinality item(value, ordinality);
  select coalesce(jsonb_agg(item.value->>'dispatchIdentitySha256' order by item.ordinality)
    filter (where item.value->>'schemaVersion' = '2'), '[]'::jsonb),
    (count(*) filter (where item.value->>'schemaVersion' = '2'))::integer
    into v_dispatch_identities, v_dispatch_attempt_count
    from jsonb_array_elements(v_task.provider_dispatch_receipt->'requests') with ordinality item(value, ordinality);
  if v_dispatch_attempt_count < 1 then
    raise exception 'VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_V2_DISPATCH' using errcode = '23514';
  end if;
  v_event := jsonb_build_object(
    'outcome', p_outcome,
    'providerTaskIdHash', case when v_provider_task_id is null then null else encode(sha256(convert_to(v_provider_task_id, 'UTF8')), 'hex') end,
    'dispatchReceiptSha256', v_dispatch_receipt_sha256,
    'dispatchWireBodySha256s', v_dispatch_wire_hashes,
    'dispatchIdentitySha256s', v_dispatch_identities,
    'dispatchAttemptCount', v_dispatch_attempt_count,
    'receipt', p_receipt
  );
  v_receipts := coalesce(v_task.provider_submission_receipt, '{"schemaVersion":1,"events":[]}'::jsonb);
  if not exists (select 1 from jsonb_array_elements(v_receipts->'events') item where item = v_event) then
    if jsonb_array_length(v_receipts->'events') >= 16 then
      raise exception 'VIDEO_PROVIDER_SUBMISSION_RECEIPT_LIMIT' using errcode = '54000';
    end if;
    v_receipts := jsonb_set(v_receipts, '{events}', (v_receipts->'events') || jsonb_build_array(v_event));
  end if;
  update public.video_tasks
     set provider_submission_receipt = v_receipts,
         provider_acknowledged_at = case when p_outcome = 'acknowledged' then coalesce(provider_acknowledged_at, clock_timestamp()) else provider_acknowledged_at end,
         provider_reconciliation_state = case when p_outcome = 'acknowledged' then 'acknowledged' else 'reconciliation_required' end,
         status = case when p_outcome = 'unknown' then 'pending' else status end,
         submission_error_code = case when p_outcome = 'unknown' then 'VIDEO_SUBMIT_OUTCOME_UNKNOWN' else submission_error_code end,
         error_message = case when p_outcome = 'unknown' then '上游提交结果尚未确认，系统将保留原任务且不会重复提交' else error_message end,
         completed_at = case when p_outcome = 'unknown' then null else completed_at end
   where id = v_task.id;
  return jsonb_build_object(
    'task_id', v_task.id,
    'outcome', p_outcome,
    'reconciliation_state', case when p_outcome = 'acknowledged' then 'acknowledged' else 'reconciliation_required' end,
    'dispatch_receipt_sha256', v_dispatch_receipt_sha256,
    'dispatch_wire_body_sha256s', v_dispatch_wire_hashes,
    'dispatch_identity_sha256s', v_dispatch_identities,
    'dispatch_attempt_count', v_dispatch_attempt_count
  );
end
$$;

do $security_alignment$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_service_role oid := to_regrole('service_role');
  v_signature text;
  v_grantee_oid oid;
  v_grantee_name name;
  v_unexpected_roles text;
begin
  select relation.relowner, pg_get_userbyid(relation.relowner)
    into v_table_owner_oid, v_table_owner
    from pg_class relation
   where relation.oid = 'public.video_tasks'::regclass;
  if v_table_owner_oid is null or v_table_owner is null then
    raise exception 'VIDEO_TASKS_TABLE_OWNER_NOT_FOUND' using errcode = '55000';
  end if;
  if v_service_role is null then
    raise exception 'VIDEO_PROVIDER_RECEIPT_SERVICE_ROLE_NOT_FOUND' using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb)',
    'public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)'
  ] loop
    execute format('alter function %s owner to %I', v_signature, v_table_owner);
    execute format('alter function %s security definer', v_signature);
    execute format('alter function %s set search_path = public, pg_temp', v_signature);
    for v_grantee_oid, v_grantee_name in
      select distinct acl.grantee, coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')::name
        from pg_proc procedure
        cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
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
    select string_agg(role_entry.rolname, ',' order by role_entry.rolname)
      into v_unexpected_roles
      from pg_roles role_entry
     where role_entry.oid not in (v_table_owner_oid, v_service_role)
       and not role_entry.rolsuper
       and has_function_privilege(role_entry.oid, to_regprocedure(v_signature), 'EXECUTE');
    if v_unexpected_roles is not null then
      raise exception 'VIDEO_PROVIDER_RECEIPT_UNEXPECTED_EFFECTIVE_EXECUTE:%:%', v_signature, v_unexpected_roles using errcode = '55000';
    end if;
  end loop;
end;
$security_alignment$;

comment on column public.video_tasks.provider_dispatch_receipt is
  'Versioned redacted provider POST receipts. V2 binds endpoint, ordered dispatch identity, exact wire-body hash, and safe projection before dispatch; duplicate wire bodies conflict.';
comment on column public.video_tasks.provider_submission_receipt is
  'Redacted response evidence bound to the durable dispatch receipt, ordered dispatch identities, exact attempt count, and V2 wire-body hashes.';

notify pgrst, 'reload schema';
commit;
