-- Roll back only the durable /api/llm exactly-once contract introduced by
-- 20260901170000_llm_request_attempts_exactly_once.sql.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $rollback_guard$
DECLARE
  v_evidence_exists boolean := false;
BEGIN
  IF to_regclass('public.llm_credit_reservations') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_LLM_DEPENDENT_MIGRATION_PRESENT'
      USING ERRCODE = '2BP01';
  END IF;

  IF to_regclass('public.llm_request_attempt_events') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.llm_request_attempt_events LIMIT 1)'
      INTO v_evidence_exists;
    IF v_evidence_exists THEN
      RAISE EXCEPTION 'ROLLBACK_BLOCKED_LLM_EVIDENCE_EXISTS'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF to_regclass('public.llm_request_attempts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.llm_request_attempts LIMIT 1)'
      INTO v_evidence_exists;
    IF v_evidence_exists THEN
      RAISE EXCEPTION 'ROLLBACK_BLOCKED_LLM_EVIDENCE_EXISTS'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$rollback_guard$;

DROP FUNCTION IF EXISTS public.reconcile_llm_request_attempt_atomic(
  text, integer, text, text, text, integer, jsonb, text, text, text
);
DROP FUNCTION IF EXISTS public.finalize_llm_request_attempt_atomic(
  text, text, text, bigint, text, integer, jsonb, text, text, text, text, text
);
DROP FUNCTION IF EXISTS public.mark_llm_request_provider_started_atomic(
  text, text, text, bigint
);
DROP FUNCTION IF EXISTS public.claim_llm_request_attempt_atomic(
  text, text, text, text, text, integer
);

DROP TABLE IF EXISTS public.llm_request_attempt_events;
DROP TABLE IF EXISTS public.llm_request_attempts;

NOTIFY pgrst, 'reload schema';
COMMIT;
