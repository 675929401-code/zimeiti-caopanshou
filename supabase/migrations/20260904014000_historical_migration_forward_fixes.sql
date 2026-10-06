BEGIN;
SET LOCAL lock_timeout = '10s';

-- Historical migrations are immutable. These permissions preserve the runtime
-- read path while all wallet mutations remain inside SECURITY DEFINER RPCs.
REVOKE ALL ON public.wallet_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.wallet_ledger_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wallet_operations, public.wallet_ledger_entries TO service_role;

-- Replace only the affected functions using the target column types. This keeps
-- compatibility with UUID and text-backed local replicas without rewriting IDs.
CREATE OR REPLACE FUNCTION public.finalize_voice_training_authorization_atomic(
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
  v_license public.voice_clone_licenses%ROWTYPE;
  v_voice_id text;
  v_voice_user_id public.user_voices.user_id%TYPE;
  v_operation text := lower(trim(coalesce(p_operation_kind, '')));
  v_result jsonb;
BEGIN
  IF trim(coalesce(p_speaker_id, '')) = '' OR length(trim(p_speaker_id)) > 500 THEN
    RAISE EXCEPTION 'VOICE_TRAINING_SPEAKER_ID_INVALID' USING ERRCODE = '22023';
  END IF;
  IF trim(coalesce(p_voice_name, '')) = '' OR length(trim(p_voice_name)) > 100 THEN
    RAISE EXCEPTION 'VOICE_TRAINING_VOICE_NAME_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job
    FROM public.voice_training_authorization_jobs
   WHERE user_id = trim(p_user_id)
     AND job_key = trim(p_job_key)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_JOB_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.operation_kind <> v_operation
     OR v_job.request_fingerprint <> p_request_fingerprint THEN
    RAISE EXCEPTION 'VOICE_TRAINING_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_fulfilled', true,
      'job_id', v_job.id,
      'status', v_job.status,
      'voice_id', v_job.voice_id,
      'result_payload', v_job.result_payload,
      'used_trainings', v_job.reserved_used_after,
      'max_trainings', v_job.max_trainings
    );
  END IF;
  IF v_job.status <> 'reserved' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_FINALIZE_STATE_INVALID' USING ERRCODE = '55000';
  END IF;

  UPDATE public.voice_clone_licenses
     SET speaker_id = trim(p_speaker_id),
         voice_type = v_operation,
         voice_name = trim(p_voice_name),
         updated_at = now()
   WHERE id::text = v_job.license_id
     AND status IN ('active', 'used')
     AND coalesce(used_trainings, 0) > 0
  RETURNING * INTO v_license;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_FINALIZE_LICENSE_CONFLICT';
  END IF;

  -- Serialize different job keys targeting the same provider speaker so a
  -- pre-existing legacy table without a unique constraint cannot duplicate it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(trim(p_user_id) || ':' || trim(p_speaker_id), 0)
  );

  SELECT id::text INTO v_voice_id
    FROM public.user_voices
   WHERE user_id::text = trim(p_user_id)
     AND speaker_id = trim(p_speaker_id)
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    UPDATE public.user_voices
       SET voice_type = v_operation,
           voice_name = trim(p_voice_name),
           language = coalesce(nullif(trim(p_language), ''), 'zh'),
           source_info = coalesce(p_source_info, '{}'::jsonb),
           is_active = true,
           updated_at = now()
     WHERE id::text = v_voice_id
       AND user_id::text = trim(p_user_id)
    RETURNING id::text INTO v_voice_id;
  ELSE
    -- Preserve the existing user identifier while respecting legacy UUID and
    -- fresh text column types. An invalid identifier fails the transaction.
    v_voice_user_id := trim(p_user_id);
    INSERT INTO public.user_voices (
      user_id, voice_type, voice_name, speaker_id, language, source_info, is_active
    ) VALUES (
      v_voice_user_id,
      v_operation,
      trim(p_voice_name),
      trim(p_speaker_id),
      coalesce(nullif(trim(p_language), ''), 'zh'),
      coalesce(p_source_info, '{}'::jsonb),
      true
    )
    RETURNING id::text INTO v_voice_id;
  END IF;
  IF v_voice_id IS NULL OR v_voice_id = '' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_VOICE_PERSIST_FAILED';
  END IF;

  v_result := coalesce(p_result_payload, '{}'::jsonb) || jsonb_build_object(
    'speakerId', trim(p_speaker_id),
    'voiceId', v_voice_id,
    'voiceName', trim(p_voice_name)
  );

  UPDATE public.voice_training_authorization_jobs
     SET status = 'completed',
         provider_speaker_id = trim(p_speaker_id),
         voice_id = v_voice_id,
         result_payload = v_result,
         completed_at = now(),
         updated_at = now()
   WHERE id = v_job.id
     AND status = 'reserved'
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_FINALIZE_CONFLICT';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_fulfilled', false,
    'job_id', v_job.id,
    'status', v_job.status,
    'voice_id', v_job.voice_id,
    'result_payload', v_job.result_payload,
    'used_trainings', v_job.reserved_used_after,
    'max_trainings', v_job.max_trainings
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_voice_training_authorization_atomic(text, text, text, text, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_voice_training_authorization_atomic(text, text, text, text, text, text, text, jsonb, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_image_generation_delivery(
  p_record_id text,
  p_user_id text,
  p_storage_key text,
  p_storage_provider text,
  p_file_name text,
  p_file_size bigint,
  p_content_type text,
  p_source text,
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.image_generation_requests%ROWTYPE;
  v_asset_id text;
  v_asset_user_id public.user_files.user_id%TYPE;
BEGIN
  IF trim(coalesce(p_record_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR trim(coalesce(p_storage_key, '')) = ''
     OR trim(coalesce(p_storage_provider, '')) = ''
     OR trim(coalesce(p_file_name, '')) = ''
     OR coalesce(p_file_size, 0) <= 0
     OR trim(coalesce(p_content_type, '')) NOT LIKE 'image/%' THEN
    RAISE EXCEPTION 'IMAGE_DELIVERY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Existing user_files.user_id is UUID, while this public RPC accepts text.
  -- Bind to the actual column type before comparison/insert; do not alter IDs.
  v_asset_user_id := trim(p_user_id);

  SELECT * INTO v_row
    FROM public.image_generation_requests
   WHERE record_id = trim(p_record_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.user_id <> trim(p_user_id)
     OR v_row.state <> 'completed'
     OR v_row.response IS NULL THEN
    RAISE EXCEPTION 'IMAGE_DELIVERY_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF coalesce(v_row.response->>'storageKey', '') <> trim(p_storage_key)
     OR coalesce(v_row.response->>'storageProvider', '') <> trim(p_storage_provider) THEN
    RAISE EXCEPTION 'IMAGE_DELIVERY_STORAGE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF v_row.delivery_state = 'delivered' AND trim(coalesce(v_row.delivery_asset_id, '')) <> '' THEN
    RETURN jsonb_build_object(
      'deliveryAssetId', v_row.delivery_asset_id,
      'deliveryState', 'delivered'
    );
  END IF;

  SELECT id::text INTO v_asset_id
    FROM public.user_files
   WHERE user_id = v_asset_user_id
     AND storage_key = trim(p_storage_key)
     AND storage_provider = trim(p_storage_provider)
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF v_asset_id IS NULL THEN
    INSERT INTO public.user_files (
      user_id,
      storage_key,
      storage_provider,
      file_name,
      file_category,
      file_size,
      content_type,
      source,
      meta,
      is_public
    ) VALUES (
      v_asset_user_id,
      trim(p_storage_key),
      trim(p_storage_provider),
      trim(p_file_name),
      'image',
      p_file_size,
      trim(p_content_type),
      nullif(trim(coalesce(p_source, '')), ''),
      coalesce(p_meta, '{}'::jsonb),
      false
    )
    RETURNING id::text INTO v_asset_id;
  END IF;

  UPDATE public.image_generation_requests
     SET delivery_state = 'delivered',
         delivery_asset_id = v_asset_id,
         updated_at = now()
   WHERE record_id = v_row.record_id;

  RETURN jsonb_build_object(
    'deliveryAssetId', v_asset_id,
    'deliveryState', 'delivered'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_image_generation_delivery(text, text, text, text, text, bigint, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_image_generation_delivery(text, text, text, text, text, bigint, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;