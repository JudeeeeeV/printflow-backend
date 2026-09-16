begin;

create table if not exists public.daemon_devices (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  secret_hash text not null,
  agent_version text,
  printers jsonb not null default '[]'::jsonb,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists daemon_devices_shop_id_idx
  on public.daemon_devices(shop_id);

create index if not exists daemon_devices_active_shop_idx
  on public.daemon_devices(shop_id)
  where revoked_at is null;

alter table public.daemon_devices enable row level security;
revoke all on table public.daemon_devices from public, anon, authenticated;

commit;
