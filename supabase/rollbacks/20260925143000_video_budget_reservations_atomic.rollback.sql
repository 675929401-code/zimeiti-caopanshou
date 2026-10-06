BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.reserve_queued_digital_video_task_budget_atomic(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.reserve_video_generation_task_budget_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,
  text,text,text,text,integer,text,text,text,text,text,text,numeric,text
);
DROP TRIGGER IF EXISTS video_tasks_budget_reservation_atomic_before_insert
  ON public.video_tasks;
DROP FUNCTION IF EXISTS public.enforce_video_budget_reservation_atomic();

NOTIFY pgrst, 'reload schema';
COMMIT;
