begin;

set local lock_timeout = '3s';

-- Older/custom decision functions could save acceptance without authorizing
-- production. Restore only active cash inquiries with saved explicit
-- acceptance, an unsettled pickup balance, and a valid stored PDF reference.
-- The payment-workflow trigger validates the production transition again.
with candidates as materialized (
  select o.* from public.orders o
  where o.state::text in ('OPEN_INQUIRY', 'AWAITING_PAYMENT')
    and o.payment_method = 'CASH_ON_PICKUP'
    and o.payment_status = 'DUE_AT_PICKUP'
    and o.acceptance_status = 'ACCEPTED'
    and o.acceptance_provenance = 'EXPLICIT'
    and exists (
      select 1 from public.shops s
      where s.id = o.shop_id and s.verification_status::text = 'VERIFIED'
    )
    and public.order_has_valid_asset(o.id)
  for update of o
), advanced as (
  update public.orders o set state = 'IN_PRODUCTION',
    production_authorized = true,
    production_authorized_at = coalesce(o.production_authorized_at, now()),
    expires_at = null
  from candidates c
  where o.id = c.id and o.state::text in ('OPEN_INQUIRY', 'AWAITING_PAYMENT')
  returning o.id, to_jsonb(c) as previous_status, to_jsonb(o) as new_status
)
insert into public.order_decisions (
  order_id, actor_role, action, reason, previous_status, new_status
)
select id, 'SYSTEM', 'RECOVER_PRODUCTION',
  'Recovered production authorization after an already recorded cash acceptance.',
  previous_status, new_status
from advanced;

-- Reapplying is safe: recovered orders are no longer inquiries awaiting payment.
-- Preserve acceptance timestamps/provenance, payment status, and old decisions.
commit;
