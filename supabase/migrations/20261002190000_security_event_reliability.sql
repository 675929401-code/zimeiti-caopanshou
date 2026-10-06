BEGIN;
SET LOCAL lock_timeout = '10s';

-- Reliable security-event intake, phase 1. This starts at the authenticated
-- internal receiver. Producer-side fetch loss remains outside this migration.

CREATE OR REPLACE FUNCTION public.security_reliability_text_is_safe(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(p_value, '') !~ '[[:cntrl:]]'
    AND coalesce(p_value, '') !~* '(bearer[[:space:]]+[-a-z0-9._~+/]{8,}|(authorization|cookie)[[:space:]]*:[^[:cntrl:]]+|(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization|cookie)["''[:space:]]*[:=][[:space:]]*[^,;[:cntrl:]]+|postgres(ql)?://|mysql://|redis://|mongodb(\+srv)?://|[?&](token|access_token|signature|sig|credential|x-amz-[^=]*|x-goog-[^=]*|q-sign-[^=]*)=)';
$$;

ALTER TABLE public.security_events
  ADD COLUMN IF NOT EXISTS reliable_ingest_id uuid,
  ADD COLUMN IF NOT EXISTS event_fingerprint character varying(64),
  ADD COLUMN IF NOT EXISTS occurrence_count integer,
  ADD COLUMN IF NOT EXISTS first_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_version character varying(32),
  ADD COLUMN IF NOT EXISTS retention_until timestamptz;

ALTER TABLE public.security_events
  DROP CONSTRAINT IF EXISTS security_events_reliable_privacy_check;
ALTER TABLE public.security_events
  ADD CONSTRAINT security_events_reliable_privacy_check CHECK (
    reliable_ingest_id IS NULL OR (
      event_fingerprint ~ '^[a-f0-9]{64}$'
      AND occurrence_count >= 1
      AND first_observed_at IS NOT NULL
      AND last_observed_at >= first_observed_at
      AND privacy_version = 'masked-v1'
      AND retention_until > first_observed_at
      AND ip_address IS NULL
      AND username IS NULL
      AND display_name IS NULL
      AND phone IS NULL
      AND raw_data IS NULL
      AND public.security_reliability_text_is_safe(coalesce(user_agent, ''))
      AND public.security_reliability_text_is_safe(coalesce(path, ''))
      AND public.security_reliability_text_is_safe(coalesce(details, ''))
    )
  ) NOT VALID;
ALTER TABLE public.security_events VALIDATE CONSTRAINT security_events_reliable_privacy_check;

CREATE UNIQUE INDEX IF NOT EXISTS security_events_reliable_ingest_unique
  ON public.security_events(reliable_ingest_id)
  WHERE reliable_ingest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_events_retention_due_idx
  ON public.security_events(retention_until)
  WHERE reliable_ingest_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.security_event_retention_policies (
  risk_level text PRIMARY KEY CHECK (risk_level IN ('low','medium','high','critical')),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  policy_reason text NOT NULL CHECK (char_length(policy_reason) BETWEEN 3 AND 240 AND public.security_reliability_text_is_safe(policy_reason)),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO public.security_event_retention_policies(risk_level,retention_days,policy_version,policy_reason)
VALUES
  ('low',30,1,'Masked low-risk security telemetry'),
  ('medium',90,1,'Masked medium-risk security telemetry'),
  ('high',180,1,'Masked high-risk investigation evidence'),
  ('critical',365,1,'Masked critical investigation evidence')
ON CONFLICT (risk_level) DO UPDATE SET
  retention_days=EXCLUDED.retention_days,
  policy_version=EXCLUDED.policy_version,
  policy_reason=EXCLUDED.policy_reason,
  updated_at=clock_timestamp();

CREATE TABLE IF NOT EXISTS public.security_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key character varying(64) NOT NULL UNIQUE CHECK (event_key ~ '^[a-f0-9]{64}$'),
  event_fingerprint character varying(64) NOT NULL CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
  dedupe_bucket_start timestamptz NOT NULL,
  event_type character varying(50) NOT NULL CHECK (event_type IN (
    'rate_limit','brute_force','bot_detected','sql_injection','xss_attempt',
    'path_traversal','prompt_injection','unauthorized_access','suspicious_behavior','api_abuse'
  )),
  risk_level character varying(20) NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  ip_hash character varying(32) CHECK (ip_hash IS NULL OR ip_hash ~ '^[a-f0-9]{32}$'),
  actor_ref_hash character varying(32) CHECK (actor_ref_hash IS NULL OR actor_ref_hash ~ '^[a-f0-9]{32}$'),
  user_agent_hash character varying(32) CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[a-f0-9]{32}$'),
  path character varying(500) CHECK (path IS NULL OR public.security_reliability_text_is_safe(path)),
  method character varying(10) CHECK (method IS NULL OR method ~ '^[A-Z]{3,10}$'),
  details character varying(500) CHECK (details IS NULL OR public.security_reliability_text_is_safe(details)),
  blocked boolean NOT NULL,
  source character varying(20) NOT NULL CHECK (source IN ('user_client','admin_panel','api_direct','anonymous')),
  occurred_at timestamptz NOT NULL,
  observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','retry','materialized','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  locked_by text,
  locked_until timestamptz,
  last_error_code text,
  last_error_summary text,
  materialized_event_id uuid,
  materialized_at timestamptz,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_fingerprint,dedupe_bucket_start),
  CHECK (last_observed_at >= first_observed_at),
  CHECK (retention_until > first_observed_at),
  CHECK (
    (status='processing' AND lease_token IS NOT NULL AND locked_by IS NOT NULL AND locked_until IS NOT NULL)
    OR status<>'processing'
  ),
  CHECK (
    (status='materialized' AND materialized_event_id IS NOT NULL AND materialized_at IS NOT NULL)
    OR status<>'materialized'
  )
);

