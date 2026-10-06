-- Role is audit metadata, not a pricing policy. Preserve historical
-- administrator exemptions explicitly so reports can exclude only those old
-- free runs while including newly charged administrator usage.
ALTER TABLE public.revenue_records
  ADD COLUMN IF NOT EXISTS billing_exempt boolean NOT NULL DEFAULT false;

UPDATE public.revenue_records
SET billing_exempt = true
WHERE is_admin = true
  AND coalesce(credits_charged, 0) = 0
  AND coalesce(cash_charged, 0) = 0
  AND coalesce(selling_price, 0) > 0;

-- Earlier video finalizers could write the same immutable financial snapshot
-- more than once after a retry. Preserve every removed row in a service-only
-- audit table, but refuse to reconcile when any business field differs.
CREATE TABLE IF NOT EXISTS public.revenue_record_duplicate_archive (
  original_id text PRIMARY KEY,
  duplicate_key_hash text NOT NULL,
  original_record jsonb NOT NULL,
  reconciliation_reason text NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE public.revenue_record_duplicate_archive FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.revenue_record_duplicate_archive TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.revenue_records AS r
    WHERE r.task_id IS NOT NULL
    GROUP BY r.user_id, r.task_id, r.record_type
    HAVING count(*) > 1
       AND count(DISTINCT (to_jsonb(r) - 'id' - 'created_at')) > 1
  ) THEN
    RAISE EXCEPTION 'REVENUE_IDEMPOTENCY_CONFLICTING_DUPLICATES_REQUIRE_REVIEW';
  END IF;
END
$$;

WITH ranked AS (
  SELECT r.*,
         row_number() OVER (
           PARTITION BY r.user_id, r.task_id, r.record_type
           ORDER BY r.created_at ASC, r.id ASC
         ) AS duplicate_rank
  FROM public.revenue_records AS r
  WHERE r.task_id IS NOT NULL
), duplicates AS (
  SELECT * FROM ranked WHERE duplicate_rank > 1
)
INSERT INTO public.revenue_record_duplicate_archive (
  original_id,
  duplicate_key_hash,
  original_record,
  reconciliation_reason
)
SELECT
  d.id,
  md5(d.user_id::text || ':' || d.task_id || ':' || d.record_type),
  to_jsonb(d) - 'duplicate_rank',
  'identical_legacy_retry_duplicate'
FROM duplicates AS d
ON CONFLICT (original_id) DO NOTHING;

WITH ranked AS (
  SELECT r.id,
         row_number() OVER (
           PARTITION BY r.user_id, r.task_id, r.record_type
           ORDER BY r.created_at ASC, r.id ASC
         ) AS duplicate_rank
  FROM public.revenue_records AS r
  WHERE r.task_id IS NOT NULL
)
DELETE FROM public.revenue_records AS r
USING ranked AS duplicate
WHERE duplicate.duplicate_rank > 1
  AND r.id = duplicate.id;

-- Every business task may create at most one revenue snapshot per account and
-- record type. The wallet operation remains the source of truth for charging;
-- this index makes a post-charge revenue retry exactly-once as well.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.revenue_records
    WHERE task_id IS NOT NULL
    GROUP BY user_id, task_id, record_type
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'REVENUE_IDEMPOTENCY_DUPLICATES_REQUIRE_RECONCILIATION';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_records_business_task_once
  ON public.revenue_records (user_id, task_id, record_type)
  WHERE task_id IS NOT NULL;
