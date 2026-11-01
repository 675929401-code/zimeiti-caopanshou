BEGIN;
SET LOCAL lock_timeout = '10s';

-- Server-only operation journal. No user_files mutation, business backfill,
-- provider call, wallet mutation, retry lease, or queue is introduced here.
CREATE TABLE IF NOT EXISTS public.gaorui_provider_asset_operations (
  scope_key text PRIMARY KEY CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  scope jsonb NOT NULL UNIQUE CHECK (jsonb_typeof(scope) = 'object'),
  claim_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('submitting','ready','processing','submission_unknown','reconciliation_required','failed')),
  result jsonb,
  error_code text,
  budget_authorization_id text NOT NULL,
  maximum_charge_cny numeric NOT NULL CHECK (maximum_charge_cny = 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  CHECK (state <> 'ready' OR result IS NOT NULL)
);
ALTER TABLE public.gaorui_provider_asset_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gaorui_provider_asset_operations OWNER TO zimeiti_owner;
REVOKE ALL ON TABLE public.gaorui_provider_asset_operations FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.video_tasks ADD COLUMN IF NOT EXISTS provider_asset_preparation jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.video_tasks'::regclass AND conname='video_tasks_provider_asset_preparation_object') THEN
    ALTER TABLE public.video_tasks ADD CONSTRAINT video_tasks_provider_asset_preparation_object
      CHECK (provider_asset_preparation IS NULL OR jsonb_typeof(provider_asset_preparation) = 'object');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_gaorui_provider_person_asset_v1(
  p_scope_key text,
  p_scope jsonb,
  p_claim_token uuid,
  p_budget_authorization_id text,
  p_maximum_charge_cny numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_asset public.user_files%ROWTYPE;
  v_asset_json jsonb;
  v_operation public.gaorui_provider_asset_operations%ROWTYPE;
  v_claimed boolean := false;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[a-f0-9]{64}$'
     OR p_scope IS NULL OR jsonb_typeof(p_scope) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_scope)) <> 13
     OR coalesce(p_scope->>'user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(p_scope->>'owned_asset_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(p_scope->>'asset_version','') !~ '^[a-f0-9]{64}$'
     OR coalesce(p_scope->>'content_sha256','') !~ '^[a-f0-9]{64}$'
     OR coalesce(p_scope->>'credential_binding_fingerprint','') !~ '^[a-f0-9]{64}$'
     OR p_scope->>'storage_provider' IS DISTINCT FROM 'tencent_cos'
     OR nullif(p_scope->>'storage_key','') IS NULL
     OR p_scope->>'provider_origin' IS DISTINCT FROM 'https://gaorui.cc'
     OR nullif(trim(p_scope->>'model_id'),'') IS NULL
     OR p_scope->>'model_name' IS DISTINCT FROM 'seedance-2.0-fast'
     OR p_scope->>'type' IS DISTINCT FROM 'image'
     OR p_scope->>'role' IS DISTINCT FROM 'reference_image'
     OR p_scope->>'purpose' IS DISTINCT FROM 'person_reference'
     OR p_claim_token IS NULL
     OR coalesce(p_budget_authorization_id,'') !~ '^[A-Za-z0-9:_-]{8,160}$'
     OR p_maximum_charge_cny IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'GAORUI_ASSET_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;

  -- The service computes the real object SHA-256. The database independently
  -- binds the operation to the current owner's actual stored image identity.
  SELECT * INTO v_asset FROM public.user_files
   WHERE id::text = p_scope->>'owned_asset_id'
     AND user_id::text = p_scope->>'user_id'
     AND file_category = 'image' AND source = 'digital-human-input'
     AND storage_provider = p_scope->>'storage_provider'
     AND storage_key = p_scope->>'storage_key'
   FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAORUI_PERSON_ASSET_NOT_OWNED_IMAGE' USING ERRCODE = '42501'; END IF;
  v_asset_json := to_jsonb(v_asset);
  IF nullif(v_asset_json->>'deleted_at','') IS NOT NULL
     OR coalesce(v_asset_json->>'is_deleted','false') = 'true'
     OR nullif(v_asset_json->'meta'->>'deleted_at','') IS NOT NULL
     OR nullif(v_asset_json->'meta'->>'deletedAt','') IS NOT NULL
     OR coalesce(v_asset_json->'meta'->>'deleted','false') = 'true'
     OR coalesce(v_asset.content_type,'') NOT IN ('image/png','image/jpeg','image/webp')
     OR v_asset.file_size IS NULL OR v_asset.file_size <= 0 OR v_asset.file_size > 20971520 THEN
    RAISE EXCEPTION 'GAORUI_PERSON_ASSET_NOT_OWNED_IMAGE' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.gaorui_provider_asset_operations (
    scope_key,scope,claim_token,state,budget_authorization_id,maximum_charge_cny
  ) VALUES (p_scope_key,p_scope,p_claim_token,'submitting',p_budget_authorization_id,p_maximum_charge_cny)
  ON CONFLICT (scope) DO NOTHING
  RETURNING true INTO v_claimed;

  SELECT * INTO v_operation FROM public.gaorui_provider_asset_operations
   WHERE scope = p_scope FOR UPDATE;
  IF NOT FOUND OR v_operation.scope_key IS DISTINCT FROM p_scope_key THEN
    RAISE EXCEPTION 'GAORUI_ASSET_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  -- Existing submitting/unknown/processing/failed rows never obtain a new token.
  -- A process crash before/after POST remains closed until reconciliation.
  RETURN jsonb_build_object('scope_key',v_operation.scope_key,'operation_id',v_operation.operation_id,
    'state',v_operation.state,'claimed',coalesce(v_claimed,false),'result',v_operation.result);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_gaorui_provider_person_asset_v1(
  p_scope_key text,
  p_claim_token uuid,
  p_state text,
  p_result jsonb,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation public.gaorui_provider_asset_operations%ROWTYPE;
  v_id text;
BEGIN
  IF p_scope_key IS NULL OR p_scope_key !~ '^[a-f0-9]{64}$' OR p_claim_token IS NULL
     OR p_state IS NULL OR p_state NOT IN ('ready','processing','submission_unknown','reconciliation_required','failed')
     OR (p_result IS NOT NULL AND (jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR length(p_result::text) > 4096))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^GAORUI_[A-Z0-9_]{1,100}$') THEN
    RAISE EXCEPTION 'GAORUI_ASSET_SETTLEMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'ready' THEN
    v_id := p_result->>'asset_id';
    IF p_result IS NULL OR coalesce(v_id,'') !~ '^[A-Za-z0-9_-]{1,160}$'
       OR p_result->>'status' IS DISTINCT FROM 'ready'
       OR p_result->>'model' IS DISTINCT FROM 'seedance-2.0-fast'
       OR p_result->>'type' IS DISTINCT FROM 'image'
       OR p_result->>'asset_type' IS DISTINCT FROM 'Image'
       OR p_result->>'visibility' IS DISTINCT FROM 'private'
       OR p_result->>'asset_url' IS DISTINCT FROM ('asset://' || v_id)
       OR p_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'GAORUI_ASSET_READY_MAPPING_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_operation FROM public.gaorui_provider_asset_operations
   WHERE scope_key = p_scope_key FOR UPDATE;
  IF NOT FOUND OR v_operation.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'GAORUI_ASSET_SETTLEMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_operation.state = p_state AND v_operation.result IS NOT DISTINCT FROM p_result
     AND v_operation.error_code IS NOT DISTINCT FROM p_error_code THEN
    RETURN jsonb_build_object('state',v_operation.state,'operation_id',v_operation.operation_id);
  END IF;
  IF v_operation.state <> 'submitting' THEN
    RAISE EXCEPTION 'GAORUI_ASSET_SETTLEMENT_CONFLICT' USING ERRCODE = '55000';
  END IF;
  UPDATE public.gaorui_provider_asset_operations
     SET state=p_state,result=p_result,error_code=p_error_code,updated_at=clock_timestamp()
   WHERE scope_key=p_scope_key;
  RETURN jsonb_build_object('state',p_state,'operation_id',v_operation.operation_id);
END;
$$;

ALTER FUNCTION public.claim_gaorui_provider_person_asset_v1(text,jsonb,uuid,text,numeric) OWNER TO zimeiti_owner;
ALTER FUNCTION public.settle_gaorui_provider_person_asset_v1(text,uuid,text,jsonb,text) OWNER TO zimeiti_owner;
REVOKE ALL ON FUNCTION public.claim_gaorui_provider_person_asset_v1(text,jsonb,uuid,text,numeric) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_gaorui_provider_person_asset_v1(text,uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gaorui_provider_person_asset_v1(text,jsonb,uuid,text,numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_gaorui_provider_person_asset_v1(text,uuid,text,jsonb,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
