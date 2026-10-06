BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Restore the immediately preceding card assignment contract before removing
-- the immutable profile snapshot columns. This rollback is self-contained and
-- does not depend on psql include directives.
CREATE OR REPLACE FUNCTION public.assign_cami_to_user_atomic(
  p_admin_id text,
  p_cami_id text,
  p_user_id text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_uuid uuid;
  v_user_uuid uuid;
  v_cami_uuid uuid;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_card public.cami_codes%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_delivery jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  BEGIN
    v_admin_uuid := p_admin_id::uuid;
    v_user_uuid := p_user_id::uuid;
    v_cami_uuid := p_cami_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_ID_INVALID');
  END;
  IF v_key = '' OR length(v_key) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_KEY_INVALID');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_ADMIN_INVALID');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_admin_uuid::text || ':' || v_key, 9302026));
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND OR v_user.role = 'admin' THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_USER_INVALID');
  END IF;
  SELECT * INTO v_card FROM public.cami_codes WHERE id = v_cami_uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_CARD_NOT_FOUND');
  END IF;
  IF coalesce(v_card.is_used, false) THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_CARD_USED');
  END IF;
  IF v_card.expires_at IS NOT NULL AND v_card.expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_CARD_EXPIRED');
  END IF;
  IF v_card.assigned_to IS NOT NULL AND v_card.assigned_to <> v_user_uuid THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_ALREADY_BOUND');
  END IF;
  IF v_card.assigned_by = v_admin_uuid AND v_card.assignment_request_key = v_key
     AND v_card.delivery_notification_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'already_assigned', true, 'card_id', v_card.id,
      'assigned_to', v_card.assigned_to, 'notification_id', v_card.delivery_notification_id
    );
  END IF;

  UPDATE public.cami_codes
  SET assigned_to = v_user_uuid,
      assigned_at = coalesce(assigned_at, v_now),
      assigned_by = v_admin_uuid,
      assignment_request_key = coalesce(assignment_request_key, v_key)
  WHERE id = v_card.id;

  v_delivery := public.enqueue_user_notification_once(
    p_user_id,
    'membership_card',
    '会员卡密待兑换',
    format('管理员已为你发放“%s”。请在个人中心确认并兑换，兑换后才会激活会员；本卡不自动发放邀请礼包。', coalesce(nullif(v_card.plan_name, ''), '会员卡')),
    v_card.code,
    jsonb_build_object(
      'dedupe_key', 'cami-assignment:' || v_card.id::text,
      'source', 'cami_management',
      'card_id', v_card.id,
      'assigned_by', v_admin_uuid
    )
  );
  IF coalesce((v_delivery ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'CAMI_ASSIGNMENT_NOTIFICATION_FAILED';
  END IF;

  UPDATE public.cami_codes
  SET delivery_notification_id = (v_delivery ->> 'notification_id')::uuid
  WHERE id = v_card.id;

  RETURN jsonb_build_object(
    'success', true,
    'already_assigned', coalesce((v_delivery ->> 'already_existed')::boolean, false),
    'card_id', v_card.id,
    'assigned_to', v_user_uuid,
    'notification_id', v_delivery ->> 'notification_id'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_cami_membership_atomic(
  p_user_id text,
  p_code text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_uuid uuid;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_code_normalized text := regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  v_card public.cami_codes%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_cash jsonb;
  v_credit jsonb;
  v_merged_categories jsonb;
  v_record_id character varying(36);
  v_new_expiry timestamptz;
  v_now timestamptz := clock_timestamp();
BEGIN
  BEGIN
    v_user_uuid := p_user_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_USER_INVALID');
  END;
  IF v_key = '' OR length(v_key) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_KEY_INVALID');
  END IF;
  IF length(v_code_normalized) < 6 THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_CODE_INVALID');
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.role = 'admin' OR NOT coalesce(v_user.is_active, true)
     OR coalesce(v_user.status, 'active') <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_USER_INVALID');
  END IF;
  SELECT * INTO v_card
  FROM public.cami_codes
  WHERE regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = v_code_normalized
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_CARD_NOT_FOUND');
  END IF;
  IF coalesce(v_card.is_used, false) THEN
    IF v_card.used_by = v_user_uuid THEN
      RETURN jsonb_build_object(
        'success', true, 'already_redeemed', true, 'card_id', v_card.id,
        'credits', coalesce(v_card.credits, 0), 'cash_balance', coalesce(v_card.cash_balance, 0),
        'duration_days', coalesce(v_card.duration_days, 0), 'plan_name', v_card.plan_name,
        'allowed_categories', coalesce(v_card.allowed_categories, '[]'::jsonb)
      );
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_CARD_USED');
  END IF;
  IF v_card.assigned_to IS NOT NULL AND v_card.assigned_to <> v_user_uuid THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_NOT_ASSIGNED_TO_USER');
  END IF;
  IF v_card.expires_at IS NOT NULL AND v_card.expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_CARD_EXPIRED');
  END IF;
  IF coalesce(v_card.duration_days, 0) < 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_DURATION_INVALID');
  END IF;

  IF coalesce(v_card.cash_balance, 0) > 0 THEN
    v_cash := public.apply_wallet_operation_atomic(
      p_user_id, 'cash_topup', 'cami:' || v_card.id::text || ':cash',
      v_card.cash_balance, '历史卡密现金权益',
      jsonb_build_object('source', 'cami_redeem', 'card_id', v_card.id)
    );
    IF coalesce((v_cash ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_cash ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'CAMI_REDEEM_CASH_WALLET_FAILED';
    END IF;
  END IF;
  IF coalesce(v_card.credits, 0) > 0 THEN
    v_credit := public.apply_wallet_operation_atomic(
      p_user_id, 'credit_topup', 'cami:' || v_card.id::text || ':credits',
      v_card.credits, '历史卡密积分权益',
      jsonb_build_object('source', 'cami_redeem', 'card_id', v_card.id)
    );
    IF coalesce((v_credit ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_credit ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'CAMI_REDEEM_CREDIT_WALLET_FAILED';
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(value ORDER BY value), '[]'::jsonb)
  INTO v_merged_categories
  FROM (
    SELECT DISTINCT value
    FROM (
      SELECT jsonb_array_elements_text(coalesce(v_user.allowed_categories, '[]'::jsonb)) AS value
      UNION ALL
      SELECT jsonb_array_elements_text(coalesce(v_card.allowed_categories, '[]'::jsonb)) AS value
    ) AS category_values
  ) AS unique_categories;

  IF coalesce(v_card.duration_days, 0) = 0 THEN
    v_new_expiry := NULL;
  ELSE
    v_new_expiry := greatest(coalesce(v_user.member_expires_at, v_now), v_now)
      + make_interval(days => v_card.duration_days);
  END IF;
  UPDATE public.users
  SET member_status = 'active',
      member_expires_at = v_new_expiry,
      allowed_categories = v_merged_categories,
      updated_at = v_now
  WHERE id = p_user_id;

  UPDATE public.cami_codes
  SET is_used = true,
      used_by = v_user_uuid,
      used_at = v_now,
      assigned_to = coalesce(assigned_to, v_user_uuid),
      assigned_at = coalesce(assigned_at, v_now),
      redemption_request_key = v_key
  WHERE id = v_card.id;

  UPDATE public.invitation_records
  SET invitee_activated = true,
      activated_at = coalesce(activated_at, v_now),
      activation_method = 'cami',
      activation_reference = v_card.id::text,
      activation_note = '会员卡密兑换激活',
      reward_sent = false
  WHERE invitee_id = v_user_uuid
  RETURNING id INTO v_record_id;
  IF v_record_id IS NOT NULL THEN
    UPDATE public.invitation_reward_grants
    SET eligibility_at = coalesce(eligibility_at, v_now), updated_at = v_now
    WHERE invitation_record_id = v_record_id AND reward_stage = 'activation';
    UPDATE public.invitation_records AS record
    SET reward_sent = NOT EXISTS (
      SELECT 1 FROM public.invitation_reward_grants AS grant_row
      WHERE grant_row.invitation_record_id = record.id
        AND grant_row.eligibility_at IS NOT NULL
        AND grant_row.status NOT IN ('sent', 'skipped')
    )
    WHERE record.id = v_record_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_redeemed', false, 'card_id', v_card.id,
    'credits', coalesce(v_card.credits, 0), 'cash_balance', coalesce(v_card.cash_balance, 0),
    'duration_days', coalesce(v_card.duration_days, 0), 'plan_name', v_card.plan_name,
    'allowed_categories', coalesce(v_card.allowed_categories, '[]'::jsonb),
    'member_expires_at', v_new_expiry, 'invitation_record_id', v_record_id,
    'cash_operation_id', v_cash ->> 'operation_id',
    'credit_operation_id', v_credit ->> 'operation_id'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_cami_membership_atomic(text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_cami_membership_atomic(text,text,text)
  TO service_role;

COMMENT ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text)
  IS 'Binds one unused membership card to one learner and delivers it exactly once.';
COMMENT ON FUNCTION public.redeem_cami_membership_atomic(text,text,text)
  IS 'Atomically redeems a membership card, activates membership and unlocks the activation reward decision without auto-paying it.';

DROP INDEX IF EXISTS public.cami_codes_profile_created_idx;
ALTER TABLE public.cami_codes
  DROP CONSTRAINT IF EXISTS cami_codes_package_assignment_fk,
  DROP CONSTRAINT IF EXISTS cami_codes_created_by_fk,
  DROP CONSTRAINT IF EXISTS cami_codes_profile_fk,
  DROP CONSTRAINT IF EXISTS cami_codes_feature_navigation_keys_check,
  DROP CONSTRAINT IF EXISTS cami_codes_profile_pair_check,
  DROP COLUMN IF EXISTS package_assignment_id,
  DROP COLUMN IF EXISTS redemption_notification_id,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS feature_navigation_keys,
  DROP COLUMN IF EXISTS profile_version,
  DROP COLUMN IF EXISTS profile_key;

NOTIFY pgrst, 'reload schema';
COMMIT;
