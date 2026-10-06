BEGIN;
SET LOCAL lock_timeout = '10s';

-- Stage 1 of the unified messaging control plane. This migration deliberately
-- creates no bridge, trigger, or backfill for announcements, user_notifications,
-- popup_pushes, or platform_settings.*_notifications. Existing producers and
-- consumers remain untouched until a separately reviewed integration migration.

CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  category text NOT NULL DEFAULT 'system' CHECK (category IN ('system', 'account_asset', 'security', 'project', 'operations')),
  locale text NOT NULL DEFAULT 'zh-CN' CHECK (length(locale) BETWEEN 2 AND 20),
  title_template text NOT NULL CHECK (length(title_template) BETWEEN 1 AND 240),
  body_template text NOT NULL CHECK (length(body_template) BETWEEN 1 AND 20000),
  variable_schema jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(variable_schema) = 'object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (template_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS message_templates_one_active_version_idx
  ON public.message_templates (template_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.message_surface_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  category text NOT NULL DEFAULT 'system' CHECK (category IN ('system', 'account_asset', 'security', 'project', 'operations')),
  priority text NOT NULL DEFAULT 'P3' CHECK (priority IN ('P0', 'P1', 'P2', 'P3', 'P4')),
  surfaces text[] NOT NULL DEFAULT ARRAY['inbox']::text[] CHECK (
    cardinality(surfaces) BETWEEN 1 AND 4
    AND surfaces <@ ARRAY['modal', 'toast', 'banner', 'inbox']::text[]
  ),
  primary_surface text NOT NULL DEFAULT 'inbox' CHECK (
    primary_surface IN ('modal', 'toast', 'banner', 'inbox')
    AND primary_surface = ANY (surfaces)
  ),
  require_ack boolean NOT NULL DEFAULT false,
  frequency_hours integer CHECK (frequency_hours IS NULL OR frequency_hours BETWEEN 1 AND 8760),
  max_impressions integer CHECK (max_impressions IS NULL OR max_impressions BETWEEN 1 AND 1000),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules) = 'object'),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (policy_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS message_surface_policies_one_active_version_idx
  ON public.message_surface_policies (policy_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.message_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key text NOT NULL UNIQUE CHECK (campaign_key ~ '^[a-z0-9][a-z0-9._:-]{0,159}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled')),
  category text NOT NULL DEFAULT 'system' CHECK (category IN ('system', 'account_asset', 'security', 'project', 'operations')),
  priority text NOT NULL DEFAULT 'P3' CHECK (priority IN ('P0', 'P1', 'P2', 'P3', 'P4')),
  template_id uuid REFERENCES public.message_templates(id) ON DELETE RESTRICT,
  surface_policy_id uuid REFERENCES public.message_surface_policies(id) ON DELETE RESTRICT,
  project_key text CHECK (project_key IS NULL OR length(project_key) BETWEEN 1 AND 160),
  tenant_key text CHECK (tenant_key IS NULL OR length(tenant_key) BETWEEN 1 AND 160),
  site_key text CHECK (site_key IS NULL OR length(site_key) BETWEEN 1 AND 160),
  audience_rule jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audience_rule) = 'object'),
  schedule_at timestamptz,
  expires_at timestamptz,
  idempotency_key text UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 240),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at IS NULL OR schedule_at IS NULL OR expires_at > schedule_at)
);

CREATE TABLE IF NOT EXISTS public.message_campaign_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.message_campaigns(id) ON DELETE RESTRICT,
  run_key text NOT NULL CHECK (length(run_key) BETWEEN 1 AND 180),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  template_snapshot jsonb NOT NULL CHECK (jsonb_typeof(template_snapshot) = 'object'),
  audience_snapshot jsonb NOT NULL CHECK (jsonb_typeof(audience_snapshot) = 'object'),
  surface_policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(surface_policy_snapshot) = 'object'),
  target_count integer NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  queued_count integer NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  terminal_count integer NOT NULL DEFAULT 0 CHECK (terminal_count >= 0),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, run_key),
  UNIQUE (campaign_id, revision),
  CHECK (queued_count <= target_count),
  CHECK (terminal_count <= target_count)
);

