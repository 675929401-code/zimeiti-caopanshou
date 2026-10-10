begin;

set local lock_timeout = '10s';

-- Fail closed before creating the guard namespace. This is an audit only: the
-- migration performs no backfill or repair of historical user_files rows.
do $duplicate_audit$
begin
  if exists (
    select 1 from public.user_files
     where source='video-page-reference'
     group by storage_provider,storage_key having count(*)>1
  ) then
    raise exception 'VIDEO_REFERENCE_DUPLICATE_KEYS_REQUIRE_REPAIR' using errcode='21000';
  end if;
end
$duplicate_audit$;

create table if not exists public.video_reference_asset_cleanup_outbox (
  asset_ref text primary key,
  user_file_id text not null,
  user_id text not null,
  storage_provider text not null check (storage_provider = 'tencent_cos'),
  storage_key text not null,
  source text not null check (source = 'video-page-reference'),
  file_category text not null check (file_category in ('image','audio')),
  upload_session text not null,
  state text not null check (state in ('available','claimed','object_deleted','completed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text,
  registered_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  object_deleted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  -- The table is newly created and intentionally receives zero backfill rows,
  -- so this uniqueness cannot conflict with historical user_files data.
  unique (storage_provider,storage_key),
  check ((state='available') = (claimed_at is null))
);

alter table public.video_reference_asset_cleanup_outbox enable row level security;
revoke all on table public.video_reference_asset_cleanup_outbox from public, anon, authenticated;
revoke all on table public.video_reference_asset_cleanup_outbox from service_role;

create or replace function public.guard_video_reference_assets_during_reservation_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cleanup public.video_reference_asset_cleanup_outbox%rowtype;
begin
  lock table public.video_tasks in access share mode;
  if new.request_snapshot is null
     or jsonb_typeof(new.request_snapshot->'referenceAssets') is distinct from 'array' then
    return new;
  end if;

  -- Only page-upload guards registered by the upload transaction participate.
  -- Unrelated object:// assets never acquire a lock and are never blocked.
  for v_cleanup in
    select cleanup.*
      from jsonb_array_elements(new.request_snapshot->'referenceAssets') item
      join public.video_reference_asset_cleanup_outbox cleanup
        on cleanup.asset_ref = item->>'ref'
       and cleanup.storage_provider = 'tencent_cos'
     order by cleanup.storage_provider,cleanup.storage_key
     for update of cleanup
  loop
    if v_cleanup.state in ('claimed','object_deleted','completed') then
      raise exception 'VIDEO_REFERENCE_ASSET_CLEANUP_IN_PROGRESS'
        using errcode = '55000';
    end if;
  end loop;
  return new;
end
$$;

drop trigger if exists video_tasks_reference_asset_reservation_guard on public.video_tasks;
create trigger video_tasks_reference_asset_reservation_guard
before insert or update of request_snapshot on public.video_tasks
for each row execute function public.guard_video_reference_assets_during_reservation_v1();

create or replace function public.register_video_reference_asset_guard_v1(
  p_asset_ref text,
  p_user_file_id text,
  p_storage_key text,
  p_storage_provider text,
  p_user_id text,
  p_source text,
  p_file_category text,
  p_upload_session text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key_count integer;
  v_exact_count integer;
  v_cleanup public.video_reference_asset_cleanup_outbox%rowtype;
begin
  lock table public.video_tasks in access share mode;
  if nullif(trim(coalesce(p_asset_ref,'')), '') is null
     or p_asset_ref not like 'object://tencent_cos/%'
     or nullif(trim(coalesce(p_user_file_id,'')), '') is null
     or nullif(trim(coalesce(p_storage_key,'')), '') is null
     or p_storage_provider is distinct from 'tencent_cos'
     or nullif(trim(coalesce(p_user_id,'')), '') is null
     or p_source is distinct from 'video-page-reference'
     or p_file_category not in ('image','audio')
     or (p_file_category='image' and p_storage_key not like 'video-inputs/%')
     or (p_file_category='audio' and p_storage_key not like 'video-audio-inputs/%')
     or coalesce(p_upload_session,'') !~ '^[A-Za-z0-9_-]{16,96}$' then
    raise exception 'VIDEO_REFERENCE_GUARD_INVALID' using errcode='22023';
  end if;
  select count(*)::integer into v_key_count from public.user_files file
   where file.storage_key=p_storage_key and file.storage_provider=p_storage_provider;
  select count(*)::integer into v_exact_count from public.user_files file
   where file.id::text=p_user_file_id and file.storage_key=p_storage_key
     and file.storage_provider=p_storage_provider and file.user_id::text=p_user_id
     and file.source=p_source and file.file_category=p_file_category
     and file.meta->>'videoPageUploadSession'=p_upload_session;
  if v_key_count > 1 then raise exception 'VIDEO_REFERENCE_DELETE_AMBIGUOUS' using errcode='21000'; end if;
  if v_key_count <> 1 or v_exact_count <> 1 then
    raise exception 'VIDEO_REFERENCE_GUARD_FORBIDDEN' using errcode='42501';
  end if;
  insert into public.video_reference_asset_cleanup_outbox (
    asset_ref,user_file_id,user_id,storage_provider,storage_key,source,file_category,upload_session,state
  ) values (
    p_asset_ref,p_user_file_id,p_user_id,p_storage_provider,p_storage_key,p_source,p_file_category,p_upload_session,'available'
  ) on conflict (asset_ref) do nothing;
  select * into v_cleanup from public.video_reference_asset_cleanup_outbox
   where asset_ref=p_asset_ref for update;
  if not found or v_cleanup.user_file_id is distinct from p_user_file_id
     or v_cleanup.user_id is distinct from p_user_id
     or v_cleanup.storage_provider is distinct from p_storage_provider
     or v_cleanup.storage_key is distinct from p_storage_key
     or v_cleanup.source is distinct from p_source
     or v_cleanup.file_category is distinct from p_file_category
     or v_cleanup.upload_session is distinct from p_upload_session
     or v_cleanup.state <> 'available' then
    raise exception 'VIDEO_REFERENCE_GUARD_IDENTITY_MISMATCH' using errcode='42501';
  end if;
  return jsonb_build_object('state','available');
end
$$;

create or replace function public.claim_video_reference_asset_cleanup_v1(
  p_asset_ref text,
  p_user_file_id text,
  p_storage_key text,
  p_storage_provider text,
  p_user_id text,
  p_source text,
  p_file_category text,
  p_upload_session text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key_count integer;
  v_exact_count integer;
  v_cleanup public.video_reference_asset_cleanup_outbox%rowtype;
begin
  lock table public.video_tasks in access share mode;
  if nullif(trim(coalesce(p_asset_ref,'')), '') is null
     or p_asset_ref not like 'object://tencent_cos/%'
     or nullif(trim(coalesce(p_user_file_id,'')), '') is null
     or nullif(trim(coalesce(p_storage_key,'')), '') is null
     or p_storage_provider is distinct from 'tencent_cos'
     or nullif(trim(coalesce(p_user_id,'')), '') is null
     or p_source is distinct from 'video-page-reference'
     or p_file_category not in ('image','audio')
     or (p_file_category='image' and p_storage_key not like 'video-inputs/%')
     or (p_file_category='audio' and p_storage_key not like 'video-audio-inputs/%')
     or coalesce(p_upload_session,'') !~ '^[A-Za-z0-9_-]{16,96}$' then
    raise exception 'VIDEO_REFERENCE_DELETE_INVALID' using errcode = '22023';
  end if;

  select * into v_cleanup
    from public.video_reference_asset_cleanup_outbox cleanup
   where cleanup.asset_ref=p_asset_ref
   for update;
  if not found then raise exception 'VIDEO_REFERENCE_DELETE_GUARD_NOT_FOUND' using errcode='55000'; end if;

  select count(*)::integer into v_key_count
    from public.user_files file
   where file.storage_key = p_storage_key
     and file.storage_provider = p_storage_provider;
  if v_key_count > 1 then
    raise exception 'VIDEO_REFERENCE_DELETE_AMBIGUOUS' using errcode = '21000';
  end if;

  select count(*)::integer into v_exact_count
    from public.user_files file
   where file.id::text = p_user_file_id
     and file.storage_key = p_storage_key
     and file.storage_provider = p_storage_provider
     and file.user_id::text = p_user_id
     and file.source = p_source
     and file.file_category = p_file_category
     and file.meta->>'videoPageUploadSession' = p_upload_session;
  if v_key_count <> 1 or v_exact_count <> 1 then
    raise exception 'VIDEO_REFERENCE_DELETE_FORBIDDEN' using errcode = '42501';
  end if;

  if v_cleanup.user_file_id is distinct from p_user_file_id
     or v_cleanup.user_id is distinct from p_user_id
     or v_cleanup.storage_provider is distinct from p_storage_provider
     or v_cleanup.storage_key is distinct from p_storage_key
     or v_cleanup.source is distinct from p_source
     or v_cleanup.file_category is distinct from p_file_category
     or v_cleanup.upload_session is distinct from p_upload_session then
    raise exception 'VIDEO_REFERENCE_DELETE_IDENTITY_MISMATCH' using errcode = '42501';
  end if;
  if v_cleanup.state = 'completed' then
    return jsonb_build_object('state','completed','already_deleted',true);
  end if;

  if exists (
    select 1
      from public.video_tasks task
     where task.user_id::text = p_user_id
       and task.status in ('pending','queued','processing','generating','finalizing','billing_pending')
       and exists (
         select 1
           from jsonb_array_elements(coalesce(task.request_snapshot->'referenceAssets','[]'::jsonb)) asset
          where asset->>'ref' = p_asset_ref
       )
  ) then
    raise exception 'VIDEO_REFERENCE_DELETE_ACTIVE_TASK' using errcode = '55000';
  end if;

  update public.video_reference_asset_cleanup_outbox
     set state=case when state='available' then 'claimed' else state end,
         claimed_at=case when state='available' then clock_timestamp() else claimed_at end,
         attempts = attempts + 1,
         last_error_code = null,
         updated_at = clock_timestamp()
   where asset_ref = p_asset_ref;
  return jsonb_build_object(
    'state',case when v_cleanup.state='available' then 'claimed' else v_cleanup.state end,
    'attempts',v_cleanup.attempts + 1
  );
end
$$;

create or replace function public.mark_video_reference_asset_object_deleted_v1(
  p_asset_ref text,
  p_user_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cleanup public.video_reference_asset_cleanup_outbox%rowtype;
begin
  lock table public.video_tasks in access share mode;
  select * into v_cleanup
    from public.video_reference_asset_cleanup_outbox
   where asset_ref = p_asset_ref and user_id = p_user_id
   for update;
  if not found then raise exception 'VIDEO_REFERENCE_DELETE_CLAIM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_cleanup.state = 'completed' then return jsonb_build_object('state','completed'); end if;
  if v_cleanup.state not in ('claimed','object_deleted') then
    raise exception 'VIDEO_REFERENCE_DELETE_STATE_INVALID' using errcode = '55000';
  end if;
  update public.video_reference_asset_cleanup_outbox
     set state='object_deleted',object_deleted_at=coalesce(object_deleted_at,clock_timestamp()),
         last_error_code=null,updated_at=clock_timestamp()
   where asset_ref=p_asset_ref;
  return jsonb_build_object('state','object_deleted');
end
$$;

create or replace function public.complete_video_reference_asset_cleanup_v1(
  p_asset_ref text,
  p_user_file_id text,
  p_storage_key text,
  p_storage_provider text,
  p_user_id text,
  p_source text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cleanup public.video_reference_asset_cleanup_outbox%rowtype;
begin
  lock table public.video_tasks in access share mode;
  select * into v_cleanup
    from public.video_reference_asset_cleanup_outbox
   where asset_ref=p_asset_ref and user_id=p_user_id
   for update;
  if not found then raise exception 'VIDEO_REFERENCE_DELETE_CLAIM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_cleanup.state = 'completed' then return jsonb_build_object('state','completed','already_deleted',true); end if;
  if v_cleanup.state <> 'object_deleted'
     or v_cleanup.user_file_id is distinct from p_user_file_id
     or v_cleanup.storage_key is distinct from p_storage_key
     or v_cleanup.storage_provider is distinct from p_storage_provider
     or v_cleanup.source is distinct from p_source then
    raise exception 'VIDEO_REFERENCE_DELETE_IDENTITY_MISMATCH' using errcode = '42501';
  end if;

  delete from public.user_files file
   where file.id::text=p_user_file_id
     and file.storage_key=p_storage_key
     and file.storage_provider=p_storage_provider
     and file.user_id::text=p_user_id
     and file.source=p_source;

  update public.video_reference_asset_cleanup_outbox
     set state='completed',completed_at=coalesce(completed_at,clock_timestamp()),
         last_error_code=null,updated_at=clock_timestamp()
   where asset_ref=p_asset_ref;
  return jsonb_build_object('state','completed');
end
$$;

create or replace function public.record_video_reference_asset_cleanup_failure_v1(
  p_asset_ref text,
  p_user_id text,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  lock table public.video_tasks in access share mode;
  if coalesce(p_error_code,'') !~ '^VIDEO_REFERENCE_DELETE_[A-Z0-9_]{1,120}$' then
    p_error_code := 'VIDEO_REFERENCE_DELETE_RETRY_REQUIRED';
  end if;
  update public.video_reference_asset_cleanup_outbox
     set last_error_code=left(nullif(trim(coalesce(p_error_code,'')),''),160),updated_at=clock_timestamp()
   where asset_ref=p_asset_ref and user_id=p_user_id and state in ('claimed','object_deleted');
  return jsonb_build_object('recorded',found);
end
$$;

revoke all on function public.guard_video_reference_assets_during_reservation_v1() from public, anon, authenticated;
revoke all on function public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.mark_video_reference_asset_object_deleted_v1(text,text) from public, anon, authenticated;
revoke all on function public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.record_video_reference_asset_cleanup_failure_v1(text,text,text) from public, anon, authenticated;
grant execute on function public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.mark_video_reference_asset_object_deleted_v1(text,text) to service_role;
grant execute on function public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text) to service_role;
grant execute on function public.record_video_reference_asset_cleanup_failure_v1(text,text,text) to service_role;

do $owner_alignment$
declare
  v_owner_oid oid;
  v_owner name;
  v_service_role oid := to_regrole('service_role');
  v_signature text;
  v_unexpected_effective_roles text;
begin
  select relowner,pg_get_userbyid(relowner) into v_owner_oid,v_owner from pg_class where oid='public.video_tasks'::regclass;
  if v_owner is null then raise exception 'VIDEO_TASKS_TABLE_OWNER_NOT_FOUND' using errcode='55000'; end if;
  if v_service_role is null then raise exception 'VIDEO_REFERENCE_SERVICE_ROLE_NOT_FOUND' using errcode='55000'; end if;
  execute format('alter table public.video_reference_asset_cleanup_outbox owner to %I',v_owner);
  foreach v_signature in array array[
    'public.guard_video_reference_assets_during_reservation_v1()',
    'public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text)',
    'public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text)',
    'public.mark_video_reference_asset_object_deleted_v1(text,text)',
    'public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text)',
    'public.record_video_reference_asset_cleanup_failure_v1(text,text,text)'
  ] loop
    execute format('alter function %s owner to %I',v_signature,v_owner);
    execute format('alter function %s security definer',v_signature);
    execute format('alter function %s set search_path = public, pg_temp',v_signature);
    execute format('revoke all on function %s from public, anon, authenticated, service_role',v_signature);
    if v_signature <> 'public.guard_video_reference_assets_during_reservation_v1()' then
      execute format('grant execute on function %s to service_role',v_signature);
    end if;
    select string_agg(role_entry.rolname,',' order by role_entry.rolname)
      into v_unexpected_effective_roles
      from pg_roles role_entry
     where role_entry.oid not in (v_owner_oid,v_service_role)
       and not role_entry.rolsuper
       and has_function_privilege(role_entry.oid,to_regprocedure(v_signature),'execute');
    if v_unexpected_effective_roles is not null then
      raise exception 'VIDEO_REFERENCE_UNEXPECTED_EFFECTIVE_EXECUTE:%:%',v_signature,v_unexpected_effective_roles
        using errcode='55000';
    end if;
  end loop;
end
$owner_alignment$;

notify pgrst, 'reload schema';
commit;
