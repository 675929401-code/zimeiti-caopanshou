BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

-- A quota release is one publishing allowance, never a package/cash refund.
-- V3 submit atomically increments used and appends its immutable operation and
-- system/admitted event. The original disconnect path then appends system/blocked.
-- Both records and aggregate charge reconciliation are required below; no
-- historical status, missing grant, or missing provider ID alone proves a debit.
CREATE TABLE public.pub3_quota_releases (
 operation_id uuid PRIMARY KEY REFERENCES public.pub3_operations(id),
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 entitlement_id uuid NOT NULL REFERENCES public.pub_entitlements(id),
 admitted_event_id uuid NOT NULL UNIQUE REFERENCES public.pub3_events(id),
 blocked_event_id uuid NOT NULL UNIQUE REFERENCES public.pub3_events(id),
 release_event_id uuid NOT NULL UNIQUE REFERENCES public.pub3_events(id),
 operation_revision integer NOT NULL CHECK(operation_revision>0),
 released_units integer NOT NULL DEFAULT 1 CHECK(released_units=1),
 used_before integer NOT NULL CHECK(used_before>0),
 used_after integer NOT NULL CHECK(used_after>=0 AND used_after=used_before-1),
 reason text NOT NULL CHECK(reason='NATIVE_ACCOUNT_DISCONNECTED_UNISSUED'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pub3_quota_releases_owner_created ON public.pub3_quota_releases(owner_id,created_at DESC);
CREATE INDEX pub3_quota_releases_entitlement ON public.pub3_quota_releases(entitlement_id);
CREATE UNIQUE INDEX pub3_quota_release_event_once ON public.pub3_events(operation_id) WHERE kind='quota_released';
ALTER TABLE public.pub3_quota_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pub3_quota_releases FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.pub3_quota_releases TO service_role;
CREATE TRIGGER pub3_quota_release_immutable BEFORE UPDATE OR DELETE ON public.pub3_quota_releases
 FOR EACH ROW EXECUTE FUNCTION public.native_metadata_history_guard();

CREATE FUNCTION public.release_native_unissued_quota_atomic(p_owner text,p_operation_id uuid,p_expected_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 v_op public.pub3_operations%ROWTYPE;
 v_ent public.pub_entitlements%ROWTYPE;
 v_release public.pub3_quota_releases%ROWTYPE;
 v_admitted uuid;v_blocked uuid;v_event uuid:=gen_random_uuid();
 v_admitted_count bigint;v_accounted bigint;
BEGIN
 -- All supported callers lock actor -> operation -> entitlement. The automatic
 -- event trigger runs inside disconnect, which already holds this actor lock.
 PERFORM public.pub_assert_actor(p_owner);
 IF p_operation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 THEN
  RAISE EXCEPTION 'NATIVE_QUOTA_INPUT_INVALID';
 END IF;
 SELECT * INTO v_op FROM public.pub3_operations WHERE id=p_operation_id AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_QUOTA_OPERATION_NOT_FOUND';END IF;
 SELECT * INTO v_release FROM public.pub3_quota_releases WHERE operation_id=v_op.id;
 IF FOUND THEN
  IF v_release.owner_id IS DISTINCT FROM p_owner OR v_release.entitlement_id IS DISTINCT FROM v_op.entitlement_id THEN
   RAISE EXCEPTION 'NATIVE_QUOTA_EVIDENCE_INVALID';
  END IF;
  RETURN jsonb_build_object('operationId',v_op.id,'entitlementId',v_release.entitlement_id,'released',true,'alreadyFulfilled',true,'release',to_jsonb(v_release));
 END IF;
 IF v_op.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
 IF v_op.kind<>'publish' OR v_op.dispatch_state<>'blocked' OR v_op.outcome<>'pending'
  OR v_op.error_code IS DISTINCT FROM 'NATIVE_ACCOUNT_DISCONNECTED' OR v_op.grant_used
  OR v_op.provider_record_id IS NOT NULL OR v_op.provider_task_id IS NOT NULL
  OR v_op.work_id IS NOT NULL OR v_op.work_link IS NOT NULL OR v_op.entitlement_id IS NULL
  OR v_op.grant_kind IS DISTINCT FROM 'create_flow' OR v_op.flow_id IS NULL
  OR v_op.grant_subject IS DISTINCT FROM v_op.flow_id OR v_op.intent_revision IS NULL
 THEN RAISE EXCEPTION 'NATIVE_QUOTA_NOT_UNISSUED';END IF;
 -- A response-loss/remote observation in the append-only history remains
 -- disqualifying even if an operator later accidentally resets the current row.
 IF EXISTS(SELECT 1 FROM public.pub3_events WHERE operation_id=v_op.id
  AND (owner_id IS DISTINCT FROM p_owner OR source='provider_reported' OR safe_payload->>'status'='unknown')) THEN
  RAISE EXCEPTION 'NATIVE_QUOTA_REMOTE_OR_UNKNOWN';
 END IF;
 SELECT count(*) INTO v_admitted_count FROM public.pub3_events
  WHERE operation_id=v_op.id AND owner_id=p_owner AND kind='admitted' AND source='system';
 IF v_admitted_count<>1 THEN RAISE EXCEPTION 'NATIVE_QUOTA_EVIDENCE_INVALID';END IF;
 SELECT id INTO v_admitted FROM public.pub3_events
  WHERE operation_id=v_op.id AND owner_id=p_owner AND kind='admitted' AND source='system';
 SELECT b.id INTO v_blocked FROM public.pub3_events b JOIN public.pub3_events a ON a.id=v_admitted
  WHERE b.operation_id=v_op.id AND b.owner_id=p_owner AND b.kind='blocked' AND b.source='system'
   AND b.safe_payload->>'status'='blocked' AND b.safe_payload->>'errorCode'='NATIVE_ACCOUNT_DISCONNECTED'
   AND b.created_at>=a.created_at ORDER BY b.created_at,b.id LIMIT 1;
 IF v_blocked IS NULL THEN RAISE EXCEPTION 'NATIVE_QUOTA_EVIDENCE_INVALID';END IF;
 SELECT * INTO v_ent FROM public.pub_entitlements WHERE id=v_op.entitlement_id AND user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_QUOTA_ENTITLEMENT_OWNER_MISMATCH';END IF;
 -- Original V1/V2/V3 claims each debit exactly once in their insert transaction.
 -- Any drift is UNKNOWN: do not guess which operation was charged or clamp zero.
 SELECT (SELECT count(*) FROM public.pub_tasks WHERE entitlement_id=v_ent.id)
       +(SELECT count(*) FROM public.pub2_attempts WHERE entitlement_id=v_ent.id)
       +(SELECT count(*) FROM public.pub3_operations WHERE entitlement_id=v_ent.id AND kind='publish')
       -(SELECT count(*) FROM public.pub3_quota_releases WHERE entitlement_id=v_ent.id)
 INTO v_accounted;
 IF v_ent.used<=0 OR v_ent.used::bigint IS DISTINCT FROM v_accounted THEN
  RAISE EXCEPTION 'NATIVE_QUOTA_ACCOUNTING_MISMATCH';
 END IF;
 INSERT INTO public.pub3_events(id,owner_id,operation_id,kind,source,safe_payload)
 VALUES(v_event,p_owner,v_op.id,'quota_released','system',jsonb_build_object(
  'status','blocked','reason','NATIVE_ACCOUNT_DISCONNECTED_UNISSUED','releasedUnits',1,
  'entitlementId',v_ent.id,'usedBefore',v_ent.used,'usedAfter',v_ent.used-1));
 INSERT INTO public.pub3_quota_releases(operation_id,owner_id,entitlement_id,admitted_event_id,blocked_event_id,release_event_id,operation_revision,used_before,used_after,reason)
 VALUES(v_op.id,p_owner,v_ent.id,v_admitted,v_blocked,v_event,v_op.revision,v_ent.used,v_ent.used-1,'NATIVE_ACCOUNT_DISCONNECTED_UNISSUED') RETURNING * INTO v_release;
 UPDATE public.pub_entitlements SET used=used-1 WHERE id=v_ent.id AND user_id=p_owner AND used=v_ent.used AND used>0;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_QUOTA_ACCOUNTING_MISMATCH';END IF;
 RETURN jsonb_build_object('operationId',v_op.id,'entitlementId',v_ent.id,'released',true,'alreadyFulfilled',false,'release',to_jsonb(v_release));
END $$;

CREATE FUNCTION public.native_release_unissued_quota_on_blocked() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_revision integer;
BEGIN
 IF NEW.kind='blocked' AND NEW.source='system' AND NEW.safe_payload->>'status'='blocked'
  AND NEW.safe_payload->>'errorCode'='NATIVE_ACCOUNT_DISCONNECTED' THEN
  SELECT revision INTO v_revision FROM public.pub3_operations WHERE id=NEW.operation_id AND owner_id=NEW.owner_id;
  PERFORM public.release_native_unissued_quota_atomic(NEW.owner_id,NEW.operation_id,v_revision);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_unissued_quota_release_on_blocked AFTER INSERT ON public.pub3_events
 FOR EACH ROW EXECUTE FUNCTION public.native_release_unissued_quota_on_blocked();

CREATE FUNCTION public.native_released_operation_terminal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.pub3_quota_releases WHERE operation_id=OLD.id)
  AND (NEW.dispatch_state IS DISTINCT FROM 'blocked' OR NEW.outcome IS DISTINCT FROM 'pending'
   OR NEW.error_code IS DISTINCT FROM 'NATIVE_ACCOUNT_DISCONNECTED' OR NEW.grant_used
   OR NEW.provider_record_id IS NOT NULL OR NEW.provider_task_id IS NOT NULL
   OR NEW.work_id IS NOT NULL OR NEW.work_link IS NOT NULL) THEN
  RAISE EXCEPTION 'NATIVE_QUOTA_RELEASED_OPERATION_TERMINAL';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_released_operation_terminal BEFORE UPDATE ON public.pub3_operations
 FOR EACH ROW EXECUTE FUNCTION public.native_released_operation_terminal_guard();

REVOKE ALL ON FUNCTION public.release_native_unissued_quota_atomic(text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.native_release_unissued_quota_on_blocked() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.native_released_operation_terminal_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.release_native_unissued_quota_atomic(text,uuid,integer) TO service_role;
-- No bulk backfill: historic blocked IDs require this same owner/CAS RPC and all
-- proofs. Pending, completed, unknown and already-issued history is untouched.
NOTIFY pgrst,'reload schema';
COMMIT;
