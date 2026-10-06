BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- A membership activation card is an immutable package delivery snapshot.
-- Template updates may create a new version, but must never widen or shrink a
-- card that was already generated.
ALTER TABLE public.cami_codes
  ADD COLUMN IF NOT EXISTS profile_key text,
  ADD COLUMN IF NOT EXISTS profile_version integer,
  ADD COLUMN IF NOT EXISTS feature_navigation_keys jsonb,
  ADD COLUMN IF NOT EXISTS created_by character varying(36),
  ADD COLUMN IF NOT EXISTS redemption_notification_id uuid,
  ADD COLUMN IF NOT EXISTS package_assignment_id uuid;

ALTER TABLE public.cami_codes
  DROP CONSTRAINT IF EXISTS cami_codes_profile_pair_check;
ALTER TABLE public.cami_codes
  ADD CONSTRAINT cami_codes_profile_pair_check
  CHECK ((profile_key IS NULL AND profile_version IS NULL) OR (profile_key IS NOT NULL AND profile_version > 0));

ALTER TABLE public.cami_codes
  DROP CONSTRAINT IF EXISTS cami_codes_feature_navigation_keys_check;
ALTER TABLE public.cami_codes
  ADD CONSTRAINT cami_codes_feature_navigation_keys_check
  CHECK (feature_navigation_keys IS NULL OR jsonb_typeof(feature_navigation_keys) = 'array');

ALTER TABLE public.cami_codes
  DROP CONSTRAINT IF EXISTS cami_codes_profile_fk;
ALTER TABLE public.cami_codes
  ADD CONSTRAINT cami_codes_profile_fk
  FOREIGN KEY (profile_key, profile_version)
  REFERENCES public.member_permission_profiles(profile_key, version);

ALTER TABLE public.cami_codes
  DROP CONSTRAINT IF EXISTS cami_codes_created_by_fk;
ALTER TABLE public.cami_codes
  ADD CONSTRAINT cami_codes_created_by_fk
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.cami_codes
  DROP CONSTRAINT IF EXISTS cami_codes_package_assignment_fk;
