BEGIN;

DROP FUNCTION IF EXISTS autodl_h3_mark_job_progress(text, uuid, text, text, text, text, text, integer, text, text);
DROP FUNCTION IF EXISTS autodl_h3_mark_claimed_job_progress(uuid, text, text, text, bigint, text, text, text, text, integer, text, text);
DROP FUNCTION IF EXISTS autodl_h3_finalize_video(uuid, text, text, text, text, text, text, bigint, text, numeric, numeric, bigint);
DROP FUNCTION IF EXISTS autodl_h3_transition_claimed_job(uuid, text, bigint, text, text, text, text, integer, timestamptz, text, text);
DROP FUNCTION IF EXISTS autodl_h3_job_transition_allowed(text, text);
DROP FUNCTION IF EXISTS autodl_h3_job_rank(text);
DROP FUNCTION IF EXISTS autodl_h3_claim_active_job(text, text, integer);
DROP FUNCTION IF EXISTS autodl_h3_claim_unknown_dispatch_job(text, text, integer);
DROP FUNCTION IF EXISTS autodl_h3_claim_job(text, text, integer);
DROP FUNCTION IF EXISTS autodl_h3_confirm_shutdown(text, text, bigint, bigint);
DROP FUNCTION IF EXISTS autodl_h3_prepare_shutdown(text, text, bigint, bigint, integer);
DROP FUNCTION IF EXISTS autodl_h3_update_instance_state(text, text, bigint, text, timestamptz, timestamptz, text, text);
DROP FUNCTION IF EXISTS autodl_h3_renew_instance_lease(text, text, bigint, integer);
DROP FUNCTION IF EXISTS autodl_h3_renew_job_lease(uuid, text, bigint, integer);
DROP FUNCTION IF EXISTS autodl_h3_acquire_instance_lease(text, text, integer);
DROP FUNCTION IF EXISTS autodl_h3_enqueue_job(text, text, text, text, text, text, jsonb);

DROP INDEX IF EXISTS revenue_records_autodl_h3_once_idx;
DROP INDEX IF EXISTS cash_transactions_autodl_h3_once_idx;
DROP TABLE IF EXISTS autodl_h3_settlements;
DROP TABLE IF EXISTS autodl_h3_instance_state;
DROP TABLE IF EXISTS autodl_h3_jobs;

COMMIT;
