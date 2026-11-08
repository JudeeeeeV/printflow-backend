-- READ ONLY. Run before planning a deployment; do not repair migration history here.
-- In Supabase, compare both version AND name: the two cash repairs formerly
-- occupied 20261108000000 / 20261108010000, now owned by print fulfillment.
select version, name from supabase_migrations.schema_migrations
where version >= '20261106000000' order by version;

select table_name, column_name, data_type from information_schema.columns
where table_schema = 'public' and (
  (table_name = 'orders' and column_name in ('payment_method', 'payment_status',
    'acceptance_status', 'output_confirmed_at', 'output_confirmed_attempt_id',
    'handed_over_at', 'handed_over_by'))
  or (table_name = 'print_jobs' and column_name in ('attempt_id', 'revision_id',
    'revision_ref', 'resolved_at', 'resolution')))
order by table_name, column_name;

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer, p.proconfig as settings,
  md5(regexp_replace(p.prosrc, '[[:space:]]', '', 'g')) as definition_hash,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as backend_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as browser_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('apply_order_decision',
  'order_has_valid_asset', 'guard_order_payment_workflow', 'guard_cash_order_expiry',
  'print_create_attempt', 'print_authorize_attempt', 'print_confirm_output',
  'print_record_handover', 'order_payment_settled', 'claim_payment_eligible_print_job')
order by p.proname;

select c.relname as table_name, t.tgname, t.tgenabled
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('orders', 'order_decisions', 'print_jobs')
  and not t.tgisinternal order by c.relname, t.tgname;

select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('order_decisions', 'print_jobs',
  'print_job_events', 'order_fulfillment_events');

-- JSON field access also works before the payment columns are installed.
select count(*) filter (where to_jsonb(o)->>'payment_method' = 'GCASH'
    and to_jsonb(o)->>'payment_status' = 'VERIFIED'
    and to_jsonb(o)->>'acceptance_status' = 'PENDING'
    and o.state::text = 'OPEN_INQUIRY') as stranded_verified_orders,
  count(*) filter (where to_jsonb(o)->>'payment_method' = 'CASH_ON_PICKUP'
    and o.state::text = 'COMPLETED'
    and to_jsonb(o)->>'handed_over_at' is null) as historical_cash_without_handover,
  count(*) filter (where to_jsonb(o)->>'payment_status' = 'REFUND_DUE') as refunds_due
from public.orders o;
