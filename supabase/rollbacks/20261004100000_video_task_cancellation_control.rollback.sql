BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.video_task_cancel_intents') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.video_task_cancel_intents LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_VIDEO_CANCELLATION_INTENTS_EXIST';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS guard_cancelled_video_client_request_trigger ON public.video_tasks;
DROP FUNCTION IF EXISTS public.guard_cancelled_video_client_request();
DROP FUNCTION IF EXISTS public.confirm_video_task_upstream_cancellation_atomic(text,text,text,text);
DROP FUNCTION IF EXISTS public.request_video_task_cancellation_atomic(text,text);
DROP TABLE IF EXISTS public.video_task_cancel_intents;

NOTIFY pgrst, 'reload schema';
COMMIT;
