BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.extraction_attempts WHERE request_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EXTRACTION_REQUEST_SNAPSHOT_ROLLBACK_BLOCKED_NONEMPTY';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.checkpoint_extraction_request_atomic(text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.read_extraction_account_history(
  p_user_id text, p_before timestamptz DEFAULT NULL, p_before_id text DEFAULT NULL, p_limit integer DEFAULT 21
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC, r.record_id DESC), '[]'::jsonb)
  FROM (
    SELECT a.record_id, a.client_request_id, a.request_kind, a.state, a.created_at, a.updated_at,
           a.response, a.error_code, a.error_message, a.billing_evidence
    FROM public.extraction_attempts a
    LEFT JOIN public.extraction_history_preferences s ON s.user_id = a.user_id
    WHERE a.user_id = p_user_id
      AND a.request_kind IN ('single', 'batch', 'search', 'coze')
      AND (s.cleared_before IS NULL OR a.created_at > s.cleared_before)
      AND NOT EXISTS (SELECT 1 FROM public.extraction_history_hidden h WHERE h.user_id = a.user_id AND h.record_id = a.record_id)
      AND (p_before IS NULL OR (a.created_at, a.record_id) < (p_before, coalesce(p_before_id, '')))
    ORDER BY a.created_at DESC, a.record_id DESC
    LIMIT greatest(1, least(coalesce(p_limit, 21), 31))
  ) r;
$$;

REVOKE ALL ON FUNCTION public.read_extraction_account_history(text, timestamptz, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_extraction_account_history(text, timestamptz, text, integer)
  TO service_role;

ALTER TABLE public.extraction_attempts
  DROP CONSTRAINT IF EXISTS extraction_attempts_request_snapshot_object;
ALTER TABLE public.extraction_attempts
  DROP COLUMN IF EXISTS request_snapshot;

NOTIFY pgrst, 'reload schema';
COMMIT;
