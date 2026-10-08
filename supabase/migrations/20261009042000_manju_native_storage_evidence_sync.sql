-- Keep the authoritative native-storage evidence aligned with every active
-- Manju release.  The active pointer and the storage marker are one logical
-- commit: a published config must never become visible with stale cutover
-- evidence.

CREATE OR REPLACE FUNCTION public.manju_config_sync_native_storage_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_release public.manju_config_releases%ROWTYPE;
  v_revision public.manju_config_revisions%ROWTYPE;
  v_state public.manju_config_storage_state%ROWTYPE;
  v_next_generation bigint;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_release
    FROM public.manju_config_releases
   WHERE id = NEW.active_release_id
     AND environment = NEW.environment
     AND domain = NEW.domain;
  SELECT * INTO v_revision
    FROM public.manju_config_revisions
   WHERE id = NEW.active_revision_id
     AND environment = NEW.environment
     AND domain = NEW.domain;

  IF v_release.id IS NULL
     OR v_revision.id IS NULL
     OR v_release.revision_id IS DISTINCT FROM v_revision.id
     OR v_release.etag IS DISTINCT FROM NEW.etag
     OR v_release.etag IS DISTINCT FROM
        (v_revision.payload_hash || ':' || v_release.release_number::text)
     OR v_revision.status IS DISTINCT FROM 'published'
     OR v_revision.published_at IS NULL THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_EVIDENCE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_state
    FROM public.manju_config_storage_state
   WHERE environment = NEW.environment
     AND domain = NEW.domain
   FOR UPDATE;

  -- Compat and migrating scopes intentionally build native state before the
  -- final cutover transaction.  They must not be switched by this trigger.
  IF NOT FOUND OR v_state.state <> 'native' THEN
    RETURN NEW;
  END IF;

  IF v_state.native_active_release_id IS NOT DISTINCT FROM NEW.active_release_id
     AND v_state.native_active_revision_id IS NOT DISTINCT FROM NEW.active_revision_id
     AND v_state.native_payload_hash IS NOT DISTINCT FROM v_revision.payload_hash THEN
    RETURN NEW;
  END IF;

  UPDATE public.manju_config_storage_state
     SET generation = v_state.generation + 1,
         compat_storage_revision = NULL,
         compat_active_release_id = NULL,
         compat_active_revision_id = NULL,
         compat_payload_hash = NULL,
         native_active_release_id = NEW.active_release_id,
         native_active_revision_id = NEW.active_revision_id,
         native_payload_hash = v_revision.payload_hash,
         last_verified_at = v_now
   WHERE environment = NEW.environment
     AND domain = NEW.domain
     AND state = 'native'
     AND generation = v_state.generation
   RETURNING generation INTO v_next_generation;

  IF v_next_generation IS NULL THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_EVIDENCE_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.manju_config_audit (
    action,
    environment,
    domain,
    revision_id,
    release_id,
    previous_release_id,
    actor_id,
    detail
  ) VALUES (
    'storage_reconcile',
    NEW.environment,
    NEW.domain,
    NEW.active_revision_id,
    NEW.active_release_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.active_release_id ELSE NULL END,
    NEW.updated_by,
    jsonb_build_object(
      'storage', 'native',
      'reason', 'native-active-release-changed',
      'previous_generation', v_state.generation,
      'generation', v_next_generation,
      'previous_native_active_release_id', v_state.native_active_release_id,
      'previous_native_active_revision_id', v_state.native_active_revision_id,
      'previous_native_payload_hash', v_state.native_payload_hash,
      'native_active_release_id', NEW.active_release_id,
      'native_active_revision_id', NEW.active_revision_id,
      'native_payload_hash', v_revision.payload_hash,
      'compat_evidence_cleared', v_state.compat_payload_hash IS NOT NULL
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manju_config_active_native_storage_evidence
  ON public.manju_config_active;
CREATE TRIGGER manju_config_active_native_storage_evidence
  AFTER INSERT OR UPDATE OF active_release_id, active_revision_id, etag
  ON public.manju_config_active
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_sync_native_storage_evidence();

REVOKE ALL ON FUNCTION public.manju_config_sync_native_storage_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

