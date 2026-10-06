BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Restore the preceding generated receipt-copy behavior. Wallet descriptions
-- again include the optional administrator note; notifications are generated
-- from the reward stage and append that note as an explanation.
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
  v_expected_recipient uuid;
  v_credit jsonb;
  v_cash jsonb;
  v_delivery jsonb;
  v_description text;
  v_notification_title text;
  v_notification_body text;
  v_amount_copy text;
  v_now timestamptz := clock_timestamp();
BEGIN
  BEGIN v_admin_uuid := p_admin_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_ADMIN_ID_INVALID');
  END;
  IF v_stage NOT IN ('registration', 'invitee_welcome', 'activation')
     OR v_key = '' OR length(v_key) > 180 THEN
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

  v_expected_recipient := CASE WHEN v_stage = 'invitee_welcome' THEN v_record.invitee_id ELSE v_record.inviter_id END;
  IF v_grant.recipient_user_id IS DISTINCT FROM v_expected_recipient THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_RECIPIENT_MISMATCH');
  END IF;
  IF v_grant.status = 'sent' THEN
    RETURN jsonb_build_object(
      'success', true, 'already_sent', true, 'grant_id', v_grant.id,
      'reward_stage', v_grant.reward_stage, 'recipient_user_id', v_grant.recipient_user_id,
      'credits', v_grant.credits, 'cash_amount', v_grant.cash_amount,
      'notification_id', v_grant.notification_id
    );
  END IF;
  IF v_grant.eligibility_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_NOT_ELIGIBLE');
  END IF;
  IF v_grant.status <> 'draft' OR (v_grant.credits <= 0 AND v_grant.cash_amount <= 0) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REWARD_DRAFT_REQUIRED');
  END IF;

  v_description := CASE v_stage
    WHEN 'registration' THEN '老会员邀请注册奖励'
    WHEN 'invitee_welcome' THEN '新会员注册体验礼包'
    ELSE '老会员正式会员邀请奖励'
  END;
  IF v_grant.credits > 0 THEN
    v_credit := public.apply_wallet_operation_atomic(
      v_grant.recipient_user_id::text, 'credit_topup',
      'invitation-reward:' || v_grant.id::text || ':credits', v_grant.credits,
      v_description || CASE WHEN v_grant.note <> '' THEN '：' || v_grant.note ELSE '' END,
      jsonb_build_object(
        'source', 'invitation_reward', 'grant_id', v_grant.id, 'stage', v_stage,
        'recipient_role', CASE WHEN v_stage = 'invitee_welcome' THEN 'invitee' ELSE 'inviter' END
      )
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
      jsonb_build_object(
        'source', 'invitation_reward', 'grant_id', v_grant.id, 'stage', v_stage,
        'recipient_role', CASE WHEN v_stage = 'invitee_welcome' THEN 'invitee' ELSE 'inviter' END
      )
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
  v_notification_title := CASE v_stage
    WHEN 'registration' THEN '邀请注册奖励已到账'
    WHEN 'invitee_welcome' THEN '注册体验礼包已到账'
    ELSE '正式会员邀请奖励已到账'
  END;
  v_notification_body := CASE v_stage
    WHEN 'invitee_welcome' THEN format('欢迎注册平台，管理员已确认发放新人体验礼包：%s。%s',
      v_amount_copy, CASE WHEN v_grant.note <> '' THEN E'\n说明：' || v_grant.note ELSE '' END)
    WHEN 'registration' THEN format('你邀请的学员已成功注册，管理员已确认发放：%s。%s',
      v_amount_copy, CASE WHEN v_grant.note <> '' THEN E'\n说明：' || v_grant.note ELSE '' END)
    ELSE format('你邀请的学员已完成正式会员激活，管理员已确认发放：%s。%s',
      v_amount_copy, CASE WHEN v_grant.note <> '' THEN E'\n说明：' || v_grant.note ELSE '' END)
  END;
  v_delivery := public.enqueue_user_notification_once(
    v_grant.recipient_user_id::text,
    'invitation_reward',
    v_notification_title,
    v_notification_body,
    NULL,
    jsonb_build_object(
      'dedupe_key', 'invitation-reward:' || v_grant.id::text,
      'source', 'invitation_reward',
      'grant_id', v_grant.id,
      'invitation_record_id', v_record.id,
      'reward_stage', v_stage,
      'recipient_role', CASE WHEN v_stage = 'invitee_welcome' THEN 'invitee' ELSE 'inviter' END,
      'inviter_id', v_record.inviter_id,
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

  UPDATE public.invitation_records AS record_row
  SET reward_sent = NOT EXISTS (
    SELECT 1 FROM public.invitation_reward_grants AS grant_row
    WHERE grant_row.invitation_record_id = record_row.id
      AND grant_row.eligibility_at IS NOT NULL
      AND grant_row.status NOT IN ('sent', 'skipped')
  )
  WHERE record_row.id = v_record.id;

  RETURN jsonb_build_object(
    'success', true, 'already_sent', false, 'grant_id', v_grant.id,
    'reward_stage', v_grant.reward_stage, 'recipient_user_id', v_grant.recipient_user_id,
    'credits', v_grant.credits, 'cash_amount', v_grant.cash_amount,
    'notification_id', v_grant.notification_id,
    'credit_operation_id', v_grant.credit_operation_id,
    'cash_operation_id', v_grant.cash_operation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.send_invitation_reward_atomic(text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_invitation_reward_atomic(text,text,text,text)
  TO service_role;

COMMENT ON FUNCTION public.send_invitation_reward_atomic(text,text,text,text)
  IS 'Atomically pays one manually drafted relationship benefit to its stage-defined recipient and sends exactly one receipt notification.';

NOTIFY pgrst, 'reload schema';
COMMIT;
