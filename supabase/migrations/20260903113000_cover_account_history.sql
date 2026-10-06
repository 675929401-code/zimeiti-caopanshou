begin;

create table if not exists public.cover_generation_history (
  asset_id uuid primary key,
  user_id uuid not null,
  background_asset_id uuid not null,
  history_record_id text not null,
  plan jsonb not null check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 8192),
  output_width integer not null check (output_width > 0),
  output_height integer not null check (output_height > 0),
  source_width integer not null check (source_width > 0),
  source_height integer not null check (source_height > 0),
  task_no integer not null check (task_no > 0),
  created_at timestamptz not null default now(),
  hidden_at timestamptz,
  unique (user_id, task_no)
);
alter table public.cover_generation_history add column if not exists authoring_context jsonb not null default '{}'::jsonb;
create index if not exists cover_history_user_created_idx
  on public.cover_generation_history(user_id, created_at desc, asset_id) where hidden_at is null;
alter table public.cover_generation_history enable row level security;
revoke all on public.cover_generation_history from anon, authenticated;
grant select, insert, update on public.cover_generation_history to service_role;

create or replace function public.record_cover_composition(
  p_user_id uuid, p_asset_id uuid, p_background_asset_id uuid, p_history_record_id text,
  p_plan jsonb, p_output_width integer, p_output_height integer, p_source_width integer, p_source_height integer
) returns public.cover_generation_history
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.cover_generation_history%rowtype; v_created timestamptz; v_number integer; v_plan jsonb; v_context jsonb;
begin
  if p_user_id is null or p_asset_id is null or p_background_asset_id is null or p_history_record_id is null
    or p_plan is null or not (p_plan ?& array['title','subtitle','aspectRatio','layoutTemplateId','animationStyleId'])
    then raise exception 'COVER_HISTORY_INVALID'; end if;
  v_plan := p_plan - '_authoring';
  v_context := coalesce(p_plan->'_authoring','{}'::jsonb);
  if jsonb_typeof(v_context)<>'object' or octet_length(v_context::text)>262144 then raise exception 'COVER_HISTORY_INVALID'; end if;
  if not exists(select 1 from user_files where id=p_asset_id and user_id=p_user_id and file_category='image')
    or not exists(select 1 from user_files where id=p_background_asset_id and user_id=p_user_id and file_category='image')
    or not exists(select 1 from conversation_messages where id=p_history_record_id and user_id::text=p_user_id::text
      and agent_id='image-workbench' and content::jsonb @> jsonb_build_object('images',jsonb_build_array(jsonb_build_object('assetId',p_asset_id::text))))
    then raise exception 'COVER_HISTORY_OWNERSHIP'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cover-history:' || p_user_id::text,0));
  select * into v_row from cover_generation_history where asset_id=p_asset_id;
  if found then
    if v_row.user_id<>p_user_id or v_row.background_asset_id<>p_background_asset_id or v_row.plan<>v_plan
      or v_row.history_record_id<>p_history_record_id then raise exception 'COVER_HISTORY_CONFLICT'; end if;
    if v_row.authoring_context='{}'::jsonb and v_context<>'{}'::jsonb then
      update cover_generation_history set authoring_context=v_context where asset_id=p_asset_id returning * into v_row;
    end if;
    -- Replaying a completed render must never resurrect a removed history item.
    return v_row;
  end if;
  select created_at into v_created from user_files where id=p_asset_id;
  select coalesce(max(task_no),0)+1 into v_number from cover_generation_history where user_id=p_user_id;
  insert into cover_generation_history(asset_id,user_id,background_asset_id,history_record_id,plan,
    output_width,output_height,source_width,source_height,task_no,created_at,authoring_context)
    values(p_asset_id,p_user_id,p_background_asset_id,p_history_record_id,v_plan,
      p_output_width,p_output_height,p_source_width,p_source_height,v_number,v_created,v_context) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.hide_cover_history(p_user_id uuid, p_asset_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_user_id is null then raise exception 'COVER_HISTORY_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cover-history:' || p_user_id::text,0));
  if p_asset_id is not null and not exists(select 1 from cover_generation_history where asset_id=p_asset_id and user_id=p_user_id)
    then raise exception 'COVER_HISTORY_NOT_FOUND'; end if;
  update cover_generation_history set hidden_at=clock_timestamp()
    where user_id=p_user_id and hidden_at is null and (p_asset_id is null or asset_id=p_asset_id);
  get diagnostics v_count = row_count;
  return jsonb_build_object('success',true,'hiddenCount',v_count);
end;
$$;

revoke all on function public.record_cover_composition(uuid,uuid,uuid,text,jsonb,integer,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.hide_cover_history(uuid,uuid) from public,anon,authenticated;
grant execute on function public.record_cover_composition(uuid,uuid,uuid,text,jsonb,integer,integer,integer,integer) to service_role;
grant execute on function public.hide_cover_history(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
