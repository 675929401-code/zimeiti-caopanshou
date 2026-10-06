BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Membership activation, membership-card delivery and invitation rewards are
-- separate business facts.  Keep their durable state separate so none of the
-- three workflows can silently imply another one.
ALTER TABLE public.invitation_records
  ADD COLUMN IF NOT EXISTS activation_method text,
  ADD COLUMN IF NOT EXISTS activation_reference text,
  ADD COLUMN IF NOT EXISTS activation_fee numeric(12, 2),
  ADD COLUMN IF NOT EXISTS activation_note text,
  ADD COLUMN IF NOT EXISTS activated_by uuid;

ALTER TABLE public.cami_codes
  ADD COLUMN IF NOT EXISTS assigned_to uuid,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by uuid,
  ADD COLUMN IF NOT EXISTS assignment_request_key text,
  ADD COLUMN IF NOT EXISTS delivery_notification_id uuid,
  ADD COLUMN IF NOT EXISTS redemption_request_key text;

CREATE UNIQUE INDEX IF NOT EXISTS cami_codes_assignment_request_unique
  ON public.cami_codes (assigned_by, assignment_request_key)
  WHERE assigned_by IS NOT NULL AND nullif(btrim(assignment_request_key), '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cami_codes_redemption_request_unique
  ON public.cami_codes (used_by, redemption_request_key)
  WHERE used_by IS NOT NULL AND nullif(btrim(redemption_request_key), '') IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.member_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  user_id uuid NOT NULL,
  member_status text NOT NULL CHECK (member_status IN ('inactive', 'trial', 'active', 'expired')),
  activation_method text,
  activation_reference text,
  activation_fee numeric(12, 2),
  activation_note text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS member_activation_events_user_created_idx
  ON public.member_activation_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.invitation_reward_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_record_id character varying(36) NOT NULL
    REFERENCES public.invitation_records(id) ON DELETE CASCADE,
  reward_stage text NOT NULL CHECK (reward_stage IN ('registration', 'activation')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'draft', 'sent', 'skipped')),
  recipient_user_id uuid NOT NULL,
  eligibility_at timestamptz,
  credits numeric(20, 6) NOT NULL DEFAULT 0 CHECK (credits >= 0),
  cash_amount numeric(20, 2) NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  note text NOT NULL DEFAULT '',
  drafted_at timestamptz,
  drafted_by uuid,
  sent_at timestamptz,
  sent_by uuid,
  send_request_key text,
  credit_operation_id bigint,
  cash_operation_id bigint,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invitation_record_id, reward_stage)
);

