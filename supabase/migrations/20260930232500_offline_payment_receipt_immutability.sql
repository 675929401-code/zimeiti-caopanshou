BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.enforce_offline_payment_receipt_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OFFLINE_PAYMENT_RECEIPT_DELETE_FORBIDDEN';
  END IF;

  IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'confirmed'
     AND NEW.status = 'confirmed'
     AND OLD.activation_event_id IS NULL
     AND NEW.activation_event_id IS NOT NULL
     AND (to_jsonb(NEW) - 'activation_event_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'activation_event_id') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'confirmed'
     AND NEW.status = 'voided'
     AND NEW.voided_at IS NOT NULL
     AND NEW.voided_by IS NOT NULL
     AND nullif(btrim(NEW.void_reason), '') IS NOT NULL
     AND nullif(btrim(NEW.void_request_key), '') IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['status','voided_at','voided_by','void_reason','void_request_key']::text[])
       IS NOT DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','voided_at','voided_by','void_reason','void_request_key']::text[]) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'OFFLINE_PAYMENT_RECEIPT_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS offline_payment_receipt_immutability_guard ON public.offline_payment_receipts;
CREATE TRIGGER offline_payment_receipt_immutability_guard
BEFORE UPDATE OR DELETE ON public.offline_payment_receipts
FOR EACH ROW EXECUTE FUNCTION public.enforce_offline_payment_receipt_immutability();

REVOKE INSERT, UPDATE, DELETE ON TABLE public.offline_payment_receipts FROM service_role;
GRANT SELECT ON TABLE public.offline_payment_receipts TO service_role;

COMMENT ON FUNCTION public.enforce_offline_payment_receipt_immutability() IS
  'Allows only the atomic activation link and one-way void transition; all financial evidence fields are immutable and rows cannot be deleted.';

COMMIT;
