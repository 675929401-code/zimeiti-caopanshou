-- Apply only to the approved local database in this acceptance round.
-- Forward-only: preserves released versions, invocation records and release audit.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.skill_packages') IS NULL
     OR to_regclass('public.skill_release_audit') IS NULL
     OR to_regprocedure('public.skill_runtime_actor_valid(text)') IS NULL THEN
    RAISE EXCEPTION 'SKILL_ARCHIVE_BASE_MIGRATION_REQUIRED';
  END IF;
END;
$$;

ALTER TABLE public.skill_release_audit DROP CONSTRAINT IF EXISTS skill_release_audit_action_check;
ALTER TABLE public.skill_release_audit ADD CONSTRAINT skill_release_audit_action_check
  CHECK (action IN ('create_draft', 'update_draft', 'publish', 'rollback', 'archive'));

-- Reference writes take a shared package lock before checking lifecycle.
-- This conflicts with archive's FOR UPDATE, closing the check/insert race.
CREATE OR REPLACE FUNCTION public.skill_runtime_lock_live_package_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_lifecycle text;
BEGIN
  SELECT lifecycle INTO v_lifecycle FROM public.skill_packages
   WHERE id = NEW.package_id FOR SHARE;
  IF NOT FOUND OR v_lifecycle <> 'published' THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_NOT_PUBLISHED' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS skill_archive_reference_lock ON public.user_skill_installations;
CREATE TRIGGER skill_archive_reference_lock BEFORE INSERT OR UPDATE ON public.user_skill_installations
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_lock_live_package_reference();
DROP TRIGGER IF EXISTS skill_archive_reference_lock ON public.agent_skill_installations;
CREATE TRIGGER skill_archive_reference_lock BEFORE INSERT OR UPDATE ON public.agent_skill_installations
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_lock_live_package_reference();
DROP TRIGGER IF EXISTS skill_archive_reference_lock ON public.skill_invocations;
CREATE TRIGGER skill_archive_reference_lock BEFORE INSERT ON public.skill_invocations
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_lock_live_package_reference();

CREATE OR REPLACE FUNCTION public.archive_skill_package(
  p_package_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_active_version_id uuid,
  p_actor_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_package public.skill_packages%ROWTYPE;
  v_version_id uuid;
  v_sequence bigint;
  v_slug text;
BEGIN
  IF p_package_id IS NULL OR p_expected_updated_at IS NULL OR p_actor_id IS NULL
     OR NOT public.skill_runtime_actor_valid(p_actor_id) THEN
    RAISE EXCEPTION 'SKILL_ARCHIVE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT slug INTO v_slug FROM public.skill_packages WHERE id = p_package_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SKILL_PACKAGE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-package:' || v_slug, 0));
  SELECT * INTO v_package FROM public.skill_packages WHERE id = p_package_id FOR UPDATE;
  IF v_package.created_by IS DISTINCT FROM p_actor_id
     OR v_package.visibility <> 'private' OR v_package.origin = 'builtin' THEN
    RAISE EXCEPTION 'SKILL_ARCHIVE_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_package.lifecycle = 'archived' THEN
    -- Reconcile only the same successful archive intent, not an unrelated stale edit.
    IF EXISTS (SELECT 1 FROM public.skill_release_audit
      WHERE package_id = p_package_id AND action = 'archive' AND actor_id = p_actor_id
        AND (detail->>'expected_updated_at')::timestamptz = p_expected_updated_at
        AND previous_version_id IS NOT DISTINCT FROM p_expected_active_version_id) THEN
      RETURN jsonb_build_object('ok', true, 'action', 'archive', 'package_id', p_package_id,
        'lifecycle', 'archived', 'already_archived', true, 'updated_at', v_package.updated_at);
    END IF;
    RAISE EXCEPTION 'SKILL_ARCHIVE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_package.updated_at IS DISTINCT FROM p_expected_updated_at
     OR v_package.active_version_id IS DISTINCT FROM p_expected_active_version_id THEN
    RAISE EXCEPTION 'SKILL_ARCHIVE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_skill_installations WHERE package_id = p_package_id AND enabled)
     OR EXISTS (SELECT 1 FROM public.agent_skill_installations WHERE package_id = p_package_id AND enabled)
     OR EXISTS (SELECT 1 FROM public.skill_invocations WHERE package_id = p_package_id AND state = 'claimed') THEN
    RAISE EXCEPTION 'SKILL_ARCHIVE_IN_USE' USING ERRCODE = '55000';
  END IF;
  SELECT id INTO v_version_id FROM public.skill_versions WHERE package_id = p_package_id
   ORDER BY (id = v_package.active_version_id) DESC NULLS LAST, version_number DESC LIMIT 1;
  IF v_version_id IS NULL THEN RAISE EXCEPTION 'SKILL_VERSION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.skill_packages SET lifecycle = 'archived', active_version_id = NULL, updated_by = p_actor_id
   WHERE id = p_package_id RETURNING * INTO v_package;
  SELECT coalesce(max(sequence), 0) + 1 INTO v_sequence FROM public.skill_release_audit WHERE package_id = p_package_id;
  INSERT INTO public.skill_release_audit(package_id, version_id, previous_version_id, sequence, action, actor_id, detail)
  VALUES (p_package_id, v_version_id, p_expected_active_version_id, v_sequence, 'archive', p_actor_id,
    jsonb_build_object('expected_updated_at', p_expected_updated_at, 'versions_preserved', true));
  RETURN jsonb_build_object('ok', true, 'action', 'archive', 'package_id', p_package_id,
    'lifecycle', 'archived', 'already_archived', false, 'updated_at', v_package.updated_at);
END;
$$;

REVOKE ALL ON FUNCTION public.skill_runtime_lock_live_package_reference() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_skill_package(uuid, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_skill_package(uuid, timestamptz, uuid, text) TO service_role;
COMMIT;
