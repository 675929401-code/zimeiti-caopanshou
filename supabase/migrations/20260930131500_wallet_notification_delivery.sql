BEGIN;
SET LOCAL lock_timeout = '10s';

-- A stable business dedupe key ties one wallet receipt to one user-visible
-- notification. Retries can safely heal a notification failure after the
-- wallet transaction committed without generating duplicate gifts.
CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_dedupe_key_unique
  ON public.user_notifications (user_id, (metadata ->> 'dedupe_key'))
  WHERE nullif(btrim(metadata ->> 'dedupe_key'), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enqueue_user_notification_once(
  p_user_id text,
  p_type text,
  p_title text,
  p_content text,
  p_cami_code text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_metadata jsonb;
  v_dedupe_key text;
  v_notification public.user_notifications%ROWTYPE;
BEGIN
  BEGIN
    v_user_id := p_user_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOTIFICATION_USER_ID_INVALID');
  END;

  IF jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOTIFICATION_METADATA_INVALID');
  END IF;
  v_metadata := coalesce(p_metadata, '{}'::jsonb);
  v_dedupe_key := nullif(btrim(v_metadata ->> 'dedupe_key'), '');
  IF v_dedupe_key IS NULL OR length(v_dedupe_key) > 240 THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOTIFICATION_DEDUPE_KEY_INVALID');
  END IF;
  IF nullif(btrim(p_title), '') IS NULL OR length(p_title) > 240 THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOTIFICATION_TITLE_INVALID');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOTIFICATION_USER_NOT_FOUND');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || v_dedupe_key, 9302026));
  SELECT * INTO v_notification
  FROM public.user_notifications
  WHERE user_id = v_user_id
    AND metadata ->> 'dedupe_key' = v_dedupe_key
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'notification_id', v_notification.id,
      'created_at', v_notification.created_at,
      'already_existed', true
    );
  END IF;

  INSERT INTO public.user_notifications (
    user_id, type, title, content, cami_code, metadata, is_read
  ) VALUES (
    v_user_id,
    left(coalesce(nullif(btrim(p_type), ''), 'system'), 80),
    left(btrim(p_title), 240),
    coalesce(p_content, ''),
    nullif(btrim(p_cami_code), ''),
    v_metadata,
    false
  ) RETURNING * INTO v_notification;

  RETURN jsonb_build_object(
    'success', true,
    'notification_id', v_notification.id,
    'created_at', v_notification.created_at,
    'already_existed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_user_notification_once(
  text, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_user_notification_once(
  text, text, text, text, text, jsonb
) TO service_role;

COMMENT ON FUNCTION public.enqueue_user_notification_once(
  text, text, text, text, text, jsonb
) IS 'Server-only exactly-once account notification enqueue keyed by metadata.dedupe_key.';

NOTIFY pgrst, 'reload schema';
COMMIT;
