-- Voice Studio P0: atomic wallet charging, versioned nest pricing and
-- provider-before-delivery authorization reservations.
--
-- This migration deliberately contains no live price seed.  A price version
-- must be created and activated by an administrator before nest purchases are
-- accepted.  Missing configuration therefore fails closed instead of silently
-- falling back to a price embedded in application source.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS voice_clone_authorized boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.voice_nest_slots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  slot_type text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'unused',
  voice_id text,
  price numeric(20, 2) NOT NULL,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.voice_clone_licenses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  license_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  user_id text,
  speaker_id text,
  voice_type text,
  voice_name text,
  max_trainings integer NOT NULL DEFAULT 15,
  used_trainings integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_voices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  voice_type text NOT NULL,
  voice_name text NOT NULL,
  speaker_id text NOT NULL,
  language text NOT NULL DEFAULT 'zh',
  source_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Older installations created the three legacy tables outside migrations.
-- Add only the columns used by the atomic functions when they are absent.
ALTER TABLE public.voice_nest_slots
  ADD COLUMN IF NOT EXISTS purchase_request_id bigint;
ALTER TABLE public.voice_nest_slots
  ADD COLUMN IF NOT EXISTS purchased_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.voice_nest_slots
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.voice_clone_licenses
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.user_voices
  ADD COLUMN IF NOT EXISTS source_info jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.user_voices
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.user_voices
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.voice_nest_price_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version text NOT NULL UNIQUE,
  unit_price_cash numeric(20, 2) NOT NULL CHECK (unit_price_cash > 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  effective_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_nest_price_one_active_idx
  ON public.voice_nest_price_versions ((status))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.voice_nest_purchase_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_payload jsonb NOT NULL,
  price_version_id bigint REFERENCES public.voice_nest_price_versions(id) ON DELETE RESTRICT,
  price_version text,
  unit_price_cash numeric(20, 2),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  total_price_cash numeric(20, 2),
  wallet_operation_id text,
  wallet_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  slot_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT voice_nest_purchase_idempotency_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS voice_nest_purchase_user_created_idx
  ON public.voice_nest_purchase_requests (user_id, created_at DESC);

ALTER TABLE public.voice_nest_purchase_requests
  ADD COLUMN IF NOT EXISTS wallet_result jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.voice_training_authorization_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  job_key text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('clone', 'design')),
  request_fingerprint text NOT NULL,
  license_id text,
  reserved_used_before integer,
  reserved_used_after integer,
  max_trainings integer,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reserved', 'completed', 'released')),
  provider_speaker_id text,
  voice_id text,
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reserved_at timestamptz,
  completed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voice_training_job_idempotency_unique UNIQUE (user_id, job_key)
);

CREATE INDEX IF NOT EXISTS voice_training_job_user_created_idx
  ON public.voice_training_authorization_jobs (user_id, created_at DESC);

