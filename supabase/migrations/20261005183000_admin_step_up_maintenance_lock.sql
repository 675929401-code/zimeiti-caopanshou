BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- A singleton, server-owned control plane for temporarily pausing only the
-- secondary-password (step-up) requirement. Role permissions and every
-- downstream business invariant remain authoritative.
CREATE TABLE IF NOT EXISTS public.admin_step_up_maintenance_lock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  is_enabled boolean NOT NULL DEFAULT false,
  enabled_by text,
  enabled_at timestamptz,
  expires_at timestamptz,
  enable_reason text NOT NULL DEFAULT '',
  disabled_by text,
  disabled_at timestamptz,
  disable_reason text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (is_enabled = false)
    OR (
      enabled_by IS NOT NULL
      AND enabled_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > enabled_at
      AND btrim(enable_reason) <> ''
    )
  )
);

INSERT INTO public.admin_step_up_maintenance_lock (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.admin_step_up_maintenance_lock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_step_up_maintenance_lock FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_step_up_maintenance_lock TO service_role;

CREATE OR REPLACE FUNCTION public.read_admin_step_up_maintenance_lock()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state public.admin_step_up_maintenance_lock%ROWTYPE;
BEGIN
  SELECT * INTO v_state
  FROM public.admin_step_up_maintenance_lock
  WHERE singleton = true
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.admin_step_up_maintenance_lock (singleton)
    VALUES (true)
    RETURNING * INTO v_state;
  END IF;

  IF v_state.is_enabled AND v_state.expires_at <= now() THEN
    UPDATE public.admin_step_up_maintenance_lock
    SET is_enabled = false,
        disabled_by = 'system',
        disabled_at = v_state.expires_at,
        disable_reason = 'ttl_expired',
        revision = revision + 1,
        updated_at = now()
    WHERE singleton = true
    RETURNING * INTO v_state;

    PERFORM public.append_admin_governance_audit(
      '', 'system', '', 'admin.accounts.manage',
      'admin_step_up_maintenance_expire', 'success', 'TTL_EXPIRED',
      'admin_step_up_maintenance_lock', '', '', '', '', '',
      jsonb_build_object('expired_at', v_state.disabled_at, 'revision', v_state.revision)
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'ready',
    'enabled', v_state.is_enabled,
    'revision', v_state.revision,
    'enabled_by', v_state.enabled_by,
    'enabled_at', v_state.enabled_at,
    'expires_at', v_state.expires_at,
    'enable_reason', v_state.enable_reason,
    'disabled_by', v_state.disabled_by,
    'disabled_at', v_state.disabled_at,
    'disable_reason', v_state.disable_reason,
    'max_duration_minutes', 30,
    'updated_at', v_state.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_admin_step_up_maintenance_lock(
  p_actor_id text,
  p_enable boolean,
  p_reason text,
  p_duration_minutes integer,
  p_expected_revision integer,
  p_step_up_token_hash text,
  p_request_key text,
  p_request_path text,
  p_request_method text,
  p_request_ip text,
  p_user_agent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor jsonb;
  v_step_up jsonb;
  v_state public.admin_step_up_maintenance_lock%ROWTYPE;
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
  v_duration integer := coalesce(p_duration_minutes, 30);
  v_expires_at timestamptz;
  v_revoked integer := 0;
BEGIN
  v_actor := public.read_admin_access_snapshot(p_actor_id);
  IF v_actor->>'authority_status' <> 'ready'
     OR coalesce((v_actor->>'integrity_valid')::boolean, false) IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('success', false, 'code', 'ADMIN_AUTHORITY_NOT_READY');
  END IF;
  IF v_actor->>'admin_level' <> 'super_admin' THEN
    RETURN jsonb_build_object('success', false, 'code', 'SUPER_ADMIN_REQUIRED');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('success', false, 'code', 'MAINTENANCE_REASON_REQUIRED');
  END IF;

  SELECT * INTO v_state
  FROM public.admin_step_up_maintenance_lock
  WHERE singleton = true
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.admin_step_up_maintenance_lock (singleton)
    VALUES (true)
    RETURNING * INTO v_state;
  END IF;

  IF v_state.is_enabled AND v_state.expires_at <= now() THEN
    UPDATE public.admin_step_up_maintenance_lock
    SET is_enabled = false,
        disabled_by = 'system',
        disabled_at = v_state.expires_at,
        disable_reason = 'ttl_expired',
        revision = revision + 1,
        updated_at = now()
    WHERE singleton = true
    RETURNING * INTO v_state;
  END IF;

  IF v_state.revision <> p_expected_revision THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MAINTENANCE_REVISION_CONFLICT',
      'revision', v_state.revision
    );
  END IF;

  IF p_enable THEN
    IF v_duration < 1 OR v_duration > 30 THEN
      RETURN jsonb_build_object('success', false, 'code', 'MAINTENANCE_DURATION_INVALID');
    END IF;
    IF nullif(btrim(coalesce(p_step_up_token_hash, '')), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'ADMIN_STEP_UP_REQUIRED');
    END IF;
    v_step_up := public.read_admin_step_up_session(
      p_actor_id,
      p_step_up_token_hash,
      'admin.accounts.manage'
    );
    IF v_step_up->>'status' <> 'ready' THEN
      RETURN jsonb_build_object('success', false, 'code', 'ADMIN_STEP_UP_REQUIRED');
    END IF;
    v_expires_at := now() + make_interval(mins => v_duration);
    UPDATE public.admin_step_up_maintenance_lock
    SET is_enabled = true,
        enabled_by = p_actor_id,
        enabled_at = now(),
        expires_at = v_expires_at,
        enable_reason = v_reason,
        disabled_by = NULL,
        disabled_at = NULL,
        disable_reason = '',
        revision = revision + 1,
        updated_at = now()
    WHERE singleton = true
    RETURNING * INTO v_state;
  ELSE
    IF NOT v_state.is_enabled THEN
      RETURN jsonb_build_object(
        'success', true,
        'code', 'NO_CHANGE',
        'state', jsonb_build_object(
          'status', 'ready', 'enabled', false, 'revision', v_state.revision,
          'enabled_by', v_state.enabled_by, 'enabled_at', v_state.enabled_at,
          'expires_at', v_state.expires_at, 'enable_reason', v_state.enable_reason,
          'disabled_by', v_state.disabled_by, 'disabled_at', v_state.disabled_at,
          'disable_reason', v_state.disable_reason, 'max_duration_minutes', 30,
          'updated_at', v_state.updated_at
        )
      );
    END IF;
    UPDATE public.admin_step_up_maintenance_lock
    SET is_enabled = false,
        disabled_by = p_actor_id,
        disabled_at = now(),
        disable_reason = v_reason,
        revision = revision + 1,
        updated_at = now()
    WHERE singleton = true
    RETURNING * INTO v_state;
  END IF;

  -- Any pre-existing password session must not become valid again after the
  -- maintenance window closes. Both directions therefore revoke active
  -- sessions and force a fresh password confirmation after restoration.
  PERFORM set_config('app.admin_governance_write', 'on', true);
  UPDATE public.admin_step_up_sessions
  SET revoked_at = now()
  WHERE revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  PERFORM public.append_admin_governance_audit(
    p_actor_id, 'super_admin', '', 'admin.accounts.manage',
    CASE WHEN p_enable THEN 'admin_step_up_maintenance_enable' ELSE 'admin_step_up_maintenance_disable' END,
    'success', CASE WHEN p_enable THEN 'LIMITED_MAINTENANCE_WINDOW' ELSE 'LOCKS_RESTORED' END,
    'admin_step_up_maintenance_lock', p_request_path, p_request_method,
    p_request_key, p_request_ip, p_user_agent,
    jsonb_build_object(
      'reason', v_reason,
      'duration_minutes', CASE WHEN p_enable THEN v_duration ELSE NULL END,
      'expires_at', v_state.expires_at,
      'revision', v_state.revision,
      'revoked_step_up_sessions', v_revoked
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'code', CASE WHEN p_enable THEN 'MAINTENANCE_ENABLED' ELSE 'MAINTENANCE_DISABLED' END,
    'state', jsonb_build_object(
      'status', 'ready',
      'enabled', v_state.is_enabled,
      'revision', v_state.revision,
      'enabled_by', v_state.enabled_by,
      'enabled_at', v_state.enabled_at,
      'expires_at', v_state.expires_at,
      'enable_reason', v_state.enable_reason,
      'disabled_by', v_state.disabled_by,
      'disabled_at', v_state.disabled_at,
      'disable_reason', v_state.disable_reason,
      'max_duration_minutes', 30,
      'updated_at', v_state.updated_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.read_admin_step_up_maintenance_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_step_up_maintenance_lock(text,boolean,text,integer,integer,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_admin_step_up_maintenance_lock() TO service_role;
GRANT EXECUTE ON FUNCTION public.set_admin_step_up_maintenance_lock(text,boolean,text,integer,integer,text,text,text,text,text,text) TO service_role;

COMMIT;
