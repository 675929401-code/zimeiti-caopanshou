BEGIN;

REVOKE ALL ON FUNCTION public.claim_video_history_poll_batch(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_video_history_poll_claim(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.release_video_history_poll_claim(text, text);
DROP FUNCTION IF EXISTS public.claim_video_history_poll_batch(text, integer, integer);
DROP INDEX IF EXISTS public.video_tasks_provider_poll_claim_idx;

ALTER TABLE public.video_tasks
  DROP COLUMN IF EXISTS provider_poll_lease_until,
  DROP COLUMN IF EXISTS provider_poll_lease_owner;

NOTIFY pgrst, 'reload schema';

COMMIT;
