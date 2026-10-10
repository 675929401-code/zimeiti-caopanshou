begin;
set local lock_timeout = '10s';

-- Never discard the only durable evidence that an object deletion is in
-- progress or that metadata still needs reconciliation. Operators must first
-- retry/drain these rows to completed (or perform an explicitly reviewed
-- reconciliation) before this rollback is allowed to remove the control plane.
--
-- Every cleanup RPC takes ACCESS SHARE on video_tasks before touching the
-- outbox, while reservations already own a video_tasks table lock before their
-- trigger reaches the outbox. Taking ACCESS EXCLUSIVE in that same order both
-- drains existing work and prevents new work from crossing the safety check.
lock table public.video_tasks in access exclusive mode;
do $rollback_safety$
declare
  v_nonterminal boolean := false;
begin
  if to_regclass('public.video_reference_asset_cleanup_outbox') is not null then
    execute 'lock table public.video_reference_asset_cleanup_outbox in access exclusive mode';
    execute 'select exists(select 1 from public.video_reference_asset_cleanup_outbox where state in (''claimed'',''object_deleted''))'
      into v_nonterminal;
  end if;
  if v_nonterminal then
    raise exception 'VIDEO_REFERENCE_CLEANUP_ROLLBACK_BLOCKED_NONTERMINAL'
      using errcode='55000';
  end if;
end
$rollback_safety$;

drop trigger if exists video_tasks_reference_asset_reservation_guard on public.video_tasks;
drop function if exists public.guard_video_reference_assets_during_reservation_v1();
drop function if exists public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text);
drop function if exists public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text);
drop function if exists public.mark_video_reference_asset_object_deleted_v1(text,text);
drop function if exists public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text);
drop function if exists public.record_video_reference_asset_cleanup_failure_v1(text,text,text);
drop table if exists public.video_reference_asset_cleanup_outbox;

notify pgrst, 'reload schema';
commit;
