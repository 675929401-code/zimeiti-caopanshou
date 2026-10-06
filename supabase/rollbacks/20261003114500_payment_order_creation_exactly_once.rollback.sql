BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payment_orders
     WHERE client_idempotency_key IS NOT NULL
        OR creation_state IS NOT NULL
        OR provider_creation_snapshot IS NOT NULL
        OR provider_request_started_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_PAYMENT_CREATION_EVIDENCE_EXISTS';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.mark_payment_order_creation_reconciliation_atomic(text,text,text,bigint,text,text,text,text);
DROP FUNCTION IF EXISTS public.finalize_payment_order_creation_atomic(text,text,text,bigint,text,text,text);
DROP FUNCTION IF EXISTS public.mark_payment_order_creation_provider_started_atomic(text,text,text,bigint);
DROP FUNCTION IF EXISTS public.claim_payment_order_creation_atomic(uuid,text,text,text,text,numeric,integer,text,text,timestamptz,text,integer);

DROP INDEX IF EXISTS public.payment_orders_creation_recovery_idx;
DROP INDEX IF EXISTS public.payment_orders_user_create_idempotency_unique;
DROP INDEX IF EXISTS public.payment_orders_trade_order_unique;

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_order_creation_state_valid,
  DROP COLUMN IF EXISTS creation_updated_at,
  DROP COLUMN IF EXISTS creation_error_code,
  DROP COLUMN IF EXISTS provider_qrcode_url,
  DROP COLUMN IF EXISTS provider_creation_snapshot,
  DROP COLUMN IF EXISTS provider_result_received_at,
  DROP COLUMN IF EXISTS provider_request_started_at,
  DROP COLUMN IF EXISTS creation_lease_expires_at,
  DROP COLUMN IF EXISTS creation_lease_token,
  DROP COLUMN IF EXISTS creation_lease_owner,
  DROP COLUMN IF EXISTS creation_state,
  DROP COLUMN IF EXISTS request_fingerprint,
  DROP COLUMN IF EXISTS client_idempotency_key;

NOTIFY pgrst, 'reload schema';

COMMIT;
