-- Priority #4: durable print attempts, agent event history, idempotent batch
-- requests, and operator-confirmed fulfillment.
--
-- This migration is additive and repeatable. Existing print_jobs rows are kept;
-- their original status is preserved in legacy_status, and legacy evidence is
-- mapped conservatively (a legacy COMPLETED job is submission evidence only).
-- Authoritative transitions live in the functions below so every rule runs in
-- one transaction with row locks.
begin;

-- RLS stays enabled on every table at all times. Re-assert it on the existing
-- tables before changing them; new tables enable it immediately on creation.
-- Only the backend's service role (which bypasses RLS) reads or writes them.
alter table public.print_jobs enable row level security;
alter table public.orders enable row level security;

-- ---------------------------------------------------------------------------
-- Attempts: extend the existing print_jobs table.
-- ---------------------------------------------------------------------------
alter table public.print_jobs
  add column if not exists attempt_id uuid,
  add column if not exists attempt_number integer,
  add column if not exists attempt_kind text,
  add column if not exists execution_mode text,
  add column if not exists previous_attempt_id uuid,
  add column if not exists superseded_by_attempt_id uuid,
  add column if not exists batch_request_id uuid,
  add column if not exists revision_id text,
  add column if not exists device_id uuid,
  add column if not exists printer_name text,
  add column if not exists print_settings jsonb,
  add column if not exists printable_path text,
  add column if not exists printable_sha256 text,
  add column if not exists printable_size bigint,
  add column if not exists failure_phase text,
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists last_event_sequence integer not null default 0,
  add column if not exists reason text,
  add column if not exists created_by uuid,
  add column if not exists authorized_at timestamptz,
  add column if not exists received_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists agent_seen_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution text,
  add column if not exists resolved_by uuid,
  add column if not exists legacy_status text,
  add column if not exists is_legacy boolean not null default false;

update public.print_jobs set attempt_id = gen_random_uuid() where attempt_id is null;
alter table public.print_jobs alter column attempt_id set default gen_random_uuid();
alter table public.print_jobs alter column attempt_id set not null;
do $$ begin
  alter table public.print_jobs add constraint print_jobs_attempt_id_key unique (attempt_id);
exception when duplicate_object or duplicate_table then null;
end $$;

-- Number legacy attempts in creation order.
with numbered as (
  select id, row_number() over (partition by order_id order by created_at, id) as n
  from public.print_jobs
)
update public.print_jobs j set attempt_number = numbered.n
from numbered
where numbered.id = j.id and j.attempt_number is null;

-- The old "one active job" rule treated FAILED as finished. Replace it with
-- "one unresolved attempt per order" (created below, after legacy cleanup).
drop index if exists public.print_jobs_one_active_per_order_idx;

-- Map legacy statuses once. New rows always carry attempt_kind, so repeated
-- application never remaps them. The old agent reported SENT_TO_SPOOLER before
-- invoking the printer, and FAILED for both download and printing errors, so
-- neither proves whether anything printed.
update public.print_jobs set
  legacy_status = status,
  is_legacy = true,
  attempt_kind = 'INITIAL',
  execution_mode = 'AGENT',
  status = case status
    when 'COMPLETED' then 'SUBMITTED'
    else 'OUTCOME_UNKNOWN'
  end,
  submitted_at = case when status = 'COMPLETED' then updated_at end
where attempt_kind is null;

-- Close legacy attempts that are superseded by a later one or belong to an
-- order that is no longer awaiting production or output confirmation. The
-- latest legacy attempt of an active order stays open for reconciliation.
update public.print_jobs j set
  resolved_at = coalesce(j.updated_at, now()),
  resolution = 'LEGACY_CLOSED'
where j.is_legacy and j.resolved_at is null and (
  exists (
    select 1 from public.print_jobs later
    where later.order_id = j.order_id and later.attempt_number > j.attempt_number
  )
  or not exists (
    select 1 from public.orders o
    where o.id = j.order_id and o.state::text in ('IN_PRODUCTION', 'PRINTED')
  )
);

