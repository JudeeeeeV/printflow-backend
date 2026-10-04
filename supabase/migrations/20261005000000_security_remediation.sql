begin;

alter table public.orders add column if not exists draft_version bigint not null default 0;
create or replace function public.increment_order_draft_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.draft_version := old.draft_version + 1;
  return new;
end;
$$;
drop trigger if exists increment_order_draft_version on public.orders;
create trigger increment_order_draft_version before update on public.orders
for each row execute function public.increment_order_draft_version();
revoke all on function public.increment_order_draft_version() from public, anon, authenticated;

alter table public.admins add column if not exists last_totp_step bigint;
create table if not exists public.admin_login_challenges (
  token_id_hash text primary key check (token_id_hash ~ '^[a-f0-9]{64}$'),
  admin_id uuid not null references public.admins(id) on delete cascade,
  setup boolean not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now()
);
create index if not exists admin_login_challenges_expiry_idx on public.admin_login_challenges(expires_at);
alter table public.admin_login_challenges enable row level security;
revoke all on public.admin_login_challenges from public, anon, authenticated;
grant select, insert, update, delete on public.admin_login_challenges to service_role;

create or replace function public.reserve_admin_2fa_attempt(p_admin_id uuid, p_challenge_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare reserved text;
begin
  update public.admin_login_challenges set attempts = attempts + 1
  where admin_id = p_admin_id and token_id_hash = p_challenge_hash
    and consumed_at is null and expires_at > now() and attempts < 5
  returning token_id_hash into reserved;
  return reserved is not null;
end;
$$;

-- Consume the challenge and OTP step, enable enrollment if needed, and create
-- the revocable session in one transaction. All concurrent challenges for an
-- admin serialize on the same row; neither an OTP nor a challenge can win twice.
create or replace function public.complete_admin_2fa(
  p_admin_id uuid, p_challenge_hash text, p_totp_step bigint, p_setup boolean,
  p_expected_secret text, p_encrypted_secret text,
  p_session_hash text, p_session_expires_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  account public.admins%rowtype;
  challenge public.admin_login_challenges%rowtype;
  current_step bigint := floor(extract(epoch from now()) / 30)::bigint;
begin
  select * into account from public.admins where id = p_admin_id for update;
  if not found then return false; end if;
  select * into challenge from public.admin_login_challenges
    where admin_id = p_admin_id and token_id_hash = p_challenge_hash for update;
  if not found or challenge.consumed_at is not null or challenge.expires_at <= now()
    or challenge.attempts < 1 or challenge.setup is distinct from p_setup
    or account.is_2fa_enabled is distinct from (not p_setup)
    or coalesce(account.two_factor_secret_encrypted, account.two_factor_secret) is distinct from p_expected_secret
    or p_expected_secret is null or p_encrypted_secret is null
    or p_totp_step is null or p_totp_step not between current_step - 1 and current_step + 1
    or (account.last_totp_step is not null and p_totp_step <= account.last_totp_step)
    or p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$'
    or p_session_expires_at is null or p_session_expires_at <= now()
  then return false; end if;

  update public.admins set last_totp_step = p_totp_step, is_2fa_enabled = true,
    two_factor_secret = null, two_factor_secret_encrypted = p_encrypted_secret where id = p_admin_id;
  update public.admin_login_challenges set consumed_at = now() where token_id_hash = p_challenge_hash;
  insert into public.admin_sessions(admin_id, token_id_hash, expires_at)
    values (p_admin_id, p_session_hash, least(p_session_expires_at, now() + interval '15 minutes'));
  return true;
end;
$$;
revoke all on function public.reserve_admin_2fa_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_admin_2fa(uuid, text, bigint, boolean, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_admin_2fa_attempt(uuid, text) to service_role;
grant execute on function public.complete_admin_2fa(uuid, text, bigint, boolean, text, text, text, timestamptz) to service_role;

commit;
