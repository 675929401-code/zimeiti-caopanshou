-- Manual rollback for 20260825062000_text_chat_controls.sql.
-- Execute only against the confirmed target after a recoverable backup.

BEGIN;

-- Conversation settings and memories are user data. Refuse destructive
-- rollback once either table contains a row; use a reviewed forward repair.
DO $rollback_guard$
DECLARE
  v_table text;
  v_count bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'text_chat_conversation_settings',
    'text_chat_memories'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'TEXT_CHAT_ROLLBACK_REFUSED_NONEMPTY:%:%', v_table, v_count;
      END IF;
    END IF;
  END LOOP;
END;
$rollback_guard$;

-- No dependency override: an unknown dependency must abort for review.
DROP TABLE IF EXISTS public.text_chat_conversation_settings;
DROP TABLE IF EXISTS public.text_chat_memories;

NOTIFY pgrst, 'reload schema';

COMMIT;
