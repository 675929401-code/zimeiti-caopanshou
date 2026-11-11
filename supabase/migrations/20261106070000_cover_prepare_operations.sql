begin;

-- Durable material/analysis parent. Provider and wallet attempts remain in their
-- existing ledgers; this table neither charges nor retries an unknown request.
create table public.cover_prepare_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_request_id text not null check (client_request_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  material_fingerprint text not null check (material_fingerprint ~ '^[a-f0-9]{64}$'),
  revision integer not null default 1 check (revision > 0),
  state text not null default 'prepared' check (state in ('prepared','analyzing','needs_input','plan_ready','unknown','failed')),
  materials jsonb not null check (jsonb_typeof(materials) = 'object' and octet_length(materials::text) <= 98304),
  preparation jsonb not null check (jsonb_typeof(preparation) = 'object' and octet_length(preparation::text) <= 131072),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 196608)),
  analysis_request_id text not null,
  analysis_attempt_id text,
  billing jsonb not null default '{}'::jsonb check (jsonb_typeof(billing) = 'object'),
  consent jsonb check (consent is null or jsonb_typeof(consent) = 'object'),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, client_request_id)
);
create index cover_prepare_operations_owner_updated_idx
  on public.cover_prepare_operations(user_id, updated_at desc);
alter table public.cover_prepare_operations enable row level security;
-- Default privileges can grant service_role ALL on newly created tables.
-- Revoke that inherited object grant before restoring the exact API scope.
revoke all on public.cover_prepare_operations from public, anon, authenticated, service_role;
grant select, insert, update on public.cover_prepare_operations to service_role;
comment on table public.cover_prepare_operations is 'Cover workbench materials and analysis operation; owned API access only; no provider URLs, tokens or inline image bytes.';
notify pgrst, 'reload schema';
commit;
