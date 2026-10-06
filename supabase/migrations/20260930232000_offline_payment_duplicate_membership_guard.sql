BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE UNIQUE INDEX IF NOT EXISTS offline_payment_confirmed_tuition_user_unique
  ON public.offline_payment_receipts (user_id)
  WHERE business_type = 'membership_tuition' AND status = 'confirmed';

COMMENT ON INDEX public.offline_payment_confirmed_tuition_user_unique IS
  'Prevents concurrent or repeated first-membership tuition receipts. A replacement is allowed only after the original receipt is explicitly voided.';

COMMIT;
