-- Ordinary generated videos remain provider-hosted and are delivered through
-- the authenticated proxy. User-visible extraction content is retained for 10
-- days, conversation content for 30 days, while billing/idempotency evidence
-- and user-owned agent/role libraries remain durable.
BEGIN;

-- Retire the global video archive copy pipeline without deleting its audit
-- rows. Existing persistent assets remain readable as legacy exceptions.
DROP TRIGGER IF EXISTS video_tasks_enqueue_history_archive ON public.video_tasks;

REVOKE ALL ON FUNCTION public.claim_video_history_archive_batch(text, integer, integer)
  FROM service_role;
REVOKE ALL ON FUNCTION public.complete_video_history_archive_job(text, text, text)
  FROM service_role;
REVOKE ALL ON FUNCTION public.fail_video_history_archive_attempt(text, text, text, boolean, integer)
  FROM service_role;

UPDATE public.video_history_archive_jobs
   SET state = 'dead_letter',
       lease_owner = NULL,
       lease_until = NULL,
       last_error_code = 'ARCHIVE_POLICY_RETIRED_DIRECT_DELIVERY',
       updated_at = now()
 WHERE state IN ('queued', 'retry', 'leased');

ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS source_expired_at timestamptz;

CREATE INDEX IF NOT EXISTS video_tasks_source_expired_idx
  ON public.video_tasks(source_expired_at, user_id, created_at DESC)
  WHERE source_expired_at IS NOT NULL;

ALTER TABLE public.extraction_attempts
  ADD COLUMN IF NOT EXISTS content_purged_at timestamptz;

CREATE INDEX IF NOT EXISTS extraction_attempts_content_retention_idx
  ON public.extraction_attempts(created_at, record_id)
  WHERE state IN ('succeeded', 'failed') AND content_purged_at IS NULL;

CREATE INDEX IF NOT EXISTS conversations_content_retention_idx
  ON public.conversations(coalesce(updated_at, created_at), id);

CREATE INDEX IF NOT EXISTS conversation_messages_content_retention_idx
  ON public.conversation_messages(created_at, id);

ALTER TABLE public.extraction_attempts
  DROP CONSTRAINT IF EXISTS extraction_attempts_terminal_shape;

ALTER TABLE public.extraction_attempts
  ADD CONSTRAINT extraction_attempts_terminal_shape CHECK (
    (state = 'running' AND http_status IS NULL AND response IS NULL AND content_purged_at IS NULL)
    OR (
      state = 'succeeded'
      AND http_status IS NOT NULL
      AND http_status BETWEEN 200 AND 299
      AND (
        (response IS NOT NULL AND content_purged_at IS NULL)
        OR (response IS NULL AND content_purged_at IS NOT NULL)
      )
    )
    OR (
      state = 'failed'
      AND http_status IS NOT NULL
      AND (
        (response IS NOT NULL AND content_purged_at IS NULL)
        OR (response IS NULL AND content_purged_at IS NOT NULL)
      )
    )
    OR (state = 'failed_unknown' AND response IS NULL AND content_purged_at IS NULL)
  );

-- Raw video extraction is a one-time delivery. The first HTTP response is
-- returned from application memory, while the durable attempt keeps only the
-- idempotency/provider/billing audit. Unresolved failed_unknown attempts keep
-- their request snapshot until an operator reconciles them.
CREATE OR REPLACE FUNCTION public.scrub_transient_video_extraction_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_extraction_mode text := lower(trim(coalesce(
    NEW.request_snapshot #>> '{payload,extraction_mode}',
    OLD.request_snapshot #>> '{payload,extraction_mode}',
    ''
  )));
