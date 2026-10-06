-- Root executes ONLY against 127.0.0.1:54322/zimeiti_local after the archive migration.
-- Reuses the original private acceptance package; all fixture changes roll back.
BEGIN;
DO $$
DECLARE
  p public.skill_packages%ROWTYPE;
  v_version_hashes jsonb;
  v_after_hashes jsonb;
  v_audit_count bigint;
  v_result jsonb;
BEGIN
  IF current_database() <> 'zimeiti_local' THEN RAISE EXCEPTION 'LOCAL_DATABASE_REQUIRED'; END IF;
  SELECT * INTO p FROM public.skill_packages WHERE id = 'cf44b5b6-18e9-4a5a-8096-8c510f7be1c2';
  IF NOT FOUND OR p.slug <> 'local-manju-crud-2d8e3ee5' OR p.visibility <> 'private'
     OR p.origin <> 'custom' OR p.lifecycle <> 'published'
     OR p.metadata->>'localAcceptanceFixture' <> 'true' THEN RAISE EXCEPTION 'KNOWN_PRIVATE_FIXTURE_REQUIRED'; END IF;
  SELECT jsonb_agg(jsonb_build_array(id, payload_hash, status) ORDER BY version_number)
    INTO v_version_hashes FROM public.skill_versions WHERE package_id = p.id;
  SELECT count(*) INTO v_audit_count FROM public.skill_release_audit WHERE package_id = p.id;
  IF has_function_privilege('anon', 'public.archive_skill_package(uuid,timestamp with time zone,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.archive_skill_package(uuid,timestamp with time zone,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ARCHIVE_RPC_MUST_BE_SERVER_ONLY';
  END IF;
  BEGIN
    PERFORM public.archive_skill_package(p.id, p.updated_at, p.active_version_id, 'fixture-other-owner');
    RAISE EXCEPTION 'OWNER_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'SKILL_ARCHIVE_OWNER_REQUIRED' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.archive_skill_package(p.id, p.updated_at - interval '1 second', p.active_version_id, p.created_by);
    RAISE EXCEPTION 'CAS_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    INSERT INTO public.user_skill_installations(user_id, package_id, version_id, enabled, installed_by)
      VALUES(p.created_by, p.id, p.active_version_id, true, p.created_by);
    PERFORM public.archive_skill_package(p.id, p.updated_at, p.active_version_id, p.created_by);
    RAISE EXCEPTION 'INSTALLATION_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'SKILL_ARCHIVE_IN_USE' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.skill_invocations(user_id, package_id, version_id, client_idempotency_key, payload_fingerprint, input)
      VALUES(p.created_by, p.id, p.active_version_id, 'archive-rollback-only-fixture', repeat('1',64), '{}'::jsonb);
    PERFORM public.archive_skill_package(p.id, p.updated_at, p.active_version_id, p.created_by);
    RAISE EXCEPTION 'INVOCATION_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'SKILL_ARCHIVE_IN_USE' THEN RAISE; END IF;
  END;
  v_result := public.archive_skill_package(p.id, p.updated_at, p.active_version_id, p.created_by);
  IF v_result->>'lifecycle' <> 'archived' OR v_result->>'already_archived' <> 'false' THEN RAISE EXCEPTION 'ARCHIVE_FAILED'; END IF;
  v_result := public.archive_skill_package(p.id, p.updated_at, p.active_version_id, p.created_by);
  IF v_result->>'already_archived' <> 'true' THEN RAISE EXCEPTION 'ARCHIVE_REPLAY_FAILED'; END IF;
  IF (SELECT count(*) FROM public.skill_release_audit WHERE package_id = p.id) <> v_audit_count + 1 THEN RAISE EXCEPTION 'ARCHIVE_AUDIT_DUPLICATED'; END IF;
  SELECT jsonb_agg(jsonb_build_array(id, payload_hash, status) ORDER BY version_number)
    INTO v_after_hashes FROM public.skill_versions WHERE package_id = p.id;
  IF v_after_hashes IS DISTINCT FROM v_version_hashes THEN RAISE EXCEPTION 'ARCHIVE_CHANGED_VERSION_HISTORY'; END IF;
  BEGIN
    INSERT INTO public.user_skill_installations(user_id, package_id, version_id, enabled, installed_by)
      VALUES(p.created_by, p.id, p.active_version_id, true, p.created_by);
    RAISE EXCEPTION 'ARCHIVED_INSTALL_NOT_REJECTED';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.publish_skill_version(p.active_version_id, NULL, p.created_by);
    RAISE EXCEPTION 'ARCHIVED_PUBLISH_NOT_REJECTED';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    PERFORM public.rollback_skill_package_version(p.id, p.active_version_id, p.active_version_id, p.created_by);
    RAISE EXCEPTION 'ARCHIVED_ROLLBACK_NOT_REJECTED';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  RAISE NOTICE 'SKILL_ARCHIVE_LOCAL_PREDICATES_PASSED';
END;
$$;
ROLLBACK;
