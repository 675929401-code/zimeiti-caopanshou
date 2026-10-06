BEGIN;
SET LOCAL lock_timeout = '10s';

-- Read receipts and explicit repushes are durable user/audit evidence. Once
-- either exists, use a forward repair instead of deleting delivery history.
DO $announcement_rollback_guard$
BEGIN
  IF to_regclass('public.announcement_user_reads') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.announcement_user_reads LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_ANNOUNCEMENT_READ_EVIDENCE_EXISTS';
  END IF;
  IF to_regclass('public.announcement_push_runs') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.announcement_push_runs
       WHERE push_kind = 'repush'
       LIMIT 1
     ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_ANNOUNCEMENT_REPUSH_EVIDENCE_EXISTS';
  END IF;
END;
$announcement_rollback_guard$;

DROP TRIGGER IF EXISTS announcements_record_initial_push ON public.announcements;
DROP TRIGGER IF EXISTS announcements_initialize_first_push ON public.announcements;
DROP FUNCTION IF EXISTS public.get_announcement_delivery_status(text, integer, integer, integer, text);
DROP FUNCTION IF EXISTS public.repush_announcement_atomic(text, text, integer, text);
DROP FUNCTION IF EXISTS public.mark_announcement_read(text, text, integer);
DROP FUNCTION IF EXISTS public.record_announcement_initial_push();
DROP FUNCTION IF EXISTS public.initialize_announcement_first_push();
DROP FUNCTION IF EXISTS public.count_announcement_account_targets(text, jsonb);
DROP TABLE IF EXISTS public.announcement_user_reads;
DROP TABLE IF EXISTS public.announcement_push_runs;

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_delivery_window_check,
  DROP CONSTRAINT IF EXISTS announcements_push_revision_check,
  DROP CONSTRAINT IF EXISTS announcements_max_impressions_check,
  DROP CONSTRAINT IF EXISTS announcements_frequency_hours_check,
  DROP CONSTRAINT IF EXISTS announcements_target_user_ids_array_check,
  DROP CONSTRAINT IF EXISTS announcements_target_audience_check,
  DROP CONSTRAINT IF EXISTS announcements_status_check,
  DROP CONSTRAINT IF EXISTS announcements_priority_check,
  DROP COLUMN IF EXISTS last_pushed_at,
  DROP COLUMN IF EXISTS first_published_at,
  DROP COLUMN IF EXISTS push_revision,
  DROP COLUMN IF EXISTS require_ack,
  DROP COLUMN IF EXISTS max_impressions,
  DROP COLUMN IF EXISTS frequency_hours,
  DROP COLUMN IF EXISTS target_user_ids,
  DROP COLUMN IF EXISTS target_audience,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS publish_at,
  DROP COLUMN IF EXISTS summary,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS priority;

NOTIFY pgrst, 'reload schema';
COMMIT;
