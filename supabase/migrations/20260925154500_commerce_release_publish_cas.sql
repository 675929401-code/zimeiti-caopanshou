BEGIN;

DROP FUNCTION IF EXISTS public.publish_commerce_config_release_atomic(uuid, uuid);

CREATE OR REPLACE FUNCTION public.publish_commerce_config_release_atomic(
  p_release_id uuid,
  p_actor_id uuid,
  p_expected_candidate_sha text,
  p_expected_current_id uuid,
  p_expected_current_sha text
) RETURNS public.commerce_config_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_release public.commerce_config_releases%ROWTYPE;
  v_current public.commerce_config_releases%ROWTYPE;
  v_has_current boolean := false;
BEGIN
  SELECT * INTO v_release
    FROM public.commerce_config_releases
    WHERE id = p_release_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMMERCE_RELEASE_NOT_FOUND'; END IF;
  IF v_release.status <> 'validated' THEN RAISE EXCEPTION 'COMMERCE_RELEASE_NOT_VALIDATED'; END IF;
  IF p_expected_candidate_sha IS NULL OR v_release.manifest_sha256 IS DISTINCT FROM p_expected_candidate_sha THEN
    RAISE EXCEPTION 'COMMERCE_RELEASE_CANDIDATE_CHANGED';
  END IF;

  SELECT * INTO v_current
    FROM public.commerce_config_releases
    WHERE is_current = true AND status = 'published'
    LIMIT 1
    FOR UPDATE;
  v_has_current := FOUND;

  IF p_expected_current_id IS NULL THEN
    IF v_has_current THEN RAISE EXCEPTION 'COMMERCE_RELEASE_CURRENT_CHANGED'; END IF;
  ELSIF NOT v_has_current
    OR v_current.id IS DISTINCT FROM p_expected_current_id
    OR p_expected_current_sha IS NULL
    OR v_current.manifest_sha256 IS DISTINCT FROM p_expected_current_sha THEN
    RAISE EXCEPTION 'COMMERCE_RELEASE_CURRENT_CHANGED';
  END IF;

  IF v_has_current THEN
    UPDATE public.commerce_config_releases
      SET is_current = false, status = 'superseded'
      WHERE id = v_current.id;
  END IF;

  UPDATE public.commerce_config_releases
    SET is_current = true, status = 'published', published_by = p_actor_id, published_at = now()
    WHERE id = p_release_id
    RETURNING * INTO v_release;

  UPDATE public.commerce_card_versions SET status = 'published'
    WHERE id IN (SELECT jsonb_array_elements_text(v_release.manifest->'cardVersionIds')::uuid);
  UPDATE public.commerce_prompt_versions SET status = 'published'
    WHERE id IN (SELECT jsonb_array_elements_text(v_release.manifest->'promptVersionIds')::uuid);
  UPDATE public.commerce_knowledge_documents SET status = 'published'
    WHERE id IN (SELECT jsonb_array_elements_text(v_release.manifest->'knowledgeDocumentIds')::uuid);
  UPDATE public.commerce_operation_routes SET status = 'published'
    WHERE id IN (SELECT jsonb_array_elements_text(v_release.manifest->'operationRouteIds')::uuid);
  UPDATE public.commerce_cards c SET current_published_version_id = v.id, status = 'published', updated_at = now()
    FROM public.commerce_card_versions v
    WHERE v.id IN (SELECT jsonb_array_elements_text(v_release.manifest->'cardVersionIds')::uuid) AND v.card_id = c.id;
  RETURN v_release;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_commerce_config_release_atomic(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_commerce_config_release_atomic(uuid, uuid, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.reject_published_commerce_release_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published','superseded') THEN RAISE EXCEPTION 'COMMERCE_RELEASE_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('published','superseded') THEN
    IF NEW.release_version IS DISTINCT FROM OLD.release_version
      OR NEW.manifest IS DISTINCT FROM OLD.manifest
      OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
      OR NEW.validation_result IS DISTINCT FROM OLD.validation_result
      OR NEW.published_by IS DISTINCT FROM OLD.published_by
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR (OLD.status = 'published' AND NEW.status NOT IN ('published','superseded'))
      OR (OLD.status = 'superseded' AND NEW.status <> 'superseded') THEN
      RAISE EXCEPTION 'COMMERCE_RELEASE_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_release_immutable ON public.commerce_config_releases;
CREATE TRIGGER commerce_release_immutable
  BEFORE UPDATE OR DELETE ON public.commerce_config_releases
  FOR EACH ROW EXECUTE FUNCTION public.reject_published_commerce_release_mutation();

COMMIT;
