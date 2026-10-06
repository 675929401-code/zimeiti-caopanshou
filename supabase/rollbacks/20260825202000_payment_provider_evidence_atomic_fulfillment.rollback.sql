-- Manual rollback for provider-evidence payment fulfillment hardening.
-- Refuses destructive rollback after any provider evidence has been persisted.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payment_orders
     WHERE provider_trade_order_id IS NOT NULL
        OR provider_transaction_id IS NOT NULL
        OR provider_paid_amount IS NOT NULL
        OR provider_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_PROVIDER_PAYMENT_EVIDENCE_EXISTS';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fulfill_payment_order_with_evidence_atomic(text, text, text, text, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.fulfill_payment_order_with_evidence_atomic(text, text, text, text, numeric);

DROP INDEX IF EXISTS public.payment_orders_provider_transaction_unique;

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_provider_evidence_all_or_none,
  DROP COLUMN IF EXISTS provider_confirmed_at,
  DROP COLUMN IF EXISTS provider_paid_amount,
  DROP COLUMN IF EXISTS provider_transaction_id,
  DROP COLUMN IF EXISTS provider_trade_order_id;

GRANT EXECUTE ON FUNCTION public.fulfill_payment_order_atomic(text, text, numeric)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
