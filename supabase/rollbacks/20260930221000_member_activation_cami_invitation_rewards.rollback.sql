BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.member_activation_events LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_MEMBER_ACTIVATION_EVENTS_EXIST';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invitation_reward_grants
    WHERE status <> 'pending' OR credits <> 0 OR cash_amount <> 0
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_INVITATION_REWARD_DECISIONS_EXIST';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cami_codes
    WHERE assigned_to IS NOT NULL OR delivery_notification_id IS NOT NULL
       OR redemption_request_key IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_CAMI_ASSIGNMENT_EVIDENCE_EXISTS';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.send_invitation_reward_atomic(text,text,text,text);
DROP FUNCTION IF EXISTS public.save_invitation_reward_decision_atomic(text,text,text,numeric,numeric,text,text);
DROP FUNCTION IF EXISTS public.redeem_cami_membership_atomic(text,text,text);
DROP FUNCTION IF EXISTS public.assign_cami_to_user_atomic(text,text,text,text);
DROP FUNCTION IF EXISTS public.set_member_activation_state_atomic(text,text,text,text,text,numeric,text,text);
DROP TRIGGER IF EXISTS invitation_records_seed_reward_grants ON public.invitation_records;
DROP FUNCTION IF EXISTS public.seed_invitation_reward_grants();
DROP TABLE IF EXISTS public.invitation_reward_grants;
DROP TABLE IF EXISTS public.member_activation_events;
DROP INDEX IF EXISTS public.invitation_reward_grants_send_request_unique;
DROP INDEX IF EXISTS public.cami_codes_redemption_request_unique;
DROP INDEX IF EXISTS public.cami_codes_assignment_request_unique;

ALTER TABLE public.cami_codes
  DROP COLUMN IF EXISTS redemption_request_key,
  DROP COLUMN IF EXISTS delivery_notification_id,
  DROP COLUMN IF EXISTS assignment_request_key,
  DROP COLUMN IF EXISTS assigned_by,
  DROP COLUMN IF EXISTS assigned_at,
  DROP COLUMN IF EXISTS assigned_to;

ALTER TABLE public.invitation_records
  DROP COLUMN IF EXISTS activated_by,
  DROP COLUMN IF EXISTS activation_note,
  DROP COLUMN IF EXISTS activation_fee,
  DROP COLUMN IF EXISTS activation_reference,
  DROP COLUMN IF EXISTS activation_method;

NOTIFY pgrst, 'reload schema';
COMMIT;