CREATE INDEX IF NOT EXISTS security_event_outbox_due_idx
  ON public.security_event_outbox(available_at,created_at)
  WHERE status IN ('pending','retry');
CREATE INDEX IF NOT EXISTS security_event_outbox_lease_idx
  ON public.security_event_outbox(locked_until)
  WHERE status='processing';
CREATE INDEX IF NOT EXISTS security_event_outbox_status_idx
  ON public.security_event_outbox(status,updated_at DESC);

CREATE TABLE IF NOT EXISTS public.security_event_delivery_attempts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES public.security_event_outbox(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('materialized','retry','dead_letter')),
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 1 AND 120),
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(outbox_id,attempt_number),
  CHECK (public.security_reliability_text_is_safe(coalesce(error_summary,'')))
);

CREATE TABLE IF NOT EXISTS public.security_event_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL UNIQUE REFERENCES public.security_event_outbox(id) ON DELETE RESTRICT,
  event_fingerprint character varying(64) NOT NULL CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 120),
  reason_summary text NOT NULL CHECK (char_length(reason_summary) BETWEEN 1 AND 240 AND public.security_reliability_text_is_safe(reason_summary)),
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  observation_count integer NOT NULL CHECK (observation_count > 0),
  dead_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retention_until timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS security_event_dead_letters_time_idx
  ON public.security_event_dead_letters(dead_at DESC);