CREATE TABLE IF NOT EXISTS public.message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.message_campaign_runs(id) ON DELETE RESTRICT,
  recipient_type text NOT NULL CHECK (recipient_type IN ('user', 'tenant', 'site', 'segment')),
  recipient_key text NOT NULL CHECK (length(recipient_key) BETWEEN 1 AND 240),
  channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'webhook', 'sms', 'push')),
  surface text NOT NULL DEFAULT 'inbox' CHECK (surface IN ('modal', 'toast', 'banner', 'inbox', 'external')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'fetched', 'impression', 'read', 'actioned', 'closed',
    'failed', 'dead_letter', 'suppressed', 'cancelled'
  )),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  last_error_message text,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fetched_at timestamptz,
  first_impression_at timestamptz,
  last_impression_at timestamptz,
  read_at timestamptz,
  actioned_at timestamptz,
  closed_at timestamptz,
  terminal_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, recipient_type, recipient_key, channel, surface)
);

CREATE TABLE IF NOT EXISTS public.message_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES public.message_deliveries(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES public.message_campaign_runs(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'queued', 'fetched', 'impression', 'read', 'click', 'action', 'close',
    'failed', 'dead_letter', 'suppressed', 'cancelled'
  )),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 240),
  actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system', 'user', 'admin', 'worker', 'provider')),
  actor_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_id, event_key)
);

CREATE TABLE IF NOT EXISTS public.message_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 120),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 240),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  priority text NOT NULL DEFAULT 'P3' CHECK (priority IN ('P0', 'P1', 'P2', 'P3', 'P4')),
  run_id uuid REFERENCES public.message_campaign_runs(id) ON DELETE RESTRICT,
  delivery_id uuid REFERENCES public.message_deliveries(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry', 'published', 'dead_letter', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  locked_by text,
  locked_at timestamptz,
  locked_until timestamptz,
  last_error_code text,
  last_error_message text,
  trace_id text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND locked_by IS NOT NULL AND locked_until IS NOT NULL)
    OR status <> 'processing'
  )
);

