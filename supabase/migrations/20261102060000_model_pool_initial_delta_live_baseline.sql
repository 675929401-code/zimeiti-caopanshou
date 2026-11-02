-- Adopt only byte-equivalent live semantics for the first canonical pool delta.
-- No model, credential, health, release, publisher or visibility data is written.
BEGIN;
DO $precondition$
DECLARE p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.model_pool_projection_delta(jsonb)'::regprocedure;
  -- Exact observed owner/ACL pairs: development and native production only.
  IF (
      (pg_get_userbyid(p.proowner) = 'zimeiti_owner'
        AND p.proacl::text = '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')
      OR (pg_get_userbyid(p.proowner) = 'postgres'
        AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,zimeiti_owner=X/postgres}')
    ) IS DISTINCT FROM true
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR NOT p.prosecdef OR p.provolatile <> 's' OR p.proparallel <> 'u'
    OR p.proisstrict OR p.proleakproof OR p.prokind <> 'f' OR NOT p.proretset
    OR (SELECT lanname FROM pg_language WHERE oid=p.prolang) <> 'plpgsql'
    OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') NOT IN (
      '0d221762e01a10bd6d8e66b4d202576492476aa0d4ebf2e2fa38cb264da3b8cf',
      'fdea4e028026049254b6f7da742a9455806794d7e5cf9206cba2b5ca39874de3')
    OR to_regprocedure('public.model_pool_projection_delta_before_initial_live_baseline(jsonb)') IS NOT NULL
    OR to_regprocedure('public.model_pool_initial_live_entry(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'MODEL_POOL_INITIAL_BASELINE_PRECONDITION_FAILED';
  END IF;
END $precondition$;
ALTER FUNCTION public.model_pool_projection_delta(jsonb) RENAME TO model_pool_projection_delta_before_initial_live_baseline;
REVOKE ALL ON FUNCTION public.model_pool_projection_delta_before_initial_live_baseline(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Internal owner-only, read-only mapper. api_key is inspected solely for the
-- canonical reference-presence bit; its value is never returned.
-- Unsupported normalization returns NULL, retaining the original delta.
CREATE FUNCTION public.model_pool_initial_live_entry(p_table text,p_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $entry$
DECLARE
  r jsonb; protocol jsonb; result jsonb; caps jsonb := '{}'::jsonb;
  pricing jsonb := '{}'::jsonb; config jsonb := '{}'::jsonb;
  trimchars text := E' \t\n\r\f' || chr(11) || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  kind text; legacy_id text; enabled boolean; endpoint text; parts text[];
  host text; port text; scheme text; pathpart text; querypart text;
  field text; value jsonb; textvalue text; numbervalue double precision;
  spec jsonb; destination text; outputkey text; sourcekey text;
  namevalue text; modelvalue text; providervalue text; protocolvalue text;
  sortvalue double precision := 0;
BEGIN
  CASE p_table
    WHEN 'cover_models' THEN SELECT to_jsonb(t) INTO r FROM public.cover_models t WHERE t.id::text=p_id;
    WHEN 'video_models' THEN SELECT to_jsonb(t) INTO r FROM public.video_models t WHERE t.id::text=p_id;
    WHEN 'llm_models' THEN SELECT to_jsonb(t) INTO r FROM public.llm_models t WHERE t.id::text=p_id;
    WHEN 'chat_models' THEN SELECT to_jsonb(t) INTO r FROM public.chat_models t WHERE t.id::text=p_id;
    ELSE RETURN NULL;
  END CASE;
  IF r IS NULL THEN RETURN NULL; END IF;
  -- DB string columns use JS String(value??'').trim; unknown scalar shapes
  -- conservatively retain delta instead of guessing JS coercion.
  FOREACH field IN ARRAY ARRAY['id','name','display_name','model_name','provider','protocol_type','api_endpoint','proxy_url','api_key','description','category','icon_url','admin_notes','user_access','billing_mode','image_parsing','file_parsing','response_format','currency'] LOOP
    IF r ? field AND r->field <> 'null'::jsonb AND jsonb_typeof(r->field) <> 'string' THEN RETURN NULL; END IF;
    r := jsonb_set(r,ARRAY[field],to_jsonb(btrim(coalesce(r->>field,''),trimchars)),true);
  END LOOP;
  legacy_id := r->>'id';
  IF legacy_id='' OR length(legacy_id)>200 THEN RETURN NULL; END IF;
  kind := CASE p_table WHEN 'cover_models' THEN 'image' WHEN 'video_models' THEN 'video' ELSE 'agent' END;
  enabled := (r->'is_hidden' IS DISTINCT FROM 'true'::jsonb) AND r->>'provider' <> 'retired_configuration';
  protocol := CASE WHEN jsonb_typeof(r->'api_protocol_config')='object' THEN r->'api_protocol_config' ELSE '{}'::jsonb END;
  IF protocol #>> '{__model_activation_gate,state}' IS DISTINCT FROM 'pending' THEN protocol := protocol-'__model_activation_gate'; END IF;
  IF protocol ? 'provider' AND protocol->'provider' <> 'null'::jsonb AND jsonb_typeof(protocol->'provider') <> 'string' THEN RETURN NULL; END IF;
  IF protocol ? 'protocol' AND protocol->'protocol' <> 'null'::jsonb AND jsonb_typeof(protocol->'protocol') <> 'string' THEN RETURN NULL; END IF;
  endpoint := CASE WHEN p_table='chat_models' THEN r->>'proxy_url' ELSE coalesce(nullif(r->>'api_endpoint',''),r->>'proxy_url') END;
  IF endpoint='' THEN
    IF enabled OR legacy_id !~ '^[A-Za-z0-9_.~-]+$' THEN RETURN NULL; END IF;
    endpoint := 'https://retired.invalid/'||p_table||'/'||legacy_id;
  END IF;
  -- Exact WHATWG URL subset: printable ASCII domain hosts, no userinfo,
  -- percent/dot-segment/Unicode/IPv4-alias/query-key coercion ambiguity.
  IF endpoint !~ '^[A-Za-z0-9:/?&=._~!$()*+,;@%-]+$' OR endpoint ~* '%2e' OR endpoint ~ '(^|/)\.{1,2}(/|\?|$)' THEN RETURN NULL; END IF;
  parts := regexp_match(endpoint,'^(https?)://([A-Za-z0-9][A-Za-z0-9.-]*)(:([0-9]+))?([^?]*)(\?.*)?$','i');
  IF parts IS NULL THEN RETURN NULL; END IF;
  scheme:=lower(parts[1]);host:=lower(parts[2]);port:=parts[4];pathpart:=parts[5];querypart:=coalesce(parts[6],'');
  -- Canonical four-octet decimal IPv4 is already WHATWG-normalized.
  -- Reject short/hex/octal/uint/trailing-dot aliases instead of coercing them.
  IF host ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' THEN
    IF host !~ '^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$' THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM unnest(string_to_array(host,'.')) AS octet(value) WHERE octet.value::integer>255) THEN RETURN NULL; END IF;
  ELSIF host ~ '(^|\.)([0-9]+|0x[0-9a-f]+)\.?$' THEN RETURN NULL;
  END IF;
  IF host ~ '\.\.' OR host ~ '(^|\.)xn--' OR host ~ '^\.|^-|-$' THEN RETURN NULL; END IF;
  IF port IS NOT NULL THEN
    IF length(port)>5 OR port::integer>65535 THEN RETURN NULL; END IF;
    port:=(port::integer)::text;
    IF (scheme='http' AND port='80') OR (scheme='https' AND port='443') THEN port:=NULL; END IF;
  END IF;
  IF pathpart='' THEN pathpart:='/'; ELSIF left(pathpart,1)<>'/' THEN RETURN NULL; END IF;
  IF querypart<>'' THEN
    FOREACH field IN ARRAY string_to_array(substr(querypart,2),'&') LOOP
      textvalue:=split_part(field,'=',1);
      IF textvalue !~ '^[A-Za-z0-9_.-]*$' OR lower(regexp_replace(textvalue,'[^A-Za-z0-9]','','g')) ~ '(apikey|accesstoken|refreshtoken|authorization|password|secret|credential)$|^(token|credentials|servicerolekey|clientsecret)$' THEN RETURN NULL; END IF;
    END LOOP;
  END IF;
  endpoint:=scheme||'://'||host||CASE WHEN port IS NULL THEN '' ELSE ':'||port END||pathpart||querypart;
  namevalue:=coalesce(nullif(r->>'name',''),nullif(r->>'display_name',''),nullif(r->>'model_name',''),legacy_id);
  modelvalue:=coalesce(nullif(r->>'model_name',''),legacy_id);
  providervalue:=coalesce(nullif(r->>'provider',''),nullif(btrim(coalesce(protocol->>'provider',''),trimchars),''),CASE WHEN p_table='chat_models' THEN 'legacy-chat' ELSE 'legacy' END);
  protocolvalue:=coalesce(nullif(r->>'protocol_type',''),nullif(btrim(coalesce(protocol->>'protocol',''),trimchars),''),kind||'-protocol-unconfigured');
  caps:=jsonb_build_object('protocol',protocol);
  IF kind IN ('image','video') THEN
    caps:=caps||jsonb_build_object('supportsImageInput',CASE WHEN jsonb_typeof(r->'supports_image_input')='boolean' THEN r->'supports_image_input' ELSE 'false'::jsonb END);
    IF kind='video' THEN caps:=caps||jsonb_build_object('requiresImage',CASE WHEN jsonb_typeof(r->'requires_image')='boolean' THEN r->'requires_image' ELSE 'false'::jsonb END); END IF;
  ELSE
    caps:=caps||jsonb_build_object('webSearch',CASE WHEN jsonb_typeof(r->'enable_web_search')='boolean' THEN r->'enable_web_search' ELSE 'false'::jsonb END);
    FOREACH field IN ARRAY ARRAY['image_parsing','file_parsing'] LOOP
      IF r->>field<>'' THEN caps:=caps||jsonb_build_object(CASE field WHEN 'image_parsing' THEN 'imageParsing' ELSE 'fileParsing' END,r->field); END IF;
    END LOOP;
  END IF;
  config:=jsonb_build_object('legacyTable',p_table,'legacyId',legacy_id,'protocolConfig',protocol,
    'tokenBillingEnabled',CASE WHEN jsonb_typeof(r->'token_billing_enabled')='boolean' THEN r->'token_billing_enabled' ELSE 'false'::jsonb END);
  FOR field,outputkey IN SELECT * FROM (VALUES ('description','description'),('category','category'),('icon_url','iconUrl'),('admin_notes','adminNotes'),('user_access','userAccess'),('billing_mode','billingMode'),('response_format','responseFormat')) pairs LOOP
    IF r->>field<>'' THEN config:=config||jsonb_build_object(outputkey,r->field); END IF;
  END LOOP;
  IF p_table='video_models' THEN
    FOREACH field IN ARRAY ARRAY['request_template','response_mapping'] LOOP
      IF r ? field AND r->field NOT IN ('null'::jsonb,'""'::jsonb) THEN config:=config||jsonb_build_object(CASE field WHEN 'request_template' THEN 'requestTemplate' ELSE 'responseMapping' END,r->field); END IF;
    END LOOP;
  END IF;
  pricing:=jsonb_build_object('currency',CASE WHEN kind='video' THEN coalesce(nullif(r->>'currency',''),'CNY') ELSE 'CNY' END);
  IF kind='agent' THEN pricing:=pricing||jsonb_build_object('billingMode',coalesce(nullif(r->>'billing_mode',''),'credit')); END IF;
  FOR spec IN SELECT jsonb_array_elements('[
    ["caps","durationSeconds","duration_seconds","video"],["caps","maxDuration","max_duration","video"],["caps","deepThinkingType","deep_thinking_type","agent"],
    ["pricing","cost","cost_price","image"],["pricing","selling","selling_price","image"],
    ["pricing","cost","cost_price","video"],["pricing","selling","price_per_use","video"],
    ["pricing","costPerUse","cost_per_use","video"],["pricing","inputCostPerMillion","input_cost_per_million","video"],["pricing","outputCostPerMillion","output_cost_per_million","video"],
    ["pricing","costPerUse","cost_per_use","agent"],["pricing","costPrice","cost_price","agent"],["pricing","inputCostPerMillion","input_cost_per_million","agent"],["pricing","outputCostPerMillion","output_cost_per_million","agent"],["pricing","cachedCostPerMillion","cached_cost_per_million","agent"],
    ["config","profitMargin","profit_margin","all"],["config","tokenRoundingUnit","token_rounding_unit","all"],["config","maxContextRounds","max_context_rounds","all"],["config","maxContextTokens","max_context_tokens","all"],["config","maxReplyTokens","max_reply_tokens","all"],["config","timeout","timeout","all"],["config","deductDeepThink","deduct_deep_think","all"],["config","frequencyLimit","frequency_limit","all"],["config","temperature","temperature","all"],["sort","sortOrder","sort_order","all"]
  ]'::jsonb) LOOP
    IF spec->>3 NOT IN (kind,'all') THEN CONTINUE; END IF;
    destination:=spec->>0;outputkey:=spec->>1;sourcekey:=spec->>2;
    value:=r->sourcekey;
    IF kind='image' AND sourcekey='selling_price' AND (value IS NULL OR value='null'::jsonb) THEN value:=r->'cost_per_use'; END IF;
    IF kind='video' AND sourcekey='price_per_use' AND (value IS NULL OR value='null'::jsonb) THEN value:=r->'cost_per_use'; END IF;
    IF value IS NULL OR value IN ('null'::jsonb,'""'::jsonb) THEN CONTINUE; END IF;
    IF jsonb_typeof(value)='boolean' THEN numbervalue:=CASE WHEN value='true'::jsonb THEN 1 ELSE 0 END;
    ELSIF jsonb_typeof(value) IN ('number','string') THEN
      textvalue:=btrim(value #>> '{}',trimchars);
      IF textvalue='' THEN numbervalue:=0;
      ELSIF textvalue ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' THEN
        BEGIN numbervalue:=textvalue::double precision; EXCEPTION WHEN numeric_value_out_of_range THEN RETURN NULL; END;
      ELSE RETURN NULL;
      END IF;
    ELSE RETURN NULL;
    END IF;
    IF numbervalue::text IN ('Infinity','-Infinity','NaN') THEN RETURN NULL; END IF;
    IF destination='caps' THEN caps:=caps||jsonb_build_object(outputkey,numbervalue);
    ELSIF destination='pricing' THEN pricing:=pricing||jsonb_build_object(outputkey,numbervalue);
    ELSIF destination='config' THEN config:=config||jsonb_build_object(outputkey,numbervalue);
    ELSE sortvalue:=greatest(0,floor(numbervalue+0.5)); END IF;
  END LOOP;
  IF sortvalue>9007199254740991 THEN RETURN NULL; END IF;
  result:=jsonb_build_object('id',CASE p_table WHEN 'llm_models' THEN 'llm:'||legacy_id WHEN 'chat_models' THEN 'chat:'||legacy_id ELSE legacy_id END,
    'kind',kind,'name',namevalue,'modelName',modelvalue,'provider',providervalue,'protocol',protocolvalue,'endpoint',endpoint,
    'catalogState',CASE WHEN enabled THEN 'enabled' ELSE 'retired' END,'sortOrder',sortvalue,'capabilities',caps,'pricing',pricing,'configuration',config);
  IF length(result->>'id')>200 OR result->>'id' ~ '[[:space:][:cntrl:]]' OR length(namevalue)>200 OR length(modelvalue)>300 OR length(providervalue)>160 OR length(protocolvalue)>120 OR length(endpoint)>2000 THEN RETURN NULL; END IF;
  IF r->>'api_key'<>'' THEN result:=result||jsonb_build_object('credentialRef','secret://platform-model/'||p_table||'/'||legacy_id); END IF;
  -- Match normalizeJson's secret-key rejection before emitting any nested config.
  IF EXISTS (
    WITH RECURSIVE walk(value,key) AS (
      SELECT result,NULL::text UNION ALL
      SELECT child.value,child.key FROM walk w CROSS JOIN LATERAL (
        SELECT e.value,e.key FROM jsonb_each(CASE WHEN jsonb_typeof(w.value)='object' THEN w.value ELSE '{}'::jsonb END) e
        UNION ALL SELECT a.value,NULL::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.value)='array' THEN w.value ELSE '[]'::jsonb END) a
      ) child
    ) SELECT 1 FROM walk AS item WHERE
      (lower(regexp_replace(coalesce(item.key,''),'[^A-Za-z0-9]','','g')) <> 'credentialref' AND lower(regexp_replace(coalesce(item.key,''),'[^A-Za-z0-9]','','g')) ~ '(apikey|accesstoken|refreshtoken|authorization|password|secret|credential)$|^(credentials|servicerolekey|token|clientsecret)$')
      OR (lower(regexp_replace(coalesce(item.key,''),'[^A-Za-z0-9]','','g'))='credentialref' AND (jsonb_typeof(item.value)<>'string' OR (item.value #>> '{}') IS DISTINCT FROM btrim(item.value #>> '{}',trimchars) OR btrim(item.value #>> '{}',trimchars) !~ '^(env|secret)://[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$'))
      OR (jsonb_typeof(item.value)='string' AND length(item.value #>> '{}')>20000)
  ) THEN RETURN NULL; END IF;
  RETURN result;
END;
$entry$;
REVOKE ALL ON FUNCTION public.model_pool_initial_live_entry(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.model_pool_projection_delta(p_snapshot jsonb)
RETURNS TABLE(legacy_table text,legacy_id text,removed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $delta$
DECLARE d record; candidate jsonb; baseline jsonb; matches integer; physical_key text; binding_key text;
BEGIN
  -- All ordinary/current-release behavior stays in the original pinned body.
  IF EXISTS (SELECT 1 FROM public.model_pool_config_releases r WHERE r.is_current AND r.status='published') THEN
    RETURN QUERY SELECT * FROM public.model_pool_projection_delta_before_initial_live_baseline(p_snapshot);
    RETURN;
  END IF;
  FOR d IN SELECT * FROM public.model_pool_projection_delta_before_initial_live_baseline(p_snapshot) LOOP
    IF d.removed THEN RAISE EXCEPTION 'MODEL_POOL_INITIAL_REMOVAL_UNEXPECTED'; END IF;
    SELECT count(*),(jsonb_agg(m.model)->0) INTO matches,candidate FROM jsonb_array_elements(p_snapshot->'models') m(model)
      WHERE m.model #>> '{configuration,legacyTable}'=d.legacy_table AND m.model #>> '{configuration,legacyId}'=d.legacy_id;
    IF matches<>1 THEN RAISE EXCEPTION 'MODEL_POOL_INITIAL_IDENTITY_AMBIGUOUS'; END IF;
    baseline:=public.model_pool_initial_live_entry(d.legacy_table,d.legacy_id);
    IF baseline IS NULL OR baseline IS DISTINCT FROM candidate THEN
      legacy_table:=d.legacy_table;legacy_id:=d.legacy_id;removed:=false;RETURN NEXT;CONTINUE;
    END IF;
    SELECT p.api_key INTO physical_key FROM (
      SELECT 'cover_models'::text tbl,id::text id,api_key FROM public.cover_models UNION ALL
      SELECT 'video_models',id::text,api_key FROM public.video_models UNION ALL
      SELECT 'llm_models',id::text,api_key FROM public.llm_models UNION ALL
      SELECT 'chat_models',id::text,api_key FROM public.chat_models
    ) p WHERE p.tbl=d.legacy_table AND p.id=d.legacy_id;
    SELECT b.secret_value INTO binding_key FROM public.platform_model_credential_bindings b WHERE b.credential_ref=candidate->>'credentialRef';
    IF coalesce(binding_key,'')<>'' AND binding_key IS DISTINCT FROM physical_key THEN
      legacy_table:=d.legacy_table;legacy_id:=d.legacy_id;removed:=false;RETURN NEXT;
    END IF;
  END LOOP;
END;
$delta$;
-- Preserve the exact pre-existing definer authority. No raw-table GRANTs.
DO $preserve_owner$
DECLARE original_owner text;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO STRICT original_owner FROM pg_proc p
    WHERE p.oid='public.model_pool_projection_delta_before_initial_live_baseline(jsonb)'::regprocedure;
  IF original_owner NOT IN ('postgres','zimeiti_owner') THEN
    RAISE EXCEPTION 'MODEL_POOL_INITIAL_BASELINE_OWNER_CHANGED';
  END IF;
  EXECUTE format('ALTER FUNCTION public.model_pool_initial_live_entry(text,text) OWNER TO %I',original_owner);
  EXECUTE format('ALTER FUNCTION public.model_pool_projection_delta(jsonb) OWNER TO %I',original_owner);
END $preserve_owner$;
REVOKE ALL ON FUNCTION public.model_pool_projection_delta(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.model_pool_projection_delta(jsonb) TO service_role;
-- Native production already allowed this owner role to call the original
-- delta. Retain that exact function-level access; never grant table access.
DO $preserve_execute$
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid='public.model_pool_projection_delta_before_initial_live_baseline(jsonb)'::regprocedure)='postgres' THEN
    GRANT EXECUTE ON FUNCTION public.model_pool_projection_delta(jsonb) TO zimeiti_owner;
  END IF;
END $preserve_execute$;
COMMIT;
