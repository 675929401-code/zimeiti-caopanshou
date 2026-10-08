-- Reconcile archive-queue privileges with the reviewed database semantic contract.
BEGIN;

GRANT ALL PRIVILEGES ON TABLE public.video_history_archive_jobs TO service_role;
REVOKE ALL ON FUNCTION public.enqueue_video_history_archive_job() FROM service_role;

COMMIT;
