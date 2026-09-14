-- Run in Supabase SQL Editor before using the password reset flow.
-- Does not delete existing users or change existing Auth triggers/RLS policies.
begin;
create schema if not exists printflow_private;
revoke all on schema printflow_private from public, anon, authenticated;

create table if not exists printflow_private.password_reset_codes (
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
alter table printflow_private.password_reset_codes enable row level security;
create index if not exists password_reset_codes_expiry_idx on printflow_private.password_reset_codes(expires_at);

-- Lock by email so parallel requests cannot bypass cooldowns or attempt limits.
create or replace function public.reserve_reset_code(p_email text, p_request_id uuid, p_token_hash text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_row printflow_private.password_reset_codes%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reset:' || p_email, 0));
  delete from printflow_private.password_reset_codes where expires_at < now() - interval '24 hours';
  select * into v_row from printflow_private.password_reset_codes where email = p_email for update;
  if found then
    if v_row.resend_at > now() then
      return greatest(1, ceil(extract(epoch from v_row.resend_at - now()))::integer);
    end if;
    if v_row.window_started_at > now() - interval '1 hour' and v_row.sent_count >= 5 then
      return greatest(1, ceil(extract(epoch from v_row.window_started_at + interval '1 hour' - now()))::integer);
    end if;
  end if;
  insert into printflow_private.password_reset_codes as codes
    (email, request_id, token_hash, expires_at, resend_at)
  values (p_email, p_request_id, p_token_hash, now() + interval '10 minutes', now() + interval '60 seconds')
  on conflict (email) do update set
    request_id = excluded.request_id, token_hash = excluded.token_hash,
    expires_at = excluded.expires_at, resend_at = excluded.resend_at, attempts = 0, consumed = false,
    sent_count = case when codes.window_started_at <= now() - interval '1 hour' then 1 else codes.sent_count + 1 end,
    window_started_at = case when codes.window_started_at <= now() - interval '1 hour' then now() else codes.window_started_at end;
  return 0;
end;
$$;

create or replace function public.consume_reset_code(p_email text, p_token_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_row printflow_private.password_reset_codes%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reset:' || p_email, 0));
  select * into v_row from printflow_private.password_reset_codes where email = p_email for update;
  if not found or v_row.consumed or v_row.expires_at <= now() or v_row.attempts >= 5 then
    return false;
  end if;
  if v_row.token_hash <> p_token_hash then
    update printflow_private.password_reset_codes set attempts = attempts + 1 where email = p_email;
    return false;
  end if;
  update printflow_private.password_reset_codes set consumed = true where email = p_email;
  return true;
end;
$$;

-- A failed delivery invalidates only that request, preserving its abuse limits.
create or replace function public.invalidate_reset_code(p_email text, p_request_id uuid)
returns void language sql security definer set search_path = '' as $$
  update printflow_private.password_reset_codes set consumed = true
  where email = p_email and request_id = p_request_id;
$$;

revoke all on function public.reserve_reset_code(text, uuid, text) from public, anon, authenticated;
revoke all on function public.consume_reset_code(text, text) from public, anon, authenticated;
revoke all on function public.invalidate_reset_code(text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_reset_code(text, uuid, text) to service_role;
grant execute on function public.consume_reset_code(text, text) to service_role;
grant execute on function public.invalidate_reset_code(text, uuid) to service_role;
commit;
