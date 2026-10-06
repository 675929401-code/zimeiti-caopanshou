-- Durable, exactly-once payment-order creation.
--
-- The local merchant order is committed before any provider request. A
-- user-scoped Idempotency-Key owns exactly one merchant order. Once provider
-- dispatch starts, automatic re-dispatch is forbidden; an ambiguous outcome
-- remains visible for reconciliation. A validated provider result that could
-- not be finalized is retained and can be finalized on a later replay without
-- another provider call.

BEGIN;

ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS client_idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS creation_state text,
  ADD COLUMN IF NOT EXISTS creation_lease_owner text,
  ADD COLUMN IF NOT EXISTS creation_lease_token bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS creation_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_request_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_result_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_creation_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS provider_qrcode_url text,
  ADD COLUMN IF NOT EXISTS creation_error_code text,
  ADD COLUMN IF NOT EXISTS creation_updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payment_orders
     GROUP BY trade_order_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_MIGRATION_DUPLICATE_TRADE_ORDER_ID';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_trade_order_unique
  ON public.payment_orders (trade_order_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_user_create_idempotency_unique
  ON public.payment_orders (user_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_orders_creation_recovery_idx
  ON public.payment_orders (creation_state, creation_updated_at)
  WHERE creation_state IN ('provider_started', 'reconciliation_required');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.payment_orders'::regclass
       AND conname = 'payment_order_creation_state_valid'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_order_creation_state_valid CHECK (
        (
          client_idempotency_key IS NULL
          AND request_fingerprint IS NULL
          AND creation_state IS NULL
          AND creation_lease_owner IS NULL
          AND creation_lease_token = 0
          AND creation_lease_expires_at IS NULL
          AND provider_request_started_at IS NULL
          AND provider_result_received_at IS NULL
          AND provider_creation_snapshot IS NULL
          AND provider_qrcode_url IS NULL
          AND creation_error_code IS NULL
        )
        OR
        (
          client_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
          AND request_fingerprint ~ '^[a-f0-9]{64}$'
          AND creation_state IN ('reserved', 'provider_started', 'reconciliation_required', 'ready')
          AND creation_lease_token >= 0
          AND (creation_error_code IS NULL OR creation_error_code ~ '^[A-Z0-9_]{1,96}$')
          AND (
            provider_creation_snapshot IS NULL
            OR jsonb_typeof(provider_creation_snapshot) = 'object'
          )
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_payment_order_creation_atomic(
  p_user_id uuid,
  p_client_idempotency_key text,
  p_request_fingerprint text,
  p_trade_order_id text,
  p_type text,
  p_amount numeric,
  p_credits_amount integer,
  p_payment_method text,
  p_payment_provider text,
  p_expire_at timestamptz,
  p_lease_owner text,
  p_lease_seconds integer DEFAULT 90
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text := trim(coalesce(p_client_idempotency_key, ''));
  v_fingerprint text := lower(trim(coalesce(p_request_fingerprint, '')));
  v_trade_order_id text := trim(coalesce(p_trade_order_id, ''));
  v_type text := lower(trim(coalesce(p_type, '')));
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_provider text := lower(trim(coalesce(p_payment_provider, '')));
  v_lease_owner text := trim(coalesce(p_lease_owner, ''));
  v_amount numeric(20, 2);
  v_inserted_rows integer := 0;
  v_order public.payment_orders%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_USER_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_IDEMPOTENCY_KEY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_REQUEST_FINGERPRINT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_trade_order_id = '' OR length(v_trade_order_id) > 240 OR v_trade_order_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_TRADE_ORDER_ID_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_type NOT IN ('credits', 'cash') THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_TYPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0 OR p_amount > 50000 OR round(p_amount, 2) <> p_amount THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_amount := round(p_amount, 2);
  IF (v_type = 'credits' AND (p_credits_amount IS NULL OR p_credits_amount <= 0))
     OR (v_type = 'cash' AND p_credits_amount IS NOT NULL) THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_CREDITS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_method !~ '^[a-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_METHOD_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_provider NOT IN ('xunhupay', 'epay') THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_PROVIDER_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_expire_at IS NULL OR p_expire_at <= now() OR p_expire_at > now() + interval '2 hours' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_EXPIRE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_lease_owner = '' OR length(v_lease_owner) > 240 OR v_lease_owner ~ '[[:cntrl:]]'
     OR p_lease_seconds IS NULL OR p_lease_seconds < 15 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_LEASE_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_orders (
    user_id, trade_order_id, type, amount, credits_amount, status,
    payment_method, payment_provider, expire_at,
    client_idempotency_key, request_fingerprint, creation_state,
    creation_lease_token, creation_updated_at
  ) VALUES (
    p_user_id, v_trade_order_id, v_type, v_amount, p_credits_amount, 'pending',
    v_method, v_provider, p_expire_at,
    v_key, v_fingerprint, 'reserved', 0, now()
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;

  SELECT * INTO v_order
    FROM public.payment_orders
   WHERE user_id = p_user_id
     AND client_idempotency_key = v_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_TRADE_ORDER_COLLISION' USING ERRCODE = '23505';
  END IF;

  IF v_order.request_fingerprint <> v_fingerprint
     OR v_order.type <> v_type
     OR round(v_order.amount, 2) <> v_amount
     OR v_order.credits_amount IS DISTINCT FROM p_credits_amount
     OR lower(trim(coalesce(v_order.payment_method, ''))) <> v_method
     OR lower(trim(coalesce(v_order.payment_provider, ''))) <> v_provider THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF v_order.creation_state = 'ready' THEN
    RETURN jsonb_build_object('action', 'replay', 'record', to_jsonb(v_order));
  END IF;
  IF v_order.creation_state = 'provider_started' THEN
    RETURN jsonb_build_object('action', 'reconciliation_required', 'record', to_jsonb(v_order));
  END IF;
  IF v_order.creation_state = 'reconciliation_required' THEN
    IF v_order.provider_creation_snapshot IS NULL THEN
      RETURN jsonb_build_object('action', 'reconciliation_required', 'record', to_jsonb(v_order));
    END IF;
    UPDATE public.payment_orders
       SET creation_lease_owner = v_lease_owner,
           creation_lease_token = creation_lease_token + 1,
           creation_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           creation_updated_at = now()
     WHERE id = v_order.id
     RETURNING * INTO v_order;
    RETURN jsonb_build_object('action', 'recover', 'record', to_jsonb(v_order));
  END IF;
  IF v_order.creation_state <> 'reserved' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_STATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_order.status <> 'pending' OR v_order.expire_at IS NULL OR v_order.expire_at <= now() THEN
    UPDATE public.payment_orders
       SET creation_state = 'reconciliation_required',
           creation_error_code = 'PAYMENT_CREATE_LOCAL_ORDER_NOT_PENDING',
           creation_lease_owner = NULL,
           creation_lease_expires_at = NULL,
           creation_updated_at = now()
     WHERE id = v_order.id
     RETURNING * INTO v_order;
    RETURN jsonb_build_object('action', 'reconciliation_required', 'record', to_jsonb(v_order));
  END IF;

  IF v_inserted_rows = 0
     AND v_order.creation_lease_expires_at IS NOT NULL
     AND v_order.creation_lease_expires_at > now() THEN
    RETURN jsonb_build_object('action', 'in_progress', 'record', to_jsonb(v_order));
  END IF;

  UPDATE public.payment_orders
     SET creation_lease_owner = v_lease_owner,
         creation_lease_token = creation_lease_token + 1,
         creation_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         creation_updated_at = now()
   WHERE id = v_order.id
   RETURNING * INTO v_order;
  RETURN jsonb_build_object('action', 'execute', 'record', to_jsonb(v_order));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_payment_order_creation_provider_started_atomic(
  p_trade_order_id text,
  p_request_fingerprint text,
  p_lease_owner text,
  p_lease_token bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
    FROM public.payment_orders
   WHERE trade_order_id = trim(coalesce(p_trade_order_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.request_fingerprint <> lower(trim(coalesce(p_request_fingerprint, '')))
     OR v_order.creation_lease_owner <> trim(coalesce(p_lease_owner, ''))
     OR v_order.creation_lease_token <> p_lease_token THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_LEASE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_order.creation_state = 'ready' THEN
    RETURN jsonb_build_object('action', 'replay', 'record', to_jsonb(v_order));
  END IF;
  IF v_order.creation_state <> 'reserved' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payment_orders
     SET creation_state = 'provider_started',
         provider_request_started_at = coalesce(provider_request_started_at, now()),
         creation_updated_at = now()
   WHERE id = v_order.id
   RETURNING * INTO v_order;
  RETURN jsonb_build_object('action', 'execute', 'record', to_jsonb(v_order));
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_payment_order_creation_atomic(
  p_trade_order_id text,
  p_request_fingerprint text,
  p_lease_owner text,
  p_lease_token bigint,
  p_payment_url text,
  p_qrcode_url text,
  p_platform_order_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
  v_payment_url text := trim(coalesce(p_payment_url, ''));
  v_qrcode_url text := trim(coalesce(p_qrcode_url, ''));
  v_platform_order_id text := trim(coalesce(p_platform_order_id, ''));
  v_snapshot jsonb;
BEGIN
  SELECT * INTO v_order
    FROM public.payment_orders
   WHERE trade_order_id = trim(coalesce(p_trade_order_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.creation_state = 'ready' THEN
    RETURN jsonb_build_object('action', 'replay', 'record', to_jsonb(v_order));
  END IF;
  IF v_order.request_fingerprint <> lower(trim(coalesce(p_request_fingerprint, '')))
     OR v_order.creation_lease_owner <> trim(coalesce(p_lease_owner, ''))
     OR v_order.creation_lease_token <> p_lease_token THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_LEASE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_order.creation_state NOT IN ('provider_started', 'reconciliation_required') THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF (v_payment_url = '' AND v_qrcode_url = '')
     OR length(v_payment_url) > 8192 OR length(v_qrcode_url) > 8192
     OR (v_payment_url <> '' AND v_payment_url !~* '^https://')
     OR (v_qrcode_url <> '' AND v_qrcode_url !~* '^https://')
     OR length(v_platform_order_id) > 240 OR v_platform_order_id ~ '[[:cntrl:]]'
     OR (lower(trim(v_order.payment_provider)) = 'xunhupay' AND v_platform_order_id = '') THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_PROVIDER_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_snapshot := jsonb_build_object(
    'paymentUrl', v_payment_url,
    'qrcodeUrl', v_qrcode_url,
    'platformOrderId', nullif(v_platform_order_id, '')
  );
  UPDATE public.payment_orders
     SET platform_order_id = nullif(v_platform_order_id, ''),
         payment_url = coalesce(nullif(v_payment_url, ''), nullif(v_qrcode_url, '')),
         provider_qrcode_url = nullif(v_qrcode_url, ''),
         provider_creation_snapshot = v_snapshot,
         provider_result_received_at = coalesce(provider_result_received_at, now()),
         creation_state = 'ready',
         creation_error_code = NULL,
         creation_lease_owner = NULL,
         creation_lease_expires_at = NULL,
         creation_updated_at = now()
   WHERE id = v_order.id
   RETURNING * INTO v_order;
  RETURN jsonb_build_object('action', 'replay', 'record', to_jsonb(v_order));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_payment_order_creation_reconciliation_atomic(
  p_trade_order_id text,
  p_request_fingerprint text,
  p_lease_owner text,
  p_lease_token bigint,
  p_error_code text,
  p_payment_url text DEFAULT NULL,
  p_qrcode_url text DEFAULT NULL,
  p_platform_order_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
  v_error_code text := upper(trim(coalesce(p_error_code, '')));
  v_payment_url text := trim(coalesce(p_payment_url, ''));
  v_qrcode_url text := trim(coalesce(p_qrcode_url, ''));
  v_platform_order_id text := trim(coalesce(p_platform_order_id, ''));
  v_snapshot jsonb := NULL;
BEGIN
  SELECT * INTO v_order
    FROM public.payment_orders
   WHERE trade_order_id = trim(coalesce(p_trade_order_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.creation_state = 'ready' THEN
    RETURN jsonb_build_object('action', 'replay', 'record', to_jsonb(v_order));
  END IF;
  IF v_order.request_fingerprint <> lower(trim(coalesce(p_request_fingerprint, '')))
     OR v_order.creation_lease_owner <> trim(coalesce(p_lease_owner, ''))
     OR v_order.creation_lease_token <> p_lease_token THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_LEASE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_order.creation_state NOT IN ('provider_started', 'reconciliation_required')
     OR v_error_code !~ '^[A-Z0-9_]{1,96}$' THEN
    RAISE EXCEPTION 'PAYMENT_CREATE_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF v_payment_url <> '' OR v_qrcode_url <> '' OR v_platform_order_id <> '' THEN
    IF (v_payment_url = '' AND v_qrcode_url = '')
       OR length(v_payment_url) > 8192 OR length(v_qrcode_url) > 8192
       OR (v_payment_url <> '' AND v_payment_url !~* '^https://')
       OR (v_qrcode_url <> '' AND v_qrcode_url !~* '^https://')
       OR length(v_platform_order_id) > 240 OR v_platform_order_id ~ '[[:cntrl:]]'
       OR (lower(trim(v_order.payment_provider)) = 'xunhupay' AND v_platform_order_id = '') THEN
      RAISE EXCEPTION 'PAYMENT_CREATE_PROVIDER_RESULT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_snapshot := jsonb_build_object(
      'paymentUrl', v_payment_url,
      'qrcodeUrl', v_qrcode_url,
      'platformOrderId', nullif(v_platform_order_id, '')
    );
  END IF;

  UPDATE public.payment_orders
     SET creation_state = 'reconciliation_required',
         provider_creation_snapshot = coalesce(v_snapshot, provider_creation_snapshot),
         provider_result_received_at = CASE
           WHEN v_snapshot IS NOT NULL THEN coalesce(provider_result_received_at, now())
           ELSE provider_result_received_at
         END,
         creation_error_code = v_error_code,
         creation_lease_owner = NULL,
         creation_lease_expires_at = NULL,
         creation_updated_at = now()
   WHERE id = v_order.id
   RETURNING * INTO v_order;
  RETURN jsonb_build_object('action', 'reconciliation_required', 'record', to_jsonb(v_order));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_payment_order_creation_atomic(uuid,text,text,text,text,numeric,integer,text,text,timestamptz,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_payment_order_creation_provider_started_atomic(text,text,text,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_payment_order_creation_atomic(text,text,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_payment_order_creation_reconciliation_atomic(text,text,text,bigint,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.claim_payment_order_creation_atomic(uuid,text,text,text,text,numeric,integer,text,text,timestamptz,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_payment_order_creation_provider_started_atomic(text,text,text,bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_payment_order_creation_atomic(text,text,text,bigint,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_payment_order_creation_reconciliation_atomic(text,text,text,bigint,text,text,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
