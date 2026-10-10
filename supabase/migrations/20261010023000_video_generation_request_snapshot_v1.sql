-- Durable, versioned video request snapshots. The snapshot is written in the
-- same transaction as budget reservation and routing freeze, so history and
-- retry never have to reconstruct accepted inputs from mutable model config.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS request_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS request_snapshot_hash text,
  ADD COLUMN IF NOT EXISTS request_snapshot_version integer;

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_request_snapshot_v1_check,
  ADD CONSTRAINT video_tasks_request_snapshot_v1_check CHECK (
    request_snapshot IS NULL OR (
      jsonb_typeof(request_snapshot) = 'object'
      AND request_snapshot_version = 1
      AND request_snapshot_hash ~ '^[a-f0-9]{64}$'
      AND request_snapshot->>'schema' = 'video_generation_request_snapshot.v1'
      AND jsonb_typeof(request_snapshot->'userPrompt') = 'string'
      AND jsonb_typeof(request_snapshot->'effectivePrompt') = 'string'
      AND jsonb_typeof(request_snapshot->'promptNormalizations') = 'array'
      AND jsonb_array_length(request_snapshot->'promptNormalizations') <= 64
      AND jsonb_typeof(request_snapshot->'negativePrompt') = 'string'
      AND jsonb_typeof(request_snapshot->'referenceAssets') = 'array'
      AND jsonb_array_length(request_snapshot->'referenceAssets') <= 64
      AND jsonb_typeof(request_snapshot->'targetDurationSeconds') = 'number'
      AND jsonb_typeof(request_snapshot->'effectiveDurationSeconds') = 'number'
      AND request_snapshot->>'aspectRatio' ~ '^\d{1,4}:\d{1,4}$'
      AND coalesce(request_snapshot->>'resolution', '') <> ''
      AND request_snapshot ? 'fps'
      AND jsonb_typeof(request_snapshot->'fps') IN ('number', 'null')
      AND request_snapshot ? 'seed'
      AND jsonb_typeof(request_snapshot->'seed') IN ('string', 'null')
      AND request_snapshot ? 'generateAudio'
      AND jsonb_typeof(request_snapshot->'generateAudio') IN ('boolean', 'null')
      AND coalesce(request_snapshot->>'publicModelId', '') <> ''
      AND request_snapshot->>'routingConfigHash' ~ '^[a-f0-9]{64}$'
      AND coalesce(request_snapshot->>'adapterVersion', '') <> ''
      AND request_snapshot->>'providerPayloadHash' ~ '^[a-f0-9]{64}$'
      AND pg_column_size(request_snapshot) <= 131072
    )
  );

CREATE OR REPLACE FUNCTION public.persist_video_generation_request_snapshot_v1_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_request_snapshot jsonb,
  p_request_snapshot_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_hash text := lower(trim(coalesce(p_request_snapshot_hash, '')));
