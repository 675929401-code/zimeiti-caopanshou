BEGIN;

-- Guarded teardown for an unused phase-1 control plane. Once any case,
-- evidence, action or audit exists, preserve it and use a reviewed forward
-- migration instead of deleting the incident record.
DO $$
BEGIN
  IF to_regclass('public.security_cases') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.security_cases LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_CASES';
  END IF;
  IF to_regclass('public.security_case_events') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.security_case_events LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_EVENTS';
  END IF;
  IF to_regclass('public.security_case_links') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.security_case_links LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_LINKS';
  END IF;
  IF to_regclass('public.security_case_actions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.security_case_actions LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_ACTIONS';
  END IF;
  IF to_regclass('public.security_case_audit') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.security_case_audit LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_AUDIT';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS security_case_audit_write_guard ON public.security_case_audit;
DROP TRIGGER IF EXISTS security_case_actions_write_guard ON public.security_case_actions;
DROP TRIGGER IF EXISTS security_case_links_write_guard ON public.security_case_links;
DROP TRIGGER IF EXISTS security_case_events_write_guard ON public.security_case_events;
DROP TRIGGER IF EXISTS security_cases_write_guard ON public.security_cases;

DROP FUNCTION IF EXISTS public.cancel_security_case_action_atomic(uuid,uuid,bigint,text,text,text);
DROP FUNCTION IF EXISTS public.request_security_case_action_atomic(uuid,bigint,text,text,text,jsonb,text,text,text);
DROP FUNCTION IF EXISTS public.link_security_case_entity_atomic(uuid,bigint,text,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.claim_security_case_atomic(uuid,bigint,text,text,text);
DROP FUNCTION IF EXISTS public.transition_security_case_atomic(uuid,bigint,text,text,text,text);
DROP FUNCTION IF EXISTS public.ingest_security_case_event_atomic(text,text,text,text,text,integer,text,text,timestamptz,text,jsonb,jsonb,text);
DROP FUNCTION IF EXISTS public.guard_security_case_audit_immutable();
DROP FUNCTION IF EXISTS public.guard_security_case_append_only();
DROP FUNCTION IF EXISTS public.guard_security_case_record_write();

DROP TABLE IF EXISTS public.security_case_audit;
DROP TABLE IF EXISTS public.security_case_actions;
DROP TABLE IF EXISTS public.security_case_links;
DROP TABLE IF EXISTS public.security_case_events;
DROP TABLE IF EXISTS public.security_cases;

DROP FUNCTION IF EXISTS public.security_case_impact_is_safe(jsonb);
DROP FUNCTION IF EXISTS public.security_case_evidence_is_safe(jsonb);
DROP FUNCTION IF EXISTS public.security_case_text_is_safe(text);
DROP FUNCTION IF EXISTS public.security_case_risk_level(integer);

NOTIFY pgrst, 'reload schema';

COMMIT;
