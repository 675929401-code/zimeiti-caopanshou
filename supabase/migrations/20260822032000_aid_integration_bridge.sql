begin;

create table if not exists public.aid_launch_tickets (
  ticket_hash text primary key,
  ticket_id uuid not null default gen_random_uuid() unique,
  -- Live users.id is varchar(36). Keep the bridge identity on that exact type
  -- so PostgreSQL can create the foreign key instead of failing the first
  -- migration in the release chain with uuid/varchar incompatibility.
  user_id varchar(36) not null references public.users(id) on delete cascade,
  role text not null,
  member_status text not null,
  tenant_id text not null default 'default',
  target_path text not null default '/',
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by text,
  constraint aid_launch_tickets_expiry_check check (expires_at > issued_at),
  constraint aid_launch_tickets_target_check check (target_path like '/%' and target_path not like '//%')
);

create index if not exists aid_launch_tickets_expiry_idx
  on public.aid_launch_tickets (expires_at)
  where consumed_at is null;

alter table public.aid_launch_tickets enable row level security;
drop policy if exists aid_launch_tickets_client_deny on public.aid_launch_tickets;
create policy aid_launch_tickets_client_deny
  on public.aid_launch_tickets
  for all
  to authenticated
  using (false)
  with check (false);

create table if not exists public.aid_service_nonces (
  nonce text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists aid_service_nonces_expiry_idx
  on public.aid_service_nonces (expires_at);

alter table public.aid_service_nonces enable row level security;
drop policy if exists aid_service_nonces_client_deny on public.aid_service_nonces;
create policy aid_service_nonces_client_deny
  on public.aid_service_nonces
  for all
  to authenticated
  using (false)
  with check (false);

create or replace function public.consume_aid_launch_ticket(
  p_ticket_hash text,
  p_consumed_by text
)
returns table (
  ticket_id uuid,
  user_id varchar(36),
  role text,
  member_status text,
  tenant_id text,
  target_path text
)
language sql
security definer
set search_path = public
as $$
  update public.aid_launch_tickets
  set consumed_at = now(), consumed_by = p_consumed_by
  where ticket_hash = p_ticket_hash
    and consumed_at is null
    and expires_at > now()
  returning ticket_id, user_id, role, member_status, tenant_id, target_path;
$$;

revoke all on function public.consume_aid_launch_ticket(text, text) from public;
revoke all on function public.consume_aid_launch_ticket(text, text) from anon;
revoke all on function public.consume_aid_launch_ticket(text, text) from authenticated;
grant execute on function public.consume_aid_launch_ticket(text, text) to service_role;

commit;
