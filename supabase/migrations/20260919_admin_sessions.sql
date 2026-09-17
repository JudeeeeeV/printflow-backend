begin;

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  token_id_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists admin_sessions_admin_idx
  on public.admin_sessions(admin_id, expires_at desc);

alter table public.admin_sessions enable row level security;
revoke all on table public.admin_sessions from public, anon, authenticated;

commit;
