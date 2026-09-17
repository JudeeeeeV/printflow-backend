begin;

create table if not exists public.admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.admins(id) on delete set null,
  action text not null check (char_length(action) between 1 and 160),
  target_type text,
  target_id text,
  outcome text not null check (outcome in ('SUCCESS', 'FAILURE')),
  request_id text not null,
  source_ip text,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_events_actor_created_idx
  on public.admin_audit_events(actor_id, created_at desc);

alter table public.admin_audit_events enable row level security;
revoke all on table public.admin_audit_events from public, anon, authenticated;
revoke update, delete, truncate on table public.admin_audit_events from service_role;
grant select, insert on table public.admin_audit_events to service_role;

commit;
