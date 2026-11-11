-- Containment rollback: preserve all original charges, refunds, prices and receipts.
-- Never delete an admission or restore a balance by hand. No provider calls.
-- Existing readback/report/refund paths remain available; new cash claims and
-- v3/v5 not-yet-consumed cash permits stop. Legacy entitlement operations are unchanged.
-- v2 browser permits already returned cannot be recalled; keep their original
-- pending markers and reconcile receipts. This rollback cannot undo external posts.
BEGIN;
SET LOCAL lock_timeout='10s';
CREATE OR REPLACE FUNCTION public.claim_publish_cash_target_atomic(p_actor text,p_request jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$BEGIN
 PERFORM public.pub_assert_actor(p_actor);
 RAISE EXCEPTION 'PUBLISH_CASH_ROLLBACK_BLOCKED';
END $$;
CREATE OR REPLACE FUNCTION public.quote_publish_cash(p_actor text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$BEGIN
 PERFORM public.pub_cash_assert_reader(p_actor);
 RETURN jsonb_build_object('schemaReady',true,'quote',NULL,'reasonCode','pricing_unavailable');
END $$;
CREATE OR REPLACE FUNCTION public.pub_cash_consume_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF NOT OLD.grant_used AND NEW.grant_used AND NEW.kind='publish' THEN
  IF TG_TABLE_NAME='pub3_operations' THEN
   IF NEW.cash_admission_id IS NOT NULL THEN RAISE EXCEPTION 'PUBLISH_CASH_ROLLBACK_BLOCKED';END IF;
  ELSIF EXISTS(SELECT 1 FROM public.pub5_targets WHERE operation_id=NEW.id AND owner_id=NEW.owner_id AND cash_admission_id IS NOT NULL) THEN RAISE EXCEPTION 'PUBLISH_CASH_ROLLBACK_BLOCKED';END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.claim_publish_cash_target_atomic(text,jsonb) OWNER TO zimeiti_owner;
ALTER FUNCTION public.quote_publish_cash(text,jsonb) OWNER TO zimeiti_owner;
ALTER FUNCTION public.pub_cash_consume_guard() OWNER TO zimeiti_owner;
REVOKE ALL ON FUNCTION public.claim_publish_cash_target_atomic(text,jsonb),public.quote_publish_cash(text,jsonb),public.pub_cash_consume_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.quote_publish_cash(text,jsonb) TO service_role;
COMMIT;
