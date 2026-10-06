BEGIN;

-- Durable queue for the exact AutoDL self-hosted MiniMax H3 channel.
-- This migration is intentionally declarative: applying it is a separate,
-- explicitly-authorized production operation.
CREATE TABLE IF NOT EXISTS autodl_h3_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_task_id text NOT NULL UNIQUE,
  client_request_id text NOT NULL,
  video_task_internal_id text,
  -- Production users.id is varchar. Keep the lifecycle ownership key in the
  -- same type so this foreign key can be applied without an unsafe cast.
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  instance_uuid text NOT NULL,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'ACCEPTED',
  upstream_task_id text,
  content_url text,
  result_asset_url text,
  progress integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  not_before timestamptz,
  lease_owner text,
  lease_token bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT autodl_h3_jobs_user_request_unique UNIQUE (user_id, client_request_id),
  CONSTRAINT autodl_h3_jobs_state_check CHECK (state IN (
    'ACCEPTED',
    'WAITING_POWER',
    'WAITING_READY',
    'DISPATCHING',
    'QUEUED',
    'RUNNING',
    'RESULT_STAGING',
    'PERSISTING',
    'FINALIZING',
    'SUCCEEDED',
    'RETRY_WAIT',
    'FAILED_TERMINAL',
    'CANCELLED',
    'RECOVERY_REQUIRED'
  )),
  CONSTRAINT autodl_h3_jobs_progress_check CHECK (progress >= 0 AND progress <= 100),
  CONSTRAINT autodl_h3_jobs_payload_object_check CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT autodl_h3_jobs_success_asset_check CHECK (
    state <> 'SUCCEEDED'
    OR (
      result_asset_url IS NOT NULL
      AND (
        result_asset_url ~ '^object://tencent_cos/[^?#]+$'
        OR (
          result_asset_url ~ '^https://'
          AND result_asset_url !~* '^https://(?:localhost|127\.0\.0\.1|[^/]*\.seetacloud\.com)(?::[0-9]+)?/'
          AND result_asset_url !~* '[?&](?:sig|sign|signature|token|key|auth|authorization|expires|x-cos-security-token|x-cos-signature)='
        )
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS autodl_h3_jobs_instance_dispatch_idx
  ON autodl_h3_jobs (instance_uuid, state, not_before, created_at);
CREATE INDEX IF NOT EXISTS autodl_h3_jobs_user_public_idx
  ON autodl_h3_jobs (user_id, public_task_id);
CREATE INDEX IF NOT EXISTS autodl_h3_jobs_upstream_idx
  ON autodl_h3_jobs (upstream_task_id)
  WHERE upstream_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS autodl_h3_instance_state (
  instance_uuid text PRIMARY KEY,
  lifecycle_state text NOT NULL DEFAULT 'UNKNOWN',
  last_activity_at timestamptz,
  idle_since timestamptz,
  lease_owner text,
  lease_token bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  activity_epoch bigint NOT NULL DEFAULT 0,
  shutdown_epoch bigint,
  last_error_code text,
  last_error_message text,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autodl_h3_instance_state_check CHECK (lifecycle_state IN (
    'OFF',
    'START_REQUESTED',
    'STARTING',
    'BOOTSTRAPPING',
    'READY',
    'BUSY',
    'IDLE_GRACE',
    'DRAINING',
    'STOP_REQUESTED',
    'STOPPING',
    'UNKNOWN',
    'FAULTED'
  ))
);

-- Exactly-once audit row written in the same transaction as the business
-- task completion, cash ledger entry and lifecycle SUCCEEDED transition.
CREATE TABLE IF NOT EXISTS autodl_h3_settlements (
  job_id uuid PRIMARY KEY REFERENCES autodl_h3_jobs(id) ON DELETE RESTRICT,
  public_task_id text NOT NULL UNIQUE,
  video_task_internal_id text NOT NULL UNIQUE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  model_id text NOT NULL,
  upstream_task_id text NOT NULL,
  stable_asset_url text NOT NULL,
  price_yuan numeric(14,4) NOT NULL DEFAULT 0,
  cost_price numeric(14,4) NOT NULL DEFAULT 0,
  charged_yuan numeric(14,4) NOT NULL DEFAULT 0,
  response_ms bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autodl_h3_settlement_money_check CHECK (
    price_yuan >= 0 AND cost_price >= 0 AND charged_yuan >= 0 AND response_ms >= 0
  ),
  CONSTRAINT autodl_h3_settlement_asset_check CHECK (stable_asset_url ~ '^object://tencent_cos/[^?#]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_transactions_autodl_h3_once_idx
  ON cash_transactions (user_id, reference_id)
  WHERE type = 'consume' AND reference_id LIKE 'autodl_h3:%';
CREATE UNIQUE INDEX IF NOT EXISTS revenue_records_autodl_h3_once_idx
  ON revenue_records (task_id, record_type)
  WHERE record_type = 'video' AND task_id LIKE 'h3q_%';

ALTER TABLE autodl_h3_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE autodl_h3_instance_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE autodl_h3_settlements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE autodl_h3_jobs FROM anon, authenticated;
REVOKE ALL ON TABLE autodl_h3_instance_state FROM anon, authenticated;
REVOKE ALL ON TABLE autodl_h3_settlements FROM anon, authenticated;
GRANT ALL ON TABLE autodl_h3_jobs TO service_role;
GRANT ALL ON TABLE autodl_h3_instance_state TO service_role;
GRANT ALL ON TABLE autodl_h3_settlements TO service_role;

DROP POLICY IF EXISTS autodl_h3_jobs_service_role_all ON autodl_h3_jobs;
CREATE POLICY autodl_h3_jobs_service_role_all
  ON autodl_h3_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS autodl_h3_instance_service_role_all ON autodl_h3_instance_state;
CREATE POLICY autodl_h3_instance_service_role_all
  ON autodl_h3_instance_state
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS autodl_h3_settlements_service_role_all ON autodl_h3_settlements;
CREATE POLICY autodl_h3_settlements_service_role_all
  ON autodl_h3_settlements
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Atomic idempotent enqueue. The first payload wins; retries return the
-- existing row and may not rewrite a task that is already running/terminal.
CREATE OR REPLACE FUNCTION autodl_h3_enqueue_job(
  p_public_task_id text,
  p_client_request_id text,
  p_video_task_internal_id text,
  p_user_id text,
  p_model_id text,
  p_instance_uuid text,
  p_request_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
  v_created boolean := false;
  v_instance autodl_h3_instance_state%ROWTYPE;
  v_initial_state text := 'ACCEPTED';
BEGIN
  INSERT INTO autodl_h3_instance_state (instance_uuid)
  VALUES (p_instance_uuid)
  ON CONFLICT (instance_uuid) DO NOTHING;

  SELECT * INTO STRICT v_instance
  FROM autodl_h3_instance_state
  WHERE instance_uuid = p_instance_uuid
  FOR UPDATE;

  IF v_instance.lifecycle_state IN ('DRAINING', 'STOP_REQUESTED', 'STOPPING') THEN
    v_initial_state := 'WAITING_POWER';
  END IF;

  INSERT INTO autodl_h3_jobs (
    public_task_id,
    client_request_id,
    video_task_internal_id,
    user_id,
    model_id,
    instance_uuid,
    request_payload,
    state
  ) VALUES (
    p_public_task_id,
    p_client_request_id,
    p_video_task_internal_id,
    p_user_id,
    p_model_id,
    p_instance_uuid,
    COALESCE(p_request_payload, '{}'::jsonb),
    v_initial_state
  )
  ON CONFLICT (user_id, client_request_id) DO NOTHING
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    v_created := true;
    UPDATE autodl_h3_instance_state
    SET
      activity_epoch = activity_epoch + 1,
      last_activity_at = now(),
      idle_since = NULL,
      lifecycle_state = CASE
        WHEN lifecycle_state IN ('READY', 'IDLE_GRACE') THEN 'BUSY'
        ELSE lifecycle_state
      END,
      state_changed_at = CASE
        WHEN lifecycle_state IN ('READY', 'IDLE_GRACE') THEN now()
        ELSE state_changed_at
      END,
      updated_at = now()
    WHERE instance_uuid = p_instance_uuid;
  ELSE
    SELECT * INTO STRICT v_job
    FROM autodl_h3_jobs
    WHERE user_id = p_user_id
      AND client_request_id = p_client_request_id;

    IF v_job.public_task_id <> p_public_task_id
       OR v_job.model_id <> p_model_id
       OR v_job.instance_uuid <> p_instance_uuid
       OR v_job.request_payload <> COALESCE(p_request_payload, '{}'::jsonb) THEN
      RAISE EXCEPTION 'AUTODL_H3_IDEMPOTENCY_CONFLICT';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'created', v_created,
    'job', to_jsonb(v_job)
  );
END
$function$;

-- Atomic first shutdown gate. It holds the instance row lock while checking
-- both the idle generation and durable blockers, then records the generation
-- being drained. External runtime activity is checked by the controller before
-- calling the confirmation gate below.
CREATE OR REPLACE FUNCTION autodl_h3_prepare_shutdown(
  p_instance_uuid text,
  p_owner text,
  p_lease_token bigint,
  p_expected_activity_epoch bigint,
  p_idle_grace_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_state autodl_h3_instance_state%ROWTYPE;
BEGIN
  SELECT * INTO v_state
  FROM autodl_h3_instance_state
  WHERE instance_uuid = p_instance_uuid
  FOR UPDATE;

  IF v_state.instance_uuid IS NULL
     OR v_state.lease_owner <> p_owner
     OR v_state.lease_token <> p_lease_token
     OR v_state.lease_expires_at IS NULL
     OR v_state.lease_expires_at <= now()
     OR v_state.activity_epoch <> p_expected_activity_epoch
     OR v_state.idle_since IS NULL
     OR v_state.idle_since > now() - make_interval(secs => GREATEST(300, p_idle_grace_seconds))
     OR EXISTS (
       SELECT 1 FROM autodl_h3_jobs
       WHERE instance_uuid = p_instance_uuid
         AND state NOT IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED')
     ) THEN
    RETURN NULL;
  END IF;

  UPDATE autodl_h3_instance_state
  SET
    lifecycle_state = 'DRAINING',
    shutdown_epoch = activity_epoch,
    state_changed_at = CASE WHEN lifecycle_state = 'DRAINING' THEN state_changed_at ELSE now() END,
    updated_at = now()
  WHERE instance_uuid = p_instance_uuid
  RETURNING * INTO v_state;

  RETURN to_jsonb(v_state);
END
$function$;

-- Atomic final shutdown gate. After this commits, a new enqueue observes
-- STOP_REQUESTED and is stored as WAITING_POWER; it is never dispatched into
-- the instance that is already being stopped.
CREATE OR REPLACE FUNCTION autodl_h3_confirm_shutdown(
  p_instance_uuid text,
  p_owner text,
  p_lease_token bigint,
  p_expected_shutdown_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_state autodl_h3_instance_state%ROWTYPE;
BEGIN
  SELECT * INTO v_state
  FROM autodl_h3_instance_state
  WHERE instance_uuid = p_instance_uuid
  FOR UPDATE;

  IF v_state.instance_uuid IS NULL
     OR v_state.lease_owner <> p_owner
     OR v_state.lease_token <> p_lease_token
     OR v_state.lease_expires_at IS NULL
     OR v_state.lease_expires_at <= now()
     OR v_state.lifecycle_state <> 'DRAINING'
     OR v_state.shutdown_epoch IS DISTINCT FROM p_expected_shutdown_epoch
     OR v_state.activity_epoch <> p_expected_shutdown_epoch
     OR EXISTS (
       SELECT 1 FROM autodl_h3_jobs
       WHERE instance_uuid = p_instance_uuid
         AND state NOT IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED')
     ) THEN
    RETURN NULL;
  END IF;

  UPDATE autodl_h3_instance_state
  SET lifecycle_state = 'STOP_REQUESTED', state_changed_at = now(), updated_at = now()
  WHERE instance_uuid = p_instance_uuid
  RETURNING * INTO v_state;

  RETURN to_jsonb(v_state);
END
$function$;

-- One process owns an instance at a time. A new owner always receives a
-- strictly larger fencing token; stale owners cannot write lifecycle state.
CREATE OR REPLACE FUNCTION autodl_h3_acquire_instance_lease(
  p_instance_uuid text,
  p_owner text,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_state autodl_h3_instance_state%ROWTYPE;
BEGIN
  INSERT INTO autodl_h3_instance_state (instance_uuid)
  VALUES (p_instance_uuid)
  ON CONFLICT (instance_uuid) DO NOTHING;

  UPDATE autodl_h3_instance_state
  SET
    lease_token = CASE
      WHEN lease_owner = p_owner AND lease_expires_at > now() THEN lease_token
      ELSE lease_token + 1
    END,
    lease_owner = p_owner,
    lease_expires_at = now() + make_interval(secs => GREATEST(5, LEAST(p_lease_seconds, 300))),
    updated_at = now()
  WHERE instance_uuid = p_instance_uuid
    AND (
      lease_owner IS NULL
      OR lease_expires_at IS NULL
      OR lease_expires_at <= now()
      OR lease_owner = p_owner
    )
  RETURNING * INTO v_state;

  IF v_state.instance_uuid IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(v_state);
END
$function$;

CREATE OR REPLACE FUNCTION autodl_h3_renew_instance_lease(
  p_instance_uuid text,
  p_owner text,
  p_lease_token bigint,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH renewed AS (
    UPDATE autodl_h3_instance_state
    SET
      lease_expires_at = now() + make_interval(secs => GREATEST(5, LEAST(p_lease_seconds, 300))),
      updated_at = now()
    WHERE instance_uuid = p_instance_uuid
      AND lease_owner = p_owner
      AND lease_token = p_lease_token
      AND lease_expires_at > now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed);
$function$;

CREATE OR REPLACE FUNCTION autodl_h3_update_instance_state(
  p_instance_uuid text,
  p_owner text,
  p_lease_token bigint,
  p_lifecycle_state text,
  p_last_activity_at timestamptz,
  p_idle_since timestamptz,
  p_last_error_code text,
  p_last_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_state autodl_h3_instance_state%ROWTYPE;
BEGIN
  UPDATE autodl_h3_instance_state
  SET
    lifecycle_state = p_lifecycle_state,
    state_changed_at = CASE
      WHEN lifecycle_state IS DISTINCT FROM p_lifecycle_state THEN now()
      ELSE state_changed_at
    END,
    last_activity_at = p_last_activity_at,
    idle_since = p_idle_since,
    last_error_code = p_last_error_code,
    last_error_message = p_last_error_message,
    updated_at = now()
  WHERE instance_uuid = p_instance_uuid
    AND lease_owner = p_owner
    AND lease_token = p_lease_token
    AND lease_expires_at > now()
  RETURNING * INTO v_state;

  IF v_state.instance_uuid IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(v_state);
END
$function$;

CREATE OR REPLACE FUNCTION autodl_h3_renew_job_lease(
  p_job_id uuid,
  p_owner text,
  p_lease_token bigint,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH renewed AS (
    UPDATE autodl_h3_jobs
    SET
      lease_expires_at = now() + make_interval(secs => GREATEST(5, LEAST(p_lease_seconds, 300))),
      updated_at = now()
    WHERE id = p_job_id
      AND lease_owner = p_owner
      AND lease_token = p_lease_token
      AND lease_expires_at > now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed);
$function$;

-- Dispatch claim uses SKIP LOCKED and a per-job fencing token. Only jobs that
-- have never been handed to H3 (no upstream_task_id) are eligible.
CREATE OR REPLACE FUNCTION autodl_h3_claim_job(
  p_instance_uuid text,
  p_owner text,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM autodl_h3_jobs
    WHERE instance_uuid = p_instance_uuid
      AND upstream_task_id IS NULL
      AND state IN ('ACCEPTED', 'WAITING_POWER', 'WAITING_READY', 'RETRY_WAIT')
      AND (not_before IS NULL OR not_before <= now())
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE autodl_h3_jobs AS jobs
  SET
    state = 'DISPATCHING',
    attempt_count = jobs.attempt_count + 1,
    lease_owner = p_owner,
    lease_token = jobs.lease_token + 1,
    lease_expires_at = now() + make_interval(secs => GREATEST(5, LEAST(p_lease_seconds, 300))),
    started_at = COALESCE(jobs.started_at, now()),
    updated_at = now(),
    error_code = NULL,
    error_message = NULL
  FROM candidate
  WHERE jobs.id = candidate.id
  RETURNING jobs.* INTO v_job;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(v_job);
END
$function$;

-- Reclaim an already-submitted upstream task when no browser/status request is
-- connected. The lifecycle worker must reconcile these jobs through H3 poll,
-- result staging and persistence before the instance may become idle.
CREATE OR REPLACE FUNCTION autodl_h3_claim_active_job(
  p_instance_uuid text,
  p_owner text,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM autodl_h3_jobs
    WHERE instance_uuid = p_instance_uuid
      AND upstream_task_id IS NOT NULL
      AND state IN (
        'QUEUED',
        'RUNNING',
        'RESULT_STAGING',
        'PERSISTING',
        'FINALIZING',
        'RECOVERY_REQUIRED'
      )
      AND (not_before IS NULL OR not_before <= now())
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY updated_at ASC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE autodl_h3_jobs AS jobs
  SET
    lease_owner = p_owner,
    lease_token = jobs.lease_token + 1,
    lease_expires_at = now() + make_interval(secs => GREATEST(5, LEAST(p_lease_seconds, 300))),
    updated_at = now()
  FROM candidate
  WHERE jobs.id = candidate.id
  RETURNING jobs.* INTO v_job;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(v_job);
END
$function$;

-- A worker that died after sending H3 but before persisting upstream_task_id
-- leaves DISPATCHING behind. Reclaim it only into recovery; the dispatcher
-- must query H3 by the stable client_request_id before deciding whether a
-- retry is safe.
CREATE OR REPLACE FUNCTION autodl_h3_claim_unknown_dispatch_job(
  p_instance_uuid text,
  p_owner text,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM autodl_h3_jobs
    WHERE instance_uuid = p_instance_uuid
      AND upstream_task_id IS NULL
      AND state IN ('DISPATCHING', 'RECOVERY_REQUIRED')
      AND (not_before IS NULL OR not_before <= now())
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY updated_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE autodl_h3_jobs AS jobs
  SET
    state = 'RECOVERY_REQUIRED',
    lease_owner = p_owner,
    lease_token = jobs.lease_token + 1,
    lease_expires_at = now() + make_interval(secs => GREATEST(5, LEAST(p_lease_seconds, 300))),
    updated_at = now(),
    error_code = 'UNKNOWN_DISPATCH_RESULT',
    error_message = '提交结果未知，正在按稳定请求编号恢复'
  FROM candidate
  WHERE jobs.id = candidate.id
  RETURNING jobs.* INTO v_job;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN to_jsonb(v_job);
END
$function$;

CREATE OR REPLACE FUNCTION autodl_h3_job_transition_allowed(p_current text, p_next text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT p_current = p_next OR CASE p_current
    WHEN 'ACCEPTED' THEN p_next IN ('WAITING_POWER','WAITING_READY','DISPATCHING','FAILED_TERMINAL','CANCELLED')
    WHEN 'WAITING_POWER' THEN p_next IN ('WAITING_READY','DISPATCHING','FAILED_TERMINAL','CANCELLED')
    WHEN 'WAITING_READY' THEN p_next IN ('DISPATCHING','FAILED_TERMINAL','CANCELLED')
    WHEN 'DISPATCHING' THEN p_next IN ('QUEUED','RETRY_WAIT','RECOVERY_REQUIRED','FAILED_TERMINAL','CANCELLED')
    WHEN 'QUEUED' THEN p_next IN ('RUNNING','RESULT_STAGING','PERSISTING','FINALIZING','RECOVERY_REQUIRED','FAILED_TERMINAL','CANCELLED')
    WHEN 'RUNNING' THEN p_next IN ('RESULT_STAGING','PERSISTING','FINALIZING','RECOVERY_REQUIRED','FAILED_TERMINAL','CANCELLED')
    WHEN 'RESULT_STAGING' THEN p_next IN ('PERSISTING','FINALIZING','RECOVERY_REQUIRED','FAILED_TERMINAL','CANCELLED')
    WHEN 'PERSISTING' THEN p_next IN ('FINALIZING','RECOVERY_REQUIRED','FAILED_TERMINAL','CANCELLED')
    WHEN 'FINALIZING' THEN p_next IN ('RECOVERY_REQUIRED','FAILED_TERMINAL','CANCELLED')
    WHEN 'RETRY_WAIT' THEN p_next IN ('WAITING_POWER','WAITING_READY','DISPATCHING','FAILED_TERMINAL','CANCELLED')
    WHEN 'RECOVERY_REQUIRED' THEN p_next IN ('RETRY_WAIT','QUEUED','RUNNING','RESULT_STAGING','PERSISTING','FINALIZING','FAILED_TERMINAL','CANCELLED')
    ELSE false
  END;
$function$;

CREATE OR REPLACE FUNCTION autodl_h3_job_rank(p_state text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE p_state
    WHEN 'ACCEPTED' THEN 0 WHEN 'WAITING_POWER' THEN 1 WHEN 'WAITING_READY' THEN 2
    WHEN 'DISPATCHING' THEN 3 WHEN 'QUEUED' THEN 4 WHEN 'RUNNING' THEN 5
    WHEN 'RESULT_STAGING' THEN 6 WHEN 'PERSISTING' THEN 7 WHEN 'FINALIZING' THEN 8
    WHEN 'SUCCEEDED' THEN 9 ELSE NULL END;
$function$;

CREATE OR REPLACE FUNCTION autodl_h3_transition_claimed_job(
  p_job_id uuid,
  p_owner text,
  p_lease_token bigint,
  p_state text,
  p_upstream_task_id text,
  p_content_url text,
  p_result_asset_url text,
  p_progress integer,
  p_not_before timestamptz,
  p_error_code text,
  p_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM autodl_h3_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.lease_owner <> p_owner OR v_job.lease_token <> p_lease_token
     OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= now() THEN
    RETURN NULL;
  END IF;
  -- Atomic settlement writes SUCCEEDED while retaining the worker lease. This
  -- same-state call is the only success acknowledgement and releases it.
  IF v_job.state = 'SUCCEEDED' AND p_state = 'SUCCEEDED' THEN
    UPDATE autodl_h3_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = v_job.id RETURNING * INTO v_job;
    RETURN to_jsonb(v_job);
  END IF;
  IF p_state = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'AUTODL_H3_SUCCESS_REQUIRES_ATOMIC_SETTLEMENT';
  END IF;
  IF autodl_h3_job_rank(v_job.state) IS NOT NULL AND autodl_h3_job_rank(p_state) IS NOT NULL
     AND autodl_h3_job_rank(p_state) < autodl_h3_job_rank(v_job.state) THEN
    RETURN to_jsonb(v_job);
  END IF;
  IF NOT autodl_h3_job_transition_allowed(v_job.state, p_state) THEN
    RAISE EXCEPTION 'AUTODL_H3_ILLEGAL_JOB_TRANSITION_%_TO_%', v_job.state, p_state;
  END IF;

  UPDATE autodl_h3_jobs
  SET
    state = p_state,
    upstream_task_id = COALESCE(p_upstream_task_id, upstream_task_id),
    content_url = COALESCE(p_content_url, content_url),
    result_asset_url = COALESCE(p_result_asset_url, result_asset_url),
    progress = GREATEST(progress, GREATEST(0, LEAST(COALESCE(p_progress, progress), 100))),
    not_before = p_not_before,
    error_code = p_error_code,
    error_message = p_error_message,
    lease_owner = NULL,
    lease_expires_at = NULL,
    completed_at = CASE
      WHEN p_state IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED') THEN now()
      ELSE completed_at
    END,
    updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE autodl_h3_instance_state SET activity_epoch = activity_epoch + 1,
    last_activity_at = now(), idle_since = NULL, updated_at = now()
  WHERE instance_uuid = v_job.instance_uuid;
  RETURN to_jsonb(v_job);
END
$function$;

DROP FUNCTION IF EXISTS autodl_h3_mark_job_progress(text, uuid, text, text, text, text, text, integer, text, text);

-- Worker-only monotonic progress update. Browser status/SSE routes have no
-- owner/token and therefore cannot mutate lifecycle state.
CREATE OR REPLACE FUNCTION autodl_h3_mark_claimed_job_progress(
  p_job_id uuid,
  p_public_task_id text,
  p_user_id text,
  p_owner text,
  p_lease_token bigint,
  p_state text,
  p_upstream_task_id text,
  p_content_url text,
  p_result_asset_url text,
  p_progress integer,
  p_error_code text,
  p_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM autodl_h3_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_job.public_task_id <> p_public_task_id OR v_job.user_id::text <> p_user_id
     OR v_job.lease_owner <> p_owner OR v_job.lease_token <> p_lease_token
     OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= now() THEN
    RETURN NULL;
  END IF;

  IF v_job.state IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED') THEN
    RETURN to_jsonb(v_job);
  END IF;

  IF p_state = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'AUTODL_H3_SUCCESS_REQUIRES_ATOMIC_SETTLEMENT';
  END IF;
  IF autodl_h3_job_rank(v_job.state) IS NOT NULL AND autodl_h3_job_rank(p_state) IS NOT NULL
     AND autodl_h3_job_rank(p_state) < autodl_h3_job_rank(v_job.state) THEN
    RETURN to_jsonb(v_job);
  END IF;
  IF NOT autodl_h3_job_transition_allowed(v_job.state, p_state) THEN
    RAISE EXCEPTION 'AUTODL_H3_ILLEGAL_JOB_TRANSITION_%_TO_%', v_job.state, p_state;
  END IF;

  UPDATE autodl_h3_jobs
  SET
    state = p_state,
    upstream_task_id = COALESCE(p_upstream_task_id, upstream_task_id),
    content_url = COALESCE(p_content_url, content_url),
    result_asset_url = COALESCE(p_result_asset_url, result_asset_url),
    progress = GREATEST(progress, GREATEST(0, LEAST(COALESCE(p_progress, progress), 100))),
    error_code = p_error_code,
    error_message = p_error_message,
    completed_at = CASE
      WHEN p_state IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED') THEN now()
      ELSE completed_at
    END,
    updated_at = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  UPDATE autodl_h3_instance_state
  SET
    activity_epoch = activity_epoch + 1,
    last_activity_at = now(),
    idle_since = NULL,
    updated_at = now()
  WHERE instance_uuid = v_job.instance_uuid;

  RETURN to_jsonb(v_job);
END
$function$;

CREATE OR REPLACE FUNCTION autodl_h3_finalize_video(
  p_job_id uuid,
  p_public_task_id text,
  p_video_task_internal_id text,
  p_user_id text,
  p_model_id text,
  p_upstream_task_id text,
  p_owner text,
  p_lease_token bigint,
  p_result_asset_url text,
  p_price_yuan numeric,
  p_cost_price numeric,
  p_response_ms bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
  v_task video_tasks%ROWTYPE;
  v_model video_models%ROWTYPE;
  v_user users%ROWTYPE;
  v_existing autodl_h3_settlements%ROWTYPE;
  v_charged numeric(14,4) := 0;
  v_balance numeric;
  v_ledger_user_id uuid;
  v_reference text := 'autodl_h3:' || p_public_task_id;
BEGIN
  SELECT * INTO v_job FROM autodl_h3_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.public_task_id IS DISTINCT FROM p_public_task_id
     OR v_job.video_task_internal_id IS DISTINCT FROM p_video_task_internal_id
     OR v_job.user_id::text IS DISTINCT FROM p_user_id
     OR v_job.model_id IS DISTINCT FROM p_model_id
     OR v_job.upstream_task_id IS DISTINCT FROM p_upstream_task_id
     OR v_job.lease_owner IS DISTINCT FROM p_owner OR v_job.lease_token IS DISTINCT FROM p_lease_token
     OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= now() THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_existing FROM autodl_h3_settlements WHERE job_id = p_job_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('committed', true, 'already_committed', true,
      'stable_asset_url', v_existing.stable_asset_url, 'charged_yuan', v_existing.charged_yuan);
  END IF;
  IF v_job.state <> 'FINALIZING' THEN RAISE EXCEPTION 'AUTODL_H3_FINALIZE_STATE_INVALID'; END IF;
  IF p_result_asset_url !~ '^object://tencent_cos/[^?#]+$' THEN RAISE EXCEPTION 'AUTODL_H3_FINALIZE_ASSET_INVALID'; END IF;
  IF p_price_yuan IS NULL OR p_cost_price IS NULL OR p_response_ms IS NULL
     OR p_price_yuan < 0 OR p_cost_price < 0 OR p_response_ms < 0
     OR jsonb_typeof(v_job.request_payload->'billingPriceYuan') <> 'number'
     OR jsonb_typeof(v_job.request_payload->'billingCostPrice') <> 'number'
     OR COALESCE((v_job.request_payload->>'billingPriceYuan')::numeric <> p_price_yuan, true)
     OR COALESCE((v_job.request_payload->>'billingCostPrice')::numeric <> p_cost_price, true) THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_BILLING_SNAPSHOT_MISMATCH';
  END IF;

  SELECT * INTO v_task FROM video_tasks WHERE id::text = p_video_task_internal_id FOR UPDATE;
  IF NOT FOUND OR v_task.user_id::text IS DISTINCT FROM p_user_id
     OR v_task.model_id::text IS DISTINCT FROM p_model_id
     OR v_task.task_id_external::text IS DISTINCT FROM p_public_task_id
     OR v_task.status NOT IN ('pending','queued','processing','finalizing') THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_VIDEO_TASK_MISMATCH';
  END IF;
  SELECT * INTO v_model FROM video_models WHERE id::text = p_model_id;
  IF NOT FOUND OR v_model.provider IS DISTINCT FROM 'autodl_h3_selfhost'
     OR v_model.protocol_type IS DISTINCT FROM 'autodl_h3_selfhost'
     OR v_model.model_name IS DISTINCT FROM 'minimax-h3-turbo'
     OR v_model.api_endpoint IS DISTINCT FROM 'http://127.0.0.1:16011/v1/video/generations'
     OR v_model.api_key IS DISTINCT FROM 'secret://autodl-h3-selfhost'
     OR v_model.is_active IS NOT TRUE OR v_model.is_hidden IS TRUE THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_MODEL_BINDING_INVALID';
  END IF;
  SELECT * INTO v_user FROM users WHERE id::text = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTODL_H3_FINALIZE_USER_MISSING'; END IF;

  -- The production ledgers use uuid user_id while users.id is varchar. The
  -- installed user identifiers are UUID strings; validate before the only
  -- explicit cast so an incompatible account fails closed and rolls back.
  IF p_user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_LEDGER_USER_ID_INVALID';
  END IF;
  v_ledger_user_id := p_user_id::uuid;

  IF COALESCE(v_user.role, 'student') <> 'admin' AND p_price_yuan > 0 THEN
    v_balance := COALESCE(v_user.cash_balance, 0);
    IF v_balance < p_price_yuan THEN
      -- No verified production debt ledger exists. Never publish success
      -- without a verified charge; the exception atomically rolls back every
      -- completion/ledger/lifecycle write in this function.
      RAISE EXCEPTION 'AUTODL_H3_FINALIZE_INSUFFICIENT_CASH';
    END IF;
    v_balance := v_balance - p_price_yuan;
    v_charged := p_price_yuan;
    UPDATE users SET cash_balance = v_balance,
      total_cash_consumed = COALESCE(total_cash_consumed, 0) + p_price_yuan,
      updated_at = now() WHERE id::text = p_user_id;
    INSERT INTO cash_transactions(user_id, amount, balance_after, type, description, reference_id, created_at)
    VALUES (v_ledger_user_id, p_price_yuan, v_balance, 'consume', '视频生成: ' || COALESCE(v_model.name, p_model_id), v_reference, now());
  END IF;

  UPDATE video_tasks SET status = 'completed', video_url = p_result_asset_url,
    storage_url = p_result_asset_url, needs_proxy = false, price_charged = v_charged,
    completed_at = now(), error_message = NULL
  WHERE id::text = p_video_task_internal_id;
  INSERT INTO revenue_records(user_id, model_id, task_id, cost_price, selling_price,
    is_admin, record_type, credits_charged, cash_charged)
  VALUES (v_ledger_user_id, p_model_id, p_public_task_id, p_cost_price, p_price_yuan,
    COALESCE(v_user.role, 'student') = 'admin', 'video', 0, v_charged);
  UPDATE autodl_h3_jobs SET state = 'SUCCEEDED', progress = 100,
    result_asset_url = p_result_asset_url, completed_at = now(), updated_at = now(),
    error_code = NULL, error_message = NULL WHERE id = p_job_id;
  INSERT INTO autodl_h3_settlements(job_id, public_task_id, video_task_internal_id,
    user_id, model_id, upstream_task_id, stable_asset_url, price_yuan, cost_price,
    charged_yuan, response_ms)
  VALUES (p_job_id, p_public_task_id, p_video_task_internal_id, p_user_id, p_model_id,
    p_upstream_task_id, p_result_asset_url, p_price_yuan, p_cost_price, v_charged, p_response_ms);
  UPDATE autodl_h3_instance_state SET activity_epoch = activity_epoch + 1,
    last_activity_at = now(), idle_since = NULL, updated_at = now()
  WHERE instance_uuid = v_job.instance_uuid;
  RETURN jsonb_build_object('committed', true, 'already_committed', false,
    'stable_asset_url', p_result_asset_url, 'charged_yuan', v_charged);
END
$function$;

REVOKE ALL ON FUNCTION autodl_h3_enqueue_job(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_prepare_shutdown(text, text, bigint, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_confirm_shutdown(text, text, bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_acquire_instance_lease(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_renew_instance_lease(text, text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_renew_job_lease(uuid, text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_update_instance_state(text, text, bigint, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_claim_job(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_claim_active_job(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_claim_unknown_dispatch_job(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_transition_claimed_job(uuid, text, bigint, text, text, text, text, integer, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_mark_claimed_job_progress(uuid, text, text, text, bigint, text, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_finalize_video(uuid, text, text, text, text, text, text, bigint, text, numeric, numeric, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_job_transition_allowed(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autodl_h3_job_rank(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION autodl_h3_enqueue_job(text, text, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_prepare_shutdown(text, text, bigint, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_confirm_shutdown(text, text, bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_acquire_instance_lease(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_renew_instance_lease(text, text, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_renew_job_lease(uuid, text, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_update_instance_state(text, text, bigint, text, timestamptz, timestamptz, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_claim_job(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_claim_active_job(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_claim_unknown_dispatch_job(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_transition_claimed_job(uuid, text, bigint, text, text, text, text, integer, timestamptz, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_mark_claimed_job_progress(uuid, text, text, text, bigint, text, text, text, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION autodl_h3_finalize_video(uuid, text, text, text, text, text, text, bigint, text, numeric, numeric, bigint) TO service_role;

COMMIT;
