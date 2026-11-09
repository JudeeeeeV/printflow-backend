begin;

set local lock_timeout = '3s';

-- One row per logical student action. Rows have no foreign key to orders, so a
-- late retry of a deleted draft still finds its result instead of recreating it.
create table if not exists public.order_operations (
  user_id uuid not null references public.users(id) on delete cascade,
  operation_key uuid not null,
  action text not null check (action in
    ('CREATE_ORDER', 'CREATE_DRAFT', 'UPDATE_DRAFT', 'SUBMIT_DRAFT', 'UPLOAD_RECEIPT')),
  target_id uuid,
  fingerprint text not null,
  content_hash text,
  planned_order_id uuid not null default gen_random_uuid(),
  status text not null default 'PROCESSING' check (status in ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  generation integer not null default 1,
  lease_expires_at timestamptz not null,
  staged_bucket text,
  staged_path text,
  result jsonb,
  error_status integer,
  error_body jsonb,
  retryable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, operation_key)
);

create index if not exists order_operations_sweep_idx
  on public.order_operations (status, lease_expires_at);
create index if not exists order_operations_recent_content_idx
  on public.order_operations (user_id, action, target_id, content_hash, created_at desc);

alter table public.order_operations enable row level security;
revoke all on table public.order_operations from public, anon, authenticated;
grant select, insert, update, delete on table public.order_operations to service_role;

create or replace function public.claim_order_operation(p_user uuid, p_key uuid, p_action text,
  p_target uuid, p_fingerprint text, p_content_hash text, p_lease_seconds integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '3s' as $$
declare
  op public.order_operations%rowtype;
begin
  insert into public.order_operations(user_id, operation_key, action, target_id, fingerprint,
    content_hash, lease_expires_at)
  values (p_user, p_key, p_action, p_target, p_fingerprint, p_content_hash,
    now() + make_interval(secs => p_lease_seconds))
  on conflict (user_id, operation_key) do nothing
  returning * into op;
  if found then
    return jsonb_build_object('outcome', 'claimed', 'generation', op.generation,
      'plannedOrderId', op.planned_order_id);
  end if;

  select * into op from public.order_operations
    where user_id = p_user and operation_key = p_key for update;
  if op.action <> p_action or op.target_id is distinct from p_target or op.fingerprint <> p_fingerprint then
    return jsonb_build_object('outcome', 'conflict');
  end if;
  if op.status = 'SUCCEEDED' then
    return jsonb_build_object('outcome', 'succeeded', 'result', op.result);
  end if;
  if op.status = 'FAILED' and not op.retryable then
    return jsonb_build_object('outcome', 'failed', 'errorStatus', op.error_status, 'errorBody', op.error_body);
  end if;
  if op.status = 'PROCESSING' and op.lease_expires_at > now() then
    return jsonb_build_object('outcome', 'processing', 'retryAfterSeconds',
      greatest(1, ceil(extract(epoch from op.lease_expires_at - now()))::integer));
  end if;

  update public.order_operations set status = 'PROCESSING', generation = generation + 1,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), error_status = null,
    error_body = null, retryable = false, updated_at = now()
  where user_id = p_user and operation_key = p_key
  returning * into op;
  return jsonb_build_object('outcome', 'claimed', 'generation', op.generation,
    'plannedOrderId', op.planned_order_id);
end $$;

