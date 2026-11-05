BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- New administrators must not inherit every business feature by default.
-- The super administrator grants features/agents explicitly; anything not
-- selected stays inaccessible on both the page and API paths.
-- Existing assignments are intentionally left untouched: revoking historical
-- admin_default rows is a separate, operator-approved data decision.
CREATE OR REPLACE FUNCTION public.seed_admin_member_permission_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_features jsonb := '[]'::jsonb;
  v_agents jsonb := '[]'::jsonb;
  v_checksum text;
  v_inserted integer := 0;
BEGIN
  IF NEW.role <> 'admin' THEN RETURN NEW; END IF;
  v_checksum := public.member_permission_checksum(NEW.id, v_features, v_agents, 1);
  PERFORM set_config('app.member_permission_write', 'on', true);
  INSERT INTO public.member_permission_assignments (
    user_id, feature_navigation_keys, agent_navigation_keys, revision, checksum,
    source, reason, updated_by
  ) VALUES (
    NEW.id, v_features, v_agents, 1, v_checksum,
    'admin_default', '管理员默认不授予业务功能；由超级管理员按需勾选后生效', NULL
  )
  ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted > 0 THEN
    INSERT INTO public.member_permission_events (
      user_id, actor_id, revision, source, request_key, reason, before_snapshot, after_snapshot
    ) VALUES (
      NEW.id, NULL, 1, 'admin_default', NULL,
      '管理员默认不授予业务功能；由超级管理员按需勾选后生效', NULL,
      jsonb_build_object(
        'feature_navigation_keys', v_features,
        'agent_navigation_keys', v_agents,
        'source_profile_key', NULL,
        'source_profile_version', NULL,
        'revision', 1,
        'checksum', v_checksum
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_admin_member_permission_snapshot() FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