ALTER TABLE public.voice_nest_price_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_nest_purchase_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_training_authorization_jobs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.purchase_voice_nest_slots_atomic(
  p_user_id text,
  p_quantity integer,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_request public.voice_nest_purchase_requests%ROWTYPE;
  v_offer public.voice_nest_price_versions%ROWTYPE;
  v_payload jsonb;
  v_total numeric(20, 2);
  v_wallet jsonb;
  v_slots jsonb := '[]'::jsonb;
  v_slot record;
BEGIN
  IF trim(coalesce(p_user_id, '')) = '' THEN
    RAISE EXCEPTION 'VOICE_NEST_USER_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 10 THEN
    RAISE EXCEPTION 'VOICE_NEST_QUANTITY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF trim(coalesce(p_idempotency_key, '')) = ''
     OR length(trim(p_idempotency_key)) > 220 THEN
    RAISE EXCEPTION 'VOICE_NEST_IDEMPOTENCY_KEY_INVALID' USING ERRCODE = '22023';
  END IF;

  v_payload := jsonb_build_object('quantity', p_quantity);

  INSERT INTO public.voice_nest_purchase_requests (
    user_id, idempotency_key, request_payload, quantity, status
  ) VALUES (
    trim(p_user_id), trim(p_idempotency_key), v_payload, p_quantity, 'processing'
  )
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_request;

  IF NOT FOUND THEN
    SELECT * INTO v_request
      FROM public.voice_nest_purchase_requests
     WHERE user_id = trim(p_user_id)
       AND idempotency_key = trim(p_idempotency_key)
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VOICE_NEST_IDEMPOTENCY_LOOKUP_FAILED';
    END IF;
    IF v_request.request_payload <> v_payload THEN
      RAISE EXCEPTION 'VOICE_NEST_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;
    IF v_request.status = 'completed' THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_fulfilled', true,
        'purchase_request_id', v_request.id,
        'quantity', v_request.quantity,
        'price_snapshot', jsonb_build_object(
          'version', v_request.price_version,
          'unit_price_cash', v_request.unit_price_cash,
          'total_price_cash', v_request.total_price_cash,
          'currency', 'CNY'
        ),
        'wallet_operation_id', v_request.wallet_operation_id,
        'wallet', v_request.wallet_result,
        'slot_ids', v_request.slot_ids
      );
    END IF;
    RAISE EXCEPTION 'VOICE_NEST_PURCHASE_IN_PROGRESS' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_user
    FROM public.users
   WHERE id = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_NEST_USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT coalesce(v_user.voice_clone_authorized, false) THEN
    RAISE EXCEPTION 'VOICE_NEST_AUTHORIZATION_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_offer
    FROM public.voice_nest_price_versions
   WHERE status = 'active'
     AND effective_at <= now()
   ORDER BY effective_at DESC, id DESC
   LIMIT 1
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_NEST_PRICE_NOT_CONFIGURED' USING ERRCODE = '55000';
  END IF;
  IF v_offer.unit_price_cash IS NULL OR v_offer.unit_price_cash <= 0 THEN
    RAISE EXCEPTION 'VOICE_NEST_PRICE_INVALID' USING ERRCODE = '22023';
  END IF;

  v_total := round(v_offer.unit_price_cash * p_quantity, 2);
  v_wallet := public.apply_wallet_operation_atomic(
    trim(p_user_id),
    'cash_charge',
    'voice:nest:' || trim(p_idempotency_key),
    v_total,
    'Voice nest purchase (' || p_quantity::text || ')',
    jsonb_build_object(
      'source', 'voice-studio',
      'operation', 'nest_purchase',
      'purchase_request_id', v_request.id,
      'quantity', p_quantity,
      'price_snapshot', jsonb_build_object(
        'version', v_offer.version,
        'unit_price_cash', v_offer.unit_price_cash,
        'total_price_cash', v_total,
        'currency', v_offer.currency
      )
    )
  );
  IF NOT coalesce((v_wallet ->> 'success')::boolean, false) THEN
    RAISE EXCEPTION 'VOICE_NEST_WALLET_OPERATION_FAILED';
  END IF;

  FOR v_slot IN
    INSERT INTO public.voice_nest_slots (
      user_id, slot_type, status, price, purchased_at, purchase_request_id
    )
    SELECT trim(p_user_id), 'general', 'unused', v_offer.unit_price_cash, now(), v_request.id
      FROM generate_series(1, p_quantity)
    RETURNING id
  LOOP
    v_slots := v_slots || jsonb_build_array(v_slot.id);
  END LOOP;

  IF jsonb_array_length(v_slots) <> p_quantity THEN
    RAISE EXCEPTION 'VOICE_NEST_SLOT_INSERT_INCOMPLETE';
  END IF;

  UPDATE public.voice_nest_purchase_requests
     SET price_version_id = v_offer.id,
         price_version = v_offer.version,
         unit_price_cash = v_offer.unit_price_cash,
         total_price_cash = v_total,
         wallet_operation_id = v_wallet ->> 'operation_id',
         wallet_result = v_wallet,
         slot_ids = v_slots,
         status = 'completed',
         completed_at = now()
   WHERE id = v_request.id
     AND status = 'processing'
  RETURNING * INTO v_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_NEST_PURCHASE_FINALIZE_CONFLICT';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_fulfilled', false,
    'purchase_request_id', v_request.id,
    'quantity', v_request.quantity,
    'price_snapshot', jsonb_build_object(
      'version', v_request.price_version,
      'unit_price_cash', v_request.unit_price_cash,
      'total_price_cash', v_request.total_price_cash,
      'currency', 'CNY'
    ),
    'wallet_operation_id', v_request.wallet_operation_id,
    'wallet', v_wallet,
    'slot_ids', v_request.slot_ids
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_voice_training_authorization_atomic(
  p_user_id text,
  p_job_key text,
  p_operation_kind text,
  p_request_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.voice_training_authorization_jobs%ROWTYPE;
  v_license public.voice_clone_licenses%ROWTYPE;
  v_operation text := lower(trim(coalesce(p_operation_kind, '')));
  v_used_before integer;
  v_used_after integer;
  v_status text;
BEGIN
  IF trim(coalesce(p_user_id, '')) = '' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_USER_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF trim(coalesce(p_job_key, '')) = '' OR length(trim(p_job_key)) > 220 THEN
    RAISE EXCEPTION 'VOICE_TRAINING_JOB_KEY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_operation NOT IN ('clone', 'design') THEN
    RAISE EXCEPTION 'VOICE_TRAINING_OPERATION_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_FINGERPRINT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.voice_training_authorization_jobs (
    user_id, job_key, operation_kind, request_fingerprint, status
  ) VALUES (
    trim(p_user_id), trim(p_job_key), v_operation, p_request_fingerprint, 'pending'
  )
  ON CONFLICT (user_id, job_key) DO NOTHING
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    SELECT * INTO v_job
      FROM public.voice_training_authorization_jobs
     WHERE user_id = trim(p_user_id)
       AND job_key = trim(p_job_key)
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VOICE_TRAINING_JOB_LOOKUP_FAILED';
    END IF;
    IF v_job.operation_kind <> v_operation
       OR v_job.request_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'VOICE_TRAINING_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'already_exists', true,
      'job_id', v_job.id,
      'job_key', v_job.job_key,
      'status', v_job.status,
      'license_id', v_job.license_id,
      'used_trainings', v_job.reserved_used_after,
      'max_trainings', v_job.max_trainings,
      'voice_id', v_job.voice_id,
      'result_payload', v_job.result_payload
    );
  END IF;

  SELECT * INTO v_license
    FROM public.voice_clone_licenses
   WHERE user_id::text = trim(p_user_id)
     AND status = 'active'
     AND coalesce(used_trainings, 0) < coalesce(max_trainings, 0)
   ORDER BY created_at DESC, id DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_LICENSE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  v_used_before := coalesce(v_license.used_trainings, 0);
  v_used_after := v_used_before + 1;
  v_status := CASE WHEN v_used_after >= v_license.max_trainings THEN 'used' ELSE 'active' END;

  UPDATE public.voice_clone_licenses
     SET used_trainings = v_used_after,
         status = v_status,
         used_at = now(),
         updated_at = now()
   WHERE id::text = v_license.id::text
     AND used_trainings = v_used_before;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_LICENSE_RESERVATION_CONFLICT';
  END IF;

  UPDATE public.voice_training_authorization_jobs
     SET license_id = v_license.id::text,
         reserved_used_before = v_used_before,
         reserved_used_after = v_used_after,
         max_trainings = v_license.max_trainings,
         status = 'reserved',
         reserved_at = now(),
         updated_at = now()
   WHERE id = v_job.id
     AND status = 'pending'
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_JOB_RESERVATION_CONFLICT';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_exists', false,
    'job_id', v_job.id,
    'job_key', v_job.job_key,
    'status', v_job.status,
    'license_id', v_job.license_id,
    'used_trainings', v_job.reserved_used_after,
    'max_trainings', v_job.max_trainings
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_voice_training_authorization_atomic(
  p_user_id text,
  p_job_key text,
  p_operation_kind text,
  p_request_fingerprint text,
  p_reason text DEFAULT 'provider_failed'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.voice_training_authorization_jobs%ROWTYPE;
  v_license public.voice_clone_licenses%ROWTYPE;
  v_operation text := lower(trim(coalesce(p_operation_kind, '')));
BEGIN
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
  IF v_job.status = 'released' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_released', true,
      'job_id', v_job.id,
      'status', v_job.status
    );
  END IF;
  IF v_job.status <> 'reserved' THEN
    RAISE EXCEPTION 'VOICE_TRAINING_RELEASE_STATE_INVALID' USING ERRCODE = '55000';
  END IF;

  UPDATE public.voice_clone_licenses
     SET used_trainings = greatest(coalesce(used_trainings, 0) - 1, 0),
         status = CASE WHEN status = 'used' THEN 'active' ELSE status END,
         updated_at = now()
   WHERE id::text = v_job.license_id
     AND coalesce(used_trainings, 0) > 0
  RETURNING * INTO v_license;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_RELEASE_LICENSE_CONFLICT';
  END IF;

  UPDATE public.voice_training_authorization_jobs
     SET status = 'released',
         release_reason = left(coalesce(p_reason, 'provider_failed'), 500),
         released_at = now(),
         updated_at = now()
   WHERE id = v_job.id
     AND status = 'reserved'
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_TRAINING_RELEASE_CONFLICT';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_released', false,
    'job_id', v_job.id,
    'status', v_job.status,
    'used_trainings', v_license.used_trainings,
    'max_trainings', v_license.max_trainings
  );
END;
$$;

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
    INSERT INTO public.user_voices (
      user_id, voice_type, voice_name, speaker_id, language, source_info, is_active
    ) VALUES (
      trim(p_user_id),
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

REVOKE ALL ON public.voice_nest_price_versions FROM anon, authenticated;
REVOKE ALL ON public.voice_nest_purchase_requests FROM anon, authenticated;
REVOKE ALL ON public.voice_training_authorization_jobs FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.purchase_voice_nest_slots_atomic(text, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_voice_training_authorization_atomic(text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_voice_training_authorization_atomic(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_voice_training_authorization_atomic(text, text, text, text, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.purchase_voice_nest_slots_atomic(text, integer, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_voice_training_authorization_atomic(text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_voice_training_authorization_atomic(text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_voice_training_authorization_atomic(text, text, text, text, text, text, text, jsonb, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
