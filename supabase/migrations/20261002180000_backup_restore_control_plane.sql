BEGIN;
SET LOCAL lock_timeout = '10s';

-- Phase one records evidence and approvals only. It does not execute backups,
-- restores, deletions, service switches, or external uploads.
CREATE TABLE IF NOT EXISTS public.backup_control_targets (
  target_key text PRIMARY KEY CHECK (
    length(target_key) BETWEEN 2 AND 80
    AND target_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  data_class text NOT NULL CHECK (length(btrim(data_class)) BETWEEN 1 AND 80),
  policy_system_of_record text NOT NULL CHECK (length(btrim(policy_system_of_record)) BETWEEN 1 AND 500),
  policy_backup_method text NOT NULL CHECK (length(btrim(policy_backup_method)) BETWEEN 1 AND 1000),
  objective_rpo_label text NOT NULL CHECK (length(btrim(objective_rpo_label)) BETWEEN 1 AND 40),
  objective_rto_label text NOT NULL CHECK (length(btrim(objective_rto_label)) BETWEEN 1 AND 40),
  objective_rpo_seconds integer CHECK (objective_rpo_seconds IS NULL OR objective_rpo_seconds > 0),
  objective_rto_seconds integer CHECK (objective_rto_seconds IS NULL OR objective_rto_seconds > 0),
  operational_status text NOT NULL DEFAULT 'unavailable'
    CHECK (operational_status IN ('unavailable','configured','healthy','degraded','failed')),
  status_reason text NOT NULL DEFAULT 'NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE'
    CHECK (length(status_reason) BETWEEN 2 AND 120 AND status_reason ~ '^[A-Z][A-Z0-9_]*$'),
  provider_name text,
  external_account_ref text,
  external_region text,
  storage_locator text,
  retention_evidence_status text NOT NULL DEFAULT 'unavailable'
    CHECK (retention_evidence_status IN ('unavailable','recorded','verified','failed','expired')),
  immutability_evidence_status text NOT NULL DEFAULT 'unavailable'
    CHECK (immutability_evidence_status IN ('unavailable','recorded','verified','failed','expired')),
  encryption_evidence_status text NOT NULL DEFAULT 'unavailable'
    CHECK (encryption_evidence_status IN ('unavailable','recorded','verified','failed','expired')),
  replication_evidence_status text NOT NULL DEFAULT 'unavailable'
    CHECK (replication_evidence_status IN ('unavailable','recorded','verified','failed','expired')),
  pitr_evidence_status text NOT NULL DEFAULT 'unavailable'
    CHECK (pitr_evidence_status IN ('unavailable','recorded','verified','failed','expired')),
  latest_successful_backup_at timestamptz,
  latest_verified_at timestamptz,
  source_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_evidence) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    operational_status <> 'healthy'
    OR (latest_successful_backup_at IS NOT NULL AND latest_verified_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.backup_control_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key text NOT NULL REFERENCES public.backup_control_targets(target_key) ON DELETE RESTRICT,
  operation_kind text NOT NULL CHECK (operation_kind IN ('backup_plan','restore_drill_plan')),
  request_status text NOT NULL DEFAULT 'planned'
    CHECK (request_status IN ('planned','requested','approved','rejected','cancelled','expired')),
  execution_mode text NOT NULL DEFAULT 'plan_request_approval_only'
    CHECK (execution_mode = 'plan_request_approval_only'),
  plan jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(plan) = 'object'),
  requested_by text,
  requested_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  approval_reason text,
  execution_enabled boolean NOT NULL DEFAULT false CHECK (execution_enabled IS FALSE),
  external_upload_enabled boolean NOT NULL DEFAULT false CHECK (external_upload_enabled IS FALSE),
  restore_enabled boolean NOT NULL DEFAULT false CHECK (restore_enabled IS FALSE),
  delete_enabled boolean NOT NULL DEFAULT false CHECK (delete_enabled IS FALSE),
  service_switch_enabled boolean NOT NULL DEFAULT false CHECK (service_switch_enabled IS FALSE),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    request_status NOT IN ('requested','approved')
    OR (requested_by IS NOT NULL AND requested_at IS NOT NULL)
  ),
  CHECK (
    request_status <> 'approved'
    OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND approval_reason IS NOT NULL
      AND approved_by <> requested_by
    )
  )
);

