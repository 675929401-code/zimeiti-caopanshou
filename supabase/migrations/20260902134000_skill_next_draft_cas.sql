BEGIN;

-- A released version is immutable. Editing it creates a new draft while the
-- package row (including metadata) stays guarded by its observed timestamp.
-- Keep the existing draft-update RPC and its version CAS contract unchanged.
CREATE FUNCTION public.create_skill_package_next_draft(
  p_slug text,
  p_display_name text,
  p_summary text,
  p_origin text,
  p_visibility text,
  p_runtime_kind text,
  p_payload jsonb,
  p_payload_hash text,
  p_semver text,
  p_schema_version text,
  p_metadata jsonb,
  p_package_id uuid,
  p_base_version_id uuid,
  p_expected_package_updated_at timestamptz,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_package public.skill_packages%ROWTYPE;
  v_base public.skill_versions%ROWTYPE;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
BEGIN
  IF p_package_id IS NULL OR p_base_version_id IS NULL
     OR p_expected_package_updated_at IS NULL THEN
    RAISE EXCEPTION 'SKILL_NEXT_DRAFT_BASE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL OR NOT public.skill_runtime_actor_valid(p_actor_id) THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Match the old RPC's lock order, then hold the package lock through its call.
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-package:' || v_slug, 0));
  SELECT * INTO v_package FROM public.skill_packages
   WHERE id = p_package_id AND slug = v_slug FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKILL_NEXT_DRAFT_PACKAGE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_package.updated_at IS DISTINCT FROM p_expected_package_updated_at THEN
    RAISE EXCEPTION 'SKILL_NEXT_DRAFT_PACKAGE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_package.lifecycle <> 'published' THEN
    RAISE EXCEPTION 'SKILL_NEXT_DRAFT_PACKAGE_NOT_PUBLISHED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_base FROM public.skill_versions
   WHERE id = p_base_version_id AND package_id = v_package.id;
  IF NOT FOUND OR v_base.status <> 'released' OR v_base.published_at IS NULL THEN
    RAISE EXCEPTION 'SKILL_NEXT_DRAFT_BASE_NOT_RELEASED' USING ERRCODE = '22023';
  END IF;

  -- The existing RPC owns payload validation, version numbering, immutable
  -- release rules and audit insertion. This transaction supplies its missing
  -- package-level CAS for creating a successor; it is not a draft update.
  RETURN public.save_skill_package_draft(
    p_slug, p_display_name, p_summary, p_origin, p_visibility, p_runtime_kind,
    p_payload, p_payload_hash, p_semver, p_schema_version, p_metadata,
    p_package_id, NULL::uuid, NULL::timestamptz, p_actor_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_skill_package_next_draft(
  text, text, text, text, text, text, jsonb, text, text, text, jsonb,
  uuid, uuid, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_skill_package_next_draft(
  text, text, text, text, text, text, jsonb, text, text, text, jsonb,
  uuid, uuid, timestamptz, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
