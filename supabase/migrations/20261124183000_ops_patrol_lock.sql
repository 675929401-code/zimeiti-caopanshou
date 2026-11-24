-- Cross-process guard for the operations patrol scheduler.
-- One advisory lock prevents duplicate probes when the web process runs multiple
-- instances; manual runs from the admin page intentionally bypass this lock.
create or replace function public.ops_patrol_try_lock(p_key bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  select pg_try_advisory_lock(p_key);
$$;

create or replace function public.ops_patrol_release_lock(p_key bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  select pg_advisory_unlock(p_key);
$$;

revoke all on function public.ops_patrol_try_lock(bigint) from public;
revoke all on function public.ops_patrol_release_lock(bigint) from public;
grant execute on function public.ops_patrol_try_lock(bigint) to service_role;
grant execute on function public.ops_patrol_release_lock(bigint) to service_role;

notify pgrst, 'reload schema';