CREATE INDEX IF NOT EXISTS invitation_reward_grants_recipient_status_idx
  ON public.invitation_reward_grants (recipient_user_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS invitation_reward_grants_send_request_unique
  ON public.invitation_reward_grants (sent_by, send_request_key)
  WHERE sent_by IS NOT NULL AND nullif(btrim(send_request_key), '') IS NOT NULL;

ALTER TABLE public.member_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_reward_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_activation_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.invitation_reward_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.member_activation_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.invitation_reward_grants TO service_role;

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

DROP TRIGGER IF EXISTS invitation_records_seed_reward_grants ON public.invitation_records;
CREATE TRIGGER invitation_records_seed_reward_grants
AFTER INSERT ON public.invitation_records
FOR EACH ROW EXECUTE FUNCTION public.seed_invitation_reward_grants();

INSERT INTO public.invitation_reward_grants (
  invitation_record_id, reward_stage, recipient_user_id, eligibility_at
)
SELECT id, 'registration', inviter_id, invited_at
FROM public.invitation_records
ON CONFLICT (invitation_record_id, reward_stage) DO NOTHING;

INSERT INTO public.invitation_reward_grants (
  invitation_record_id, reward_stage, recipient_user_id, eligibility_at
)
SELECT id, 'activation', inviter_id,
       CASE WHEN invitee_activated THEN coalesce(activated_at, now()) ELSE NULL END
FROM public.invitation_records
ON CONFLICT (invitation_record_id, reward_stage) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_member_activation_state_atomic(
  p_admin_id text,
  p_user_id text,
  p_member_status text,
  p_activation_method text,
  p_activation_reference text,
  p_activation_fee numeric,
  p_activation_note text,
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
  v_status text := lower(btrim(coalesce(p_member_status, '')));
  v_method text := nullif(lower(btrim(coalesce(p_activation_method, ''))), '');
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_existing public.member_activation_events%ROWTYPE;
  v_event_id uuid;
  v_user public.users%ROWTYPE;
  v_record_id character varying(36);
  v_now timestamptz := clock_timestamp();
BEGIN
  BEGIN
    v_admin_uuid := p_admin_id::uuid;
    v_user_uuid := p_user_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_ID_INVALID');
  END;
  IF v_status NOT IN ('inactive', 'trial', 'active', 'expired') THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_STATUS_INVALID');
  END IF;
  IF v_key = '' OR length(v_key) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_KEY_INVALID');
  END IF;
  IF p_activation_fee IS NOT NULL AND (p_activation_fee < 0 OR p_activation_fee > 100000000) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_FEE_INVALID');
  END IF;
  IF v_status = 'active' AND coalesce(v_method, '') NOT IN ('admin_manual', 'cami', 'legacy') THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_METHOD_REQUIRED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_ADMIN_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_admin_uuid::text || ':' || v_key, 9302026));

  SELECT * INTO v_existing
  FROM public.member_activation_events
  WHERE admin_id = v_admin_uuid AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.user_id <> v_user_uuid
       OR v_existing.member_status <> v_status
       OR v_existing.activation_method IS DISTINCT FROM v_method
       OR v_existing.activation_reference IS DISTINCT FROM nullif(btrim(coalesce(p_activation_reference, '')), '')
       OR v_existing.activation_fee IS DISTINCT FROM (CASE WHEN p_activation_fee IS NULL THEN NULL ELSE round(p_activation_fee, 2) END)
       OR v_existing.activation_note IS DISTINCT FROM left(coalesce(p_activation_note, ''), 2000) THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'already_applied', true, 'event_id', v_existing.id,
      'member_status', v_existing.member_status
    );
  END IF;

  SELECT * INTO v_user
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_USER_NOT_FOUND');
  END IF;
  IF v_user.role = 'admin' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_ACTIVATION_ADMIN_TARGET_FORBIDDEN');
  END IF;

  UPDATE public.users
  SET member_status = v_status,
      member_expires_at = CASE WHEN v_status = 'active' THEN NULL ELSE member_expires_at END,
      updated_at = v_now
  WHERE id = p_user_id;

  INSERT INTO public.member_activation_events (
    admin_id, user_id, member_status, activation_method, activation_reference,
    activation_fee, activation_note, idempotency_key, created_at
  ) VALUES (
    v_admin_uuid, v_user_uuid, v_status, v_method,
    nullif(btrim(coalesce(p_activation_reference, '')), ''),
    CASE WHEN p_activation_fee IS NULL THEN NULL ELSE round(p_activation_fee, 2) END,
    left(coalesce(p_activation_note, ''), 2000), v_key, v_now
  ) RETURNING id INTO v_event_id;

  IF v_status = 'active' THEN
    UPDATE public.invitation_records
    SET invitee_activated = true,
        activated_at = coalesce(activated_at, v_now),
        activation_method = v_method,
        activation_reference = nullif(btrim(coalesce(p_activation_reference, '')), ''),
        activation_fee = CASE WHEN p_activation_fee IS NULL THEN NULL ELSE round(p_activation_fee, 2) END,
        activation_note = left(coalesce(p_activation_note, ''), 2000),
        activated_by = v_admin_uuid,
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
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_applied', false, 'event_id', v_event_id,
    'member_status', v_status, 'invitation_record_id', v_record_id,
    'activation_method', v_method
  );
END;
$$;

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

