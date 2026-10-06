BEGIN;

DO $$
BEGIN
  IF to_regclass('public.payment_refund_attempts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.payment_refund_attempts LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_PAYMENT_REFUND_EVIDENCE_EXISTS';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.finalize_payment_refund_attempt_atomic(text,text,text,bigint,text,text,text,text,numeric,jsonb);
DROP FUNCTION IF EXISTS public.mark_payment_refund_provider_started_atomic(text,text,text,bigint);
DROP FUNCTION IF EXISTS public.claim_payment_refund_attempt_atomic(text,text,text,text,text,text,text,integer);
DROP TABLE IF EXISTS public.payment_refund_attempts;

ALTER TABLE public.payment_orders
  DROP COLUMN IF EXISTS refund_attempt_id,
  DROP COLUMN IF EXISTS provider_refund_id,
  DROP COLUMN IF EXISTS provider_refund_amount,
  DROP COLUMN IF EXISTS provider_refund_status,
  DROP COLUMN IF EXISTS refunded_at;

NOTIFY pgrst, 'reload schema';
COMMIT;
