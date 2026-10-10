begin;

set local lock_timeout = '10s';

-- The application now persists the full, immutable image request contract as
-- image_generation_request_snapshot.v2.  The previous database function and
-- check constraint accepted v1 only, so a valid UI submission failed closed
-- before provider admission or billing.  Keep v1 readable/replayable while
-- accepting the stricter v2 fields emitted by the current route.
alter table public.image_generation_requests
  drop constraint if exists image_generation_requests_snapshot_valid;

alter table public.image_generation_requests
  add constraint image_generation_requests_snapshot_valid check (
    request_snapshot is null
    or (
      jsonb_typeof(request_snapshot) = 'object'
      and octet_length(request_snapshot::text) <= 131072
      and coalesce(request_snapshot->>'schema', '') in (
        'image_generation_request_snapshot.v1',
        'image_generation_request_snapshot.v2'
      )
    )
  ) not valid;

alter table public.image_generation_requests
  validate constraint image_generation_requests_snapshot_valid;

create or replace function public.claim_image_generation_request_v2(
  p_record_id text,
  p_user_id text,
  p_user_hash text,
  p_client_idempotency_key text,
  p_client_trace_id text,
  p_payload_fingerprint text,
  p_request_snapshot jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.image_generation_requests%rowtype;
  v_created boolean := false;
  v_reference_count integer;
  v_snapshot_schema text;
begin
  if trim(coalesce(p_record_id, '')) = ''
     or trim(coalesce(p_user_id, '')) = ''
     or trim(coalesce(p_user_hash, '')) = ''
     or trim(coalesce(p_client_idempotency_key, '')) = ''
     or trim(coalesce(p_client_trace_id, '')) = ''
     or trim(coalesce(p_payload_fingerprint, '')) !~ '^[a-f0-9]{64}$' then
    raise exception 'IMAGE_IDEMPOTENCY_INPUT_INVALID' using errcode = '22023';
  end if;

  v_snapshot_schema := p_request_snapshot->>'schema';
  if p_request_snapshot is null
     or jsonb_typeof(p_request_snapshot) is distinct from 'object'
     or octet_length(p_request_snapshot::text) > 131072
     or coalesce(v_snapshot_schema, '') not in (
       'image_generation_request_snapshot.v1',
       'image_generation_request_snapshot.v2'
     )
     or coalesce(p_request_snapshot->>'surface', '') not in (
       'image-workbench',
       'cover-studio',
       'storyboard-workbench',
       'free-canvas',
       'short-drama-film-studio',
       'other'
     )
     or jsonb_typeof(p_request_snapshot->'prompt') is distinct from 'string'
     or coalesce(char_length(p_request_snapshot->>'prompt'), 0) not between 1 and 50000
     or jsonb_typeof(p_request_snapshot->'publicModelId') is distinct from 'string'
     or coalesce(char_length(p_request_snapshot->>'publicModelId'), 0) not between 1 and 200
     or jsonb_typeof(p_request_snapshot->'modelName') is distinct from 'string'
     or coalesce(char_length(p_request_snapshot->>'modelName'), 0) not between 1 and 200
     or coalesce(p_request_snapshot->>'mode', '') not in ('text-to-image', 'image-to-image')
     or coalesce(p_request_snapshot->>'aspectRatio', '') !~ '^\d{1,3}:\d{1,3}$'
     or coalesce(p_request_snapshot->>'resolution', '') not in ('0.5K', '1K', '2K', '3K', '4K')
     or jsonb_typeof(p_request_snapshot->'referenceAssetRefs') is distinct from 'array'
     or jsonb_typeof(p_request_snapshot->'quotedPriceYuan') is distinct from 'number'
     or jsonb_typeof(p_request_snapshot->'billingExempt') is distinct from 'boolean'
     or (
       p_request_snapshot ? 'exactCoverText'
       and (
         jsonb_typeof(p_request_snapshot->'exactCoverText') is distinct from 'string'
         or char_length(p_request_snapshot->>'exactCoverText') > 200
       )
     ) then
    raise exception 'IMAGE_REQUEST_SNAPSHOT_INVALID' using errcode = '22023';
  end if;

  if jsonb_array_length(p_request_snapshot->'referenceAssetRefs') > 9
     or (p_request_snapshot->>'quotedPriceYuan')::numeric < 0
     or (p_request_snapshot->>'quotedPriceYuan')::numeric > 1000000 then
    raise exception 'IMAGE_REQUEST_SNAPSHOT_INVALID' using errcode = '22023';
  end if;

  v_reference_count := jsonb_array_length(p_request_snapshot->'referenceAssetRefs');
  if (p_request_snapshot->>'mode' = 'text-to-image') <> (v_reference_count = 0)
     or exists (
       select 1
       from jsonb_array_elements_text(p_request_snapshot->'referenceAssetRefs') item(value)
       where item.value !~ '^ref_[a-f0-9]{32}$'
     )
     or v_reference_count <> (
       select count(distinct item.value)
       from jsonb_array_elements_text(p_request_snapshot->'referenceAssetRefs') item(value)
     ) then
    raise exception 'IMAGE_REQUEST_SNAPSHOT_INVALID' using errcode = '22023';
  end if;

  if v_snapshot_schema = 'image_generation_request_snapshot.v2'
     and (
       jsonb_typeof(p_request_snapshot->'style') is distinct from 'string'
       or char_length(p_request_snapshot->>'style') > 256
       or jsonb_typeof(p_request_snapshot->'effectivePrompt') is distinct from 'string'
       or coalesce(char_length(p_request_snapshot->>'effectivePrompt'), 0) not between 1 and 50000
       or coalesce(p_request_snapshot->>'providerProtocol', '') not in (
         'google_generate_content',
         'chat_completions',
         'images_generations',
         'images_generations_async',
         'images_edits',
         'cover_workflow'
       )
       or coalesce(p_request_snapshot->>'outputPixelSize', '') !~ '^\d{2,5}x\d{2,5}$'
       or p_request_snapshot->'imageCount' is distinct from '1'::jsonb
       or coalesce(p_request_snapshot->>'referenceUsage', '') not in ('general', 'character-identity')
       or coalesce(p_request_snapshot->>'payloadFingerprint', '') !~ '^[a-f0-9]{64}$'
       or p_request_snapshot->>'payloadFingerprint' is distinct from trim(p_payload_fingerprint)
     ) then
    raise exception 'IMAGE_REQUEST_SNAPSHOT_INVALID' using errcode = '22023';
  end if;

  insert into public.image_generation_requests (
    record_id, user_id, user_hash, client_idempotency_key, client_trace_id,
    payload_fingerprint, state, request_snapshot
  ) values (
    trim(p_record_id), trim(p_user_id), trim(p_user_hash),
    trim(p_client_idempotency_key), trim(p_client_trace_id),
    trim(p_payload_fingerprint), 'intent', p_request_snapshot
  )
  on conflict (user_id, client_idempotency_key) do nothing
  returning * into v_row;

  v_created := found;
  if not v_created then
    select * into v_row
      from public.image_generation_requests
     where user_id = trim(p_user_id)
       and client_idempotency_key = trim(p_client_idempotency_key)
     for update;
    if not found then raise exception 'IMAGE_IDEMPOTENCY_LOOKUP_FAILED'; end if;
    if v_row.record_id <> trim(p_record_id)
       or v_row.user_hash <> trim(p_user_hash)
       or v_row.payload_fingerprint <> trim(p_payload_fingerprint)
       or v_row.client_trace_id <> trim(p_client_trace_id) then
      raise exception 'IMAGE_IDEMPOTENCY_CONFLICT' using errcode = '22023';
    end if;
    if v_row.request_snapshot is null then
      update public.image_generation_requests
         set request_snapshot = p_request_snapshot,
             updated_at = now()
       where record_id = v_row.record_id
       returning * into v_row;
    elsif v_row.request_snapshot is distinct from p_request_snapshot then
      raise exception 'IMAGE_REQUEST_SNAPSHOT_CONFLICT' using errcode = '22023';
    end if;
  end if;

  return jsonb_build_object('created', v_created, 'record', to_jsonb(v_row));
end;
$$;

revoke all on function public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)
  to service_role;

