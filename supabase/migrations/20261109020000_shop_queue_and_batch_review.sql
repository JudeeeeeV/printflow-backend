-- Priority #3. Additive queue reads and atomic claims; no document revisions.
begin;
set local lock_timeout = '3s';

create or replace function public.shop_queue_classify(o jsonb, a jsonb, has_file boolean)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  s text := o->>'state';
  ps text := o->>'payment_status';
  opened boolean := a is not null and a->>'resolved_at' is null;
  valid_settings boolean := coalesce(o->>'paper_size' in ('SHORT','A4','LONG')
    and o->>'print_color_mode' in ('COLOR','BLACK_AND_WHITE')
    and o->>'orientation' in ('PORTRAIT','LANDSCAPE'), false);
  eligible boolean := coalesce(o->>'acceptance_status' = 'ACCEPTED' and has_file and
    case when o->>'payment_method' = 'CASH_ON_PICKUP' then ps in ('DUE_AT_PICKUP','COLLECTED')
    else ps = 'VERIFIED' end, false);
  section text;
  reasons jsonb := '[]';
  actions jsonb := '["review"]';
  priority integer := 4;
begin
  if s = 'DRAFT' then return null; end if;
  if ps in ('REFUND_DUE','PENDING_VERIFICATION','DISPUTED','REVIEW_REQUIRED') then
    section := 'new';
  elsif s in ('COMPLETED','CANCELLED','REJECTED','EXPIRED') then
    section := case when opened then 'ready' else 'history' end;
  elsif s in ('PRINTED','READY_FOR_PICKUP') then section := 'pickup';
  elsif s = 'IN_PRODUCTION' then
    section := case when not eligible or (not opened and not valid_settings) then 'new'
      when opened and a->>'status' in ('SUBMITTED','MANUAL_STARTED') then 'pickup' else 'ready' end;
  else section := 'new'; end if;

  if not has_file then reasons := reasons || '["The stored document is unavailable."]'; end if;
  if not valid_settings then reasons := reasons || '["Complete, valid print settings are required."]'; end if;
  if o->>'handed_over_at' is not null then reasons := reasons || '["This order has already been handed over."]'; end if;
  if o->>'acceptance_status' <> 'ACCEPTED' then
    reasons := reasons || jsonb_build_array(case when o->>'payment_method' = 'CASH_ON_PICKUP'
      then 'Shop acceptance is required.' else 'GCash payment must authorize production.' end);
  end if;
  if not eligible then reasons := reasons || '["Payment or acceptance does not allow production."]'; end if;
  if s <> 'IN_PRODUCTION' then reasons := reasons || '["This order is not awaiting initial printing."]'; end if;
  if opened then reasons := reasons || '["Resolve the current print attempt before starting another."]'; end if;
  if ps = 'REFUND_DUE' then priority := 0;
  elsif ps = 'PENDING_VERIFICATION' then priority := 1;
  elsif o->>'payment_method' = 'CASH_ON_PICKUP' and s = 'OPEN_INQUIRY' and o->>'acceptance_status' = 'PENDING' then priority := 2;
  elsif ps = 'REVIEW_REQUIRED' then priority := 3; end if;

  -- Mirror the existing fulfillment transitions; these flags do not authorize mutations.
  if o->>'handed_over_at' is null and s not in ('COMPLETED','CANCELLED','REJECTED','EXPIRED') then
    if s = 'READY_FOR_PICKUP' then
      if o->>'output_confirmed_at' is null then actions := actions || '["confirm"]';
      else
        actions := actions || '["reprint"]';
        if o->>'payment_method' <> 'CASH_ON_PICKUP' then actions := actions || '["handover"]'; end if;
      end if;
    elsif s = 'PRINTED' then actions := actions || '["confirm","reprint"]';
    elsif s = 'IN_PRODUCTION' and opened then
      if a->>'status' = 'FAILED_PRE_SUBMISSION' then actions := actions || '["retry"]';
      elsif a->>'status' = 'OUTCOME_UNKNOWN' then actions := actions || '["resolve"]';
      elsif a->>'status' in ('SUBMITTED','MANUAL_STARTED') then actions := actions || '["confirm","reprint"]';
      elsif greatest((a->>'updated_at')::timestamptz, coalesce((a->>'agent_seen_at')::timestamptz, (a->>'updated_at')::timestamptz)) < now() - interval '10 minutes'
        then actions := actions || '["resolve"]'; end if;
    end if;
  end if;
  if not eligible then actions := '["review"]'; end if;
  return jsonb_build_object('section', section, 'selectable', s = 'IN_PRODUCTION' and eligible and valid_settings and not opened and o->>'handed_over_at' is null,
    'blocking_reasons', reasons, 'available_actions', actions, 'action_priority', priority);
