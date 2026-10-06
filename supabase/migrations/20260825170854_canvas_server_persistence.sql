begin;

create table if not exists public.canvas_documents (
  id text primary key,
  owner_id text not null,
  name text not null check (char_length(name) between 1 and 160),
  revision bigint not null default 1 check (revision > 0),
  document jsonb not null,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint canvas_documents_stable_id check (id ~ '^canvas:[0-9a-fA-F-]{36}$')
);

create index if not exists canvas_documents_owner_updated_idx
  on public.canvas_documents (owner_id, updated_at desc)
  where deleted = false;

create table if not exists public.canvas_document_requests (
  owner_id text not null,
  idempotency_key text not null,
  operation text not null check (operation in ('save', 'copy', 'delete')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  canvas_id text not null,
  response_revision bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (owner_id, idempotency_key)
);

create index if not exists canvas_document_requests_created_idx
  on public.canvas_document_requests (created_at);

alter table public.canvas_documents enable row level security;
alter table public.canvas_document_requests enable row level security;

drop policy if exists canvas_documents_owner_select on public.canvas_documents;
create policy canvas_documents_owner_select on public.canvas_documents
  for select using (owner_id = auth.uid()::text);

drop policy if exists canvas_documents_owner_write on public.canvas_documents;
create policy canvas_documents_owner_write on public.canvas_documents
  for all using (owner_id = auth.uid()::text) with check (owner_id = auth.uid()::text);

drop policy if exists canvas_document_requests_owner_select on public.canvas_document_requests;
create policy canvas_document_requests_owner_select on public.canvas_document_requests
  for select using (owner_id = auth.uid()::text);

revoke all on public.canvas_documents from anon, authenticated;
revoke all on public.canvas_document_requests from anon, authenticated;
grant select, insert, update, delete on public.canvas_documents to service_role;
grant select, insert, update, delete on public.canvas_document_requests to service_role;

create or replace function public.save_canvas_document_atomic(
  p_owner_id text,
  p_canvas_id text,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_operation text,
  p_request_hash text,
  p_name text,
  p_document jsonb
)
returns table (
  canvas_id text,
  canvas_name text,
  canvas_revision bigint,
  canvas_created_at timestamptz,
  canvas_updated_at timestamptz,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.canvas_document_requests%rowtype;
  v_canvas public.canvas_documents%rowtype;
begin
  if p_owner_id is null or p_canvas_id !~ '^canvas:[0-9a-fA-F-]{36}$' then
    raise exception 'CANVAS_INVALID_ARGUMENT' using errcode = 'P0001';
  end if;
  if p_expected_revision < 0 or p_operation not in ('save', 'copy') then
    raise exception 'CANVAS_INVALID_ARGUMENT' using errcode = 'P0001';
  end if;

  insert into public.canvas_document_requests (
    owner_id, idempotency_key, operation, request_hash, canvas_id, response_revision
  ) values (
    p_owner_id, p_idempotency_key, p_operation, p_request_hash, p_canvas_id, 0
  ) on conflict (owner_id, idempotency_key) do nothing;

  select * into v_request
  from public.canvas_document_requests
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;

  if v_request.request_hash <> p_request_hash or v_request.operation <> p_operation then
    raise exception 'CANVAS_IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;

  if v_request.response_revision > 0 then
    select * into v_canvas
    from public.canvas_documents
    where id = v_request.canvas_id and owner_id = p_owner_id;
    if not found then raise exception 'CANVAS_NOT_FOUND' using errcode = 'P0001'; end if;
    return query select v_canvas.id, v_canvas.name, v_request.response_revision,
      v_canvas.created_at, v_canvas.updated_at, true;
    return;
  end if;

  select * into v_canvas
  from public.canvas_documents
  where id = p_canvas_id and owner_id = p_owner_id
  for update;

  if found then
    if v_canvas.deleted then raise exception 'CANVAS_NOT_FOUND' using errcode = 'P0001'; end if;
    if v_canvas.revision <> p_expected_revision then
      raise exception 'CANVAS_REVISION_CONFLICT:%', v_canvas.revision using errcode = 'P0001';
    end if;
    update public.canvas_documents
      set name = p_name,
          document = p_document,
          revision = revision + 1,
          updated_at = now()
      where id = p_canvas_id and owner_id = p_owner_id
      returning * into v_canvas;
  else
    if p_expected_revision <> 0 then
      raise exception 'CANVAS_NOT_FOUND' using errcode = 'P0001';
    end if;
    insert into public.canvas_documents (id, owner_id, name, revision, document)
      values (p_canvas_id, p_owner_id, p_name, 1, p_document)
      returning * into v_canvas;
  end if;

  update public.canvas_document_requests
    set canvas_id = v_canvas.id, response_revision = v_canvas.revision
    where owner_id = p_owner_id and idempotency_key = p_idempotency_key;

  return query select v_canvas.id, v_canvas.name, v_canvas.revision,
    v_canvas.created_at, v_canvas.updated_at, false;
end;
$$;

create or replace function public.delete_canvas_document_atomic(
  p_owner_id text,
  p_canvas_id text,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns table (canvas_id text, deleted_revision bigint, idempotent_replay boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.canvas_document_requests%rowtype;
  v_canvas public.canvas_documents%rowtype;
begin
  insert into public.canvas_document_requests (
    owner_id, idempotency_key, operation, request_hash, canvas_id, response_revision
  ) values (
    p_owner_id, p_idempotency_key, 'delete', p_request_hash, p_canvas_id, 0
  ) on conflict (owner_id, idempotency_key) do nothing;

  select * into v_request
  from public.canvas_document_requests
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;

  if v_request.request_hash <> p_request_hash or v_request.operation <> 'delete' then
    raise exception 'CANVAS_IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;
  if v_request.response_revision > 0 then
    return query select v_request.canvas_id, v_request.response_revision, true;
    return;
  end if;

  select * into v_canvas
  from public.canvas_documents
  where id = p_canvas_id and owner_id = p_owner_id
  for update;
  if not found or v_canvas.deleted then raise exception 'CANVAS_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_canvas.revision <> p_expected_revision then
    raise exception 'CANVAS_REVISION_CONFLICT:%', v_canvas.revision using errcode = 'P0001';
  end if;

  update public.canvas_documents
    set deleted = true, revision = revision + 1, updated_at = now()
    where id = p_canvas_id and owner_id = p_owner_id
    returning * into v_canvas;

  update public.canvas_document_requests
    set response_revision = v_canvas.revision
    where owner_id = p_owner_id and idempotency_key = p_idempotency_key;

  return query select v_canvas.id, v_canvas.revision, false;
end;
$$;

revoke all on function public.save_canvas_document_atomic(text,text,bigint,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.delete_canvas_document_atomic(text,text,bigint,text,text) from public, anon, authenticated;
grant execute on function public.save_canvas_document_atomic(text,text,bigint,text,text,text,text,jsonb) to service_role;
grant execute on function public.delete_canvas_document_atomic(text,text,bigint,text,text) to service_role;

commit;
