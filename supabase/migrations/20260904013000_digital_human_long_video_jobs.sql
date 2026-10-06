BEGIN;
SET LOCAL lock_timeout = '10s';

-- This migration defines the durable parent/child boundary only. It does not
-- debit a wallet, dispatch a provider request, cut media or merge results.
CREATE TABLE public.digital_human_long_jobs (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 16 AND 100),
  user_id uuid NOT NULL,
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  model_id text NOT NULL,
  protocol_type text NOT NULL DEFAULT 'dashscope_video_retalk'
    CHECK (protocol_type = 'dashscope_video_retalk'),
  source_video_asset_id text NOT NULL CHECK (char_length(source_video_asset_id) BETWEEN 8 AND 200),
  source_audio_asset_id text NOT NULL CHECK (char_length(source_audio_asset_id) BETWEEN 8 AND 200),
  total_duration_seconds numeric(12,3) NOT NULL CHECK (total_duration_seconds > 2),
  planned_segment_count integer NOT NULL CHECK (planned_segment_count BETWEEN 1 AND 1000),
  recommended_segment_seconds numeric(12,3) NOT NULL DEFAULT 115
    CHECK (recommended_segment_seconds > 2 AND recommended_segment_seconds <= 115),
  unit_price_yuan numeric(14,4) NOT NULL CHECK (unit_price_yuan >= 0),
  locked_price_yuan numeric(14,2) NOT NULL CHECK (
    locked_price_yuan >= 0
    AND locked_price_yuan = round(total_duration_seconds * unit_price_yuan, 2)
  ),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued','processing','confirming','failed','cancelled',
    'merging','ready_to_settle','completed'
  )),
  billing_state text NOT NULL DEFAULT 'quote_locked'
    CHECK (billing_state IN ('quote_locked','ready_to_settle','settled','voided')),
  billing_idempotency_key text NOT NULL UNIQUE
    CHECK (char_length(billing_idempotency_key) BETWEEN 8 AND 200),
  billing_operation_id bigint,
  charged_yuan numeric(14,2) NOT NULL DEFAULT 0 CHECK (charged_yuan >= 0),
  merged_asset_id text,
  merged_sha256 text CHECK (merged_sha256 IS NULL OR merged_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, client_request_id),
  UNIQUE (id, user_id),
  CHECK (
    charged_yuan = 0
    OR (
      state = 'completed'
      AND billing_state = 'settled'
      AND charged_yuan = locked_price_yuan
      AND billing_operation_id IS NOT NULL
      AND merged_asset_id IS NOT NULL
      AND merged_sha256 IS NOT NULL
    )
  ),
  CHECK (
    state <> 'completed'
    OR (
      billing_state = 'settled'
      AND charged_yuan = locked_price_yuan
      AND merged_asset_id IS NOT NULL
      AND merged_sha256 IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE TABLE public.digital_human_long_segments (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 16 AND 120),
  parent_id text NOT NULL,
  user_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  start_seconds numeric(12,3) NOT NULL CHECK (start_seconds >= 0),
  end_seconds numeric(12,3) NOT NULL,
  duration_seconds numeric(12,3) NOT NULL CHECK (duration_seconds > 2 AND duration_seconds <= 115),
  boundary_kind text NOT NULL CHECK (boundary_kind IN ('manual','silence','sentence','planned','media_end')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued','dispatching','running','submission_unknown','completed','failed','cancelled'
  )),
  video_task_id text UNIQUE REFERENCES public.video_tasks(id),
  result_asset_id text,
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (parent_id, ordinal),
  FOREIGN KEY (parent_id, user_id)
    REFERENCES public.digital_human_long_jobs(id, user_id) ON DELETE CASCADE,
  CHECK (end_seconds > start_seconds),
  CHECK (abs(duration_seconds - (end_seconds - start_seconds)) < 0.001),
  CHECK (
    state <> 'completed'
    OR (
      video_task_id IS NOT NULL
      AND result_asset_id IS NOT NULL
      AND result_sha256 IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX digital_human_long_jobs_user_created
  ON public.digital_human_long_jobs(user_id, created_at DESC);
CREATE INDEX digital_human_long_jobs_state
  ON public.digital_human_long_jobs(state, updated_at);
CREATE INDEX digital_human_long_segments_parent
  ON public.digital_human_long_segments(parent_id, ordinal);
CREATE INDEX digital_human_long_segments_state
  ON public.digital_human_long_segments(state, updated_at);

ALTER TABLE public.digital_human_long_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_human_long_segments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.digital_human_long_jobs, public.digital_human_long_segments
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.digital_human_long_jobs, public.digital_human_long_segments
  TO service_role;

-- Reserves one immutable parent plan and all child time ranges atomically.
-- An identical client request is idempotent; a changed fingerprint conflicts.
CREATE FUNCTION public.reserve_digital_human_long_job(p_parent jsonb, p_segments jsonb)
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
  v_locked_price numeric;
  v_user_id uuid;
BEGIN
  IF jsonb_typeof(p_parent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_segments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_segments) < 1
     OR jsonb_array_length(p_segments) > 1000
     OR pg_column_size(p_parent) > 16000
     OR pg_column_size(p_segments) > 128000 THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_PLAN_INVALID';
  END IF;

  v_user_id := (p_parent ->> 'userId')::uuid;
  v_total := (p_parent ->> 'totalDurationSeconds')::numeric;
  v_unit_price := (p_parent ->> 'unitPriceYuan')::numeric;
  v_locked_price := (p_parent ->> 'lockedPriceYuan')::numeric;
  IF coalesce(p_parent ->> 'protocolType', '') <> 'dashscope_video_retalk'
     OR coalesce(p_parent ->> 'requestFingerprint', '') !~ '^[0-9a-f]{64}$'
     OR v_total <= 2
     OR v_unit_price < 0
     OR v_locked_price <> round(v_total * v_unit_price, 2)
     OR jsonb_array_length(p_segments) <> (p_parent ->> 'plannedSegmentCount')::integer THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_PLAN_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'digital-human-long:' || v_user_id::text || ':' || coalesce(p_parent ->> 'clientRequestId', ''),
    0
  ));
  SELECT * INTO v_existing
    FROM public.digital_human_long_jobs
    WHERE user_id = v_user_id AND client_request_id = p_parent ->> 'clientRequestId';
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_parent ->> 'requestFingerprint' THEN
      RAISE EXCEPTION 'VIDEO_REQUEST_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN jsonb_build_object('created', false, 'id', v_existing.id, 'state', v_existing.state);
  END IF;

  INSERT INTO public.digital_human_long_jobs(
    id,user_id,client_request_id,request_fingerprint,model_id,protocol_type,
    source_video_asset_id,source_audio_asset_id,total_duration_seconds,
    planned_segment_count,recommended_segment_seconds,unit_price_yuan,
    locked_price_yuan,billing_idempotency_key
  ) VALUES (
    p_parent ->> 'id',v_user_id,p_parent ->> 'clientRequestId',
    p_parent ->> 'requestFingerprint',p_parent ->> 'modelId',p_parent ->> 'protocolType',
    p_parent ->> 'sourceVideoAssetId',p_parent ->> 'sourceAudioAssetId',v_total,
    (p_parent ->> 'plannedSegmentCount')::integer,
    (p_parent ->> 'recommendedSegmentSeconds')::numeric,v_unit_price,v_locked_price,
    p_parent ->> 'billingIdempotencyKey'
  );

  FOR v_segment IN
    SELECT value FROM jsonb_array_elements(p_segments)
    ORDER BY (value ->> 'ordinal')::integer
  LOOP
    v_start := (v_segment ->> 'startSeconds')::numeric;
    v_end := (v_segment ->> 'endSeconds')::numeric;
    v_duration := (v_segment ->> 'durationSeconds')::numeric;
    IF (v_segment ->> 'ordinal')::integer <> v_expected_ordinal
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

REVOKE ALL ON FUNCTION public.reserve_digital_human_long_job(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_digital_human_long_job(jsonb, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