end;
$$;

-- This projection is internal: HTTP summaries strip source_path and raw_attempt.
create or replace function public.shop_queue_rows(p_shop uuid, p_ids uuid[] default null)
returns setof jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'state', o.state::text, 'created_at', o.created_at, 'order_name', to_jsonb(o)->'order_name',
    'client_name', nullif(btrim(concat_ws(' ', to_jsonb(u)->>'first_name', to_jsonb(u)->>'last_name')), ''),
    'paper_size', to_jsonb(o)->'paper_size', 'print_color_mode', to_jsonb(o)->'print_color_mode',
    'orientation', to_jsonb(o)->'orientation', 'page_count', o.page_count, 'copies', o.copies, 'total', o.total,
    'payment_method', o.payment_method, 'payment_status', o.payment_status, 'acceptance_status', o.acceptance_status,
    'current_receipt_id', o.current_receipt_id, 'is_unclaimed', o.is_unclaimed,
    'output_confirmed_at', o.output_confirmed_at, 'output_confirmed_attempt_id', o.output_confirmed_attempt_id,
    'handed_over_at', o.handed_over_at, 'closed_at', coalesce(o.handed_over_at, closed.at),
    'source_path', asset.file_url, 'has_document', public.order_has_valid_asset(o.id),
    'assets', case when asset.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('original_filename', to_jsonb(asset)->'original_filename')) end,
    'raw_attempt', to_jsonb(attempt),
    'fingerprint', md5(jsonb_build_array(o.id, o.state::text, o.payment_method, o.payment_status, o.acceptance_status,
      o.current_receipt_id, o.total, to_jsonb(o)->'paper_size', to_jsonb(o)->'print_color_mode', to_jsonb(o)->'orientation',
      o.page_count, o.copies, asset.id, asset.file_url, to_jsonb(asset)->'original_filename', attempt.attempt_id, attempt.status, attempt.resolved_at)::text)
  ) || public.shop_queue_classify(to_jsonb(o), to_jsonb(attempt), public.order_has_valid_asset(o.id))
  from public.orders o
  left join public.users u on u.id = o.client_id
  left join lateral (select a.* from public.assets a where a.order_id = o.id order by a.id limit 1) asset on true
  left join lateral (select j.* from public.print_jobs j where j.order_id = o.id and j.shop_id = p_shop order by j.attempt_number desc nulls last, j.created_at desc limit 1) attempt on true
  left join lateral (select max(d.created_at) as at from public.order_decisions d where d.order_id = o.id and d.action in ('COMPLETED','COLLECT_CASH','CANCEL','REJECT_ORDER','EXPIRE')) closed on true
  where o.shop_id = p_shop and o.state::text <> 'DRAFT' and (p_ids is null or o.id = any(p_ids));
$$;

