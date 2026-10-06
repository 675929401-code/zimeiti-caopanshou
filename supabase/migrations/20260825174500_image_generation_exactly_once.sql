-- Database-backed exactly-once claim for every paid image provider request.
-- Provider calls are external and cannot be part of a PostgreSQL transaction;
-- therefore an unresolved intent fails closed and must be reconciled manually.

CREATE TABLE IF NOT EXISTS public.image_generation_requests (
  record_id text PRIMARY KEY,
  user_id text NOT NULL,
  user_hash text NOT NULL,
  client_idempotency_key text NOT NULL,
  client_trace_id text NOT NULL,
  payload_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'intent'
    CHECK (state IN ('intent', 'completed', 'failed_unknown')),
  response jsonb,
  delivery_state text NOT NULL DEFAULT 'held'
    CHECK (delivery_state IN ('held', 'delivered')),
  delivery_asset_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT image_generation_requests_user_key_unique
    UNIQUE (user_id, client_idempotency_key)
);

CREATE INDEX IF NOT EXISTS image_generation_requests_user_updated_idx
  ON public.image_generation_requests (user_id, updated_at DESC);

ALTER TABLE public.image_generation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_generation_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.image_generation_requests TO service_role;

CREATE OR REPLACE FUNCTION public.claim_image_generation_request(
  p_record_id text,
  p_user_id text,
  p_user_hash text,
  p_client_idempotency_key text,
  p_client_trace_id text,
  p_payload_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.image_generation_requests%ROWTYPE;
  v_created boolean := false;
BEGIN
  IF trim(coalesce(p_record_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR trim(coalesce(p_user_hash, '')) = ''
     OR trim(coalesce(p_client_idempotency_key, '')) = ''
     OR trim(coalesce(p_client_trace_id, '')) = ''
     OR trim(coalesce(p_payload_fingerprint, '')) = '' THEN
    RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.image_generation_requests (
    record_id,
    user_id,
    user_hash,
    client_idempotency_key,
    client_trace_id,
    payload_fingerprint,
    state
  ) VALUES (
    trim(p_record_id),
    trim(p_user_id),
    trim(p_user_hash),
    trim(p_client_idempotency_key),
    trim(p_client_trace_id),
    trim(p_payload_fingerprint),
    'intent'
  )
  ON CONFLICT (user_id, client_idempotency_key) DO NOTHING
  RETURNING * INTO v_row;

  v_created := FOUND;
  IF NOT v_created THEN
    SELECT * INTO v_row
      FROM public.image_generation_requests
     WHERE user_id = trim(p_user_id)
       AND client_idempotency_key = trim(p_client_idempotency_key);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_LOOKUP_FAILED';
    END IF;
    IF v_row.record_id <> trim(p_record_id)
       OR v_row.user_hash <> trim(p_user_hash)
       OR v_row.payload_fingerprint <> trim(p_payload_fingerprint) THEN
      RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;
    IF v_row.client_trace_id <> trim(p_client_trace_id) THEN
      RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_TRACE_CONFLICT' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN jsonb_build_object('created', v_created, 'record', to_jsonb(v_row));
END;
$$;

-- Billing happens before this RPC. Until it commits, the generated object has
-- no user_files ownership row and therefore is not visible/downloadable by the
-- account. Locking the request row makes repeated delivery finalization atomic.
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
   WHERE user_id = trim(p_user_id)
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
      trim(p_user_id),
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

CREATE OR REPLACE FUNCTION public.save_image_generation_request(
  p_record_id text,
  p_payload_fingerprint text,
  p_state text,
  p_response jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.image_generation_requests%ROWTYPE;
  v_state text := lower(trim(coalesce(p_state, '')));
BEGIN
  IF v_state NOT IN ('completed', 'failed_unknown') THEN
    RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_STATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'completed' AND p_response IS NULL THEN
    RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_RESPONSE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.image_generation_requests
   WHERE record_id = trim(p_record_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.payload_fingerprint <> trim(p_payload_fingerprint) THEN
    RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_row.state = 'completed' THEN
    IF v_state <> 'completed' OR v_row.response IS DISTINCT FROM p_response THEN
      RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_RESULT_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('record', to_jsonb(v_row));
  END IF;
  IF v_row.state = 'failed_unknown' THEN
    IF v_state <> 'failed_unknown' THEN
      RAISE EXCEPTION 'IMAGE_IDEMPOTENCY_UNKNOWN_TERMINAL' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('record', to_jsonb(v_row));
  END IF;

  UPDATE public.image_generation_requests
     SET state = v_state,
         response = CASE WHEN v_state = 'completed' THEN p_response ELSE NULL END,
         updated_at = now()
   WHERE record_id = v_row.record_id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object('record', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_image_generation_request(text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_image_generation_request(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_image_generation_delivery(text, text, text, text, text, bigint, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_image_generation_request(text, text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.save_image_generation_request(text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_image_generation_delivery(text, text, text, text, text, bigint, text, text, jsonb)
  TO service_role;
