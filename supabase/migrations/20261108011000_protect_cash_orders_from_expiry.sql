begin;

-- Older workers delete OPEN_INQUIRY rows by created_at rather than checking
-- payment_method. Protect submitted cash orders even while those workers exist.
create or replace function public.guard_cash_order_expiry() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.payment_method = 'CASH_ON_PICKUP' and old.state::text <> 'DRAFT' then
      return null;
    end if;
    return old;
  end if;

  if new.payment_method = 'CASH_ON_PICKUP' then
    new.expires_at := null;
    if new.state::text = 'EXPIRED' then
      if tg_op = 'INSERT' then
        raise exception 'Cash on pickup orders cannot expire' using errcode = '23514';
      elsif old.state::text <> 'EXPIRED' then
        -- Skip this row without preventing an older bulk job from processing
        -- other payment methods. Do not change a cash order's lifecycle.
        return null;
      end if;
    end if;
  end if;
  return new;
end $$;

-- Run after the existing payment-workflow guard initializes submitted orders.
create or replace trigger zz_guard_cash_order_expiry
before insert or update or delete on public.orders
for each row execute function public.guard_cash_order_expiry();

-- Remove stale deadlines without reopening rejected, cancelled or expired rows.
update public.orders set expires_at = null
where payment_method = 'CASH_ON_PICKUP' and expires_at is not null;

commit;
