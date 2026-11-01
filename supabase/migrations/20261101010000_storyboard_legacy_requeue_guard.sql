-- DRAFT independent forward migration: schema + function only, no pg_temp,
-- business-row updates, transaction controls, or edits to the original #9.
-- Normal versioned ledger prevents rerunning this migration.
ALTER TABLE public.video_history_archive_jobs
  ADD COLUMN legacy_requeue_blocked boolean NOT NULL DEFAULT false;

-- Replacement based on #9: only the two CASE predicates add the marker.
-- CREATE OR REPLACE retains function owner/ACL; original SECURITY DEFINER and
-- controlled search_path are preserved. Verify after all 20 migrations.
CREATE OR REPLACE FUNCTION public.enqueue_storyboard_video_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.task_label LIKE '分镜工作台%' AND NEW.status='completed' AND NEW.storyboard_archive_expires_at IS NOT NULL THEN
  INSERT INTO public.video_history_archive_jobs(task_id,expires_at)
   VALUES(NEW.id::text,NEW.storyboard_archive_expires_at) ON CONFLICT(task_id) DO UPDATE
   SET expires_at=coalesce(video_history_archive_jobs.expires_at,excluded.expires_at),
       state=CASE WHEN video_history_archive_jobs.state IN ('source_expired','dead_letter')
          AND NOT video_history_archive_jobs.legacy_requeue_blocked
          AND NEW.storyboard_archive_expires_at>now() AND NEW.history_hidden_at IS NULL AND NEW.source_expired_at IS NULL
          AND coalesce(NEW.provider_result_url,NEW.video_url,'') ~ '^https?://'
          AND (video_history_archive_jobs.lease_until IS NULL OR video_history_archive_jobs.lease_until<=now())
        THEN 'queued' ELSE video_history_archive_jobs.state END,
       next_attempt_at=CASE WHEN video_history_archive_jobs.state IN ('source_expired','dead_letter')
          AND NOT video_history_archive_jobs.legacy_requeue_blocked
          AND NEW.storyboard_archive_expires_at>now() AND NEW.history_hidden_at IS NULL AND NEW.source_expired_at IS NULL
          AND coalesce(NEW.provider_result_url,NEW.video_url,'') ~ '^https?://'
          AND (video_history_archive_jobs.lease_until IS NULL OR video_history_archive_jobs.lease_until<=now())
        THEN now() ELSE video_history_archive_jobs.next_attempt_at END;
   UPDATE public.video_tasks task SET storyboard_archive_state=job.state
    FROM public.video_history_archive_jobs job WHERE task.id=NEW.id AND job.task_id=NEW.id::text;
 END IF;
 RETURN NEW;
END $$;
