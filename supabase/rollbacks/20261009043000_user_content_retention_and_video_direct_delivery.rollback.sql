-- Emergency compatibility rollback. Content already purged by the forward
-- migration cannot be reconstructed without the pre-migration database backup.
BEGIN;

DROP TRIGGER IF EXISTS extraction_attempts_scrub_transient_video_content
  ON public.extraction_attempts;
DROP FUNCTION IF EXISTS public.scrub_transient_video_extraction_content();
DROP FUNCTION IF EXISTS public.purge_expired_user_content(integer, integer, integer);
DROP FUNCTION IF EXISTS public.mark_video_upstream_source_expired(text, text, integer);

CREATE OR REPLACE FUNCTION public.read_extraction_account_history(
  p_user_id text,
  p_before timestamptz DEFAULT NULL,
  p_before_id text DEFAULT NULL,
  p_limit integer DEFAULT 21
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC, r.record_id DESC), '[]'::jsonb)
  FROM (
    SELECT a.record_id,
           a.client_request_id,
           a.request_kind,
           a.state,
           a.created_at,
           a.updated_at,
           a.response,
           a.request_snapshot,
           a.error_code,
           a.error_message,
           a.billing_evidence
      FROM public.extraction_attempts a
      LEFT JOIN public.extraction_history_preferences s ON s.user_id = a.user_id
     WHERE a.user_id = p_user_id
       AND a.request_kind IN ('single', 'batch', 'search', 'coze')
       AND a.content_purged_at IS NULL
       AND (s.cleared_before IS NULL OR a.created_at > s.cleared_before)
       AND NOT EXISTS (
         SELECT 1
           FROM public.extraction_history_hidden h
          WHERE h.user_id = a.user_id
            AND h.record_id = a.record_id
       )
       AND (p_before IS NULL OR (a.created_at, a.record_id) < (p_before, coalesce(p_before_id, '')))
     ORDER BY a.created_at DESC, a.record_id DESC
     LIMIT greatest(1, least(coalesce(p_limit, 21), 31))
  ) r;
$$;

REVOKE ALL ON FUNCTION public.read_extraction_account_history(text, timestamptz, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_extraction_account_history(text, timestamptz, text, integer)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.claim_video_history_archive_batch(text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_video_history_archive_job(text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_video_history_archive_attempt(text, text, text, boolean, integer)
  TO service_role;

DROP TRIGGER IF EXISTS video_tasks_enqueue_history_archive ON public.video_tasks;
CREATE TRIGGER video_tasks_enqueue_history_archive
AFTER INSERT OR UPDATE OF status, storage_url, provider_result_url, video_url
ON public.video_tasks
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_video_history_archive_job();

UPDATE public.video_history_archive_jobs job
   SET state = 'queued',
       next_attempt_at = now(),
       last_error_code = NULL,
       updated_at = now()
  FROM public.video_tasks task
 WHERE task.id::text = job.task_id
   AND job.state = 'dead_letter'
   AND job.last_error_code = 'ARCHIVE_POLICY_RETIRED_DIRECT_DELIVERY'
   AND nullif(trim(coalesce(task.storage_url, '')), '') IS NULL
   AND nullif(trim(coalesce(task.provider_result_url, task.video_url, '')), '') IS NOT NULL
   AND coalesce(task.completed_at, task.created_at) > now() - interval '3 days';

-- Keep source_expired_at/content_purged_at and the expanded terminal constraint:
-- dropping them could make already-scrubbed rows invalid or erase audit state.
DROP INDEX IF EXISTS public.video_tasks_source_expired_idx;
DROP INDEX IF EXISTS public.extraction_attempts_content_retention_idx;
DROP INDEX IF EXISTS public.conversations_content_retention_idx;
DROP INDEX IF EXISTS public.conversation_messages_content_retention_idx;

NOTIFY pgrst, 'reload schema';
COMMIT;
