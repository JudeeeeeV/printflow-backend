begin;

alter table public.orders
  add column payment_method text not null default 'GCASH'
    check (payment_method in ('GCASH', 'CASH_ON_PICKUP')),
  add column acceptance_status text not null default 'PENDING'
    check (acceptance_status in ('PENDING', 'ACCEPTED', 'REJECTED')),
  add column payment_status text not null default 'UNPAID'
    check (payment_status in ('UNPAID', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED',
      'DISPUTED', 'DUE_AT_PICKUP', 'COLLECTED', 'REFUND_DUE', 'REFUNDED', 'REVIEW_REQUIRED')),
  add column current_receipt_id text,
  add column acceptance_reason text,
  add column acceptance_provenance text not null default 'EXPLICIT',
  add column accepted_at timestamptz,
  add column rejected_at timestamptz,
  add column payment_verified_at timestamptz,
  add column cash_collected_at timestamptz,
  add column refunded_at timestamptz,
  add column refund_reference text,
  add column production_authorized boolean not null default false,
  add column production_authorized_at timestamptz,
  add column is_unclaimed boolean not null default false,
  add column unclaimed_at timestamptz,
  add column unclaimed_reason text;

alter table public.payment_receipts
  add column review_status text not null default 'PENDING'
    check (review_status in ('PENDING', 'VERIFIED', 'REJECTED')),
  add column reviewed_at timestamptz,
  add column rejection_reason text;

create table public.order_decisions (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  actor_id uuid,
  actor_role text not null,
  action text not null,
  receipt_id text,
  amount numeric(12,2),
  reason text,
  reference text,
  previous_status jsonb not null,
  new_status jsonb not null,
  created_at timestamptz not null default now()
);
create index order_decisions_order_idx on public.order_decisions(order_id, id);
create unique index order_decisions_once_financial_idx
  on public.order_decisions(order_id, action)
  where action in ('COLLECT_CASH', 'RECORD_REFUND');
alter table public.order_decisions enable row level security;
revoke all on table public.order_decisions from public, anon, authenticated;
grant select, insert on table public.order_decisions to service_role;
grant usage, select on sequence public.order_decisions_id_seq to service_role;

-- Keep the ID text-compatible with existing UUID or numeric receipt schemas.
update public.orders o set current_receipt_id = (
  select r.id::text from public.payment_receipts r where r.order_id = o.id
  order by r.created_at desc, r.id::text desc limit 1
);
update public.payment_receipts set review_status = 'VERIFIED' where verified is true;
update public.payment_receipts r set review_status = 'REJECTED',
  rejection_reason = o.shop_rejection_reason
from public.orders o where r.id::text = o.current_receipt_id
  and o.state::text in ('AWAITING_PAYMENT', 'ESCALATED_DISPUTE') and not coalesce(r.verified, false);

update public.orders o set
  acceptance_status = case when state::text in ('IN_PRODUCTION', 'PRINTED', 'READY_FOR_PICKUP', 'COMPLETED')
    then 'ACCEPTED' when state::text = 'REJECTED' then 'REJECTED' else 'PENDING' end,
  acceptance_provenance = case when state::text in ('IN_PRODUCTION', 'PRINTED', 'READY_FOR_PICKUP', 'COMPLETED')
    then 'LEGACY_INFERRED' else 'LEGACY_UNCONFIRMED' end,
  production_authorized = state::text in ('IN_PRODUCTION', 'PRINTED', 'READY_FOR_PICKUP', 'COMPLETED'),
  payment_status = case
    when (select count(*) from public.payment_receipts r where r.order_id = o.id and r.verified is true) = 1
      and exists (select 1 from public.payment_receipts r where r.id::text = o.current_receipt_id
        and r.verified is true and nullif(trim(r.receipt_url), '') is not null
        and nullif(trim(r.reference_number), '') is not null)
      then case when state::text in ('CANCELLED', 'REJECTED', 'EXPIRED') then 'REFUND_DUE' else 'VERIFIED' end
    when exists (select 1 from public.payment_receipts r where r.order_id = o.id and r.verified is true) then 'REVIEW_REQUIRED'
    when state::text = 'ESCALATED_DISPUTE' and current_receipt_id is not null then 'DISPUTED'
    when state::text = 'AWAITING_PAYMENT' and current_receipt_id is not null then 'REJECTED'
    when state::text = 'AWAITING_PAYMENT_VERIFICATION' and current_receipt_id is not null
      and not exists (select 1 from public.payment_receipts r where r.order_id = o.id and r.verified is true)
      and exists (select 1 from public.payment_receipts r where r.id::text = o.current_receipt_id
        and nullif(trim(r.receipt_url), '') is not null and nullif(trim(r.reference_number), '') is not null)
      then 'PENDING_VERIFICATION'
    when current_receipt_id is not null or state::text in ('IN_PRODUCTION', 'PRINTED', 'READY_FOR_PICKUP', 'COMPLETED',
      'AWAITING_PAYMENT_VERIFICATION', 'ESCALATED_DISPUTE') then 'REVIEW_REQUIRED'
    else 'UNPAID' end;

