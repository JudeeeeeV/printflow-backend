-- Publish application data changes so the backend can send authorized SSE
-- invalidations to connected user and admin dashboards.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'assets', 'daemon_devices', 'notifications', 'orders',
    'payment_receipts', 'print_jobs', 'shops', 'users'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I replica identity full', table_name);
      if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end if;
  end loop;
end $$;
