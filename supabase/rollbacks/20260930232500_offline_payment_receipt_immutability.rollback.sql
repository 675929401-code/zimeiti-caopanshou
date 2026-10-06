BEGIN;
DROP TRIGGER IF EXISTS offline_payment_receipt_immutability_guard ON public.offline_payment_receipts;
DROP FUNCTION IF EXISTS public.enforce_offline_payment_receipt_immutability();
GRANT SELECT, INSERT, UPDATE ON TABLE public.offline_payment_receipts TO service_role;
COMMIT;
