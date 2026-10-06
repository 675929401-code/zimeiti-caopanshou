-- DESIGN ONLY — DO NOT APPLY FROM THE NORMAL MIGRATION RUNNER.
-- PRODUCT-USAGE-EVENTS-R697 durable product analytics proposal.
-- This file has not been applied to local, staging, or production databases.
-- Applying it requires a reviewed database release, privacy notice activation,
-- retention scheduling and a verified rollback package.
--
-- Data boundary:
--   * the authenticated user id is assigned by the server;
--   * browser session and journey UUIDs are converted to keyed HMAC values;
--   * event, feature, page, milestone and entry point are strict allowlists;
--   * prompts, generated content, media/material URLs, e-mail addresses, raw
--     network addresses and user-agent strings have no columns in this model;
--   * policy_basis_code and notice_version come from reviewed deployment
--     configuration; collection must fail closed while either is absent;
--   * all published cohorts use k >= 5 and never return direct identifiers;
--   * operation_flight_events remains an operational recorder and is not used
--     by the product KPI function below.

BEGIN;

CREATE TABLE IF NOT EXISTS public.product_usage_events (
  id uuid PRIMARY KEY,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_hmac varchar(64) NOT NULL CHECK (session_hmac ~ '^[0-9a-f]{64}$'),
  event_type text NOT NULL CHECK (event_type IN (
    'page_view',
    'session_heartbeat',
    'feature_open',
    'workflow_started',
    'workflow_completed',
    'workflow_failed',
    'value_milestone'
  )),
  feature_key text NOT NULL CHECK (feature_key IN (
    'app_market',
    'agent_chat',
    'commercial_ip',
    'copywriting',
    'image_generation',
    'video_generation',
    'voice_generation',
    'storyboard',
    'cover_studio',
    'media_history',
    'commerce',
    'member_center',
    'help_center'
  )),
  page_key text CHECK (page_key IN (
    'home', 'tools', 'agent_chat', 'commercial_ip', 'copywriting', 'image',
    'video', 'voice', 'storyboard', 'cover', 'media_history', 'commerce',
    'member', 'help'
  )),
  journey_hmac varchar(64) CHECK (journey_hmac IS NULL OR journey_hmac ~ '^[0-9a-f]{64}$'),
  milestone_key text CHECK (milestone_key IN (
    'activation_completed',
    'first_workflow_completed',
    'first_project_saved',
    'first_asset_downloaded',
    'first_export_completed',
    'first_publish_completed'
  )),
  entry_point text CHECK (entry_point IN (
    'direct', 'navigation', 'deep_link', 'notification', 'history', 'retry'
  )),
  outcome_reason_code varchar(80) CHECK (
    outcome_reason_code IS NULL OR outcome_reason_code ~ '^[A-Za-z0-9._:-]{1,80}$'
  ),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  step_number integer CHECK (step_number IS NULL OR step_number BETWEEN 0 AND 1000),
  client_sequence integer CHECK (client_sequence IS NULL OR client_sequence >= 0),
  client_occurred_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  capture_source text NOT NULL CHECK (capture_source IN ('browser', 'server')),
  purpose_code text NOT NULL CHECK (purpose_code = 'product_improvement'),
  policy_basis_code varchar(80) NOT NULL CHECK (policy_basis_code ~ '^[A-Za-z0-9._:-]{3,80}$'),
  notice_version varchar(64) NOT NULL,
  source_version varchar(128),
  build_id varchar(128),
  retained_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (retained_until > occurred_at),
  CHECK (event_type <> 'page_view' OR page_key IS NOT NULL),
  CHECK (event_type NOT LIKE 'workflow_%' OR journey_hmac IS NOT NULL),
  CHECK (event_type <> 'value_milestone' OR milestone_key IS NOT NULL),
  CHECK (event_type = 'workflow_failed' OR outcome_reason_code IS NULL)
);

COMMENT ON TABLE public.product_usage_events IS
  'DESIGN-ONLY allowlisted product analytics facts. No generic metadata or content fields.';
