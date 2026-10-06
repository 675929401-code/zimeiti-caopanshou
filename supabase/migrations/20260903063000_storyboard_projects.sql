begin;

create table if not exists public.storyboard_projects (
  owner_id text not null,
  id text not null check (id ~ '^[A-Za-z0-9:_-]{8,160}$'),
  title text not null check (char_length(title) between 1 and 160),
  document jsonb not null check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 2097152),
  card_count integer generated always as (jsonb_array_length(document -> 'cards')) stored,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  revision bigint not null default 1 check (revision > 0),
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);
create index if not exists storyboard_projects_owner_updated_idx
  on public.storyboard_projects (owner_id, updated_at desc) where deleted = false;
alter table public.storyboard_projects enable row level security;
revoke all on public.storyboard_projects from anon, authenticated;
grant select, insert, update on public.storyboard_projects to service_role;

create or replace function public.save_storyboard_project(
  p_owner_id text, p_id text, p_expected_revision bigint,
  p_title text, p_document jsonb, p_content_hash text
)
returns public.storyboard_projects
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.storyboard_projects%rowtype;
begin
  if p_owner_id is null or btrim(p_owner_id) = '' or p_id is null
    or p_id !~ '^[A-Za-z0-9:_-]{8,160}$' or p_expected_revision is null
    or p_expected_revision < 0 or p_document is null or p_content_hash is null then
    raise exception 'STORYBOARD_INVALID_ARGUMENT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id || ':' || p_id, 0));
  select * into v_row from public.storyboard_projects
    where owner_id = p_owner_id and id = p_id for update;
  if found then
    if v_row.deleted then raise exception 'STORYBOARD_NOT_FOUND'; end if;
    -- A lost response can safely retry the exact document without another revision.
    if v_row.content_hash = p_content_hash then return v_row; end if;
    if v_row.revision <> p_expected_revision then raise exception 'STORYBOARD_REVISION_CONFLICT'; end if;
    update public.storyboard_projects set title = p_title, document = p_document,
      content_hash = p_content_hash, revision = revision + 1, updated_at = now()
      where owner_id = p_owner_id and id = p_id returning * into v_row;
  else
    if p_expected_revision <> 0 then raise exception 'STORYBOARD_NOT_FOUND'; end if;
    insert into public.storyboard_projects (owner_id, id, title, document, content_hash)
      values (p_owner_id, p_id, p_title, p_document, p_content_hash) returning * into v_row;
  end if;
  return v_row;
end;
$$;

create or replace function public.delete_storyboard_project(p_owner_id text, p_id text, p_expected_revision bigint)
returns public.storyboard_projects
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.storyboard_projects%rowtype;
begin
  if p_owner_id is null or btrim(p_owner_id) = '' or p_id is null
    or p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'STORYBOARD_INVALID_ARGUMENT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id || ':' || p_id, 0));
  select * into v_row from public.storyboard_projects
    where owner_id = p_owner_id and id = p_id for update;
  if not found then raise exception 'STORYBOARD_NOT_FOUND'; end if;
  if v_row.deleted then return v_row; end if;
  if v_row.revision <> p_expected_revision then raise exception 'STORYBOARD_REVISION_CONFLICT'; end if;
  update public.storyboard_projects set deleted = true, revision = revision + 1, updated_at = now()
    where owner_id = p_owner_id and id = p_id returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.save_storyboard_project(text,text,bigint,text,jsonb,text) from public, anon, authenticated;
revoke all on function public.delete_storyboard_project(text,text,bigint) from public, anon, authenticated;
grant execute on function public.save_storyboard_project(text,text,bigint,text,jsonb,text) to service_role;
grant execute on function public.delete_storyboard_project(text,text,bigint) to service_role;
notify pgrst, 'reload schema';
commit;
