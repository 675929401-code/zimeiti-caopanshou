BEGIN;

DO $$
BEGIN
  IF to_regclass('public.payment_refund_reconciliation_actions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.payment_refund_reconciliation_actions LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_PAYMENT_REFUND_RECONCILIATION_EVIDENCE_EXISTS';
  END IF;
  IF to_regclass('public.payment_refund_attempts') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.payment_refund_attempts
        WHERE last_reconciliation_action_id IS NOT NULL
           OR last_reconciled_by IS NOT NULL
           OR last_reconciled_at IS NOT NULL
       LIMIT 1
     ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_PAYMENT_REFUND_RECONCILIATION_LINK_EXISTS';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.read_payment_order_admin_summary(text);
DROP FUNCTION IF EXISTS public.resolve_payment_refund_reconciliation_atomic(text,text,text,text,text,text,text,jsonb);
DROP TABLE IF EXISTS public.payment_refund_reconciliation_actions;

ALTER TABLE public.payment_refund_attempts
  DROP COLUMN IF EXISTS last_reconciliation_action_id,
  DROP COLUMN IF EXISTS last_reconciled_by,
  DROP COLUMN IF EXISTS last_reconciled_at;

NOTIFY pgrst, 'reload schema';
COMMIT;
