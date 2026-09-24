begin;

-- Match the existing backend-only access model even if this feature is installed
-- on a project with older browser write grants. The backend authenticates the
-- account and binds PATCH /shops/me to that account's shop ID.
alter table public.shops enable row level security;
revoke all on table public.shops from public, anon, authenticated;

-- Table revocation alone does not remove existing column-level grants.
revoke insert (location, description, latitude, longitude),
       update (location, description, latitude, longitude)
  on public.shops from public, anon, authenticated;

commit;