comment on function public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb) is
  'Claims immutable image requests. Accepts legacy v1 and integrity-complete image_generation_request_snapshot.v2; provider and billing work occurs only after this claim succeeds.';

-- Status polling reconciles a request only after it has remained unresolved
-- for the configured stale window.  It must understand the same immutable
-- snapshot versions as the claim path or a v2 intent could never release a
-- confirmed charge after an interrupted provider call.
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
  v_price numeric(20, 6);
  v_billing_key text;
  v_charge public.wallet_operations%rowtype;
  v_refund jsonb;
  v_snapshot_schema text;
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

  if v_request.state not in ('intent', 'failed_unknown')
     or v_request.response is not null
     or v_request.delivery_state <> 'held'
     or v_request.delivery_asset_id is not null then
    return jsonb_build_object('reconciled', false, 'reason', 'already_resolved', 'record', to_jsonb(v_request));
  end if;
  if v_request.updated_at > clock_timestamp() - make_interval(secs => p_stale_after_seconds) then
    return jsonb_build_object('reconciled', false, 'reason', 'not_stale', 'record', to_jsonb(v_request));
  end if;

  v_snapshot_schema := v_request.request_snapshot->>'schema';
  if v_request.request_snapshot is null
     or coalesce(v_snapshot_schema, '') not in (
       'image_generation_request_snapshot.v1',
       'image_generation_request_snapshot.v2'
     )
     or jsonb_typeof(v_request.request_snapshot->'quotedPriceYuan') is distinct from 'number'
     or jsonb_typeof(v_request.request_snapshot->'billingExempt') is distinct from 'boolean'
     or (
       v_snapshot_schema = 'image_generation_request_snapshot.v2'
       and (
         coalesce(v_request.request_snapshot->>'payloadFingerprint', '') !~ '^[a-f0-9]{64}$'
         or v_request.request_snapshot->>'payloadFingerprint' is distinct from v_request.payload_fingerprint
       )
     ) then
    raise exception 'IMAGE_STALE_RECONCILIATION_SNAPSHOT_INVALID';
  end if;

  v_price := round((v_request.request_snapshot->>'quotedPriceYuan')::numeric, 2);
  if v_price < 0 or v_price > 1000000 then
    raise exception 'IMAGE_STALE_RECONCILIATION_PRICE_INVALID';
  end if;
  v_billing_key := 'image:h3_' || substr(encode(sha256(convert_to(
    trim(p_user_id) || ':' || v_request.client_idempotency_key, 'UTF8'
  )), 'hex'), 1, 48);

  select * into v_charge
    from public.wallet_operations
   where user_id = trim(p_user_id)
     and operation_kind = 'cash_charge'
     and idempotency_key = v_billing_key
   for update;
  if found then
    if v_charge.status <> 'completed' or v_charge.amount <> v_price or v_price <= 0 then
      raise exception 'IMAGE_STALE_RECONCILIATION_BILLING_CONFLICT';
    end if;
    v_refund := public.apply_wallet_operation_atomic(
      trim(p_user_id),
      'cash_refund',
      v_billing_key || ':release',
      v_charge.amount,
      '图片任务中断且未取得可交付结果，自动退回原请求费用',
      jsonb_build_object(
        'source', 'image.stale-intent-reconciliation',
        'record_id', v_request.record_id,
        'charge_operation_id', v_charge.id,
        'charge_idempotency_key', v_billing_key
      )
    );
    if coalesce((v_refund->>'success')::boolean, false) is not true then
      raise exception 'IMAGE_STALE_RECONCILIATION_REFUND_FAILED';
    end if;
  elsif v_price > 0 then
    -- A request can be interrupted before budget reservation. In that case
    -- there is no charge to release, but the request must become retryable.
    v_refund := null;
  end if;

  update public.image_generation_requests
     set state = 'failed_unknown',
         response = jsonb_build_object(
           'schema', 'image_request_rejection.v1',
           'payloadFingerprint', v_request.payload_fingerprint,
           'source', 'platform',
           'code', 'IMAGE_PLATFORM_REQUEST_INTERRUPTED',
           'interruptedAt', clock_timestamp()
         ),
         updated_at = clock_timestamp()
   where record_id = v_request.record_id
   returning * into v_request;

  return jsonb_build_object(
    'reconciled', true,
    'reason', 'stale_interrupted',
    'refunded', v_refund is not null,
    'refund', v_refund,
    'record', to_jsonb(v_request)
  );
end;
$$;

revoke all on function public.reconcile_stale_image_generation_request_atomic(text,text,integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_stale_image_generation_request_atomic(text,text,integer)
  to service_role;

comment on function public.reconcile_stale_image_generation_request_atomic(text,text,integer) is
  'Reconciles stale v1/v2 image intents and atomically releases any confirmed charge before making the request retryable.';

notify pgrst, 'reload schema';
commit;
