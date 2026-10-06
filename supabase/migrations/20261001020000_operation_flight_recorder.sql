BEGIN;

-- A durable, append-only flight recorder for cross-surface operational facts.
-- Payloads, prompts, provider responses, credentials and signed URLs are never
-- accepted by this table. Business lifecycle triggers write only stable IDs,
-- state transitions, bounded timing data and non-sensitive accounting flags.
CREATE TABLE IF NOT EXISTS public.operation_flight_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text NOT NULL,
  user_id text,
  username text,
  source text NOT NULL CHECK (source IN ('browser', 'database', 'server', 'worker', 'system', 'admin')),
  domain text NOT NULL CHECK (domain IN ('chat', 'image', 'video', 'voice', 'extract', 'payment', 'auth', 'storage', 'admin', 'system', 'other')),
  operation text NOT NULL,
  phase text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('in_progress', 'success', 'warning', 'error', 'cancelled', 'unknown')),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  route text,
  error_code text,
  error_fingerprint text,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  source_version text,
  build_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_flight_trace_format CHECK (trace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'),
  CONSTRAINT operation_flight_operation_length CHECK (char_length(operation) BETWEEN 1 AND 120),
  CONSTRAINT operation_flight_phase_length CHECK (char_length(phase) BETWEEN 1 AND 80),
  CONSTRAINT operation_flight_route_path CHECK (route IS NULL OR (char_length(route) <= 512 AND route LIKE '/%')),
  CONSTRAINT operation_flight_error_fingerprint_format CHECK (
    error_fingerprint IS NULL OR error_fingerprint ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS operation_flight_events_occurred_idx
  ON public.operation_flight_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS operation_flight_events_trace_idx
  ON public.operation_flight_events (trace_id, occurred_at ASC);
CREATE INDEX IF NOT EXISTS operation_flight_events_user_idx
  ON public.operation_flight_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operation_flight_events_domain_outcome_idx
  ON public.operation_flight_events (domain, outcome, occurred_at DESC);
CREATE INDEX IF NOT EXISTS operation_flight_events_error_idx
  ON public.operation_flight_events (error_fingerprint, occurred_at DESC)
  WHERE error_fingerprint IS NOT NULL;

ALTER TABLE public.operation_flight_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.operation_flight_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.operation_flight_events TO service_role;

CREATE OR REPLACE FUNCTION public.capture_operation_flight_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
  v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_state text;
  v_old_state text;
  v_trace text;
  v_domain text;
  v_operation text;
  v_outcome text;
  v_started_at timestamptz;
  v_ended_at timestamptz;
  v_occurred_at timestamptz := now();
  v_duration_ms bigint;
  v_http_status integer;
  v_error_code text;
  v_record_id text;
  v_metadata jsonb;
BEGIN
  v_state := lower(coalesce(nullif(v_new ->> 'state', ''), nullif(v_new ->> 'status', ''), 'updated'));
  v_old_state := lower(coalesce(nullif(v_old ->> 'state', ''), nullif(v_old ->> 'status', ''), ''));

  -- Ignore ordinary row refreshes. State, terminal timestamp, error code and
  -- billing/delivery state changes remain visible without logging prompts,
  -- responses, URLs or other unbounded business payloads.
  IF TG_OP = 'UPDATE'
     AND v_state IS NOT DISTINCT FROM v_old_state
     AND (v_new ->> 'completed_at') IS NOT DISTINCT FROM (v_old ->> 'completed_at')
     AND (v_new ->> 'error_code') IS NOT DISTINCT FROM (v_old ->> 'error_code')
     AND (v_new ->> 'billing_state') IS NOT DISTINCT FROM (v_old ->> 'billing_state')
     AND (v_new ->> 'delivery_state') IS NOT DISTINCT FROM (v_old ->> 'delivery_state') THEN
    RETURN NEW;
  END IF;

  v_record_id := coalesce(
    nullif(v_new ->> 'record_id', ''),
    nullif(v_new ->> 'request_id', ''),
    nullif(v_new ->> 'id', ''),
    'unknown'
  );
  v_trace := coalesce(
    nullif(v_new ->> 'client_request_id', ''),
    nullif(v_new ->> 'client_trace_id', ''),
    nullif(v_new ->> 'client_idempotency_key', ''),
    nullif(v_new ->> 'request_id', ''),
    nullif(v_new ->> 'record_id', ''),
    nullif(v_new ->> 'id', '')
  );
  v_trace := regexp_replace(coalesce(v_trace, TG_TABLE_NAME || ':' || v_record_id), '[^A-Za-z0-9._:-]', '_', 'g');
  IF char_length(v_trace) < 8 THEN
    v_trace := regexp_replace(TG_TABLE_NAME || ':' || v_record_id, '[^A-Za-z0-9._:-]', '_', 'g');
  END IF;
  v_trace := left(v_trace, 160);

  SELECT mapped.domain, mapped.operation
    INTO v_domain, v_operation
    FROM (VALUES
      ('llm_request_attempts', 'chat', 'chat.model_request'),
      ('image_generation_requests', 'image', 'image.generation'),
      ('video_tasks', 'video', 'video.generation'),
      ('voice_generation_requests', 'voice', 'voice.generation'),
      ('extraction_attempts', 'extract', 'extract.request')
    ) AS mapped(table_name, domain, operation)
   WHERE mapped.table_name = TG_TABLE_NAME;
  v_domain := coalesce(v_domain, 'other');
  v_operation := coalesce(v_operation, TG_TABLE_NAME || '.lifecycle');

  v_outcome := CASE
    WHEN v_state IN ('succeeded', 'completed', 'delivered', 'success', 'active') THEN 'success'
    WHEN v_state IN ('failed', 'failed_unknown', 'reconciliation_required', 'recovery_required', 'error', 'unhealthy') THEN 'error'
    WHEN v_state IN ('cancelled', 'canceled', 'refunded') THEN 'cancelled'
    WHEN v_state IN ('degraded', 'warning', 'held') THEN 'warning'
    WHEN v_state IN ('running', 'pending', 'submitting', 'intent', 'processing', 'queued', 'finalizing') THEN 'in_progress'
    ELSE 'unknown'
  END;

  BEGIN
    v_started_at := coalesce(
      nullif(v_new ->> 'provider_call_started_at', '')::timestamptz,
      nullif(v_new ->> 'started_at', '')::timestamptz,
      nullif(v_new ->> 'created_at', '')::timestamptz
    );
  EXCEPTION WHEN others THEN
    v_started_at := NULL;
  END;
  BEGIN
    v_ended_at := coalesce(
      nullif(v_new ->> 'completed_at', '')::timestamptz,
      nullif(v_new ->> 'updated_at', '')::timestamptz,
      v_started_at
    );
  EXCEPTION WHEN others THEN
    v_ended_at := v_started_at;
  END;
  IF v_started_at IS NOT NULL AND v_ended_at IS NOT NULL AND v_outcome <> 'in_progress' THEN
    v_duration_ms := greatest(0, least(86400000, floor(extract(epoch FROM (v_ended_at - v_started_at)) * 1000)::bigint));
  END IF;
  v_occurred_at := coalesce(v_ended_at, v_started_at, now());

  BEGIN
    v_http_status := nullif(v_new ->> 'http_status', '')::integer;
  EXCEPTION WHEN others THEN
    v_http_status := NULL;
  END;
  IF v_http_status IS NOT NULL AND (v_http_status < 100 OR v_http_status > 599) THEN
    v_http_status := NULL;
  END IF;

  v_error_code := left(nullif(v_new ->> 'error_code', ''), 120);
  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source_table', TG_TABLE_NAME,
    'record_id', left(v_record_id, 160),
    'workload_phase', left(nullif(v_new ->> 'phase', ''), 80),
    'model_id', left(nullif(v_new ->> 'model_id', ''), 160),
    'provider_task_id', left(coalesce(nullif(v_new ->> 'provider_task_id', ''), nullif(v_new ->> 'task_id_external', '')), 160),
    'attempt_no', v_new -> 'attempt_no',
    'billing_state', left(nullif(v_new ->> 'billing_state', ''), 80),
    'delivery_state', left(nullif(v_new ->> 'delivery_state', ''), 80),
    'charged_credits', v_new -> 'charge_credits',
    'price_charged', v_new -> 'price_charged'
  ));

  INSERT INTO public.operation_flight_events (
    trace_id, user_id, source, domain, operation, phase, outcome,
    duration_ms, http_status, error_code, summary, metadata, occurred_at
  ) VALUES (
    v_trace,
    left(nullif(v_new ->> 'user_id', ''), 160),
    'database',
    v_domain,
    v_operation,
    left(v_state, 80),
    v_outcome,
    v_duration_ms,
    v_http_status,
    v_error_code,
    left(v_operation || ' lifecycle entered ' || v_state, 500),
    v_metadata,
    v_occurred_at
  );
  RETURN NEW;
EXCEPTION WHEN others THEN
  -- Telemetry can never make a paid or user-facing business transaction fail.
  RAISE WARNING '[operation-flight-recorder] capture failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'llm_request_attempts',
    'image_generation_requests',
    'video_tasks',
    'voice_generation_requests',
    'extraction_attempts'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS operation_flight_recorder ON public.%I', v_table);
      EXECUTE format(
        'CREATE TRIGGER operation_flight_recorder AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.capture_operation_flight_event()',
        v_table
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;
