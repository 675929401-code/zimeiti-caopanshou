-- Versioned, fail-closed configuration authority for the Commerce Agent.
-- User jobs, conversations and assets remain in the Commerce business store.

CREATE TABLE IF NOT EXISTS public.commerce_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key text NOT NULL UNIQUE CHECK (stable_key ~ '^[a-z0-9][a-z0-9.-]{2,79}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_validation','published','disabled','archived')),
  current_published_version_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commerce_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key text NOT NULL CHECK (length(prompt_key) BETWEEN 1 AND 120),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 50000),
  source text NOT NULL DEFAULT 'independent-implementation',
  change_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','published','archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(prompt_key, version)
);

CREATE TABLE IF NOT EXISTS public.commerce_knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_key text NOT NULL CHECK (length(knowledge_key) BETWEEN 1 AND 120),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 100000),
  enabled boolean NOT NULL DEFAULT true,
  applicable_card_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(applicable_card_keys) = 'array'),
  change_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','published','archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(knowledge_key, version)
);

CREATE TABLE IF NOT EXISTS public.commerce_card_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.commerce_cards(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  display jsonb NOT NULL CHECK (jsonb_typeof(display) = 'object'),
  material_slots jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(material_slots) = 'array'),
  input_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(input_fields) = 'array'),
  executor_type text NOT NULL CHECK (executor_type IN ('director','agent_plan','image_skill','video_entry','fixed_pipeline')),
  prompt_version_id uuid REFERENCES public.commerce_prompt_versions(id) ON DELETE RESTRICT,
  knowledge_document_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(knowledge_document_ids) = 'array'),
  output_contract jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_contract) = 'object'),
  quality_rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quality_rules) = 'object'),
  model_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(model_policy) = 'object'),
  video_defaults jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(video_defaults) = 'object'),
  test_cases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(test_cases) = 'array'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_validation','validated','published','disabled','archived')),
  validation_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation_result) = 'object'),
  change_note text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(card_id, version)
);

ALTER TABLE public.commerce_cards
  DROP CONSTRAINT IF EXISTS commerce_cards_current_version_fk;
ALTER TABLE public.commerce_cards
  ADD CONSTRAINT commerce_cards_current_version_fk
  FOREIGN KEY (current_published_version_id) REFERENCES public.commerce_card_versions(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.commerce_operation_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 3 AND 160),
  version integer NOT NULL CHECK (version > 0),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  model_kind text NOT NULL CHECK (model_kind IN ('agent','image','video')),
  primary_model_id text NOT NULL DEFAULT '',
  fallback_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fallback_model_ids) = 'array'),
  capability_requirements jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capability_requirements) = 'object'),
  user_selectable boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','published','disabled','archived')),
  change_note text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id, version),
  CHECK (user_selectable = false OR model_kind = 'video')
);

CREATE TABLE IF NOT EXISTS public.commerce_config_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_version integer NOT NULL UNIQUE CHECK (release_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','published','superseded','rolled_back','failed')),
  is_current boolean NOT NULL DEFAULT false,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manifest) = 'object'),
  validation_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation_result) = 'object'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  change_note text NOT NULL DEFAULT '',
  rollback_target_id uuid REFERENCES public.commerce_config_releases(id) ON DELETE RESTRICT,
  created_by uuid,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.commerce_model_acceptance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_kind text NOT NULL CHECK (model_kind IN ('agent','image','video')),
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  model_config_hash text NOT NULL CHECK (model_config_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('passed','invalidated')),
  canary_job_id text NOT NULL CHECK (length(canary_job_id) BETWEEN 1 AND 200),
  quote_id text,
  evidence_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_asset_ids) = 'array'),
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_summary) = 'object'),
  provider_cost numeric(18,8) NOT NULL DEFAULT 0 CHECK (provider_cost >= 0),
  verified_by uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(model_kind, model_id, model_config_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_config_one_current_release
  ON public.commerce_config_releases (is_current) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS commerce_card_versions_card_status_idx
  ON public.commerce_card_versions(card_id, status, version DESC);
CREATE INDEX IF NOT EXISTS commerce_prompt_versions_key_status_idx
  ON public.commerce_prompt_versions(prompt_key, status, version DESC);
CREATE INDEX IF NOT EXISTS commerce_operation_routes_operation_status_idx
  ON public.commerce_operation_routes(operation_id, status, version DESC);
CREATE INDEX IF NOT EXISTS commerce_model_acceptance_current_idx
  ON public.commerce_model_acceptance_evidence(model_kind, model_id, status, verified_at DESC);

ALTER TABLE public.commerce_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_card_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_operation_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_config_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_model_acceptance_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.commerce_cards FROM anon, authenticated;
REVOKE ALL ON public.commerce_card_versions FROM anon, authenticated;
REVOKE ALL ON public.commerce_prompt_versions FROM anon, authenticated;
REVOKE ALL ON public.commerce_knowledge_documents FROM anon, authenticated;
REVOKE ALL ON public.commerce_operation_routes FROM anon, authenticated;
REVOKE ALL ON public.commerce_config_releases FROM anon, authenticated;
REVOKE ALL ON public.commerce_model_acceptance_evidence FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reject_published_commerce_version_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN RAISE EXCEPTION 'PUBLISHED_COMMERCE_VERSION_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'PUBLISHED_COMMERCE_VERSION_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_card_versions_immutable ON public.commerce_card_versions;
CREATE TRIGGER commerce_card_versions_immutable BEFORE UPDATE OR DELETE ON public.commerce_card_versions FOR EACH ROW EXECUTE FUNCTION public.reject_published_commerce_version_mutation();
DROP TRIGGER IF EXISTS commerce_prompt_versions_immutable ON public.commerce_prompt_versions;
CREATE TRIGGER commerce_prompt_versions_immutable BEFORE UPDATE OR DELETE ON public.commerce_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.reject_published_commerce_version_mutation();
DROP TRIGGER IF EXISTS commerce_knowledge_documents_immutable ON public.commerce_knowledge_documents;
CREATE TRIGGER commerce_knowledge_documents_immutable BEFORE UPDATE OR DELETE ON public.commerce_knowledge_documents FOR EACH ROW EXECUTE FUNCTION public.reject_published_commerce_version_mutation();
DROP TRIGGER IF EXISTS commerce_operation_routes_immutable ON public.commerce_operation_routes;
CREATE TRIGGER commerce_operation_routes_immutable BEFORE UPDATE OR DELETE ON public.commerce_operation_routes FOR EACH ROW EXECUTE FUNCTION public.reject_published_commerce_version_mutation();

CREATE OR REPLACE FUNCTION public.reject_commerce_model_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'COMMERCE_MODEL_EVIDENCE_IMMUTABLE'; END IF;
  IF OLD.status = 'passed' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'COMMERCE_MODEL_EVIDENCE_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS commerce_model_evidence_immutable ON public.commerce_model_acceptance_evidence;
CREATE TRIGGER commerce_model_evidence_immutable BEFORE UPDATE OR DELETE ON public.commerce_model_acceptance_evidence FOR EACH ROW EXECUTE FUNCTION public.reject_commerce_model_evidence_mutation();

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
    SET is_current = false,
        status = CASE WHEN status = 'published' THEN 'superseded' ELSE status END
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

COMMENT ON TABLE public.commerce_config_releases IS 'Atomic Commerce Agent configuration publication pointer. Runtime snapshots reference immutable row ids.';
COMMENT ON TABLE public.commerce_model_acceptance_evidence IS 'Server-issued, configuration-hash-bound real canary evidence. Ordinary catalog clients cannot read this table.';
