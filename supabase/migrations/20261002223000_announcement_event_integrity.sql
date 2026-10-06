BEGIN;
SET LOCAL lock_timeout = '10s';

-- This ledger closes the account-scoped announcement interaction path. It is
-- deliberately separate from platform_settings and from the foundation-only
-- unified messaging schema: no legacy or unified-message data is imported.
CREATE TABLE IF NOT EXISTS public.announcement_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id character varying(36) NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  user_id character varying(36) NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('impression', 'read', 'click', 'close', 'remind_later')
  ),
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 160),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT announcement_delivery_events_semantic_unique
    UNIQUE (announcement_id, revision, user_id, event_type),
  CONSTRAINT announcement_delivery_events_user_key_unique
    UNIQUE (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS announcement_delivery_events_announcement_idx
  ON public.announcement_delivery_events (announcement_id, revision, occurred_at DESC);
CREATE INDEX IF NOT EXISTS announcement_delivery_events_user_idx
  ON public.announcement_delivery_events (user_id, occurred_at DESC);

ALTER TABLE public.announcement_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.announcement_delivery_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.announcement_delivery_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_announcement_delivery_event(
  p_announcement_id text,
  p_user_id text,
  p_revision integer,
  p_event_type text,
  p_event_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_announcement public.announcements%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_expected_event_key text;
  v_event public.announcement_delivery_events%ROWTYPE;
  v_inserted boolean := false;
BEGIN
  IF nullif(btrim(p_announcement_id), '') IS NULL
     OR char_length(p_announcement_id) > 36
     OR nullif(btrim(p_user_id), '') IS NULL
     OR p_revision IS NULL OR p_revision < 1
     OR p_event_type NOT IN ('impression', 'read', 'click', 'close', 'remind_later')
     OR nullif(btrim(p_event_key), '') IS NULL
     OR char_length(p_event_key) > 160 THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_EVENT_INPUT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  v_expected_event_key := format(
    'announcement:%s:r%s:%s:v1',
    btrim(p_announcement_id),
    p_revision,
    p_event_type
  );
  IF p_event_key <> v_expected_event_key THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_EVENT_KEY_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_user
  FROM public.users
  WHERE id = p_user_id
    AND is_active IS TRUE
    AND coalesce(status, 'active') = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_ACCOUNT_NOT_ACTIVE' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_announcement
  FROM public.announcements
  WHERE id = p_announcement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_announcement.push_revision <> p_revision THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_REVISION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_announcement.is_active IS NOT TRUE
     OR v_announcement.status NOT IN ('published', 'scheduled')
     OR (v_announcement.publish_at IS NOT NULL AND v_announcement.publish_at > clock_timestamp())
     OR (v_announcement.expires_at IS NOT NULL AND v_announcement.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_NOT_VISIBLE' USING ERRCODE = 'P0001';
  END IF;
  IF (CASE v_announcement.target_audience
       WHEN 'all' THEN false
       WHEN 'authenticated' THEN false
       WHEN 'admins' THEN v_user.role <> 'admin'
       WHEN 'selected' THEN NOT (v_announcement.target_user_ids ? v_user.id::text)
       ELSE true
     END) THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_NOT_TARGETED' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.announcement_push_runs
    WHERE announcement_id = v_announcement.id
      AND revision = p_revision
  ) THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_PUSH_RUN_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_event_type = 'read' AND NOT EXISTS (
    SELECT 1
    FROM public.announcement_user_reads
    WHERE announcement_id = v_announcement.id
      AND revision = p_revision
      AND user_id = v_user.id
  ) THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_READ_RECEIPT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.announcement_delivery_events (
    announcement_id,
    revision,
    user_id,
    event_type,
    event_key,
    occurred_at
  ) VALUES (
    v_announcement.id,
    p_revision,
    v_user.id,
    p_event_type,
    p_event_key,
    clock_timestamp()
  )
  ON CONFLICT (announcement_id, revision, user_id, event_type) DO NOTHING
  RETURNING * INTO v_event;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT * INTO v_event
    FROM public.announcement_delivery_events
    WHERE announcement_id = v_announcement.id
      AND revision = p_revision
      AND user_id = v_user.id
      AND event_type = p_event_type;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'recorded', v_inserted,
    'alreadyRecorded', NOT v_inserted,
    'eventId', v_event.id,
    'announcementId', v_event.announcement_id,
    'revision', v_event.revision,
    'event', v_event.event_type,
    'eventKey', v_event.event_key,
    'occurredAt', v_event.occurred_at,
    'semantics', 'unique_account_per_revision_event_v1'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_announcement_event_totals(
  p_announcement_id text,
  p_revision integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_announcement public.announcements%ROWTYPE;
  v_revision integer;
  v_impression integer := 0;
  v_read integer := 0;
  v_click integer := 0;
  v_close integer := 0;
  v_remind_later integer := 0;
  v_last_event_at timestamptz;
BEGIN
  SELECT * INTO v_announcement
  FROM public.announcements
  WHERE id = p_announcement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_revision := coalesce(p_revision, v_announcement.push_revision);
  IF v_revision < 1 OR NOT EXISTS (
    SELECT 1 FROM public.announcement_push_runs
    WHERE announcement_id = v_announcement.id AND revision = v_revision
  ) THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_PUSH_RUN_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    count(*) FILTER (WHERE event_type = 'impression')::integer,
    count(*) FILTER (WHERE event_type = 'read')::integer,
    count(*) FILTER (WHERE event_type = 'click')::integer,
    count(*) FILTER (WHERE event_type = 'close')::integer,
    count(*) FILTER (WHERE event_type = 'remind_later')::integer,
    max(occurred_at)
  INTO v_impression, v_read, v_click, v_close, v_remind_later, v_last_event_at
  FROM public.announcement_delivery_events
  WHERE announcement_id = v_announcement.id
    AND revision = v_revision;

  RETURN jsonb_build_object(
    'announcementId', v_announcement.id,
    'revision', v_revision,
    'counts', jsonb_build_object(
      'impression', coalesce(v_impression, 0),
      'read', coalesce(v_read, 0),
      'click', coalesce(v_click, 0),
      'close', coalesce(v_close, 0),
      'remind_later', coalesce(v_remind_later, 0)
    ),
    'lastEventAt', v_last_event_at,
    'source', 'announcement_delivery_events',
    'semantics', 'unique_account_per_revision_event_v1',
    'legacyAnalyticsMerged', false,
    'unifiedMessagingBridge', 'foundation_only_not_connected'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_announcement_delivery_event(text, text, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_announcement_event_totals(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_announcement_delivery_event(text, text, integer, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_announcement_event_totals(text, integer)
  TO service_role;

COMMENT ON TABLE public.announcement_delivery_events IS
  'Append-only, account-scoped announcement interactions. One row per account, announcement revision, and event type.';
COMMENT ON FUNCTION public.record_announcement_delivery_event(text, text, integer, text, text) IS
  'Validates current account eligibility and records one idempotent event per announcement revision and event type.';
COMMENT ON FUNCTION public.get_announcement_event_totals(text, integer) IS
  'Compatibility aggregate from the event ledger only; legacy JSON is not merged and unified messaging remains unbridged.';

NOTIFY pgrst, 'reload schema';
COMMIT;