CREATE OR REPLACE FUNCTION public.save_invitation_reward_decision_atomic(
  p_admin_id text,
  p_invitation_record_id text,
  p_reward_stage text,
  p_credits numeric,
  p_cash_amount numeric,
  p_note text,
  p_decision text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_uuid uuid;
  v_stage text := lower(btrim(coalesce(p_reward_stage, '')));
  v_decision text := lower(btrim(coalesce(p_decision, 'draft')));
  v_grant public.invitation_reward_grants%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  BEGIN v_admin_uuid := p_admin_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_ADMIN_ID_INVALID');
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_ADMIN_INVALID');
  END IF;
  IF v_stage NOT IN ('registration', 'activation') OR v_decision NOT IN ('draft', 'skip') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_DECISION_INVALID');
  END IF;
  IF coalesce(p_credits, 0) < 0 OR coalesce(p_cash_amount, 0) < 0
     OR coalesce(p_credits, 0) > 1000000000 OR coalesce(p_cash_amount, 0) > 100000000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_AMOUNT_INVALID');
  END IF;
  IF v_decision = 'draft' AND coalesce(p_credits, 0) = 0 AND coalesce(p_cash_amount, 0) = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_AMOUNT_REQUIRED');
  END IF;

  SELECT * INTO v_grant
  FROM public.invitation_reward_grants
  WHERE invitation_record_id = p_invitation_record_id AND reward_stage = v_stage
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_NOT_FOUND');
  END IF;
  IF v_grant.eligibility_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_NOT_ELIGIBLE');
  END IF;
  IF v_grant.status = 'sent' THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_ALREADY_SENT');
  END IF;

  UPDATE public.invitation_reward_grants
  SET status = CASE WHEN v_decision = 'skip' THEN 'skipped' ELSE 'draft' END,
      credits = CASE WHEN v_decision = 'skip' THEN 0 ELSE round(coalesce(p_credits, 0), 6) END,
      cash_amount = CASE WHEN v_decision = 'skip' THEN 0 ELSE round(coalesce(p_cash_amount, 0), 2) END,
      note = left(coalesce(p_note, ''), 2000),
      drafted_at = v_now,
      drafted_by = v_admin_uuid,
      updated_at = v_now
  WHERE id = v_grant.id
  RETURNING * INTO v_grant;

  UPDATE public.invitation_records AS record
  SET reward_sent = NOT EXISTS (
    SELECT 1 FROM public.invitation_reward_grants AS grant_row
    WHERE grant_row.invitation_record_id = record.id
      AND grant_row.eligibility_at IS NOT NULL
      AND grant_row.status NOT IN ('sent', 'skipped')
  )
  WHERE record.id = p_invitation_record_id;

  RETURN jsonb_build_object(
    'success', true, 'grant_id', v_grant.id, 'reward_stage', v_grant.reward_stage,
    'status', v_grant.status, 'credits', v_grant.credits,
    'cash_amount', v_grant.cash_amount, 'note', v_grant.note,
    'updated_at', v_grant.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.send_invitation_reward_atomic(
  p_admin_id text,
  p_invitation_record_id text,
  p_reward_stage text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_uuid uuid;
  v_stage text := lower(btrim(coalesce(p_reward_stage, '')));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_grant public.invitation_reward_grants%ROWTYPE;
  v_record public.invitation_records%ROWTYPE;
  v_credit jsonb;
  v_cash jsonb;
  v_delivery jsonb;
  v_description text;
  v_amount_copy text;
  v_now timestamptz := clock_timestamp();
BEGIN
  BEGIN v_admin_uuid := p_admin_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_ADMIN_ID_INVALID');
  END;
  IF v_stage NOT IN ('registration', 'activation') OR v_key = '' OR length(v_key) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_SEND_INPUT_INVALID');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_ADMIN_INVALID');
  END IF;

  SELECT * INTO v_record FROM public.invitation_records
  WHERE id = p_invitation_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_RECORD_NOT_FOUND');
  END IF;
  SELECT * INTO v_grant FROM public.invitation_reward_grants
  WHERE invitation_record_id = p_invitation_record_id AND reward_stage = v_stage
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_NOT_FOUND');
  END IF;
  IF v_grant.status = 'sent' THEN
    RETURN jsonb_build_object(
      'success', true, 'already_sent', true, 'grant_id', v_grant.id,
      'reward_stage', v_grant.reward_stage, 'credits', v_grant.credits,
      'cash_amount', v_grant.cash_amount, 'notification_id', v_grant.notification_id
    );
  END IF;
  IF v_grant.eligibility_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_NOT_ELIGIBLE');
  END IF;
  IF v_grant.status <> 'draft' OR (v_grant.credits <= 0 AND v_grant.cash_amount <= 0) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_DRAFT_REQUIRED');
  END IF;

  v_description := CASE WHEN v_stage = 'registration' THEN '邀请注册礼包' ELSE '邀请正式会员礼包' END;
  IF v_grant.credits > 0 THEN
    v_credit := public.apply_wallet_operation_atomic(
      v_grant.recipient_user_id::text, 'credit_topup',
      'invitation-reward:' || v_grant.id::text || ':credits', v_grant.credits,
      v_description || CASE WHEN v_grant.note <> '' THEN '：' || v_grant.note ELSE '' END,
      jsonb_build_object('source', 'invitation_reward', 'grant_id', v_grant.id, 'stage', v_stage)
    );
    IF coalesce((v_credit ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_credit ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'INVITATION_REWARD_CREDIT_WALLET_FAILED';
    END IF;
  END IF;
  IF v_grant.cash_amount > 0 THEN
    v_cash := public.apply_wallet_operation_atomic(
      v_grant.recipient_user_id::text, 'cash_topup',
      'invitation-reward:' || v_grant.id::text || ':cash', v_grant.cash_amount,
      v_description || CASE WHEN v_grant.note <> '' THEN '：' || v_grant.note ELSE '' END,
      jsonb_build_object('source', 'invitation_reward', 'grant_id', v_grant.id, 'stage', v_stage)
    );
    IF coalesce((v_cash ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_cash ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'INVITATION_REWARD_CASH_WALLET_FAILED';
    END IF;
  END IF;

  v_amount_copy := concat_ws('、',
    CASE WHEN v_grant.credits > 0 THEN trim(to_char(v_grant.credits, 'FM999999999999990.######')) || ' 积分' END,
    CASE WHEN v_grant.cash_amount > 0 THEN '¥' || trim(to_char(v_grant.cash_amount, 'FM999999999999990.00')) || ' 现金' END
  );
  v_delivery := public.enqueue_user_notification_once(
    v_grant.recipient_user_id::text,
    'invitation_reward',
    CASE WHEN v_stage = 'registration' THEN '邀请注册礼包已到账' ELSE '邀请正式会员礼包已到账' END,
    format('你邀请的学员%s，管理员已确认发放：%s。%s',
      CASE WHEN v_stage = 'registration' THEN '已成功注册' ELSE '已完成正式会员激活' END,
      v_amount_copy,
      CASE WHEN v_grant.note <> '' THEN E'\n说明：' || v_grant.note ELSE '' END
    ),
    NULL,
    jsonb_build_object(
      'dedupe_key', 'invitation-reward:' || v_grant.id::text,
      'source', 'invitation_reward',
      'grant_id', v_grant.id,
      'invitation_record_id', v_record.id,
      'reward_stage', v_stage,
      'invitee_id', v_record.invitee_id
    )
  );
  IF coalesce((v_delivery ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'INVITATION_REWARD_NOTIFICATION_FAILED';
  END IF;

  UPDATE public.invitation_reward_grants
  SET status = 'sent', sent_at = v_now, sent_by = v_admin_uuid,
      send_request_key = v_key,
      credit_operation_id = nullif(v_credit ->> 'operation_id', '')::bigint,
      cash_operation_id = nullif(v_cash ->> 'operation_id', '')::bigint,
      notification_id = (v_delivery ->> 'notification_id')::uuid,
      updated_at = v_now
  WHERE id = v_grant.id
  RETURNING * INTO v_grant;

  UPDATE public.invitation_records AS record
  SET reward_sent = NOT EXISTS (
    SELECT 1 FROM public.invitation_reward_grants AS grant_row
    WHERE grant_row.invitation_record_id = record.id
      AND grant_row.eligibility_at IS NOT NULL
      AND grant_row.status NOT IN ('sent', 'skipped')
  )
  WHERE record.id = v_record.id;

  RETURN jsonb_build_object(
    'success', true, 'already_sent', false, 'grant_id', v_grant.id,
    'reward_stage', v_grant.reward_stage, 'credits', v_grant.credits,
    'cash_amount', v_grant.cash_amount, 'notification_id', v_grant.notification_id,
    'credit_operation_id', v_grant.credit_operation_id,
    'cash_operation_id', v_grant.cash_operation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_activation_state_atomic(text,text,text,text,text,numeric,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_cami_membership_atomic(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_invitation_reward_decision_atomic(text,text,text,numeric,numeric,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_invitation_reward_atomic(text,text,text,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_member_activation_state_atomic(text,text,text,text,text,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_cami_membership_atomic(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_invitation_reward_decision_atomic(text,text,text,numeric,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.send_invitation_reward_atomic(text,text,text,text) TO service_role;

COMMENT ON TABLE public.invitation_reward_grants IS 'Manual, stage-specific invitation rewards. Registration and paid activation are separate decisions.';
COMMENT ON FUNCTION public.assign_cami_to_user_atomic(text,text,text,text) IS 'Binds one unused membership card to one learner and delivers it exactly once.';
COMMENT ON FUNCTION public.redeem_cami_membership_atomic(text,text,text) IS 'Atomically redeems a membership card, activates membership and unlocks the activation reward decision without auto-paying it.';
COMMENT ON FUNCTION public.send_invitation_reward_atomic(text,text,text,text) IS 'Atomically pays one manually drafted invitation reward and sends its account notification exactly once.';

NOTIFY pgrst, 'reload schema';
COMMIT;
