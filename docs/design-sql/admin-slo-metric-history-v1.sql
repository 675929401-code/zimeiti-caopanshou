-- DESIGN ONLY — 2026-10-03
-- This file has not been applied to local, candidate, or production databases.
-- Until a release migration applies an audited equivalent, the UI/API must
-- report historyPersistence.state=unavailable and never render empty history
-- as zero, healthy, or "no incidents".

begin;

create table if not exists public.admin_metric_snapshot_runs (
  id uuid primary key default gen_random_uuid(),
  capture_key text not null unique,
  registry_version text not null,
  window_hours integer not null check (window_hours between 1 and 168),
  captured_at timestamptz not null,
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'capturing' check (status in ('capturing', 'captured', 'failed')),
  metric_count integer not null default 0 check (metric_count between 0 and 100),
  available_count integer not null default 0 check (available_count between 0 and 100),
  partial_count integer not null default 0 check (partial_count between 0 and 100),
  unavailable_count integer not null default 0 check (unavailable_count between 0 and 100),
  captured_by text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null
);

create table if not exists public.admin_metric_snapshot_values (
  run_id uuid not null references public.admin_metric_snapshot_runs(id) on delete cascade,
  metric_id text not null,
  captured_at timestamptz not null,
  value_json jsonb null,
  unit text not null check (unit in ('count', 'currency_cny', 'percent', 'milliseconds', 'seconds', 'text')),
  metric_status text not null check (metric_status in ('healthy', 'warning', 'critical', 'unknown', 'unavailable')),
  availability text not null check (availability in ('available', 'partial', 'unavailable')),
  partial boolean not null,
  metric_as_of timestamptz null,
  freshness_seconds integer null check (freshness_seconds is null or freshness_seconds >= 0),
  coverage_ratio numeric(8,6) null check (coverage_ratio is null or coverage_ratio between 0 and 1),
  source_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(source_ids) = 'array'),
  primary key (run_id, metric_id)
);

create index if not exists admin_metric_snapshot_runs_captured_at_idx
  on public.admin_metric_snapshot_runs (captured_at desc);
create index if not exists admin_metric_snapshot_values_metric_time_idx
  on public.admin_metric_snapshot_values (metric_id, captured_at desc);

alter table public.admin_metric_snapshot_runs enable row level security;
alter table public.admin_metric_snapshot_values enable row level security;
revoke all on public.admin_metric_snapshot_runs from anon, authenticated;
revoke all on public.admin_metric_snapshot_values from anon, authenticated;
grant select, insert, update, delete on public.admin_metric_snapshot_runs to service_role;
grant select, insert, update, delete on public.admin_metric_snapshot_values to service_role;

