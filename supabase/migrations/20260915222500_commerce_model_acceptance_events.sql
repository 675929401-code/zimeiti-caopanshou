-- Commerce model acceptance is an append-only event stream. A later
-- invalidation must be able to supersede an earlier pass without mutating or
-- deleting the original audit record, and a new canary may pass again later.

ALTER TABLE public.commerce_model_acceptance_evidence
  DROP CONSTRAINT IF EXISTS commerce_model_acceptance_evidence_model_kind_model_id_model_config_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS commerce_model_acceptance_job_status_unique
  ON public.commerce_model_acceptance_evidence(canary_job_id, status);

CREATE OR REPLACE FUNCTION public.reject_commerce_model_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  RAISE EXCEPTION 'COMMERCE_MODEL_EVIDENCE_IMMUTABLE';
END;
$$;

COMMENT ON TABLE public.commerce_model_acceptance_evidence IS
  'Append-only, configuration-hash-bound canary events. The latest event per model hash is authoritative; invalidated supersedes passed without deleting history.';
