BEGIN;
SET LOCAL lock_timeout = '10s';

-- Never remove recorded backup, restore, verification, RPO/RTO, request, or
-- audit evidence. Once any such row exists, use a reviewed forward migration.
DO $backup_restore_rollback_guard$
DECLARE
  v_count integer;
BEGIN
  IF to_regclass('public.backup_control_events') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.backup_control_events LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;
  IF to_regclass('public.backup_rpo_rto_receipts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.backup_rpo_rto_receipts LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;
  IF to_regclass('public.restore_verification_checks') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.restore_verification_checks LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;
  IF to_regclass('public.restore_drills') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.restore_drills LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;
  IF to_regclass('public.backup_retention_evidence') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.backup_retention_evidence LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;
  IF to_regclass('public.backup_artifacts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.backup_artifacts LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;
  IF to_regclass('public.backup_runs') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.backup_runs LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;
  IF to_regclass('public.backup_control_requests') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.backup_control_requests LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE';
  END IF;

  IF to_regclass('public.backup_control_targets') IS NOT NULL THEN
    SELECT count(*)::integer INTO v_count FROM public.backup_control_targets;
    IF v_count NOT IN (0, 7)
       OR EXISTS (
         WITH expected(
           target_key,display_name,system_of_record,backup_method,
           rpo_label,rto_label,rpo_seconds,rto_seconds
         ) AS (VALUES
           ('source','源代码','private Git origin','independent private Git mirror plus signed release tags','24h','4h',86400,14400),
           ('artifacts','发布产物','immutable artifact registry or COS','versioning plus cross-account or cross-region copy','per release','1h',NULL::integer,3600),
           ('public-assets','公共静态资产','versioned COS/CDN objects','content hashes, object versioning, inventory and independent copy','24h','4h',86400,14400),
           ('database','主业务数据库','managed production database','PITR plus encrypted logical backup with schema coverage verification','5m','2h',300,7200),
           ('wallet-ledger','钱包与账本','production database append-only ledger','PITR plus daily encrypted immutable snapshot and reconciliation','1m','4h',60,14400),
           ('user-assets','用户私有资产','private object storage plus database metadata','object versioning plus database/object joint inventory','15m','4h',900,14400),
           ('secrets','凭据与恢复包','secret manager or protected server environment','controlled encrypted recovery package and key rotation history','24h','2h',86400,7200)
         )
         SELECT 1
           FROM public.backup_control_targets t
           LEFT JOIN expected e ON e.target_key=t.target_key
          WHERE e.target_key IS NULL
             OR t.display_name IS DISTINCT FROM e.display_name
             OR t.data_class IS DISTINCT FROM e.target_key
             OR t.policy_system_of_record IS DISTINCT FROM e.system_of_record
             OR t.policy_backup_method IS DISTINCT FROM e.backup_method
             OR t.objective_rpo_label IS DISTINCT FROM e.rpo_label
             OR t.objective_rto_label IS DISTINCT FROM e.rto_label
             OR t.objective_rpo_seconds IS DISTINCT FROM e.rpo_seconds
             OR t.objective_rto_seconds IS DISTINCT FROM e.rto_seconds
             OR t.operational_status <> 'unavailable'
             OR t.status_reason <> 'NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE'
             OR t.provider_name IS NOT NULL
             OR t.external_account_ref IS NOT NULL
             OR t.external_region IS NOT NULL
             OR t.storage_locator IS NOT NULL
             OR t.retention_evidence_status <> 'unavailable'
             OR t.immutability_evidence_status <> 'unavailable'
             OR t.encryption_evidence_status <> 'unavailable'
             OR t.replication_evidence_status <> 'unavailable'
             OR t.pitr_evidence_status <> 'unavailable'
             OR t.latest_successful_backup_at IS NOT NULL
             OR t.latest_verified_at IS NOT NULL
             OR t.revision <> 1
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'BACKUP_RESTORE_ROLLBACK_REQUIRES_UNCHANGED_TARGET_SEED';
    END IF;
  END IF;
END;
$backup_restore_rollback_guard$;

DROP TABLE IF EXISTS public.backup_control_events;
DROP TABLE IF EXISTS public.backup_rpo_rto_receipts;
DROP TABLE IF EXISTS public.restore_verification_checks;
DROP TABLE IF EXISTS public.restore_drills;
DROP TABLE IF EXISTS public.backup_retention_evidence;
DROP TABLE IF EXISTS public.backup_artifacts;
DROP TABLE IF EXISTS public.backup_runs;
DROP TABLE IF EXISTS public.backup_control_requests;
DROP TABLE IF EXISTS public.backup_control_targets;

NOTIFY pgrst, 'reload schema';
COMMIT;
