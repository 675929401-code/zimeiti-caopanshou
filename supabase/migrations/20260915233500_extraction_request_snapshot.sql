BEGIN;

ALTER TABLE public.extraction_attempts
  ADD COLUMN IF NOT EXISTS request_snapshot jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.extraction_attempts'::regclass
      AND conname = 'extraction_attempts_request_snapshot_object'
  ) THEN
    ALTER TABLE public.extraction_attempts
      ADD CONSTRAINT extraction_attempts_request_snapshot_object CHECK (
        request_snapshot IS NULL
        OR (
          jsonb_typeof(request_snapshot) = 'object'
          AND octet_length(request_snapshot::text) <= 131072
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.checkpoint_extraction_request_atomic(
  p_record_id text,
  p_user_id text,
  p_payload_fingerprint text,
  p_request_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.extraction_attempts%ROWTYPE;
BEGIN
  IF trim(coalesce(p_record_id, '')) !~ '^[a-f0-9]{64}$'
     OR trim(coalesce(p_user_id, '')) = ''
     OR trim(coalesce(p_payload_fingerprint, '')) !~ '^[a-f0-9]{64}$'
     OR p_request_snapshot IS NULL
     OR jsonb_typeof(p_request_snapshot) <> 'object'
     OR p_request_snapshot->>'schema' <> 'extraction_request_snapshot.v1'
     OR jsonb_typeof(p_request_snapshot->'payload') <> 'object'
     OR octet_length(p_request_snapshot::text) > 131072 THEN
    RAISE EXCEPTION 'EXTRACTION_REQUEST_SNAPSHOT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.extraction_attempts
   WHERE record_id = trim(p_record_id)
     AND user_id = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXTRACTION_REQUEST_SNAPSHOT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.payload_fingerprint <> trim(p_payload_fingerprint) THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_row.state <> 'running' THEN
    RAISE EXCEPTION 'EXTRACTION_REQUEST_SNAPSHOT_CLOSED' USING ERRCODE = '22023';
  END IF;
  IF v_row.request_kind <> p_request_snapshot->>'request_kind' THEN
    RAISE EXCEPTION 'EXTRACTION_REQUEST_SNAPSHOT_KIND_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_row.request_snapshot IS NOT NULL
     AND v_row.request_snapshot IS DISTINCT FROM p_request_snapshot THEN
    RAISE EXCEPTION 'EXTRACTION_REQUEST_SNAPSHOT_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF v_row.request_snapshot IS NULL THEN
    UPDATE public.extraction_attempts
       SET request_snapshot = p_request_snapshot,
           updated_at = now()
     WHERE record_id = v_row.record_id
     RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object('record', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.read_extraction_account_history(
  p_user_id text, p_before timestamptz DEFAULT NULL, p_before_id text DEFAULT NULL, p_limit integer DEFAULT 21
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC, r.record_id DESC), '[]'::jsonb)
  FROM (
    SELECT a.record_id, a.client_request_id, a.request_kind, a.state, a.created_at, a.updated_at,
           a.response, a.request_snapshot, a.error_code, a.error_message, a.billing_evidence
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

REVOKE ALL ON FUNCTION public.checkpoint_extraction_request_atomic(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_extraction_account_history(text, timestamptz, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_extraction_request_atomic(text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_extraction_account_history(text, timestamptz, text, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
