-- Manual rollback for 20260822032000_aid_integration_bridge.sql.
-- Execute only against the confirmed target after a recoverable backup.

BEGIN;

-- Launch tickets and service nonces are security records. Refuse to erase
-- either table after it has ever been used; use a reviewed forward repair.
DO $rollback_guard$
DECLARE
  v_table text;
  v_count bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'aid_launch_tickets',
    'aid_service_nonces'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'AID_ROLLBACK_REFUSED_NONEMPTY:%:%', v_table, v_count;
      END IF;
    END IF;
  END LOOP;
END;
$rollback_guard$;

DROP FUNCTION IF EXISTS public.consume_aid_launch_ticket(text, text);

-- No dependency override: an unknown dependency must abort for review.
DROP TABLE IF EXISTS public.aid_launch_tickets;
DROP TABLE IF EXISTS public.aid_service_nonces;

NOTIFY pgrst, 'reload schema';

COMMIT;