-- Defaults keep inserts from a not-yet-updated backend working during rollout.
-- They are set only after the legacy remap above, so it still finds old rows.
alter table public.print_jobs alter column attempt_kind set default 'INITIAL';
alter table public.print_jobs alter column execution_mode set default 'AGENT';
create or replace function public.print_jobs_assign_attempt_number()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.attempt_number is null then
    select coalesce(max(attempt_number), 0) + 1 into new.attempt_number
    from public.print_jobs where order_id = new.order_id;
  end if;
  return new;
end;
$$;
drop trigger if exists print_jobs_assign_attempt_number on public.print_jobs;
create trigger print_jobs_assign_attempt_number before insert on public.print_jobs
for each row execute function public.print_jobs_assign_attempt_number();
revoke all on function public.print_jobs_assign_attempt_number() from public, anon, authenticated;

alter table public.print_jobs alter column attempt_number set not null;
alter table public.print_jobs alter column attempt_kind set not null;
alter table public.print_jobs alter column execution_mode set not null;

create unique index if not exists print_jobs_one_open_attempt_per_order_idx
  on public.print_jobs(order_id) where resolved_at is null;
create unique index if not exists print_jobs_order_attempt_number_idx
  on public.print_jobs(order_id, attempt_number);
create index if not exists print_jobs_open_device_idx
  on public.print_jobs(device_id) where resolved_at is null;
create index if not exists print_jobs_batch_request_idx
  on public.print_jobs(batch_request_id) where batch_request_id is not null;

