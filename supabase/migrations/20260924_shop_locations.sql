begin;

alter table public.shops
  add column if not exists location text,
  add column if not exists description text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

alter table public.shops drop constraint if exists shops_coordinates_valid;
alter table public.shops add constraint shops_coordinates_valid check (
  (latitude is null and longitude is null)
  or (latitude is not null and longitude is not null
      and latitude between -90 and 90 and longitude between -180 and 180)
);

comment on column public.shops.latitude is 'Shop pickup location set by shop staff; never a student location.';
comment on column public.shops.longitude is 'Shop pickup location set by shop staff; never a student location.';

commit;
