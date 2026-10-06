-- Manual rollback for 20260825121000_atomic_wallet_payment_fulfillment.sql.
-- This file intentionally lives outside supabase/migrations so the Supabase CLI
-- cannot mistake destructive rollback SQL for a forward migration.
-- Do not run after production wallet operations have been recorded without
-- first exporting and reconciling the durable ledger.

BEGIN;

-- Default to preserving money, idempotency and audit data. Once either table
-- contains a row, rollback must be a reviewed forward repair instead of a
-- destructive teardown.
DO $rollback_guard$
DECLARE
  v_table text;
  v_count bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'wallet_ledger_entries',
    'wallet_operations'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'WALLET_ROLLBACK_REFUSED_NONEMPTY:%:%', v_table, v_count;
      END IF;
    END IF;
  END LOOP;
END;
$rollback_guard$;

DROP FUNCTION IF EXISTS public.fulfill_payment_order_atomic(text, text, numeric);
DROP FUNCTION IF EXISTS public.apply_wallet_operation_atomic(text, text, text, numeric, text, jsonb);
DROP TABLE IF EXISTS public.wallet_ledger_entries;
DROP TABLE IF EXISTS public.wallet_operations;
NOTIFY pgrst, 'reload schema';

COMMIT;
