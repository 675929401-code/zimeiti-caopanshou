BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.digital_human_long_jobs
  ADD COLUMN provider_key text CHECK (provider_key IS NULL OR provider_key ~ '^[0-9a-f]{64}$'),
  ADD COLUMN model_hash text CHECK (model_hash IS NULL OR model_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN resolution text NOT NULL DEFAULT '720p' CHECK (resolution = '720p'),
  ADD COLUMN source_video_duration_seconds numeric(12,3) CHECK (source_video_duration_seconds > 2),
  ADD COLUMN source_audio_duration_seconds numeric(12,3) CHECK (source_audio_duration_seconds > 2),
  ADD COLUMN video_extension boolean NOT NULL DEFAULT false,
  ADD COLUMN billing_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN unit_cost_yuan numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost_yuan >= 0),
  ADD COLUMN locked_cost_yuan numeric(14,4) NOT NULL DEFAULT 0 CHECK (locked_cost_yuan >= 0),
  ADD COLUMN merged_storage_url text,
  ADD COLUMN merge_lease_owner text,
  ADD COLUMN merge_lease_until timestamptz,
  ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revenue_recorded_at timestamptz;

ALTER TABLE public.digital_human_long_jobs
  ALTER COLUMN billing_operation_id TYPE text USING billing_operation_id::text;

ALTER TABLE public.digital_human_long_segments
  DROP CONSTRAINT IF EXISTS digital_human_long_segments_state_check;

-- The foundation allowed child rows to point at ordinary video_tasks. The
-- isolated long worker stores the provider receipt directly, so replace only
-- that generated completion check without guessing PostgreSQL's auto name.
DO $$
DECLARE v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.digital_human_long_segments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%video_task_id IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE public.digital_human_long_segments DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$$;

DO $$
DECLARE v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.digital_human_long_jobs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%locked_price_yuan = round%total_duration_seconds%unit_price_yuan%'
  LOOP
    EXECUTE format('ALTER TABLE public.digital_human_long_jobs DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.digital_human_long_segments
  ADD CONSTRAINT digital_human_long_segments_state_check CHECK (state IN (
    'queued','preparing','dispatching','running','submission_unknown',
    'finalizing','completed','failed','cancelled'
  )),
  ADD COLUMN prepared_person_asset_id text,
  ADD COLUMN prepared_audio_asset_id text,
  ADD COLUMN provider_task_id text,
  ADD COLUMN provider_result_url text,
  ADD COLUMN result_storage_url text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20);

ALTER TABLE public.digital_human_long_segments
  ADD CONSTRAINT digital_human_long_segments_completed_result_check CHECK (
    state <> 'completed'
    OR (
      provider_task_id IS NOT NULL
      AND result_asset_id IS NOT NULL
      AND result_storage_url IS NOT NULL
      AND result_sha256 IS NOT NULL
      AND completed_at IS NOT NULL
    )
  );

