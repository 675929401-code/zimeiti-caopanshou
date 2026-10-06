BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.security_event_outbox') IS NOT NULL
     AND EXISTS(SELECT 1 FROM public.security_event_outbox LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_OUTBOX';
  END IF;
  IF to_regclass('public.security_event_delivery_attempts') IS NOT NULL
     AND EXISTS(SELECT 1 FROM public.security_event_delivery_attempts LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_ATTEMPTS';
  END IF;
  IF to_regclass('public.security_event_dead_letters') IS NOT NULL
     AND EXISTS(SELECT 1 FROM public.security_event_dead_letters LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_DEAD_LETTERS';
  END IF;
  IF to_regclass('public.security_rate_limit_windows') IS NOT NULL
     AND EXISTS(SELECT 1 FROM public.security_rate_limit_windows LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_RATE_STATE';
  END IF;
  IF to_regclass('public.security_ip_risk_state') IS NOT NULL
     AND EXISTS(SELECT 1 FROM public.security_ip_risk_state LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_IP_STATE';
  END IF;
  IF EXISTS(SELECT 1 FROM public.security_events WHERE reliable_ingest_id IS NOT NULL LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_NO_MATERIALIZED_EVENTS';
  END IF;
  IF to_regclass('public.security_event_retention_policies') IS NOT NULL AND (
    (SELECT count(*) FROM public.security_event_retention_policies)<>4
    OR EXISTS(
      SELECT 1 FROM public.security_event_retention_policies
       WHERE (risk_level='low' AND (retention_days<>30 OR policy_version<>1))
          OR (risk_level='medium' AND (retention_days<>90 OR policy_version<>1))
          OR (risk_level='high' AND (retention_days<>180 OR policy_version<>1))
          OR (risk_level='critical' AND (retention_days<>365 OR policy_version<>1))
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_UNCHANGED_RETENTION_POLICY';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS security_ip_risk_write_guard ON public.security_ip_risk_state;
DROP TRIGGER IF EXISTS security_rate_limit_write_guard ON public.security_rate_limit_windows;
DROP TRIGGER IF EXISTS security_event_dead_letters_write_guard ON public.security_event_dead_letters;
DROP TRIGGER IF EXISTS security_event_attempts_write_guard ON public.security_event_delivery_attempts;
DROP TRIGGER IF EXISTS security_event_outbox_write_guard ON public.security_event_outbox;

DROP FUNCTION IF EXISTS public.get_security_event_reliability_status();
DROP FUNCTION IF EXISTS public.consume_security_rate_limit_atomic(text,text,integer,integer,integer);
DROP FUNCTION IF EXISTS public.settle_security_event_outbox_attempt(uuid,uuid,boolean,text,text,integer);
DROP FUNCTION IF EXISTS public.claim_security_event_outbox_batch(text,integer,integer);
DROP FUNCTION IF EXISTS public.enqueue_security_event_atomic(text,text,timestamptz,text,text,text,text,text,text,text,text,boolean,text,timestamptz);
DROP FUNCTION IF EXISTS public.guard_security_reliability_append_only();
DROP FUNCTION IF EXISTS public.guard_security_reliability_write();

DROP TABLE IF EXISTS public.security_event_delivery_attempts;
DROP TABLE IF EXISTS public.security_event_dead_letters;
DROP TABLE IF EXISTS public.security_event_outbox;
DROP TABLE IF EXISTS public.security_rate_limit_windows;
DROP TABLE IF EXISTS public.security_ip_risk_state;
DROP TABLE IF EXISTS public.security_event_retention_policies;

DROP INDEX IF EXISTS public.security_events_retention_due_idx;
DROP INDEX IF EXISTS public.security_events_reliable_ingest_unique;
ALTER TABLE public.security_events DROP CONSTRAINT IF EXISTS security_events_reliable_privacy_check;
ALTER TABLE public.security_events
  DROP COLUMN IF EXISTS retention_until,
  DROP COLUMN IF EXISTS privacy_version,
  DROP COLUMN IF EXISTS last_observed_at,
  DROP COLUMN IF EXISTS first_observed_at,
  DROP COLUMN IF EXISTS occurrence_count,
  DROP COLUMN IF EXISTS event_fingerprint,
  DROP COLUMN IF EXISTS reliable_ingest_id;

DROP FUNCTION IF EXISTS public.security_reliability_text_is_safe(text);

NOTIFY pgrst,'reload schema';
COMMIT;