COMMENT ON COLUMN public.product_usage_events.session_hmac IS
  'Server-side keyed correlation value. The browser UUID is never stored.';
COMMENT ON COLUMN public.product_usage_events.journey_hmac IS
  'Server-side keyed workflow correlation value. Never returned by aggregate APIs.';

CREATE INDEX IF NOT EXISTS product_usage_events_time_lookup
  ON public.product_usage_events(occurred_at DESC, user_id);
CREATE INDEX IF NOT EXISTS product_usage_events_feature_lookup
  ON public.product_usage_events(feature_key, occurred_at DESC, user_id);
CREATE INDEX IF NOT EXISTS product_usage_events_workflow_lookup
  ON public.product_usage_events(event_type, occurred_at DESC, user_id)
  WHERE event_type IN ('workflow_started', 'workflow_completed', 'workflow_failed', 'value_milestone');
CREATE INDEX IF NOT EXISTS product_usage_events_retention_cleanup
  ON public.product_usage_events(retained_until);

CREATE TABLE IF NOT EXISTS public.product_usage_daily_user_facts (
  event_date date NOT NULL,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  page_view_count integer NOT NULL DEFAULT 0 CHECK (page_view_count >= 0),
  feature_open_count integer NOT NULL DEFAULT 0 CHECK (feature_open_count >= 0),
  workflow_started_count integer NOT NULL DEFAULT 0 CHECK (workflow_started_count >= 0),
  workflow_completed_count integer NOT NULL DEFAULT 0 CHECK (workflow_completed_count >= 0),
  workflow_failed_count integer NOT NULL DEFAULT 0 CHECK (workflow_failed_count >= 0),
  value_milestone_count integer NOT NULL DEFAULT 0 CHECK (value_milestone_count >= 0),
  first_event_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_date, user_id, feature_key)
);

CREATE INDEX IF NOT EXISTS product_usage_daily_user_facts_active_lookup
  ON public.product_usage_daily_user_facts(event_date DESC, user_id);
CREATE INDEX IF NOT EXISTS product_usage_daily_user_facts_feature_lookup
  ON public.product_usage_daily_user_facts(feature_key, event_date DESC, user_id);