insert into public.order_decisions(order_id, actor_role, action, previous_status, new_status, reason)
select id, 'MIGRATION', 'LEGACY_RECONCILIATION', jsonb_build_object('state', state),
  jsonb_build_object('acceptance', acceptance_status, 'payment', payment_status), acceptance_provenance
from public.orders where state::text <> 'DRAFT';

update public.orders set state = 'OPEN_INQUIRY'
where state::text in ('PROOF_APPROVED', 'AWAITING_PAYMENT', 'AWAITING_PAYMENT_VERIFICATION', 'ESCALATED_DISPUTE');
update public.orders set expires_at = case
  when payment_status = 'UNPAID' and state::text = 'OPEN_INQUIRY' then created_at + interval '15 minutes'
  when payment_status = 'REJECTED' and state::text = 'OPEN_INQUIRY' then coalesce(expires_at, now() + interval '24 hours')
  else null end;

create function public.order_has_valid_asset(p_order uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from public.orders o join public.assets a on a.order_id = o.id
    where o.id = p_order and o.page_count > 0 and o.copies between 1 and 99
      and a.file_type::text = 'PDF' and a.dpi >= 300 and nullif(trim(a.file_url), '') is not null);
$$;

create function public.guard_order_payment_workflow() returns trigger
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
create trigger guard_order_payment_workflow before insert or update on public.orders
for each row execute function public.guard_order_payment_workflow();

create function public.prevent_order_decision_changes() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Order decisions are append-only' using errcode = '42501';
end $$;
create trigger order_decisions_append_only before update or delete on public.order_decisions
for each row execute function public.prevent_order_decision_changes();

