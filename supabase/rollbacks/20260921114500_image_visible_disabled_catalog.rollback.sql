BEGIN;

CREATE OR REPLACE FUNCTION public.read_image_model_publication_state(p_model_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'model',to_jsonb(m),'modelSnapshotHash',public.image_model_validation_snapshot(m),
    'published',coalesce((SELECT jsonb_agg(jsonb_build_object('configurationHash',v.configuration_hash,
      'modelSnapshotHash',v.model_snapshot_hash)) FROM public.image_model_validations v
      WHERE v.model_id=m.id AND v.state='published'),'[]'::jsonb),
    'legacyBaseline',(SELECT jsonb_build_object('configurationHash',b.configuration_hash,
      'modelSnapshotHash',b.model_snapshot_hash,'evidenceRef',b.evidence_ref)
      FROM public.image_model_legacy_baselines b WHERE b.model_id=m.id)
  ) ORDER BY m.sort_order,m.id),'[]'::jsonb)
  FROM public.cover_models m WHERE (p_model_id IS NULL AND m.is_active=true AND m.is_hidden=false) OR m.id=p_model_id;
$$;

COMMIT;
