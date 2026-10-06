BEGIN;
SET LOCAL lock_timeout = '10s';

-- Announcement content remains in the existing table. Delivery policy and the
-- account-scoped revision are first-class columns so runtime code never has to
-- treat an anonymous platform_settings JSON blob as durable delivery state.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS publish_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS target_audience text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS target_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS frequency_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS max_impressions integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS require_ack boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS push_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_pushed_at timestamptz;

-- One-time compatibility import for delivery metadata written by the previous
-- route. Invalid legacy values are ignored and receive the safe column defaults.
DO $announcement_legacy_import$
DECLARE
  v_delivery jsonb := '{}'::jsonb;
BEGIN
  BEGIN
    SELECT CASE
      WHEN jsonb_typeof(setting_value::jsonb) = 'object' THEN setting_value::jsonb
      ELSE '{}'::jsonb
    END
    INTO v_delivery
    FROM public.platform_settings
    WHERE setting_key = 'announcement_delivery_v2'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_delivery := '{}'::jsonb;
  END;

  v_delivery := coalesce(v_delivery, '{}'::jsonb);
  UPDATE public.announcements AS announcement
  SET
    priority = CASE
      WHEN v_delivery -> announcement.id ->> 'priority' IN ('normal', 'important', 'urgent')
        THEN v_delivery -> announcement.id ->> 'priority'
      WHEN announcement.is_pinned THEN 'important'
      ELSE 'normal'
    END,
    status = CASE
      WHEN v_delivery -> announcement.id ->> 'status' IN ('draft', 'scheduled', 'published', 'withdrawn')
        THEN v_delivery -> announcement.id ->> 'status'
      WHEN announcement.is_active THEN 'published'
      ELSE 'withdrawn'
    END,
    summary = left(coalesce(v_delivery -> announcement.id ->> 'summary', ''), 300),
    publish_at = CASE
      WHEN coalesce(v_delivery -> announcement.id ->> 'publish_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
        THEN (v_delivery -> announcement.id ->> 'publish_at')::timestamptz
      ELSE NULL
    END,
    expires_at = CASE
      WHEN coalesce(v_delivery -> announcement.id ->> 'expires_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
        THEN (v_delivery -> announcement.id ->> 'expires_at')::timestamptz
      ELSE NULL
    END,
    target_audience = CASE
      WHEN v_delivery -> announcement.id ->> 'target_audience' IN ('all', 'guests', 'authenticated', 'admins', 'selected')
        THEN v_delivery -> announcement.id ->> 'target_audience'
      ELSE 'all'
    END,
    target_user_ids = CASE
      WHEN jsonb_typeof(v_delivery -> announcement.id -> 'target_user_ids') = 'array'
        THEN v_delivery -> announcement.id -> 'target_user_ids'
      ELSE '[]'::jsonb
    END,
    frequency_hours = CASE
      WHEN coalesce(v_delivery -> announcement.id ->> 'frequency_hours', '') ~ '^\\d+$'
        THEN greatest(1, least(720, (v_delivery -> announcement.id ->> 'frequency_hours')::integer))
      ELSE 24
    END,
    max_impressions = CASE
      WHEN coalesce(v_delivery -> announcement.id ->> 'max_impressions', '') ~ '^\\d+$'
        THEN greatest(0, least(100, (v_delivery -> announcement.id ->> 'max_impressions')::integer))
      ELSE 3
    END,
    require_ack = CASE
      WHEN lower(coalesce(v_delivery -> announcement.id ->> 'require_ack', 'false')) IN ('true', 'false')
        THEN coalesce(v_delivery -> announcement.id ->> 'require_ack', 'false')::boolean
      ELSE false
    END;
END;
$announcement_legacy_import$;

-- Existing published/scheduled announcements start at revision 1. Drafts and
-- withdrawn records remain revision 0 until their first publication.
UPDATE public.announcements
SET
  push_revision = 1,
  first_published_at = coalesce(first_published_at, publish_at, created_at, now()),
  last_pushed_at = coalesce(last_pushed_at, publish_at, created_at, now())
WHERE push_revision = 0
  AND is_active IS TRUE
  AND status IN ('published', 'scheduled');

DO $announcement_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_priority_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_priority_check
      CHECK (priority IN ('normal', 'important', 'urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_status_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_status_check
      CHECK (status IN ('draft', 'scheduled', 'published', 'withdrawn'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_target_audience_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_target_audience_check
      CHECK (target_audience IN ('all', 'guests', 'authenticated', 'admins', 'selected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_target_user_ids_array_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_target_user_ids_array_check
      CHECK (jsonb_typeof(target_user_ids) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_frequency_hours_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_frequency_hours_check
      CHECK (frequency_hours BETWEEN 1 AND 720);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_max_impressions_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_max_impressions_check
      CHECK (max_impressions BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_push_revision_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_push_revision_check
      CHECK (push_revision >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_delivery_window_check') THEN
    ALTER TABLE public.announcements ADD CONSTRAINT announcements_delivery_window_check
      CHECK (publish_at IS NULL OR expires_at IS NULL OR expires_at > publish_at);
  END IF;
END;
$announcement_constraints$;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.announcements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcements TO service_role;

CREATE TABLE IF NOT EXISTS public.announcement_push_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id character varying(36) NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  push_kind text NOT NULL CHECK (push_kind IN ('initial', 'repush')),
  pushed_by character varying(36) REFERENCES public.users(id) ON DELETE SET NULL,
  reason text,
  target_audience text NOT NULL CHECK (target_audience IN ('all', 'guests', 'authenticated', 'admins', 'selected')),
  target_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(target_user_ids) = 'array'),
  target_count integer NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  pushed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_push_runs_revision_unique UNIQUE (announcement_id, revision)
);

CREATE INDEX IF NOT EXISTS announcement_push_runs_announcement_idx
  ON public.announcement_push_runs (announcement_id, revision DESC);

CREATE TABLE IF NOT EXISTS public.announcement_user_reads (
  announcement_id character varying(36) NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  user_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, revision, user_id)
);

CREATE INDEX IF NOT EXISTS announcement_user_reads_user_idx
  ON public.announcement_user_reads (user_id, read_at DESC);
CREATE INDEX IF NOT EXISTS announcement_user_reads_delivery_idx
  ON public.announcement_user_reads (announcement_id, revision, read_at DESC);

ALTER TABLE public.announcement_push_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_user_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.announcement_push_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.announcement_user_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.announcement_push_runs TO service_role;
GRANT SELECT, INSERT ON TABLE public.announcement_user_reads TO service_role;

CREATE OR REPLACE FUNCTION public.count_announcement_account_targets(
  p_target_audience text,
  p_target_user_ids jsonb
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
  FROM public.users AS account
  WHERE account.is_active IS TRUE
    AND coalesce(account.status, 'active') = 'active'
    AND CASE p_target_audience
      WHEN 'all' THEN true
      WHEN 'authenticated' THEN true
      WHEN 'admins' THEN account.role = 'admin'
      WHEN 'selected' THEN coalesce(p_target_user_ids, '[]'::jsonb) ? account.id::text
      ELSE false
    END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_announcement_first_push()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.is_active IS TRUE
     AND NEW.status IN ('published', 'scheduled')
     AND coalesce(NEW.push_revision, 0) = 0 THEN
    NEW.push_revision := 1;
    NEW.first_published_at := coalesce(NEW.first_published_at, NEW.publish_at, clock_timestamp());
    NEW.last_pushed_at := coalesce(NEW.last_pushed_at, NEW.first_published_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_announcement_initial_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.push_revision <> 1 THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.push_revision <> 1 OR coalesce(OLD.push_revision, 0) <> 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.push_revision = 1 THEN
    INSERT INTO public.announcement_push_runs (
      announcement_id, revision, push_kind, pushed_by, reason,
      target_audience, target_user_ids, target_count, pushed_at
    ) VALUES (
      NEW.id, 1, 'initial', NULL, 'first_publish',
      NEW.target_audience, NEW.target_user_ids,
      public.count_announcement_account_targets(NEW.target_audience, NEW.target_user_ids),
      coalesce(NEW.last_pushed_at, clock_timestamp())
    )
    ON CONFLICT (announcement_id, revision) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS announcements_initialize_first_push ON public.announcements;
CREATE TRIGGER announcements_initialize_first_push
BEFORE INSERT OR UPDATE OF is_active, status, push_revision ON public.announcements
FOR EACH ROW EXECUTE FUNCTION public.initialize_announcement_first_push();

DROP TRIGGER IF EXISTS announcements_record_initial_push ON public.announcements;
CREATE TRIGGER announcements_record_initial_push
AFTER INSERT OR UPDATE OF is_active, status, push_revision ON public.announcements
FOR EACH ROW EXECUTE FUNCTION public.record_announcement_initial_push();

INSERT INTO public.announcement_push_runs (
  announcement_id, revision, push_kind, pushed_by, reason,
  target_audience, target_user_ids, target_count, pushed_at
)
SELECT
  announcement.id, announcement.push_revision, 'initial', NULL, 'migration_backfill',
  announcement.target_audience, announcement.target_user_ids,
  public.count_announcement_account_targets(announcement.target_audience, announcement.target_user_ids),
  coalesce(announcement.last_pushed_at, announcement.created_at, now())
FROM public.announcements AS announcement
WHERE announcement.push_revision = 1
ON CONFLICT (announcement_id, revision) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mark_announcement_read(
  p_announcement_id text,
  p_user_id text,
  p_revision integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_announcement public.announcements%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_read_at timestamptz;
  v_inserted boolean := false;
BEGIN
  IF nullif(btrim(p_announcement_id), '') IS NULL
     OR nullif(btrim(p_user_id), '') IS NULL
     OR p_revision IS NULL OR p_revision < 1 THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_READ_INPUT_INVALID' USING ERRCODE = 'P0001';
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

  INSERT INTO public.announcement_user_reads (announcement_id, revision, user_id, read_at)
  VALUES (v_announcement.id, p_revision, v_user.id, clock_timestamp())
  ON CONFLICT (announcement_id, revision, user_id) DO NOTHING
  RETURNING read_at INTO v_read_at;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT read_at INTO v_read_at
    FROM public.announcement_user_reads
    WHERE announcement_id = v_announcement.id
      AND revision = p_revision
      AND user_id = v_user.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'announcementId', v_announcement.id,
    'revision', p_revision,
    'readAt', v_read_at,
    'alreadyRead', NOT v_inserted,
    'status', 'read'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.repush_announcement_atomic(
  p_announcement_id text,
  p_actor_id text,
  p_expected_revision integer,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_announcement public.announcements%ROWTYPE;
  v_previous integer;
  v_next integer;
  v_now timestamptz := clock_timestamp();
  v_run_id uuid;
  v_target_count integer;
BEGIN
  IF nullif(btrim(p_announcement_id), '') IS NULL
     OR nullif(btrim(p_actor_id), '') IS NULL
     OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_PUSH_INPUT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_actor_id AND role = 'admin'
      AND is_active IS TRUE AND coalesce(status, 'active') = 'active'
  ) THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_ADMIN_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_announcement
  FROM public.announcements
  WHERE id = p_announcement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_announcement.is_active IS NOT TRUE
     OR v_announcement.status NOT IN ('published', 'scheduled')
     OR (v_announcement.publish_at IS NOT NULL AND v_announcement.publish_at > v_now)
     OR (v_announcement.expires_at IS NOT NULL AND v_announcement.expires_at <= v_now) THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_NOT_PUSHABLE' USING ERRCODE = 'P0001';
  END IF;

  v_previous := v_announcement.push_revision;
  IF v_previous <> p_expected_revision THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_REVISION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  v_next := v_previous + 1;
  v_target_count := public.count_announcement_account_targets(
    v_announcement.target_audience,
    v_announcement.target_user_ids
  );

  UPDATE public.announcements
  SET push_revision = v_next, last_pushed_at = v_now
  WHERE id = v_announcement.id;

  INSERT INTO public.announcement_push_runs (
    announcement_id, revision, push_kind, pushed_by, reason,
    target_audience, target_user_ids, target_count, pushed_at
  ) VALUES (
    v_announcement.id, v_next, 'repush', p_actor_id,
    left(nullif(btrim(p_reason), ''), 500),
    v_announcement.target_audience, v_announcement.target_user_ids,
    v_target_count, v_now
  )
  RETURNING id INTO v_run_id;

  RETURN jsonb_build_object(
    'success', true,
    'announcementId', v_announcement.id,
    'previousRevision', v_previous,
    'revision', v_next,
    'pushedAt', v_now,
    'runId', v_run_id,
    'targetCount', v_target_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_announcement_delivery_status(
  p_announcement_id text,
  p_revision integer DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20,
  p_read_state text DEFAULT 'all'
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_announcement public.announcements%ROWTYPE;
  v_run public.announcement_push_runs%ROWTYPE;
  v_revision integer;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 20), 100));
  v_read_state text := coalesce(p_read_state, 'all');
  v_target_count integer := 0;
  v_read_count integer := 0;
  v_filtered_count integer := 0;
  v_recipients jsonb := '[]'::jsonb;
  v_target_audience text;
  v_target_user_ids jsonb;
BEGIN
  IF v_read_state NOT IN ('all', 'read', 'unread') THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_DELIVERY_FILTER_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_announcement
  FROM public.announcements
  WHERE id = p_announcement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_revision := coalesce(p_revision, v_announcement.push_revision);
  SELECT * INTO v_run
  FROM public.announcement_push_runs
  WHERE announcement_id = v_announcement.id AND revision = v_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNOUNCEMENT_PUSH_RUN_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  -- Normal edits do not create a new revision. For the current revision the
  -- live audience therefore follows the edited announcement; historical
  -- revision reports retain the immutable push-run audience snapshot.
  IF v_revision = v_announcement.push_revision THEN
    v_target_audience := v_announcement.target_audience;
    v_target_user_ids := v_announcement.target_user_ids;
  ELSE
    v_target_audience := v_run.target_audience;
    v_target_user_ids := v_run.target_user_ids;
  END IF;

  WITH target_accounts AS (
    SELECT account.id, account.username, account.display_name, account.role
    FROM public.users AS account
    WHERE account.is_active IS TRUE
      AND coalesce(account.status, 'active') = 'active'
      AND CASE v_target_audience
        WHEN 'all' THEN true
        WHEN 'authenticated' THEN true
        WHEN 'admins' THEN account.role = 'admin'
        WHEN 'selected' THEN v_target_user_ids ? account.id::text
        ELSE false
      END
  ), delivery AS (
    SELECT target_accounts.*, receipt.read_at
    FROM target_accounts
    LEFT JOIN public.announcement_user_reads AS receipt
      ON receipt.announcement_id = v_announcement.id
     AND receipt.revision = v_revision
     AND receipt.user_id = target_accounts.id
  )
  SELECT count(*)::integer, count(read_at)::integer
  INTO v_target_count, v_read_count
  FROM delivery;

  WITH target_accounts AS (
    SELECT account.id, account.username, account.display_name, account.role
    FROM public.users AS account
    WHERE account.is_active IS TRUE
      AND coalesce(account.status, 'active') = 'active'
      AND CASE v_target_audience
        WHEN 'all' THEN true
        WHEN 'authenticated' THEN true
        WHEN 'admins' THEN account.role = 'admin'
        WHEN 'selected' THEN v_target_user_ids ? account.id::text
        ELSE false
      END
  ), delivery AS (
    SELECT target_accounts.*, receipt.read_at
    FROM target_accounts
    LEFT JOIN public.announcement_user_reads AS receipt
      ON receipt.announcement_id = v_announcement.id
     AND receipt.revision = v_revision
     AND receipt.user_id = target_accounts.id
  ), filtered AS (
    SELECT * FROM delivery
    WHERE v_read_state = 'all'
       OR (v_read_state = 'read' AND read_at IS NOT NULL)
       OR (v_read_state = 'unread' AND read_at IS NULL)
  )
  SELECT count(*)::integer INTO v_filtered_count FROM filtered;

  WITH target_accounts AS (
    SELECT account.id, account.username, account.display_name, account.role
    FROM public.users AS account
    WHERE account.is_active IS TRUE
      AND coalesce(account.status, 'active') = 'active'
      AND CASE v_target_audience
        WHEN 'all' THEN true
        WHEN 'authenticated' THEN true
        WHEN 'admins' THEN account.role = 'admin'
        WHEN 'selected' THEN v_target_user_ids ? account.id::text
        ELSE false
      END
  ), delivery AS (
    SELECT target_accounts.*, receipt.read_at
    FROM target_accounts
    LEFT JOIN public.announcement_user_reads AS receipt
      ON receipt.announcement_id = v_announcement.id
     AND receipt.revision = v_revision
     AND receipt.user_id = target_accounts.id
  ), page_rows AS (
    SELECT * FROM delivery
    WHERE v_read_state = 'all'
       OR (v_read_state = 'read' AND read_at IS NOT NULL)
       OR (v_read_state = 'unread' AND read_at IS NULL)
    ORDER BY (read_at IS NULL) DESC, read_at DESC NULLS LAST, id
    OFFSET (v_page - 1) * v_page_size
    LIMIT v_page_size
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'userId', id,
    'username', username,
    'displayName', display_name,
    'role', role,
    'status', CASE WHEN read_at IS NULL THEN 'unread' ELSE 'read' END,
    'readAt', read_at
  )), '[]'::jsonb)
  INTO v_recipients
  FROM page_rows;

  RETURN jsonb_build_object(
    'announcementId', v_announcement.id,
    'revision', v_revision,
    'pushRun', jsonb_build_object(
      'id', v_run.id,
      'kind', v_run.push_kind,
      'pushedBy', v_run.pushed_by,
      'reason', v_run.reason,
      'pushedAt', v_run.pushed_at,
      'snapshotTargetCount', v_run.target_count
    ),
    'summary', jsonb_build_object(
      'targetCount', v_target_count,
      'readCount', v_read_count,
      'unreadCount', greatest(v_target_count - v_read_count, 0),
      'readRate', CASE WHEN v_target_count = 0 THEN 0
        ELSE round(v_read_count::numeric / v_target_count, 4) END
    ),
    'pagination', jsonb_build_object(
      'page', v_page,
      'pageSize', v_page_size,
      'total', v_filtered_count,
      'totalPages', CASE WHEN v_filtered_count = 0 THEN 0
        ELSE ceil(v_filtered_count::numeric / v_page_size)::integer END
    ),
    'recipients', v_recipients
  );
END;
$$;

REVOKE ALL ON FUNCTION public.count_announcement_account_targets(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_announcement_read(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.repush_announcement_atomic(text, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_announcement_delivery_status(text, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_announcement_account_targets(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_announcement_read(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.repush_announcement_atomic(text, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_announcement_delivery_status(text, integer, integer, integer, text) TO service_role;

COMMENT ON COLUMN public.announcements.push_revision IS
  'Account delivery revision. First publication is revision 1; only explicit repush increments it.';
COMMENT ON TABLE public.announcement_user_reads IS
  'Immutable per-account read receipts keyed by announcement and push revision.';
COMMENT ON TABLE public.announcement_push_runs IS
  'Audit record for initial publication and every explicit administrator repush.';

NOTIFY pgrst, 'reload schema';
COMMIT;
