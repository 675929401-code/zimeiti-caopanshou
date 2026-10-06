BEGIN;

CREATE TABLE IF NOT EXISTS public.extraction_history_hidden (
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  record_id text NOT NULL REFERENCES public.extraction_attempts(record_id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, record_id)
);
CREATE TABLE IF NOT EXISTS public.extraction_history_preferences (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  cleared_before timestamptz NOT NULL
);
ALTER TABLE public.extraction_history_hidden ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_history_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extraction_history_hidden, public.extraction_history_preferences FROM anon, authenticated;
GRANT ALL ON public.extraction_history_hidden, public.extraction_history_preferences TO service_role;

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

CREATE OR REPLACE FUNCTION public.hide_extraction_account_history(p_user_id text, p_record_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('extract-history:' || p_user_id, 0));
  IF p_record_id IS NULL THEN
    INSERT INTO public.extraction_history_preferences(user_id, cleared_before)
    VALUES (p_user_id, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE SET cleared_before = greatest(extraction_history_preferences.cleared_before, EXCLUDED.cleared_before);
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.extraction_attempts WHERE record_id = p_record_id AND user_id = p_user_id AND request_kind IN ('single','batch','search','coze')) THEN
      RAISE EXCEPTION 'EXTRACTION_HISTORY_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.extraction_history_hidden(user_id, record_id) VALUES (p_user_id, p_record_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.read_extraction_account_history(text,timestamptz,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hide_extraction_account_history(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_extraction_account_history(text,timestamptz,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.hide_extraction_account_history(text,text) TO service_role;
CREATE INDEX IF NOT EXISTS extraction_attempts_history_cursor_idx ON public.extraction_attempts(user_id, created_at DESC, record_id DESC) WHERE request_kind IN ('single','batch','search','coze');
NOTIFY pgrst, 'reload schema';
COMMIT;
