BEGIN;

DROP TRIGGER IF EXISTS commerce_release_immutable ON public.commerce_config_releases;
DROP FUNCTION IF EXISTS public.reject_published_commerce_release_mutation();
DROP FUNCTION IF EXISTS public.publish_commerce_config_release_atomic(uuid, uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION public.publish_commerce_config_release_atomic(
  p_release_id uuid,
  p_actor_id uuid
) RETURNS public.commerce_config_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_release public.commerce_config_releases%ROWTYPE;
BEGIN
  SELECT * INTO v_release FROM public.commerce_config_releases WHERE id = p_release_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMMERCE_RELEASE_NOT_FOUND'; END IF;
  IF v_release.status <> 'validated' THEN RAISE EXCEPTION 'COMMERCE_RELEASE_NOT_VALIDATED'; END IF;
  UPDATE public.commerce_config_releases
    SET is_current = false, status = CASE WHEN status = 'published' THEN 'superseded' ELSE status END
    WHERE is_current = true;
  UPDATE public.commerce_config_releases
    SET is_current = true, status = 'published', published_by = p_actor_id, published_at = now()
    WHERE id = p_release_id RETURNING * INTO v_release;
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

REVOKE ALL ON FUNCTION public.publish_commerce_config_release_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_commerce_config_release_atomic(uuid, uuid) TO service_role;

COMMIT;
