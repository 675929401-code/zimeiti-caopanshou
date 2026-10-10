BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- PostgreSQL 15 exposes SHA-256 through pg_catalog.sha256(bytea).  Do not
-- require pgcrypto/digest: local installations may intentionally ship without
-- that optional extension, while Supabase commonly installs it in a separate
-- schema outside this SECURITY DEFINER function's locked search_path.
DO $repair$
DECLARE
  v_signature regprocedure := 'public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_old_expression text := 'encode(digest(''zimeiti-verification='' || v_claim.verification_token_hash, ''sha256''), ''hex'')';
  v_new_expression text := 'encode(pg_catalog.sha256(convert_to(''zimeiti-verification='' || v_claim.verification_token_hash, ''UTF8'')), ''hex'')';
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF position(v_new_expression IN v_definition) > 0 THEN
    RETURN;
  END IF;
  IF position(v_old_expression IN v_definition) = 0 THEN
    RAISE EXCEPTION 'WHITE_LABEL_DNS_SHA256_SOURCE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old_expression, v_new_expression);
END;
$repair$;

DO $verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text)'::regprocedure
  ) INTO v_definition;
  IF position('pg_catalog.sha256' IN v_definition) = 0 OR position('digest(' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'WHITE_LABEL_DNS_SHA256_COMPAT_NOT_APPLIED' USING ERRCODE = '55000';
  END IF;
END;
$verify$;

REVOKE ALL ON FUNCTION public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
