BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.digital_human_long_jobs
  ADD COLUMN IF NOT EXISTS history_hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS digital_human_long_jobs_visible_history
  ON public.digital_human_long_jobs(user_id, created_at DESC, id DESC)
  WHERE history_hidden_at IS NULL;

CREATE OR REPLACE FUNCTION public.hide_digital_human_long_history_item(
  p_user_id text,
  p_parent_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent public.digital_human_long_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_parent
  FROM public.digital_human_long_jobs
  WHERE id = p_parent_id AND user_id::text = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_HISTORY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_parent.state NOT IN ('completed', 'failed', 'cancelled')
     OR v_parent.billing_state IN ('quote_locked', 'ready_to_settle') THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_HISTORY_PENDING' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.digital_human_long_jobs
  SET history_hidden_at = coalesce(history_hidden_at, clock_timestamp())
  WHERE id = p_parent_id AND user_id::text = p_user_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.hide_digital_human_long_history_item(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hide_digital_human_long_history_item(text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
