-- Run while an order decision is still loading. These queries only read
-- metadata; they do not accept/reject orders or terminate database sessions.
-- Do not add query text, trigger arguments, or connection details to the output.

-- Exclude SQL Editor diagnostics and parallel workers that also contain the
-- function name. clock_timestamp() avoids negative ages for newer sessions.
with decisions as (
  select pid, state, wait_event_type, wait_event, query_start,
         pg_blocking_pids(pid) as blocking_pids
  from pg_stat_activity
  where datname = current_database()
    and pid <> pg_backend_pid()
    and backend_type = 'client backend'
    and state = 'active'
    and query ilike '%apply_order_decision%'
    and query not ilike '%pg_stat_activity%'
)
select d.pid, d.state, d.wait_event_type, d.wait_event, d.blocking_pids,
       clock_timestamp() - d.query_start as running_for,
       b.pid as blocker_pid, b.state as blocker_state,
       clock_timestamp() - b.xact_start as blocker_transaction_age,
       b.wait_event_type as blocker_wait_type, b.wait_event as blocker_wait
from decisions d
left join pg_stat_activity b on b.pid = any(d.blocking_pids);

select c.relname as table_name, t.tgname as trigger_name,
       t.tgenabled as enabled,
       n.nspname as function_schema, p.proname as function_name
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n on n.oid = p.pronamespace
where t.tgrelid in ('public.orders'::regclass, 'public.order_decisions'::regclass)
  and not t.tgisinternal
order by c.relname, t.tgname;