CREATE TABLE IF NOT EXISTS public.product_usage_user_lifecycle (
  user_id varchar(36) PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  first_feature_open_at timestamptz,
  first_workflow_started_at timestamptz,
  first_workflow_completed_at timestamptz,
  first_value_milestone_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_usage_user_lifecycle_first_seen
  ON public.product_usage_user_lifecycle(first_seen_at, user_id);

ALTER TABLE public.product_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_usage_daily_user_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_usage_user_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_usage_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.product_usage_daily_user_facts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.product_usage_user_lifecycle FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.product_usage_events TO service_role;
GRANT SELECT ON TABLE public.product_usage_daily_user_facts TO service_role;
GRANT SELECT ON TABLE public.product_usage_user_lifecycle TO service_role;

CREATE OR REPLACE FUNCTION public.update_product_usage_rollups_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.product_usage_daily_user_facts (
    event_date,
    user_id,
    feature_key,
    event_count,
    page_view_count,
    feature_open_count,
    workflow_started_count,
    workflow_completed_count,
    workflow_failed_count,
    value_milestone_count,
    first_event_at,
    last_event_at
  ) VALUES (
    NEW.occurred_at::date,
    NEW.user_id,
    NEW.feature_key,
    1,
    (NEW.event_type = 'page_view')::integer,
    (NEW.event_type = 'feature_open')::integer,
    (NEW.event_type = 'workflow_started')::integer,
    (NEW.event_type = 'workflow_completed')::integer,
    (NEW.event_type = 'workflow_failed')::integer,
    (NEW.event_type = 'value_milestone')::integer,
    NEW.occurred_at,
    NEW.occurred_at
  )
  ON CONFLICT (event_date, user_id, feature_key) DO UPDATE SET
    event_count = public.product_usage_daily_user_facts.event_count + 1,
    page_view_count = public.product_usage_daily_user_facts.page_view_count + (NEW.event_type = 'page_view')::integer,
    feature_open_count = public.product_usage_daily_user_facts.feature_open_count + (NEW.event_type = 'feature_open')::integer,
    workflow_started_count = public.product_usage_daily_user_facts.workflow_started_count + (NEW.event_type = 'workflow_started')::integer,
    workflow_completed_count = public.product_usage_daily_user_facts.workflow_completed_count + (NEW.event_type = 'workflow_completed')::integer,
    workflow_failed_count = public.product_usage_daily_user_facts.workflow_failed_count + (NEW.event_type = 'workflow_failed')::integer,
    value_milestone_count = public.product_usage_daily_user_facts.value_milestone_count + (NEW.event_type = 'value_milestone')::integer,
    first_event_at = least(public.product_usage_daily_user_facts.first_event_at, NEW.occurred_at),
    last_event_at = greatest(public.product_usage_daily_user_facts.last_event_at, NEW.occurred_at),
    updated_at = now();

  INSERT INTO public.product_usage_user_lifecycle (
    user_id,
    first_seen_at,
    last_seen_at,
    first_feature_open_at,
    first_workflow_started_at,
    first_workflow_completed_at,
    first_value_milestone_at
  ) VALUES (
    NEW.user_id,
    NEW.occurred_at,
    NEW.occurred_at,
    CASE WHEN NEW.event_type = 'feature_open' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type = 'workflow_started' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type = 'workflow_completed' THEN NEW.occurred_at END,
    CASE WHEN NEW.event_type = 'value_milestone' THEN NEW.occurred_at END
  )
  ON CONFLICT (user_id) DO UPDATE SET
    first_seen_at = least(public.product_usage_user_lifecycle.first_seen_at, NEW.occurred_at),
    last_seen_at = greatest(public.product_usage_user_lifecycle.last_seen_at, NEW.occurred_at),
    first_feature_open_at = coalesce(
      least(public.product_usage_user_lifecycle.first_feature_open_at, CASE WHEN NEW.event_type = 'feature_open' THEN NEW.occurred_at END),
      public.product_usage_user_lifecycle.first_feature_open_at,
      CASE WHEN NEW.event_type = 'feature_open' THEN NEW.occurred_at END
    ),
    first_workflow_started_at = coalesce(
      least(public.product_usage_user_lifecycle.first_workflow_started_at, CASE WHEN NEW.event_type = 'workflow_started' THEN NEW.occurred_at END),
      public.product_usage_user_lifecycle.first_workflow_started_at,
      CASE WHEN NEW.event_type = 'workflow_started' THEN NEW.occurred_at END
    ),
    first_workflow_completed_at = coalesce(
      least(public.product_usage_user_lifecycle.first_workflow_completed_at, CASE WHEN NEW.event_type = 'workflow_completed' THEN NEW.occurred_at END),
      public.product_usage_user_lifecycle.first_workflow_completed_at,
      CASE WHEN NEW.event_type = 'workflow_completed' THEN NEW.occurred_at END
    ),
    first_value_milestone_at = coalesce(
      least(public.product_usage_user_lifecycle.first_value_milestone_at, CASE WHEN NEW.event_type = 'value_milestone' THEN NEW.occurred_at END),
      public.product_usage_user_lifecycle.first_value_milestone_at,
      CASE WHEN NEW.event_type = 'value_milestone' THEN NEW.occurred_at END
    ),
    updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_usage_events_rollup_v1 ON public.product_usage_events;
CREATE TRIGGER product_usage_events_rollup_v1
AFTER INSERT ON public.product_usage_events
FOR EACH ROW EXECUTE FUNCTION public.update_product_usage_rollups_v1();

REVOKE ALL ON FUNCTION public.update_product_usage_rollups_v1() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.read_admin_product_usage_snapshot_v1(
  p_window_days integer DEFAULT 90,
  p_min_cohort_size integer DEFAULT 5,
  p_as_of timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH parameters AS (
    SELECT
      greatest(30, least(180, p_window_days))::integer AS window_days,
      greatest(5, p_min_cohort_size)::bigint AS minimum_cohort,
      p_as_of AS as_of
  ),
  bounded_facts AS (
    SELECT fact.*
    FROM public.product_usage_daily_user_facts fact
    CROSS JOIN parameters parameter
    WHERE fact.event_date BETWEEN (parameter.as_of::date - (parameter.window_days - 1)) AND parameter.as_of::date
  ),
  instrumentation AS (
    SELECT
      coalesce(sum(fact.event_count), 0)::bigint AS event_count,
      min(fact.first_event_at) AS started_at,
      max(fact.last_event_at) AS latest_record_at
    FROM bounded_facts fact
  ),
  active_counts AS (
    SELECT
      count(DISTINCT fact.user_id) FILTER (WHERE fact.event_date >= parameter.as_of::date)::bigint AS dau,
      count(DISTINCT fact.user_id) FILTER (WHERE fact.event_date >= parameter.as_of::date - 6)::bigint AS wau,
      count(DISTINCT fact.user_id) FILTER (WHERE fact.event_date >= parameter.as_of::date - 29)::bigint AS mau
    FROM bounded_facts fact
    CROSS JOIN parameters parameter
  ),
  activation_cohort AS (
    SELECT
      member.id AS user_id,
      member.created_at,
      lifecycle.first_workflow_completed_at,
      (
        lifecycle.first_workflow_completed_at IS NOT NULL
        AND lifecycle.first_workflow_completed_at <= member.created_at + interval '7 days'
      ) AS activated
    FROM public.users member
    CROSS JOIN parameters parameter
    LEFT JOIN public.product_usage_user_lifecycle lifecycle ON lifecycle.user_id = member.id
    WHERE member.role = 'student'
      AND member.created_at >= parameter.as_of - interval '37 days'
      AND member.created_at < parameter.as_of - interval '7 days'
  ),
  activation_summary AS (
    SELECT count(*)::bigint AS eligible, count(*) FILTER (WHERE activated)::bigint AS activated
    FROM activation_cohort
  ),
  retention_days(day_offset) AS (VALUES (1), (7), (30)),
  retention_summary AS (
    SELECT
      retention.day_offset,
      count(lifecycle.user_id) FILTER (
        WHERE lifecycle.first_seen_at::date <= parameter.as_of::date - retention.day_offset
      )::bigint AS eligible,
      count(lifecycle.user_id) FILTER (
        WHERE lifecycle.first_seen_at::date <= parameter.as_of::date - retention.day_offset
          AND EXISTS (
            SELECT 1
            FROM public.product_usage_daily_user_facts returned
            WHERE returned.user_id = lifecycle.user_id
              AND returned.event_date = lifecycle.first_seen_at::date + retention.day_offset
          )
      )::bigint AS retained
    FROM retention_days retention
    CROSS JOIN parameters parameter
    CROSS JOIN public.product_usage_user_lifecycle lifecycle
    GROUP BY retention.day_offset
  ),
  feature_catalog(feature_key) AS (
    VALUES
      ('app_market'::text), ('agent_chat'), ('commercial_ip'), ('copywriting'),
      ('image_generation'), ('video_generation'), ('voice_generation'), ('storyboard'),
      ('cover_studio'), ('media_history'), ('commerce'), ('member_center'), ('help_center')
  ),
  feature_summary AS (
    SELECT
      catalog.feature_key,
      count(DISTINCT fact.user_id) FILTER (
        WHERE fact.feature_open_count > 0
           OR fact.workflow_started_count > 0
           OR fact.workflow_completed_count > 0
           OR fact.workflow_failed_count > 0
           OR fact.value_milestone_count > 0
      )::bigint AS active_users,
      count(DISTINCT fact.user_id) FILTER (WHERE fact.workflow_completed_count > 0)::bigint AS completed_users
    FROM feature_catalog catalog
    LEFT JOIN bounded_facts fact ON fact.feature_key = catalog.feature_key
    CROSS JOIN parameters parameter
    WHERE fact.event_date IS NULL OR fact.event_date >= parameter.as_of::date - 29
    GROUP BY catalog.feature_key
  ),
  active_30 AS (
    SELECT DISTINCT fact.user_id
    FROM bounded_facts fact
    CROSS JOIN parameters parameter
    WHERE fact.event_date >= parameter.as_of::date - 29
  ),
  value_path AS (
    SELECT
      count(active.user_id)::bigint AS active_users,
      count(active.user_id) FILTER (WHERE lifecycle.first_feature_open_at IS NOT NULL)::bigint AS feature_open_users,
      count(active.user_id) FILTER (
        WHERE lifecycle.first_feature_open_at IS NOT NULL
          AND lifecycle.first_workflow_started_at >= lifecycle.first_feature_open_at
      )::bigint AS workflow_started_users,
      count(active.user_id) FILTER (
        WHERE lifecycle.first_feature_open_at IS NOT NULL
          AND lifecycle.first_workflow_started_at >= lifecycle.first_feature_open_at
          AND lifecycle.first_workflow_completed_at >= lifecycle.first_workflow_started_at
      )::bigint AS workflow_completed_users,
      count(active.user_id) FILTER (
        WHERE lifecycle.first_feature_open_at IS NOT NULL
          AND lifecycle.first_workflow_started_at >= lifecycle.first_feature_open_at
          AND lifecycle.first_workflow_completed_at >= lifecycle.first_workflow_started_at
          AND lifecycle.first_value_milestone_at >= lifecycle.first_workflow_completed_at
      )::bigint AS value_milestone_users
    FROM active_30 active
    LEFT JOIN public.product_usage_user_lifecycle lifecycle ON lifecycle.user_id = active.user_id
  )
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'asOf', parameter.as_of,
    'instrumentation', jsonb_build_object(
      'eventCount', instrumentation.event_count,
      'startedAt', instrumentation.started_at,
      'latestRecordAt', instrumentation.latest_record_at
    ),
    'metrics', jsonb_build_object(
      'dau', jsonb_build_object(
        'state', CASE WHEN active.dau BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END,
        'value', CASE WHEN active.dau BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE active.dau END,
        'privacySuppressed', active.dau BETWEEN 1 AND parameter.minimum_cohort - 1
      ),
      'wau', jsonb_build_object(
        'state', CASE WHEN active.wau BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END,
        'value', CASE WHEN active.wau BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE active.wau END,
        'privacySuppressed', active.wau BETWEEN 1 AND parameter.minimum_cohort - 1
      ),
      'mau', jsonb_build_object(
        'state', CASE WHEN active.mau BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END,
        'value', CASE WHEN active.mau BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE active.mau END,
        'privacySuppressed', active.mau BETWEEN 1 AND parameter.minimum_cohort - 1
      ),
      'activation', jsonb_build_object(
        'state', CASE WHEN activation.eligible BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END,
        'value', CASE WHEN activation.eligible < parameter.minimum_cohort THEN NULL ELSE activation.activated::numeric / nullif(activation.eligible, 0) END,
        'numerator', CASE WHEN activation.eligible < parameter.minimum_cohort THEN NULL ELSE activation.activated END,
        'denominator', CASE WHEN activation.eligible < parameter.minimum_cohort THEN NULL ELSE activation.eligible END,
        'privacySuppressed', activation.eligible BETWEEN 1 AND parameter.minimum_cohort - 1
      )
    ),
    'retention', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'day', summary.day_offset,
        'state', CASE WHEN summary.eligible BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END,
        'retainedUsers', CASE WHEN summary.eligible < parameter.minimum_cohort THEN NULL ELSE summary.retained END,
        'eligibleUsers', CASE WHEN summary.eligible < parameter.minimum_cohort THEN NULL ELSE summary.eligible END,
        'rate', CASE WHEN summary.eligible < parameter.minimum_cohort THEN NULL ELSE summary.retained::numeric / nullif(summary.eligible, 0) END,
        'privacySuppressed', summary.eligible BETWEEN 1 AND parameter.minimum_cohort - 1
      ) ORDER BY summary.day_offset), '[]'::jsonb)
      FROM retention_summary summary
    ),
    'featureAdoption', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'featureKey', feature.feature_key,
        'state', CASE WHEN feature.active_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END,
        'activeUsers', CASE WHEN feature.active_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE feature.active_users END,
        'monthlyActiveUsers', CASE WHEN active.mau BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE active.mau END,
        'adoptionRate', CASE WHEN feature.active_users BETWEEN 1 AND parameter.minimum_cohort - 1 OR active.mau < parameter.minimum_cohort THEN NULL ELSE feature.active_users::numeric / nullif(active.mau, 0) END,
        'workflowCompletedUsers', CASE WHEN feature.completed_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE feature.completed_users END,
        'privacySuppressed', feature.active_users BETWEEN 1 AND parameter.minimum_cohort - 1 OR active.mau BETWEEN 1 AND parameter.minimum_cohort - 1
      ) ORDER BY feature.active_users DESC, feature.feature_key), '[]'::jsonb)
      FROM feature_summary feature
    ),
    'valuePath', jsonb_build_array(
      jsonb_build_object('key', 'active', 'state', CASE WHEN path.active_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END, 'users', CASE WHEN path.active_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE path.active_users END, 'conversionFromPrevious', 1, 'privacySuppressed', path.active_users BETWEEN 1 AND parameter.minimum_cohort - 1),
      jsonb_build_object('key', 'feature_open', 'state', CASE WHEN path.feature_open_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END, 'users', CASE WHEN path.feature_open_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE path.feature_open_users END, 'conversionFromPrevious', CASE WHEN path.active_users < parameter.minimum_cohort THEN NULL ELSE path.feature_open_users::numeric / nullif(path.active_users, 0) END, 'privacySuppressed', path.feature_open_users BETWEEN 1 AND parameter.minimum_cohort - 1),
      jsonb_build_object('key', 'workflow_started', 'state', CASE WHEN path.workflow_started_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END, 'users', CASE WHEN path.workflow_started_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE path.workflow_started_users END, 'conversionFromPrevious', CASE WHEN path.feature_open_users < parameter.minimum_cohort THEN NULL ELSE path.workflow_started_users::numeric / nullif(path.feature_open_users, 0) END, 'privacySuppressed', path.workflow_started_users BETWEEN 1 AND parameter.minimum_cohort - 1),
      jsonb_build_object('key', 'workflow_completed', 'state', CASE WHEN path.workflow_completed_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END, 'users', CASE WHEN path.workflow_completed_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE path.workflow_completed_users END, 'conversionFromPrevious', CASE WHEN path.workflow_started_users < parameter.minimum_cohort THEN NULL ELSE path.workflow_completed_users::numeric / nullif(path.workflow_started_users, 0) END, 'privacySuppressed', path.workflow_completed_users BETWEEN 1 AND parameter.minimum_cohort - 1),
      jsonb_build_object('key', 'value_milestone', 'state', CASE WHEN path.value_milestone_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN 'partial' ELSE 'available' END, 'users', CASE WHEN path.value_milestone_users BETWEEN 1 AND parameter.minimum_cohort - 1 THEN NULL ELSE path.value_milestone_users END, 'conversionFromPrevious', CASE WHEN path.workflow_completed_users < parameter.minimum_cohort THEN NULL ELSE path.value_milestone_users::numeric / nullif(path.workflow_completed_users, 0) END, 'privacySuppressed', path.value_milestone_users BETWEEN 1 AND parameter.minimum_cohort - 1)
    )
  )
  FROM parameters parameter
  CROSS JOIN instrumentation
  CROSS JOIN active_counts active
  CROSS JOIN activation_summary activation
  CROSS JOIN value_path path;
$$;

REVOKE ALL ON FUNCTION public.read_admin_product_usage_snapshot_v1(integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_admin_product_usage_snapshot_v1(integer, integer, timestamptz) TO service_role;

-- A separately reviewed scheduler must delete rows where retained_until <= now().
-- It must never be activated by this design-only file.

COMMIT;
