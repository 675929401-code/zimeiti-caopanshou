BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.llm_model_validation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.llm_models(id) ON DELETE CASCADE,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
  provider_host text NOT NULL CHECK (length(provider_host) BETWEEN 1 AND 255),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  checked_by uuid NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, configuration_hash)
);

CREATE INDEX IF NOT EXISTS llm_model_validation_evidence_checked_idx
  ON public.llm_model_validation_evidence (model_id, checked_at DESC);

ALTER TABLE public.llm_model_validation_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.llm_model_validation_evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.llm_model_validation_evidence TO service_role;

-- Keep catalog publication separate from operational activation.  The legacy
-- projection remains the single catalog writer, while this wrapper preserves
-- activation only when the complete execution/billing binding is unchanged.
ALTER FUNCTION public.project_model_pool_configuration_atomic(jsonb)
  RENAME TO project_model_pool_configuration_atomic_before_llm_gate;

CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic(p_snapshot jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(
    id::text,
    jsonb_build_object(
      'active', is_active,
      'binding', jsonb_build_array(
        model_name,
        coalesce(api_endpoint, proxy_url, ''),
        md5(coalesce(api_key, '')),
        billing_mode,
        token_billing_enabled,
        input_cost_per_million,
        output_cost_per_million,
        cached_cost_per_million,
        profit_margin,
        max_context_rounds,
        max_context_tokens,
        max_reply_tokens,
        timeout,
        deep_thinking_type,
        enable_web_search,
        deduct_deep_think,
        frequency_limit,
        image_parsing,
        file_parsing
      )
    )
  ), '{}'::jsonb)
  INTO v_before
  FROM public.llm_models;

  PERFORM public.project_model_pool_configuration_atomic_before_llm_gate(p_snapshot);

  -- Fields used by the live text adapter must round-trip through the immutable
  -- snapshot. Missing legacy fields preserve their current value.
  UPDATE public.llm_models target
     SET enable_web_search = coalesce((model #>> '{capabilities,webSearch}')::boolean, target.enable_web_search, false),
         deep_thinking_type = coalesce(nullif(model #>> '{capabilities,deepThinkingType}', '')::integer, target.deep_thinking_type, 0),
         image_parsing = coalesce(nullif(model #>> '{capabilities,imageParsing}', ''), target.image_parsing, 'none'),
         file_parsing = coalesce(nullif(model #>> '{capabilities,fileParsing}', ''), target.file_parsing, 'none'),
         deduct_deep_think = coalesce(nullif(model #>> '{configuration,deductDeepThink}', '')::integer, target.deduct_deep_think, 1),
         frequency_limit = coalesce(nullif(model #>> '{configuration,frequencyLimit}', '')::integer, target.frequency_limit, 50)
    FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
     AND target.id::text = model #>> '{configuration,legacyId}';

  UPDATE public.llm_models target
     SET is_active = (
       target.is_hidden = false
       AND coalesce((v_before -> target.id::text ->> 'active')::boolean, false)
       AND (v_before -> target.id::text -> 'binding') IS NOT DISTINCT FROM jsonb_build_array(
         target.model_name,
         coalesce(target.api_endpoint, target.proxy_url, ''),
         md5(coalesce(target.api_key, '')),
         target.billing_mode,
         target.token_billing_enabled,
         target.input_cost_per_million,
         target.output_cost_per_million,
         target.cached_cost_per_million,
         target.profit_margin,
         target.max_context_rounds,
         target.max_context_tokens,
         target.max_reply_tokens,
         target.timeout,
         target.deep_thinking_type,
         target.enable_web_search,
         target.deduct_deep_think,
         target.frequency_limit,
         target.image_parsing,
         target.file_parsing
       )
     );
END;
$$;

REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb)
  TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN
    GRANT SELECT, INSERT, UPDATE ON public.llm_model_validation_evidence TO zimeiti_owner;
    GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) TO zimeiti_owner;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
