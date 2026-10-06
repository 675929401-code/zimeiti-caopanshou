BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.offline_payment_receipts LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_OFFLINE_PAYMENT_RECEIPTS_EXIST';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.void_offline_payment_receipt_atomic(text,text,text,text);
DROP FUNCTION IF EXISTS public.record_offline_payment_and_activate_member_atomic(text,text,text,text,numeric,timestamptz,text,text,text,text);
DROP TABLE IF EXISTS public.offline_payment_receipts;

NOTIFY pgrst, 'reload schema';
COMMIT;