ALTER TABLE public.digital_human_long_jobs
  ADD CONSTRAINT digital_human_long_jobs_locked_price_check CHECK (
    (billing_exempt AND locked_price_yuan = 0)
    OR (NOT billing_exempt AND locked_price_yuan = round(total_duration_seconds * unit_price_yuan, 2))
  ),
  ADD CONSTRAINT digital_human_long_jobs_completed_delivery_check CHECK (
    state <> 'completed'
    OR (
      billing_state = 'settled'
      AND ((billing_exempt AND billing_operation_id IS NULL) OR (NOT billing_exempt AND billing_operation_id IS NOT NULL))
      AND merged_asset_id IS NOT NULL
      AND merged_storage_url IS NOT NULL
      AND merged_sha256 IS NOT NULL
      AND completed_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX digital_human_long_segments_provider_task
  ON public.digital_human_long_segments(provider_task_id)
  WHERE provider_task_id IS NOT NULL;
CREATE INDEX digital_human_long_segments_ready
  ON public.digital_human_long_segments(state, next_run_at, created_at);
CREATE INDEX digital_human_long_jobs_provider
  ON public.digital_human_long_jobs(provider_key, state);

CREATE FUNCTION public.guard_digital_human_long_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.model_hash IS DISTINCT FROM OLD.model_hash
     OR NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.protocol_type IS DISTINCT FROM OLD.protocol_type
     OR NEW.source_video_asset_id IS DISTINCT FROM OLD.source_video_asset_id
     OR NEW.source_audio_asset_id IS DISTINCT FROM OLD.source_audio_asset_id
     OR NEW.total_duration_seconds IS DISTINCT FROM OLD.total_duration_seconds
     OR NEW.planned_segment_count IS DISTINCT FROM OLD.planned_segment_count
     OR NEW.unit_price_yuan IS DISTINCT FROM OLD.unit_price_yuan
     OR NEW.locked_price_yuan IS DISTINCT FROM OLD.locked_price_yuan
     OR NEW.billing_exempt IS DISTINCT FROM OLD.billing_exempt
     OR NEW.unit_cost_yuan IS DISTINCT FROM OLD.unit_cost_yuan
     OR NEW.locked_cost_yuan IS DISTINCT FROM OLD.locked_cost_yuan THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_SNAPSHOT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_digital_human_long_snapshot_immutable
  BEFORE UPDATE ON public.digital_human_long_jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_digital_human_long_snapshot_immutable();

-- Replace the initial plan reservation with the immutable provider and price
-- snapshot required by the runtime. It still does not debit a wallet.
CREATE OR REPLACE FUNCTION public.reserve_digital_human_long_job(p_parent jsonb, p_segments jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.digital_human_long_jobs%ROWTYPE;
  v_segment jsonb;
  v_expected_ordinal integer := 0;
  v_previous_end numeric := 0;
  v_start numeric;
  v_end numeric;
  v_duration numeric;
  v_total numeric;
  v_unit_price numeric;
  v_unit_cost numeric;
  v_locked_price numeric;
  v_locked_cost numeric;
  v_user_id uuid;
  v_billing_exempt boolean;
BEGIN
  IF jsonb_typeof(p_parent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_segments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_segments) < 2
     OR jsonb_array_length(p_segments) > 1000
     OR pg_column_size(p_parent) > 16000
     OR pg_column_size(p_segments) > 128000 THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_PLAN_INVALID';
  END IF;

  v_user_id := (p_parent ->> 'userId')::uuid;
  v_total := (p_parent ->> 'totalDurationSeconds')::numeric;
  v_unit_price := (p_parent ->> 'unitPriceYuan')::numeric;
  v_unit_cost := (p_parent ->> 'unitCostYuan')::numeric;
  v_locked_price := (p_parent ->> 'lockedPriceYuan')::numeric;
  v_locked_cost := (p_parent ->> 'lockedCostYuan')::numeric;
  v_billing_exempt := coalesce((p_parent ->> 'billingExempt')::boolean, false);
  IF coalesce(p_parent ->> 'id', '') !~ '^dhl_[0-9a-f]{40}$'
     OR coalesce(p_parent ->> 'protocolType', '') <> 'dashscope_video_retalk'
     OR coalesce(p_parent ->> 'requestFingerprint', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_parent ->> 'providerKey', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_parent ->> 'modelHash', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_parent ->> 'sourceVideoAssetId', '') !~ '^[0-9a-f-]{36}$'
     OR coalesce(p_parent ->> 'sourceAudioAssetId', '') !~ '^[0-9a-f-]{36}$'
     OR v_total <= 115
     OR v_unit_price <= 0 OR v_unit_cost < 0
     OR (v_billing_exempt AND v_locked_price <> 0)
     OR (NOT v_billing_exempt AND v_locked_price <> round(v_total * v_unit_price, 2))
     OR v_locked_cost <> round(v_total * v_unit_cost, 4)
     OR jsonb_array_length(p_segments) <> (p_parent ->> 'plannedSegmentCount')::integer
     OR (p_parent ->> 'recommendedSegmentSeconds')::numeric <> 115
     OR (p_parent ->> 'sourceVideoDurationSeconds')::numeric <= 2
     OR (p_parent ->> 'sourceAudioDurationSeconds')::numeric <= 2 THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_PLAN_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('digital-human-account:' || v_user_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'digital-human-long:' || v_user_id::text || ':' || coalesce(p_parent ->> 'clientRequestId', ''), 0
  ));

  SELECT * INTO v_existing
    FROM public.digital_human_long_jobs
    WHERE user_id = v_user_id AND client_request_id = p_parent ->> 'clientRequestId';
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_parent ->> 'requestFingerprint'
       OR v_existing.provider_key IS DISTINCT FROM p_parent ->> 'providerKey'
       OR v_existing.model_hash IS DISTINCT FROM p_parent ->> 'modelHash' THEN
      RAISE EXCEPTION 'VIDEO_REQUEST_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN jsonb_build_object('created', false, 'id', v_existing.id, 'state', v_existing.state);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.digital_human_long_jobs
    WHERE user_id = v_user_id AND state NOT IN ('completed','failed','cancelled')
  ) OR EXISTS (
    SELECT 1 FROM public.video_tasks
    WHERE user_id = v_user_id AND task_label LIKE 'digital-human:%'
      AND status NOT IN ('completed','failed','cancelled','expired')
  ) THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_ACCOUNT_BUSY';
  END IF;

  INSERT INTO public.digital_human_long_jobs(
    id,user_id,client_request_id,request_fingerprint,model_id,protocol_type,
    provider_key,model_hash,source_video_asset_id,source_audio_asset_id,
    source_video_duration_seconds,source_audio_duration_seconds,video_extension,billing_exempt,
    total_duration_seconds,planned_segment_count,recommended_segment_seconds,
    resolution,unit_price_yuan,unit_cost_yuan,locked_price_yuan,locked_cost_yuan,
    billing_idempotency_key
  ) VALUES (
    p_parent ->> 'id',v_user_id,p_parent ->> 'clientRequestId',
    p_parent ->> 'requestFingerprint',p_parent ->> 'modelId',p_parent ->> 'protocolType',
    p_parent ->> 'providerKey',p_parent ->> 'modelHash',
    p_parent ->> 'sourceVideoAssetId',p_parent ->> 'sourceAudioAssetId',
    (p_parent ->> 'sourceVideoDurationSeconds')::numeric,
    (p_parent ->> 'sourceAudioDurationSeconds')::numeric,
    (p_parent ->> 'videoExtension')::boolean,v_billing_exempt,v_total,
    (p_parent ->> 'plannedSegmentCount')::integer,
    (p_parent ->> 'recommendedSegmentSeconds')::numeric,
    p_parent ->> 'resolution',v_unit_price,v_unit_cost,v_locked_price,v_locked_cost,
    p_parent ->> 'billingIdempotencyKey'
  );

  FOR v_segment IN
    SELECT value FROM jsonb_array_elements(p_segments)
    ORDER BY (value ->> 'ordinal')::integer
  LOOP
    v_start := (v_segment ->> 'startSeconds')::numeric;
    v_end := (v_segment ->> 'endSeconds')::numeric;
    v_duration := (v_segment ->> 'durationSeconds')::numeric;
    IF coalesce(v_segment ->> 'id', '') !~ '^dhls_[0-9a-f]{40}$'
       OR (v_segment ->> 'ordinal')::integer <> v_expected_ordinal
       OR abs(v_start - v_previous_end) >= 0.001
       OR v_duration <= 2 OR v_duration > 115
       OR abs(v_duration - (v_end - v_start)) >= 0.001 THEN
      RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_SEGMENT_INVALID';
    END IF;
    INSERT INTO public.digital_human_long_segments(
      id,parent_id,user_id,ordinal,start_seconds,end_seconds,duration_seconds,boundary_kind
    ) VALUES (
      v_segment ->> 'id',p_parent ->> 'id',v_user_id,v_expected_ordinal,
      v_start,v_end,v_duration,v_segment ->> 'boundaryKind'
    );
    v_previous_end := v_end;
    v_expected_ordinal := v_expected_ordinal + 1;
  END LOOP;
  IF abs(v_previous_end - v_total) >= 0.001 THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_SEGMENTS_INCOMPLETE';
  END IF;
  RETURN jsonb_build_object('created', true, 'id', p_parent ->> 'id', 'state', 'queued');
END;
$$;

-- Ordinary digital-human submissions cannot enter while an account owns an
-- active long parent. The long worker does not create video_tasks rows.
CREATE OR REPLACE FUNCTION public.guard_video_task_against_active_long_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(NEW.task_label, '') LIKE 'digital-human:%'
     AND EXISTS (
       SELECT 1 FROM public.digital_human_long_jobs
       WHERE user_id = NEW.user_id AND state NOT IN ('completed','failed','cancelled')
     ) THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_ACCOUNT_BUSY';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_video_task_against_active_long_job ON public.video_tasks;
CREATE TRIGGER guard_video_task_against_active_long_job
  BEFORE INSERT ON public.video_tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_video_task_against_active_long_job();

-- Bidirectional provider-key exclusion, long queue side. Expired leases are
-- recoverable; a crashed POST with no saved provider id becomes unknown and is
-- never submitted again automatically.
CREATE FUNCTION public.claim_digital_human_long_segment(p_worker text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_segment public.digital_human_long_segments%ROWTYPE;
  v_parent public.digital_human_long_jobs%ROWTYPE;
  v_claim record;
BEGIN
  IF length(p_worker) < 16 OR length(p_worker) > 100 THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_WORKER_INVALID';
  END IF;
  UPDATE public.digital_human_long_segments
    SET state = 'queued', lease_owner = NULL, lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE state = 'preparing' AND lease_until < now();
  UPDATE public.digital_human_long_segments
    SET state = CASE WHEN provider_task_id IS NULL THEN 'submission_unknown' ELSE 'running' END,
        lease_owner = NULL, lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE state = 'dispatching' AND lease_until < now();
  UPDATE public.digital_human_long_segments
    SET lease_owner = NULL, lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE state IN ('running','finalizing') AND lease_until < now();

  FOR v_claim IN
    SELECT s, p FROM public.digital_human_long_segments s
    JOIN public.digital_human_long_jobs p ON p.id = s.parent_id
    WHERE p.state IN ('queued','processing','confirming')
      AND s.state IN ('queued','running','finalizing')
      AND s.next_run_at <= now()
      AND (s.lease_until IS NULL OR s.lease_until < now())
      AND NOT EXISTS (
        SELECT 1 FROM public.digital_human_long_segments prior
        WHERE prior.parent_id = s.parent_id AND prior.ordinal < s.ordinal AND prior.state <> 'completed'
      )
    ORDER BY CASE s.state WHEN 'running' THEN 0 WHEN 'finalizing' THEN 1 ELSE 2 END,
             p.created_at, s.ordinal
    LIMIT 100
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    v_segment := v_claim.s;
    v_parent := v_claim.p;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('digital-video-channel:' || v_parent.provider_key, 0)) THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.digital_video_dispatch_jobs
      WHERE provider_key = v_parent.provider_key
        AND state IN ('dispatching','running','submission_unknown','finalizing')
    ) THEN CONTINUE; END IF;
    IF v_segment.state = 'queued' AND EXISTS (
        SELECT 1 FROM public.digital_human_long_segments other
        JOIN public.digital_human_long_jobs other_parent ON other_parent.id = other.parent_id
        WHERE other_parent.provider_key = v_parent.provider_key AND other.id <> v_segment.id
          AND other.state IN ('preparing','dispatching','running','submission_unknown','finalizing')
    ) THEN CONTINUE; END IF;

    UPDATE public.digital_human_long_segments
      SET state = CASE WHEN v_segment.state = 'queued' THEN 'preparing' ELSE v_segment.state END,
          lease_owner = p_worker, lease_until = now() + interval '10 minutes',
          attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = v_segment.id RETURNING * INTO v_segment;
    UPDATE public.digital_human_long_jobs
      SET state = 'processing', updated_at = now()
      WHERE id = v_parent.id AND state IN ('queued','processing','confirming');
    RETURN to_jsonb(v_segment) || jsonb_build_object('parent', to_jsonb(v_parent));
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.retry_digital_human_long_segment(
  p_segment_id text, p_worker text, p_error_code text, p_error_message text, p_delay_seconds integer DEFAULT 10
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.digital_human_long_segments
    SET state = 'queued', lease_owner = NULL, lease_until = NULL,
        next_run_at = now() + make_interval(secs => greatest(2, least(p_delay_seconds, 300))),
        error_code = p_error_code, error_message = left(p_error_message, 500), updated_at = now()
    WHERE id = p_segment_id AND lease_owner = p_worker AND state = 'preparing'
      AND attempt_count < 4;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.prepare_digital_human_long_segment(
  p_segment_id text, p_worker text, p_person_asset_id text, p_audio_asset_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.digital_human_long_segments
    SET prepared_person_asset_id = p_person_asset_id, prepared_audio_asset_id = p_audio_asset_id,
        updated_at = now()
    WHERE id = p_segment_id AND lease_owner = p_worker AND state = 'preparing'
      AND p_person_asset_id ~ '^[0-9a-f-]{36}$' AND p_audio_asset_id ~ '^[0-9a-f-]{36}$';
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.begin_digital_human_long_segment_post(p_segment_id text, p_worker text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.digital_human_long_segments
    SET state = 'dispatching', lease_until = now() + interval '10 minutes', updated_at = now()
    WHERE id = p_segment_id AND lease_owner = p_worker AND state = 'preparing'
      AND lease_until > now() AND prepared_person_asset_id IS NOT NULL AND prepared_audio_asset_id IS NOT NULL;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.bind_digital_human_long_segment_provider(
  p_segment_id text, p_worker text, p_provider_task_id text, p_state text, p_result_url text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_state NOT IN ('running','finalizing') OR trim(coalesce(p_provider_task_id,'')) = '' THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_PROVIDER_RECEIPT_INVALID';
  END IF;
  UPDATE public.digital_human_long_segments
    SET provider_task_id = p_provider_task_id, provider_result_url = p_result_url,
        state = p_state, lease_owner = NULL, lease_until = NULL,
        next_run_at = now() + interval '5 seconds', error_code = NULL, error_message = NULL,
        updated_at = now()
    WHERE id = p_segment_id AND lease_owner = p_worker AND state = 'dispatching'
      AND (provider_task_id IS NULL OR provider_task_id = p_provider_task_id);
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.update_digital_human_long_segment(
  p_segment_id text, p_worker text, p_state text, p_result_url text DEFAULT NULL,
  p_error_code text DEFAULT NULL, p_error_message text DEFAULT NULL, p_delay_seconds integer DEFAULT 10
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_parent_id text;
BEGIN
  IF p_state NOT IN ('running','finalizing','submission_unknown','failed') THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_SEGMENT_STATE_INVALID';
  END IF;
  UPDATE public.digital_human_long_segments
    SET state = p_state, provider_result_url = coalesce(p_result_url, provider_result_url),
        error_code = p_error_code, error_message = left(p_error_message, 500),
        lease_owner = NULL, lease_until = NULL,
        next_run_at = now() + make_interval(secs => greatest(2, least(p_delay_seconds, 300))),
        updated_at = now()
    WHERE id = p_segment_id AND lease_owner = p_worker
      AND state IN ('preparing','dispatching','running','finalizing')
    RETURNING parent_id INTO v_parent_id;
  IF v_parent_id IS NULL THEN RETURN false; END IF;
  UPDATE public.digital_human_long_jobs SET
    state = CASE p_state WHEN 'failed' THEN 'failed' WHEN 'submission_unknown' THEN 'confirming' ELSE 'processing' END,
    billing_state = CASE WHEN p_state = 'failed' THEN 'voided' ELSE billing_state END,
    error_code = p_error_code, error_message = left(p_error_message, 500), updated_at = now()
    WHERE id = v_parent_id AND state NOT IN ('completed','cancelled');
  RETURN true;
END;
$$;

CREATE FUNCTION public.complete_digital_human_long_segment(
  p_segment_id text, p_worker text, p_result_asset_id text,
  p_result_storage_url text, p_result_sha256 text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_parent_id text;
BEGIN
  IF p_result_asset_id !~ '^[0-9a-f-]{36}$'
     OR p_result_storage_url !~ '^object://tencent_cos/[^?#]+$'
     OR p_result_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_RESULT_INVALID';
  END IF;
  UPDATE public.digital_human_long_segments
    SET state = 'completed', result_asset_id = p_result_asset_id,
        result_storage_url = p_result_storage_url, result_sha256 = p_result_sha256,
        lease_owner = NULL, lease_until = NULL, completed_at = now(), updated_at = now(),
        error_code = NULL, error_message = NULL
    WHERE id = p_segment_id AND lease_owner = p_worker AND state = 'finalizing'
    RETURNING parent_id INTO v_parent_id;
  IF v_parent_id IS NULL THEN RETURN false; END IF;
  UPDATE public.digital_human_long_jobs
    SET state = 'processing', error_code = NULL, error_message = NULL, updated_at = now(), next_run_at = now()
    WHERE id = v_parent_id AND state IN ('processing','confirming');
  RETURN true;
END;
$$;

CREATE FUNCTION public.claim_digital_human_long_finalization(p_worker text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_parent public.digital_human_long_jobs%ROWTYPE;
BEGIN
  UPDATE public.digital_human_long_jobs
    SET merge_lease_owner = NULL, merge_lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE state IN ('merging','ready_to_settle') AND merge_lease_until < now();
  SELECT * INTO v_parent FROM public.digital_human_long_jobs p
    WHERE p.state IN ('processing','merging','ready_to_settle')
      AND p.next_run_at <= now() AND (p.merge_lease_until IS NULL OR p.merge_lease_until < now())
      AND (
        p.state = 'ready_to_settle'
        OR NOT EXISTS (
          SELECT 1 FROM public.digital_human_long_segments s
          WHERE s.parent_id = p.id AND s.state <> 'completed'
        )
      )
    ORDER BY p.created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.digital_human_long_jobs
    SET state = CASE WHEN v_parent.state = 'ready_to_settle' THEN v_parent.state ELSE 'merging' END,
        merge_lease_owner = p_worker, merge_lease_until = now() + interval '15 minutes', updated_at = now()
    WHERE id = v_parent.id RETURNING * INTO v_parent;
  RETURN to_jsonb(v_parent);
END;
$$;

CREATE FUNCTION public.mark_digital_human_long_job_merged(
  p_parent_id text, p_worker text, p_asset_id text, p_storage_url text, p_sha256 text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_asset_id !~ '^[0-9a-f-]{36}$' OR p_storage_url !~ '^object://tencent_cos/[^?#]+$'
     OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_MERGE_INVALID'; END IF;
  UPDATE public.digital_human_long_jobs p SET
    merged_asset_id = p_asset_id, merged_storage_url = p_storage_url, merged_sha256 = p_sha256,
    state = 'ready_to_settle', billing_state = 'ready_to_settle',
    merge_lease_owner = NULL, merge_lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE p.id = p_parent_id AND p.merge_lease_owner = p_worker AND p.state = 'merging'
      AND NOT EXISTS (
        SELECT 1 FROM public.digital_human_long_segments s
        WHERE s.parent_id = p.id AND s.state <> 'completed'
      );
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.finalize_digital_human_long_job(
  p_parent_id text, p_worker text, p_billing_operation_id text, p_charged_yuan numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_parent public.digital_human_long_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_parent FROM public.digital_human_long_jobs WHERE id = p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_NOT_FOUND'; END IF;
  IF v_parent.state = 'completed' THEN
    RETURN jsonb_build_object('completed', true, 'alreadyCompleted', true, 'chargedYuan', v_parent.charged_yuan);
  END IF;
  IF v_parent.state <> 'ready_to_settle' OR v_parent.merge_lease_owner IS DISTINCT FROM p_worker
     OR v_parent.merged_asset_id IS NULL OR v_parent.merged_storage_url IS NULL OR v_parent.merged_sha256 IS NULL
     OR round(p_charged_yuan, 2) <> v_parent.locked_price_yuan
     OR (v_parent.locked_price_yuan > 0 AND trim(coalesce(p_billing_operation_id,'')) = '') THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_SETTLEMENT_INVALID';
  END IF;
  UPDATE public.digital_human_long_jobs SET
    state = 'completed', billing_state = 'settled', billing_operation_id = nullif(trim(p_billing_operation_id),''),
    charged_yuan = v_parent.locked_price_yuan, completed_at = now(),
    merge_lease_owner = NULL, merge_lease_until = NULL, updated_at = now()
    WHERE id = p_parent_id;
  RETURN jsonb_build_object('completed', true, 'alreadyCompleted', false, 'chargedYuan', v_parent.locked_price_yuan);
END;
$$;

CREATE FUNCTION public.cancel_digital_human_long_job(p_parent_id text, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_parent public.digital_human_long_jobs%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('digital-human-account:' || p_user_id::text, 0));
  SELECT * INTO v_parent FROM public.digital_human_long_jobs
    WHERE id = p_parent_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_parent.state = 'cancelled' THEN RETURN 'cancelled'; END IF;
  IF v_parent.state IN ('completed','failed') OR EXISTS (
    SELECT 1 FROM public.digital_human_long_segments WHERE parent_id = p_parent_id
      AND state IN ('dispatching','running','submission_unknown','finalizing','completed')
  ) THEN RETURN 'started'; END IF;
  UPDATE public.digital_human_long_segments SET state = 'cancelled', lease_owner = NULL, lease_until = NULL,
    completed_at = now(), updated_at = now() WHERE parent_id = p_parent_id AND state IN ('queued','preparing');
  UPDATE public.digital_human_long_jobs SET state = 'cancelled', billing_state = 'voided', charged_yuan = 0,
    error_message = '已取消排队，本次未扣费', completed_at = now(), updated_at = now()
    WHERE id = p_parent_id;
  RETURN 'cancelled';
END;
$$;

-- Replace only the ordinary claim RPC, preserving its existing behavior and
-- adding the reverse side of the provider-key exclusion.
CREATE OR REPLACE FUNCTION public.claim_digital_video_dispatch(p_worker text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.digital_video_dispatch_jobs%ROWTYPE; v_count integer;
BEGIN
  IF length(p_worker)<16 OR length(p_worker)>100 THEN RAISE EXCEPTION 'DIGITAL_QUEUE_WORKER_INVALID'; END IF;
  UPDATE public.digital_video_dispatch_jobs q SET state=CASE WHEN t.task_id_external IS NOT NULL THEN 'running' ELSE 'submission_unknown' END,
    error_code=CASE WHEN t.task_id_external IS NULL THEN 'VIDEO_SUBMIT_OUTCOME_UNKNOWN' ELSE NULL END,
    error_message=CASE WHEN t.task_id_external IS NULL THEN '正在确认原任务，请勿重复生成' ELSE NULL END,
    lease_until=NULL,next_run_at=now(),updated_at=now()
    FROM public.video_tasks t WHERE t.id=q.task_id AND q.state='dispatching' AND q.lease_until<now();
  UPDATE public.digital_video_dispatch_jobs q SET state='running',error_code=NULL,error_message=NULL,next_run_at=now(),updated_at=now()
    FROM public.video_tasks t WHERE t.id=q.task_id AND q.state='submission_unknown'
      AND q.error_code IN ('VIDEO_SUBMIT_OUTCOME_UNKNOWN','VIDEO_PROVIDER_TASK_ID_MISSING') AND t.task_id_external IS NOT NULL;
  FOR j IN SELECT * FROM public.digital_video_dispatch_jobs
    WHERE state IN ('queued','running','finalizing') AND next_run_at<=now()
      AND (lease_until IS NULL OR lease_until<now())
    ORDER BY CASE WHEN state='queued' THEN 1 ELSE 0 END,next_run_at,created_at
    LIMIT 100 FOR UPDATE SKIP LOCKED
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.digital_human_long_segments s
      JOIN public.digital_human_long_jobs p ON p.id=s.parent_id
      WHERE p.provider_key=j.provider_key
        AND s.state IN ('preparing','dispatching','running','submission_unknown','finalizing')
    ) THEN CONTINUE; END IF;
    IF j.state='queued' THEN
      IF NOT pg_try_advisory_xact_lock(hashtextextended('digital-video-channel:'||j.provider_key,0)) THEN CONTINUE; END IF;
      SELECT count(*) INTO v_count FROM public.digital_video_dispatch_jobs
        WHERE provider_key=j.provider_key AND state IN ('dispatching','running','submission_unknown');
      IF v_count>=1 THEN CONTINUE; END IF;
    END IF;
    UPDATE public.digital_video_dispatch_jobs SET state=CASE WHEN j.state='queued' THEN 'dispatching' ELSE j.state END,
      lease_owner=p_worker,lease_until=now()+interval '5 minutes',updated_at=now()
      WHERE task_id=j.task_id RETURNING * INTO j;
    RETURN to_jsonb(j);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_video_task_against_active_long_job(),
  public.guard_digital_human_long_snapshot_immutable(),
  public.claim_digital_human_long_segment(text),
  public.retry_digital_human_long_segment(text,text,text,text,integer),
  public.prepare_digital_human_long_segment(text,text,text,text),
  public.begin_digital_human_long_segment_post(text,text),
  public.bind_digital_human_long_segment_provider(text,text,text,text,text),
  public.update_digital_human_long_segment(text,text,text,text,text,text,integer),
  public.complete_digital_human_long_segment(text,text,text,text,text),
  public.claim_digital_human_long_finalization(text),
  public.mark_digital_human_long_job_merged(text,text,text,text,text),
  public.finalize_digital_human_long_job(text,text,text,numeric),
  public.cancel_digital_human_long_job(text,uuid),
  public.reserve_digital_human_long_job(jsonb,jsonb),
  public.claim_digital_video_dispatch(text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_digital_human_long_segment(text),
  public.retry_digital_human_long_segment(text,text,text,text,integer),
  public.prepare_digital_human_long_segment(text,text,text,text),
  public.begin_digital_human_long_segment_post(text,text),
  public.bind_digital_human_long_segment_provider(text,text,text,text,text),
  public.update_digital_human_long_segment(text,text,text,text,text,text,integer),
  public.complete_digital_human_long_segment(text,text,text,text,text),
  public.claim_digital_human_long_finalization(text),
  public.mark_digital_human_long_job_merged(text,text,text,text,text),
  public.finalize_digital_human_long_job(text,text,text,numeric),
  public.cancel_digital_human_long_job(text,uuid),
  public.reserve_digital_human_long_job(jsonb,jsonb),
  public.claim_digital_video_dispatch(text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
