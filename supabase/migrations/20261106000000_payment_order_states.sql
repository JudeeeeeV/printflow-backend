-- Apply before the payment workflow migration: PostgreSQL requires newly added
-- enum values to be committed before they can be used by data migrations.
do $$
declare
  state_type regtype;
  state_name text;
begin
  select a.atttypid::regtype into state_type
  from pg_attribute a join pg_type t on t.oid = a.atttypid
  where a.attrelid = 'public.orders'::regclass and a.attname = 'state'
    and t.typtype = 'e';
  if state_type is not null then
    foreach state_name in array array['OPEN_INQUIRY', 'IN_PRODUCTION', 'PRINTED',
      'READY_FOR_PICKUP', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REJECTED'] loop
      execute format('alter type %s add value if not exists %L', state_type, state_name);
    end loop;
  end if;
end $$;
