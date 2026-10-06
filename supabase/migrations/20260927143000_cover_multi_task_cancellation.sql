begin;

set local lock_timeout = '10s';

alter table public.cover_generation_attempts
  add column if not exists cancelled_at timestamptz;

alter table public.cover_generation_attempts
  drop constraint if exists cover_generation_attempts_state_check;

alter table public.cover_generation_attempts
  add constraint cover_generation_attempts_state_check
  check (state in ('claimed','dispatched','delivery_pending','completed','failed','cancelled'));

drop index if exists public.cover_generation_attempts_one_active_idx;
create index if not exists cover_generation_attempts_active_idx
  on public.cover_generation_attempts(user_id, surface, updated_at desc)
  where state in ('claimed','dispatched','delivery_pending');

create or replace function public.claim_cover_generation_attempt(
  p_user_id uuid,
  p_client_idempotency_key text,
  p_client_trace_id text,
  p_task jsonb,
  p_generation_input jsonb,
  p_requires_reference_reupload boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row public.cover_generation_attempts%rowtype;
  v_created boolean := false;
begin
  if p_user_id is null
    or coalesce(p_client_idempotency_key, '') !~ '^[A-Za-z0-9_-]{8,128}$'
    or coalesce(p_client_trace_id, '') !~ '^[A-Za-z0-9_-]{8,128}$'
    or jsonb_typeof(p_task) is distinct from 'object'
    or jsonb_typeof(p_generation_input) is distinct from 'object'
    or octet_length(p_task::text) > 65536
    or octet_length(p_generation_input::text) > 65536
    or position('data:' in lower(p_task::text)) > 0
    or position('blob:' in lower(p_task::text)) > 0
    or position('data:' in lower(p_generation_input::text)) > 0
    or position('blob:' in lower(p_generation_input::text)) > 0 then
    raise exception 'COVER_ATTEMPT_INPUT_INVALID' using errcode = '22023';
  end if;

  -- Claims are serialized only for the short insert/idempotency check. The
  -- resulting tasks remain independent and may run concurrently.
  perform pg_advisory_xact_lock(hashtextextended(
    'cover-attempt-claim:' || p_user_id::text || ':cover-studio',
    0
  ));

  select * into v_row
    from public.cover_generation_attempts
   where user_id = p_user_id
     and surface = 'cover-studio'
     and (
       client_idempotency_key = p_client_idempotency_key
       or client_trace_id = p_client_trace_id
     )
   order by created_at asc, id asc
   limit 1
   for update;

  if found then
    if v_row.client_idempotency_key <> p_client_idempotency_key
       or v_row.client_trace_id <> p_client_trace_id
       or v_row.task is distinct from p_task
       or v_row.generation_input is distinct from p_generation_input
       or v_row.requires_reference_reupload is distinct from coalesce(p_requires_reference_reupload, false) then
      raise exception 'COVER_ATTEMPT_IDEMPOTENCY_CONFLICT' using errcode = '22023';
    end if;
    return jsonb_build_object('created', false, 'record', to_jsonb(v_row));
  end if;

  insert into public.cover_generation_attempts(
    user_id, surface, client_idempotency_key, client_trace_id,
    task, generation_input, requires_reference_reupload
  ) values (
    p_user_id, 'cover-studio', p_client_idempotency_key, p_client_trace_id,
    p_task, p_generation_input, coalesce(p_requires_reference_reupload, false)
  ) returning * into v_row;
  v_created := true;
  return jsonb_build_object('created', v_created, 'record', to_jsonb(v_row));
end;
$$;

create or replace function public.begin_cover_generation_dispatch(
  p_user_id uuid,
  p_client_idempotency_key text,
  p_client_trace_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row public.cover_generation_attempts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'cover-attempt:' || p_user_id::text || ':cover-studio:' || p_client_idempotency_key,
    0
  ));
  select * into v_row
    from public.cover_generation_attempts
   where user_id = p_user_id
     and surface = 'cover-studio'
     and client_idempotency_key = p_client_idempotency_key
     and client_trace_id = p_client_trace_id
   for update;
  if not found then
    raise exception 'COVER_ATTEMPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.state <> 'claimed' then
    return jsonb_build_object('acquired', false, 'record', to_jsonb(v_row));
  end if;
  if v_row.created_at <= clock_timestamp() - interval '10 minutes' then
    update public.cover_generation_attempts
       set state = 'failed',
           error_code = 'COVER_CLAIM_EXPIRED_BEFORE_DISPATCH',
           updated_at = clock_timestamp(),
           completed_at = clock_timestamp()
     where id = v_row.id
     returning * into v_row;
    return jsonb_build_object('acquired', false, 'record', to_jsonb(v_row));
  end if;
  update public.cover_generation_attempts
     set state = 'dispatched',
         dispatched_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = v_row.id
   returning * into v_row;
  return jsonb_build_object('acquired', true, 'record', to_jsonb(v_row));
end;
$$;

create or replace function public.cancel_cover_generation_attempt(
  p_user_id uuid,
  p_client_idempotency_key text,
  p_client_trace_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row public.cover_generation_attempts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'cover-attempt:' || p_user_id::text || ':cover-studio:' || p_client_idempotency_key,
    0
  ));
  select * into v_row
    from public.cover_generation_attempts
   where user_id = p_user_id
     and surface = 'cover-studio'
     and client_idempotency_key = p_client_idempotency_key
     and client_trace_id = p_client_trace_id
   for update;
  if not found then
    raise exception 'COVER_ATTEMPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.state not in ('claimed','dispatched','delivery_pending') then
    return jsonb_build_object('record', to_jsonb(v_row));
  end if;
  update public.cover_generation_attempts
     set state = 'cancelled',
         error_code = 'COVER_CANCELLED_BY_USER',
         cancelled_at = clock_timestamp(),
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = v_row.id
   returning * into v_row;
  return jsonb_build_object('record', to_jsonb(v_row));