ALTER TABLE public.cami_codes
  ADD CONSTRAINT cami_codes_package_assignment_fk
  FOREIGN KEY (package_assignment_id) REFERENCES public.member_package_assignments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cami_codes_profile_created_idx
  ON public.cami_codes(profile_key, profile_version, created_at DESC)
  WHERE profile_key IS NOT NULL;

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
  v_current_package public.member_package_assignments%ROWTYPE;
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

  PERFORM pg_advisory_xact_lock(hashtextextended('cami-assignment-user:' || p_user_id, 1102026));
  PERFORM pg_advisory_xact_lock(hashtextextended(v_admin_uuid::text || ':' || v_key, 9302026));

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.role = 'admin' OR NOT coalesce(v_user.is_active, true)
     OR coalesce(v_user.status, 'active') <> 'active' THEN
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
      'assigned_to', v_card.assigned_to, 'notification_id', v_card.delivery_notification_id,
      'profile_key', v_card.profile_key, 'profile_version', v_card.profile_version
    );
  END IF;
  IF v_card.profile_key IS NULL OR v_card.profile_version IS NULL
     OR v_card.feature_navigation_keys IS NULL
     OR jsonb_typeof(v_card.feature_navigation_keys) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_PROFILE_SNAPSHOT_REQUIRED');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cami_codes
    WHERE assigned_to = v_user_uuid AND NOT coalesce(is_used, false) AND id <> v_card.id
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_PENDING_EXISTS');
  END IF;

  SELECT * INTO v_current_package
  FROM public.member_package_assignments
  WHERE user_id = p_user_id AND membership_status = 'active'
  ORDER BY created_at DESC
  LIMIT 1;
  IF coalesce(v_user.member_status, 'inactive') = 'active'
     AND coalesce(v_card.duration_days, 0) = 0
     AND v_current_package.profile_key IS NOT DISTINCT FROM v_card.profile_key
     AND v_current_package.profile_version IS NOT DISTINCT FROM v_card.profile_version THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMI_ASSIGNMENT_PACKAGE_ALREADY_ACTIVE');
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
    '会员激活卡已送达',
    format('管理员已把“%s”激活卡绑定到你的账号。无需复制卡密或联系客服，请前往个人中心一键兑换；兑换成功后，会员状态、套餐权限以及 %s 积分、¥%s 现金将一次生效。邀请奖励仍由管理员另行确认。',
      coalesce(nullif(v_card.plan_name, ''), '会员套餐'),
      trim(to_char(coalesce(v_card.credits, 0), 'FM999999999999990.######')),
      trim(to_char(coalesce(v_card.cash_balance, 0), 'FM999999999999990.00'))
    ),
    v_card.code,
    jsonb_build_object(
      'dedupe_key', 'cami-assignment:' || v_card.id::text,
      'source', 'cami_management',
      'card_id', v_card.id,
      'profile_key', v_card.profile_key,
      'profile_version', v_card.profile_version,
      'assigned_by', v_admin_uuid,
      'redemption_path', '/profile?tab=notifications'
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
    'notification_id', v_delivery ->> 'notification_id',
    'profile_key', v_card.profile_key,
    'profile_version', v_card.profile_version
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
  v_profile public.member_permission_profiles%ROWTYPE;
  v_current_package public.member_package_assignments%ROWTYPE;
  v_cash jsonb;
  v_credit jsonb;
  v_permission jsonb;
  v_activation jsonb;
  v_delivery jsonb;
  v_merged_categories jsonb;
  v_record_id character varying(36);
  v_assignment_id uuid := gen_random_uuid();
  v_current_revision integer := 0;
  v_actor_id text;
  v_new_expiry timestamptz;
  v_amount_copy text;
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

  PERFORM pg_advisory_xact_lock(hashtextextended('cami-redemption-user:' || p_user_id, 1102026));
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
        'allowed_categories', coalesce(v_card.allowed_categories, '[]'::jsonb),
        'feature_navigation_keys', coalesce(v_card.feature_navigation_keys, '[]'::jsonb),
        'profile_key', v_card.profile_key, 'profile_version', v_card.profile_version,
        'package_assignment_id', v_card.package_assignment_id
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

  -- New cards apply the exact generated package snapshot. Historical cards
  -- keep the former compatibility path below.
  IF v_card.profile_key IS NOT NULL THEN
    IF v_card.profile_version IS NULL OR v_card.feature_navigation_keys IS NULL
       OR jsonb_typeof(v_card.feature_navigation_keys) <> 'array'
       OR jsonb_typeof(coalesce(v_card.allowed_categories, '[]'::jsonb)) <> 'array' THEN
      RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_PROFILE_SNAPSHOT_INVALID');
    END IF;
    SELECT * INTO v_profile
    FROM public.member_permission_profiles
    WHERE profile_key = v_card.profile_key AND version = v_card.profile_version;
    IF NOT FOUND OR v_profile.membership_status <> 'active'
       OR v_profile.name <> v_card.plan_name
       OR coalesce(v_profile.duration_days, 0) <> coalesce(v_card.duration_days, 0)
       OR v_profile.credits <> round(coalesce(v_card.credits, 0), 6)
       OR v_profile.cash_amount <> round(coalesce(v_card.cash_balance, 0), 2)
       OR public.normalize_member_feature_keys(v_profile.feature_navigation_keys)
          <> public.normalize_member_feature_keys(v_card.feature_navigation_keys)
       OR public.normalize_member_agent_keys(v_profile.agent_navigation_keys)
          <> public.normalize_member_agent_keys(coalesce(v_card.allowed_categories, '[]'::jsonb)) THEN
      RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_PROFILE_SNAPSHOT_MISMATCH');
    END IF;

    SELECT * INTO v_current_package
    FROM public.member_package_assignments
    WHERE user_id = p_user_id AND membership_status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;
    IF coalesce(v_user.member_status, 'inactive') = 'active'
       AND coalesce(v_card.duration_days, 0) = 0
       AND v_current_package.profile_key IS NOT DISTINCT FROM v_card.profile_key
       AND v_current_package.profile_version IS NOT DISTINCT FROM v_card.profile_version THEN
      RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_PACKAGE_ALREADY_ACTIVE');
    END IF;

    v_actor_id := coalesce(v_card.assigned_by::text, v_card.created_by);
    IF v_actor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.users
      WHERE id = v_actor_id AND role = 'admin' AND coalesce(is_active, true)
        AND coalesce(status, 'active') = 'active'
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'CAMI_REDEEM_ACTOR_INVALID');
    END IF;

    SELECT revision INTO v_current_revision
    FROM public.member_permission_assignments
    WHERE user_id = p_user_id;
    v_current_revision := coalesce(v_current_revision, 0);
    v_permission := public.set_member_permissions_atomic(
      v_actor_id,
      p_user_id,
      public.normalize_member_feature_keys(v_card.feature_navigation_keys),
      public.normalize_member_agent_keys(coalesce(v_card.allowed_categories, '[]'::jsonb)),
      v_current_revision,
      'cami-permission:' || v_card.id::text,
      '兑换会员激活卡：' || coalesce(v_card.plan_name, '会员套餐'),
      NULL,
      NULL
    );
    IF coalesce((v_permission ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'CAMI_REDEEM_PERMISSION_FAILED:%', coalesce(v_permission ->> 'code', 'UNKNOWN');
    END IF;

    v_activation := public.set_member_activation_state_atomic(
      v_actor_id,
      p_user_id,
      'active',
      'cami',
      v_card.id::text,
      NULL,
      '兑换会员激活卡：' || coalesce(v_card.plan_name, '会员套餐'),
      'cami-activation:' || v_card.id::text
    );
    IF coalesce((v_activation ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'CAMI_REDEEM_ACTIVATION_FAILED:%', coalesce(v_activation ->> 'code', 'UNKNOWN');
    END IF;
    v_record_id := nullif(v_activation ->> 'invitation_record_id', '');

    IF coalesce(v_card.duration_days, 0) = 0 THEN
      v_new_expiry := NULL;
    ELSE
      v_new_expiry := greatest(coalesce(v_user.member_expires_at, v_now), v_now)
        + make_interval(days => v_card.duration_days);
    END IF;
    UPDATE public.users
    SET member_expires_at = v_new_expiry, updated_at = v_now
    WHERE id = p_user_id;

    IF coalesce(v_card.cash_balance, 0) > 0 THEN
      v_cash := public.apply_wallet_operation_atomic(
        p_user_id, 'cash_topup', 'cami:' || v_card.id::text || ':cash',
        v_card.cash_balance, '激活卡「' || coalesce(v_card.plan_name, '会员套餐') || '」现金权益',
        jsonb_build_object('source', 'cami_redeem', 'card_id', v_card.id, 'profile_key', v_card.profile_key, 'profile_version', v_card.profile_version)
      );
      IF coalesce((v_cash ->> 'success')::boolean, false) IS NOT TRUE
         OR nullif(v_cash ->> 'operation_id', '') IS NULL THEN
        RAISE EXCEPTION 'CAMI_REDEEM_CASH_WALLET_FAILED';
      END IF;
    END IF;
    IF coalesce(v_card.credits, 0) > 0 THEN
      v_credit := public.apply_wallet_operation_atomic(
        p_user_id, 'credit_topup', 'cami:' || v_card.id::text || ':credits',
        v_card.credits, '激活卡「' || coalesce(v_card.plan_name, '会员套餐') || '」积分权益',
        jsonb_build_object('source', 'cami_redeem', 'card_id', v_card.id, 'profile_key', v_card.profile_key, 'profile_version', v_card.profile_version)
      );
      IF coalesce((v_credit ->> 'success')::boolean, false) IS NOT TRUE
         OR nullif(v_credit ->> 'operation_id', '') IS NULL THEN
        RAISE EXCEPTION 'CAMI_REDEEM_CREDIT_WALLET_FAILED';
      END IF;
    END IF;

    v_amount_copy := concat_ws('、',
      CASE WHEN coalesce(v_card.credits, 0) > 0 THEN trim(to_char(v_card.credits, 'FM999999999999990.######')) || ' 积分' END,
      CASE WHEN coalesce(v_card.cash_balance, 0) > 0 THEN '¥' || trim(to_char(v_card.cash_balance, 'FM999999999999990.00')) || ' 现金' END
    );
    v_delivery := public.enqueue_user_notification_once(
      p_user_id,
      'member_package',
      '「' || coalesce(v_card.plan_name, '会员套餐') || '」已激活',
      format('激活卡兑换成功。%s%s功能权限已经生效；如存在邀请关系，邀请人的正式会员奖励将由管理员另行决定。',
        CASE WHEN v_new_expiry IS NULL THEN '会员长期有效；' ELSE '会员有效期至 ' || to_char(v_new_expiry AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') || '；' END,
        CASE WHEN v_amount_copy <> '' THEN '同时到账：' || v_amount_copy || '；' ELSE '' END
      ),
      NULL,
      jsonb_build_object(
        'dedupe_key', 'cami-redemption:' || v_card.id::text,
        'source', 'cami_redeem',
        'card_id', v_card.id,
        'profile_key', v_card.profile_key,
        'profile_version', v_card.profile_version,
        'invitation_record_id', v_record_id
      )
    );
    IF coalesce((v_delivery ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'CAMI_REDEEM_NOTIFICATION_FAILED';
    END IF;

    INSERT INTO public.member_package_assignments (
      id, user_id, invitation_record_id, profile_key, profile_version,
      package_name, membership_status, duration_days, member_expires_at,
      credits, cash_amount, feature_navigation_keys, agent_navigation_keys,
      permission_revision, note, assigned_by, request_key,
      credit_operation_id, cash_operation_id, notification_id, created_at
    ) VALUES (
      v_assignment_id, p_user_id, v_record_id, v_card.profile_key, v_card.profile_version,
      coalesce(v_card.plan_name, '会员套餐'), 'active', coalesce(v_card.duration_days, 0), v_new_expiry,
      round(coalesce(v_card.credits, 0), 6), round(coalesce(v_card.cash_balance, 0), 2),
      public.normalize_member_feature_keys(v_card.feature_navigation_keys),
      public.normalize_member_agent_keys(coalesce(v_card.allowed_categories, '[]'::jsonb)),
      (v_permission ->> 'revision')::integer,
      '学员一键兑换管理员绑定的会员激活卡', v_actor_id,
      'cami-redemption:' || v_card.id::text,
      nullif(v_credit ->> 'operation_id', '')::bigint,
      nullif(v_cash ->> 'operation_id', '')::bigint,
      (v_delivery ->> 'notification_id')::uuid, v_now
    );

    UPDATE public.cami_codes
    SET is_used = true,
        used_by = v_user_uuid,
        used_at = v_now,
        assigned_to = coalesce(assigned_to, v_user_uuid),
        assigned_at = coalesce(assigned_at, v_now),
        redemption_request_key = v_key,
        redemption_notification_id = (v_delivery ->> 'notification_id')::uuid,
        package_assignment_id = v_assignment_id
    WHERE id = v_card.id;

    RETURN jsonb_build_object(
      'success', true, 'already_redeemed', false, 'card_id', v_card.id,
      'credits', coalesce(v_card.credits, 0), 'cash_balance', coalesce(v_card.cash_balance, 0),
      'duration_days', coalesce(v_card.duration_days, 0), 'plan_name', v_card.plan_name,
      'allowed_categories', public.normalize_member_agent_keys(coalesce(v_card.allowed_categories, '[]'::jsonb)),
      'feature_navigation_keys', public.normalize_member_feature_keys(v_card.feature_navigation_keys),
      'profile_key', v_card.profile_key, 'profile_version', v_card.profile_version,
      'member_expires_at', v_new_expiry, 'invitation_record_id', v_record_id,
      'package_assignment_id', v_assignment_id,
      'notification_id', v_delivery ->> 'notification_id',
      'cash_operation_id', v_cash ->> 'operation_id',
      'credit_operation_id', v_credit ->> 'operation_id'
    );
  END IF;

  -- Historical cards retain the previous behavior for backwards compatibility.
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
  SET member_status = 'active', member_expires_at = v_new_expiry,
      allowed_categories = v_merged_categories, updated_at = v_now
  WHERE id = p_user_id;

  UPDATE public.cami_codes
  SET is_used = true, used_by = v_user_uuid, used_at = v_now,
      assigned_to = coalesce(assigned_to, v_user_uuid),
      assigned_at = coalesce(assigned_at, v_now), redemption_request_key = v_key
  WHERE id = v_card.id;

  UPDATE public.invitation_records
  SET invitee_activated = true,
      activated_at = coalesce(activated_at, v_now),
      activation_method = 'cami', activation_reference = v_card.id::text,
      activation_note = '历史会员卡密兑换激活', reward_sent = false
  WHERE invitee_id = v_user_uuid
  RETURNING id INTO v_record_id;
  IF v_record_id IS NOT NULL THEN
    UPDATE public.invitation_reward_grants
    SET eligibility_at = coalesce(eligibility_at, v_now), updated_at = v_now
    WHERE invitation_record_id = v_record_id AND reward_stage = 'activation';
    UPDATE public.invitation_records AS record_row
    SET reward_sent = NOT EXISTS (
      SELECT 1 FROM public.invitation_reward_grants AS grant_row
      WHERE grant_row.invitation_record_id = record_row.id
        AND grant_row.eligibility_at IS NOT NULL
        AND grant_row.status NOT IN ('sent', 'skipped')
    )
    WHERE record_row.id = v_record_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_redeemed', false, 'legacy_card', true,
    'card_id', v_card.id, 'credits', coalesce(v_card.credits, 0),
    'cash_balance', coalesce(v_card.cash_balance, 0),
    'duration_days', coalesce(v_card.duration_days, 0), 'plan_name', v_card.plan_name,
    'allowed_categories', coalesce(v_card.allowed_categories, '[]'::jsonb),
    'feature_navigation_keys', '[]'::jsonb,
    'member_expires_at', v_new_expiry, 'invitation_record_id', v_record_id,
    'cash_operation_id', v_cash ->> 'operation_id',
    'credit_operation_id', v_credit ->> 'operation_id'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_cami_membership_atomic(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_cami_membership_atomic(text,text,text) TO service_role;

COMMENT ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text)
  IS 'Binds one immutable package activation card to one learner, blocks duplicate pending cards and sends exactly one account notification.';
COMMENT ON FUNCTION public.redeem_cami_membership_atomic(text,text,text)
  IS 'Atomically redeems an immutable package snapshot, activates membership, applies permissions and wallet benefits, records the package receipt and unlocks but never auto-pays invitation rewards.';

NOTIFY pgrst, 'reload schema';
COMMIT;
