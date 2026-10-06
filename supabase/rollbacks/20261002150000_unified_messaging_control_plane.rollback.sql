BEGIN;
SET LOCAL lock_timeout = '10s';

-- A rollback that would erase delivery or retry evidence must stop. Resolve or
-- export the new control-plane rows before retrying this rollback.
DO $unified_messaging_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.message_events LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.message_dead_letters LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.message_outbox LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.message_deliveries LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.message_campaign_runs LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.message_campaigns LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.message_templates LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.message_surface_policies LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_UNIFIED_MESSAGING_EVIDENCE_EXISTS' USING ERRCODE = '55000';
  END IF;
END;
$unified_messaging_rollback_guard$;

DROP FUNCTION IF EXISTS public.get_unified_messaging_status();
DROP FUNCTION IF EXISTS public.settle_message_outbox_attempt(uuid, uuid, boolean, text, text, integer);
DROP FUNCTION IF EXISTS public.claim_message_outbox_batch(text, integer, integer);
DROP FUNCTION IF EXISTS public.enqueue_message_outbox_atomic(text, text, text, text, jsonb, text, uuid, uuid, integer, timestamptz, text);

DROP TRIGGER IF EXISTS message_dead_letters_updated_at ON public.message_dead_letters;
DROP TRIGGER IF EXISTS message_outbox_updated_at ON public.message_outbox;
DROP TRIGGER IF EXISTS message_deliveries_updated_at ON public.message_deliveries;
DROP TRIGGER IF EXISTS message_campaign_runs_updated_at ON public.message_campaign_runs;
DROP TRIGGER IF EXISTS message_campaigns_updated_at ON public.message_campaigns;
DROP TRIGGER IF EXISTS message_surface_policies_updated_at ON public.message_surface_policies;
DROP TRIGGER IF EXISTS message_templates_updated_at ON public.message_templates;

DROP TABLE IF EXISTS public.message_dead_letters;
DROP TABLE IF EXISTS public.message_outbox;
DROP TABLE IF EXISTS public.message_events;
DROP TABLE IF EXISTS public.message_deliveries;
DROP TABLE IF EXISTS public.message_campaign_runs;
DROP TABLE IF EXISTS public.message_campaigns;
DROP TABLE IF EXISTS public.message_surface_policies;
DROP TABLE IF EXISTS public.message_templates;
DROP FUNCTION IF EXISTS public.set_unified_message_updated_at();

NOTIFY pgrst, 'reload schema';
COMMIT;
