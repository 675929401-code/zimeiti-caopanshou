DROP INDEX IF EXISTS public.video_tasks_provider_poll_priority_idx;

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_provider_progress_check,
  DROP CONSTRAINT IF EXISTS video_tasks_provider_poll_failures_check,
  DROP COLUMN IF EXISTS provider_progress,
  DROP COLUMN IF EXISTS provider_status_message,
  DROP COLUMN IF EXISTS provider_last_polled_at,
  DROP COLUMN IF EXISTS provider_poll_failures;

NOTIFY pgrst, 'reload schema';
