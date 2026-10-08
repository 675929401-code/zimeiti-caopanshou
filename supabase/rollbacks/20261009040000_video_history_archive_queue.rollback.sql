-- Queue rollback removes only scheduling/control-plane objects. Successfully
-- archived media and task delivery URLs remain valid and are not destroyed.
BEGIN;

DROP TRIGGER IF EXISTS video_tasks_enqueue_history_archive ON public.video_tasks;
DROP FUNCTION IF EXISTS public.enqueue_video_history_archive_job();
DROP FUNCTION IF EXISTS public.fail_video_history_archive_attempt(text, text, text, boolean, integer);
DROP FUNCTION IF EXISTS public.complete_video_history_archive_job(text, text, text);
DROP FUNCTION IF EXISTS public.claim_video_history_archive_batch(text, integer, integer);
DROP INDEX IF EXISTS public.video_history_archive_jobs_lease_idx;
DROP INDEX IF EXISTS public.video_history_archive_jobs_ready_idx;
DROP TABLE IF EXISTS public.video_history_archive_jobs;

COMMIT;