create or replace function public.capture_admin_metric_snapshot(
  p_capture_key text,
  p_registry_version text,
  p_window_hours integer,
  p_captured_at timestamptz,
  p_source_digest text,
  p_metrics jsonb,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_existing record;
  v_metric jsonb;
  v_metric_count integer;
  v_available integer := 0;
  v_partial integer := 0;
  v_unavailable integer := 0;
begin
  if p_capture_key is null or p_capture_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$' then
    raise exception 'SLO_METRIC_CAPTURE_KEY_INVALID' using errcode = '22023';
  end if;
  if p_registry_version is null or length(p_registry_version) > 100 then
    raise exception 'SLO_METRIC_REGISTRY_VERSION_INVALID' using errcode = '22023';
  end if;
  if p_window_hours is null or p_window_hours not between 1 and 168 then
    raise exception 'SLO_METRIC_WINDOW_INVALID' using errcode = '22023';
  end if;
  if p_captured_at is null or p_captured_at > now() + interval '5 minutes' then
    raise exception 'SLO_METRIC_CAPTURE_TIME_INVALID' using errcode = '22023';
  end if;
  if p_source_digest is null or p_source_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'SLO_METRIC_SOURCE_DIGEST_INVALID' using errcode = '22023';
  end if;
  if p_actor is null or length(trim(p_actor)) < 3 or length(p_actor) > 200 then
    raise exception 'SLO_METRIC_CAPTURE_ACTOR_INVALID' using errcode = '22023';
  end if;
  if jsonb_typeof(p_metrics) <> 'array' then
    raise exception 'SLO_METRIC_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  v_metric_count := jsonb_array_length(p_metrics);
  if v_metric_count < 1 or v_metric_count > 100 then
    raise exception 'SLO_METRIC_COUNT_INVALID' using errcode = '22023';
  end if;

  select * into v_existing
  from public.admin_metric_snapshot_runs
  where capture_key = p_capture_key
  for update;

  if found then
    if v_existing.registry_version <> p_registry_version
      or v_existing.window_hours <> p_window_hours
      or v_existing.source_digest <> p_source_digest then
      raise exception 'SLO_METRIC_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'runId', v_existing.id,
      'captureKey', v_existing.capture_key,
      'status', v_existing.status,
      'metricCount', v_existing.metric_count,
      'idempotentReplay', true
    );
  end if;

  insert into public.admin_metric_snapshot_runs (
    capture_key, registry_version, window_hours, captured_at, source_digest, captured_by
  ) values (
    p_capture_key, p_registry_version, p_window_hours, p_captured_at, p_source_digest, trim(p_actor)
  ) returning id into v_run_id;

  for v_metric in select value from jsonb_array_elements(p_metrics)
  loop
    if coalesce(v_metric->>'metricId', '') !~ '^[a-z][a-z0-9.-]{2,100}$' then
      raise exception 'SLO_METRIC_ID_INVALID' using errcode = '22023';
    end if;
    if coalesce(v_metric->>'availability', '') not in ('available', 'partial', 'unavailable') then
      raise exception 'SLO_METRIC_AVAILABILITY_INVALID' using errcode = '22023';
    end if;

    insert into public.admin_metric_snapshot_values (
      run_id,
      metric_id,
      captured_at,
      value_json,
      unit,
      metric_status,
      availability,
      partial,
      metric_as_of,
      freshness_seconds,
      coverage_ratio,
      source_ids
    ) values (
      v_run_id,
      v_metric->>'metricId',
      p_captured_at,
      v_metric->'value',
      v_metric->>'unit',
      v_metric->>'metricStatus',
      v_metric->>'availability',
      coalesce((v_metric->>'partial')::boolean, true),
      nullif(v_metric->>'asOf', '')::timestamptz,
      nullif(v_metric->>'freshnessSeconds', '')::integer,
      nullif(v_metric->>'coverageRatio', '')::numeric,
      coalesce(v_metric->'sourceIds', '[]'::jsonb)
    );

    if v_metric->>'availability' = 'available' then v_available := v_available + 1;
    elsif v_metric->>'availability' = 'partial' then v_partial := v_partial + 1;
    else v_unavailable := v_unavailable + 1;
    end if;
  end loop;

  update public.admin_metric_snapshot_runs
  set status = 'captured',
      metric_count = v_metric_count,
      available_count = v_available,
      partial_count = v_partial,
      unavailable_count = v_unavailable,
      completed_at = now()
  where id = v_run_id;

  return jsonb_build_object(
    'runId', v_run_id,
    'captureKey', p_capture_key,
    'status', 'captured',
    'metricCount', v_metric_count,
    'available', v_available,
    'partial', v_partial,
    'unavailable', v_unavailable,
    'idempotentReplay', false
  );
end;
$$;

revoke all on function public.capture_admin_metric_snapshot(text, text, integer, timestamptz, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.capture_admin_metric_snapshot(text, text, integer, timestamptz, text, jsonb, text) to service_role;

commit;

-- Release procedure (not executed by this design file):
-- 1. Convert this design into a timestamped release migration and review RLS.
-- 2. Apply it to an isolated database, run signed capture twice with the same
--    idempotency key, and prove one run / 41 values.
-- 3. Configure an external scheduler at >=5 minute cadence. The browser UI
--    must never call POST /api/internal/slo-metrics/capture.
-- 4. Add a bounded retention job only after retention days are approved.
