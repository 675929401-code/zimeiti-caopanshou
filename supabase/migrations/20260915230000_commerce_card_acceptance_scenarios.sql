-- Distinguish standard generation, exact local revision and optional minimum-input
-- evidence. A director release requires both standard and revision evidence for
-- the exact immutable card contract hash.

ALTER TABLE public.commerce_card_acceptance_evidence
  ADD COLUMN IF NOT EXISTS scenario_kind text NOT NULL DEFAULT 'standard';

ALTER TABLE public.commerce_card_acceptance_evidence
  DROP CONSTRAINT IF EXISTS commerce_card_acceptance_evidence_scenario_kind_check;
ALTER TABLE public.commerce_card_acceptance_evidence
  ADD CONSTRAINT commerce_card_acceptance_evidence_scenario_kind_check
  CHECK (scenario_kind IN ('standard','revision','minimum'));

ALTER TABLE public.commerce_card_acceptance_evidence
  ADD COLUMN IF NOT EXISTS source_canary_job_id text;

ALTER TABLE public.commerce_card_acceptance_evidence
  DROP CONSTRAINT IF EXISTS commerce_card_acceptance_revision_source_check;
ALTER TABLE public.commerce_card_acceptance_evidence
  ADD CONSTRAINT commerce_card_acceptance_revision_source_check
  CHECK (
    (scenario_kind <> 'revision' AND source_canary_job_id IS NULL)
    OR
    (scenario_kind = 'revision'
      AND length(source_canary_job_id) BETWEEN 1 AND 200
      AND source_canary_job_id <> canary_job_id)
  );

DROP INDEX IF EXISTS public.commerce_card_acceptance_current_idx;
CREATE INDEX commerce_card_acceptance_current_idx
  ON public.commerce_card_acceptance_evidence(
    card_version_id,
    card_contract_hash,
    scenario_kind,
    verified_at DESC,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS commerce_card_acceptance_revision_source_idx
  ON public.commerce_card_acceptance_evidence(source_canary_job_id)
  WHERE scenario_kind = 'revision';

COMMENT ON COLUMN public.commerce_card_acceptance_evidence.scenario_kind IS
  'Acceptance scenario: standard generation, exact local revision, or optional minimum legal input.';
COMMENT ON COLUMN public.commerce_card_acceptance_evidence.source_canary_job_id IS
  'For revision evidence, the already passed standard canary job whose exact script was used as the immutable edit base.';