BEGIN
  IF nullif(trim(coalesce(p_task_id, '')), '') IS NULL
     OR nullif(trim(coalesce(p_user_id, '')), '') IS NULL
     OR lower(trim(coalesce(p_request_fingerprint, ''))) !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(p_request_snapshot) IS DISTINCT FROM 'object'
     OR p_request_snapshot->>'schema' IS DISTINCT FROM 'video_generation_request_snapshot.v1'
     OR v_hash !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(p_request_snapshot->'userPrompt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request_snapshot->'effectivePrompt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request_snapshot->'promptNormalizations') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_request_snapshot->'promptNormalizations') > 64
     OR jsonb_typeof(p_request_snapshot->'negativePrompt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request_snapshot->'referenceAssets') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_request_snapshot->'referenceAssets') > 64
     OR jsonb_typeof(p_request_snapshot->'targetDurationSeconds') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_request_snapshot->'effectiveDurationSeconds') IS DISTINCT FROM 'number'
     OR (p_request_snapshot->>'targetDurationSeconds')::numeric <= 0
     OR (p_request_snapshot->>'effectiveDurationSeconds')::numeric <= 0
     OR p_request_snapshot->>'aspectRatio' !~ '^\d{1,4}:\d{1,4}$'
     OR coalesce(p_request_snapshot->>'resolution', '') = ''
     OR NOT (p_request_snapshot ? 'fps')
     OR jsonb_typeof(p_request_snapshot->'fps') NOT IN ('number', 'null')
     OR NOT (p_request_snapshot ? 'seed')
     OR jsonb_typeof(p_request_snapshot->'seed') NOT IN ('string', 'null')
     OR NOT (p_request_snapshot ? 'generateAudio')
     OR jsonb_typeof(p_request_snapshot->'generateAudio') NOT IN ('boolean', 'null')
     OR coalesce(p_request_snapshot->>'publicModelId', '') = ''
     OR p_request_snapshot->>'routingConfigHash' !~ '^[a-f0-9]{64}$'
     OR coalesce(p_request_snapshot->>'adapterVersion', '') = ''
     OR p_request_snapshot->>'providerPayloadHash' !~ '^[a-f0-9]{64}$'
     OR pg_column_size(p_request_snapshot) > 131072 THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_request_snapshot->'promptNormalizations') item
     WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
        OR coalesce(item->>'name', '') = ''
        OR jsonb_typeof(item->'applied') IS DISTINCT FROM 'boolean'
        OR (item ? 'detail' AND jsonb_typeof(item->'detail') IS DISTINCT FROM 'string')
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_request_snapshot->'referenceAssets') item
     WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR coalesce(item->>'role', '') NOT IN (
          'first_frame', 'last_frame', 'reference_image', 'reference_image_list',
          'reference_audio', 'reference_audio_list', 'source_video', 'person_asset', 'audio_asset'
        )
        OR jsonb_typeof(item->'index') IS DISTINCT FROM 'number'
        OR (item->>'index')::numeric < 0
        OR trunc((item->>'index')::numeric) <> (item->>'index')::numeric
        OR coalesce(item->>'ref', '') = ''
        OR item->>'ref' ~* '^(blob:|data:|file:)'
        OR item->>'ref' ~ '[?#]'
  ) OR EXISTS (
    SELECT 1
      FROM (
        SELECT item->>'role' AS role, item->>'index' AS asset_index, count(*) AS copies
          FROM jsonb_array_elements(p_request_snapshot->'referenceAssets') item
         GROUP BY item->>'role', item->>'index'
      ) duplicated
     WHERE duplicated.copies > 1
  ) THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_ITEMS_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_TASK_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.request_fingerprint IS DISTINCT FROM lower(trim(p_request_fingerprint))
     OR v_task.routing_snapshot_hash IS DISTINCT FROM p_request_snapshot->>'routingConfigHash'
     OR v_task.prompt IS DISTINCT FROM p_request_snapshot->>'userPrompt'
     OR v_task.aspect_ratio IS DISTINCT FROM p_request_snapshot->>'aspectRatio'
     OR coalesce(v_task.resolution, '') IS DISTINCT FROM p_request_snapshot->>'resolution'
     OR v_task.duration_seconds IS DISTINCT FROM (p_request_snapshot->>'targetDurationSeconds')::numeric THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_IDENTITY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF v_task.request_snapshot IS NOT NULL
     AND (v_task.request_snapshot IS DISTINCT FROM p_request_snapshot
          OR v_task.request_snapshot_hash IS DISTINCT FROM v_hash) THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
  END IF;

  UPDATE public.video_tasks
     SET request_snapshot = p_request_snapshot,
         request_snapshot_hash = v_hash,
         request_snapshot_version = 1
   WHERE id = v_task.id
     AND request_snapshot IS NULL;

  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'request_snapshot_hash', v_hash,
    'created', v_task.request_snapshot IS NULL
  );
END
$$;

