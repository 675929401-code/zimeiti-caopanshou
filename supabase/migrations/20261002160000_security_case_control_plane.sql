BEGIN;

-- Security-case control plane, phase 1.
-- This migration deliberately has no executor that updates users or sessions.
-- It can aggregate evidence, transition/claim cases, preview impacts in the
-- application layer, and persist allowlisted requests as pending_executor.

CREATE OR REPLACE FUNCTION public.security_case_risk_level(p_score integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_score >= 85 THEN 'critical'
    WHEN p_score >= 60 THEN 'high'
    WHEN p_score >= 30 THEN 'medium'
    ELSE 'low'
  END;
$$;

CREATE OR REPLACE FUNCTION public.security_case_text_is_safe(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(p_value, '') !~ '[[:cntrl:]]'
    AND coalesce(p_value, '') !~* '(password|passwd|authorization|bearer[[:space:]]|api[_-]?key|secret[[:space:]]*[:=]|postgres(ql)?://|mysql://|redis://|[?&](token|signature|x-amz-[^=]*)=)';
$$;

CREATE OR REPLACE FUNCTION public.security_case_evidence_is_safe(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof(p_value) = 'object'
    AND p_value - ARRAY[
      'sourceLabel', 'sourceTable', 'path', 'method', 'blocked',
      'traceId', 'errorCode', 'agentName', 'status'
    ] = '{}'::jsonb
    AND p_value::text !~* '"(?:password|passwd|pwd|token|secret|authorization|cookie|connectionString|signedUrl|rawData|fullMessage|messagePreview)"';
$$;

CREATE OR REPLACE FUNCTION public.security_case_impact_is_safe(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof(p_value) = 'object'
    AND p_value - ARRAY[
      'schema', 'actionType', 'targetType', 'targetRef', 'targetExists',
      'currentState', 'affectedRowsMax', 'reversible', 'executionSupported',
      'executorStatus', 'notes'
    ] = '{}'::jsonb
    AND p_value->>'schema' = 'security-case-impact/v1'
    AND jsonb_typeof(p_value->'targetExists') = 'boolean'
    AND jsonb_typeof(p_value->'affectedRowsMax') = 'number'
    AND (p_value->>'affectedRowsMax')::integer BETWEEN 1 AND 10000
    AND p_value->>'reversible' = 'true'
    AND p_value->>'executionSupported' = 'false'
    AND p_value->>'executorStatus' = 'unavailable'
    AND jsonb_typeof(p_value->'notes') = 'array'
    AND jsonb_array_length(p_value->'notes') BETWEEN 1 AND 8
    AND p_value::text !~* '"(?:password|passwd|pwd|token|secret|authorization|cookie|connectionString|signedUrl|rawData)"';
$$;

CREATE TABLE IF NOT EXISTS public.security_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160 AND public.security_case_text_is_safe(title)),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 500 AND public.security_case_text_is_safe(summary)),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  risk_score integer NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'triaged', 'assigned', 'mitigating', 'monitoring', 'resolved', 'false_positive'
  )),
  assigned_to text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen_at >= first_seen_at),
  CHECK (
    (status IN ('resolved', 'false_positive') AND closed_at IS NOT NULL)
    OR (status NOT IN ('resolved', 'false_positive') AND closed_at IS NULL)
  ),
  CHECK (status <> 'assigned' OR assigned_to IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS security_cases_active_fingerprint_unique
  ON public.security_cases (fingerprint)
  WHERE status NOT IN ('resolved', 'false_positive');
CREATE INDEX IF NOT EXISTS security_cases_queue_idx
  ON public.security_cases (status, risk_score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS security_cases_assignee_idx
  ON public.security_cases (assigned_to, status, updated_at DESC)
  WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.security_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.security_cases(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN (
    'security_event', 'prompt_guard_log', 'login_log', 'operation_flight_event'
  )),
  source_event_id text NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 200),
  event_fingerprint text NOT NULL CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 120),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  risk_score integer NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 500 AND public.security_case_text_is_safe(summary)),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (public.security_case_evidence_is_safe(evidence)),
  occurred_at timestamptz NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by text,
  UNIQUE (source_kind, source_event_id)
);

CREATE INDEX IF NOT EXISTS security_case_events_case_idx
  ON public.security_case_events (case_id, occurred_at DESC, linked_at DESC);
