BEGIN;

DROP TRIGGER IF EXISTS zz_invitation_records_auto_welcome_package ON public.invitation_records;
DROP FUNCTION IF EXISTS public.maybe_assign_invited_registration_welcome_package();
DROP FUNCTION IF EXISTS public.set_invited_registration_package_automation_atomic(text,boolean,text);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.member_package_automation_runs
    WHERE status = 'sent' OR package_assignment_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: automatic package receipts already exist';
  END IF;
END;
$$;

DROP TABLE IF EXISTS public.member_package_automation_runs;
DROP TABLE IF EXISTS public.member_package_automation_events;
DROP TABLE IF EXISTS public.member_package_automation_settings;

NOTIFY pgrst, 'reload schema';
COMMIT;
