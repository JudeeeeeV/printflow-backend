begin;

set local lock_timeout = '3s';

-- GCash receipt verification is the single production-authorization decision.
-- Cash retains explicit acceptance and collection completes its order.
create or replace function public.apply_order_decision(p_order uuid, p_actor uuid, p_actor_type text,
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
    if p_action in ('VERIFY', 'ADMIN_VERIFY') and o.state::text = 'OPEN_INQUIRY'
      and o.acceptance_status = 'PENDING' and public.order_has_valid_asset(o.id)
      and exists(select 1 from public.shops s where s.id=o.shop_id and s.verification_status::text='VERIFIED') then
      o.acceptance_status := 'ACCEPTED';
      o.accepted_at := now();
      o.acceptance_provenance := 'PAYMENT_VERIFIED';
    end if;
    o.dispute_reason := null;
    o.expires_at := case when o.payment_status = 'REJECTED' and o.state::text = 'OPEN_INQUIRY'
      then now() + interval '24 hours' else null end;
    update public.notifications set is_read = true where order_id = o.id;
  elsif p_action = 'ACCEPT' then
    if o.payment_method <> 'CASH_ON_PICKUP' then
      raise exception 'GCash orders are authorized by receipt verification' using errcode = '40001';
    end if;
    if o.acceptance_status = 'ACCEPTED' then return to_jsonb(o); end if;
    if o.state::text <> 'OPEN_INQUIRY' or o.acceptance_status <> 'PENDING' or not public.order_has_valid_asset(o.id) then
      raise exception 'Order cannot be accepted; review state and file' using errcode = '40001';
    end if;
    o.acceptance_status := 'ACCEPTED'; o.accepted_at := now(); o.acceptance_provenance := 'EXPLICIT';
  elsif p_action in ('REJECT_ORDER', 'CANCEL') then
    if p_action = 'REJECT_ORDER' and o.payment_method <> 'CASH_ON_PICKUP' then
      raise exception 'Use receipt rejection for GCash orders' using errcode = '40001';
    end if;
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
      or o.output_confirmed_at is null
      or exists(select 1 from public.print_jobs j where j.order_id = o.id and j.resolved_at is null)
      or coalesce((p_data->>'confirmed')::boolean, false) is not true then
      raise exception 'Confirm full cash collection at pickup' using errcode = '23514';
    end if;
    o.payment_status := 'COLLECTED'; o.cash_collected_at := now(); amount_value := o.total;
    next_state := 'COMPLETED';
    o.handed_over_at := now(); o.handed_over_by := p_actor;
    o.is_unclaimed := false; o.unclaimed_at := null; o.unclaimed_reason := null;
  elsif p_action = 'RECORD_REFUND' then
    if o.payment_status = 'REFUNDED' and reference_value = o.refund_reference then return to_jsonb(o); end if;
    if o.payment_status <> 'REFUND_DUE' or reference_value is null
      or coalesce((p_data->>'confirmed')::boolean, false) is not true then
      raise exception 'Confirm the full manual refund and provide its reference' using errcode = '23514';
    end if;
    o.payment_status := 'REFUNDED'; o.refunded_at := now(); o.refund_reference := reference_value; amount_value := o.total;
  elsif p_action = 'FLAG_UNCLAIMED' then
    if o.state::text <> 'READY_FOR_PICKUP' then
      raise exception 'Unclaimed requires a ready order' using errcode = '23514';
    end if;
    if o.is_unclaimed then return to_jsonb(o); end if;
    o.is_unclaimed := true; o.unclaimed_at := now(); o.unclaimed_reason := note;
  elsif p_action = 'CLEAR_UNCLAIMED' then
    if not o.is_unclaimed then return to_jsonb(o); end if;
    if o.state::text <> 'READY_FOR_PICKUP' then raise exception 'Order is not awaiting pickup' using errcode = '40001'; end if;
    o.is_unclaimed := false; o.unclaimed_at := null; o.unclaimed_reason := null;
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
    expires_at = o.expires_at, shop_rejection_reason = o.shop_rejection_reason, dispute_reason = o.dispute_reason,
    handed_over_at = o.handed_over_at, handed_over_by = o.handed_over_by
  where id = o.id returning * into o;
  insert into public.order_decisions(order_id, actor_id, actor_role, action, receipt_id, amount, reason,
    reference, previous_status, new_status)
    values(o.id, p_actor, actor_role, p_action, coalesce(receipt_key, o.current_receipt_id), amount_value, note,
      reference_value, before_row, to_jsonb(o));
  if p_action = 'COLLECT_CASH' then
    insert into public.order_fulfillment_events (order_id, shop_id, event_type, attempt_id, actor_id)
    values (o.id, o.shop_id, 'HANDED_OVER', o.output_confirmed_attempt_id, p_actor);
  end if;
  return to_jsonb(o);
end $$;

alter function public.apply_order_decision(uuid, uuid, text, text, jsonb)
  set lock_timeout = '3s';
revoke all on function public.apply_order_decision(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_order_decision(uuid, uuid, text, text, jsonb)
  to service_role;

-- Recover active GCash inquiries already verified under the earlier workflow.
-- Retain historical timestamps and payment records; never reopen closed orders
-- or authorize an unavailable document, unverified shop, or unreviewed receipt.
with candidates as materialized (
  select o.* from public.orders o
  where o.state::text = 'OPEN_INQUIRY' and o.payment_method = 'GCASH'
    and o.payment_status = 'VERIFIED' and o.acceptance_status in ('PENDING','ACCEPTED')
    and public.order_has_valid_asset(o.id)
    and exists(select 1 from public.shops s where s.id=o.shop_id and s.verification_status::text='VERIFIED')
    and exists(select 1 from public.payment_receipts r where r.id::text=o.current_receipt_id
      and r.order_id=o.id and r.verified is true and r.review_status='VERIFIED'
      and nullif(trim(r.receipt_url),'') is not null and nullif(trim(r.reference_number),'') is not null)
  for update of o
), authorized as (
  update public.orders o set state='IN_PRODUCTION', acceptance_status='ACCEPTED',
    accepted_at=coalesce(o.accepted_at,o.payment_verified_at),
    acceptance_provenance=case when c.acceptance_status='PENDING' then 'PAYMENT_VERIFIED' else o.acceptance_provenance end,
    expires_at=null
  from candidates c where o.id=c.id and o.state::text='OPEN_INQUIRY'
  returning o.id,to_jsonb(c) as previous_status,to_jsonb(o) as new_status
)
insert into public.order_decisions(order_id,actor_role,action,reason,previous_status,new_status)
select id,'SYSTEM','AUTHORIZE_VERIFIED_GCASH','Authorized production from the existing verified current receipt.',previous_status,new_status
from authorized;

notify pgrst, 'reload schema';
commit;
