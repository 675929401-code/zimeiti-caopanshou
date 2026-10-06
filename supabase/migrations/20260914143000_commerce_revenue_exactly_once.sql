-- One delivered commerce job may contribute at most one revenue record.
-- Existing non-commerce task keys keep their current semantics.
CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_records_commerce_task_once
ON public.revenue_records (task_id)
WHERE task_id LIKE 'commerce-job-%';
