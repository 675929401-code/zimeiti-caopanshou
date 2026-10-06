-- PostgreSQL truncates automatically generated identifiers to 63 bytes. The
-- original unnamed UNIQUE constraint therefore has this shorter catalog name.
ALTER TABLE public.commerce_model_acceptance_evidence
  DROP CONSTRAINT IF EXISTS commerce_model_acceptance_evi_model_kind_model_id_model_con_key;
