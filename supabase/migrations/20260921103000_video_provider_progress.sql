-- Persist supplier-observed progress independently from browser connections.
-- This lets both video surfaces resume the same task after refresh without
-- fabricating a percentage when a supplier only reports queued/processing.
ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS provider_progress numeric(6,3),
  ADD COLUMN IF NOT EXISTS provider_status_message text,
  ADD COLUMN IF NOT EXISTS provider_last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_poll_failures integer NOT NULL DEFAULT 0;

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_provider_progress_check,
  ADD CONSTRAINT video_tasks_provider_progress_check CHECK (
    provider_progress IS NULL OR provider_progress BETWEEN 0 AND 100
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_provider_poll_failures_check,
  ADD CONSTRAINT video_tasks_provider_poll_failures_check CHECK (provider_poll_failures >= 0);

CREATE INDEX IF NOT EXISTS video_tasks_provider_poll_priority_idx
  ON public.video_tasks (provider_last_polled_at ASC NULLS FIRST, created_at ASC, id ASC)
  WHERE status IN ('pending', 'queued', 'processing', 'generating');

COMMENT ON COLUMN public.video_tasks.provider_progress IS
  'Latest real supplier-reported progress normalized to 0..100; NULL means the supplier did not report a percentage.';
COMMENT ON COLUMN public.video_tasks.provider_status_message IS
  'Latest public-safe supplier status summary. Raw supplier diagnostics are never stored here.';
COMMENT ON COLUMN public.video_tasks.provider_last_polled_at IS
  'Last time the background media worker received or attempted a supplier status response.';
COMMENT ON COLUMN public.video_tasks.provider_poll_failures IS
  'Consecutive supplier status read failures; reset to zero after a successful status response.';

NOTIFY pgrst, 'reload schema';