CREATE TABLE IF NOT EXISTS public.message_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL UNIQUE REFERENCES public.message_outbox(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES public.message_campaign_runs(id) ON DELETE RESTRICT,
  delivery_id uuid REFERENCES public.message_deliveries(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'discarded')),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 120),
  reason_message text,
  attempt_count integer NOT NULL CHECK (attempt_count >= 0),
  payload_snapshot jsonb NOT NULL CHECK (jsonb_typeof(payload_snapshot) = 'object'),
  resolution_note text,
  resolved_by text,
  dead_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'open' AND resolved_at IS NULL)
    OR (status IN ('resolved', 'discarded') AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS message_campaigns_status_schedule_idx
  ON public.message_campaigns (status, schedule_at, created_at DESC);
CREATE INDEX IF NOT EXISTS message_campaign_runs_campaign_created_idx
  ON public.message_campaign_runs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_campaign_runs_status_schedule_idx
  ON public.message_campaign_runs (status, scheduled_at, created_at);
CREATE INDEX IF NOT EXISTS message_deliveries_run_status_idx
  ON public.message_deliveries (run_id, status, created_at);
CREATE INDEX IF NOT EXISTS message_deliveries_recipient_idx
  ON public.message_deliveries (recipient_type, recipient_key, created_at DESC);
CREATE INDEX IF NOT EXISTS message_events_delivery_time_idx
  ON public.message_events (delivery_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS message_events_run_type_idx
  ON public.message_events (run_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS message_outbox_due_idx
  ON public.message_outbox (priority, available_at, created_at)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS message_outbox_expired_lease_idx
  ON public.message_outbox (locked_until)
  WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS message_dead_letters_status_time_idx
  ON public.message_dead_letters (status, dead_at DESC);

CREATE OR REPLACE FUNCTION public.set_unified_message_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS message_templates_updated_at ON public.message_templates;
CREATE TRIGGER message_templates_updated_at
BEFORE UPDATE ON public.message_templates
FOR EACH ROW EXECUTE FUNCTION public.set_unified_message_updated_at();

DROP TRIGGER IF EXISTS message_surface_policies_updated_at ON public.message_surface_policies;
CREATE TRIGGER message_surface_policies_updated_at
BEFORE UPDATE ON public.message_surface_policies
FOR EACH ROW EXECUTE FUNCTION public.set_unified_message_updated_at();

DROP TRIGGER IF EXISTS message_campaigns_updated_at ON public.message_campaigns;
CREATE TRIGGER message_campaigns_updated_at
BEFORE UPDATE ON public.message_campaigns
FOR EACH ROW EXECUTE FUNCTION public.set_unified_message_updated_at();

DROP TRIGGER IF EXISTS message_campaign_runs_updated_at ON public.message_campaign_runs;
CREATE TRIGGER message_campaign_runs_updated_at
BEFORE UPDATE ON public.message_campaign_runs
FOR EACH ROW EXECUTE FUNCTION public.set_unified_message_updated_at();

DROP TRIGGER IF EXISTS message_deliveries_updated_at ON public.message_deliveries;
CREATE TRIGGER message_deliveries_updated_at
BEFORE UPDATE ON public.message_deliveries
FOR EACH ROW EXECUTE FUNCTION public.set_unified_message_updated_at();

DROP TRIGGER IF EXISTS message_outbox_updated_at ON public.message_outbox;
CREATE TRIGGER message_outbox_updated_at
BEFORE UPDATE ON public.message_outbox
FOR EACH ROW EXECUTE FUNCTION public.set_unified_message_updated_at();

DROP TRIGGER IF EXISTS message_dead_letters_updated_at ON public.message_dead_letters;
CREATE TRIGGER message_dead_letters_updated_at
BEFORE UPDATE ON public.message_dead_letters
FOR EACH ROW EXECUTE FUNCTION public.set_unified_message_updated_at();

-- Idempotent, transactional outbox enqueue. Future business-specific RPCs must
-- call this function inside their own database transaction; calling it after an
-- already committed business write does not retroactively make that write atomic.
CREATE OR REPLACE FUNCTION public.enqueue_message_outbox_atomic(
  p_idempotency_key text,
  p_aggregate_type text,
  p_aggregate_id text,
  p_event_type text,
  p_payload jsonb,
  p_priority text DEFAULT 'P3',
  p_run_id uuid DEFAULT NULL,
  p_delivery_id uuid DEFAULT NULL,
  p_max_attempts integer DEFAULT 8,
  p_available_at timestamptz DEFAULT clock_timestamp(),
  p_trace_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.message_outbox%ROWTYPE;
  v_created public.message_outbox%ROWTYPE;
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_aggregate_type text := nullif(btrim(p_aggregate_type), '');
  v_aggregate_id text := nullif(btrim(p_aggregate_id), '');
  v_event_type text := nullif(btrim(p_event_type), '');
BEGIN
  IF v_key IS NULL OR length(v_key) > 240 THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_IDEMPOTENCY_KEY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_aggregate_type IS NULL OR length(v_aggregate_type) > 120
     OR v_aggregate_id IS NULL OR length(v_aggregate_id) > 240
     OR v_event_type IS NULL OR length(v_event_type) > 120 THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_AGGREGATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_PAYLOAD_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_priority NOT IN ('P0', 'P1', 'P2', 'P3', 'P4') THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_PRIORITY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 100 THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_MAX_ATTEMPTS_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('message-outbox:' || v_key, 150002026));

  SELECT * INTO v_existing
  FROM public.message_outbox
  WHERE idempotency_key = v_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.aggregate_type <> v_aggregate_type
       OR v_existing.aggregate_id <> v_aggregate_id
       OR v_existing.event_type <> v_event_type
       OR v_existing.priority <> p_priority
       OR v_existing.payload <> p_payload
       OR v_existing.run_id IS DISTINCT FROM p_run_id
       OR v_existing.delivery_id IS DISTINCT FROM p_delivery_id THEN
      RAISE EXCEPTION 'MESSAGE_OUTBOX_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'outboxId', v_existing.id,
      'status', v_existing.status,
      'alreadyExisted', true,
      'attemptCount', v_existing.attempt_count,
      'availableAt', v_existing.available_at
    );
  END IF;

  INSERT INTO public.message_outbox (
    idempotency_key, aggregate_type, aggregate_id, event_type, priority,
    run_id, delivery_id, payload, max_attempts, available_at, trace_id
  ) VALUES (
    v_key, v_aggregate_type, v_aggregate_id, v_event_type, p_priority,
    p_run_id, p_delivery_id, p_payload, p_max_attempts,
    coalesce(p_available_at, clock_timestamp()), left(nullif(btrim(p_trace_id), ''), 240)
  )
  RETURNING * INTO v_created;

  RETURN jsonb_build_object(
    'success', true,
    'outboxId', v_created.id,
    'status', v_created.status,
    'alreadyExisted', false,
    'attemptCount', v_created.attempt_count,
    'availableAt', v_created.available_at
  );
END;
$$;

-- Claims due rows with SKIP LOCKED. Expired final leases are moved to the
-- dead-letter table before new work is claimed, so they cannot be stranded.
CREATE OR REPLACE FUNCTION public.claim_message_outbox_batch(
  p_worker_id text,
  p_batch_size integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 60
)
RETURNS SETOF public.message_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_worker_id text := nullif(btrim(p_worker_id), '');
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_worker_id IS NULL OR length(v_worker_id) > 160 THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_WORKER_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 100 THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_BATCH_SIZE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_LEASE_INVALID' USING ERRCODE = '22023';
  END IF;

  WITH exhausted AS (
    UPDATE public.message_outbox AS exhausted_outbox
    SET status = 'dead_letter',
        lease_token = NULL,
        locked_by = NULL,
        locked_at = NULL,
        locked_until = NULL,
        last_error_code = coalesce(exhausted_outbox.last_error_code, 'MESSAGE_OUTBOX_ATTEMPTS_EXHAUSTED'),
        last_error_message = coalesce(exhausted_outbox.last_error_message, 'Outbox attempts exhausted before a terminal receipt was recorded')
    WHERE exhausted_outbox.attempt_count >= exhausted_outbox.max_attempts
      AND (
        exhausted_outbox.status IN ('pending', 'retry')
        OR (exhausted_outbox.status = 'processing' AND exhausted_outbox.locked_until <= v_now)
      )
    RETURNING exhausted_outbox.*
  )
  INSERT INTO public.message_dead_letters (
    outbox_id, run_id, delivery_id, reason_code, reason_message,
    attempt_count, payload_snapshot, dead_at
  )
  SELECT
    exhausted.id, exhausted.run_id, exhausted.delivery_id,
    coalesce(exhausted.last_error_code, 'MESSAGE_OUTBOX_ATTEMPTS_EXHAUSTED'),
    left(exhausted.last_error_message, 2000), exhausted.attempt_count,
    exhausted.payload, v_now
  FROM exhausted
  ON CONFLICT (outbox_id) DO NOTHING;

  RETURN QUERY
  WITH candidates AS (
    SELECT candidate.id
    FROM public.message_outbox AS candidate
    WHERE candidate.attempt_count < candidate.max_attempts
      AND (
        (candidate.status IN ('pending', 'retry') AND candidate.available_at <= v_now)
        OR (candidate.status = 'processing' AND candidate.locked_until <= v_now)
      )
    ORDER BY
      CASE candidate.priority
        WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2
        WHEN 'P3' THEN 3 ELSE 4
      END,
      candidate.available_at,
      candidate.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.message_outbox AS claimed
  SET status = 'processing',
      attempt_count = claimed.attempt_count + 1,
      lease_token = gen_random_uuid(),
      locked_by = v_worker_id,
      locked_at = v_now,
      locked_until = v_now + make_interval(secs => p_lease_seconds)
  FROM candidates
  WHERE claimed.id = candidates.id
  RETURNING claimed.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_message_outbox_attempt(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_outbox public.message_outbox%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_next_status text;
BEGIN
  IF p_outbox_id IS NULL OR p_lease_token IS NULL OR p_succeeded IS NULL THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_SETTLEMENT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_retry_delay_seconds IS NULL OR p_retry_delay_seconds < 0 OR p_retry_delay_seconds > 86400 THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_RETRY_DELAY_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_outbox
  FROM public.message_outbox
  WHERE id = p_outbox_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_outbox.status IN ('published', 'dead_letter', 'cancelled') THEN
    RETURN jsonb_build_object(
      'success', true,
      'outboxId', v_outbox.id,
      'status', v_outbox.status,
      'attemptCount', v_outbox.attempt_count,
      'alreadySettled', true
    );
  END IF;

  IF v_outbox.status <> 'processing' OR v_outbox.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'MESSAGE_OUTBOX_LEASE_CONFLICT' USING ERRCODE = '40001';
  END IF;

  IF p_succeeded THEN
    UPDATE public.message_outbox
    SET status = 'published',
        published_at = v_now,
        lease_token = NULL,
        locked_by = NULL,
        locked_at = NULL,
        locked_until = NULL,
        last_error_code = NULL,
        last_error_message = NULL
    WHERE id = v_outbox.id
    RETURNING * INTO v_outbox;
    v_next_status := 'published';
  ELSIF v_outbox.attempt_count >= v_outbox.max_attempts THEN
    UPDATE public.message_outbox
    SET status = 'dead_letter',
        lease_token = NULL,
        locked_by = NULL,
        locked_at = NULL,
        locked_until = NULL,
        last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'MESSAGE_OUTBOX_DELIVERY_FAILED'), 120),
        last_error_message = left(coalesce(p_error_message, ''), 2000)
    WHERE id = v_outbox.id
    RETURNING * INTO v_outbox;

    INSERT INTO public.message_dead_letters (
      outbox_id, run_id, delivery_id, reason_code, reason_message,
      attempt_count, payload_snapshot, dead_at
    ) VALUES (
      v_outbox.id, v_outbox.run_id, v_outbox.delivery_id,
      coalesce(v_outbox.last_error_code, 'MESSAGE_OUTBOX_DELIVERY_FAILED'),
      v_outbox.last_error_message, v_outbox.attempt_count, v_outbox.payload, v_now
    )
    ON CONFLICT (outbox_id) DO NOTHING;
    v_next_status := 'dead_letter';
  ELSE
    UPDATE public.message_outbox
    SET status = 'retry',
        available_at = v_now + make_interval(secs => p_retry_delay_seconds),
        lease_token = NULL,
        locked_by = NULL,
        locked_at = NULL,
        locked_until = NULL,
        last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'MESSAGE_OUTBOX_DELIVERY_FAILED'), 120),
        last_error_message = left(coalesce(p_error_message, ''), 2000)
    WHERE id = v_outbox.id
    RETURNING * INTO v_outbox;
    v_next_status := 'retry';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'outboxId', v_outbox.id,
    'status', v_next_status,
    'attemptCount', v_outbox.attempt_count,
    'maxAttempts', v_outbox.max_attempts,
    'availableAt', v_outbox.available_at,
    'alreadySettled', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_unified_messaging_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'migration', '20261002150000',
    'asOf', now(),
    'tableCounts', jsonb_build_object(
      'templates', (SELECT count(*) FROM public.message_templates),
      'surfacePolicies', (SELECT count(*) FROM public.message_surface_policies),
      'campaigns', (SELECT count(*) FROM public.message_campaigns),
      'runs', (SELECT count(*) FROM public.message_campaign_runs),
      'deliveries', (SELECT count(*) FROM public.message_deliveries),
      'events', (SELECT count(*) FROM public.message_events),
      'outbox', (SELECT count(*) FROM public.message_outbox),
      'deadLetters', (SELECT count(*) FROM public.message_dead_letters)
    ),
    'outbox', jsonb_build_object(
      'pending', (SELECT count(*) FROM public.message_outbox WHERE status = 'pending'),
      'processing', (SELECT count(*) FROM public.message_outbox WHERE status = 'processing'),
      'retry', (SELECT count(*) FROM public.message_outbox WHERE status = 'retry'),
      'published', (SELECT count(*) FROM public.message_outbox WHERE status = 'published'),
      'deadLetter', (SELECT count(*) FROM public.message_outbox WHERE status = 'dead_letter'),
      'cancelled', (SELECT count(*) FROM public.message_outbox WHERE status = 'cancelled'),
      'due', (SELECT count(*) FROM public.message_outbox WHERE status IN ('pending', 'retry') AND available_at <= now()),
      'oldestDueAt', (SELECT min(available_at) FROM public.message_outbox WHERE status IN ('pending', 'retry') AND available_at <= now())
    ),
    'deliveries', jsonb_build_object(
      'queued', (SELECT count(*) FROM public.message_deliveries WHERE status = 'queued'),
      'fetched', (SELECT count(*) FROM public.message_deliveries WHERE status = 'fetched'),
      'impression', (SELECT count(*) FROM public.message_deliveries WHERE status = 'impression'),
      'read', (SELECT count(*) FROM public.message_deliveries WHERE status = 'read'),
      'actioned', (SELECT count(*) FROM public.message_deliveries WHERE status = 'actioned'),
      'closed', (SELECT count(*) FROM public.message_deliveries WHERE status = 'closed'),
      'failed', (SELECT count(*) FROM public.message_deliveries WHERE status = 'failed'),
      'deadLetter', (SELECT count(*) FROM public.message_deliveries WHERE status = 'dead_letter'),
      'suppressed', (SELECT count(*) FROM public.message_deliveries WHERE status = 'suppressed'),
      'cancelled', (SELECT count(*) FROM public.message_deliveries WHERE status = 'cancelled')
    ),
    'deadLetters', jsonb_build_object(
      'open', (SELECT count(*) FROM public.message_dead_letters WHERE status = 'open'),
      'resolved', (SELECT count(*) FROM public.message_dead_letters WHERE status = 'resolved'),
      'discarded', (SELECT count(*) FROM public.message_dead_letters WHERE status = 'discarded')
    ),
    'surfacePolicies', jsonb_build_object(
      'active', (SELECT count(*) FROM public.message_surface_policies WHERE status = 'active'),
      'draft', (SELECT count(*) FROM public.message_surface_policies WHERE status = 'draft'),
      'retired', (SELECT count(*) FROM public.message_surface_policies WHERE status = 'retired')
    )
  );
