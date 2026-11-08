begin;

-- Repair installations where the payment columns/RPC exist but the guard was
-- removed. Keep migration DDL from waiting indefinitely behind active writers.
set local lock_timeout = '3s';

create or replace function public.guard_order_payment_workflow() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and old.state::text <> 'DRAFT' and new.payment_method <> old.payment_method then
    raise exception 'Payment method is locked after submission' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' or (old.state::text = 'DRAFT' and new.state::text <> 'DRAFT') then
    new.payment_status := case when new.payment_method = 'CASH_ON_PICKUP' then 'DUE_AT_PICKUP' else 'UNPAID' end;
    new.expires_at := case when new.state::text = 'DRAFT' or new.payment_method = 'CASH_ON_PICKUP'
      then null else now() + interval '15 minutes' end;
  elsif new.state::text = 'DRAFT' then
    new.payment_status := case when new.payment_method = 'CASH_ON_PICKUP' then 'DUE_AT_PICKUP' else 'UNPAID' end;
    new.expires_at := null;
  end if;
  if new.state::text in ('IN_PRODUCTION', 'PRINTED', 'READY_FOR_PICKUP', 'COMPLETED') and
    (tg_op = 'INSERT' or new.state is distinct from old.state) then
    if new.acceptance_status <> 'ACCEPTED'
      or (new.payment_method = 'GCASH' and new.payment_status <> 'VERIFIED')
      or (new.payment_method = 'CASH_ON_PICKUP' and new.payment_status not in ('DUE_AT_PICKUP', 'COLLECTED'))
      or not public.order_has_valid_asset(new.id) then
      raise exception 'Acceptance, valid asset and payment eligibility are required' using errcode = '23514';
    end if;
    new.production_authorized := true;
    if new.state::text = 'IN_PRODUCTION' then
      new.production_authorized_at := coalesce(new.production_authorized_at, now());
    end if;
    if new.state::text = 'COMPLETED' and new.payment_method = 'CASH_ON_PICKUP' and new.payment_status <> 'COLLECTED' then
      raise exception 'Record cash collection before handover' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create or replace trigger guard_order_payment_workflow before insert or update on public.orders
for each row execute function public.guard_order_payment_workflow();

revoke all on function public.guard_order_payment_workflow()
  from public, anon, authenticated;

-- A missing guard leaves new cash inquiries at the column default UNPAID.
-- Correct only unsettled drafts/inquiries still awaiting shop acceptance.
-- Do not reopen orders, infer collected money, or alter accepted/history rows.
update public.orders set payment_status = 'DUE_AT_PICKUP', expires_at = null
where payment_method = 'CASH_ON_PICKUP' and payment_status = 'UNPAID'
  and acceptance_status = 'PENDING' and state::text in ('DRAFT', 'OPEN_INQUIRY');

-- Apply only to this RPC, preserving its ownership, grants, search path and
-- authorization logic. PostgreSQL rolls back the decision on lock timeout.
alter function public.apply_order_decision(uuid, uuid, text, text, jsonb)
  set lock_timeout = '3s';

notify pgrst, 'reload schema';
commit;