CREATE FUNCTION public.reserve_video_generation_task_request_snapshot_v1_atomic(
  p_task_id text,
  p_user_id text,
  p_model_id text,
  p_client_request_id text,
  p_request_fingerprint text,
  p_billing_price_yuan numeric,
  p_billing_cost_price_yuan numeric,
  p_billing_unit text,
  p_billing_quantity numeric,
  p_explicitly_free boolean,
  p_billing_exempt boolean,
  p_routing_snapshot jsonb,
  p_request_snapshot jsonb,
  p_request_snapshot_hash text,
  p_provider_task_id text DEFAULT NULL,
  p_task_label text DEFAULT NULL,
  p_batch_id text DEFAULT NULL,
  p_batch_topic text DEFAULT NULL,
  p_card_index integer DEFAULT NULL,
  p_prompt text DEFAULT '',
  p_first_frame_url text DEFAULT NULL,
  p_last_frame_url text DEFAULT NULL,
  p_reference_image_url text DEFAULT NULL,
  p_aspect_ratio text DEFAULT '16:9',
  p_resolution text DEFAULT NULL,
  p_duration_seconds numeric DEFAULT 5,
  p_content_url text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_snapshot_result jsonb;
  v_existing_snapshot jsonb;
  v_existing_snapshot_hash text;
BEGIN
  v_result := public.reserve_video_generation_task_routing_atomic(
    p_task_id => p_task_id,
    p_user_id => p_user_id,
    p_model_id => p_model_id,
    p_client_request_id => p_client_request_id,
    p_request_fingerprint => p_request_fingerprint,
    p_billing_price_yuan => p_billing_price_yuan,
    p_billing_cost_price_yuan => p_billing_cost_price_yuan,
    p_billing_unit => p_billing_unit,
    p_billing_quantity => p_billing_quantity,
    p_explicitly_free => p_explicitly_free,
    p_billing_exempt => p_billing_exempt,
    p_routing_snapshot => p_routing_snapshot,
    p_provider_task_id => p_provider_task_id,
    p_task_label => p_task_label,
    p_batch_id => p_batch_id,
    p_batch_topic => p_batch_topic,
    p_card_index => p_card_index,
    p_prompt => p_prompt,
    p_first_frame_url => p_first_frame_url,
    p_last_frame_url => p_last_frame_url,
    p_reference_image_url => p_reference_image_url,
    p_aspect_ratio => p_aspect_ratio,
    p_resolution => p_resolution,
    p_duration_seconds => p_duration_seconds,
    p_content_url => p_content_url
  );
  IF coalesce((v_result->>'created')::boolean, false) THEN
    v_snapshot_result := public.persist_video_generation_request_snapshot_v1_atomic(
      p_task_id, p_user_id, p_request_fingerprint, p_request_snapshot, p_request_snapshot_hash
    );
    RETURN v_result || jsonb_build_object(
      'request_snapshot_hash', v_snapshot_result->>'request_snapshot_hash'
    );
  END IF;

  SELECT request_snapshot, request_snapshot_hash
    INTO v_existing_snapshot, v_existing_snapshot_hash
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF v_existing_snapshot IS NULL THEN
    RETURN v_result || jsonb_build_object('request_snapshot_unavailable', true);
  END IF;
  IF v_existing_snapshot IS DISTINCT FROM p_request_snapshot
     OR v_existing_snapshot_hash IS DISTINCT FROM lower(trim(p_request_snapshot_hash)) THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN v_result || jsonb_build_object(
    'request_snapshot_hash', v_existing_snapshot_hash,
    'request_snapshot_replayed', true
  );
END
$$;

CREATE FUNCTION public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(
  p_task jsonb,
  p_dispatch jsonb,
  p_routing_snapshot jsonb,
  p_request_snapshot jsonb,
  p_request_snapshot_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_snapshot_result jsonb;
  v_existing_snapshot jsonb;
  v_existing_snapshot_hash text;
BEGIN
  v_result := public.reserve_queued_digital_video_task_routing_atomic(
    p_task, p_dispatch, p_routing_snapshot
  );
  IF coalesce((v_result->>'created')::boolean, false) THEN
    v_snapshot_result := public.persist_video_generation_request_snapshot_v1_atomic(
      p_task->>'p_task_id',
      p_task->>'p_user_id',
      p_task->>'p_request_fingerprint',
      p_request_snapshot,
      p_request_snapshot_hash
    );
    RETURN v_result || jsonb_build_object(
      'request_snapshot_hash', v_snapshot_result->>'request_snapshot_hash'
    );
  END IF;

  SELECT request_snapshot, request_snapshot_hash
    INTO v_existing_snapshot, v_existing_snapshot_hash
    FROM public.video_tasks
   WHERE id::text = trim(p_task->>'p_task_id')
     AND user_id::text = trim(p_task->>'p_user_id')
   FOR UPDATE;
  IF v_existing_snapshot IS NULL THEN
    RETURN v_result || jsonb_build_object('request_snapshot_unavailable', true);
  END IF;
  IF v_existing_snapshot IS DISTINCT FROM p_request_snapshot
     OR v_existing_snapshot_hash IS DISTINCT FROM lower(trim(p_request_snapshot_hash)) THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN v_result || jsonb_build_object(
    'request_snapshot_hash', v_existing_snapshot_hash,
    'request_snapshot_replayed', true
  );
END
$$;

REVOKE ALL ON FUNCTION public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_video_generation_task_request_snapshot_v1_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_video_generation_task_request_snapshot_v1_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)
  TO service_role;

COMMENT ON COLUMN public.video_tasks.request_snapshot IS
  'Immutable video_generation_request_snapshot.v1 used by owner history, recovery and explicit retry.';
COMMENT ON COLUMN public.video_tasks.request_snapshot_hash IS
  'Application-computed SHA-256 of the canonical immutable request snapshot.';
COMMENT ON FUNCTION public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text) IS
  'Persists an immutable, versioned video request snapshot after task identity and routing checks.';

COMMIT;
