begin;
set local lock_timeout = '3s';

-- Integrate Priority #1 payment eligibility into Priority #4 attempt and fulfillment RPCs.
-- These definitions follow the latest revision_ref migration, not the older initial attempt function.
create or replace function public.order_payment_settled(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.orders o where o.id = p_order_id
    and o.payment_status in ('VERIFIED', 'COLLECTED'));
$$;

create or replace function public.print_create_attempt(
  p_order_id uuid, p_shop_id uuid, p_kind text, p_mode text,
  p_previous_attempt_id uuid, p_revision_id text,
  p_printable_path text, p_printable_sha256 text, p_printable_size bigint,
  p_device_id uuid, p_printer_name text, p_print_settings jsonb,
  p_batch_request_id uuid, p_actor_id uuid, p_reason text, p_queue_cleared boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ord record;
  open_attempt public.print_jobs%rowtype;
  has_open boolean;
  new_attempt public.print_jobs%rowtype;
  next_number integer;
  clean_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  stale boolean;
begin
  if p_kind not in ('INITIAL', 'RETRY', 'REPRINT') or p_mode not in ('AGENT', 'MANUAL')
    or (p_mode = 'AGENT' and p_device_id is null)
    or p_revision_id is null
    or (clean_reason is not null and char_length(clean_reason) > 500)
  then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  end if;

  select o.id, o.state::text as state, o.handed_over_at, o.output_confirmed_attempt_id,
    o.acceptance_status, o.payment_method, o.payment_status
    into ord
  from public.orders o
  where o.id = p_order_id and o.shop_id = p_shop_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  if ord.handed_over_at is not null or ord.state not in ('IN_PRODUCTION', 'PRINTED', 'READY_FOR_PICKUP') then
    return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_PRINTABLE');
  end if;

  if ord.acceptance_status <> 'ACCEPTED'
    or not public.order_has_valid_asset(p_order_id)
    or not exists (select 1 from public.shops s where s.id = p_shop_id and s.verification_status::text = 'VERIFIED')
    or (ord.payment_method = 'GCASH' and ord.payment_status <> 'VERIFIED')
    or (ord.payment_method = 'CASH_ON_PICKUP' and ord.payment_status not in ('DUE_AT_PICKUP', 'COLLECTED'))
  then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_NOT_ELIGIBLE');
  end if;

  select * into open_attempt from public.print_jobs
  where order_id = p_order_id and resolved_at is null
  for update;
  has_open := found;

  if p_kind = 'INITIAL' then
    if ord.state <> 'IN_PRODUCTION' then
      return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_PRINTABLE');
    end if;
    if has_open then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_OPEN', 'attemptId', open_attempt.attempt_id);
    end if;
  elsif p_kind = 'RETRY' then
    if not has_open or open_attempt.attempt_id is distinct from p_previous_attempt_id then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_CURRENT');
    end if;
    if ord.state not in ('IN_PRODUCTION', 'PRINTED') then
      return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_PRINTABLE');
    end if;
    stale := open_attempt.updated_at < now() - interval '10 minutes'
      and coalesce(open_attempt.agent_seen_at, open_attempt.updated_at) < now() - interval '10 minutes';
    if open_attempt.status = 'FAILED_PRE_SUBMISSION' then
      null;
    elsif open_attempt.status = 'OUTCOME_UNKNOWN'
      or (open_attempt.status in ('QUEUED', 'RECEIVED', 'DOWNLOADING', 'SUBMITTING') and stale)
    then
      -- Uncertain or stalled work: the operator confirmed the earlier
      -- submission is stopped or cleared and gave a reason.
      if clean_reason is null or p_queue_cleared is not true then
        return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
      end if;
    else
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_RETRYABLE', 'status', open_attempt.status);
    end if;
  else -- REPRINT
    if clean_reason is null then
      return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
    end if;
    if has_open then
      if open_attempt.attempt_id is distinct from p_previous_attempt_id then
        return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_CURRENT');
      end if;
      if open_attempt.status not in ('SUBMITTED', 'MANUAL_STARTED') then
        return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_REPRINTABLE', 'status', open_attempt.status);
      end if;
    elsif ord.state = 'READY_FOR_PICKUP' then
      if p_previous_attempt_id is distinct from ord.output_confirmed_attempt_id then
        return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_CURRENT');
      end if;
    elsif ord.state <> 'PRINTED' then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_REPRINTABLE');
    end if;
  end if;

  -- Retries and reprints keep the locked revision.
  if has_open and open_attempt.revision_ref is not null and open_attempt.revision_ref <> p_revision_id then
    return jsonb_build_object('ok', false, 'code', 'REVISION_CHANGED');
  end if;

  select coalesce(max(attempt_number), 0) + 1 into next_number
  from public.print_jobs where order_id = p_order_id;

  if has_open then
    update public.print_jobs
      set resolved_at = now(), resolution = 'SUPERSEDED', resolved_by = p_actor_id, updated_at = now()
    where attempt_id = open_attempt.attempt_id;
  end if;

  insert into public.print_jobs (
    order_id, shop_id, status, attempt_number, attempt_kind, execution_mode,
    previous_attempt_id, batch_request_id, revision_ref, device_id, printer_name,
    print_settings, printable_path, printable_sha256, printable_size, reason, created_by
  ) values (
    p_order_id, p_shop_id,
    case when p_mode = 'MANUAL' then 'MANUAL_STARTED' else 'QUEUED' end,
    next_number, p_kind, p_mode,
    case when has_open then open_attempt.attempt_id else p_previous_attempt_id end,
    p_batch_request_id, p_revision_id,
    case when p_mode = 'AGENT' then p_device_id end,
    case when p_mode = 'AGENT' then left(p_printer_name, 200) end,
    p_print_settings, p_printable_path, p_printable_sha256, p_printable_size,
    clean_reason, p_actor_id
  ) returning * into new_attempt;

  if has_open then
    update public.print_jobs set superseded_by_attempt_id = new_attempt.attempt_id
    where attempt_id = open_attempt.attempt_id;
    insert into public.print_job_events (attempt_id, order_id, shop_id, source, event_type, status, actor_id, details)
    values (open_attempt.attempt_id, p_order_id, p_shop_id, 'OPERATOR', 'ATTEMPT_SUPERSEDED', open_attempt.status, p_actor_id,
      jsonb_build_object('supersededBy', new_attempt.attempt_id, 'kind', p_kind, 'reason', clean_reason,
        'queueCleared', coalesce(p_queue_cleared, false)));
  end if;

  insert into public.print_job_events (attempt_id, order_id, shop_id, source, event_type, status, actor_id, device_id, details)
  values (new_attempt.attempt_id, p_order_id, p_shop_id, 'OPERATOR', 'ATTEMPT_CREATED', new_attempt.status, p_actor_id,
    new_attempt.device_id,
    jsonb_build_object('kind', p_kind, 'mode', p_mode, 'attemptNumber', next_number,
      'previousAttemptId', new_attempt.previous_attempt_id, 'reason', clean_reason,
      'batchRequestId', p_batch_request_id));

  -- A reprint invalidates current pickup readiness; history keeps the earlier
  -- confirmation.
  if p_kind = 'REPRINT' and ord.state in ('READY_FOR_PICKUP', 'PRINTED') then
    update public.orders set state = 'IN_PRODUCTION',
      output_confirmed_attempt_id = null, output_confirmed_at = null, output_confirmed_by = null,
      is_unclaimed = false, unclaimed_at = null, unclaimed_reason = null
    where id = p_order_id;
    insert into public.order_fulfillment_events (order_id, shop_id, event_type, attempt_id, revision_id, actor_id, reason, details)
    values (p_order_id, p_shop_id, 'READINESS_INVALIDATED', new_attempt.attempt_id, p_revision_id, p_actor_id, clean_reason,
      jsonb_build_object('previousState', ord.state, 'previousConfirmedAttemptId', ord.output_confirmed_attempt_id));
  end if;

  return jsonb_build_object('ok', true, 'attempt', to_jsonb(new_attempt),
    'supersededAttemptId', case when has_open then open_attempt.attempt_id end);
end;
$$;

create or replace function public.print_authorize_attempt(
  p_attempt_id uuid, p_shop_id uuid, p_device_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  attempt public.print_jobs%rowtype;
  ord record;
  blocker uuid;
begin
  select * into attempt from public.print_jobs where attempt_id = p_attempt_id for update;
  if not found or attempt.shop_id <> p_shop_id then
    return jsonb_build_object('authorized', false, 'reason', 'ATTEMPT_NOT_FOUND');
  end if;
  if attempt.execution_mode <> 'AGENT' or attempt.device_id is distinct from p_device_id then
    return jsonb_build_object('authorized', false, 'reason', 'WRONG_DEVICE');
  end if;
  if attempt.resolved_at is not null then
    return jsonb_build_object('authorized', false, 'reason', 'SUPERSEDED');
  end if;
  if attempt.status not in ('QUEUED', 'RECEIVED', 'DOWNLOADING') then
    return jsonb_build_object('authorized', false, 'reason', 'INVALID_STATE', 'status', attempt.status);
  end if;
  select o.state::text as state, o.handed_over_at, o.acceptance_status, o.payment_method, o.payment_status into ord
  from public.orders o where o.id = attempt.order_id;
  if not found or ord.state <> 'IN_PRODUCTION' or ord.handed_over_at is not null then
    return jsonb_build_object('authorized', false, 'reason', 'ORDER_NOT_PRINTABLE');
  end if;
  if ord.acceptance_status <> 'ACCEPTED'
    or not public.order_has_valid_asset(attempt.order_id)
    or not exists (select 1 from public.shops s where s.id = p_shop_id and s.verification_status::text = 'VERIFIED')
    or (ord.payment_method = 'GCASH' and ord.payment_status <> 'VERIFIED')
    or (ord.payment_method = 'CASH_ON_PICKUP' and ord.payment_status not in ('DUE_AT_PICKUP', 'COLLECTED'))
  then
    return jsonb_build_object('authorized', false, 'reason', 'PAYMENT_NOT_ELIGIBLE');
  end if;
  -- An uncertain or hung invocation pauses this agent until it is resolved.
  select attempt_id into blocker from public.print_jobs
  where device_id = p_device_id and resolved_at is null and attempt_id <> p_attempt_id
    and status in ('OUTCOME_UNKNOWN', 'SUBMITTING')
  limit 1;
  if blocker is not null then
    return jsonb_build_object('authorized', false, 'reason', 'DEVICE_PAUSED', 'blockingAttemptId', blocker);
  end if;
  update public.print_jobs set authorized_at = now(), agent_seen_at = now() where attempt_id = p_attempt_id;
  insert into public.print_job_events (attempt_id, order_id, shop_id, source, event_type, status, device_id)
  values (p_attempt_id, attempt.order_id, attempt.shop_id, 'SERVER', 'PRINT_AUTHORIZED', attempt.status, p_device_id);
  return jsonb_build_object('authorized', true);
end;
$$;

create or replace function public.print_record_handover(
  p_order_id uuid, p_shop_id uuid, p_expected_attempt_id uuid, p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare ord record;
begin
  select o.id, o.state::text as state, o.handed_over_at, o.output_confirmed_attempt_id, o.output_confirmed_at
    into ord
  from public.orders o where o.id = p_order_id and o.shop_id = p_shop_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  if ord.state = 'COMPLETED' and ord.handed_over_at is not null then
    return jsonb_build_object('ok', true, 'result', 'DUPLICATE');
  end if;
  if ord.state <> 'READY_FOR_PICKUP' or ord.output_confirmed_at is null then
    return jsonb_build_object('ok', false, 'code', 'OUTPUT_NOT_CONFIRMED');
  end if;
  if ord.output_confirmed_attempt_id is distinct from p_expected_attempt_id then
    return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_CURRENT');
  end if;
  if exists (select 1 from public.print_jobs where order_id = p_order_id and resolved_at is null) then
    return jsonb_build_object('ok', false, 'code', 'ATTEMPT_OPEN');
  end if;
  if not public.order_payment_settled(p_order_id) then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_NOT_SETTLED');
  end if;
  update public.orders set state = 'COMPLETED', handed_over_at = now(), handed_over_by = p_actor_id,
    is_unclaimed = false, unclaimed_at = null, unclaimed_reason = null
  where id = p_order_id;
  insert into public.order_fulfillment_events (order_id, shop_id, event_type, attempt_id, actor_id)
  values (p_order_id, p_shop_id, 'HANDED_OVER', p_expected_attempt_id, p_actor_id);
  return jsonb_build_object('ok', true, 'result', 'HANDED_OVER');
end;
$$;

drop function if exists public.claim_payment_eligible_print_job(uuid, uuid);
notify pgrst, 'reload schema';
commit;
