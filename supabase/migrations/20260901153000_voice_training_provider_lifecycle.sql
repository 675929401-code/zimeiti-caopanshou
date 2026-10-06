-- Durable voice-training provider lifecycle.
-- This migration is source-only until the release operator applies it. Runtime
-- routes fail closed with MIGRATION_NOT_READY when these RPCs are unavailable.

ALTER TABLE public.voice_training_authorization_jobs
  DROP CONSTRAINT IF EXISTS voice_training_authorization_jobs_status_check;

ALTER TABLE public.voice_training_authorization_jobs
  ADD CONSTRAINT voice_training_authorization_jobs_status_check
  CHECK (status IN (
    'pending', 'reserved', 'provider_pending', 'reconciliation_required',
    'completed', 'released'
  ));

ALTER TABLE public.voice_training_authorization_jobs
  ADD COLUMN IF NOT EXISTS provider_call_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_last_status text,
  ADD COLUMN IF NOT EXISTS reconciliation_reason text;

CREATE INDEX IF NOT EXISTS voice_training_reconciliation_idx
  ON public.voice_training_authorization_jobs (status, updated_at)
  WHERE status IN ('provider_pending', 'reconciliation_required');

CREATE OR REPLACE FUNCTION public.claim_voice_training_provider_call_atomic(
  p_user_id text,
  p_job_key text,
  p_operation_kind text,
  p_request_fingerprint text,
  p_provider_speaker_id text,
  p_result_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.voice_training_authorization_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
    FROM public.voice_training_authorization_jobs
   WHERE user_id = trim(p_user_id) AND job_key = trim(p_job_key)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_TRAINING_JOB_NOT_FOUND'; END IF;
  IF v_job.operation_kind <> lower(trim(p_operation_kind))
     OR v_job.request_fingerprint <> p_request_fingerprint THEN
    RAISE EXCEPTION 'VOICE_TRAINING_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_job.provider_call_started_at IS NOT NULL OR v_job.status IN ('provider_pending', 'reconciliation_required', 'completed') THEN
    RETURN jsonb_build_object('success', true, 'claimed', false, 'job', to_jsonb(v_job));
  END IF;
  IF v_job.status <> 'reserved' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_PROVIDER_CLAIM_STATE_INVALID' USING ERRCODE = '55000';
  END IF;
  UPDATE public.voice_training_authorization_jobs
     SET status = 'provider_pending',
         provider_speaker_id = trim(p_provider_speaker_id),
         provider_call_started_at = now(),
         provider_last_checked_at = now(),
         provider_last_status = 'submitting',
         result_payload = coalesce(result_payload, '{}'::jsonb)
           || coalesce(p_result_payload, '{}'::jsonb)
           || jsonb_build_object(
             'speakerId', trim(p_provider_speaker_id),
             'providerCallStarted', true,
             'lifecycleState', 'provider_pending'
           ),
         updated_at = now()
   WHERE id = v_job.id
     AND status = 'reserved'
     AND provider_call_started_at IS NULL
  RETURNING * INTO v_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_TRAINING_PROVIDER_CLAIM_CONFLICT'; END IF;
  RETURN jsonb_build_object('success', true, 'claimed', true, 'job', to_jsonb(v_job));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_voice_training_provider_attempt_atomic(
  p_user_id text,
  p_job_key text,
  p_operation_kind text,
  p_request_fingerprint text,
  p_provider_speaker_id text,
  p_lifecycle_status text,
  p_provider_status text,
  p_result_payload jsonb DEFAULT '{}'::jsonb,
  p_provider_call_started boolean DEFAULT true,
  p_reconciliation_reason text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.voice_training_authorization_jobs%ROWTYPE;
  v_operation text := lower(trim(coalesce(p_operation_kind, '')));
  v_lifecycle text := lower(trim(coalesce(p_lifecycle_status, '')));
BEGIN
  IF v_operation NOT IN ('clone', 'design')
     OR v_lifecycle NOT IN ('provider_pending', 'reconciliation_required') THEN
    RAISE EXCEPTION 'VOICE_TRAINING_LIFECYCLE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF trim(coalesce(p_provider_speaker_id, '')) = '' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_SPEAKER_ID_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job
    FROM public.voice_training_authorization_jobs
   WHERE user_id = trim(p_user_id)
     AND job_key = trim(p_job_key)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_TRAINING_JOB_NOT_FOUND'; END IF;
  IF v_job.operation_kind <> v_operation
     OR v_job.request_fingerprint <> p_request_fingerprint THEN
    RAISE EXCEPTION 'VOICE_TRAINING_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object('success', true, 'already_fulfilled', true, 'job', to_jsonb(v_job));
  END IF;
  IF v_job.status = 'released' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_JOB_RELEASED' USING ERRCODE = '55000';
  END IF;
  IF v_job.status NOT IN ('reserved', 'provider_pending', 'reconciliation_required') THEN
    RAISE EXCEPTION 'VOICE_TRAINING_LIFECYCLE_STATE_INVALID' USING ERRCODE = '55000';
  END IF;

  UPDATE public.voice_training_authorization_jobs
     SET status = v_lifecycle,
         provider_speaker_id = trim(p_provider_speaker_id),
         provider_call_started_at = CASE
           WHEN p_provider_call_started THEN coalesce(provider_call_started_at, now())
           ELSE provider_call_started_at
         END,
         provider_last_checked_at = now(),
         provider_last_status = left(coalesce(p_provider_status, ''), 100),
         reconciliation_reason = CASE
           WHEN v_lifecycle = 'reconciliation_required'
             THEN left(coalesce(p_reconciliation_reason, 'provider_state_unknown'), 500)
           ELSE NULL
         END,
         result_payload = coalesce(result_payload, '{}'::jsonb)
           || coalesce(p_result_payload, '{}'::jsonb)
           || jsonb_build_object(
             'speakerId', trim(p_provider_speaker_id),
             'providerCallStarted', p_provider_call_started,
             'lifecycleState', v_lifecycle
           ),
         updated_at = now()
   WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object('success', true, 'job', to_jsonb(v_job));
END;
$$;

CREATE OR REPLACE FUNCTION public.release_voice_training_terminal_atomic(
  p_user_id text,
  p_job_key text,
  p_operation_kind text,
  p_request_fingerprint text,
  p_terminal_kind text,
  p_reason text DEFAULT 'provider_failed'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.voice_training_authorization_jobs%ROWTYPE;
  v_result jsonb;
  v_terminal text := lower(trim(coalesce(p_terminal_kind, '')));
BEGIN
  IF v_terminal NOT IN ('not_started', 'provider_failed') THEN
    RAISE EXCEPTION 'VOICE_TRAINING_TERMINAL_KIND_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job
    FROM public.voice_training_authorization_jobs
   WHERE user_id = trim(p_user_id) AND job_key = trim(p_job_key)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_TRAINING_JOB_NOT_FOUND'; END IF;
  IF v_job.operation_kind <> lower(trim(p_operation_kind))
     OR v_job.request_fingerprint <> p_request_fingerprint THEN
    RAISE EXCEPTION 'VOICE_TRAINING_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_job.status = 'released' THEN
    RETURN jsonb_build_object('success', true, 'already_released', true, 'status', 'released');
  END IF;
  IF v_terminal = 'not_started'
     AND (v_job.status <> 'reserved' OR v_job.provider_call_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'VOICE_TRAINING_PROVIDER_MAY_HAVE_STARTED' USING ERRCODE = '55000';
  END IF;
  IF v_terminal = 'provider_failed'
     AND (v_job.status NOT IN ('provider_pending', 'reconciliation_required')
          OR lower(coalesce(v_job.provider_last_status, '')) <> 'failed') THEN
    RAISE EXCEPTION 'VOICE_TRAINING_PROVIDER_FAILURE_UNCONFIRMED' USING ERRCODE = '55000';
  END IF;

  -- The legacy release RPC accepts reserved only. The transition and release
  -- occur inside this transaction, so no other session can observe the bridge.
  UPDATE public.voice_training_authorization_jobs
     SET status = 'reserved', updated_at = now()
   WHERE id = v_job.id;
  SELECT public.release_voice_training_authorization_atomic(
    trim(p_user_id), trim(p_job_key), lower(trim(p_operation_kind)),
    p_request_fingerprint, left(coalesce(p_reason, v_terminal), 500)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_voice_training_ready_atomic(
  p_user_id text,
  p_job_key text,
  p_operation_kind text,
  p_request_fingerprint text,
  p_speaker_id text,
  p_voice_name text,
  p_language text,
  p_source_info jsonb DEFAULT '{}'::jsonb,
  p_result_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.voice_training_authorization_jobs%ROWTYPE;
  v_result jsonb;
BEGIN
  IF lower(coalesce(p_result_payload ->> 'status', '')) <> 'ready' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_TERMINAL_READY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job
    FROM public.voice_training_authorization_jobs
   WHERE user_id = trim(p_user_id) AND job_key = trim(p_job_key)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_TRAINING_JOB_NOT_FOUND'; END IF;
  IF v_job.operation_kind <> lower(trim(p_operation_kind))
     OR v_job.request_fingerprint <> p_request_fingerprint THEN
    RAISE EXCEPTION 'VOICE_TRAINING_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true, 'already_fulfilled', true, 'status', v_job.status,
      'voice_id', v_job.voice_id, 'result_payload', v_job.result_payload,
      'used_trainings', v_job.reserved_used_after, 'max_trainings', v_job.max_trainings
    );
  END IF;
  IF v_job.status NOT IN ('provider_pending', 'reconciliation_required')
     OR trim(coalesce(v_job.provider_speaker_id, '')) <> trim(p_speaker_id) THEN
    RAISE EXCEPTION 'VOICE_TRAINING_READY_STATE_INVALID' USING ERRCODE = '55000';
  END IF;

  -- Atomic bridge into the legacy finalizer; rollback restores the lifecycle
  -- state if finalization raises.
  UPDATE public.voice_training_authorization_jobs
     SET status = 'reserved',
         provider_last_status = 'ready',
         provider_last_checked_at = now(),
         result_payload = coalesce(result_payload, '{}'::jsonb) || p_result_payload,
         updated_at = now()
   WHERE id = v_job.id;
  SELECT public.finalize_voice_training_authorization_atomic(
    trim(p_user_id), trim(p_job_key), lower(trim(p_operation_kind)),
    p_request_fingerprint, trim(p_speaker_id), trim(p_voice_name), trim(p_language),
    coalesce(p_source_info, '{}'::jsonb), coalesce(p_result_payload, '{}'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_voice_training_provider_attempt_atomic(text,text,text,text,text,text,text,jsonb,boolean,text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_voice_training_provider_call_atomic(text,text,text,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_voice_training_terminal_atomic(text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_voice_training_ready_atomic(text,text,text,text,text,text,text,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_voice_training_provider_attempt_atomic(text,text,text,text,text,text,text,jsonb,boolean,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_voice_training_provider_call_atomic(text,text,text,text,text,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_voice_training_terminal_atomic(text,text,text,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_voice_training_ready_atomic(text,text,text,text,text,text,text,jsonb,jsonb)
  TO service_role;
