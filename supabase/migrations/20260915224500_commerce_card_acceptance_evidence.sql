-- Card releases require append-only evidence from an exact draft card version,
-- an actual provider job, persisted output and a complete quality scorecard.

CREATE TABLE IF NOT EXISTS public.commerce_card_acceptance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_version_id uuid NOT NULL REFERENCES public.commerce_card_versions(id) ON DELETE RESTRICT,
  card_contract_hash text NOT NULL CHECK (card_contract_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('passed','invalidated')),
  canary_job_id text NOT NULL CHECK (length(canary_job_id) BETWEEN 1 AND 200),
  quote_id text NOT NULL CHECK (length(quote_id) BETWEEN 1 AND 200),
  model_kind text NOT NULL CHECK (model_kind IN ('agent','image','video')),
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  model_config_hash text NOT NULL CHECK (model_config_hash ~ '^[a-f0-9]{64}$'),
  evidence_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_asset_ids) = 'array'),
  scorecard jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scorecard) = 'object'),
  overall_score numeric(6,2) NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  hard_errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hard_errors) = 'array'),
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_summary) = 'object'),
  provider_cost numeric(18,8) NOT NULL DEFAULT 0 CHECK (provider_cost >= 0),
  verified_by uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_card_acceptance_job_status_unique
  ON public.commerce_card_acceptance_evidence(canary_job_id, status);
CREATE INDEX IF NOT EXISTS commerce_card_acceptance_current_idx
  ON public.commerce_card_acceptance_evidence(card_version_id, card_contract_hash, verified_at DESC, created_at DESC);

ALTER TABLE public.commerce_card_acceptance_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_card_acceptance_evidence FROM anon, authenticated;
GRANT SELECT, INSERT ON public.commerce_card_acceptance_evidence TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN
    GRANT SELECT, INSERT ON public.commerce_card_acceptance_evidence TO zimeiti_owner;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_commerce_card_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  RAISE EXCEPTION 'COMMERCE_CARD_EVIDENCE_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS commerce_card_evidence_immutable ON public.commerce_card_acceptance_evidence;
CREATE TRIGGER commerce_card_evidence_immutable
  BEFORE UPDATE OR DELETE ON public.commerce_card_acceptance_evidence
  FOR EACH ROW EXECUTE FUNCTION public.reject_commerce_card_evidence_mutation();

COMMENT ON TABLE public.commerce_card_acceptance_evidence IS
  'Append-only evidence for an exact card contract hash, actual provider job, persisted output and server-validated quality scorecard.';
