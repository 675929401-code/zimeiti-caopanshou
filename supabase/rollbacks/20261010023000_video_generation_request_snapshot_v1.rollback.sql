BEGIN;
SET LOCAL lock_timeout = '10s';

-- Destructive disaster rollback only. Normal application rollback must leave
-- this additive history schema in place. Refuse to erase persisted request
-- snapshots; operators must restore or forward-fix instead of dropping evidence.
DO $$
BEGIN
  IF current_setting('app.allow_destructive_video_snapshot_rollback', true)
       IS DISTINCT FROM 'BACKUP_VERIFIED_AND_NO_NEW_SNAPSHOTS' THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_ROLLBACK_EXPLICIT_CONFIRMATION_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.video_tasks
     WHERE request_snapshot IS NOT NULL
        OR request_snapshot_hash IS NOT NULL
        OR request_snapshot_version IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_SNAPSHOT_ROLLBACK_WOULD_DELETE_HISTORY';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text);
DROP FUNCTION IF EXISTS public.reserve_video_generation_task_request_snapshot_v1_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text
);
DROP FUNCTION IF EXISTS public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text);

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_request_snapshot_v1_check,
  DROP COLUMN IF EXISTS request_snapshot_version,
  DROP COLUMN IF EXISTS request_snapshot_hash,
  DROP COLUMN IF EXISTS request_snapshot;

COMMIT;
