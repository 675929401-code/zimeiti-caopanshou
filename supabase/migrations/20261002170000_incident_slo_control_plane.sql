BEGIN;

-- Stage-one SLI/SLO and incident control plane.
-- This migration creates durable control-plane state only. It does not attach
-- collectors, send alerts, restart services, replay paid work, or remediate
-- production. Existing health, flight-recorder, log and queue sources remain
-- independent until an explicit later integration migration is reviewed.

CREATE TABLE IF NOT EXISTS public.incident_slo_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text,
  owner_key text,
  criticality text NOT NULL DEFAULT 'P2' CHECK (criticality IN ('P0','P1','P2','P3')),
  source_contract jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_contract) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_service_key_format CHECK (service_key ~ '^[a-z0-9][a-z0-9._:-]{2,119}$'),
  CONSTRAINT incident_slo_service_name_length CHECK (char_length(display_name) BETWEEN 1 AND 160)
);

CREATE TABLE IF NOT EXISTS public.incident_slo_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.incident_slo_services(id) ON DELETE RESTRICT,
  slo_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  indicator_kind text NOT NULL CHECK (indicator_kind IN (
    'availability','error_rate','latency','queue_freshness','worker_heartbeat','external_dependency','custom'
  )),
  objective_ratio numeric(9,8) NOT NULL CHECK (objective_ratio > 0 AND objective_ratio <= 1),
  objective_window_seconds integer NOT NULL CHECK (objective_window_seconds BETWEEN 60 AND 31536000),
  latency_threshold_ms integer CHECK (latency_threshold_ms IS NULL OR latency_threshold_ms BETWEEN 1 AND 86400000),
  measurement_source text NOT NULL,
  burn_rate_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(burn_rate_policy) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_definition_key_format CHECK (slo_key ~ '^[a-z0-9][a-z0-9._:-]{2,159}$'),
  CONSTRAINT incident_slo_measurement_source_length CHECK (char_length(measurement_source) BETWEEN 1 AND 160)
);

CREATE TABLE IF NOT EXISTS public.incident_slo_maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid REFERENCES public.incident_slo_services(id) ON DELETE RESTRICT,
  window_key text NOT NULL UNIQUE,
  title text NOT NULL,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  suppression_scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(suppression_scope) = 'object'),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','completed','cancelled')),
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_maintenance_range CHECK (ends_at > starts_at),
  CONSTRAINT incident_slo_maintenance_key_format CHECK (window_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$')
);

CREATE TABLE IF NOT EXISTS public.incident_slo_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.incident_slo_services(id) ON DELETE RESTRICT,
  slo_definition_id uuid NOT NULL REFERENCES public.incident_slo_definitions(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  window_kind text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  source_status text NOT NULL CHECK (source_status IN ('available','partial','unavailable')),
  sli_value numeric(12,10),
  good_count bigint,
  total_count bigint,
  burn_rate numeric(18,8),
  error_budget_remaining_ratio numeric(18,8),
  violated boolean NOT NULL DEFAULT false,
  source_as_of timestamptz,
  freshness_seconds integer,
  coverage_ratio numeric(9,8),
  source_reference jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_reference) = 'object'),
  observation_payload jsonb NOT NULL CHECK (jsonb_typeof(observation_payload) = 'object'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_measurement_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT incident_slo_measurement_window CHECK (window_ended_at > window_started_at),
  CONSTRAINT incident_slo_measurement_value CHECK (sli_value IS NULL OR (sli_value >= 0 AND sli_value <= 1)),
  CONSTRAINT incident_slo_measurement_counts CHECK (
    (good_count IS NULL OR good_count >= 0) AND
    (total_count IS NULL OR total_count >= 0) AND
    (good_count IS NULL OR total_count IS NULL OR good_count <= total_count)
  ),
  CONSTRAINT incident_slo_measurement_burn_rate CHECK (burn_rate IS NULL OR burn_rate >= 0),
  CONSTRAINT incident_slo_measurement_freshness CHECK (freshness_seconds IS NULL OR freshness_seconds >= 0),
  CONSTRAINT incident_slo_measurement_coverage CHECK (coverage_ratio IS NULL OR (coverage_ratio >= 0 AND coverage_ratio <= 1)),
  CONSTRAINT incident_slo_unavailable_is_null CHECK (
    source_status <> 'unavailable' OR (
      sli_value IS NULL AND good_count IS NULL AND total_count IS NULL AND burn_rate IS NULL
      AND error_budget_remaining_ratio IS NULL AND source_as_of IS NULL AND freshness_seconds IS NULL
      AND coverage_ratio IS NULL AND violated = false
    )
  ),
  CONSTRAINT incident_slo_available_has_value CHECK (source_status = 'unavailable' OR sli_value IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.incident_slo_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.incident_slo_services(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','owned','triaged','mitigating','monitoring','resolved','false_positive'
  )),
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  title text NOT NULL,
  owner_actor_id text,
  lease_token uuid,
  lease_until timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text,
  postmortem_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_incident_fingerprint_format CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT incident_slo_incident_lease_shape CHECK (
    (lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS incident_slo_one_active_incident_per_fingerprint
  ON public.incident_slo_incidents (fingerprint)
  WHERE status IN ('open','owned','triaged','mitigating','monitoring');

CREATE TABLE IF NOT EXISTS public.incident_slo_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.incident_slo_services(id) ON DELETE RESTRICT,
  slo_definition_id uuid NOT NULL REFERENCES public.incident_slo_definitions(id) ON DELETE RESTRICT,
  latest_measurement_id uuid NOT NULL REFERENCES public.incident_slo_measurements(id) ON DELETE RESTRICT,
  incident_id uuid REFERENCES public.incident_slo_incidents(id) ON DELETE SET NULL,
  maintenance_window_id uuid REFERENCES public.incident_slo_maintenance_windows(id) ON DELETE SET NULL,
  fingerprint text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','suppressed','resolved')),
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  summary text NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_alert_fingerprint_format CHECK (fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS public.incident_slo_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.incident_slo_incidents(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'created','deduplicated','claimed','state_changed','probe_requested','probe_result',
    'action_previewed','action_requested','postmortem_linked','note'
  )),
  from_status text,
  to_status text,
  actor_id text NOT NULL,
  trace_id text,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, idempotency_key),
  CONSTRAINT incident_slo_event_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 240)
);