end;
$$;

create or replace function public.reconcile_stale_cover_generation_attempts(
  p_user_id uuid,
  p_stale_after_seconds integer default 600
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_seconds integer := greatest(60, least(coalesce(p_stale_after_seconds, 600), 86400));
  v_claimed integer := 0;
  v_dispatched integer := 0;
begin
  with stale_claimed as (
    select attempt.id
      from public.cover_generation_attempts attempt
     where attempt.user_id = p_user_id
       and attempt.surface = 'cover-studio'
       and attempt.state = 'claimed'
       and attempt.created_at <= clock_timestamp() - make_interval(secs => v_seconds)
     for update skip locked
  )
  update public.cover_generation_attempts attempt
     set state = 'failed',
         error_code = 'COVER_CLAIM_EXPIRED_BEFORE_DISPATCH',
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where attempt.id in (select id from stale_claimed)
     and attempt.state = 'claimed';
  get diagnostics v_claimed = row_count;

  with stale_dispatched as (
    select attempt.id
      from public.cover_generation_attempts attempt
     where attempt.user_id = p_user_id
       and attempt.surface = 'cover-studio'
       and attempt.state in ('dispatched','delivery_pending')
       and coalesce(attempt.dispatched_at, attempt.updated_at) <= clock_timestamp() - make_interval(secs => v_seconds)
       and not exists (
         select 1
           from public.image_generation_requests request
          where request.user_id = attempt.user_id::text
            and request.client_idempotency_key = attempt.client_idempotency_key
            and request.client_trace_id = attempt.client_trace_id
       )
     for update skip locked
  )
  update public.cover_generation_attempts attempt
     set state = 'failed',
         error_code = 'COVER_DISPATCH_INTENT_MISSING',
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where attempt.id in (select id from stale_dispatched)
     and attempt.state in ('dispatched','delivery_pending')
     and not exists (
       select 1
         from public.image_generation_requests request
        where request.user_id = attempt.user_id::text
          and request.client_idempotency_key = attempt.client_idempotency_key
          and request.client_trace_id = attempt.client_trace_id
     );
  get diagnostics v_dispatched = row_count;

  return jsonb_build_object(
    'claimedExpired', v_claimed,
    'dispatchIntentMissing', v_dispatched
  );
end;
$$;

create or replace function public.settle_cover_generation_attempt(
  p_user_id uuid,
  p_client_idempotency_key text,
  p_client_trace_id text,
  p_state text,
  p_background_asset_id uuid default null,
  p_result_asset_id uuid default null,
  p_history_record_id text default null,
  p_error_code text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row public.cover_generation_attempts%rowtype;
begin
  if p_state not in ('delivery_pending','completed','failed') then
    raise exception 'COVER_ATTEMPT_STATE_INVALID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'cover-attempt:' || p_user_id::text || ':cover-studio:' || p_client_idempotency_key,
    0
  ));
  select * into v_row
    from public.cover_generation_attempts
   where user_id = p_user_id
     and surface = 'cover-studio'
     and client_idempotency_key = p_client_idempotency_key
     and client_trace_id = p_client_trace_id
   for update;
  if not found then
    raise exception 'COVER_ATTEMPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.state in ('completed','failed','cancelled') then
    return jsonb_build_object('record', to_jsonb(v_row));
  end if;
  if p_state = 'completed' and (
    p_background_asset_id is null
    or p_result_asset_id is null
    or nullif(btrim(coalesce(p_history_record_id,'')), '') is null
  ) then
    raise exception 'COVER_ATTEMPT_RESULT_INVALID' using errcode = '22023';
  end if;
  update public.cover_generation_attempts
     set state = p_state,
         background_asset_id = coalesce(p_background_asset_id, background_asset_id),
         result_asset_id = coalesce(p_result_asset_id, result_asset_id),
         history_record_id = coalesce(nullif(btrim(p_history_record_id), ''), history_record_id),
         error_code = case when p_error_code is null then error_code else left(p_error_code, 160) end,
         updated_at = clock_timestamp(),
         completed_at = case when p_state in ('completed','failed') then clock_timestamp() else completed_at end
   where id = v_row.id
   returning * into v_row;
  return jsonb_build_object('record', to_jsonb(v_row));
end;
$$;

revoke all on function public.claim_cover_generation_attempt(uuid,text,text,jsonb,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.begin_cover_generation_dispatch(uuid,text,text) from public,anon,authenticated;
revoke all on function public.cancel_cover_generation_attempt(uuid,text,text) from public,anon,authenticated;
revoke all on function public.reconcile_stale_cover_generation_attempts(uuid,integer) from public,anon,authenticated;
revoke all on function public.settle_cover_generation_attempt(uuid,text,text,text,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_cover_generation_attempt(uuid,text,text,jsonb,jsonb,boolean) to service_role;
grant execute on function public.begin_cover_generation_dispatch(uuid,text,text) to service_role;
grant execute on function public.cancel_cover_generation_attempt(uuid,text,text) to service_role;
grant execute on function public.reconcile_stale_cover_generation_attempts(uuid,integer) to service_role;
grant execute on function public.settle_cover_generation_attempt(uuid,text,text,text,uuid,uuid,text,text) to service_role;

notify pgrst, 'reload schema';
commit;