CREATE TABLE IF NOT EXISTS public.security_rate_limit_windows (
  scope_hash character varying(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  route_key character varying(200) NOT NULL CHECK (char_length(route_key) BETWEEN 1 AND 200 AND public.security_reliability_text_is_safe(route_key)),
  window_started_at timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  request_limit integer NOT NULL CHECK (request_limit BETWEEN 1 AND 100000),
  request_count integer NOT NULL CHECK (request_count >= 0),
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_hash,route_key),
  CHECK (expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS security_rate_limit_windows_expiry_idx
  ON public.security_rate_limit_windows(expires_at);

CREATE TABLE IF NOT EXISTS public.security_ip_risk_state (
  ip_hash character varying(32) PRIMARY KEY CHECK (ip_hash ~ '^[a-f0-9]{32}$'),
  window_started_at timestamptz NOT NULL,
  critical_count integer NOT NULL DEFAULT 0 CHECK (critical_count >= 0),
  high_count integer NOT NULL DEFAULT 0 CHECK (high_count >= 0),
  last_seen_at timestamptz NOT NULL,
  banned_until timestamptz,
  reason_code text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS security_ip_risk_state_ban_idx
  ON public.security_ip_risk_state(banned_until)
  WHERE banned_until IS NOT NULL;

ALTER TABLE public.security_event_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_event_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_event_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_ip_risk_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.security_event_retention_policies FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.security_event_outbox FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.security_event_delivery_attempts FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.security_event_dead_letters FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.security_rate_limit_windows FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.security_ip_risk_state FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.security_event_delivery_attempts_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.security_event_retention_policies TO service_role;
GRANT SELECT ON public.security_event_outbox TO service_role;
GRANT SELECT ON public.security_event_delivery_attempts TO service_role;
GRANT SELECT ON public.security_event_dead_letters TO service_role;
GRANT SELECT ON public.security_rate_limit_windows TO service_role;
GRANT SELECT ON public.security_ip_risk_state TO service_role;

CREATE OR REPLACE FUNCTION public.guard_security_reliability_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_RELIABILITY_DELETE_FORBIDDEN';
  END IF;
  IF current_setting('app.security_reliability_write',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='SECURITY_RELIABILITY_DIRECT_WRITE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_security_reliability_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_RELIABILITY_EVIDENCE_IMMUTABLE';
  END IF;
  IF current_setting('app.security_reliability_write',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='SECURITY_RELIABILITY_DIRECT_WRITE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER security_event_outbox_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.security_event_outbox
FOR EACH ROW EXECUTE FUNCTION public.guard_security_reliability_write();
CREATE TRIGGER security_event_attempts_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.security_event_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION public.guard_security_reliability_append_only();
CREATE TRIGGER security_event_dead_letters_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.security_event_dead_letters
FOR EACH ROW EXECUTE FUNCTION public.guard_security_reliability_append_only();
CREATE TRIGGER security_rate_limit_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.security_rate_limit_windows
FOR EACH ROW EXECUTE FUNCTION public.guard_security_reliability_write();
CREATE TRIGGER security_ip_risk_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.security_ip_risk_state
FOR EACH ROW EXECUTE FUNCTION public.guard_security_reliability_write();

CREATE OR REPLACE FUNCTION public.enqueue_security_event_atomic(
  p_event_key text,
  p_event_fingerprint text,
  p_dedupe_bucket_start timestamptz,
  p_event_type text,
  p_risk_level text,
  p_ip_hash text,
  p_actor_ref_hash text,
  p_user_agent_hash text,
  p_path text,
  p_method text,
  p_details text,
  p_blocked boolean,
  p_source text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  v_row public.security_event_outbox%ROWTYPE;
  v_policy public.security_event_retention_policies%ROWTYPE;
  v_ip public.security_ip_risk_state%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
  v_prior text:=current_setting('app.security_reliability_write',true);
BEGIN
  IF p_event_key IS NULL OR p_event_key !~ '^[a-f0-9]{64}$'
     OR p_event_fingerprint IS NULL OR p_event_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_event_type IS NULL OR p_event_type NOT IN ('rate_limit','brute_force','bot_detected','sql_injection','xss_attempt','path_traversal','prompt_injection','unauthorized_access','suspicious_behavior','api_abuse')
     OR p_risk_level IS NULL OR p_risk_level NOT IN ('low','medium','high','critical')
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[a-f0-9]{32}$')
     OR (p_actor_ref_hash IS NOT NULL AND p_actor_ref_hash !~ '^[a-f0-9]{32}$')
     OR (p_user_agent_hash IS NOT NULL AND p_user_agent_hash !~ '^[a-f0-9]{32}$')
     OR char_length(coalesce(p_path,''))>500 OR NOT public.security_reliability_text_is_safe(coalesce(p_path,''))
     OR (p_method IS NOT NULL AND p_method !~ '^[A-Z]{3,10}$')
     OR char_length(coalesce(p_details,''))>500 OR NOT public.security_reliability_text_is_safe(coalesce(p_details,''))
     OR p_blocked IS NULL OR p_source IS NULL OR p_source NOT IN ('user_client','admin_panel','api_direct','anonymous')
     OR p_occurred_at IS NULL OR p_dedupe_bucket_start IS NULL
     OR p_occurred_at>v_now+interval '5 minutes'
     OR p_dedupe_bucket_start>p_occurred_at OR p_dedupe_bucket_start<p_occurred_at-interval '2 minutes' THEN
    RETURN jsonb_build_object('success',false,'code','SECURITY_EVENT_INPUT_INVALID');
  END IF;

  SELECT * INTO v_policy FROM public.security_event_retention_policies WHERE risk_level=p_risk_level;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','SECURITY_EVENT_RETENTION_POLICY_MISSING'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('security-event-key:'||p_event_key,20261002190000));
  PERFORM pg_advisory_xact_lock(hashtextextended('security-event-fingerprint:'||p_event_fingerprint||':'||p_dedupe_bucket_start::text,20261002190000));
  SELECT * INTO v_row FROM public.security_event_outbox
   WHERE event_key=p_event_key OR (event_fingerprint=p_event_fingerprint AND dedupe_bucket_start=p_dedupe_bucket_start)
   ORDER BY CASE WHEN event_key=p_event_key THEN 0 ELSE 1 END
   LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_row.event_key=p_event_key AND v_row.event_fingerprint<>p_event_fingerprint THEN
      RETURN jsonb_build_object('success',false,'code','SECURITY_EVENT_IDEMPOTENCY_CONFLICT');
    END IF;
    PERFORM set_config('app.security_reliability_write','on',true);
    UPDATE public.security_event_outbox
       SET observation_count=observation_count+1,last_observed_at=greatest(last_observed_at,p_occurred_at),updated_at=v_now
     WHERE id=v_row.id RETURNING * INTO v_row;
    IF v_row.status='materialized' THEN
      UPDATE public.security_events
         SET occurrence_count=v_row.observation_count,last_observed_at=v_row.last_observed_at
       WHERE reliable_ingest_id=v_row.id;
    END IF;
    PERFORM set_config('app.security_reliability_write',coalesce(v_prior,''),true);
    RETURN jsonb_build_object(
      'success',true,'duplicate',true,'outboxId',v_row.id,'status',v_row.status,
      'observationCount',v_row.observation_count,'materializedEventId',v_row.materialized_event_id,
      'durable',true
    );
  END IF;

  PERFORM set_config('app.security_reliability_write','on',true);
  INSERT INTO public.security_event_outbox(
    event_key,event_fingerprint,dedupe_bucket_start,event_type,risk_level,
    ip_hash,actor_ref_hash,user_agent_hash,path,method,details,blocked,source,
    occurred_at,first_observed_at,last_observed_at,retention_until
  ) VALUES (
    p_event_key,p_event_fingerprint,p_dedupe_bucket_start,p_event_type,p_risk_level,
    p_ip_hash,p_actor_ref_hash,p_user_agent_hash,nullif(p_path,''),p_method,nullif(p_details,''),p_blocked,p_source,
    p_occurred_at,p_occurred_at,p_occurred_at,p_occurred_at+make_interval(days=>v_policy.retention_days)
  ) RETURNING * INTO v_row;

  IF p_ip_hash IS NOT NULL THEN
    SELECT * INTO v_ip FROM public.security_ip_risk_state WHERE ip_hash=p_ip_hash FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.security_ip_risk_state(ip_hash,window_started_at,critical_count,high_count,last_seen_at)
      VALUES(p_ip_hash,p_occurred_at,CASE WHEN p_risk_level='critical' THEN 1 ELSE 0 END,CASE WHEN p_risk_level='high' THEN 1 ELSE 0 END,p_occurred_at)
      RETURNING * INTO v_ip;
    ELSE
      IF p_occurred_at-v_ip.window_started_at>interval '24 hours' THEN
        v_ip.window_started_at:=p_occurred_at; v_ip.critical_count:=0; v_ip.high_count:=0;
      END IF;
      v_ip.critical_count:=v_ip.critical_count+CASE WHEN p_risk_level='critical' THEN 1 ELSE 0 END;
      v_ip.high_count:=v_ip.high_count+CASE WHEN p_risk_level='high' THEN 1 ELSE 0 END;
      UPDATE public.security_ip_risk_state SET
        window_started_at=v_ip.window_started_at,critical_count=v_ip.critical_count,high_count=v_ip.high_count,
        last_seen_at=greatest(last_seen_at,p_occurred_at),
        banned_until=CASE
          WHEN v_ip.critical_count>=3 OR v_ip.high_count>=5 THEN greatest(coalesce(banned_until,'-infinity'::timestamptz),p_occurred_at+interval '1 hour')
          ELSE banned_until END,
        reason_code=CASE WHEN v_ip.critical_count>=3 THEN 'CRITICAL_THRESHOLD' WHEN v_ip.high_count>=5 THEN 'HIGH_THRESHOLD' ELSE reason_code END,
        revision=revision+1,updated_at=v_now
      WHERE ip_hash=p_ip_hash RETURNING * INTO v_ip;
    END IF;
    IF v_ip.critical_count>=3 OR v_ip.high_count>=5 THEN
      UPDATE public.security_ip_risk_state SET
        banned_until=greatest(coalesce(banned_until,'-infinity'::timestamptz),p_occurred_at+interval '1 hour'),
        reason_code=CASE WHEN v_ip.critical_count>=3 THEN 'CRITICAL_THRESHOLD' ELSE 'HIGH_THRESHOLD' END,
        updated_at=v_now
      WHERE ip_hash=p_ip_hash RETURNING * INTO v_ip;
    END IF;
  END IF;

  PERFORM set_config('app.security_reliability_write',coalesce(v_prior,''),true);
  RETURN jsonb_build_object(
    'success',true,'duplicate',false,'outboxId',v_row.id,'status',v_row.status,
    'observationCount',1,'durable',true,
    'ipBanned',coalesce(v_ip.banned_until>v_now,false),'ipBanUntil',v_ip.banned_until
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_security_event_outbox_batch(
  p_worker_id text,
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 30
)
RETURNS SETOF public.security_event_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE v_prior text:=current_setting('app.security_reliability_write',true);
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$' OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='SECURITY_EVENT_CLAIM_INVALID';
  END IF;
  PERFORM set_config('app.security_reliability_write','on',true);
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM public.security_event_outbox
     WHERE (status IN ('pending','retry') AND available_at<=clock_timestamp())
        OR (status='processing' AND locked_until<=clock_timestamp())
     ORDER BY available_at,created_at
     FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.security_event_outbox o SET
    status='processing',attempt_count=o.attempt_count+1,lease_token=gen_random_uuid(),
    locked_by=p_worker_id,locked_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
  FROM candidates c WHERE o.id=c.id RETURNING o.*;
  PERFORM set_config('app.security_reliability_write',coalesce(v_prior,''),true);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_security_event_outbox_attempt(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_error_code text DEFAULT NULL,
  p_error_summary text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  v_row public.security_event_outbox%ROWTYPE;
  v_event_id uuid;
  v_outcome text;
  v_prior text:=current_setting('app.security_reliability_write',true);
BEGIN
  IF p_outbox_id IS NULL OR p_lease_token IS NULL OR p_success IS NULL OR p_retry_delay_seconds NOT BETWEEN 0 AND 3600
     OR char_length(coalesce(p_error_code,''))>120 OR coalesce(p_error_code,'') !~ '^[A-Za-z0-9._:-]*$'
     OR char_length(coalesce(p_error_summary,''))>240 OR NOT public.security_reliability_text_is_safe(coalesce(p_error_summary,'')) THEN
    RETURN jsonb_build_object('success',false,'code','SECURITY_EVENT_SETTLEMENT_INVALID');
  END IF;
  SELECT * INTO v_row FROM public.security_event_outbox WHERE id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','SECURITY_EVENT_OUTBOX_NOT_FOUND'); END IF;
  IF v_row.status IN ('materialized','dead_letter') THEN
    RETURN jsonb_build_object('success',true,'alreadySettled',true,'status',v_row.status,'eventId',v_row.materialized_event_id);
  END IF;
  IF v_row.status<>'processing' OR v_row.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('success',false,'code','SECURITY_EVENT_LEASE_CONFLICT');
  END IF;

  PERFORM set_config('app.security_reliability_write','on',true);
  IF p_success THEN
    INSERT INTO public.security_events(
      event_type,risk_level,ip_address,ip_hash,user_id,username,display_name,phone,user_agent,
      path,method,details,raw_data,blocked,source,created_at,reliable_ingest_id,event_fingerprint,
      occurrence_count,first_observed_at,last_observed_at,privacy_version,retention_until
    ) VALUES (
      v_row.event_type,v_row.risk_level,NULL,v_row.ip_hash,NULL,NULL,NULL,NULL,
      CASE WHEN v_row.user_agent_hash IS NULL THEN NULL ELSE 'hash:'||v_row.user_agent_hash END,
      v_row.path,v_row.method,v_row.details,NULL,v_row.blocked,v_row.source,v_row.occurred_at,
      v_row.id,v_row.event_fingerprint,v_row.observation_count,v_row.first_observed_at,v_row.last_observed_at,
      'masked-v1',v_row.retention_until
    )
    ON CONFLICT (reliable_ingest_id) WHERE reliable_ingest_id IS NOT NULL DO UPDATE SET
      occurrence_count=EXCLUDED.occurrence_count,last_observed_at=EXCLUDED.last_observed_at
    RETURNING id INTO v_event_id;
    v_outcome:='materialized';
    UPDATE public.security_event_outbox SET
      status='materialized',materialized_event_id=v_event_id,materialized_at=clock_timestamp(),
      lease_token=NULL,locked_by=NULL,locked_until=NULL,last_error_code=NULL,last_error_summary=NULL,updated_at=clock_timestamp()
    WHERE id=v_row.id;
  ELSIF v_row.attempt_count>=v_row.max_attempts THEN
    v_outcome:='dead_letter';
    UPDATE public.security_event_outbox SET
      status='dead_letter',lease_token=NULL,locked_by=NULL,locked_until=NULL,
      last_error_code=coalesce(nullif(p_error_code,''),'MATERIALIZATION_FAILED'),
      last_error_summary=coalesce(nullif(p_error_summary,''),'Materialization failed'),updated_at=clock_timestamp()
    WHERE id=v_row.id;
    INSERT INTO public.security_event_dead_letters(
      outbox_id,event_fingerprint,reason_code,reason_summary,attempt_count,observation_count,retention_until
    ) VALUES (
      v_row.id,v_row.event_fingerprint,coalesce(nullif(p_error_code,''),'MATERIALIZATION_FAILED'),
      coalesce(nullif(p_error_summary,''),'Materialization failed'),v_row.attempt_count,v_row.observation_count,v_row.retention_until
    ) ON CONFLICT (outbox_id) DO NOTHING;
  ELSE
    v_outcome:='retry';
    UPDATE public.security_event_outbox SET
      status='retry',available_at=clock_timestamp()+make_interval(secs=>p_retry_delay_seconds),
      lease_token=NULL,locked_by=NULL,locked_until=NULL,
      last_error_code=coalesce(nullif(p_error_code,''),'MATERIALIZATION_FAILED'),
      last_error_summary=coalesce(nullif(p_error_summary,''),'Materialization failed'),updated_at=clock_timestamp()
    WHERE id=v_row.id;
  END IF;

  INSERT INTO public.security_event_delivery_attempts(outbox_id,attempt_number,outcome,worker_id,error_code,error_summary)
  VALUES(v_row.id,v_row.attempt_count,v_outcome,v_row.locked_by,nullif(p_error_code,''),nullif(p_error_summary,''));
  PERFORM set_config('app.security_reliability_write',coalesce(v_prior,''),true);
  RETURN jsonb_build_object(
    'success',true,'alreadySettled',false,'outboxId',v_row.id,'status',v_outcome,
    'attemptCount',v_row.attempt_count,'eventId',v_event_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_security_rate_limit_atomic(
  p_scope_hash text,
  p_route_key text,
  p_window_seconds integer,
  p_request_limit integer,
  p_cost integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  v_row public.security_rate_limit_windows%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
  v_prior text:=current_setting('app.security_reliability_write',true);
BEGIN
  IF p_scope_hash !~ '^[a-f0-9]{64}$' OR char_length(coalesce(p_route_key,'')) NOT BETWEEN 1 AND 200
     OR NOT public.security_reliability_text_is_safe(p_route_key) OR p_window_seconds NOT BETWEEN 1 AND 86400
     OR p_request_limit NOT BETWEEN 1 AND 100000 OR p_cost NOT BETWEEN 1 AND 1000 THEN
    RETURN jsonb_build_object('success',false,'code','SECURITY_RATE_LIMIT_INPUT_INVALID');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('security-rate:'||p_scope_hash||':'||p_route_key,20261002190000));
  PERFORM set_config('app.security_reliability_write','on',true);
  SELECT * INTO v_row FROM public.security_rate_limit_windows WHERE scope_hash=p_scope_hash AND route_key=p_route_key FOR UPDATE;
  IF NOT FOUND OR v_row.expires_at<=v_now OR v_row.window_seconds<>p_window_seconds OR v_row.request_limit<>p_request_limit THEN
    INSERT INTO public.security_rate_limit_windows(scope_hash,route_key,window_started_at,window_seconds,request_limit,request_count,expires_at)
    VALUES(p_scope_hash,p_route_key,v_now,p_window_seconds,p_request_limit,p_cost,v_now+make_interval(secs=>p_window_seconds))
    ON CONFLICT(scope_hash,route_key) DO UPDATE SET
      window_started_at=EXCLUDED.window_started_at,window_seconds=EXCLUDED.window_seconds,
      request_limit=EXCLUDED.request_limit,request_count=EXCLUDED.request_count,expires_at=EXCLUDED.expires_at,
      revision=public.security_rate_limit_windows.revision+1,updated_at=v_now
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.security_rate_limit_windows SET request_count=request_count+p_cost,revision=revision+1,updated_at=v_now
    WHERE scope_hash=p_scope_hash AND route_key=p_route_key RETURNING * INTO v_row;
  END IF;
  PERFORM set_config('app.security_reliability_write',coalesce(v_prior,''),true);
  RETURN jsonb_build_object(
    'success',true,'allowed',v_row.request_count<=v_row.request_limit,
    'count',v_row.request_count,'limit',v_row.request_limit,
    'remaining',greatest(0,v_row.request_limit-v_row.request_count),'resetAt',v_row.expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_security_event_reliability_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT jsonb_build_object(
    'success',true,
    'schema','security-event-reliability-status/v1',
    'migration','20261002190000',
    'scope','receiver_after_authentication',
    'producerDeliveryDurable',false,
    'preReceiverLossObservable',false,
    'receiverInlineDrainEnabled',true,
    'retryWorkerScheduled',false,
    'retentionPolicyConfigured',true,
    'retentionPurgeExecutorAvailable',false,
    'acceptedUnique',(SELECT count(*) FROM public.security_event_outbox),
    'acceptedObservations',(SELECT coalesce(sum(observation_count),0) FROM public.security_event_outbox),
    'materializedUnique',(SELECT count(*) FROM public.security_event_outbox WHERE status='materialized'),
    'materializedObservations',(SELECT coalesce(sum(observation_count),0) FROM public.security_event_outbox WHERE status='materialized'),
    'pendingUnique',(SELECT count(*) FROM public.security_event_outbox WHERE status IN ('pending','processing','retry')),
    'deadLetterUnique',(SELECT count(*) FROM public.security_event_outbox WHERE status='dead_letter'),
    'knownLostObservations',(SELECT coalesce(sum(observation_count),0) FROM public.security_event_outbox WHERE status='dead_letter'),
    'retryAttempts',(SELECT count(*) FROM public.security_event_delivery_attempts WHERE outcome='retry'),
    'oldestPendingAt',(SELECT min(first_observed_at) FROM public.security_event_outbox WHERE status IN ('pending','processing','retry')),
    'retentionDue',(SELECT count(*) FROM public.security_events WHERE reliable_ingest_id IS NOT NULL AND retention_until<=clock_timestamp()),
    'sharedRateScopes',(SELECT count(*) FROM public.security_rate_limit_windows),
    'sharedIpRiskStates',(SELECT count(*) FROM public.security_ip_risk_state),
    'activeIpBans',(SELECT count(*) FROM public.security_ip_risk_state WHERE banned_until>clock_timestamp())
  );
$$;

REVOKE ALL ON FUNCTION public.security_reliability_text_is_safe(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.guard_security_reliability_write() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.guard_security_reliability_append_only() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.enqueue_security_event_atomic(text,text,timestamptz,text,text,text,text,text,text,text,text,boolean,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_security_event_outbox_batch(text,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.settle_security_event_outbox_attempt(uuid,uuid,boolean,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.consume_security_rate_limit_atomic(text,text,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_security_event_reliability_status() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_security_event_atomic(text,text,timestamptz,text,text,text,text,text,text,text,text,boolean,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_security_event_outbox_batch(text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_security_event_outbox_attempt(uuid,uuid,boolean,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_security_rate_limit_atomic(text,text,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_security_event_reliability_status() TO service_role;

COMMENT ON TABLE public.security_event_outbox IS 'Durable masked security-event intake after the authenticated internal receiver.';
COMMENT ON TABLE public.security_event_delivery_attempts IS 'Append-only materialization attempt evidence.';
COMMENT ON TABLE public.security_event_dead_letters IS 'Immutable terminal failures with masked metadata only.';
COMMENT ON TABLE public.security_rate_limit_windows IS 'Shared fixed-window rate state; integration into locked proxy remains separate.';
COMMENT ON TABLE public.security_ip_risk_state IS 'Shared hashed-IP risk state; integration into locked proxy remains separate.';

NOTIFY pgrst,'reload schema';
COMMIT;
