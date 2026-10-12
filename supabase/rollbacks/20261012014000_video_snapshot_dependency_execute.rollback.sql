begin;

set local lock_timeout = '10s';

-- Forward repair only: a role may already have held EXECUTE before this
-- migration. Never blindly revoke it or change either routing function owner.
-- Preserve both ACLs, all business rows, and the migration ledger.
do $dependency_rollback_guard$
begin
  raise exception 'VIDEO_SNAPSHOT_DEPENDENCY_ROLLBACK_REQUIRES_REVIEWED_PRE_ACL'
    using errcode = '55000';
end;
$dependency_rollback_guard$;

commit;