CREATE INDEX IF NOT EXISTS backup_control_requests_target_idx
  ON public.backup_control_requests(target_key, created_at DESC);
CREATE INDEX IF NOT EXISTS backup_control_requests_status_idx
  ON public.backup_control_requests(request_status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.backup_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key text NOT NULL REFERENCES public.backup_control_targets(target_key) ON DELETE RESTRICT,
  request_id uuid REFERENCES public.backup_control_requests(request_id) ON DELETE RESTRICT,
  run_kind text NOT NULL CHECK (run_kind IN ('full','incremental','pitr','snapshot','logical','source_mirror','artifact_copy','object_inventory')),
  environment text NOT NULL CHECK (environment IN ('production','isolated','development','unavailable')),
  status text NOT NULL CHECK (status IN ('planned','requested','approved','running','succeeded','failed','cancelled','unavailable')),
  started_at timestamptz,
  finished_at timestamptz,
  restore_point_at timestamptz,
  artifact_count integer CHECK (artifact_count IS NULL OR artifact_count >= 0),
  total_bytes bigint CHECK (total_bytes IS NULL OR total_bytes >= 0),
  manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_uri text,
  external_run_ref text,
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK (
    status <> 'succeeded'
    OR (
      environment <> 'unavailable'
      AND started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND restore_point_at IS NOT NULL
      AND artifact_count IS NOT NULL
      AND artifact_count > 0
      AND total_bytes IS NOT NULL
      AND total_bytes > 0
      AND manifest_sha256 IS NOT NULL
      AND evidence_uri IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS backup_runs_target_idx
  ON public.backup_runs(target_key, created_at DESC);
CREATE INDEX IF NOT EXISTS backup_runs_status_idx
  ON public.backup_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.backup_artifacts (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.backup_runs(run_id) ON DELETE RESTRICT,
  artifact_key text NOT NULL CHECK (length(btrim(artifact_key)) BETWEEN 1 AND 300),
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('manifest','database_dump','table_export','object_inventory','source_bundle','release_bundle','other')),
  storage_uri text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  checksum_verified_at timestamptz,
  evidence_status text NOT NULL DEFAULT 'unavailable'
    CHECK (evidence_status IN ('unavailable','recorded','verified','failed','expired')),
  retention_until timestamptz,
  immutable_until timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, artifact_key),
  CHECK (
    evidence_status <> 'verified'
    OR (
      storage_uri IS NOT NULL
      AND size_bytes IS NOT NULL
      AND sha256 IS NOT NULL
      AND checksum_verified_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS backup_artifacts_run_idx
  ON public.backup_artifacts(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.backup_retention_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key text NOT NULL REFERENCES public.backup_control_targets(target_key) ON DELETE RESTRICT,
  run_id uuid REFERENCES public.backup_runs(run_id) ON DELETE RESTRICT,
  artifact_id uuid REFERENCES public.backup_artifacts(artifact_id) ON DELETE RESTRICT,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('retention','immutability','encryption','replication','pitr')),
  evidence_status text NOT NULL DEFAULT 'unavailable'
    CHECK (evidence_status IN ('unavailable','recorded','verified','failed','expired')),
  observed_at timestamptz,
  valid_until timestamptz,
  evidence_uri text,
  checksum_sha256 text CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    evidence_status <> 'verified'
    OR (
      observed_at IS NOT NULL
      AND evidence_uri IS NOT NULL
      AND checksum_sha256 IS NOT NULL
      AND (evidence_kind NOT IN ('retention','immutability') OR valid_until IS NOT NULL)
    )
  )
);

CREATE INDEX IF NOT EXISTS backup_retention_evidence_target_idx
  ON public.backup_retention_evidence(target_key, evidence_kind, observed_at DESC);

CREATE TABLE IF NOT EXISTS public.restore_drills (
  drill_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key text NOT NULL REFERENCES public.backup_control_targets(target_key) ON DELETE RESTRICT,
  source_run_id uuid REFERENCES public.backup_runs(run_id) ON DELETE RESTRICT,
  request_id uuid REFERENCES public.backup_control_requests(request_id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('planned','requested','approved','running','succeeded','failed','cancelled','unavailable')),
  environment_kind text NOT NULL DEFAULT 'unavailable'
    CHECK (environment_kind IN ('isolated','production','unavailable')),
  restore_point_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  isolation_verified boolean,
  production_write_count integer CHECK (production_write_count IS NULL OR production_write_count >= 0),
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  error_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK (
    status <> 'succeeded'
    OR (
      environment_kind = 'isolated'
      AND source_run_id IS NOT NULL
      AND restore_point_at IS NOT NULL
      AND started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND isolation_verified IS TRUE
      AND production_write_count IS NOT NULL
      AND production_write_count = 0
      AND evidence_uri IS NOT NULL
      AND evidence_sha256 IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS restore_drills_target_idx
  ON public.restore_drills(target_key, created_at DESC);
CREATE INDEX IF NOT EXISTS restore_drills_status_idx
  ON public.restore_drills(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.restore_verification_checks (
  check_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_id uuid NOT NULL REFERENCES public.restore_drills(drill_id) ON DELETE RESTRICT,
  check_key text NOT NULL CHECK (
    length(check_key) BETWEEN 2 AND 100
    AND check_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  check_scope text NOT NULL CHECK (check_scope IN ('users','auth','ledger','config','objects','schema','other')),
  status text NOT NULL DEFAULT 'not_run' CHECK (status IN ('not_run','passed','failed','unavailable')),
  expected_count bigint CHECK (expected_count IS NULL OR expected_count >= 0),
  observed_count bigint CHECK (observed_count IS NULL OR observed_count >= 0),
  expected_digest text,
  observed_digest text,
  checked_at timestamptz,
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drill_id, check_key),
  CHECK (
    status <> 'passed'
    OR (
      checked_at IS NOT NULL
      AND evidence_uri IS NOT NULL
      AND evidence_sha256 IS NOT NULL
      AND (
        (expected_count IS NOT NULL AND observed_count IS NOT NULL)
        OR (expected_digest IS NOT NULL AND observed_digest IS NOT NULL)
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS restore_verification_checks_drill_idx
  ON public.restore_verification_checks(drill_id, check_scope);

CREATE TABLE IF NOT EXISTS public.backup_rpo_rto_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_id uuid NOT NULL REFERENCES public.restore_drills(drill_id) ON DELETE RESTRICT,
  target_key text NOT NULL REFERENCES public.backup_control_targets(target_key) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'unavailable'
    CHECK (status IN ('unavailable','recorded','verified','failed','expired')),
  observed_rpo_seconds integer CHECK (observed_rpo_seconds IS NULL OR observed_rpo_seconds >= 0),
  observed_rto_seconds integer CHECK (observed_rto_seconds IS NULL OR observed_rto_seconds >= 0),
  measured_at timestamptz,
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drill_id, target_key),
  CHECK (
    status <> 'verified'
    OR (
      observed_rpo_seconds IS NOT NULL
      AND observed_rto_seconds IS NOT NULL
      AND measured_at IS NOT NULL
      AND evidence_uri IS NOT NULL
      AND evidence_sha256 IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS backup_rpo_rto_receipts_target_idx
  ON public.backup_rpo_rto_receipts(target_key, measured_at DESC);

CREATE TABLE IF NOT EXISTS public.backup_control_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key text REFERENCES public.backup_control_targets(target_key) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type IN ('control_plane','target','request','run','artifact','evidence','drill','check','receipt')),
  entity_id text,
  event_kind text NOT NULL CHECK (
    length(event_kind) BETWEEN 2 AND 100
    AND event_kind ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  event_status text NOT NULL CHECK (event_status IN ('info','planned','requested','approved','rejected','unavailable','succeeded','failed')),
  actor_id text,
  happened_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_control_events_target_idx
  ON public.backup_control_events(target_key, happened_at DESC);
CREATE INDEX IF NOT EXISTS backup_control_events_entity_idx
  ON public.backup_control_events(entity_type, entity_id, happened_at DESC);

ALTER TABLE public.backup_control_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_control_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_retention_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_drills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_verification_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_rpo_rto_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_control_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.backup_control_targets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_control_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_artifacts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_retention_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.restore_drills FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.restore_verification_checks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_rpo_rto_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_control_events FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.backup_control_targets FROM service_role;
REVOKE ALL ON TABLE public.backup_control_requests FROM service_role;
REVOKE ALL ON TABLE public.backup_runs FROM service_role;
REVOKE ALL ON TABLE public.backup_artifacts FROM service_role;
REVOKE ALL ON TABLE public.backup_retention_evidence FROM service_role;
REVOKE ALL ON TABLE public.restore_drills FROM service_role;
REVOKE ALL ON TABLE public.restore_verification_checks FROM service_role;
REVOKE ALL ON TABLE public.backup_rpo_rto_receipts FROM service_role;
REVOKE ALL ON TABLE public.backup_control_events FROM service_role;

GRANT SELECT ON TABLE public.backup_control_targets TO service_role;
GRANT SELECT ON TABLE public.backup_control_requests TO service_role;
GRANT SELECT ON TABLE public.backup_runs TO service_role;
GRANT SELECT ON TABLE public.backup_artifacts TO service_role;
GRANT SELECT ON TABLE public.backup_retention_evidence TO service_role;
GRANT SELECT ON TABLE public.restore_drills TO service_role;
GRANT SELECT ON TABLE public.restore_verification_checks TO service_role;
GRANT SELECT ON TABLE public.backup_rpo_rto_receipts TO service_role;
GRANT SELECT ON TABLE public.backup_control_events TO service_role;

INSERT INTO public.backup_control_targets (
  target_key, display_name, data_class,
  policy_system_of_record, policy_backup_method,
  objective_rpo_label, objective_rto_label,
  objective_rpo_seconds, objective_rto_seconds,
  operational_status, status_reason,
  retention_evidence_status, immutability_evidence_status,
  encryption_evidence_status, replication_evidence_status, pitr_evidence_status,
  source_evidence
) VALUES
  ('source','源代码','source','private Git origin','independent private Git mirror plus signed release tags','24h','4h',86400,14400,'unavailable','NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE','unavailable','unavailable','unavailable','unavailable','unavailable','[{"source":"deploy/policies/backup-policy.json","classId":"source","evidenceType":"policy_declaration"}]'::jsonb),
  ('artifacts','发布产物','artifacts','immutable artifact registry or COS','versioning plus cross-account or cross-region copy','per release','1h',NULL,3600,'unavailable','NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE','unavailable','unavailable','unavailable','unavailable','unavailable','[{"source":"deploy/policies/backup-policy.json","classId":"artifacts","evidenceType":"policy_declaration"}]'::jsonb),
  ('public-assets','公共静态资产','public-assets','versioned COS/CDN objects','content hashes, object versioning, inventory and independent copy','24h','4h',86400,14400,'unavailable','NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE','unavailable','unavailable','unavailable','unavailable','unavailable','[{"source":"deploy/policies/backup-policy.json","classId":"public-assets","evidenceType":"policy_declaration"}]'::jsonb),
  ('database','主业务数据库','database','managed production database','PITR plus encrypted logical backup with schema coverage verification','5m','2h',300,7200,'unavailable','NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE','unavailable','unavailable','unavailable','unavailable','unavailable','[{"source":"deploy/policies/backup-policy.json","classId":"database","evidenceType":"policy_declaration"},{"source":"runtime-tools/backup-data.sh","evidenceType":"script_exists_not_execution_receipt"},{"source":"scripts/cos-data-snapshot.mjs","evidenceType":"script_exists_not_execution_receipt"}]'::jsonb),
  ('wallet-ledger','钱包与账本','wallet-ledger','production database append-only ledger','PITR plus daily encrypted immutable snapshot and reconciliation','1m','4h',60,14400,'unavailable','NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE','unavailable','unavailable','unavailable','unavailable','unavailable','[{"source":"deploy/policies/backup-policy.json","classId":"wallet-ledger","evidenceType":"policy_declaration"}]'::jsonb),
  ('user-assets','用户私有资产','user-assets','private object storage plus database metadata','object versioning plus database/object joint inventory','15m','4h',900,14400,'unavailable','NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE','unavailable','unavailable','unavailable','unavailable','unavailable','[{"source":"deploy/policies/backup-policy.json","classId":"user-assets","evidenceType":"policy_declaration"}]'::jsonb),
  ('secrets','凭据与恢复包','secrets','secret manager or protected server environment','controlled encrypted recovery package and key rotation history','24h','2h',86400,7200,'unavailable','NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE','unavailable','unavailable','unavailable','unavailable','unavailable','[{"source":"deploy/policies/backup-policy.json","classId":"secrets","evidenceType":"policy_declaration"}]'::jsonb)
ON CONFLICT (target_key) DO NOTHING;

-- Reapplying the migration must not turn a conflicting target into a success.
DO $backup_restore_seed_guard$
BEGIN
  IF EXISTS (
    WITH expected(target_key,display_name,rpo_label,rto_label,rpo_seconds,rto_seconds) AS (VALUES
      ('source','源代码','24h','4h',86400,14400),
      ('artifacts','发布产物','per release','1h',NULL::integer,3600),
      ('public-assets','公共静态资产','24h','4h',86400,14400),
      ('database','主业务数据库','5m','2h',300,7200),
      ('wallet-ledger','钱包与账本','1m','4h',60,14400),
      ('user-assets','用户私有资产','15m','4h',900,14400),
      ('secrets','凭据与恢复包','24h','2h',86400,7200)
    )
    SELECT 1
      FROM expected e
      LEFT JOIN public.backup_control_targets t ON t.target_key=e.target_key
     WHERE t.target_key IS NULL
        OR t.display_name IS DISTINCT FROM e.display_name
        OR t.data_class IS DISTINCT FROM e.target_key
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
        OR t.latest_successful_backup_at IS NOT NULL
        OR t.latest_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'BACKUP_RESTORE_TARGET_SEED_CONFLICT';
  END IF;
END;
$backup_restore_seed_guard$;

COMMENT ON TABLE public.backup_control_targets IS
  'Policy-scoped backup targets; unavailable means no current external execution evidence has been registered.';
COMMENT ON TABLE public.backup_control_requests IS
  'Plan/request/approval records only; phase-one constraints prohibit execution, upload, restore, delete, and service switch.';
COMMENT ON TABLE public.backup_runs IS
  'Evidence-backed backup run receipts; succeeded requires manifest checksum, artifact count, bytes, restore point, and receipt URI.';
COMMENT ON TABLE public.restore_drills IS
  'Isolation-only restore drill receipts; succeeded requires verified isolation and zero production writes.';
COMMENT ON TABLE public.backup_control_events IS
  'Backup and restore control-plane status/audit events; clients have read-only access through the server.';

NOTIFY pgrst, 'reload schema';
COMMIT;
