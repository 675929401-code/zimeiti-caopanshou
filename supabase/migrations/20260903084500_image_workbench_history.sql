begin;

create table if not exists public.image_workbench_history (
  owner_id text not null,
  id text not null check (id ~ '^[A-Za-z0-9:_-]{8,160}$'),
  document jsonb not null check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 262144),
  created_at timestamptz not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);
create index if not exists image_workbench_history_owner_created_idx
  on public.image_workbench_history(owner_id, created_at desc) where deleted = false;
create table if not exists public.image_workbench_history_state (
  owner_id text primary key,
  cleared_before timestamptz not null
);
alter table public.image_workbench_history enable row level security;
alter table public.image_workbench_history_state enable row level security;
revoke all on public.image_workbench_history, public.image_workbench_history_state from anon, authenticated;
grant select, insert, update on public.image_workbench_history, public.image_workbench_history_state to service_role;

create or replace function public.save_image_workbench_history(p_owner_id text, p_id text, p_document jsonb, p_created_at timestamptz)
returns public.image_workbench_history
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.image_workbench_history%rowtype; v_cutoff timestamptz;
begin
  if p_owner_id is null or btrim(p_owner_id) = '' or p_id is null or p_id !~ '^[A-Za-z0-9:_-]{8,160}$'
    or p_document is null or p_created_at is null then raise exception 'IMAGE_HISTORY_INVALID_ARGUMENT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('image-history:' || p_owner_id, 0));
  select * into v_row from public.image_workbench_history where owner_id = p_owner_id and id = p_id;
  -- Completed history is immutable. A late upload cannot undo deletion.
  if found then return v_row; end if;
  select cleared_before into v_cutoff from public.image_workbench_history_state where owner_id = p_owner_id;
  insert into public.image_workbench_history(owner_id,id,document,created_at,deleted)
    values(p_owner_id,p_id,p_document,p_created_at,coalesce(p_created_at <= v_cutoff,false)) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.delete_image_workbench_history(p_owner_id text, p_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_owner_id is null or btrim(p_owner_id) = '' or (p_id is not null and p_id !~ '^[A-Za-z0-9:_-]{8,160}$')
    then raise exception 'IMAGE_HISTORY_INVALID_ARGUMENT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('image-history:' || p_owner_id, 0));
  if p_id is null then
    insert into public.image_workbench_history_state(owner_id,cleared_before) values(p_owner_id,clock_timestamp())
      on conflict(owner_id) do update set cleared_before=excluded.cleared_before;
    update public.image_workbench_history set deleted=true,updated_at=now() where owner_id=p_owner_id and deleted=false;
  else
    if not exists(select 1 from public.image_workbench_history where owner_id=p_owner_id and id=p_id)
      then raise exception 'IMAGE_HISTORY_NOT_FOUND'; end if;
    update public.image_workbench_history set deleted=true,updated_at=now() where owner_id=p_owner_id and id=p_id and deleted=false;
  end if;
  get diagnostics v_count = row_count;
  return jsonb_build_object('success',true,'deletedCount',v_count);
end;
$$;
revoke all on function public.save_image_workbench_history(text,text,jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.delete_image_workbench_history(text,text) from public, anon, authenticated;
grant execute on function public.save_image_workbench_history(text,text,jsonb,timestamptz) to service_role;
grant execute on function public.delete_image_workbench_history(text,text) to service_role;
notify pgrst, 'reload schema';
commit;