-- Service-role-only transaction. Actor identities come from authenticated
-- controllers; the database independently checks ownership and account role.
create function public.apply_order_decision(p_order uuid, p_actor uuid, p_actor_type text,
  p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.orders%rowtype;
  before_row jsonb;
  actor_role text;
  next_state text;
  receipt_key text;
  note text := nullif(trim(p_data->>'reason'), '');
  reference_value text := nullif(trim(p_data->>'reference'), '');
  receipt_path text := nullif(trim(p_data->>'receiptPath'), '');
  amount_value numeric;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if p_actor_type = 'STUDENT' then
    if o.client_id <> p_actor or not exists(select 1 from public.users where id = p_actor and role::text = 'STUDENT') then
      raise exception 'Order not found' using errcode = 'P0002';
    end if;
    actor_role := 'STUDENT';
    if p_action not in ('UPLOAD_RECEIPT', 'DISPUTE', 'CANCEL') then
      raise exception 'Action not permitted' using errcode = '42501';
    end if;
  elsif p_actor_type = 'SHOP' then
    select u.role::text into actor_role from public.users u join public.shops s on s.id = u.id
      where u.id = p_actor and s.id = o.shop_id and s.verification_status::text = 'VERIFIED'
        and u.role::text in ('CLERK', 'MANAGER');
    if actor_role is null then raise exception 'Verified owning shop required' using errcode = '42501'; end if;
    if p_action not in ('ACCEPT', 'REJECT_ORDER', 'VERIFY', 'REJECT_RECEIPT', 'COLLECT_CASH',
      'RECORD_REFUND', 'FLAG_UNCLAIMED', 'CLEAR_UNCLAIMED', 'READY_FOR_PICKUP', 'COMPLETED') then
      raise exception 'Action not permitted' using errcode = '42501';
    end if;
  elsif p_actor_type = 'ADMIN' then
    if not exists(select 1 from public.admins where id = p_actor) or p_action not in ('ADMIN_VERIFY', 'ADMIN_REJECT') then
      raise exception 'Administrator required' using errcode = '42501';
    end if;
    actor_role := 'ADMIN';
    if o.payment_status <> 'DISPUTED' then raise exception 'Dispute changed; refresh first' using errcode = '40001'; end if;
  elsif p_actor_type = 'SYSTEM' and p_actor is null and p_action = 'EXPIRE' then
    actor_role := 'SYSTEM';
  else raise exception 'Action not permitted' using errcode = '42501';
  end if;

  before_row := to_jsonb(o);
  next_state := o.state::text;
  if p_action = 'UPLOAD_RECEIPT' then
    if o.payment_method <> 'GCASH' or o.state::text in ('DRAFT', 'CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED')
      or o.payment_status not in ('UNPAID', 'REJECTED', 'REVIEW_REQUIRED') then
      raise exception 'Receipt submission is not available' using errcode = '40001';
    end if;
    if o.expires_at is not null and o.expires_at <= now() then
      raise exception 'Payment deadline has passed' using errcode = '40001';
    end if;
    if reference_value is null or receipt_path is null then
      raise exception 'Receipt and reference are required' using errcode = '23514';
    end if;
    insert into public.payment_receipts(order_id, uploaded_by, receipt_url, reference_number, verified, review_status)
      values(o.id, p_actor, receipt_path, reference_value, false, 'PENDING') returning id::text into receipt_key;
    o.current_receipt_id := receipt_key;
    o.payment_status := 'PENDING_VERIFICATION';
    o.expires_at := null;
    o.shop_rejection_reason := null;
    insert into public.notifications(order_id, clerk_id) values(o.id, o.shop_id);
  elsif p_action in ('VERIFY', 'REJECT_RECEIPT', 'ADMIN_VERIFY', 'ADMIN_REJECT') then
    receipt_key := p_data->>'receiptId';
    if receipt_key is null or receipt_key is distinct from o.current_receipt_id then
      raise exception 'Receipt changed; refresh before reviewing' using errcode = '40001';
    end if;
    if o.payment_method <> 'GCASH' or o.payment_status not in ('PENDING_VERIFICATION', 'DISPUTED') then
      raise exception 'Payment review changed; refresh first' using errcode = '40001';
    end if;
    if p_actor_type = 'SHOP' and o.payment_status = 'DISPUTED' then
      raise exception 'Disputed receipts require administrator review' using errcode = '42501';
    end if;
    if p_action in ('VERIFY', 'ADMIN_VERIFY') then
      if not exists(select 1 from public.payment_receipts where id::text = receipt_key and order_id = o.id
        and nullif(trim(receipt_url), '') is not null and nullif(trim(reference_number), '') is not null) then
        raise exception 'A receipt image and reference are required before verification' using errcode = '23514';
      end if;
      if coalesce((p_data->>'confirmed')::boolean, false) is not true then
        raise exception 'Confirm receipt, reference and amount against shop records' using errcode = '23514';
      end if;
      o.payment_status := case when o.state::text in ('CANCELLED', 'REJECTED', 'EXPIRED') then 'REFUND_DUE' else 'VERIFIED' end;
      o.payment_verified_at := now();
      update public.payment_receipts set verified = true, review_status = 'VERIFIED', reviewed_at = now(), rejection_reason = null
        where id::text = receipt_key and order_id = o.id;
      amount_value := o.total;
    else
      if note is null then raise exception 'A rejection reason is required' using errcode = '23514'; end if;
      o.payment_status := 'REJECTED';
      o.shop_rejection_reason := note;
      update public.payment_receipts set verified = false, review_status = 'REJECTED', reviewed_at = now(), rejection_reason = note
        where id::text = receipt_key and order_id = o.id;
    end if;
    if not found then raise exception 'Current receipt not found' using errcode = '40001'; end if;
    o.dispute_reason := null;
    o.expires_at := case when o.payment_status = 'REJECTED' and o.state::text = 'OPEN_INQUIRY'
      then now() + interval '24 hours' else null end;
    update public.notifications set is_read = true where order_id = o.id;
  elsif p_action = 'ACCEPT' then
    if o.acceptance_status = 'ACCEPTED' then return to_jsonb(o); end if;
    if o.state::text <> 'OPEN_INQUIRY' or o.acceptance_status <> 'PENDING' or not public.order_has_valid_asset(o.id) then
      raise exception 'Order cannot be accepted; review state and file' using errcode = '40001';
    end if;
    if o.payment_method = 'GCASH' and (o.current_receipt_id is null or o.payment_status not in ('PENDING_VERIFICATION', 'VERIFIED')) then
      raise exception 'GCash proof is required before shop acceptance' using errcode = '23514';
    end if;
    o.acceptance_status := 'ACCEPTED'; o.accepted_at := now(); o.acceptance_provenance := 'EXPLICIT';
  elsif p_action in ('REJECT_ORDER', 'CANCEL') then
    if o.state::text = (case when p_action = 'CANCEL' then 'CANCELLED' else 'REJECTED' end) then return to_jsonb(o); end if;
    if o.production_authorized or o.state::text <> 'OPEN_INQUIRY' then
      raise exception 'Order can no longer be cancelled or rejected' using errcode = '40001';
    end if;
    if p_action = 'REJECT_ORDER' and note is null then raise exception 'A rejection reason is required' using errcode = '23514'; end if;
    next_state := case when p_action = 'CANCEL' then 'CANCELLED' else 'REJECTED' end;
    if p_action = 'REJECT_ORDER' then
      o.acceptance_status := 'REJECTED'; o.acceptance_reason := note; o.rejected_at := now();
    end if;
    if o.payment_status = 'VERIFIED' then o.payment_status := 'REFUND_DUE'; amount_value := o.total; end if;
    o.expires_at := null;
  elsif p_action = 'DISPUTE' then
    if o.payment_method <> 'GCASH' or o.payment_status <> 'REJECTED' or note is null
      or o.state::text in ('DRAFT', 'CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED')
      or (o.expires_at is not null and o.expires_at <= now()) then
      raise exception 'This receipt cannot be disputed' using errcode = '40001';
    end if;
    o.payment_status := 'DISPUTED'; o.dispute_reason := note; o.expires_at := null;
  elsif p_action = 'COLLECT_CASH' then
    if o.payment_status = 'COLLECTED' then return to_jsonb(o); end if;
    if o.payment_method <> 'CASH_ON_PICKUP' or o.payment_status <> 'DUE_AT_PICKUP' or o.state::text <> 'READY_FOR_PICKUP'
      or o.acceptance_status <> 'ACCEPTED' or not public.order_has_valid_asset(o.id)
      or coalesce((p_data->>'confirmed')::boolean, false) is not true then
      raise exception 'Confirm full cash collection at pickup' using errcode = '23514';
    end if;
    o.payment_status := 'COLLECTED'; o.cash_collected_at := now(); amount_value := o.total;
  elsif p_action = 'RECORD_REFUND' then
    if o.payment_status = 'REFUNDED' and reference_value = o.refund_reference then return to_jsonb(o); end if;
    if o.payment_status <> 'REFUND_DUE' or reference_value is null
      or coalesce((p_data->>'confirmed')::boolean, false) is not true then
      raise exception 'Confirm the full manual refund and provide its reference' using errcode = '23514';
    end if;
    o.payment_status := 'REFUNDED'; o.refunded_at := now(); o.refund_reference := reference_value; amount_value := o.total;
  elsif p_action = 'FLAG_UNCLAIMED' then
    if o.is_unclaimed and o.unclaimed_reason = note then return to_jsonb(o); end if;
    if o.state::text <> 'READY_FOR_PICKUP' or note is null then
      raise exception 'Unclaimed requires a ready order and a reason' using errcode = '23514';
    end if;
    o.is_unclaimed := true; o.unclaimed_at := now(); o.unclaimed_reason := note;
  elsif p_action = 'CLEAR_UNCLAIMED' then
    if not o.is_unclaimed then return to_jsonb(o); end if;
    if o.state::text <> 'READY_FOR_PICKUP' then raise exception 'Order is not awaiting pickup' using errcode = '40001'; end if;
    o.is_unclaimed := false; o.unclaimed_at := null; o.unclaimed_reason := null;
  elsif p_action in ('READY_FOR_PICKUP', 'COMPLETED') then
    if o.state::text = p_action then return to_jsonb(o); end if;
    if (p_action = 'READY_FOR_PICKUP' and o.state::text not in ('IN_PRODUCTION', 'PRINTED'))
      or (p_action = 'COMPLETED' and o.state::text <> 'READY_FOR_PICKUP')
      or coalesce((p_data->>'confirmed')::boolean, false) is not true then
      raise exception 'Confirm output or handover from the appropriate order state' using errcode = '40001';
    end if;
    next_state := p_action;
    if p_action = 'COMPLETED' then o.is_unclaimed := false; o.unclaimed_at := null; o.unclaimed_reason := null; end if;
  elsif p_action = 'EXPIRE' then
    if o.state::text <> 'OPEN_INQUIRY' or o.production_authorized or o.payment_method <> 'GCASH'
      or o.payment_status not in ('UNPAID', 'REJECTED') or o.expires_at is null or o.expires_at > now() then
      return to_jsonb(o);
    end if;
    next_state := 'EXPIRED'; o.expires_at := null;
  else raise exception 'Unknown order action' using errcode = '23514';
  end if;

  if next_state = 'OPEN_INQUIRY' and o.acceptance_status = 'ACCEPTED'
    and ((o.payment_method = 'GCASH' and o.payment_status = 'VERIFIED')
      or (o.payment_method = 'CASH_ON_PICKUP' and o.payment_status = 'DUE_AT_PICKUP'))
    and public.order_has_valid_asset(o.id) then
    next_state := 'IN_PRODUCTION';
  end if;
  if o.payment_status in ('VERIFIED', 'DUE_AT_PICKUP', 'COLLECTED', 'REFUND_DUE', 'REFUNDED') then o.expires_at := null; end if;

  update public.orders set
    state = (jsonb_populate_record(null::public.orders, jsonb_build_object('state', next_state))).state,
    acceptance_status = o.acceptance_status, acceptance_reason = o.acceptance_reason,
    acceptance_provenance = o.acceptance_provenance, accepted_at = o.accepted_at, rejected_at = o.rejected_at,
    payment_status = o.payment_status, current_receipt_id = o.current_receipt_id,
    payment_verified_at = o.payment_verified_at, cash_collected_at = o.cash_collected_at,
    refunded_at = o.refunded_at, refund_reference = o.refund_reference,
    is_unclaimed = o.is_unclaimed, unclaimed_at = o.unclaimed_at, unclaimed_reason = o.unclaimed_reason,
    expires_at = o.expires_at, shop_rejection_reason = o.shop_rejection_reason, dispute_reason = o.dispute_reason
  where id = o.id returning * into o;
  insert into public.order_decisions(order_id, actor_id, actor_role, action, receipt_id, amount, reason,
    reference, previous_status, new_status)
    values(o.id, p_actor, actor_role, p_action, coalesce(receipt_key, o.current_receipt_id), amount_value, note,
      reference_value, before_row, to_jsonb(o));
  return to_jsonb(o);
end $$;

create function public.claim_payment_eligible_print_job(p_order uuid, p_shop uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id = p_order and shop_id = p_shop for update;
  if not found or not exists(select 1 from public.shops where id = p_shop and verification_status::text = 'VERIFIED')
    or o.state::text <> 'IN_PRODUCTION' or o.acceptance_status <> 'ACCEPTED'
    or not public.order_has_valid_asset(p_order)
    or (o.payment_method = 'GCASH' and o.payment_status <> 'VERIFIED')
    or (o.payment_method = 'CASH_ON_PICKUP' and o.payment_status not in ('DUE_AT_PICKUP', 'COLLECTED')) then
    raise exception 'Order is no longer eligible for dispatch' using errcode = '40001';
  end if;
  update public.print_jobs set status = 'FAILED', updated_at = now()
    where order_id = p_order and shop_id = p_shop and status in ('QUEUED', 'DOWNLOADING', 'SENT_TO_SPOOLER')
      and updated_at < now() - interval '10 minutes';
  insert into public.print_jobs(order_id, shop_id, status) values(p_order, p_shop, 'QUEUED');
  return true;
exception when unique_violation then return false;
end $$;

revoke all on function public.order_has_valid_asset(uuid) from public, anon, authenticated;
revoke all on function public.guard_order_payment_workflow() from public, anon, authenticated;
revoke all on function public.prevent_order_decision_changes() from public, anon, authenticated;
revoke all on function public.apply_order_decision(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_payment_eligible_print_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_order_decision(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.claim_payment_eligible_print_job(uuid, uuid) to service_role;
notify pgrst, 'reload schema';
commit;
