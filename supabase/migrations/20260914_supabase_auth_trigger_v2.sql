-- Drop the old private schema tables and RPCs
drop function if exists public.reserve_signup_code(text, uuid, text);
drop function if exists public.consume_signup_code(text, text);
drop function if exists public.invalidate_signup_code(text, uuid);
drop function if exists public.provision_verified_signup(uuid);
drop function if exists public.reserve_reset_code(text, uuid, text);
drop function if exists public.consume_reset_code(text, text);
drop function if exists public.invalidate_reset_code(text, uuid);
drop table if exists printflow_private.signup_codes;
drop table if exists printflow_private.reset_codes;

-- Create the trigger function to populate users and shops
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
  v_shop_name text;
begin
  -- Only provision after email is confirmed
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    -- Get the role from raw_user_meta_data
    v_role := case when new.raw_user_meta_data ->> 'role' = 'CLERK'
      then 'CLERK'::public.user_role else 'STUDENT'::public.user_role end;
      
    -- Insert into public.users
    insert into public.users(id, email, role) values (new.id, new.email, v_role)
    on conflict (id) do nothing;
    
    -- If CLERK, insert into public.shops
    if v_role = 'CLERK' then
      v_shop_name := nullif(btrim(new.raw_user_meta_data ->> 'shop_name'), '');
      if v_shop_name is null then 
        v_shop_name := 'Untitled Shop'; 
      end if;
      
      insert into public.shops(id, name, status, verification_status, pricing_matrix)
      values (new.id, v_shop_name, 'OPEN', 'UNVERIFIED',
        '{"paper_sizes":{"SHORT":2,"A4":3,"LONG":4},"color_mode_multipliers":{"BLACK_AND_WHITE":0,"COLOR":3}}'::jsonb)
      on conflict (id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

-- Attach the trigger to auth.users
drop trigger if exists on_auth_user_verified on auth.users;
create trigger on_auth_user_verified
  after update on auth.users
  for each row execute procedure public.handle_new_user();
