-- Read-only verification after the payment repair migrations. No function
-- bodies, SQL statements, trigger arguments, or credentials are returned.
-- A false source match indicates a different body or comments, not necessarily
-- a functional defect; it needs review before replacing any deployed function.
-- Run while Accept is loading. Everything is returned in ONE result table so
-- SQL editors that display only the last result cannot hide earlier checks.
with expected(name, signature, source_hash) as (
  values
    ('apply_order_decision',
     'public.apply_order_decision(uuid,uuid,text,text,jsonb)',
     'eb9809e53d14f87bf59a0f6d56e20b2a'),
    ('order_has_valid_asset', 'public.order_has_valid_asset(uuid)',
     '62719e5bf089e21ce3ed0b17e82ffb8a'),
    ('guard_order_payment_workflow', 'public.guard_order_payment_workflow()',
     '5c5086fdf21ab07acfab53832d176d2e')
), functions as (
  select e.name, p.oid, p.prosecdef, p.proconfig,
         md5(regexp_replace(p.prosrc, '[[:space:]]', '', 'g')) = e.source_hash
           as matches_repository
  from expected e
  left join pg_proc p on p.oid = to_regprocedure(e.signature)
), decisions as materialized (
  select pid, state, wait_event_type, wait_event, query_start,
         pg_blocking_pids(pid) as blocking_pids
  from pg_stat_activity
  where datname = current_database()
    and pid <> pg_backend_pid()
    and backend_type = 'client backend'
    and state = 'active'
    and query ilike '%apply_order_decision%'
    and query not ilike '%pg_stat_activity%'
), checks(check_name, result) as (
  select 'function.' || name || '.matches_repository',
         coalesce(matches_repository::text, 'MISSING')
  from functions
  union all
  select 'decision.security_definer', coalesce(prosecdef::text, 'MISSING')
  from functions where name = 'apply_order_decision'
  union all
  select 'decision.lock_timeout', coalesce((
    select split_part(setting, '=', 2) from unnest(proconfig) setting
    where setting like 'lock_timeout=%'
  ), 'NOT SET')
  from functions where name = 'apply_order_decision'
  union all
  select 'decision.backend_can_execute',
         coalesce(has_function_privilege('service_role', oid, 'EXECUTE')::text, 'MISSING')
  from functions where name = 'apply_order_decision'
  union all
  select 'trigger.' || expected.name || '.enabled', coalesce(t.tgenabled::text, 'MISSING')
  from (values ('guard_order_payment_workflow'), ('zz_guard_cash_order_expiry')) expected(name)
  left join pg_trigger t
    on t.tgrelid = 'public.orders'::regclass and t.tgname = expected.name
  union all
  select 'activity.active_decisions', count(*)::text from decisions
  union all
  select 'activity.decision.' || pid,
         format('running=%s; wait=%s/%s; blocking_pids=%s',
           clock_timestamp() - query_start,
           coalesce(wait_event_type, 'NONE'), coalesce(wait_event, 'NONE'), blocking_pids)
  from decisions
  union all
  select distinct 'activity.blocker.' || b.pid,
         format('state=%s; transaction_age=%s; wait=%s/%s',
           b.state, clock_timestamp() - b.xact_start,
           coalesce(b.wait_event_type, 'NONE'), coalesce(b.wait_event, 'NONE'))
  from decisions d
  join pg_stat_activity b on b.pid = any(d.blocking_pids)
)
select check_name, result from checks order by check_name;
