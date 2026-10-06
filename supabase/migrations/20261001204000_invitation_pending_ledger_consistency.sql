BEGIN;

-- A package assignment is the durable receipt for the newcomer package stage.
-- Keep the invitation reward node in sync regardless of whether the assignment
-- came from the admin dialog, registration automation, or card redemption.
CREATE OR REPLACE FUNCTION public.sync_invitation_welcome_reward_from_package_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.invitation_record_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.invitation_reward_grants
  SET status = 'sent',
      eligibility_at = coalesce(eligibility_at, NEW.created_at),
      credits = NEW.credits,
      cash_amount = NEW.cash_amount,
      note = NEW.note,
      drafted_at = coalesce(drafted_at, NEW.created_at),
      sent_at = coalesce(sent_at, NEW.created_at),
      send_request_key = coalesce(nullif(send_request_key, ''), NEW.request_key),
      credit_operation_id = NEW.credit_operation_id,
      cash_operation_id = NEW.cash_operation_id,
      notification_id = NEW.notification_id,
      package_assignment_id = NEW.id,
      updated_at = now()
  WHERE invitation_record_id = NEW.invitation_record_id
    AND reward_stage = 'invitee_welcome'
    AND (
      status <> 'sent'
      OR package_assignment_id IS DISTINCT FROM NEW.id
    );

  UPDATE public.invitation_records AS relation
  SET reward_sent = NOT EXISTS (
    SELECT 1
    FROM public.invitation_reward_grants AS grant_row
    WHERE grant_row.invitation_record_id = relation.id
      AND grant_row.eligibility_at IS NOT NULL
      AND grant_row.status NOT IN ('sent', 'skipped')
  )
  WHERE relation.id = NEW.invitation_record_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_package_assignments_sync_invitation_welcome
  ON public.member_package_assignments;
CREATE TRIGGER member_package_assignments_sync_invitation_welcome
AFTER INSERT ON public.member_package_assignments
FOR EACH ROW
EXECUTE FUNCTION public.sync_invitation_welcome_reward_from_package_assignment();

-- Repair historical rows created by the card-redemption path before this
-- trigger existed. The latest assignment is the authoritative package receipt.
WITH latest_assignment AS (
  SELECT DISTINCT ON (assignment.invitation_record_id)
    assignment.*
  FROM public.member_package_assignments AS assignment
  WHERE assignment.invitation_record_id IS NOT NULL
  ORDER BY assignment.invitation_record_id, assignment.created_at DESC, assignment.id DESC
)
UPDATE public.invitation_reward_grants AS grant_row
SET status = 'sent',
    eligibility_at = coalesce(grant_row.eligibility_at, assignment.created_at),
    credits = assignment.credits,
    cash_amount = assignment.cash_amount,
    note = assignment.note,
    drafted_at = coalesce(grant_row.drafted_at, assignment.created_at),
    sent_at = coalesce(grant_row.sent_at, assignment.created_at),
    send_request_key = coalesce(nullif(grant_row.send_request_key, ''), assignment.request_key),
    credit_operation_id = assignment.credit_operation_id,
    cash_operation_id = assignment.cash_operation_id,
    notification_id = assignment.notification_id,
    package_assignment_id = assignment.id,
    updated_at = now()
FROM latest_assignment AS assignment
WHERE grant_row.invitation_record_id = assignment.invitation_record_id
  AND grant_row.reward_stage = 'invitee_welcome'
  AND (
    grant_row.status <> 'sent'
    OR grant_row.package_assignment_id IS DISTINCT FROM assignment.id
  );

UPDATE public.invitation_records AS relation
SET reward_sent = NOT EXISTS (
  SELECT 1
  FROM public.invitation_reward_grants AS grant_row
  WHERE grant_row.invitation_record_id = relation.id
    AND grant_row.eligibility_at IS NOT NULL
    AND grant_row.status NOT IN ('sent', 'skipped')
);

COMMENT ON FUNCTION public.sync_invitation_welcome_reward_from_package_assignment()
IS 'Keeps newcomer-package invitation status aligned with the durable package assignment receipt across admin, automation, and card-redemption paths.';

COMMIT;
