-- Non-destructive rollback: block all new sales/execution; retain paid history,
-- wallet ledger, entitlements and receipts. Rolling back application code must
-- not delete business records or automatically refund unknown executions.
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtextextended('publish-center:config',0));
INSERT INTO public.pub_config_versions(version,execution_enabled,sales_enabled,announcement,operator_links,enabled_platforms,procurement_notes,procurement_verified_at)
SELECT version+1,false,false,'发布服务维护中，已保存的草稿和记录会保留。',operator_links,enabled_platforms,procurement_notes,procurement_verified_at
FROM public.pub_config_versions ORDER BY version DESC LIMIT 1;
COMMIT;
