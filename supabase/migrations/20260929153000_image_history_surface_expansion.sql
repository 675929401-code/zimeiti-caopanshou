begin;

set local lock_timeout = '10s';

-- Preserve the stable existing surface keys while allowing the two production
-- image entry points already accepted by the public request contract. This is
-- metadata-only: no media object, wallet row or existing snapshot is rewritten.
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
begin
  if trim(coalesce(p_record_id, '')) = ''
     or trim(coalesce(p_user_id, '')) = ''
     or trim(coalesce(p_user_hash, '')) = ''
     or trim(coalesce(p_client_idempotency_key, '')) = ''
     or trim(coalesce(p_client_trace_id, '')) = ''
     or trim(coalesce(p_payload_fingerprint, '')) = '' then
    raise exception 'IMAGE_IDEMPOTENCY_INPUT_INVALID' using errcode = '22023';
  end if;
  if p_request_snapshot is null
     or jsonb_typeof(p_request_snapshot) is distinct from 'object'
     or octet_length(p_request_snapshot::text) > 131072
     or p_request_snapshot->>'schema' is distinct from 'image_generation_request_snapshot.v1'
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
     or coalesce(p_request_snapshot->>'resolution', '') not in ('1K', '2K', '4K')
     or jsonb_typeof(p_request_snapshot->'referenceAssetRefs') is distinct from 'array'
     or jsonb_typeof(p_request_snapshot->'quotedPriceYuan') is distinct from 'number'
     or jsonb_typeof(p_request_snapshot->'billingExempt') is distinct from 'boolean' then
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

notify pgrst, 'reload schema';
commit;
