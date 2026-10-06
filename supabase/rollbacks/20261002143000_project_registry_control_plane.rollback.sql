BEGIN;
SET LOCAL lock_timeout = '10s';

-- Guarded rollback: only the untouched code-seeded registry may be removed.
-- Any later project/source registration requires a reviewed forward repair.
DO $project_registry_rollback_guard$
DECLARE
  v_count integer;
BEGIN
  IF to_regclass('public.project_source_registry') IS NOT NULL THEN
    SELECT count(*)::integer INTO v_count FROM public.project_source_registry;
    IF v_count NOT IN (0, 10)
       OR EXISTS (
         WITH expected(source_kind,source_key,evidence_path) AS (VALUES
           ('task','llm_request_attempts','src/lib/server/admin-command-center.ts'),
           ('task','image_generation_requests','src/lib/server/admin-command-center.ts'),
           ('task','video_tasks','src/lib/server/admin-command-center.ts'),
           ('task','voice_generation_requests','src/lib/server/admin-command-center.ts'),
           ('task','extraction_attempts','src/lib/server/admin-command-center.ts'),
           ('billing','revenue_records','src/lib/server/admin-command-center.ts'),
           ('billing','credit_transactions','src/lib/billing-source-catalog.ts'),
           ('billing','cash_transactions','src/lib/billing.ts'),
           ('notification','user_notifications','src/lib/user-notification-server.ts'),
           ('notification','announcements','src/lib/announcement-delivery-server.ts')
         )
         SELECT 1
           FROM public.project_source_registry s
           LEFT JOIN expected e
             ON e.source_kind=s.source_kind AND e.source_key=s.source_key
          WHERE e.source_key IS NULL
             OR s.revision <> 1
             OR s.mapping_status <> 'unregistered'
             OR s.project_key IS NOT NULL
             OR s.project_key_field IS NOT NULL
             OR s.evidence_path IS DISTINCT FROM e.evidence_path
             OR s.reason_code <> 'SOURCE_HAS_NO_PROJECT_KEY'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'PROJECT_REGISTRY_ROLLBACK_REQUIRES_UNCHANGED_SOURCE_SEED';
    END IF;
  END IF;

  IF to_regclass('public.project_workspace_registry') IS NOT NULL THEN
    SELECT count(*)::integer INTO v_count FROM public.project_workspace_registry;
    IF v_count NOT IN (0, 9)
       OR EXISTS (
         WITH expected(workspace_key,display_name,route,sort_order) AS (VALUES
           ('marketplace','应用广场','/',10),
           ('toolbox','效率工具','/tools',11),
           ('storyboard_workbench','分镜编排','/storyboard-workbench',12),
           ('image_workbench','图像生成','/image-workbench',13),
           ('create','视频创作','/video',14),
           ('voice','声音制作','/voice-studio/workspace',15),
           ('cover','封面设计','/cover',16),
           ('youcai','漫剧创作','/youcai',17),
           ('commerce_agent','带货创作','/commerce',18)
         )
         SELECT 1
           FROM public.project_workspace_registry w
           LEFT JOIN expected e ON e.workspace_key=w.workspace_key
          WHERE e.workspace_key IS NULL
             OR w.revision <> 1
             OR w.mapping_status <> 'mapped'
             OR w.project_key IS DISTINCT FROM e.workspace_key
             OR w.display_name IS DISTINCT FROM e.display_name
             OR w.route IS DISTINCT FROM e.route
             OR w.source_catalog <> 'PRIMARY_NAVIGATION'
             OR w.source_evidence IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
               'source','src/lib/marketplace-navigation.ts','workspaceKey',e.workspace_key
             ))
             OR w.sort_order <> e.sort_order
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'PROJECT_REGISTRY_ROLLBACK_REQUIRES_UNCHANGED_WORKSPACE_SEED';
    END IF;
  END IF;

  IF to_regclass('public.project_registry') IS NOT NULL THEN
    SELECT count(*)::integer INTO v_count FROM public.project_registry;
    IF v_count NOT IN (0, 10)
       OR EXISTS (
         WITH expected(project_key,parent_project_key,display_name,primary_route,sort_order) AS (VALUES
           ('zimeiti-caopanshou',NULL::text,'自媒体操盘手',NULL::text,0),
           ('marketplace','zimeiti-caopanshou','应用广场','/',10),
           ('toolbox','zimeiti-caopanshou','效率工具','/tools',11),
           ('storyboard_workbench','zimeiti-caopanshou','分镜编排','/storyboard-workbench',12),
           ('image_workbench','zimeiti-caopanshou','图像生成','/image-workbench',13),
           ('create','zimeiti-caopanshou','视频创作','/video',14),
           ('voice','zimeiti-caopanshou','声音制作','/voice-studio/workspace',15),
           ('cover','zimeiti-caopanshou','封面设计','/cover',16),
           ('youcai','zimeiti-caopanshou','漫剧创作','/youcai',17),
           ('commerce_agent','zimeiti-caopanshou','带货创作','/commerce',18)
         )
         SELECT 1
           FROM public.project_registry p
           LEFT JOIN expected e ON e.project_key=p.project_key
          WHERE e.project_key IS NULL
             OR p.parent_project_key IS DISTINCT FROM e.parent_project_key
             OR p.display_name IS DISTINCT FROM e.display_name
             OR p.internal_name IS DISTINCT FROM e.project_key
             OR p.primary_route IS DISTINCT FROM e.primary_route
             OR p.responsible_owner IS NOT NULL
             OR p.lifecycle_status <> 'active'
             OR p.registration_status <> 'partial'
             OR p.accepts_new_business IS NOT TRUE
             OR p.sla_profile IS DISTINCT FROM '{"status":"unregistered"}'::jsonb
             OR p.tenant_support <> 'unknown'
             OR p.allowed_message_surfaces <> '{}'::text[]
             OR p.source_evidence IS DISTINCT FROM CASE
               WHEN p.project_key='zimeiti-caopanshou' THEN
                 '[{"source":"deploy/policies/release-policy.json","field":"projectId","value":"zimeiti-caopanshou"}]'::jsonb
               ELSE jsonb_build_array(jsonb_build_object(
                 'source','src/lib/marketplace-navigation.ts',
                 'symbol','PRIMARY_NAVIGATION',
                 'workspaceKey',p.project_key
               ))
             END
             OR p.sort_order <> e.sort_order
             OR p.revision <> 1
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'PROJECT_REGISTRY_ROLLBACK_REQUIRES_UNCHANGED_PROJECT_SEED';
    END IF;
  END IF;
END;
$project_registry_rollback_guard$;

DROP TABLE IF EXISTS public.project_source_registry;
DROP TABLE IF EXISTS public.project_workspace_registry;
DROP TABLE IF EXISTS public.project_registry;

NOTIFY pgrst, 'reload schema';
COMMIT;