CREATE TABLE IF NOT EXISTS public.incident_slo_recovery_probes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.incident_slo_incidents(id) ON DELETE RESTRICT,
  probe_key text NOT NULL UNIQUE,
  probe_kind text NOT NULL CHECK (probe_kind IN (
    'read_only_health','read_only_consistency','worker_heartbeat','external_dependency_read'
  )),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','running','passed','failed','cancelled')),
  requested_by text NOT NULL,
  request_idempotency_key text NOT NULL UNIQUE,
  result_request_key text UNIQUE,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  result_summary text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  execution_enabled boolean NOT NULL DEFAULT false CHECK (execution_enabled = false),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_probe_key_length CHECK (char_length(probe_key) BETWEEN 8 AND 200)
);

CREATE TABLE IF NOT EXISTS public.incident_slo_postmortems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL UNIQUE REFERENCES public.incident_slo_incidents(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','published','waived')),
  owner_actor_id text NOT NULL,
  summary text,
  root_cause jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(root_cause) = 'object'),
  action_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_items) = 'array'),
  external_reference text,
  last_request_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.incident_slo_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.incident_slo_incidents(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('preview','request')),
  action_kind text NOT NULL CHECK (action_kind IN (
    'read_only_probe','resume_side_effect_free_polling','pause_confirmed_fault_channel'
  )),
  status text NOT NULL CHECK (status IN ('previewed','requested','cancelled','rejected')),
  requested_by text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  execution_enabled boolean NOT NULL DEFAULT false CHECK (execution_enabled = false),
  paid_operation boolean NOT NULL DEFAULT false CHECK (paid_operation = false),
  service_restart boolean NOT NULL DEFAULT false CHECK (service_restart = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_action_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 200)
);

CREATE TABLE IF NOT EXISTS public.incident_slo_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  service_id uuid REFERENCES public.incident_slo_services(id) ON DELETE RESTRICT,
  incident_id uuid REFERENCES public.incident_slo_incidents(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  action text NOT NULL,
  result text NOT NULL CHECK (result IN ('success','rejected','deduplicated','suppressed')),
  reason_code text NOT NULL,
  trace_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_slo_audit_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 320)
);

CREATE INDEX IF NOT EXISTS incident_slo_measurements_definition_window_idx
  ON public.incident_slo_measurements (slo_definition_id, window_ended_at DESC);
CREATE INDEX IF NOT EXISTS incident_slo_measurements_source_status_idx
  ON public.incident_slo_measurements (source_status, observed_at DESC);
CREATE INDEX IF NOT EXISTS incident_slo_alerts_state_seen_idx
  ON public.incident_slo_alerts (state, last_observed_at DESC);
