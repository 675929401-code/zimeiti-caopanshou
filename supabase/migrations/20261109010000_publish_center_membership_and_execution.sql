BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Independent resource registration only. Existing grants/profile snapshots are never widened.
INSERT INTO public.member_permission_resources(resource_type, resource_key, label, route, description, sort_order)
VALUES ('feature','publish_center','发布中心','/publish-center','成片草稿、浏览器账号与发布执行记录',100)
ON CONFLICT(resource_type, resource_key) DO UPDATE SET label=EXCLUDED.label, route=EXCLUDED.route, description=EXCLUDED.description, last_seen_at=now();

CREATE TABLE public.pub_config_versions (
  version integer PRIMARY KEY CHECK(version > 0), execution_enabled boolean NOT NULL DEFAULT false,
  sales_enabled boolean NOT NULL DEFAULT false, announcement text NOT NULL DEFAULT '',
  enabled_platforms jsonb NOT NULL DEFAULT '["xhs","douyin","wxSph"]' CHECK(jsonb_typeof(enabled_platforms)='array' AND enabled_platforms <@ '["xhs","douyin","wxSph"]'),
  procurement_notes text NOT NULL DEFAULT '', procurement_verified_at timestamptz,
  operator_links jsonb NOT NULL CHECK(jsonb_typeof(operator_links)='object'),
  created_by varchar(36) REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.pub_config_versions(version, operator_links, announcement) VALUES(1,
  '{"officialUrl":"https://aitoearn.cn/","docsUrl":"https://docs.aitoearn.ai/zh/use/publish-flow","apiKeyUrl":"https://aitoearn.cn/zh-CN/developer/api-keys","contactUrl":"https://github.com/yikart/AiToEarn#社区与支持","pluginUrl":"https://aitoearn.cn/zh-CN/websit/plugin-guide"}',
  '发布服务尚未开放，您可以先整理成片和保存草稿。');
CREATE TABLE public.pub_plan_versions (
  id uuid NOT NULL, version integer NOT NULL CHECK(version>0), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '', price_cents integer NOT NULL CHECK(price_cents>0),
  quota integer NOT NULL CHECK(quota>0), valid_days integer NOT NULL CHECK(valid_days BETWEEN 1 AND 3650),
  platforms jsonb NOT NULL CHECK(jsonb_typeof(platforms)='array' AND jsonb_array_length(platforms)>0 AND platforms <@ '["xhs","douyin","wxSph"]'),
  enabled boolean NOT NULL DEFAULT false, created_by varchar(36) REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(id,version)
);
-- No sellable plans are seeded; prices and limits require an explicit administrator decision.
CREATE TABLE public.pub_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar(36) NOT NULL REFERENCES public.users(id),
  plan_id uuid NOT NULL, plan_version integer NOT NULL, plan_name text NOT NULL, price_cents integer NOT NULL CHECK(price_cents>0),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160), payload_fingerprint text NOT NULL,
  wallet_operation_id bigint NOT NULL REFERENCES public.wallet_operations(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,idempotency_key), FOREIGN KEY(plan_id,plan_version) REFERENCES public.pub_plan_versions(id,version)
);
CREATE TABLE public.pub_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar(36) NOT NULL REFERENCES public.users(id),
  purchase_id uuid NOT NULL UNIQUE REFERENCES public.pub_purchases(id), plan_id uuid NOT NULL, plan_version integer NOT NULL,
  plan_name text NOT NULL, quota integer NOT NULL CHECK(quota>0), used integer NOT NULL DEFAULT 0 CHECK(used>=0 AND used<=quota),
  platforms jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(plan_id,plan_version) REFERENCES public.pub_plan_versions(id,version)
);
CREATE TABLE public.pub_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar(36) NOT NULL REFERENCES public.users(id),
  platform text NOT NULL CHECK(platform IN ('xhs','douyin','wxSph')), platform_account_id text NOT NULL CHECK(length(platform_account_id) BETWEEN 1 AND 160),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200), avatar text, source text NOT NULL DEFAULT 'browser_reported' CHECK(source='browser_reported'),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,platform,platform_account_id)
);
CREATE TABLE public.pub_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar(36) NOT NULL REFERENCES public.users(id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0), payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  is_deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pub_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar(36) NOT NULL REFERENCES public.users(id),
  draft_id uuid NOT NULL REFERENCES public.pub_drafts(id), draft_revision integer NOT NULL, draft_snapshot jsonb NOT NULL,
  account_id uuid NOT NULL REFERENCES public.pub_accounts(id), account_snapshot jsonb NOT NULL, platform text NOT NULL CHECK(platform IN ('xhs','douyin','wxSph')),
  entitlement_id uuid NOT NULL REFERENCES public.pub_entitlements(id), idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
  payload_fingerprint text NOT NULL, status text NOT NULL DEFAULT 'awaiting_receipt' CHECK(status IN ('awaiting_receipt','unknown','browser_reported')),
  receipt jsonb, receipt_source text CHECK(receipt_source='browser_reported'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE INDEX pub_purchases_owner_created ON public.pub_purchases(user_id,created_at DESC);
CREATE INDEX pub_entitlements_owner_expiry ON public.pub_entitlements(user_id,expires_at);
CREATE INDEX pub_drafts_owner_updated ON public.pub_drafts(user_id,updated_at DESC);
CREATE INDEX pub_tasks_owner_created ON public.pub_tasks(user_id,created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pub_config_versions','pub_plan_versions','pub_purchases','pub_entitlements','pub_accounts','pub_drafts','pub_tasks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
  END LOOP;
END $$;

CREATE FUNCTION public.pub_assert_actor(p_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user public.users%ROWTYPE; v_snapshot jsonb;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_USER_NOT_FOUND'; END IF;
  IF v_user.is_active IS FALSE OR lower(trim(coalesce(v_user.status,''))) IN ('blocked','suspended','disabled','inactive') THEN RAISE EXCEPTION 'PUBLISH_USER_DISABLED'; END IF;
  PERFORM 1 FROM public.member_permission_assignments WHERE user_id=p_user_id FOR SHARE;
  v_snapshot:=public.read_member_permission_snapshot(p_user_id);
  IF v_snapshot->>'authority_status'<>'ready' OR coalesce((v_snapshot->>'integrity_valid')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_PERMISSION_UNAVAILABLE'; END IF;
  IF NOT coalesce(v_snapshot->'feature_navigation_keys' ? 'publish_center',false) THEN RAISE EXCEPTION 'PUBLISH_ACCESS_DENIED'; END IF;
END $$;

CREATE FUNCTION public.purchase_publish_package_atomic(p_user_id text,p_plan_id uuid,p_plan_version integer,p_idempotency_key text,p_payload_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_plan public.pub_plan_versions%ROWTYPE; v_config public.pub_config_versions%ROWTYPE; v_purchase public.pub_purchases%ROWTYPE; v_entitlement public.pub_entitlements%ROWTYPE; v_wallet jsonb;
BEGIN
  PERFORM public.pub_assert_actor(p_user_id);
  IF length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 160 OR p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$' OR coalesce(p_payload_fingerprint,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  SELECT * INTO v_purchase FROM public.pub_purchases WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_purchase.payload_fingerprint<>p_payload_fingerprint OR v_purchase.plan_id<>p_plan_id OR v_purchase.plan_version<>p_plan_version THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT'; END IF;
    SELECT * INTO v_entitlement FROM public.pub_entitlements WHERE purchase_id=v_purchase.id AND user_id=p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_PURCHASE_INCOMPLETE'; END IF;
    RETURN jsonb_build_object('purchase',to_jsonb(v_purchase),'entitlement',to_jsonb(v_entitlement),'alreadyFulfilled',true);
  END IF;
  SELECT * INTO v_config FROM public.pub_config_versions ORDER BY version DESC LIMIT 1 FOR SHARE;
  IF v_config.sales_enabled IS NOT TRUE OR v_config.execution_enabled IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_SALES_DISABLED'; END IF;
  SELECT * INTO v_plan FROM public.pub_plan_versions WHERE id=p_plan_id AND version=p_plan_version FOR SHARE;
  IF NOT FOUND OR v_plan.enabled IS NOT TRUE OR EXISTS(SELECT 1 FROM public.pub_plan_versions WHERE id=p_plan_id AND version>p_plan_version) THEN RAISE EXCEPTION 'PUBLISH_PLAN_UNAVAILABLE'; END IF;
  IF NOT (v_plan.platforms <@ v_config.enabled_platforms) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_DISABLED'; END IF;
  v_wallet:=public.apply_wallet_operation_atomic(p_user_id,'cash_charge','publish-package:'||p_idempotency_key,v_plan.price_cents::numeric/100,'购买发布执行套餐',jsonb_build_object('source','publish_center','planId',p_plan_id,'planVersion',p_plan_version));
  IF coalesce((v_wallet->>'success')::boolean,false) IS NOT TRUE OR v_wallet->>'operation_id' IS NULL THEN RAISE EXCEPTION 'PUBLISH_WALLET_CHARGE_FAILED'; END IF;
  INSERT INTO public.pub_purchases(user_id,plan_id,plan_version,plan_name,price_cents,idempotency_key,payload_fingerprint,wallet_operation_id)
  VALUES(p_user_id,p_plan_id,p_plan_version,v_plan.name,v_plan.price_cents,p_idempotency_key,p_payload_fingerprint,(v_wallet->>'operation_id')::bigint) RETURNING * INTO v_purchase;
  INSERT INTO public.pub_entitlements(user_id,purchase_id,plan_id,plan_version,plan_name,quota,platforms,expires_at)
  VALUES(p_user_id,v_purchase.id,p_plan_id,p_plan_version,v_plan.name,v_plan.quota,v_plan.platforms,now()+make_interval(days=>v_plan.valid_days)) RETURNING * INTO v_entitlement;
  RETURN jsonb_build_object('purchase',to_jsonb(v_purchase),'entitlement',to_jsonb(v_entitlement),'alreadyFulfilled',false);
END $$;

CREATE FUNCTION public.claim_publish_execution_atomic(p_user_id text,p_draft_id uuid,p_draft_revision integer,p_account_id uuid,p_entitlement_id uuid,p_idempotency_key text,p_payload_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_task public.pub_tasks%ROWTYPE; v_draft public.pub_drafts%ROWTYPE; v_account public.pub_accounts%ROWTYPE; v_entitlement public.pub_entitlements%ROWTYPE; v_config public.pub_config_versions%ROWTYPE;
BEGIN
  PERFORM public.pub_assert_actor(p_user_id);
  IF length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 160 OR p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$' OR coalesce(p_payload_fingerprint,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  SELECT * INTO v_task FROM public.pub_tasks WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_task.payload_fingerprint<>p_payload_fingerprint OR v_task.draft_id<>p_draft_id OR v_task.draft_revision<>p_draft_revision OR v_task.account_id<>p_account_id OR v_task.entitlement_id<>p_entitlement_id THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('task',to_jsonb(v_task),'shouldExecute',false,'alreadyFulfilled',true);
  END IF;
  SELECT * INTO v_config FROM public.pub_config_versions ORDER BY version DESC LIMIT 1 FOR SHARE;
  IF v_config.execution_enabled IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_EXECUTION_DISABLED'; END IF;
  SELECT * INTO v_draft FROM public.pub_drafts WHERE id=p_draft_id AND user_id=p_user_id AND NOT is_deleted FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND'; END IF;
  IF v_draft.revision<>p_draft_revision THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  SELECT * INTO v_account FROM public.pub_accounts WHERE id=p_account_id AND user_id=p_user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  IF NOT coalesce(v_draft.payload->'platforms' ? v_account.platform,false) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_NOT_ALLOWED'; END IF;
  IF NOT coalesce(v_config.enabled_platforms ? v_account.platform,false) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_DISABLED'; END IF;
  SELECT * INTO v_entitlement FROM public.pub_entitlements WHERE id=p_entitlement_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_NOT_FOUND'; END IF;
  IF v_entitlement.expires_at<=now() THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_EXPIRED'; END IF;
  IF v_entitlement.used>=v_entitlement.quota THEN RAISE EXCEPTION 'PUBLISH_NO_QUOTA'; END IF;
  IF NOT coalesce(v_entitlement.platforms ? v_account.platform,false) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_NOT_ALLOWED'; END IF;
  UPDATE public.pub_entitlements SET used=used+1 WHERE id=v_entitlement.id;
  INSERT INTO public.pub_tasks(user_id,draft_id,draft_revision,draft_snapshot,account_id,account_snapshot,platform,entitlement_id,idempotency_key,payload_fingerprint)
  VALUES(p_user_id,v_draft.id,v_draft.revision,v_draft.payload,v_account.id,jsonb_build_object('platform',v_account.platform,'platformAccountId',v_account.platform_account_id,'displayName',v_account.display_name),v_account.platform,v_entitlement.id,p_idempotency_key,p_payload_fingerprint) RETURNING * INTO v_task;
  RETURN jsonb_build_object('task',to_jsonb(v_task),'shouldExecute',true,'alreadyFulfilled',false);
END $$;

CREATE FUNCTION public.save_publish_draft_atomic(p_user_id text,p_id uuid,p_expected_revision integer,p_payload jsonb,p_delete boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_draft public.pub_drafts%ROWTYPE;
BEGIN
  PERFORM public.pub_assert_actor(p_user_id);
  IF p_id IS NULL THEN
    IF p_expected_revision<>0 OR p_delete THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
    INSERT INTO public.pub_drafts(user_id,payload) VALUES(p_user_id,p_payload) RETURNING * INTO v_draft;
  ELSE
    UPDATE public.pub_drafts SET payload=CASE WHEN p_delete THEN payload ELSE p_payload END, revision=revision+1, is_deleted=p_delete, updated_at=now()
    WHERE id=p_id AND user_id=p_user_id AND revision=p_expected_revision AND NOT is_deleted RETURNING * INTO v_draft;
    IF NOT FOUND THEN
      IF EXISTS(SELECT 1 FROM public.pub_drafts WHERE id=p_id AND user_id=p_user_id AND NOT is_deleted) THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
      RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND';
    END IF;
  END IF;
  RETURN to_jsonb(v_draft);
END $$;

CREATE FUNCTION public.save_publish_account_atomic(p_user_id text,p_platform text,p_platform_account_id text,p_display_name text,p_avatar text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_account public.pub_accounts%ROWTYPE;
BEGIN
  PERFORM public.pub_assert_actor(p_user_id);
  INSERT INTO public.pub_accounts(user_id,platform,platform_account_id,display_name,avatar)
  VALUES(p_user_id,p_platform,p_platform_account_id,p_display_name,p_avatar)
  ON CONFLICT(user_id,platform,platform_account_id) DO UPDATE SET display_name=EXCLUDED.display_name,avatar=EXCLUDED.avatar,updated_at=now()
  RETURNING * INTO v_account;
  RETURN to_jsonb(v_account);
END $$;

CREATE FUNCTION public.report_publish_execution_atomic(p_user_id text,p_task_id uuid,p_receipt jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_task public.pub_tasks%ROWTYPE;
BEGIN
  PERFORM public.pub_assert_actor(p_user_id);
  SELECT * INTO v_task FROM public.pub_tasks WHERE id=p_task_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_TASK_NOT_FOUND'; END IF;
  IF v_task.receipt IS NOT NULL THEN
    IF v_task.receipt<>p_receipt THEN RAISE EXCEPTION 'PUBLISH_RECEIPT_CONFLICT'; END IF;
    RETURN to_jsonb(v_task);
  END IF;
  UPDATE public.pub_tasks SET receipt=p_receipt,receipt_source='browser_reported',status='browser_reported',updated_at=now() WHERE id=v_task.id RETURNING * INTO v_task;
  RETURN to_jsonb(v_task);
END $$;

CREATE FUNCTION public.save_publish_config_atomic(p_actor_id text,p_expected_version integer,p_config jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_current integer; v_result public.pub_config_versions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('publish-center:config',0));
  SELECT coalesce(max(version),0) INTO v_current FROM public.pub_config_versions;
  IF v_current<>p_expected_version THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  INSERT INTO public.pub_config_versions(version,execution_enabled,sales_enabled,announcement,operator_links,enabled_platforms,procurement_notes,procurement_verified_at,created_by)
  VALUES(v_current+1,(p_config->>'executionEnabled')::boolean,(p_config->>'salesEnabled')::boolean,p_config->>'announcement',p_config->'operatorLinks',p_config->'enabledPlatforms',p_config->>'procurementNotes',(p_config->>'procurementVerifiedAt')::timestamptz,p_actor_id) RETURNING * INTO v_result;
  RETURN to_jsonb(v_result);
END $$;

CREATE FUNCTION public.save_publish_plan_atomic(p_actor_id text,p_plan jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_current integer; v_result public.pub_plan_versions%ROWTYPE; v_id uuid:=(p_plan->>'id')::uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('publish-center:plan:'||v_id::text,0));
  SELECT coalesce(max(version),0) INTO v_current FROM public.pub_plan_versions WHERE id=v_id;
  IF v_current<>(p_plan->>'expectedVersion')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  INSERT INTO public.pub_plan_versions(id,version,name,description,price_cents,quota,valid_days,platforms,enabled,created_by)
  VALUES(v_id,v_current+1,p_plan->>'name',p_plan->>'description',(p_plan->>'priceCents')::integer,(p_plan->>'quota')::integer,(p_plan->>'validDays')::integer,p_plan->'platforms',(p_plan->>'enabled')::boolean,p_actor_id) RETURNING * INTO v_result;
  RETURN to_jsonb(v_result);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('pub_assert_actor','purchase_publish_package_atomic','claim_publish_execution_atomic','save_publish_draft_atomic','save_publish_account_atomic','report_publish_execution_atomic','save_publish_config_atomic','save_publish_plan_atomic') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
