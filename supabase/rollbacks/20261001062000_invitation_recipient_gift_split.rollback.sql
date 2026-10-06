BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.invitation_reward_grants
    WHERE reward_stage = 'invitee_welcome'
      AND (status <> 'pending' OR credits <> 0 OR cash_amount <> 0
           OR drafted_at IS NOT NULL OR sent_at IS NOT NULL OR notification_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'INVITEE_WELCOME_ROLLBACK_BLOCKED_BUSINESS_RECEIPTS_EXIST';
  END IF;
END;
$$;

DELETE FROM public.invitation_reward_grants WHERE reward_stage = 'invitee_welcome';

ALTER TABLE public.invitation_reward_grants
  DROP CONSTRAINT IF EXISTS invitation_reward_grants_reward_stage_check;
ALTER TABLE public.invitation_reward_grants
  ADD CONSTRAINT invitation_reward_grants_reward_stage_check
  CHECK (reward_stage IN ('registration', 'activation'));

CREATE OR REPLACE FUNCTION public.seed_invitation_reward_grants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.invitation_reward_grants (
    invitation_record_id, reward_stage, recipient_user_id, eligibility_at
  ) VALUES
    (NEW.id, 'registration', NEW.inviter_id, NEW.invited_at),
    (NEW.id, 'activation', NEW.inviter_id, CASE WHEN NEW.invitee_activated THEN coalesce(NEW.activated_at, now()) ELSE NULL END)
  ON CONFLICT (invitation_record_id, reward_stage) DO NOTHING;
  RETURN NEW;
END;
$$;

UPDATE public.invitation_records AS relation
SET reward_sent = NOT EXISTS (
  SELECT 1 FROM public.invitation_reward_grants AS grant_row
  WHERE grant_row.invitation_record_id = relation.id
    AND grant_row.eligibility_at IS NOT NULL
    AND grant_row.status NOT IN ('sent', 'skipped')
);

COMMENT ON TABLE public.invitation_reward_grants
  IS 'Manual, stage-specific inviter rewards. Registration and paid activation are separate decisions.';

NOTIFY pgrst, 'reload schema';
COMMIT;
