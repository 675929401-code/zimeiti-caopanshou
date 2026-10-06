BEGIN;

-- The legacy payment fulfillment entrypoint does not require provider-side
-- merchant-order and transaction evidence. Keep it in the schema only for
-- rollback compatibility, but make it unreachable from every API role.
REVOKE EXECUTE ON FUNCTION public.fulfill_payment_order_atomic(text, text, numeric)
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