CREATE INDEX IF NOT EXISTS security_case_events_fingerprint_idx
  ON public.security_case_events (event_fingerprint, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.security_case_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.security_cases(id) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type IN (
    'user', 'session', 'ip_hash', 'route', 'trace', 'credential', 'channel'
  )),
  entity_ref text NOT NULL CHECK (
    char_length(entity_ref) BETWEEN 1 AND 200
    AND entity_ref !~ '[[:cntrl:]]'
  ),
  entity_label text NOT NULL DEFAULT '' CHECK (char_length(entity_label) <= 120 AND public.security_case_text_is_safe(entity_label)),
  linked_by text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, entity_type, entity_ref)
);

CREATE INDEX IF NOT EXISTS security_case_links_entity_idx
  ON public.security_case_links (entity_type, entity_ref, linked_at DESC);

CREATE TABLE IF NOT EXISTS public.security_case_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.security_cases(id) ON DELETE RESTRICT,
  action_type text NOT NULL CHECK (action_type IN ('revoke_session', 'disable_user')),
  target_type text NOT NULL CHECK (target_type IN ('session', 'user')),
  target_ref text NOT NULL CHECK (
    char_length(target_ref) BETWEEN 1 AND 200
    AND target_ref !~ '[[:cntrl:]]'
  ),
  status text NOT NULL DEFAULT 'pending_executor' CHECK (status IN (
    'pending_executor', 'executing', 'succeeded', 'failed', 'cancelled'
  )),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  execution_supported boolean NOT NULL DEFAULT false CHECK (execution_supported = false),
  executor_key text,
  impact_preview jsonb NOT NULL CHECK (public.security_case_impact_is_safe(impact_preview)),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500 AND public.security_case_text_is_safe(reason)),
  requested_by text NOT NULL,
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by text,
  cancelled_at timestamptz,
  cancellation_reason text,
  executed_at timestamptz,
  result_code text,
  result_summary text,
  CHECK (
    (action_type = 'revoke_session' AND target_type = 'session')
    OR (action_type = 'disable_user' AND target_type = 'user')
  ),
  CHECK (
    (status = 'cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
    OR (status <> 'cancelled' AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
  ),
  CHECK (status NOT IN ('succeeded', 'failed') AND executed_at IS NULL AND result_code IS NULL AND result_summary IS NULL),
  UNIQUE (requested_by, request_key)
);

CREATE INDEX IF NOT EXISTS security_case_actions_case_idx
  ON public.security_case_actions (case_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS security_case_actions_pending_idx
  ON public.security_case_actions (status, requested_at ASC)
  WHERE status = 'pending_executor';

CREATE TABLE IF NOT EXISTS public.security_case_audit (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES public.security_cases(id) ON DELETE RESTRICT,
  action_id uuid REFERENCES public.security_case_actions(id) ON DELETE RESTRICT,
  actor_id text,
  event_type text NOT NULL CHECK (event_type IN (
    'case_created', 'event_linked', 'entity_linked', 'case_transitioned',
    'case_claimed', 'action_requested', 'action_cancelled'
  )),
  from_status text,
  to_status text,
  reason_code text NOT NULL DEFAULT '' CHECK (char_length(reason_code) <= 120),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500 AND public.security_case_text_is_safe(reason)),
  request_key text NOT NULL DEFAULT '' CHECK (char_length(request_key) <= 200),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(details) = 'object'
    AND details::text !~* '"(?:password|passwd|pwd|token|secret|authorization|cookie|connectionString|signedUrl|rawData|fullMessage)"'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_case_audit_case_idx
  ON public.security_case_audit (case_id, created_at DESC, id DESC);

ALTER TABLE public.security_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_case_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_case_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_case_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.security_cases FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.security_case_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.security_case_links FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.security_case_actions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.security_case_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.security_cases TO service_role;
GRANT SELECT ON public.security_case_events TO service_role;
GRANT SELECT ON public.security_case_links TO service_role;
GRANT SELECT ON public.security_case_actions TO service_role;
GRANT SELECT ON public.security_case_audit TO service_role;
REVOKE ALL ON SEQUENCE public.security_case_audit_id_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_security_case_record_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_DELETE_FORBIDDEN';
  END IF;
  IF current_setting('app.security_case_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SECURITY_CASE_DIRECT_WRITE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_security_case_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_EVIDENCE_IMMUTABLE';
  END IF;
  IF current_setting('app.security_case_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SECURITY_CASE_DIRECT_WRITE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_security_case_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_AUDIT_IMMUTABLE';
  END IF;
  IF current_setting('app.security_case_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SECURITY_CASE_DIRECT_WRITE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS security_cases_write_guard ON public.security_cases;
CREATE TRIGGER security_cases_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.security_cases
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_case_record_write();
DROP TRIGGER IF EXISTS security_case_events_write_guard ON public.security_case_events;
CREATE TRIGGER security_case_events_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.security_case_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_case_append_only();
DROP TRIGGER IF EXISTS security_case_links_write_guard ON public.security_case_links;
CREATE TRIGGER security_case_links_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.security_case_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_case_append_only();
DROP TRIGGER IF EXISTS security_case_actions_write_guard ON public.security_case_actions;
CREATE TRIGGER security_case_actions_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.security_case_actions
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_case_record_write();
DROP TRIGGER IF EXISTS security_case_audit_write_guard ON public.security_case_audit;
CREATE TRIGGER security_case_audit_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.security_case_audit
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_case_audit_immutable();

CREATE OR REPLACE FUNCTION public.ingest_security_case_event_atomic(
  p_event_fingerprint text,
  p_source_kind text,
  p_source_event_id text,
  p_event_type text,
  p_risk_level text,
  p_risk_score integer,
  p_title text,
  p_summary text,
  p_occurred_at timestamptz,
  p_actor_id text,
  p_evidence jsonb DEFAULT '{}'::jsonb,
  p_entities jsonb DEFAULT '[]'::jsonb,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.security_cases%ROWTYPE;
  v_existing_event public.security_case_events%ROWTYPE;
  v_entity jsonb;
  v_entity_type text;
  v_entity_ref text;
  v_entity_label text;
  v_created boolean := false;
  v_score integer;
  v_risk text;
  v_entity_count integer := 0;
  v_prior_write text := current_setting('app.security_case_write', true);
BEGIN
  IF p_event_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_source_kind NOT IN ('security_event', 'prompt_guard_log', 'login_log', 'operation_flight_event')
     OR nullif(btrim(p_source_event_id), '') IS NULL OR char_length(p_source_event_id) > 200
     OR nullif(btrim(p_event_type), '') IS NULL OR char_length(p_event_type) > 120
     OR p_risk_level NOT IN ('low', 'medium', 'high', 'critical')
     OR p_risk_score NOT BETWEEN 0 AND 100
     OR p_risk_level <> public.security_case_risk_level(p_risk_score)
     OR nullif(btrim(p_title), '') IS NULL OR char_length(p_title) > 160
     OR char_length(coalesce(p_summary, '')) > 500
     OR NOT public.security_case_text_is_safe(p_title)
     OR NOT public.security_case_text_is_safe(coalesce(p_summary, ''))
     OR p_occurred_at IS NULL OR p_actor_id IS NULL
     OR NOT public.security_case_evidence_is_safe(coalesce(p_evidence, '{}'::jsonb))
     OR jsonb_typeof(p_entities) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_entities) > 16 THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_EVENT_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('security-source:' || p_source_kind || ':' || p_source_event_id, 20261002160000));
  PERFORM pg_advisory_xact_lock(hashtextextended('security-case:' || p_event_fingerprint, 20261002160000));
  SELECT * INTO v_existing_event
    FROM public.security_case_events
   WHERE source_kind = p_source_kind AND source_event_id = p_source_event_id;
  IF FOUND THEN
    SELECT * INTO v_case FROM public.security_cases WHERE id = v_existing_event.case_id;
    RETURN jsonb_build_object(
      'success', true, 'duplicate', true, 'createdCase', false,
      'caseId', v_case.id, 'revision', v_case.revision,
      'eventCount', v_case.event_count, 'riskScore', v_case.risk_score,
      'riskLevel', v_case.risk_level, 'status', v_case.status
    );
  END IF;

  SELECT * INTO v_case
    FROM public.security_cases
   WHERE fingerprint = p_event_fingerprint
     AND status NOT IN ('resolved', 'false_positive')
   FOR UPDATE;

  IF NOT FOUND THEN
    v_score := p_risk_score;
    v_risk := public.security_case_risk_level(v_score);
    PERFORM set_config('app.security_case_write', 'on', true);
    INSERT INTO public.security_cases (
      fingerprint, title, summary, risk_level, risk_score, status,
      revision, event_count, first_seen_at, last_seen_at, created_by, updated_by
    ) VALUES (
      p_event_fingerprint, btrim(p_title), coalesce(p_summary, ''), v_risk, v_score, 'open',
      1, 1, p_occurred_at, p_occurred_at, p_actor_id, p_actor_id
    ) RETURNING * INTO v_case;
    v_created := true;
    INSERT INTO public.security_case_audit (
      case_id, actor_id, event_type, to_status, reason_code, request_key, details
    ) VALUES (
      v_case.id, p_actor_id, 'case_created', 'open', 'EVENT_FINGERPRINT_NEW',
      left(coalesce(p_request_key, ''), 200),
      jsonb_build_object('sourceKind', p_source_kind, 'eventType', p_event_type)
    );
  ELSE
    v_score := least(100, greatest(v_case.risk_score, p_risk_score) + least(15, greatest(1, v_case.event_count)));
    v_risk := public.security_case_risk_level(v_score);
    PERFORM set_config('app.security_case_write', 'on', true);
    UPDATE public.security_cases
       SET risk_score = v_score,
           risk_level = v_risk,
           event_count = event_count + 1,
           first_seen_at = least(first_seen_at, p_occurred_at),
           last_seen_at = greatest(last_seen_at, p_occurred_at),
           summary = CASE WHEN summary = '' THEN coalesce(p_summary, '') ELSE summary END,
           revision = revision + 1,
           updated_by = p_actor_id,
           updated_at = now()
     WHERE id = v_case.id
     RETURNING * INTO v_case;
  END IF;

  INSERT INTO public.security_case_events (
    case_id, source_kind, source_event_id, event_fingerprint, event_type,
    risk_level, risk_score, summary, evidence, occurred_at, linked_by
  ) VALUES (
    v_case.id, p_source_kind, p_source_event_id, p_event_fingerprint, p_event_type,
    p_risk_level, p_risk_score, coalesce(p_summary, ''), coalesce(p_evidence, '{}'::jsonb),
    p_occurred_at, p_actor_id
  );

  FOR v_entity IN SELECT value FROM jsonb_array_elements(p_entities) LOOP
    IF jsonb_typeof(v_entity) IS DISTINCT FROM 'object'
       OR v_entity - ARRAY['type', 'ref', 'label'] <> '{}'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SECURITY_CASE_ENTITY_INVALID';
    END IF;
    v_entity_type := v_entity->>'type';
    v_entity_ref := btrim(coalesce(v_entity->>'ref', ''));
    v_entity_label := left(coalesce(v_entity->>'label', ''), 120);
    IF v_entity_type NOT IN ('user', 'session', 'ip_hash', 'route', 'trace', 'credential', 'channel')
       OR char_length(v_entity_ref) NOT BETWEEN 1 AND 200
       OR v_entity_ref ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SECURITY_CASE_ENTITY_INVALID';
    END IF;
    INSERT INTO public.security_case_links (case_id, entity_type, entity_ref, entity_label, linked_by)
    VALUES (v_case.id, v_entity_type, v_entity_ref, v_entity_label, p_actor_id)
    ON CONFLICT (case_id, entity_type, entity_ref) DO NOTHING;
    v_entity_count := v_entity_count + 1;
  END LOOP;

  INSERT INTO public.security_case_audit (
    case_id, actor_id, event_type, from_status, to_status, reason_code,
    request_key, details
  ) VALUES (
    v_case.id, p_actor_id, 'event_linked', v_case.status, v_case.status,
    CASE WHEN v_created THEN 'CASE_CREATED_WITH_EVENT' ELSE 'EVENT_FINGERPRINT_MATCHED' END,
    left(coalesce(p_request_key, ''), 200),
    jsonb_build_object(
      'sourceKind', p_source_kind, 'eventType', p_event_type,
      'entityCount', v_entity_count, 'eventCount', v_case.event_count
    )
  );

  PERFORM set_config('app.security_case_write', coalesce(v_prior_write, ''), true);
  RETURN jsonb_build_object(
    'success', true, 'duplicate', false, 'createdCase', v_created,
    'caseId', v_case.id, 'revision', v_case.revision,
    'eventCount', v_case.event_count, 'riskScore', v_case.risk_score,
    'riskLevel', v_case.risk_level, 'status', v_case.status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_security_case_atomic(
  p_case_id uuid,
  p_expected_revision bigint,
  p_target_status text,
  p_actor_id text,
  p_reason text,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.security_cases%ROWTYPE;
  v_allowed boolean := false;
  v_from_status text;
  v_prior_write text := current_setting('app.security_case_write', true);
BEGIN
  IF p_case_id IS NULL OR p_expected_revision < 1 OR p_actor_id IS NULL
     OR p_target_status NOT IN ('triaged', 'mitigating', 'monitoring', 'resolved', 'false_positive')
     OR char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500
     OR NOT public.security_case_text_is_safe(p_reason) THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_TRANSITION_INVALID');
  END IF;
  SELECT * INTO v_case FROM public.security_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_NOT_FOUND'); END IF;
  IF v_case.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_REVISION_CONFLICT', 'revision', v_case.revision, 'status', v_case.status);
  END IF;
  v_allowed := (v_case.status = 'open' AND p_target_status = 'triaged')
    OR (v_case.status = 'assigned' AND p_target_status = 'mitigating')
    OR (v_case.status = 'mitigating' AND p_target_status = 'monitoring')
    OR (v_case.status = 'monitoring' AND p_target_status = 'resolved')
    OR (v_case.status IN ('open', 'triaged', 'assigned', 'mitigating', 'monitoring') AND p_target_status = 'false_positive');
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_TRANSITION_NOT_ALLOWED', 'status', v_case.status);
  END IF;
  v_from_status := v_case.status;
  PERFORM set_config('app.security_case_write', 'on', true);
  UPDATE public.security_cases
     SET status = p_target_status,
         revision = revision + 1,
         closed_at = CASE WHEN p_target_status IN ('resolved', 'false_positive') THEN now() ELSE NULL END,
         updated_by = p_actor_id,
         updated_at = now()
   WHERE id = p_case_id
   RETURNING * INTO v_case;
  INSERT INTO public.security_case_audit (
    case_id, actor_id, event_type, from_status, to_status, reason_code, reason, request_key
  ) VALUES (
    p_case_id, p_actor_id, 'case_transitioned',
    v_from_status,
    p_target_status, 'CASE_STATUS_TRANSITION', btrim(p_reason), left(coalesce(p_request_key, ''), 200)
  );
  PERFORM set_config('app.security_case_write', coalesce(v_prior_write, ''), true);
  RETURN jsonb_build_object('success', true, 'caseId', v_case.id, 'revision', v_case.revision, 'status', v_case.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_security_case_atomic(
  p_case_id uuid,
  p_expected_revision bigint,
  p_actor_id text,
  p_reason text,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.security_cases%ROWTYPE;
  v_prior_write text := current_setting('app.security_case_write', true);
BEGIN
  IF p_case_id IS NULL OR p_expected_revision < 1 OR p_actor_id IS NULL
     OR char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500
     OR NOT public.security_case_text_is_safe(p_reason) THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_CLAIM_INVALID');
  END IF;
  SELECT * INTO v_case FROM public.security_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_NOT_FOUND'); END IF;
  IF v_case.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_REVISION_CONFLICT', 'revision', v_case.revision, 'status', v_case.status, 'assignedTo', v_case.assigned_to);
  END IF;
  IF v_case.status <> 'triaged' OR v_case.assigned_to IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_CLAIM_NOT_AVAILABLE', 'status', v_case.status, 'assignedTo', v_case.assigned_to);
  END IF;
  PERFORM set_config('app.security_case_write', 'on', true);
  UPDATE public.security_cases
     SET status = 'assigned', assigned_to = p_actor_id, revision = revision + 1,
         updated_by = p_actor_id, updated_at = now()
   WHERE id = p_case_id
   RETURNING * INTO v_case;
  INSERT INTO public.security_case_audit (
    case_id, actor_id, event_type, from_status, to_status, reason_code, reason, request_key
  ) VALUES (
    p_case_id, p_actor_id, 'case_claimed', 'triaged', 'assigned',
    'CASE_CLAIM_CAS', btrim(p_reason), left(coalesce(p_request_key, ''), 200)
  );
  PERFORM set_config('app.security_case_write', coalesce(v_prior_write, ''), true);
  RETURN jsonb_build_object('success', true, 'caseId', v_case.id, 'revision', v_case.revision, 'status', v_case.status, 'assignedTo', v_case.assigned_to);
END;
$$;

CREATE OR REPLACE FUNCTION public.link_security_case_entity_atomic(
  p_case_id uuid,
  p_expected_revision bigint,
  p_entity_type text,
  p_entity_ref text,
  p_entity_label text,
  p_actor_id text,
  p_reason text,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.security_cases%ROWTYPE;
  v_link_id uuid;
  v_prior_write text := current_setting('app.security_case_write', true);
BEGIN
  IF p_case_id IS NULL OR p_expected_revision < 1 OR p_actor_id IS NULL
     OR p_entity_type NOT IN ('user', 'session', 'ip_hash', 'route', 'trace', 'credential', 'channel')
     OR char_length(btrim(coalesce(p_entity_ref, ''))) NOT BETWEEN 1 AND 200
     OR p_entity_ref ~ '[[:cntrl:]]'
     OR char_length(coalesce(p_entity_label, '')) > 120
     OR NOT public.security_case_text_is_safe(coalesce(p_entity_label, ''))
     OR char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500
     OR NOT public.security_case_text_is_safe(p_reason) THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ENTITY_INVALID');
  END IF;
  SELECT * INTO v_case FROM public.security_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_NOT_FOUND'); END IF;
  IF v_case.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_REVISION_CONFLICT', 'revision', v_case.revision);
  END IF;
  IF v_case.status IN ('resolved', 'false_positive') THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_CLOSED');
  END IF;
  SELECT id INTO v_link_id FROM public.security_case_links
   WHERE case_id = p_case_id AND entity_type = p_entity_type AND entity_ref = btrim(p_entity_ref);
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'caseId', p_case_id, 'revision', v_case.revision, 'linkId', v_link_id);
  END IF;
  PERFORM set_config('app.security_case_write', 'on', true);
  INSERT INTO public.security_case_links (case_id, entity_type, entity_ref, entity_label, linked_by)
  VALUES (p_case_id, p_entity_type, btrim(p_entity_ref), left(coalesce(p_entity_label, ''), 120), p_actor_id)
  RETURNING id INTO v_link_id;
  UPDATE public.security_cases
     SET revision = revision + 1, updated_by = p_actor_id, updated_at = now()
   WHERE id = p_case_id
   RETURNING * INTO v_case;
  INSERT INTO public.security_case_audit (
    case_id, actor_id, event_type, from_status, to_status, reason_code, reason, request_key, details
  ) VALUES (
    p_case_id, p_actor_id, 'entity_linked', v_case.status, v_case.status,
    'CASE_ENTITY_LINKED', btrim(p_reason), left(coalesce(p_request_key, ''), 200),
    jsonb_build_object('entityType', p_entity_type, 'linkId', v_link_id)
  );
  PERFORM set_config('app.security_case_write', coalesce(v_prior_write, ''), true);
  RETURN jsonb_build_object('success', true, 'duplicate', false, 'caseId', p_case_id, 'revision', v_case.revision, 'linkId', v_link_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.request_security_case_action_atomic(
  p_case_id uuid,
  p_expected_revision bigint,
  p_action_type text,
  p_target_type text,
  p_target_ref text,
  p_impact_preview jsonb,
  p_actor_id text,
  p_reason text,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_case public.security_cases%ROWTYPE;
  v_action public.security_case_actions%ROWTYPE;
  v_prior_status text;
  v_prior_write text := current_setting('app.security_case_write', true);
BEGIN
  IF p_case_id IS NULL OR p_expected_revision < 1 OR p_actor_id IS NULL
     OR p_action_type NOT IN ('revoke_session', 'disable_user')
     OR p_target_type NOT IN ('session', 'user')
     OR (p_action_type = 'revoke_session' AND p_target_type <> 'session')
     OR (p_action_type = 'disable_user' AND p_target_type <> 'user')
     OR char_length(btrim(coalesce(p_target_ref, ''))) NOT BETWEEN 1 AND 200
     OR NOT public.security_case_impact_is_safe(p_impact_preview)
     OR p_impact_preview->>'actionType' IS DISTINCT FROM p_action_type
     OR p_impact_preview->>'targetType' IS DISTINCT FROM p_target_type
     OR p_impact_preview->>'targetRef' IS DISTINCT FROM p_target_ref
     OR p_impact_preview->>'targetExists' IS DISTINCT FROM 'true'
     OR p_impact_preview->>'currentState' IS DISTINCT FROM 'active'
     OR p_impact_preview->>'executionSupported' IS DISTINCT FROM 'false'
     OR p_impact_preview->>'executorStatus' IS DISTINCT FROM 'unavailable'
     OR char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500
     OR NOT public.security_case_text_is_safe(p_reason)
     OR p_request_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_INVALID');
  END IF;
  SELECT * INTO v_action FROM public.security_case_actions
   WHERE requested_by = p_actor_id AND request_key = p_request_key;
  IF FOUND THEN
    IF v_action.case_id <> p_case_id OR v_action.action_type <> p_action_type OR v_action.target_ref <> p_target_ref THEN
      RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'duplicate', true, 'actionId', v_action.id,
      'actionRevision', v_action.revision, 'status', v_action.status,
      'executionSupported', false, 'executorStatus', 'unavailable'
    );
  END IF;
  SELECT * INTO v_case FROM public.security_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_NOT_FOUND'); END IF;
  IF v_case.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_REVISION_CONFLICT', 'revision', v_case.revision);
  END IF;
  IF v_case.status NOT IN ('assigned', 'mitigating') OR v_case.assigned_to IS DISTINCT FROM p_actor_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_REQUIRES_ASSIGNEE', 'status', v_case.status, 'assignedTo', v_case.assigned_to);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.security_case_links
     WHERE case_id = p_case_id AND entity_type = p_target_type AND entity_ref = p_target_ref
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_TARGET_NOT_LINKED');
  END IF;
  v_prior_status := v_case.status;
  PERFORM set_config('app.security_case_write', 'on', true);
  INSERT INTO public.security_case_actions (
    case_id, action_type, target_type, target_ref, status, revision,
    execution_supported, impact_preview, reason, requested_by, request_key
  ) VALUES (
    p_case_id, p_action_type, p_target_type, p_target_ref, 'pending_executor', 1,
    false, p_impact_preview, btrim(p_reason), p_actor_id, p_request_key
  ) RETURNING * INTO v_action;
  UPDATE public.security_cases
     SET status = CASE WHEN status = 'assigned' THEN 'mitigating' ELSE status END,
         revision = revision + 1, updated_by = p_actor_id, updated_at = now()
   WHERE id = p_case_id
   RETURNING * INTO v_case;
  INSERT INTO public.security_case_audit (
    case_id, action_id, actor_id, event_type, from_status, to_status,
    reason_code, reason, request_key, details
  ) VALUES (
    p_case_id, v_action.id, p_actor_id, 'action_requested',
    v_prior_status,
    v_case.status, 'EXECUTOR_UNAVAILABLE_PENDING', btrim(p_reason), p_request_key,
    jsonb_build_object('actionType', p_action_type, 'actionStatus', 'pending_executor', 'executionSupported', false)
  );
  PERFORM set_config('app.security_case_write', coalesce(v_prior_write, ''), true);
  RETURN jsonb_build_object(
    'success', true, 'duplicate', false, 'caseId', p_case_id,
    'caseRevision', v_case.revision, 'caseStatus', v_case.status,
    'actionId', v_action.id, 'actionRevision', v_action.revision,
    'status', v_action.status, 'executionSupported', false, 'executorStatus', 'unavailable'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_security_case_action_atomic(
  p_action_id uuid,
  p_case_id uuid,
  p_expected_action_revision bigint,
  p_actor_id text,
  p_reason text,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action public.security_case_actions%ROWTYPE;
  v_case public.security_cases%ROWTYPE;
  v_prior_write text := current_setting('app.security_case_write', true);
BEGIN
  IF p_action_id IS NULL OR p_case_id IS NULL OR p_expected_action_revision < 1 OR p_actor_id IS NULL
     OR char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500
     OR NOT public.security_case_text_is_safe(p_reason) THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_CANCEL_INVALID');
  END IF;
  SELECT * INTO v_action FROM public.security_case_actions WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_NOT_FOUND'); END IF;
  IF v_action.case_id <> p_case_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_CASE_MISMATCH');
  END IF;
  IF v_action.status = 'cancelled' AND v_action.cancelled_by IS NOT DISTINCT FROM p_actor_id
     AND EXISTS (
       SELECT 1 FROM public.security_case_audit
        WHERE action_id = p_action_id AND event_type = 'action_cancelled'
          AND actor_id IS NOT DISTINCT FROM p_actor_id
          AND request_key = left(coalesce(p_request_key, ''), 200)
     ) THEN
    RETURN jsonb_build_object(
      'success', true, 'duplicate', true, 'caseId', v_action.case_id,
      'actionId', v_action.id, 'actionRevision', v_action.revision, 'status', v_action.status
    );
  END IF;
  IF v_action.revision <> p_expected_action_revision THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_REVISION_CONFLICT', 'revision', v_action.revision);
  END IF;
  SELECT * INTO v_case FROM public.security_cases WHERE id = v_action.case_id FOR UPDATE;
  IF v_action.status <> 'pending_executor' THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_NOT_CANCELLABLE', 'status', v_action.status);
  END IF;
  IF v_action.requested_by IS DISTINCT FROM p_actor_id AND v_case.assigned_to IS DISTINCT FROM p_actor_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'SECURITY_CASE_ACTION_CANCEL_DENIED');
  END IF;
  PERFORM set_config('app.security_case_write', 'on', true);
  UPDATE public.security_case_actions
     SET status = 'cancelled', revision = revision + 1,
         cancelled_by = p_actor_id, cancelled_at = now(), cancellation_reason = left(btrim(p_reason), 500)
   WHERE id = p_action_id
   RETURNING * INTO v_action;
  UPDATE public.security_cases
     SET revision = revision + 1, updated_by = p_actor_id, updated_at = now()
   WHERE id = v_case.id
   RETURNING * INTO v_case;
  INSERT INTO public.security_case_audit (
    case_id, action_id, actor_id, event_type, from_status, to_status,
    reason_code, reason, request_key, details
  ) VALUES (
    v_case.id, v_action.id, p_actor_id, 'action_cancelled', v_case.status, v_case.status,
    'PENDING_ACTION_CANCELLED', btrim(p_reason), left(coalesce(p_request_key, ''), 200),
    jsonb_build_object('actionType', v_action.action_type, 'actionStatus', v_action.status)
  );
  PERFORM set_config('app.security_case_write', coalesce(v_prior_write, ''), true);
  RETURN jsonb_build_object(
    'success', true, 'caseId', v_case.id, 'caseRevision', v_case.revision,
    'actionId', v_action.id, 'actionRevision', v_action.revision, 'status', v_action.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.security_case_risk_level(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.security_case_text_is_safe(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.security_case_evidence_is_safe(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.security_case_impact_is_safe(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_security_case_record_write() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_security_case_append_only() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_security_case_audit_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ingest_security_case_event_atomic(text,text,text,text,text,integer,text,text,timestamptz,text,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.transition_security_case_atomic(uuid,bigint,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_security_case_atomic(uuid,bigint,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_security_case_entity_atomic(uuid,bigint,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.request_security_case_action_atomic(uuid,bigint,text,text,text,jsonb,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_security_case_action_atomic(uuid,uuid,bigint,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ingest_security_case_event_atomic(text,text,text,text,text,integer,text,text,timestamptz,text,jsonb,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_security_case_atomic(uuid,bigint,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_security_case_atomic(uuid,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_security_case_entity_atomic(uuid,bigint,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_security_case_action_atomic(uuid,bigint,text,text,text,jsonb,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_security_case_action_atomic(uuid,uuid,bigint,text,text,text) TO service_role;

COMMENT ON TABLE public.security_cases IS 'Deduplicated security cases with CAS revision and explicit lifecycle.';
COMMENT ON TABLE public.security_case_events IS 'Append-only references to existing security facts; raw credentials and payloads are forbidden.';
COMMENT ON TABLE public.security_case_actions IS 'Allowlisted action requests only. Phase 1 has no executor and never mutates target users or sessions.';
COMMENT ON TABLE public.security_case_audit IS 'Immutable security-case audit stream.';

NOTIFY pgrst, 'reload schema';

COMMIT;
