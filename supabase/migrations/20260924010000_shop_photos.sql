begin;

alter table public.shops add column if not exists shop_photo_path text;
comment on column public.shops.shop_photo_path is 'Server-generated object path in private shop_photos bucket, never a user-supplied URL.';

-- All shop mutations go through the authenticated backend.
alter table public.shops enable row level security;
revoke insert, update on table public.shops from public, anon, authenticated;
revoke insert (shop_photo_path), update (shop_photo_path)
  on public.shops from public, anon, authenticated;

-- Defense against any older broad Storage policies. Signed URLs are issued by
-- the backend only for the shop's own photo or an approved public shop listing.
drop policy if exists shop_photos_backend_only on storage.objects;
create policy shop_photos_backend_only on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'shop_photos')
  with check (bucket_id <> 'shop_photos');

commit;