CREATE INDEX IF NOT EXISTS incident_slo_incidents_status_updated_idx
  ON public.incident_slo_incidents (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS incident_slo_incident_events_timeline_idx
  ON public.incident_slo_incident_events (incident_id, occurred_at ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS incident_slo_maintenance_active_idx
  ON public.incident_slo_maintenance_windows (service_id, starts_at, ends_at)
  WHERE status IN ('scheduled','active');
CREATE INDEX IF NOT EXISTS incident_slo_recovery_incident_idx
  ON public.incident_slo_recovery_probes (incident_id, requested_at DESC);

ALTER TABLE public.incident_slo_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_maintenance_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_recovery_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_postmortems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_slo_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.incident_slo_services FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_definitions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_maintenance_windows FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_measurements FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_incidents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_alerts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_incident_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_recovery_probes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_postmortems FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_action_requests FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.incident_slo_audit_events FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reject_incident_slo_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'INCIDENT_SLO_IMMUTABLE_EVIDENCE' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS incident_slo_measurements_immutable ON public.incident_slo_measurements;
CREATE TRIGGER incident_slo_measurements_immutable
  BEFORE UPDATE OR DELETE ON public.incident_slo_measurements
  FOR EACH ROW EXECUTE FUNCTION public.reject_incident_slo_immutable_mutation();
DROP TRIGGER IF EXISTS incident_slo_incident_events_immutable ON public.incident_slo_incident_events;
CREATE TRIGGER incident_slo_incident_events_immutable
  BEFORE UPDATE OR DELETE ON public.incident_slo_incident_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_incident_slo_immutable_mutation();
DROP TRIGGER IF EXISTS incident_slo_audit_events_immutable ON public.incident_slo_audit_events;
CREATE TRIGGER incident_slo_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.incident_slo_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_incident_slo_immutable_mutation();

CREATE OR REPLACE FUNCTION public.record_incident_slo_observation_atomic(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_service public.incident_slo_services%ROWTYPE;
  v_slo public.incident_slo_definitions%ROWTYPE;
  v_measurement public.incident_slo_measurements%ROWTYPE;
  v_alert public.incident_slo_alerts%ROWTYPE;
  v_incident public.incident_slo_incidents%ROWTYPE;
  v_maintenance_id uuid;
  v_measurement_key text := btrim(coalesce(p_input ->> 'idempotencyKey', ''));
  v_service_key text := lower(btrim(coalesce(p_input ->> 'serviceKey', '')));
  v_slo_key text := lower(btrim(coalesce(p_input ->> 'sloKey', '')));
  v_window_kind text := btrim(coalesce(p_input ->> 'windowKind', ''));
  v_source_status text := lower(btrim(coalesce(p_input ->> 'sourceStatus', '')));
  v_actor_id text := left(btrim(coalesce(p_input ->> 'actorId', 'system')), 200);
  v_trace_id text := nullif(left(btrim(coalesce(p_input ->> 'traceId', '')), 200), '');
  v_alert_fingerprint text := lower(btrim(coalesce(p_input ->> 'alertFingerprint', '')));
  v_alert_severity text := upper(btrim(coalesce(p_input ->> 'alertSeverity', 'P2')));
  v_alert_summary text := left(btrim(coalesce(p_input ->> 'alertSummary', '')), 500);
  v_window_started_at timestamptz;
  v_window_ended_at timestamptz;
  v_source_as_of timestamptz;
  v_sli_value numeric;
  v_good_count bigint;
  v_total_count bigint;
  v_burn_rate numeric;
  v_error_budget_remaining numeric;
  v_freshness_seconds integer;
  v_coverage_ratio numeric;
  v_violated boolean := coalesce((p_input ->> 'violated')::boolean, false);
  v_source_reference jsonb := coalesce(p_input -> 'sourceReference', '{}'::jsonb);
  v_payload jsonb;
  v_inserted boolean := false;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'INCIDENT_SLO_OBSERVATION_OBJECT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_measurement_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INCIDENT_SLO_IDEMPOTENCY_KEY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_window_kind = '' OR char_length(v_window_kind) > 80 THEN
    RAISE EXCEPTION 'INCIDENT_SLO_WINDOW_KIND_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_source_status NOT IN ('available','partial','unavailable') THEN
    RAISE EXCEPTION 'INCIDENT_SLO_SOURCE_STATUS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_source_reference) <> 'object' THEN
    RAISE EXCEPTION 'INCIDENT_SLO_SOURCE_REFERENCE_INVALID' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_window_started_at := (p_input ->> 'windowStartedAt')::timestamptz;
    v_window_ended_at := (p_input ->> 'windowEndedAt')::timestamptz;
    v_source_as_of := nullif(p_input ->> 'sourceAsOf', '')::timestamptz;
    v_sli_value := nullif(p_input ->> 'sliValue', '')::numeric;
    v_good_count := nullif(p_input ->> 'goodCount', '')::bigint;
    v_total_count := nullif(p_input ->> 'totalCount', '')::bigint;
    v_burn_rate := nullif(p_input ->> 'burnRate', '')::numeric;
    v_error_budget_remaining := nullif(p_input ->> 'errorBudgetRemainingRatio', '')::numeric;
    v_freshness_seconds := nullif(p_input ->> 'freshnessSeconds', '')::integer;
    v_coverage_ratio := nullif(p_input ->> 'coverageRatio', '')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'INCIDENT_SLO_OBSERVATION_VALUE_INVALID' USING ERRCODE = '22023';
  END;

  IF v_window_started_at IS NULL OR v_window_ended_at IS NULL OR v_window_ended_at <= v_window_started_at THEN
    RAISE EXCEPTION 'INCIDENT_SLO_WINDOW_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_source_status = 'unavailable' THEN
    IF v_sli_value IS NOT NULL OR v_good_count IS NOT NULL OR v_total_count IS NOT NULL OR v_burn_rate IS NOT NULL
       OR v_error_budget_remaining IS NOT NULL OR v_source_as_of IS NOT NULL OR v_freshness_seconds IS NOT NULL
       OR v_coverage_ratio IS NOT NULL OR v_violated THEN
      RAISE EXCEPTION 'INCIDENT_SLO_UNAVAILABLE_MUST_BE_NULL' USING ERRCODE = '22023';
    END IF;
  ELSIF v_sli_value IS NULL THEN
    RAISE EXCEPTION 'INCIDENT_SLO_AVAILABLE_VALUE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_violated AND v_alert_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INCIDENT_SLO_ALERT_FINGERPRINT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_violated AND (v_alert_severity NOT IN ('P0','P1','P2','P3') OR v_alert_summary = '') THEN
    RAISE EXCEPTION 'INCIDENT_SLO_ALERT_FIELDS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_service
    FROM public.incident_slo_services
   WHERE service_key = v_service_key AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INCIDENT_SLO_SERVICE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_slo
    FROM public.incident_slo_definitions
   WHERE slo_key = v_slo_key AND service_id = v_service.id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INCIDENT_SLO_DEFINITION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'serviceKey', v_service_key,
    'sloKey', v_slo_key,
    'windowKind', v_window_kind,
    'windowStartedAt', v_window_started_at,
    'windowEndedAt', v_window_ended_at,
    'sourceStatus', v_source_status,
    'sliValue', v_sli_value,
    'goodCount', v_good_count,
    'totalCount', v_total_count,
    'burnRate', v_burn_rate,
    'errorBudgetRemainingRatio', v_error_budget_remaining,
    'violated', v_violated,
    'sourceAsOf', v_source_as_of,
    'freshnessSeconds', v_freshness_seconds,
    'coverageRatio', v_coverage_ratio,
    'sourceReference', v_source_reference,
    'alertFingerprint', nullif(v_alert_fingerprint, ''),
    'alertSeverity', CASE WHEN v_violated THEN v_alert_severity END,
    'alertSummary', CASE WHEN v_violated THEN v_alert_summary END
  ));

  PERFORM pg_advisory_xact_lock(hashtextextended('incident-slo-measurement:' || v_measurement_key, 0));
  INSERT INTO public.incident_slo_measurements (
    service_id, slo_definition_id, idempotency_key, window_kind,
    window_started_at, window_ended_at, source_status, sli_value,
    good_count, total_count, burn_rate, error_budget_remaining_ratio,
    violated, source_as_of, freshness_seconds, coverage_ratio,
    source_reference, observation_payload
  ) VALUES (
    v_service.id, v_slo.id, v_measurement_key, v_window_kind,
    v_window_started_at, v_window_ended_at, v_source_status, v_sli_value,
    v_good_count, v_total_count, v_burn_rate, v_error_budget_remaining,
    v_violated, v_source_as_of, v_freshness_seconds, v_coverage_ratio,
    v_source_reference, v_payload
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_measurement;

  IF NOT FOUND THEN
    SELECT * INTO v_measurement
      FROM public.incident_slo_measurements
     WHERE idempotency_key = v_measurement_key;
    IF v_measurement.observation_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'INCIDENT_SLO_MEASUREMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    IF v_violated THEN
      SELECT * INTO v_alert FROM public.incident_slo_alerts WHERE fingerprint = v_alert_fingerprint;
      SELECT * INTO v_incident
        FROM public.incident_slo_incidents
       WHERE fingerprint = v_alert_fingerprint
         AND status IN ('open','owned','triaged','mitigating','monitoring')
       ORDER BY created_at DESC LIMIT 1;
    END IF;
    RETURN jsonb_build_object(
      'alreadyExisted', true,
      'measurementId', v_measurement.id,
      'sourceStatus', v_measurement.source_status,
      'sliValue', v_measurement.sli_value,
      'alertId', v_alert.id,
      'incidentId', v_incident.id,
      'alertState', v_alert.state
    );
  END IF;
  v_inserted := true;

  IF NOT v_violated THEN
    INSERT INTO public.incident_slo_audit_events (
      idempotency_key, service_id, actor_id, action, result, reason_code, trace_id, metadata
    ) VALUES (
      'measurement:' || v_measurement_key, v_service.id, v_actor_id,
      'record_measurement', 'success', 'MEASUREMENT_RECORDED', v_trace_id,
      jsonb_build_object('measurementId', v_measurement.id, 'sourceStatus', v_source_status)
    );
    RETURN jsonb_build_object(
      'alreadyExisted', false,
      'measurementId', v_measurement.id,
      'sourceStatus', v_source_status,
      'sliValue', v_sli_value,
      'alertId', null,
      'incidentId', null,
      'alertState', null
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('incident-slo-alert:' || v_alert_fingerprint, 0));
  SELECT * INTO v_alert
    FROM public.incident_slo_alerts
   WHERE fingerprint = v_alert_fingerprint;
  IF FOUND AND (v_alert.service_id <> v_service.id OR v_alert.slo_definition_id <> v_slo.id) THEN
    RAISE EXCEPTION 'INCIDENT_SLO_ALERT_FINGERPRINT_CONFLICT' USING ERRCODE = '23505';
  END IF;
  SELECT id INTO v_maintenance_id
    FROM public.incident_slo_maintenance_windows
   WHERE status IN ('scheduled','active')
     AND starts_at <= v_window_ended_at
     AND ends_at >= v_window_ended_at
     AND (service_id IS NULL OR service_id = v_service.id)
   ORDER BY service_id NULLS LAST, starts_at DESC
   LIMIT 1;

  INSERT INTO public.incident_slo_alerts (
    service_id, slo_definition_id, latest_measurement_id, maintenance_window_id,
    fingerprint, state, severity, summary, evidence,
    first_observed_at, last_observed_at
  ) VALUES (
    v_service.id, v_slo.id, v_measurement.id, v_maintenance_id,
    v_alert_fingerprint, CASE WHEN v_maintenance_id IS NULL THEN 'open' ELSE 'suppressed' END,
    v_alert_severity, v_alert_summary,
    jsonb_build_object('measurementId', v_measurement.id, 'sourceReference', v_source_reference),
    v_window_ended_at, v_window_ended_at
  )
  ON CONFLICT (fingerprint) DO UPDATE SET
    latest_measurement_id = EXCLUDED.latest_measurement_id,
    maintenance_window_id = EXCLUDED.maintenance_window_id,
    incident_id = CASE
      WHEN EXCLUDED.state = 'suppressed' THEN NULL
      ELSE public.incident_slo_alerts.incident_id
    END,
    state = EXCLUDED.state,
    severity = EXCLUDED.severity,
    summary = EXCLUDED.summary,
    occurrence_count = public.incident_slo_alerts.occurrence_count + 1,
    last_observed_at = EXCLUDED.last_observed_at,
    resolved_at = NULL,
    evidence = EXCLUDED.evidence,
    updated_at = now()
  RETURNING * INTO v_alert;

  IF v_maintenance_id IS NOT NULL THEN
    INSERT INTO public.incident_slo_audit_events (
      idempotency_key, service_id, actor_id, action, result, reason_code, trace_id, metadata
    ) VALUES (
      'suppressed:' || v_measurement_key, v_service.id, v_actor_id,
      'deduplicate_alert', 'suppressed', 'ACTIVE_MAINTENANCE_WINDOW', v_trace_id,
      jsonb_build_object('measurementId', v_measurement.id, 'alertId', v_alert.id, 'maintenanceWindowId', v_maintenance_id)
    );
    RETURN jsonb_build_object(
      'alreadyExisted', false,
      'measurementId', v_measurement.id,
      'sourceStatus', v_source_status,
      'sliValue', v_sli_value,
      'alertId', v_alert.id,
      'incidentId', null,
      'alertState', 'suppressed'
    );
  END IF;

  SELECT * INTO v_incident
    FROM public.incident_slo_incidents
   WHERE fingerprint = v_alert_fingerprint
     AND status IN ('open','owned','triaged','mitigating','monitoring')
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.incident_slo_incidents (
      service_id, fingerprint, severity, title,
      first_observed_at, last_observed_at, postmortem_required
    ) VALUES (
      v_service.id, v_alert_fingerprint, v_alert_severity, v_alert_summary,
      v_window_ended_at, v_window_ended_at, v_alert_severity IN ('P0','P1')
    ) RETURNING * INTO v_incident;
  ELSE
    UPDATE public.incident_slo_incidents
       SET severity = CASE
           WHEN array_position(ARRAY['P0','P1','P2','P3'], v_alert_severity)
                < array_position(ARRAY['P0','P1','P2','P3'], severity) THEN v_alert_severity
           ELSE severity END,
           last_observed_at = greatest(last_observed_at, v_window_ended_at),
           updated_at = now()
     WHERE id = v_incident.id
     RETURNING * INTO v_incident;
  END IF;

  UPDATE public.incident_slo_alerts
     SET incident_id = v_incident.id, updated_at = now()
   WHERE id = v_alert.id;

  INSERT INTO public.incident_slo_incident_events (
    incident_id, idempotency_key, event_type, to_status, actor_id, trace_id, summary, metadata
  ) VALUES (
    v_incident.id, 'observation:' || v_measurement_key,
    CASE WHEN v_incident.first_observed_at = v_window_ended_at THEN 'created' ELSE 'deduplicated' END,
    v_incident.status, v_actor_id, v_trace_id, v_alert_summary,
    jsonb_build_object('measurementId', v_measurement.id, 'alertId', v_alert.id, 'occurrenceCount', v_alert.occurrence_count)
  ) ON CONFLICT (incident_id, idempotency_key) DO NOTHING;

  INSERT INTO public.incident_slo_audit_events (
    idempotency_key, service_id, incident_id, actor_id, action, result, reason_code, trace_id, metadata
  ) VALUES (
    'observation:' || v_measurement_key, v_service.id, v_incident.id, v_actor_id,
    'deduplicate_alert', CASE WHEN v_alert.occurrence_count > 1 THEN 'deduplicated' ELSE 'success' END,
    CASE WHEN v_alert.occurrence_count > 1 THEN 'ALERT_FINGERPRINT_MATCHED' ELSE 'INCIDENT_CREATED' END,
    v_trace_id, jsonb_build_object('measurementId', v_measurement.id, 'alertId', v_alert.id)
  );

  RETURN jsonb_build_object(
    'alreadyExisted', NOT v_inserted,
    'measurementId', v_measurement.id,
    'sourceStatus', v_source_status,
    'sliValue', v_sli_value,
    'alertId', v_alert.id,
    'incidentId', v_incident.id,
    'alertState', 'open',
    'occurrenceCount', v_alert.occurrence_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_incident_slo_incident_cas(
  p_incident_id uuid,
  p_actor_id text,
  p_expected_revision integer,
  p_lease_seconds integer,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.incident_slo_incidents%ROWTYPE;
  v_event_id uuid;
BEGIN
  IF p_actor_id IS NULL OR btrim(p_actor_id) = '' OR char_length(p_actor_id) > 200
     OR p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 8 AND 200
     OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'INCIDENT_SLO_CLAIM_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_event_id FROM public.incident_slo_incident_events
   WHERE incident_id = p_incident_id AND idempotency_key = 'claim:' || p_request_key;
  IF FOUND THEN
    SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id;
    RETURN jsonb_build_object('alreadyExisted', true, 'incidentId', v_incident.id, 'status', v_incident.status,
      'revision', v_incident.revision, 'ownerActorId', v_incident.owner_actor_id,
      'leaseToken', v_incident.lease_token, 'leaseUntil', v_incident.lease_until);
  END IF;

  SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_SLO_INCIDENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_incident.status NOT IN ('open','owned','triaged','mitigating','monitoring') THEN
    RAISE EXCEPTION 'INCIDENT_SLO_INCIDENT_CLOSED' USING ERRCODE = '55000';
  END IF;
  IF v_incident.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'INCIDENT_SLO_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_incident.lease_until > now() AND v_incident.owner_actor_id IS DISTINCT FROM btrim(p_actor_id) THEN
    RAISE EXCEPTION 'INCIDENT_SLO_LEASE_HELD' USING ERRCODE = '55P03';
  END IF;

  UPDATE public.incident_slo_incidents
     SET status = CASE WHEN status = 'open' THEN 'owned' ELSE status END,
         owner_actor_id = btrim(p_actor_id), lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => p_lease_seconds),
         revision = revision + 1, updated_at = now()
   WHERE id = p_incident_id
   RETURNING * INTO v_incident;

  INSERT INTO public.incident_slo_incident_events (
    incident_id, idempotency_key, event_type, from_status, to_status, actor_id, summary, metadata
  ) VALUES (
    v_incident.id, 'claim:' || p_request_key, 'claimed', NULL, v_incident.status,
    btrim(p_actor_id), 'Incident ownership lease acquired',
    jsonb_build_object('revision', v_incident.revision, 'leaseUntil', v_incident.lease_until)
  );
  INSERT INTO public.incident_slo_audit_events (
    idempotency_key, service_id, incident_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    'claim:' || p_incident_id::text || ':' || p_request_key, v_incident.service_id, v_incident.id,
    btrim(p_actor_id), 'claim_incident', 'success', 'INCIDENT_LEASE_ACQUIRED',
    jsonb_build_object('revision', v_incident.revision)
  );
  RETURN jsonb_build_object('alreadyExisted', false, 'incidentId', v_incident.id, 'status', v_incident.status,
    'revision', v_incident.revision, 'ownerActorId', v_incident.owner_actor_id,
    'leaseToken', v_incident.lease_token, 'leaseUntil', v_incident.lease_until);
END;
$$;

CREATE OR REPLACE FUNCTION public.request_incident_slo_recovery_probe(
  p_incident_id uuid,
  p_actor_id text,
  p_lease_token uuid,
  p_expected_revision integer,
  p_probe_key text,
  p_probe_kind text,
  p_request_key text,
  p_parameters jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.incident_slo_incidents%ROWTYPE;
  v_probe public.incident_slo_recovery_probes%ROWTYPE;
BEGIN
  IF p_probe_kind NOT IN ('read_only_health','read_only_consistency','worker_heartbeat','external_dependency_read')
     OR char_length(coalesce(p_probe_key,'')) NOT BETWEEN 8 AND 200
     OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR jsonb_typeof(coalesce(p_parameters, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'INCIDENT_SLO_PROBE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_probe FROM public.incident_slo_recovery_probes WHERE request_idempotency_key = p_request_key;
  IF FOUND THEN
    IF v_probe.incident_id <> p_incident_id OR v_probe.probe_key <> p_probe_key OR v_probe.probe_kind <> p_probe_kind THEN
      RAISE EXCEPTION 'INCIDENT_SLO_PROBE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('alreadyExisted', true, 'probeId', v_probe.id, 'status', v_probe.status,
      'executionEnabled', false);
  END IF;
  SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_SLO_INCIDENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_incident.revision <> p_expected_revision THEN RAISE EXCEPTION 'INCIDENT_SLO_REVISION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF v_incident.owner_actor_id IS DISTINCT FROM btrim(p_actor_id)
     OR v_incident.lease_token IS DISTINCT FROM p_lease_token OR v_incident.lease_until <= now() THEN
    RAISE EXCEPTION 'INCIDENT_SLO_LEASE_INVALID' USING ERRCODE = '55P03';
  END IF;
  INSERT INTO public.incident_slo_recovery_probes (
    incident_id, probe_key, probe_kind, requested_by, request_idempotency_key, parameters
  ) VALUES (
    p_incident_id, p_probe_key, p_probe_kind, btrim(p_actor_id), p_request_key, coalesce(p_parameters, '{}'::jsonb)
  ) RETURNING * INTO v_probe;
  INSERT INTO public.incident_slo_incident_events (
    incident_id, idempotency_key, event_type, to_status, actor_id, summary, metadata
  ) VALUES (
    p_incident_id, 'probe-request:' || p_request_key, 'probe_requested', v_incident.status,
    btrim(p_actor_id), 'Read-only recovery probe requested',
    jsonb_build_object('probeId', v_probe.id, 'probeKind', p_probe_kind, 'executionEnabled', false)
  );
  INSERT INTO public.incident_slo_audit_events (
    idempotency_key, service_id, incident_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    'probe-request:' || p_request_key, v_incident.service_id, p_incident_id, btrim(p_actor_id),
    'request_recovery_probe', 'success', 'RECOVERY_PROBE_REGISTERED',
    jsonb_build_object('probeId', v_probe.id, 'executionEnabled', false)
  );
  RETURN jsonb_build_object('alreadyExisted', false, 'probeId', v_probe.id, 'status', v_probe.status,
    'executionEnabled', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_incident_slo_recovery_probe_result_cas(
  p_incident_id uuid,
  p_probe_id uuid,
  p_actor_id text,
  p_lease_token uuid,
  p_expected_revision integer,
  p_result_status text,
  p_request_key text,
  p_summary text,
  p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.incident_slo_incidents%ROWTYPE;
  v_probe public.incident_slo_recovery_probes%ROWTYPE;
BEGIN
  IF p_result_status NOT IN ('passed','failed') OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'INCIDENT_SLO_PROBE_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_probe FROM public.incident_slo_recovery_probes WHERE id = p_probe_id FOR UPDATE;
  IF NOT FOUND OR v_probe.incident_id <> p_incident_id THEN RAISE EXCEPTION 'INCIDENT_SLO_PROBE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_probe.result_request_key = p_request_key THEN
    RETURN jsonb_build_object('alreadyExisted', true, 'probeId', v_probe.id, 'status', v_probe.status);
  END IF;
  IF v_probe.result_request_key IS NOT NULL THEN
    RAISE EXCEPTION 'INCIDENT_SLO_PROBE_ALREADY_SETTLED' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id FOR UPDATE;
  IF v_incident.revision <> p_expected_revision THEN RAISE EXCEPTION 'INCIDENT_SLO_REVISION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF v_incident.owner_actor_id IS DISTINCT FROM btrim(p_actor_id)
     OR v_incident.lease_token IS DISTINCT FROM p_lease_token OR v_incident.lease_until <= now() THEN
    RAISE EXCEPTION 'INCIDENT_SLO_LEASE_INVALID' USING ERRCODE = '55P03';
  END IF;
  UPDATE public.incident_slo_recovery_probes
     SET status = p_result_status, result_request_key = p_request_key,
         result_summary = left(nullif(btrim(coalesce(p_summary,'')),''), 1000),
         evidence = coalesce(p_evidence, '{}'::jsonb), completed_at = now(), updated_at = now()
   WHERE id = p_probe_id RETURNING * INTO v_probe;
  UPDATE public.incident_slo_incidents SET revision = revision + 1, updated_at = now()
   WHERE id = p_incident_id RETURNING * INTO v_incident;
  INSERT INTO public.incident_slo_incident_events (
    incident_id, idempotency_key, event_type, to_status, actor_id, summary, metadata
  ) VALUES (
    p_incident_id, 'probe-result:' || p_request_key, 'probe_result', v_incident.status,
    btrim(p_actor_id), v_probe.result_summary,
    jsonb_build_object('probeId', v_probe.id, 'result', v_probe.status, 'revision', v_incident.revision)
  );
  INSERT INTO public.incident_slo_audit_events (
    idempotency_key, service_id, incident_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    'probe-result:' || p_request_key, v_incident.service_id, p_incident_id, btrim(p_actor_id),
    'record_recovery_probe_result', 'success', 'RECOVERY_PROBE_RESULT_RECORDED',
    jsonb_build_object('probeId', v_probe.id, 'result', v_probe.status, 'revision', v_incident.revision)
  );
  RETURN jsonb_build_object('alreadyExisted', false, 'probeId', v_probe.id, 'status', v_probe.status,
    'incidentRevision', v_incident.revision);
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_incident_slo_incident_cas(
  p_incident_id uuid,
  p_actor_id text,
  p_lease_token uuid,
  p_expected_revision integer,
  p_target_status text,
  p_request_key text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.incident_slo_incidents%ROWTYPE;
  v_from_status text;
  v_passed_probe boolean;
BEGIN
  IF p_target_status NOT IN ('triaged','mitigating','monitoring','resolved','false_positive')
     OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'INCIDENT_SLO_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.incident_slo_incident_events WHERE incident_id = p_incident_id AND idempotency_key = 'transition:' || p_request_key) THEN
    SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id;
    RETURN jsonb_build_object('alreadyExisted', true, 'incidentId', v_incident.id,
      'status', v_incident.status, 'revision', v_incident.revision);
  END IF;
  SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_SLO_INCIDENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_incident.revision <> p_expected_revision THEN RAISE EXCEPTION 'INCIDENT_SLO_REVISION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF v_incident.owner_actor_id IS DISTINCT FROM btrim(p_actor_id)
     OR v_incident.lease_token IS DISTINCT FROM p_lease_token OR v_incident.lease_until <= now() THEN
    RAISE EXCEPTION 'INCIDENT_SLO_LEASE_INVALID' USING ERRCODE = '55P03';
  END IF;
  IF v_incident.status IN ('resolved','false_positive') THEN RAISE EXCEPTION 'INCIDENT_SLO_INCIDENT_CLOSED' USING ERRCODE = '55000'; END IF;
  IF p_target_status = 'resolved' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.incident_slo_recovery_probes
       WHERE incident_id = p_incident_id AND status = 'passed'
    ) INTO v_passed_probe;
    IF NOT v_passed_probe THEN RAISE EXCEPTION 'INCIDENT_SLO_RECOVERY_PROBE_REQUIRED' USING ERRCODE = '55000'; END IF;
  END IF;
  v_from_status := v_incident.status;
  UPDATE public.incident_slo_incidents
     SET status = p_target_status, revision = revision + 1,
         resolved_at = CASE WHEN p_target_status IN ('resolved','false_positive') THEN now() ELSE NULL END,
         resolution_note = CASE WHEN p_target_status IN ('resolved','false_positive') THEN left(nullif(btrim(coalesce(p_note,'')),''), 1000) ELSE resolution_note END,
         lease_token = CASE WHEN p_target_status IN ('resolved','false_positive') THEN NULL ELSE lease_token END,
         lease_until = CASE WHEN p_target_status IN ('resolved','false_positive') THEN NULL ELSE lease_until END,
         updated_at = now()
   WHERE id = p_incident_id RETURNING * INTO v_incident;
  IF p_target_status IN ('resolved','false_positive') THEN
    UPDATE public.incident_slo_alerts SET state = 'resolved', resolved_at = now(), updated_at = now()
     WHERE incident_id = p_incident_id;
  END IF;
  INSERT INTO public.incident_slo_incident_events (
    incident_id, idempotency_key, event_type, from_status, to_status, actor_id, summary, metadata
  ) VALUES (
    p_incident_id, 'transition:' || p_request_key, 'state_changed', v_from_status, p_target_status,
    btrim(p_actor_id), left(nullif(btrim(coalesce(p_note,'')),''), 1000), jsonb_build_object('revision', v_incident.revision)
  );
  INSERT INTO public.incident_slo_audit_events (
    idempotency_key, service_id, incident_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    'transition:' || p_request_key, v_incident.service_id, p_incident_id, btrim(p_actor_id),
    'transition_incident', 'success', 'INCIDENT_STATE_CHANGED',
    jsonb_build_object('fromStatus', v_from_status, 'toStatus', p_target_status, 'revision', v_incident.revision)
  );
  RETURN jsonb_build_object('alreadyExisted', false, 'incidentId', v_incident.id,
    'status', v_incident.status, 'revision', v_incident.revision);
END;
$$;

CREATE OR REPLACE FUNCTION public.register_incident_slo_action_request(
  p_incident_id uuid,
  p_actor_id text,
  p_lease_token uuid,
  p_expected_revision integer,
  p_mode text,
  p_action_kind text,
  p_request_key text,
  p_parameters jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.incident_slo_incidents%ROWTYPE;
  v_action public.incident_slo_action_requests%ROWTYPE;
BEGIN
  IF p_mode NOT IN ('preview','request')
     OR p_action_kind NOT IN ('read_only_probe','resume_side_effect_free_polling','pause_confirmed_fault_channel')
     OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR jsonb_typeof(coalesce(p_parameters, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'INCIDENT_SLO_ACTION_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_action FROM public.incident_slo_action_requests WHERE idempotency_key = p_request_key;
  IF FOUND THEN
    IF v_action.incident_id <> p_incident_id OR v_action.mode <> p_mode OR v_action.action_kind <> p_action_kind
       OR v_action.parameters IS DISTINCT FROM coalesce(p_parameters, '{}'::jsonb) THEN
      RAISE EXCEPTION 'INCIDENT_SLO_ACTION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('alreadyExisted', true, 'actionRequestId', v_action.id,
      'mode', v_action.mode, 'status', v_action.status, 'executionEnabled', false,
      'paidOperation', false, 'serviceRestart', false);
  END IF;
  SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_SLO_INCIDENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_incident.revision <> p_expected_revision THEN RAISE EXCEPTION 'INCIDENT_SLO_REVISION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF v_incident.owner_actor_id IS DISTINCT FROM btrim(p_actor_id)
     OR v_incident.lease_token IS DISTINCT FROM p_lease_token OR v_incident.lease_until <= now() THEN
    RAISE EXCEPTION 'INCIDENT_SLO_LEASE_INVALID' USING ERRCODE = '55P03';
  END IF;
  INSERT INTO public.incident_slo_action_requests (
    incident_id, idempotency_key, mode, action_kind, status, requested_by, parameters
  ) VALUES (
    p_incident_id, p_request_key, p_mode, p_action_kind,
    CASE WHEN p_mode = 'preview' THEN 'previewed' ELSE 'requested' END,
    btrim(p_actor_id), coalesce(p_parameters, '{}'::jsonb)
  ) RETURNING * INTO v_action;
  INSERT INTO public.incident_slo_incident_events (
    incident_id, idempotency_key, event_type, to_status, actor_id, summary, metadata
  ) VALUES (
    p_incident_id, 'action:' || p_request_key,
    CASE WHEN p_mode = 'preview' THEN 'action_previewed' ELSE 'action_requested' END,
    v_incident.status, btrim(p_actor_id), 'Control-plane action registration only',
    jsonb_build_object('actionRequestId', v_action.id, 'actionKind', p_action_kind,
      'executionEnabled', false, 'paidOperation', false, 'serviceRestart', false)
  );
  INSERT INTO public.incident_slo_audit_events (
    idempotency_key, service_id, incident_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    'action:' || p_request_key, v_incident.service_id, p_incident_id, btrim(p_actor_id),
    'register_action_request', 'success',
    CASE WHEN p_mode = 'preview' THEN 'ACTION_PREVIEW_REGISTERED' ELSE 'ACTION_REQUEST_REGISTERED' END,
    jsonb_build_object('actionRequestId', v_action.id, 'executionEnabled', false,
      'paidOperation', false, 'serviceRestart', false)
  );
  RETURN jsonb_build_object('alreadyExisted', false, 'actionRequestId', v_action.id,
    'mode', v_action.mode, 'status', v_action.status, 'executionEnabled', false,
    'paidOperation', false, 'serviceRestart', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.link_incident_slo_postmortem_cas(
  p_incident_id uuid,
  p_actor_id text,
  p_expected_revision integer,
  p_request_key text,
  p_status text,
  p_summary text DEFAULT NULL,
  p_root_cause jsonb DEFAULT '{}'::jsonb,
  p_action_items jsonb DEFAULT '[]'::jsonb,
  p_external_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.incident_slo_incidents%ROWTYPE;
  v_postmortem public.incident_slo_postmortems%ROWTYPE;
BEGIN
  IF p_status NOT IN ('draft','in_review','published','waived')
     OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR jsonb_typeof(coalesce(p_root_cause, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(coalesce(p_action_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'INCIDENT_SLO_POSTMORTEM_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_postmortem FROM public.incident_slo_postmortems WHERE last_request_key = p_request_key;
  IF FOUND THEN
    IF v_postmortem.incident_id <> p_incident_id THEN RAISE EXCEPTION 'INCIDENT_SLO_POSTMORTEM_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('alreadyExisted', true, 'postmortemId', v_postmortem.id,
      'status', v_postmortem.status, 'incidentId', v_postmortem.incident_id);
  END IF;
  SELECT * INTO v_incident FROM public.incident_slo_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_SLO_INCIDENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_incident.revision <> p_expected_revision THEN RAISE EXCEPTION 'INCIDENT_SLO_REVISION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF v_incident.owner_actor_id IS DISTINCT FROM btrim(p_actor_id) THEN
    RAISE EXCEPTION 'INCIDENT_SLO_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.incident_slo_postmortems (
    incident_id, status, owner_actor_id, summary, root_cause, action_items, external_reference, last_request_key
  ) VALUES (
    p_incident_id, p_status, btrim(p_actor_id), left(p_summary, 4000),
    coalesce(p_root_cause, '{}'::jsonb), coalesce(p_action_items, '[]'::jsonb),
    left(p_external_reference, 1000), p_request_key
  )
  ON CONFLICT (incident_id) DO UPDATE SET
    status = EXCLUDED.status, owner_actor_id = EXCLUDED.owner_actor_id,
    summary = EXCLUDED.summary, root_cause = EXCLUDED.root_cause,
    action_items = EXCLUDED.action_items, external_reference = EXCLUDED.external_reference,
    last_request_key = EXCLUDED.last_request_key, updated_at = now()
  RETURNING * INTO v_postmortem;
  UPDATE public.incident_slo_incidents SET revision = revision + 1, updated_at = now()
   WHERE id = p_incident_id RETURNING * INTO v_incident;
  INSERT INTO public.incident_slo_incident_events (
    incident_id, idempotency_key, event_type, to_status, actor_id, summary, metadata
  ) VALUES (
    p_incident_id, 'postmortem:' || p_request_key, 'postmortem_linked', v_incident.status,
    btrim(p_actor_id), 'Postmortem linked',
    jsonb_build_object('postmortemId', v_postmortem.id, 'postmortemStatus', v_postmortem.status,
      'revision', v_incident.revision)
  );
  INSERT INTO public.incident_slo_audit_events (
    idempotency_key, service_id, incident_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    'postmortem:' || p_request_key, v_incident.service_id, p_incident_id, btrim(p_actor_id),
    'link_postmortem', 'success', 'POSTMORTEM_LINKED',
    jsonb_build_object('postmortemId', v_postmortem.id, 'revision', v_incident.revision)
  );
  RETURN jsonb_build_object('alreadyExisted', false, 'postmortemId', v_postmortem.id,
    'status', v_postmortem.status, 'incidentId', v_postmortem.incident_id,
    'incidentRevision', v_incident.revision);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_incident_slo_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_definitions jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY rows."serviceKey", rows."sloKey"), '[]'::jsonb)
    INTO v_definitions
    FROM (
      SELECT
        s.service_key AS "serviceKey",
        d.slo_key AS "sloKey",
        d.indicator_kind AS "indicatorKind",
        d.objective_ratio AS "objectiveRatio",
        d.objective_window_seconds AS "objectiveWindowSeconds",
        coalesce(m.source_status, 'unavailable') AS "sourceStatus",
        m.sli_value AS "value",
        m.source_as_of AS "asOf",
        m.freshness_seconds AS "freshnessSeconds",
        m.coverage_ratio AS "coverageRatio",
        (m.source_status = 'partial') AS "partial",
        m.id AS "measurementId"
      FROM public.incident_slo_definitions d
      JOIN public.incident_slo_services s ON s.id = d.service_id
      LEFT JOIN LATERAL (
        SELECT x.id, x.source_status, x.sli_value, x.source_as_of, x.freshness_seconds, x.coverage_ratio
          FROM public.incident_slo_measurements x
         WHERE x.slo_definition_id = d.id
         ORDER BY x.window_ended_at DESC, x.created_at DESC
         LIMIT 1
      ) m ON true
      WHERE s.status = 'active' AND d.status = 'active'
      ORDER BY s.service_key, d.slo_key
      LIMIT 200
    ) rows;
  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'migration', '20261002170000',
    'asOf', clock_timestamp(),
    'tableCounts', jsonb_build_object(
      'services', (SELECT count(*) FROM public.incident_slo_services),
      'definitions', (SELECT count(*) FROM public.incident_slo_definitions),
      'measurements', (SELECT count(*) FROM public.incident_slo_measurements),
      'alerts', (SELECT count(*) FROM public.incident_slo_alerts),
      'incidents', (SELECT count(*) FROM public.incident_slo_incidents),
      'incidentEvents', (SELECT count(*) FROM public.incident_slo_incident_events),
      'maintenanceWindows', (SELECT count(*) FROM public.incident_slo_maintenance_windows),
      'recoveryProbes', (SELECT count(*) FROM public.incident_slo_recovery_probes),
      'postmortems', (SELECT count(*) FROM public.incident_slo_postmortems),
      'actionRequests', (SELECT count(*) FROM public.incident_slo_action_requests),
      'auditEvents', (SELECT count(*) FROM public.incident_slo_audit_events)
    ),
    'measurements', jsonb_build_object(
      'available', (SELECT count(*) FROM public.incident_slo_measurements WHERE source_status = 'available'),
      'partial', (SELECT count(*) FROM public.incident_slo_measurements WHERE source_status = 'partial'),
      'unavailable', (SELECT count(*) FROM public.incident_slo_measurements WHERE source_status = 'unavailable')
    ),
    'alerts', jsonb_build_object(
      'open', (SELECT count(*) FROM public.incident_slo_alerts WHERE state = 'open'),
      'acknowledged', (SELECT count(*) FROM public.incident_slo_alerts WHERE state = 'acknowledged'),
      'suppressed', (SELECT count(*) FROM public.incident_slo_alerts WHERE state = 'suppressed'),
      'resolved', (SELECT count(*) FROM public.incident_slo_alerts WHERE state = 'resolved')
    ),
    'incidents', jsonb_build_object(
      'active', (SELECT count(*) FROM public.incident_slo_incidents WHERE status IN ('open','owned','triaged','mitigating','monitoring')),
      'resolved', (SELECT count(*) FROM public.incident_slo_incidents WHERE status = 'resolved'),
      'falsePositive', (SELECT count(*) FROM public.incident_slo_incidents WHERE status = 'false_positive'),
      'leased', (SELECT count(*) FROM public.incident_slo_incidents WHERE lease_until > now())
    ),
    'actions', jsonb_build_object(
      'previewed', (SELECT count(*) FROM public.incident_slo_action_requests WHERE status = 'previewed'),
      'requested', (SELECT count(*) FROM public.incident_slo_action_requests WHERE status = 'requested'),
      'executorAvailable', false,
      'paidExecutionEnabled', false,
      'serviceRestartEnabled', false,
      'productionRemediationEnabled', false
    ),
    'definitions', v_definitions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reject_incident_slo_immutable_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_incident_slo_observation_atomic(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_incident_slo_incident_cas(uuid,text,integer,integer,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.request_incident_slo_recovery_probe(uuid,text,uuid,integer,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_incident_slo_recovery_probe_result_cas(uuid,uuid,text,uuid,integer,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.transition_incident_slo_incident_cas(uuid,text,uuid,integer,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_incident_slo_action_request(uuid,text,uuid,integer,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_incident_slo_postmortem_cas(uuid,text,integer,text,text,text,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_incident_slo_status() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.record_incident_slo_observation_atomic(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_incident_slo_incident_cas(uuid,text,integer,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_incident_slo_recovery_probe(uuid,text,uuid,integer,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_incident_slo_recovery_probe_result_cas(uuid,uuid,text,uuid,integer,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_incident_slo_incident_cas(uuid,text,uuid,integer,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_incident_slo_action_request(uuid,text,uuid,integer,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_incident_slo_postmortem_cas(uuid,text,integer,text,text,text,jsonb,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_incident_slo_status() TO service_role;

COMMIT;