-- Applies an operation's writes and records its result in one transaction.
-- PF001: this worker no longer holds the claim. PF002: not a draft. PF003: stale version.
create or replace function public.commit_order_operation(p_user uuid, p_key uuid, p_generation integer,
  p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '3s' as $$
declare
  op public.order_operations%rowtype;
  o public.orders%rowtype;
  settings public.orders%rowtype;
  decided jsonb;
  outcome jsonb;
  replaced text[] := '{}';
  expected bigint := (p_data->>'expectedVersion')::bigint;
  asset_path text := nullif(p_data#>>'{asset,path}', '');
begin
  select * into op from public.order_operations
    where user_id = p_user and operation_key = p_key for update;
  if not found then raise exception 'Operation not found' using errcode = 'P0002'; end if;
  if op.status = 'SUCCEEDED' then
    return jsonb_build_object('result', op.result, 'replacedPaths', '[]'::jsonb);
  end if;
  if op.status <> 'PROCESSING' or op.generation <> p_generation or op.lease_expires_at <= now() then
    raise exception 'Operation claim is no longer current' using errcode = 'PF001';
  end if;

  if op.action in ('CREATE_ORDER', 'CREATE_DRAFT') then
    if asset_path is null then raise exception 'A stored document is required' using errcode = '23514'; end if;
    settings := jsonb_populate_record(null::public.orders, p_data->'order');
    insert into public.orders(id, client_id, shop_id, state, total, print_color_mode, paper_size,
      page_count, payment_method, order_name, orientation, copies)
    values (op.planned_order_id, p_user, op.target_id, settings.state, settings.total,
      settings.print_color_mode, settings.paper_size, settings.page_count,
      coalesce(settings.payment_method, 'GCASH'), settings.order_name, settings.orientation, settings.copies)
    returning * into o;
    insert into public.assets(order_id, file_url, dpi, file_type, original_filename)
    values (o.id, asset_path, (p_data#>>'{asset,dpi}')::integer, p_data#>>'{asset,fileType}',
      p_data#>>'{asset,originalFilename}');
    outcome := jsonb_build_object('message', p_data->>'message', 'orderId', o.id,
      'state', o.state, 'order', to_jsonb(o));
  elsif op.action in ('UPDATE_DRAFT', 'SUBMIT_DRAFT') then
    select * into o from public.orders where id = op.target_id and client_id = p_user for update;
    if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
    if o.state::text <> 'DRAFT' then raise exception 'Order is not a draft' using errcode = 'PF002'; end if;
    if expected is not null and o.draft_version <> expected then
      raise exception 'Draft version is stale' using errcode = 'PF003';
    end if;
    settings := jsonb_populate_record(null::public.orders, p_data->'order');
    update public.orders set
      shop_id = coalesce(settings.shop_id, o.shop_id),
      paper_size = coalesce(settings.paper_size, o.paper_size),
      print_color_mode = coalesce(settings.print_color_mode, o.print_color_mode),
      total = coalesce(settings.total, o.total),
      page_count = coalesce(settings.page_count, o.page_count),
      payment_method = coalesce(settings.payment_method, o.payment_method),
      order_name = coalesce(settings.order_name, o.order_name),
      orientation = coalesce(settings.orientation, o.orientation),
      copies = coalesce(settings.copies, o.copies),
      state = case when op.action = 'SUBMIT_DRAFT' then 'OPEN_INQUIRY'::public.order_state else o.state end,
      created_at = case when op.action = 'SUBMIT_DRAFT' then now() else o.created_at end
    where id = o.id returning * into o;
    if asset_path is not null then
      select coalesce(array_agg(file_url), '{}') into replaced from public.assets where order_id = o.id;
      delete from public.assets where order_id = o.id;
      insert into public.assets(order_id, file_url, dpi, file_type, original_filename)
      values (o.id, asset_path, (p_data#>>'{asset,dpi}')::integer, p_data#>>'{asset,fileType}',
        p_data#>>'{asset,originalFilename}');
    end if;
    outcome := jsonb_build_object('message', p_data->>'message', 'orderId', o.id,
      'state', o.state, 'order', to_jsonb(o));
  else
    decided := public.apply_order_decision(op.target_id, p_user, 'STUDENT', 'UPLOAD_RECEIPT',
      jsonb_build_object('receiptPath', p_data->>'receiptPath', 'reference', p_data->>'reference'));
    outcome := jsonb_build_object('message', p_data->>'message', 'state', decided->>'state', 'order', decided);
  end if;

  update public.order_operations set status = 'SUCCEEDED', result = outcome, staged_bucket = null,
    staged_path = null, completed_at = now(), updated_at = now()
  where user_id = p_user and operation_key = p_key;
  return jsonb_build_object('result', outcome, 'replacedPaths', to_jsonb(replaced));
end $$;

revoke all on function public.claim_order_operation(uuid, uuid, text, uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.commit_order_operation(uuid, uuid, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_order_operation(uuid, uuid, text, uuid, text, text, integer) to service_role;
grant execute on function public.commit_order_operation(uuid, uuid, integer, jsonb) to service_role;

commit;