$$;

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_surface_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_campaign_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_dead_letters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.message_templates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_surface_policies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_campaigns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_campaign_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_deliveries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_dead_letters FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_surface_policies TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_campaign_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_deliveries TO service_role;
GRANT SELECT, INSERT ON TABLE public.message_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.message_outbox TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.message_dead_letters TO service_role;

REVOKE ALL ON FUNCTION public.set_unified_message_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_message_outbox_atomic(text, text, text, text, jsonb, text, uuid, uuid, integer, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_message_outbox_batch(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_message_outbox_attempt(uuid, uuid, boolean, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_unified_messaging_status() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_unified_message_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_message_outbox_atomic(text, text, text, text, jsonb, text, uuid, uuid, integer, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_message_outbox_batch(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_message_outbox_attempt(uuid, uuid, boolean, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_unified_messaging_status() TO service_role;

COMMENT ON TABLE public.message_campaigns IS 'Unified message intent and audience rule. Stage 1 does not import legacy messages.';
COMMENT ON TABLE public.message_campaign_runs IS 'Immutable content, audience, and surface snapshots for one campaign publication attempt.';
COMMENT ON TABLE public.message_deliveries IS 'Per-recipient delivery state; target, fetched, impression, and read are distinct facts.';
COMMENT ON TABLE public.message_events IS 'Append-only idempotent user and worker delivery events.';
COMMENT ON TABLE public.message_outbox IS 'Transactional outbox with leases, retries, and terminal states.';
COMMENT ON TABLE public.message_dead_letters IS 'Terminal outbox failures retained for explicit review and resolution.';
COMMENT ON FUNCTION public.enqueue_message_outbox_atomic(text, text, text, text, jsonb, text, uuid, uuid, integer, timestamptz, text)
  IS 'Idempotently inserts one outbox row. Business RPCs must call it inside the same database transaction as their business mutation.';

NOTIFY pgrst, 'reload schema';
COMMIT;
