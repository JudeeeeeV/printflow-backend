begin;

alter table public.shops
  add column if not exists availability_override boolean not null default false,
  add column if not exists opens_at time not null default '08:00',
  add column if not exists closes_at time not null default '20:00',
  add column if not exists timezone text not null default 'Asia/Manila';

alter table public.orders
  add column if not exists order_name varchar(120),
  add column if not exists orientation text not null default 'PORTRAIT',
  add column if not exists copies integer not null default 1;

do $$ begin
  alter table public.shops add constraint shops_schedule_window_check
    check (opens_at <> closes_at);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.orders add constraint orders_orientation_check
    check (orientation in ('PORTRAIT', 'LANDSCAPE'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.orders add constraint orders_copies_check
    check (copies between 1 and 99);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
commit;
