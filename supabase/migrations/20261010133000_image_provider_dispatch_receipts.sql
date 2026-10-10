begin;

set local lock_timeout = '10s';

alter table public.image_generation_requests
  add column if not exists provider_dispatch_receipt jsonb,
  add column if not exists provider_submission_receipt jsonb;

alter table public.image_generation_requests
  drop constraint if exists image_generation_requests_provider_receipt_order,
  add constraint image_generation_requests_provider_receipt_order check (
    provider_submission_receipt is null or provider_dispatch_receipt is not null
  ) not valid;

alter table public.image_generation_requests
  validate constraint image_generation_requests_provider_receipt_order;

create or replace function public.record_image_provider_dispatch_receipt_atomic(
  p_record_id text,
  p_user_id text,
  p_client_trace_id text,
  p_payload_fingerprint text,
  p_receipt jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.image_generation_requests%rowtype;
  v_projection jsonb;
begin
  if trim(coalesce(p_record_id, '')) = ''
     or trim(coalesce(p_user_id, '')) = ''
     or trim(coalesce(p_client_trace_id, '')) = ''
     or trim(coalesce(p_payload_fingerprint, '')) !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_receipt) is distinct from 'object'
     or octet_length(p_receipt::text) > 8192
     or coalesce(p_receipt->>'schema', '') <> 'image_provider_dispatch_receipt.v1'
     or coalesce(p_receipt->>'receiptId', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     or coalesce(p_receipt->>'receiptSha256', '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_receipt->>'recordedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     or p_receipt->>'receiptSha256' <> encode(sha256(convert_to(concat(
       'schema=', coalesce(p_receipt->>'schema', ''), E'\n',
       'receiptId=', coalesce(p_receipt->>'receiptId', ''), E'\n',
       'recordedAt=', coalesce(p_receipt->>'recordedAt', ''), E'\n',
       'providerProtocol=', coalesce(p_receipt->>'providerProtocol', ''), E'\n',
       'endpointOriginSha256=', coalesce(p_receipt->>'endpointOriginSha256', ''), E'\n',
       'requestContentType=', coalesce(p_receipt->>'requestContentType', ''), E'\n',
       'actualPayloadSha256=', coalesce(p_receipt->>'actualPayloadSha256', ''), E'\n',
       'actualPayloadBytes=', coalesce(p_receipt->>'actualPayloadBytes', ''), E'\n',
       'idempotencyKeySha256=', coalesce(p_receipt->>'idempotencyKeySha256', ''), E'\n',
       'requestProjection.userPromptSha256=', coalesce(p_receipt->'requestProjection'->>'userPromptSha256', ''), E'\n',
       'requestProjection.effectivePromptSha256=', coalesce(p_receipt->'requestProjection'->>'effectivePromptSha256', ''), E'\n',
       'requestProjection.modelIdSha256=', coalesce(p_receipt->'requestProjection'->>'modelIdSha256', ''), E'\n',
       'requestProjection.aspectRatio=', coalesce(p_receipt->'requestProjection'->>'aspectRatio', ''), E'\n',
       'requestProjection.resolution=', coalesce(p_receipt->'requestProjection'->>'resolution', ''), E'\n',
       'requestProjection.imageCount=', coalesce(p_receipt->'requestProjection'->>'imageCount', ''), E'\n',
       'requestProjection.referenceCount=', coalesce(p_receipt->'requestProjection'->>'referenceCount', '')
     ), 'UTF8')), 'hex')
     or coalesce(p_receipt->>'endpointOriginSha256', '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_receipt->>'actualPayloadSha256', '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_receipt->>'providerProtocol', '') not in (
       'google_generate_content', 'chat_completions', 'images_generations',
       'images_generations_async', 'images_edits', 'cover_workflow'
     )
     or coalesce(p_receipt->>'requestContentType', '') not in ('application/json', 'multipart/form-data')
     or jsonb_typeof(p_receipt->'actualPayloadBytes') is distinct from 'number'
     or coalesce(p_receipt->>'actualPayloadBytes', '') !~ '^[0-9]+$'
     or (p_receipt->>'actualPayloadBytes')::bigint not between 1 and 52428800
     or (p_receipt ? 'idempotencyKeySha256' and coalesce(p_receipt->>'idempotencyKeySha256', '') !~ '^[a-f0-9]{64}$')
     or (p_receipt - array[
       'schema','receiptId','receiptSha256','recordedAt','providerProtocol','endpointOriginSha256',
       'requestContentType','actualPayloadSha256','actualPayloadBytes','idempotencyKeySha256','requestProjection'
     ]::text[]) <> '{}'::jsonb then
    raise exception 'IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID' using errcode = '22023';
  end if;

  begin
    perform (p_receipt->>'recordedAt')::timestamptz;
  exception when others then
    raise exception 'IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID' using errcode = '22023';
  end;

  v_projection := p_receipt->'requestProjection';
  if jsonb_typeof(v_projection) is distinct from 'object'
     or (v_projection - array[
       'userPromptSha256','effectivePromptSha256','modelIdSha256','aspectRatio',
       'resolution','imageCount','referenceCount'
     ]::text[]) <> '{}'::jsonb
     or coalesce(v_projection->>'userPromptSha256', '') !~ '^[a-f0-9]{64}$'
     or coalesce(v_projection->>'effectivePromptSha256', '') !~ '^[a-f0-9]{64}$'
     or coalesce(v_projection->>'modelIdSha256', '') !~ '^[a-f0-9]{64}$'
     or coalesce(v_projection->>'aspectRatio', '') !~ '^\d{1,3}:\d{1,3}$'
     or coalesce(v_projection->>'resolution', '') not in ('0.5K','1K','2K','3K','4K')
     or v_projection->'imageCount' is distinct from '1'::jsonb
     or jsonb_typeof(v_projection->'referenceCount') is distinct from 'number'
     or coalesce(v_projection->>'referenceCount', '') !~ '^[0-9]+$'
     or (v_projection->>'referenceCount')::integer not between 0 and 9 then
    raise exception 'IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID' using errcode = '22023';
  end if;

  select * into v_request
    from public.image_generation_requests
   where record_id = trim(p_record_id)
     and user_id = trim(p_user_id)
   for update;

  if not found
     or v_request.client_trace_id <> trim(p_client_trace_id)
     or v_request.payload_fingerprint <> trim(p_payload_fingerprint) then
    raise exception 'IMAGE_PROVIDER_RECEIPT_REQUEST_CONFLICT' using errcode = '22023';
  end if;
  if v_request.state <> 'intent' then
    raise exception 'IMAGE_PROVIDER_RECEIPT_TERMINAL_CONFLICT' using errcode = '22023';
  end if;
  if v_request.provider_dispatch_receipt is not null then
    if v_request.provider_dispatch_receipt is distinct from p_receipt then
      raise exception 'IMAGE_PROVIDER_DISPATCH_RECEIPT_CONFLICT' using errcode = '22023';
    end if;
    return jsonb_build_object('created', false, 'record', to_jsonb(v_request));
  end if;

  update public.image_generation_requests
     set provider_dispatch_receipt = p_receipt,
         updated_at = clock_timestamp()
   where record_id = v_request.record_id
   returning * into v_request;

  return jsonb_build_object('created', true, 'record', to_jsonb(v_request));
end;
$$;

create or replace function public.record_image_provider_submission_receipt_atomic(
  p_record_id text,
  p_user_id text,
  p_client_trace_id text,
  p_payload_fingerprint text,
  p_dispatch_receipt_sha256 text,
  p_receipt jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.image_generation_requests%rowtype;
begin
  if trim(coalesce(p_record_id, '')) = ''
     or trim(coalesce(p_user_id, '')) = ''
     or trim(coalesce(p_client_trace_id, '')) = ''
     or trim(coalesce(p_payload_fingerprint, '')) !~ '^[a-f0-9]{64}$'
     or trim(coalesce(p_dispatch_receipt_sha256, '')) !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_receipt) is distinct from 'object'
     or octet_length(p_receipt::text) > 8192
     or coalesce(p_receipt->>'schema', '') <> 'image_provider_submission_receipt.v1'
     or coalesce(p_receipt->>'receiptId', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     or coalesce(p_receipt->>'receiptSha256', '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_receipt->>'recordedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     or p_receipt->>'receiptSha256' <> encode(sha256(convert_to(concat(
       'schema=', coalesce(p_receipt->>'schema', ''), E'\n',
       'receiptId=', coalesce(p_receipt->>'receiptId', ''), E'\n',
       'dispatchReceiptSha256=', coalesce(p_receipt->>'dispatchReceiptSha256', ''), E'\n',
       'recordedAt=', coalesce(p_receipt->>'recordedAt', ''), E'\n',
       'providerProtocol=', coalesce(p_receipt->>'providerProtocol', ''), E'\n',
       'transportState=', coalesce(p_receipt->>'transportState', ''), E'\n',
       'responseStatus=', coalesce(p_receipt->>'responseStatus', ''), E'\n',
       'responseContentType=', coalesce(p_receipt->>'responseContentType', ''), E'\n',
       'responseBodySha256=', coalesce(p_receipt->>'responseBodySha256', ''), E'\n',
       'responseBodyBytes=', coalesce(p_receipt->>'responseBodyBytes', ''), E'\n',
       'providerAcknowledgementSha256=', coalesce(p_receipt->>'providerAcknowledgementSha256', ''), E'\n',
       'providerAcknowledgementField=', coalesce(p_receipt->>'providerAcknowledgementField', '')
     ), 'UTF8')), 'hex')
     or coalesce(p_receipt->>'dispatchReceiptSha256', '') <> trim(p_dispatch_receipt_sha256)
     or coalesce(p_receipt->>'providerProtocol', '') not in (
       'google_generate_content', 'chat_completions', 'images_generations',
       'images_generations_async', 'images_edits', 'cover_workflow'
     )
     or coalesce(p_receipt->>'transportState', '') not in ('response_received','transport_error','response_body_error')
     or jsonb_typeof(p_receipt->'responseBodyBytes') is distinct from 'number'
     or coalesce(p_receipt->>'responseBodyBytes', '') !~ '^[0-9]+$'
     or (p_receipt->>'responseBodyBytes')::bigint not between 0 and 41943040
     or (p_receipt ? 'responseStatus' and (
       jsonb_typeof(p_receipt->'responseStatus') is distinct from 'number'
       or coalesce(p_receipt->>'responseStatus', '') !~ '^[0-9]+$'
       or (p_receipt->>'responseStatus')::integer not between 100 and 599
     ))
     or (p_receipt ? 'responseBodySha256' and coalesce(p_receipt->>'responseBodySha256', '') !~ '^[a-f0-9]{64}$')
     or (p_receipt ? 'providerAcknowledgementSha256' and coalesce(p_receipt->>'providerAcknowledgementSha256', '') !~ '^[a-f0-9]{64}$')
     or (p_receipt ? 'providerAcknowledgementField' and coalesce(p_receipt->>'providerAcknowledgementField', '') not in ('request_id','task_id','job_id','id'))
     or (p_receipt ? 'responseContentType' and coalesce(p_receipt->>'responseContentType', '') !~ '^[a-z0-9.+-]{1,64}/[a-z0-9.+-]{1,64}$')
     or ((p_receipt->>'responseBodyBytes')::bigint > 0) <> (p_receipt ? 'responseBodySha256')
     or (p_receipt ? 'providerAcknowledgementSha256') <> (p_receipt ? 'providerAcknowledgementField')
     or (p_receipt->>'transportState' = 'response_received' and not (p_receipt ? 'responseStatus'))
     or (p_receipt->>'transportState' = 'transport_error' and (p_receipt ? 'responseStatus'))
     or (p_receipt - array[
       'schema','receiptId','receiptSha256','dispatchReceiptSha256','recordedAt','providerProtocol',
       'transportState','responseStatus','responseContentType','responseBodySha256','responseBodyBytes',
       'providerAcknowledgementSha256','providerAcknowledgementField'
     ]::text[]) <> '{}'::jsonb then
    raise exception 'IMAGE_PROVIDER_SUBMISSION_RECEIPT_INVALID' using errcode = '22023';
  end if;

  begin
    perform (p_receipt->>'recordedAt')::timestamptz;
  exception when others then
    raise exception 'IMAGE_PROVIDER_SUBMISSION_RECEIPT_INVALID' using errcode = '22023';
  end;

  select * into v_request
    from public.image_generation_requests
   where record_id = trim(p_record_id)
     and user_id = trim(p_user_id)
   for update;

  if not found
     or v_request.client_trace_id <> trim(p_client_trace_id)
     or v_request.payload_fingerprint <> trim(p_payload_fingerprint) then
    raise exception 'IMAGE_PROVIDER_RECEIPT_REQUEST_CONFLICT' using errcode = '22023';
  end if;
  if v_request.state <> 'intent'
     or coalesce(v_request.provider_dispatch_receipt->>'receiptSha256', '') <> trim(p_dispatch_receipt_sha256)
     or v_request.provider_dispatch_receipt->>'providerProtocol' is distinct from p_receipt->>'providerProtocol' then
    raise exception 'IMAGE_PROVIDER_SUBMISSION_RECEIPT_CONFLICT' using errcode = '22023';
  end if;
  if v_request.provider_submission_receipt is not null then
    if v_request.provider_submission_receipt is distinct from p_receipt then
      raise exception 'IMAGE_PROVIDER_SUBMISSION_RECEIPT_CONFLICT' using errcode = '22023';
    end if;
    return jsonb_build_object('created', false, 'record', to_jsonb(v_request));
  end if;

  update public.image_generation_requests
     set provider_submission_receipt = p_receipt,
         updated_at = clock_timestamp()
   where record_id = v_request.record_id
   returning * into v_request;

  return jsonb_build_object('created', true, 'record', to_jsonb(v_request));
end;
$$;

-- Keep the 1300 implementation as an owner-only helper.  The public wrapper
-- locks the same request first, so a dispatch receipt cannot race with stale
-- reconciliation and cause a possibly accepted provider request to be refunded.
do $install_receipt_aware_reconciliation$
declare
  v_current_definition text;
begin
  if to_regprocedure('public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)') is null then
    if to_regprocedure('public.reconcile_stale_image_generation_request_atomic(text,text,integer)') is null then
      raise exception 'IMAGE_STALE_RECONCILIATION_FUNCTION_NOT_FOUND' using errcode = '55000';
    end if;
    select pg_get_functiondef(to_regprocedure(
      'public.reconcile_stale_image_generation_request_atomic(text,text,integer)'
    )) into v_current_definition;
    if position('provider_evidence_present' in coalesce(v_current_definition, '')) > 0 then
      raise exception 'IMAGE_STALE_RECONCILIATION_HELPER_FORWARD_REPAIR_REQUIRED' using errcode = '55000';
    end if;
    alter function public.reconcile_stale_image_generation_request_atomic(text,text,integer)
      rename to reconcile_stale_image_generation_request_without_provider_receipt;
  end if;
end;
$install_receipt_aware_reconciliation$;

create or replace function public.reconcile_stale_image_generation_request_atomic(
  p_record_id text,
  p_user_id text,
  p_stale_after_seconds integer default 600
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.image_generation_requests%rowtype;
begin
  if trim(coalesce(p_record_id, '')) = ''
     or trim(coalesce(p_user_id, '')) = ''
     or p_stale_after_seconds is null
     or p_stale_after_seconds < 600
     or p_stale_after_seconds > 86400 then
    raise exception 'IMAGE_STALE_RECONCILIATION_INPUT_INVALID' using errcode = '22023';
  end if;

  select * into v_request
    from public.image_generation_requests
   where record_id = trim(p_record_id)
     and user_id = trim(p_user_id)
   for update;
  if not found then
    return jsonb_build_object('reconciled', false, 'reason', 'not_found');
  end if;
  if v_request.provider_dispatch_receipt is not null
     or v_request.provider_submission_receipt is not null then
    return jsonb_build_object(
      'reconciled', false,
      'reason', 'provider_evidence_present',
      'record', to_jsonb(v_request)
    );
  end if;

  return public.reconcile_stale_image_generation_request_without_provider_receipt(
    trim(p_record_id), trim(p_user_id), p_stale_after_seconds
  );
end;
$$;

do $owner_and_acl_alignment$
declare
  v_table_owner name;
  v_signature text;
  v_grantee_oid oid;
  v_grantee_name name;
  v_public_rpc boolean;
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
    'public.reconcile_stale_image_generation_request_atomic(text,text,integer)',
    'public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)',
    'public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb)',
    'public.record_image_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'IMAGE_PROVIDER_RECEIPT_FUNCTION_NOT_FOUND:%', v_signature using errcode = '55000';
    end if;
    execute format('alter function %s owner to %I', v_signature, v_table_owner);
    execute format('alter function %s security definer', v_signature);
    execute format('alter function %s set search_path = public, pg_temp', v_signature);
    for v_grantee_oid, v_grantee_name in
      select distinct acl.grantee, coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')::name
        from pg_proc procedure
        cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
       where procedure.oid = to_regprocedure(v_signature)
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee <> procedure.proowner
    loop
      if v_grantee_oid = 0 then
        execute format('revoke all on function %s from public', v_signature);
      else
        execute format('revoke all on function %s from %I', v_signature, v_grantee_name);
      end if;
    end loop;
    v_public_rpc := v_signature not like '%without_provider_receipt%';
    if v_public_rpc then
      execute format('grant execute on function %s to service_role', v_signature);
    end if;
  end loop;
end;
$owner_and_acl_alignment$;

do $owner_and_effective_acl_guard$
declare
  v_table_owner oid;
  v_service_role oid := to_regrole('service_role');
begin
  select relation.relowner into v_table_owner
    from pg_class relation
   where relation.oid = 'public.image_generation_requests'::regclass;
  if v_table_owner is null or v_service_role is null then
    raise exception 'IMAGE_PROVIDER_RECEIPT_RUNTIME_OWNER_REQUIRED' using errcode = '55000';
  end if;
  if exists (
    select 1
      from unnest(array[
        'public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)',
        'public.reconcile_stale_image_generation_request_atomic(text,text,integer)',
        'public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb)',
        'public.record_image_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)'
      ]) signature(value)
      join pg_proc procedure on procedure.oid = to_regprocedure(signature.value)
     where procedure.proowner <> v_table_owner
        or not procedure.prosecdef
        or procedure.proconfig is distinct from array['search_path=public, pg_temp']::text[]
        or not has_function_privilege(v_service_role, procedure.oid, 'EXECUTE')
        or exists (
          select 1 from pg_roles role
           where not role.rolsuper
             and role.oid not in (v_table_owner, v_service_role)
             and has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
        )
  ) then
    raise exception 'IMAGE_PROVIDER_RECEIPT_EFFECTIVE_EXECUTE_ACL_INVALID' using errcode = '55000';
  end if;
  if exists (
    select 1 from pg_proc procedure
     where procedure.oid = to_regprocedure(
       'public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)'
     )
       and (procedure.proowner <> v_table_owner
         or not procedure.prosecdef
         or procedure.proconfig is distinct from array['search_path=public, pg_temp']::text[]
         or exists (
           select 1 from pg_roles role
            where not role.rolsuper
              and role.oid <> v_table_owner
              and has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
         ))
  ) then
    raise exception 'IMAGE_PROVIDER_RECEIPT_HELPER_EFFECTIVE_EXECUTE_ACL_INVALID' using errcode = '55000';
  end if;
end;
$owner_and_effective_acl_guard$;

comment on column public.image_generation_requests.provider_dispatch_receipt is
  'Redacted CAS-protected proof recorded before the one provider POST: exact wire-body SHA-256/size, protocol and bounded request projection; never raw body, URL query, credentials or base64. The table owner and service_role remain trusted, so this is not physical immutability.';
comment on column public.image_generation_requests.provider_submission_receipt is
  'Redacted CAS-protected proof of the first provider POST transport/response: raw response-body SHA-256/size, HTTP status and hashed acknowledgement only. The table owner and service_role remain trusted, so this is not physical immutability.';
comment on function public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb) is
  'Table-owner SECURITY DEFINER CAS that validates the full redacted receipt digest before a provider POST. EXECUTE is service_role-only; table owner and service_role are trusted.';
comment on function public.record_image_provider_submission_receipt_atomic(text,text,text,text,text,jsonb) is
  'Table-owner SECURITY DEFINER CAS that binds one redacted submission receipt to its dispatch receipt. EXECUTE is service_role-only.';
comment on function public.reconcile_stale_image_generation_request_atomic(text,text,integer) is
  'Receipt-aware stale reconciliation. Any provider dispatch/submission evidence keeps the request locked for manual/result reconciliation and prevents unsafe refund-plus-retry.';

notify pgrst, 'reload schema';
commit;
