begin;

alter table public.users add column if not exists first_name text;
alter table public.users add column if not exists last_name text;

-- Shared by provisioning and the one-time backfill. Do not infer names from
-- arbitrary personal email addresses; only Azure accounts using CIT's format.
create or replace function public.registration_name(email text, app_data jsonb, user_data jsonb)
returns table(first_name text, last_name text)
language sql immutable set search_path = '' as $$
  select
    case when app_data ->> 'provider' = 'azure'
      and lower(btrim(email)) ~ '^[^.@[:space:]]+(\.[^.@[:space:]]+)+@cit\.edu$'
      then initcap(replace(regexp_replace(split_part(lower(btrim(email)), '@', 1), '\.[^.]+$', ''), '.', ' '))
      else nullif(btrim(user_data ->> 'first_name'), '') end,
    case when app_data ->> 'provider' = 'azure'
      and lower(btrim(email)) ~ '^[^.@[:space:]]+(\.[^.@[:space:]]+)+@cit\.edu$'
      then initcap(substring(split_part(lower(btrim(email)), '@', 1) from '[^.]+$'))
      else nullif(btrim(user_data ->> 'last_name'), '') end;
$$;
revoke all on function public.registration_name(text, jsonb, jsonb) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
  v_shop_name text;
  v_first_name text;
  v_last_name text;
begin
  if new.email_confirmed_at is null then return new; end if;
  if tg_op = 'UPDATE' then
    if old.email_confirmed_at is not null then return new; end if;
  end if;

  v_role := case when coalesce(new.raw_app_meta_data ->> 'provider', '') <> 'azure'
    and new.raw_user_meta_data ->> 'role' = 'CLERK'
    then 'CLERK'::public.user_role else 'STUDENT'::public.user_role end;
  select first_name, last_name into v_first_name, v_last_name
    from public.registration_name(new.email, new.raw_app_meta_data, new.raw_user_meta_data);

  insert into public.users(id, email, role, first_name, last_name)
    values (new.id, new.email, v_role, v_first_name, v_last_name)
    on conflict (id) do update set
      first_name = coalesce(public.users.first_name, excluded.first_name),
      last_name = coalesce(public.users.last_name, excluded.last_name);

  if v_role = 'CLERK' then
    v_shop_name := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'shop_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'shopName'), ''), 'Untitled Shop');
    insert into public.shops(id, name, status, verification_status, pricing_matrix)
      values (new.id, v_shop_name, 'OPEN', 'UNVERIFIED',
        '{"paper_sizes":{"SHORT":2,"A4":3,"LONG":4},"color_mode_multipliers":{"BLACK_AND_WHITE":0,"COLOR":3}}'::jsonb)
      on conflict (id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_verified on auth.users;
create trigger on_auth_user_verified
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.handle_new_user();

update public.users p
  set first_name = coalesce(nullif(btrim(p.first_name), ''), n.first_name),
      last_name = coalesce(nullif(btrim(p.last_name), ''), n.last_name)
  from auth.users a
  cross join lateral public.registration_name(a.email, a.raw_app_meta_data, a.raw_user_meta_data) n
  where p.id = a.id;

commit;
