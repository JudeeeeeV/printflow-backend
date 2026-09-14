-- Run in Supabase SQL Editor before using the new registration flow.
-- Does not delete existing users or change existing Auth triggers/RLS policies.
begin;
create schema if not exists printflow_private;
revoke all on schema printflow_private from public, anon, authenticated;

create table if not exists printflow_private.signup_codes (
  email text primary key,
  request_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null,
  resend_at timestamptz not null,
  attempts integer not null default 0,
  consumed boolean not null default false,
  window_started_at timestamptz not null default now(),
  sent_count integer not null default 1
);
alter table printflow_private.signup_codes enable row level security;
create index if not exists signup_codes_expiry_idx on printflow_private.signup_codes(expires_at);

-- Lock by email so parallel requests cannot bypass cooldowns or attempt limits.
create or replace function public.reserve_signup_code(p_email text, p_request_id uuid, p_token_hash text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_row printflow_private.signup_codes%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup:' || p_email, 0));
  delete from printflow_private.signup_codes where expires_at < now() - interval '24 hours';
  select * into v_row from printflow_private.signup_codes where email = p_email for update;
  if found then
    if v_row.resend_at > now() then
      return greatest(1, ceil(extract(epoch from v_row.resend_at - now()))::integer);
    end if;
    if v_row.window_started_at > now() - interval '1 hour' and v_row.sent_count >= 50 then
      return greatest(1, ceil(extract(epoch from v_row.window_started_at + interval '1 hour' - now()))::integer);
    end if;
  end if;
  insert into printflow_private.signup_codes as codes
    (email, request_id, token_hash, expires_at, resend_at)
  values (p_email, p_request_id, p_token_hash, now() + interval '10 minutes', now() + interval '15 seconds')
  on conflict (email) do update set
    request_id = excluded.request_id, token_hash = excluded.token_hash,
    expires_at = excluded.expires_at, resend_at = excluded.resend_at, attempts = 0, consumed = false,
    sent_count = case when codes.window_started_at <= now() - interval '1 hour' then 1 else codes.sent_count + 1 end,
    window_started_at = case when codes.window_started_at <= now() - interval '1 hour' then now() else codes.window_started_at end;
  return 0;
end;
$$;

create or replace function public.consume_signup_code(p_email text, p_token_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_row printflow_private.signup_codes%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup:' || p_email, 0));
  select * into v_row from printflow_private.signup_codes where email = p_email for update;
  if not found or v_row.consumed or v_row.expires_at <= now() or v_row.attempts >= 5 then
    return false;
  end if;
  if v_row.token_hash <> p_token_hash then
    update printflow_private.signup_codes set attempts = attempts + 1 where email = p_email;
    return false;
  end if;
  update printflow_private.signup_codes set consumed = true where email = p_email;
  return true;
end;
$$;

-- A failed delivery invalidates only that request, preserving its abuse limits.
create or replace function public.invalidate_signup_code(p_email text, p_request_id uuid)
returns void language sql security definer set search_path = '' as $$
  update printflow_private.signup_codes set consumed = true
  where email = p_email and request_id = p_request_id;
$$;

-- Idempotent: retries never overwrite a user's role or a shop's existing details.
-- Auth user creation and verification must already have succeeded.
create or replace function public.provision_verified_signup(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user auth.users%rowtype;
        v_role public.user_role;
        v_shop_name text;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found or v_user.email_confirmed_at is null or v_user.email is null then
    raise exception 'Email must be verified before creating a profile';
  end if;
  if v_user.raw_app_meta_data ->> 'signup_source' is distinct from 'printflow_email_otp' then
    raise exception 'This account was not created by the verified signup flow';
  end if;
  v_role := case when v_user.raw_app_meta_data ->> 'signup_role' = 'CLERK'
    then 'CLERK'::public.user_role else 'STUDENT'::public.user_role end;
  insert into public.users(id, email, role) values (v_user.id, v_user.email, v_role)
  on conflict (id) do nothing;
  if v_role = 'CLERK' then
    v_shop_name := nullif(btrim(v_user.raw_app_meta_data ->> 'signup_shop_name'), '');
    if v_shop_name is null then raise exception 'Shop name is required'; end if;
    insert into public.shops(id, name, status, verification_status, pricing_matrix)
    values (v_user.id, v_shop_name, 'OPEN', 'UNVERIFIED',
      '{"paper_sizes":{"SHORT":2,"A4":3,"LONG":4},"color_mode_multipliers":{"BLACK_AND_WHITE":0,"COLOR":3}}'::jsonb)
    on conflict (id) do nothing;
  end if;
end;
$$;

revoke all on function public.reserve_signup_code(text, uuid, text) from public, anon, authenticated;
revoke all on function public.consume_signup_code(text, text) from public, anon, authenticated;
revoke all on function public.invalidate_signup_code(text, uuid) from public, anon, authenticated;
revoke all on function public.provision_verified_signup(uuid) from public, anon, authenticated;
grant execute on function public.reserve_signup_code(text, uuid, text) to service_role;
grant execute on function public.consume_signup_code(text, text) to service_role;
grant execute on function public.invalidate_signup_code(text, uuid) to service_role;
grant execute on function public.provision_verified_signup(uuid) to service_role;
commit;
