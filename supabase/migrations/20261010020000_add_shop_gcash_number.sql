alter table public.shops
  add column if not exists gcash_number text;

alter table public.shops
  drop constraint if exists shops_gcash_number_valid;

alter table public.shops
  add constraint shops_gcash_number_valid
  check (gcash_number is null or gcash_number ~ '^09[0-9]{9}$');