create or replace function public.shop_queue_query(p_shop uuid, p_query jsonb default '{}')
returns jsonb language sql stable security definer set search_path = '' as $$
  with base as materialized (select r as item from public.shop_queue_rows(p_shop) r),
  filtered as materialized (
    select item from base where item->>'section' = coalesce(p_query->>'section','new')
      and (coalesce(p_query->>'search','') = '' or strpos(lower(concat_ws(' ',item->>'id',item->>'order_name',item->>'client_name',item#>>'{assets,0,original_filename}')),lower(p_query->>'search')) > 0)
      and (coalesce(p_query->>'paperSize','ALL') = 'ALL' or item->>'paper_size' = p_query->>'paperSize')
      and (coalesce(p_query->>'colorMode','ALL') = 'ALL' or item->>'print_color_mode' = p_query->>'colorMode')
      and (coalesce(p_query->>'paymentMethod','ALL') = 'ALL' or item->>'payment_method' = p_query->>'paymentMethod')
      and (coalesce(p_query->>'status','ALL') = 'ALL' or item->>'state' = p_query->>'status' or item->>'payment_status' = p_query->>'status' or item#>>'{raw_attempt,status}' = p_query->>'status'
        or (p_query->>'status' = 'UNCLAIMED' and (item->>'is_unclaimed')::boolean))
      and (nullif(p_query->>'dateFrom','') is null or (item->>'created_at')::timestamptz >= ((p_query->>'dateFrom')::date::timestamp at time zone 'Asia/Manila'))
      and (nullif(p_query->>'dateTo','') is null or (item->>'created_at')::timestamptz < (((p_query->>'dateTo')::date + 1)::timestamp at time zone 'Asia/Manila'))
      and (coalesce((p_query->>'selectableOnly')::boolean,false) is false or (item->>'selectable')::boolean)
      and not (coalesce(p_query->'excludeIds','[]') ? (item->>'id'))
      and (p_query->'onlyIds' is null or (p_query->'onlyIds') ? (item->>'id'))
  ), limits as (
    select count(*)::integer as total, greatest(1,ceil(count(*)::numeric / greatest(1,least(25,coalesce((p_query->>'pageSize')::integer,6)))))::integer as pages from filtered
  ), paging as (
    select total,pages, greatest(1,least(pages,coalesce((p_query->>'page')::integer,1))) as page,
      greatest(1,least(25,coalesce((p_query->>'pageSize')::integer,6))) as size from limits
  ), ordered as (
    select item, row_number() over(order by
      case when coalesce(p_query->>'sort','default') = 'default' and p_query->>'section' = 'new' then (item->>'action_priority')::integer end asc nulls last,
      case when p_query->>'sort' = 'title' then lower(coalesce(nullif(btrim(item->>'order_name'),''),
        nullif(btrim(regexp_replace(btrim(item#>>'{assets,0,original_filename}'), '(.)\.[^.]*$', '\1')),''))) end asc nulls last,
      case when p_query->>'sort' = 'customer' then lower(nullif(item->>'client_name','')) end asc nulls last,
      case when coalesce(p_query->>'sort','default') = 'default' and p_query->>'section' = 'history' then coalesce(item->>'closed_at',item->>'created_at')::timestamptz end desc nulls last,
      case when p_query->>'sort' = 'newest' then (item->>'created_at')::timestamptz end desc nulls last,
      case when coalesce(p_query->>'sort','default') in ('default','oldest') and not(coalesce(p_query->>'sort','default') = 'default' and p_query->>'section' = 'history') then (item->>'created_at')::timestamptz end asc nulls last,
      item->>'id') as position from filtered
  )
  select jsonb_build_object('data',coalesce((select jsonb_agg(item order by position) from ordered,paging where position > (page-1)*size and position <= page*size),'[]'),
    'meta',(select jsonb_build_object('currentPage',page,'pageSize',size,'totalItems',total,'totalPages',pages) from paging),
    'counts',jsonb_build_object('new',(select count(*) from base where item->>'section'='new'),'ready',(select count(*) from base where item->>'section'='ready'),
      'pickup',(select count(*) from base where item->>'section'='pickup'),'history',(select count(*) from base where item->>'section'='history')));
$$;

-- Keep the classification, current receipt, decisions and files in one read snapshot.
create or replace function public.shop_queue_detail(p_shop uuid, p_order uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(o) || r || jsonb_build_object(
    'assets', coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from public.assets a where a.order_id = o.id), '[]'::jsonb),
    'payment_receipts', coalesce((select jsonb_agg(to_jsonb(p)) from public.payment_receipts p where p.order_id = o.id), '[]'::jsonb),
    'order_decisions', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.id) from public.order_decisions d where d.order_id = o.id), '[]'::jsonb)
  )
  from public.orders o
  cross join lateral public.shop_queue_rows(p_shop, array[o.id]) r
  where o.id = p_order and o.shop_id = p_shop;
$$;

create index if not exists orders_shop_queue_created_idx on public.orders(shop_id, created_at, id);
create index if not exists assets_shop_queue_order_idx on public.assets(order_id, id);
create index if not exists order_decisions_closure_idx on public.order_decisions(order_id, created_at desc) where action in ('COMPLETED','COLLECT_CASH','CANCEL','REJECT_ORDER','EXPIRE');

create table if not exists public.print_batch_reviews (
  token uuid primary key default gen_random_uuid(), shop_id uuid not null references public.shops(id),
  actor_id uuid not null, mode text not null check(mode in ('AGENT','MANUAL')), device_id uuid, printer_name text,
  items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 25),
  created_at timestamptz not null default now(), expires_at timestamptz not null default now() + interval '10 minutes',
  request_id uuid unique
);
alter table public.print_batch_reviews enable row level security;
revoke all on public.print_batch_reviews from public,anon,authenticated;
grant select,insert,update,delete on public.print_batch_reviews to service_role;

-- A nested exception block rolls back every attempt/event if any claim fails.
create or replace function public.print_claim_reviewed_batch(p_token uuid,p_shop uuid,p_actor uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  review public.print_batch_reviews%rowtype;
  item jsonb; current_item jsonb; result jsonb; created jsonb := '[]'; ids uuid[];
  sizes integer; conflict jsonb;
begin
  select * into review from public.print_batch_reviews where token=p_token and shop_id=p_shop and actor_id=p_actor for update;
  if not found then return jsonb_build_object('ok',false,'code','REVIEW_REQUIRED'); end if;
  if review.request_id is not null then return jsonb_build_object('ok',false,'code','REVIEW_ALREADY_USED'); end if;
  if review.expires_at <= now() then return jsonb_build_object('ok',false,'code','REVIEW_EXPIRED'); end if;
  perform 1 from public.print_batch_requests where request_id=p_request and shop_id=p_shop and created_by=p_actor and status='PENDING' for update;
  if not found then return jsonb_build_object('ok',false,'code','REQUEST_NOT_PENDING'); end if;
  perform 1 from public.shops where id=p_shop and verification_status::text='VERIFIED' for share;
  if not found then return jsonb_build_object('ok',false,'code','SHOP_NOT_VERIFIED'); end if;
  select array_agg((x->>'orderId')::uuid),count(distinct x#>>'{settings,paperSize}') into ids,sizes from jsonb_array_elements(review.items) x;
  if sizes <> 1 or cardinality(ids) <> (select count(distinct id) from unnest(ids) id) then
    return jsonb_build_object('ok',false,'code','INVALID_BATCH');
  end if;
  -- Lock order rows in deterministic order, then assets and open attempts.
  perform o.id from public.orders o where o.shop_id=p_shop and o.id=any(ids) order by o.id for update;
  perform a.id from public.assets a where a.order_id=any(ids) order by a.order_id,a.id for share;
  perform j.id from public.print_jobs j where j.shop_id=p_shop and j.order_id=any(ids) and j.resolved_at is null order by j.order_id for update;
  for item in select * from jsonb_array_elements(review.items) loop
    select r into current_item from public.shop_queue_rows(p_shop,array[(item->>'orderId')::uuid]) r;
    if current_item is null or current_item->>'fingerprint' is distinct from item->>'fingerprint' or (current_item->>'selectable')::boolean is not true
      or current_item->>'source_path' is distinct from item->>'sourceStored' then
      return jsonb_build_object('ok',false,'code','BATCH_CHANGED','conflicts',jsonb_build_array(jsonb_build_object('orderId',item->>'orderId','message','Order eligibility, file or settings changed. Review again.')));
    end if;
  end loop;
  begin
    for item in select * from jsonb_array_elements(review.items) loop
      result := public.print_create_attempt((item->>'orderId')::uuid,p_shop,'INITIAL',review.mode,null,item->>'sourcePath',
        item#>>'{printable,path}',item#>>'{printable,sha256}',(item#>>'{printable,size}')::bigint,
        review.device_id,review.printer_name,item->'settings',p_request,p_actor,null,false);
      if (result->>'ok')::boolean is not true then
        conflict := jsonb_build_object('orderId',item->>'orderId','message',coalesce(result->>'code','Claim failed'));
        raise exception 'claim failed' using errcode='P0001';
      end if;
      created := created || jsonb_build_array(result->'attempt');
    end loop;
    update public.print_batch_reviews set request_id=p_request where token=p_token;
  exception when sqlstate 'P0001' then
    return jsonb_build_object('ok',false,'code','BATCH_CHANGED','conflicts',jsonb_build_array(conflict));
  end;
  return jsonb_build_object('ok',true,'attempts',created);
end;
$$;

create or replace function public.print_fail_reviewed_batch(p_request uuid,p_shop uuid,p_response jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.print_batch_requests where request_id=p_request and shop_id=p_shop and status='PENDING' for update;
  if not found or exists(select 1 from public.print_jobs where batch_request_id=p_request and shop_id=p_shop) then return false; end if;
  update public.print_batch_requests set status='FAILED',response=p_response,completed_at=now() where request_id=p_request and shop_id=p_shop;
  return true;
end;
$$;

-- A crashed worker may leave a request pending before claiming any attempts.
-- Lock the request before releasing it; an old worker must then fail its claim.
create or replace function public.print_expire_unclaimed_batch(p_request uuid,p_shop uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.print_batch_requests where request_id=p_request and shop_id=p_shop
    and status='PENDING' and created_at <= now() - interval '15 minutes' for update;
  if not found then return false; end if;
  return public.print_fail_reviewed_batch(p_request,p_shop,jsonb_build_object(
    'statusCode',409,'body',jsonb_build_object('code','REVIEW_REQUIRED',
      'message','The unclaimed batch request expired. Refresh and review again.')));
end;
$$;

revoke all on function public.shop_queue_classify(jsonb,jsonb,boolean),public.shop_queue_rows(uuid,uuid[]),public.shop_queue_query(uuid,jsonb),public.shop_queue_detail(uuid,uuid),public.print_claim_reviewed_batch(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.shop_queue_classify(jsonb,jsonb,boolean),public.shop_queue_rows(uuid,uuid[]),public.shop_queue_query(uuid,jsonb),public.shop_queue_detail(uuid,uuid),public.print_claim_reviewed_batch(uuid,uuid,uuid,uuid) to service_role;
revoke all on function public.print_fail_reviewed_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.print_fail_reviewed_batch(uuid,uuid,jsonb) to service_role;
revoke all on function public.print_expire_unclaimed_batch(uuid,uuid) from public,anon,authenticated;
grant execute on function public.print_expire_unclaimed_batch(uuid,uuid) to service_role;
alter function public.print_claim_reviewed_batch(uuid,uuid,uuid,uuid) set lock_timeout = '3s';
alter function public.print_expire_unclaimed_batch(uuid,uuid) set lock_timeout = '3s';
notify pgrst, 'reload schema';
commit;