do $$ begin
  alter table public.print_jobs add constraint print_jobs_status_check check (status in (
    'QUEUED', 'RECEIVED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED',
    'FAILED_PRE_SUBMISSION', 'OUTCOME_UNKNOWN', 'MANUAL_STARTED',
    -- Accepted only so an older backend instance can keep writing during a
    -- rolling deployment; the functions below never produce these values.
    'SENT_TO_SPOOLER', 'COMPLETED', 'FAILED'
  ));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.print_jobs add constraint print_jobs_attempt_kind_check
    check (attempt_kind in ('INITIAL', 'RETRY', 'REPRINT'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.print_jobs add constraint print_jobs_execution_mode_check
    check (execution_mode in ('AGENT', 'MANUAL'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.print_jobs add constraint print_jobs_resolution_check check (
    (resolved_at is null and resolution is null)
    or (resolved_at is not null and resolution in ('SUPERSEDED', 'OUTPUT_CONFIRMED', 'LEGACY_CLOSED'))
  );
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.print_jobs add constraint print_jobs_error_bounds_check check (
    (error_code is null or char_length(error_code) <= 64)
    and (error_message is null or char_length(error_message) <= 500)
    and (reason is null or char_length(reason) <= 500)
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Append-only attempt event history.
-- ---------------------------------------------------------------------------
create table if not exists public.print_job_events (
  id bigint generated by default as identity primary key,
  attempt_id uuid not null references public.print_jobs(attempt_id) on delete cascade,
  order_id uuid not null,
  shop_id uuid not null,
  source text not null check (source in ('AGENT', 'OPERATOR', 'SERVER', 'MIGRATION')),
  event_type text not null check (char_length(event_type) <= 64),
  status text check (status is null or char_length(status) <= 64),
  agent_sequence integer check (agent_sequence is null or agent_sequence > 0),
  device_id uuid,
  actor_id uuid,
  outcome text check (outcome is null or char_length(outcome) <= 64),
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.print_job_events enable row level security;
revoke all on table public.print_job_events from public, anon, authenticated;
create unique index if not exists print_job_events_agent_sequence_idx
  on public.print_job_events(attempt_id, agent_sequence) where agent_sequence is not null;
create index if not exists print_job_events_order_idx on public.print_job_events(order_id, id);

create or replace function public.print_job_events_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'print_job_events is append-only';
end;
$$;
drop trigger if exists print_job_events_append_only on public.print_job_events;
create trigger print_job_events_append_only before update on public.print_job_events
for each row execute function public.print_job_events_append_only();

-- Record legacy history once, without inventing devices or actors.
insert into public.print_job_events (attempt_id, order_id, shop_id, source, event_type, status, details, created_at)
select j.attempt_id, j.order_id, j.shop_id, 'MIGRATION', 'LEGACY_BACKFILL', j.status,
  jsonb_build_object('legacyStatus', j.legacy_status, 'resolution', j.resolution),
  j.updated_at
from public.print_jobs j
where j.is_legacy and not exists (
  select 1 from public.print_job_events e
  where e.attempt_id = j.attempt_id and e.event_type = 'LEGACY_BACKFILL'
);

-- ---------------------------------------------------------------------------
-- Idempotent batch requests bound to their reviewed contents.
-- ---------------------------------------------------------------------------
create table if not exists public.print_batch_requests (
  request_id uuid primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'COMPLETED', 'FAILED')),
  response jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.print_batch_requests enable row level security;
revoke all on table public.print_batch_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fulfillment milestones on orders, with their own history.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists output_confirmed_attempt_id uuid,
  add column if not exists output_confirmed_at timestamptz,
  add column if not exists output_confirmed_by uuid,
  add column if not exists handed_over_at timestamptz,
  add column if not exists handed_over_by uuid;

create table if not exists public.order_fulfillment_events (
  id bigint generated by default as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  shop_id uuid not null,
  event_type text not null check (event_type in (
    'OUTPUT_CONFIRMED', 'READINESS_INVALIDATED', 'HANDED_OVER', 'RECONCILIATION_NOTE'
  )),
  attempt_id uuid references public.print_jobs(attempt_id),
  revision_id text,
  actor_id uuid,
  reason text check (reason is null or char_length(reason) <= 500),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.order_fulfillment_events enable row level security;
revoke all on table public.order_fulfillment_events from public, anon, authenticated;
create index if not exists order_fulfillment_events_order_idx
  on public.order_fulfillment_events(order_id, id);

grant select, insert, update, delete on table
  public.print_job_events, public.print_batch_requests, public.order_fulfillment_events
  to service_role;
revoke all on sequence public.print_job_events_id_seq from public, anon, authenticated;
revoke all on sequence public.order_fulfillment_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.print_job_events_id_seq to service_role;
grant usage, select on sequence public.order_fulfillment_events_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Payment requirement for handover. Priority #1's cash collection extends this
-- single function; printer events never modify payment records.
-- ---------------------------------------------------------------------------
create or replace function public.order_payment_settled(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.payment_receipts r
    where r.order_id = p_order_id and r.verified is true
  );
$$;

-- ---------------------------------------------------------------------------
-- Batch requests.
-- ---------------------------------------------------------------------------
create or replace function public.print_begin_batch_request(
  p_request_id uuid, p_shop_id uuid, p_request_hash text, p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request public.print_batch_requests%rowtype;
  inserted integer;
begin
  insert into public.print_batch_requests (request_id, shop_id, request_hash, created_by)
  values (p_request_id, p_shop_id, p_request_hash, p_actor_id)
  on conflict (request_id) do nothing;
  get diagnostics inserted = row_count;
  select * into request from public.print_batch_requests where request_id = p_request_id for update;
  if request.shop_id <> p_shop_id or request.request_hash <> p_request_hash then
    return jsonb_build_object('state', 'CONFLICT');
  end if;
  if inserted = 1 then return jsonb_build_object('state', 'NEW'); end if;
  if request.status = 'PENDING' then
    return jsonb_build_object('state', 'IN_PROGRESS');
  end if;
  return jsonb_build_object('state', 'DONE', 'status', request.status, 'response', request.response);
end;
$$;

create or replace function public.print_complete_batch_request(
  p_request_id uuid, p_shop_id uuid, p_status text, p_response jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare updated integer;
begin
  if p_status not in ('COMPLETED', 'FAILED') then return false; end if;
  update public.print_batch_requests
    set status = p_status, response = p_response, completed_at = now()
  where request_id = p_request_id and shop_id = p_shop_id and status = 'PENDING';
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Attempt creation: initial dispatch, retry, reprint, automated or manual.
-- ---------------------------------------------------------------------------
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

  select o.id, o.state::text as state, o.handed_over_at, o.output_confirmed_attempt_id
    into ord
  from public.orders o
  where o.id = p_order_id and o.shop_id = p_shop_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  if ord.handed_over_at is not null or ord.state not in ('IN_PRODUCTION', 'PRINTED', 'READY_FOR_PICKUP') then
    return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_PRINTABLE');
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
  if has_open and open_attempt.revision_id is not null and open_attempt.revision_id <> p_revision_id then
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
    previous_attempt_id, batch_request_id, revision_id, device_id, printer_name,
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
      output_confirmed_attempt_id = null, output_confirmed_at = null, output_confirmed_by = null
    where id = p_order_id;
    insert into public.order_fulfillment_events (order_id, shop_id, event_type, attempt_id, revision_id, actor_id, reason, details)
    values (p_order_id, p_shop_id, 'READINESS_INVALIDATED', new_attempt.attempt_id, p_revision_id, p_actor_id, clean_reason,
      jsonb_build_object('previousState', ord.state, 'previousConfirmedAttemptId', ord.output_confirmed_attempt_id));
  end if;

  return jsonb_build_object('ok', true, 'attempt', to_jsonb(new_attempt),
    'supersededAttemptId', case when has_open then open_attempt.attempt_id end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Agent events: bound to the attempt and authenticated device, deduplicated by
-- sequence, and never allowed to change orders.
-- ---------------------------------------------------------------------------
create or replace function public.print_record_agent_event(
  p_attempt_id uuid, p_shop_id uuid, p_device_id uuid, p_sequence integer,
  p_status text, p_failure_phase text, p_error_code text, p_error_message text,
  p_occurred_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  attempt public.print_jobs%rowtype;
  inserted_id bigint;
  effective text := p_status;
  outcome text;
  current_rank integer;
  new_rank integer;
  terminal boolean := p_status in ('SUBMITTED', 'FAILED_PRE_SUBMISSION', 'OUTCOME_UNKNOWN');
begin
  if p_sequence is null or p_sequence < 1 or p_status is null or p_status not in (
    'RECEIVED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED', 'FAILED_PRE_SUBMISSION', 'OUTCOME_UNKNOWN'
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_EVENT', 'retry', false);
  end if;
  select * into attempt from public.print_jobs where attempt_id = p_attempt_id for update;
  if not found or attempt.shop_id <> p_shop_id then
    return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_FOUND', 'retry', false);
  end if;
  if attempt.execution_mode <> 'AGENT' or attempt.device_id is distinct from p_device_id then
    return jsonb_build_object('ok', false, 'code', 'WRONG_DEVICE', 'retry', false);
  end if;

  current_rank := case attempt.status
    when 'QUEUED' then 0 when 'RECEIVED' then 1 when 'DOWNLOADING' then 2 when 'SUBMITTING' then 3
    else 99 end;
  new_rank := case p_status
    when 'RECEIVED' then 1 when 'DOWNLOADING' then 2 when 'SUBMITTING' then 3 else 100 end;

  if attempt.resolved_at is not null then
    outcome := 'IGNORED_RESOLVED';
  elsif p_sequence <= attempt.last_event_sequence then
    outcome := 'IGNORED_OUT_OF_ORDER';
  elsif current_rank = 99 then
    outcome := 'IGNORED_TERMINAL';
  elsif not terminal and new_rank <= current_rank then
    outcome := 'IGNORED_REGRESSION';
  elsif p_status = 'FAILED_PRE_SUBMISSION' and attempt.status = 'SUBMITTING' then
    -- Invocation had started; a later "pre-submission" claim cannot be trusted.
    effective := 'OUTCOME_UNKNOWN';
    outcome := 'APPLIED_AS_UNKNOWN';
  else
    outcome := 'APPLIED';
  end if;

  insert into public.print_job_events (
    attempt_id, order_id, shop_id, source, event_type, status, agent_sequence,
    device_id, outcome, details, occurred_at
  ) values (
    p_attempt_id, attempt.order_id, attempt.shop_id, 'AGENT', 'AGENT_STATUS', p_status, p_sequence,
    p_device_id, outcome,
    jsonb_strip_nulls(jsonb_build_object('failurePhase', left(p_failure_phase, 64),
      'errorCode', left(p_error_code, 64), 'errorMessage', left(p_error_message, 500),
      'effectiveStatus', effective)),
    p_occurred_at
  )
  on conflict (attempt_id, agent_sequence) where agent_sequence is not null do nothing
  returning id into inserted_id;

  if inserted_id is null then
    return jsonb_build_object('ok', true, 'result', 'DUPLICATE', 'attempt', to_jsonb(attempt));
  end if;

  if outcome like 'APPLIED%' then
    update public.print_jobs set
      status = effective,
      last_event_sequence = p_sequence,
      updated_at = now(),
      agent_seen_at = now(),
      received_at = coalesce(received_at, now()),
      submitted_at = case when effective = 'SUBMITTED' then now() else submitted_at end,
      failure_phase = case when effective in ('FAILED_PRE_SUBMISSION', 'OUTCOME_UNKNOWN')
        then left(coalesce(p_failure_phase, attempt.status), 64) else failure_phase end,
      error_code = case when effective in ('FAILED_PRE_SUBMISSION', 'OUTCOME_UNKNOWN')
        then left(p_error_code, 64) else error_code end,
      error_message = case when effective in ('FAILED_PRE_SUBMISSION', 'OUTCOME_UNKNOWN')
        then left(p_error_message, 500) else error_message end
    where attempt_id = p_attempt_id
    returning * into attempt;
  end if;

  return jsonb_build_object('ok', true, 'result', outcome, 'attempt', to_jsonb(attempt));
end;
$$;

-- Recheck immediately before print invocation.
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
  select o.state::text as state, o.handed_over_at into ord
  from public.orders o where o.id = attempt.order_id;
  if not found or ord.state <> 'IN_PRODUCTION' or ord.handed_over_at is not null then
    return jsonb_build_object('authorized', false, 'reason', 'ORDER_NOT_PRINTABLE');
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

-- Server-side failure for attempts the agent can be proven never to have
-- received (no live connection at dispatch and never authorized).
create or replace function public.print_mark_undelivered(
  p_attempt_ids uuid[], p_shop_id uuid, p_error_code text, p_error_message text
) returns integer language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  with failed as (
    update public.print_jobs set status = 'FAILED_PRE_SUBMISSION', failure_phase = 'DELIVERY',
      error_code = left(p_error_code, 64), error_message = left(p_error_message, 500), updated_at = now()
    where attempt_id = any(p_attempt_ids) and shop_id = p_shop_id and resolved_at is null
      and status = 'QUEUED' and authorized_at is null and last_event_sequence = 0
    returning attempt_id, order_id, shop_id
  ), logged as (
    insert into public.print_job_events (attempt_id, order_id, shop_id, source, event_type, status, details)
    select attempt_id, order_id, shop_id, 'SERVER', 'DELIVERY_FAILED', 'FAILED_PRE_SUBMISSION',
      jsonb_build_object('errorCode', left(p_error_code, 64))
    from failed
    returning 1
  )
  select count(*) into changed from logged;
  return changed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator fulfillment decisions.
-- ---------------------------------------------------------------------------
create or replace function public.print_confirm_output(
  p_order_id uuid, p_shop_id uuid, p_expected_attempt_id uuid, p_actor_id uuid,
  p_reason text, p_checks jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ord record;
  attempt public.print_jobs%rowtype;
  has_open boolean;
  clean_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  check_name text;
  revision text;
begin
  if clean_reason is not null and char_length(clean_reason) > 500 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  end if;
  select o.id, o.state::text as state, o.handed_over_at, o.output_confirmed_attempt_id, o.output_confirmed_at
    into ord
  from public.orders o where o.id = p_order_id and o.shop_id = p_shop_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  if ord.state = 'READY_FOR_PICKUP' and ord.output_confirmed_at is not null
    and ord.output_confirmed_attempt_id is not distinct from p_expected_attempt_id then
    return jsonb_build_object('ok', true, 'result', 'DUPLICATE');
  end if;
  -- Legacy READY_FOR_PICKUP orders were marked ready without inspection.
  if ord.handed_over_at is not null or not (
    ord.state in ('IN_PRODUCTION', 'PRINTED')
    or (ord.state = 'READY_FOR_PICKUP' and ord.output_confirmed_at is null)
  ) then
    return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_CONFIRMABLE');
  end if;
  foreach check_name in array array['document', 'revision', 'paper', 'color', 'orientation', 'pages', 'copies'] loop
    if coalesce((p_checks ->> check_name)::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'code', 'CHECKS_INCOMPLETE', 'check', check_name);
    end if;
  end loop;

  select * into attempt from public.print_jobs
  where order_id = p_order_id and resolved_at is null for update;
  has_open := found;
  if has_open then
    if attempt.attempt_id is distinct from p_expected_attempt_id then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_CURRENT');
    end if;
    if attempt.status = 'FAILED_PRE_SUBMISSION' then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_FAILED');
    end if;
    if attempt.status not in ('SUBMITTED', 'MANUAL_STARTED') and clean_reason is null then
      return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REASON_REQUIRED');
    end if;
    revision := attempt.revision_id;
  else
    if p_expected_attempt_id is not null then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_CURRENT');
    end if;
    if clean_reason is null then
      return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REASON_REQUIRED');
    end if;
  end if;

  update public.orders set state = 'READY_FOR_PICKUP',
    output_confirmed_attempt_id = p_expected_attempt_id,
    output_confirmed_at = now(), output_confirmed_by = p_actor_id
  where id = p_order_id;
  if has_open then
    update public.print_jobs set resolved_at = now(), resolution = 'OUTPUT_CONFIRMED',
      resolved_by = p_actor_id, updated_at = now()
    where attempt_id = attempt.attempt_id;
    insert into public.print_job_events (attempt_id, order_id, shop_id, source, event_type, status, actor_id, details)
    values (attempt.attempt_id, p_order_id, p_shop_id, 'OPERATOR', 'OUTPUT_CONFIRMED', attempt.status, p_actor_id,
      jsonb_build_object('reason', clean_reason));
  end if;
  insert into public.order_fulfillment_events (order_id, shop_id, event_type, attempt_id, revision_id, actor_id, reason, details)
  values (p_order_id, p_shop_id, 'OUTPUT_CONFIRMED', p_expected_attempt_id, revision, p_actor_id, clean_reason,
    jsonb_build_object('checks', p_checks, 'previousState', ord.state,
      'attemptStatus', case when has_open then attempt.status end,
      'reconciled', clean_reason is not null));
  return jsonb_build_object('ok', true, 'result', 'CONFIRMED');
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
  update public.orders set state = 'COMPLETED', handed_over_at = now(), handed_over_by = p_actor_id
  where id = p_order_id;
  insert into public.order_fulfillment_events (order_id, shop_id, event_type, attempt_id, actor_id)
  values (p_order_id, p_shop_id, 'HANDED_OVER', p_expected_attempt_id, p_actor_id);
  return jsonb_build_object('ok', true, 'result', 'HANDED_OVER');
end;
$$;

-- "Outcome is still uncertain": record the inspection and leave the order blocked.
create or replace function public.print_record_reconciliation_note(
  p_attempt_id uuid, p_shop_id uuid, p_actor_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  attempt public.print_jobs%rowtype;
  clean_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if clean_reason is null or char_length(clean_reason) > 500 then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  end if;
  select * into attempt from public.print_jobs where attempt_id = p_attempt_id and shop_id = p_shop_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_FOUND'); end if;
  insert into public.print_job_events (attempt_id, order_id, shop_id, source, event_type, status, actor_id, details)
  values (p_attempt_id, attempt.order_id, p_shop_id, 'OPERATOR', 'STILL_UNCERTAIN', attempt.status, p_actor_id,
    jsonb_build_object('reason', clean_reason));
  insert into public.order_fulfillment_events (order_id, shop_id, event_type, attempt_id, revision_id, actor_id, reason)
  values (attempt.order_id, p_shop_id, 'RECONCILIATION_NOTE', p_attempt_id, attempt.revision_id, p_actor_id, clean_reason);
  return jsonb_build_object('ok', true, 'result', 'RECORDED');
end;
$$;

do $$
declare signature text;
begin
  foreach signature in array array[
    'public.order_payment_settled(uuid)',
    'public.print_begin_batch_request(uuid, uuid, text, uuid)',
    'public.print_complete_batch_request(uuid, uuid, text, jsonb)',
    'public.print_create_attempt(uuid, uuid, text, text, uuid, text, text, text, bigint, uuid, text, jsonb, uuid, uuid, text, boolean)',
    'public.print_record_agent_event(uuid, uuid, uuid, integer, text, text, text, text, timestamptz)',
    'public.print_authorize_attempt(uuid, uuid, uuid)',
    'public.print_mark_undelivered(uuid[], uuid, text, text)',
    'public.print_confirm_output(uuid, uuid, uuid, uuid, text, jsonb)',
    'public.print_record_handover(uuid, uuid, uuid, uuid)',
    'public.print_record_reconciliation_note(uuid, uuid, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end $$;
revoke all on function public.print_job_events_append_only() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