BEGIN
  IF NEW.state IN ('succeeded', 'failed') AND v_extraction_mode = 'video' THEN
    NEW.provider_evidence := coalesce(NEW.provider_evidence, '{}'::jsonb)
      || jsonb_build_object('content_retention', 'video_transient');
    NEW.response := NULL;
    NEW.request_snapshot := NULL;
    NEW.error_message := NULL;
    NEW.content_purged_at := coalesce(NEW.content_purged_at, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_transient_video_extraction_content()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS extraction_attempts_scrub_transient_video_content
  ON public.extraction_attempts;
CREATE TRIGGER extraction_attempts_scrub_transient_video_content
BEFORE UPDATE OF state, response, request_snapshot
ON public.extraction_attempts
FOR EACH ROW
EXECUTE FUNCTION public.scrub_transient_video_extraction_content();

-- Apply the same no-history rule to terminal raw-video rows that predate this
-- migration. Audit fields and charge evidence remain untouched.
UPDATE public.extraction_attempts
   SET provider_evidence = coalesce(provider_evidence, '{}'::jsonb)
         || jsonb_build_object('content_retention', 'video_transient'),
       response = NULL,
       request_snapshot = NULL,
       error_message = NULL,
       content_purged_at = coalesce(content_purged_at, clock_timestamp()),
       updated_at = clock_timestamp()
 WHERE state IN ('succeeded', 'failed')
   AND content_purged_at IS NULL
   AND lower(trim(coalesce(request_snapshot #>> '{payload,extraction_mode}', ''))) = 'video';

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
       AND a.created_at > now() - interval '10 days'
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

CREATE OR REPLACE FUNCTION public.mark_video_upstream_source_expired(
  p_task_id text,
  p_user_id text,
  p_http_status integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_marked_at timestamptz;
BEGIN
  IF trim(coalesce(p_task_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR p_http_status NOT IN (404, 410) THEN
    RAISE EXCEPTION 'VIDEO_SOURCE_EXPIRY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_SOURCE_EXPIRY_TASK_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.status <> 'completed' THEN
    RAISE EXCEPTION 'VIDEO_SOURCE_EXPIRY_TASK_NOT_COMPLETED' USING ERRCODE = '55000';
  END IF;
  IF nullif(trim(coalesce(v_task.storage_url, '')), '') IS NOT NULL THEN
    RETURN jsonb_build_object(
      'marked', false,
      'reason', 'persistent_legacy_asset',
      'task_id', v_task.id::text
    );
  END IF;

  v_marked_at := coalesce(v_task.source_expired_at, clock_timestamp());
  UPDATE public.video_tasks
     SET source_expired_at = v_marked_at,
         history_hidden_at = coalesce(history_hidden_at, v_marked_at),
         provider_result_url = NULL,
         video_url = NULL,
         content_url = NULL,
         thumbnail_url = NULL,
         needs_proxy = false
   WHERE id = v_task.id;

  UPDATE public.video_history_archive_jobs
     SET state = 'source_expired',
         source_expired_at = coalesce(source_expired_at, v_marked_at),
         lease_owner = NULL,
         lease_until = NULL,
         last_error_code = 'UPSTREAM_SOURCE_HTTP_' || p_http_status::text,
         updated_at = now()
   WHERE task_id = v_task.id::text
     AND state <> 'completed';

  RETURN jsonb_build_object(
    'marked', true,
    'already_marked', v_task.source_expired_at IS NOT NULL,
    'task_id', v_task.id::text,
    'source_expired_at', v_marked_at,
    'http_status', p_http_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_video_upstream_source_expired(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_video_upstream_source_expired(text, text, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.purge_expired_user_content(
  p_conversation_days integer DEFAULT 30,
  p_extraction_days integer DEFAULT 10,
  p_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conversation_days integer := greatest(30, least(coalesce(p_conversation_days, 30), 3650));
  v_extraction_days integer := greatest(10, least(coalesce(p_extraction_days, 10), 3650));
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_conversation_ids text[] := ARRAY[]::text[];
  v_message_ids text[] := ARRAY[]::text[];
  v_settings_deleted integer := 0;
  v_attachments_deleted integer := 0;
  v_conversation_attachments_deleted integer := 0;
  v_messages_deleted integer := 0;
  v_expired_messages_deleted integer := 0;
  v_conversation_messages_deleted integer := 0;
  v_conversations_deleted integer := 0;
  v_extractions_purged integer := 0;
  v_has_more_messages boolean := false;
  v_has_more_conversations boolean := false;
  v_has_more_extractions boolean := false;
BEGIN
  SELECT coalesce(array_agg(candidate.id ORDER BY candidate.created_at, candidate.id), ARRAY[]::text[])
    INTO v_message_ids
    FROM (
      SELECT message.id, message.created_at
        FROM public.conversation_messages message
       WHERE message.created_at <= now() - make_interval(days => v_conversation_days)
       ORDER BY message.created_at, message.id
       LIMIT v_limit
       FOR UPDATE SKIP LOCKED
    ) candidate;

  IF cardinality(v_message_ids) > 0 THEN
    DELETE FROM public.conversation_message_attachments
     WHERE message_id = ANY(v_message_ids);
    GET DIAGNOSTICS v_attachments_deleted = ROW_COUNT;

    DELETE FROM public.conversation_messages
     WHERE id = ANY(v_message_ids);
    GET DIAGNOSTICS v_expired_messages_deleted = ROW_COUNT;
    v_messages_deleted := v_expired_messages_deleted;
  END IF;

  SELECT coalesce(array_agg(candidate.id ORDER BY candidate.retention_at, candidate.id), ARRAY[]::text[])
    INTO v_conversation_ids
    FROM (
      SELECT conversation.id,
             coalesce(conversation.updated_at, conversation.created_at) AS retention_at
        FROM public.conversations conversation
       WHERE coalesce(conversation.updated_at, conversation.created_at)
             <= now() - make_interval(days => v_conversation_days)
       ORDER BY coalesce(conversation.updated_at, conversation.created_at), conversation.id
       LIMIT v_limit
       FOR UPDATE SKIP LOCKED
    ) candidate;

  IF cardinality(v_conversation_ids) > 0 THEN
    DELETE FROM public.text_chat_conversation_settings
     WHERE conversation_id = ANY(v_conversation_ids);
    GET DIAGNOSTICS v_settings_deleted = ROW_COUNT;

    DELETE FROM public.conversation_message_attachments
     WHERE conversation_id = ANY(v_conversation_ids);
    GET DIAGNOSTICS v_conversation_attachments_deleted = ROW_COUNT;
    v_attachments_deleted := v_attachments_deleted + v_conversation_attachments_deleted;

    DELETE FROM public.conversation_messages
     WHERE conversation_id = ANY(v_conversation_ids);
    GET DIAGNOSTICS v_conversation_messages_deleted = ROW_COUNT;
    v_messages_deleted := v_messages_deleted + v_conversation_messages_deleted;

    DELETE FROM public.conversations
     WHERE id = ANY(v_conversation_ids);
    GET DIAGNOSTICS v_conversations_deleted = ROW_COUNT;
  END IF;

  WITH candidates AS (
    SELECT attempt.record_id,
           lower(trim(coalesce(attempt.request_snapshot #>> '{payload,extraction_mode}', ''))) = 'video'
             AS is_transient_video
      FROM public.extraction_attempts attempt
     WHERE attempt.state IN ('succeeded', 'failed')
       AND attempt.content_purged_at IS NULL
       AND (
         lower(trim(coalesce(attempt.request_snapshot #>> '{payload,extraction_mode}', ''))) = 'video'
         OR attempt.created_at <= now() - make_interval(days => v_extraction_days)
       )
     ORDER BY attempt.created_at, attempt.record_id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.extraction_attempts attempt
     SET response = NULL,
         request_snapshot = NULL,
         error_message = NULL,
         provider_evidence = coalesce(attempt.provider_evidence, '{}'::jsonb)
           || jsonb_build_object(
             'content_retention',
             CASE WHEN candidates.is_transient_video
               THEN 'video_transient'
               ELSE 'expired_after_10_days'
             END
           ),
         content_purged_at = clock_timestamp(),
         updated_at = clock_timestamp()
    FROM candidates
   WHERE attempt.record_id = candidates.record_id;
  GET DIAGNOSTICS v_extractions_purged = ROW_COUNT;

  SELECT EXISTS (
    SELECT 1
      FROM public.conversation_messages message
     WHERE message.created_at <= now() - make_interval(days => v_conversation_days)
  ) INTO v_has_more_messages;

  SELECT EXISTS (
    SELECT 1
      FROM public.conversations conversation
     WHERE coalesce(conversation.updated_at, conversation.created_at)
           <= now() - make_interval(days => v_conversation_days)
  ) INTO v_has_more_conversations;

  SELECT EXISTS (
    SELECT 1
     FROM public.extraction_attempts attempt
     WHERE attempt.state IN ('succeeded', 'failed')
       AND attempt.content_purged_at IS NULL
       AND (
         lower(trim(coalesce(attempt.request_snapshot #>> '{payload,extraction_mode}', ''))) = 'video'
         OR attempt.created_at <= now() - make_interval(days => v_extraction_days)
       )
  ) INTO v_has_more_extractions;

  RETURN jsonb_build_object(
    'conversation_settings_deleted', v_settings_deleted,
    'conversation_attachments_deleted', v_attachments_deleted,
    'conversation_messages_deleted', v_messages_deleted,
    'conversations_deleted', v_conversations_deleted,
    'extractions_purged', v_extractions_purged,
    'has_more', v_has_more_messages OR v_has_more_conversations OR v_has_more_extractions,
    'protected_collections', jsonb_build_array(
      'agents',
      'agent_memories',
      'text_chat_memories',
      'user_files',
      'billing_evidence',
      'provider_evidence'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_user_content(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_user_content(integer, integer, integer)
  TO service_role;

COMMENT ON COLUMN public.video_tasks.source_expired_at IS
  'Definitive upstream 404/410 observed after all supported fetch paths failed; billing and task evidence remain.';
COMMENT ON COLUMN public.extraction_attempts.content_purged_at IS
  'User-visible request/result content was removed immediately for raw video extraction or after the text retention window; provider, billing and idempotency evidence remain.';
COMMENT ON FUNCTION public.scrub_transient_video_extraction_content() IS
  'Removes terminal raw-video extraction request/result content in the same transaction while preserving exactly-once, provider and billing evidence.';
COMMENT ON FUNCTION public.purge_expired_user_content(integer, integer, integer) IS
  'Deletes conversation content after 30 days, scrubs raw-video extraction content immediately and other extraction content after 10 days; never deletes agents, role libraries, long-term memories, user files, billing or provider evidence.';

NOTIFY pgrst, 'reload schema';
COMMIT;
