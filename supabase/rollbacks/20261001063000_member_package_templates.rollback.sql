BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.member_package_assignments LIMIT 1) THEN
    RAISE EXCEPTION 'MEMBER_PACKAGE_ROLLBACK_BLOCKED_ASSIGNMENT_RECEIPTS_EXIST';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.assign_member_package_atomic(
  text,text,text,text,integer,text,text,integer,numeric,numeric,jsonb,jsonb,integer,text,text
);
DROP FUNCTION IF EXISTS public.create_member_package_profile_version_atomic(
  text,text,text,text,text,integer,numeric,numeric,jsonb,jsonb,text
);

ALTER TABLE public.invitation_reward_grants
  DROP COLUMN IF EXISTS package_assignment_id;
DROP TABLE IF EXISTS public.member_package_assignments;

DELETE FROM public.member_permission_profiles
WHERE profile_key IN ('trial_member', 'super_vip');

DROP INDEX IF EXISTS public.member_permission_profile_change_request_unique;
ALTER TABLE public.member_permission_profiles
  DROP CONSTRAINT IF EXISTS member_permission_profiles_membership_status_check,
  DROP CONSTRAINT IF EXISTS member_permission_profiles_duration_days_check,
  DROP CONSTRAINT IF EXISTS member_permission_profiles_benefit_amount_check,
  DROP COLUMN IF EXISTS membership_status,
  DROP COLUMN IF EXISTS duration_days,
  DROP COLUMN IF EXISTS credits,
  DROP COLUMN IF EXISTS cash_amount,
  DROP COLUMN IF EXISTS sort_order,
  DROP COLUMN IF EXISTS is_selectable,
  DROP COLUMN IF EXISTS change_request_key,
  DROP COLUMN IF EXISTS updated_at;

CREATE OR REPLACE FUNCTION public.normalize_member_feature_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(key ORDER BY ordinal), '[]'::jsonb)
  FROM unnest(ARRAY[
    'marketplace', 'toolbox', 'storyboard_workbench', 'image_workbench',
    'create', 'voice', 'cover', 'youcai', 'commerce_agent'
  ]::text[]) WITH ORDINALITY AS allowed(key, ordinal)
  WHERE CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? key ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.normalize_member_agent_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(key ORDER BY ordinal), '[]'::jsonb)
  FROM unnest(ARRAY[
    'bip:loop', 'task:影像编导', 'task:文案创作', 'task:获客转化', '自用'
  ]::text[]) WITH ORDINALITY AS allowed(key, ordinal)
  WHERE CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? key ELSE false END
$$;

DROP TABLE IF EXISTS public.member_permission_resources;

NOTIFY pgrst, 'reload schema';
COMMIT;
