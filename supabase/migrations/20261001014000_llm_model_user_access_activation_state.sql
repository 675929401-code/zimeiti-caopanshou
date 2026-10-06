BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

-- The stable pre-activation state is intentionally descriptive and does not
-- fit the historical varchar(20) column. Widen only the LLM catalog field;
-- existing values, indexes and defaults remain unchanged.
ALTER TABLE public.llm_models
  ALTER COLUMN user_access TYPE character varying(32);

COMMENT ON COLUMN public.llm_models.user_access IS
  'Runtime visibility state: available, hidden, or pending_model_activation.';

COMMIT;
