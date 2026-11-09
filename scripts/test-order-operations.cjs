const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const db = new PGlite();
  const student = randomUUID(), other = randomUUID(), shop = randomUUID();
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const claim = (key, action = 'CREATE_ORDER', target = shop, fingerprint = 'f1', user = student, lease = 180) =>
    scalar('select public.claim_order_operation($1,$2,$3,$4,$5,$6,$7)', [user, key, action, target, fingerprint, 'hash', lease]);
  const commit = (key, generation, data, user = student) =>
    scalar('select public.commit_order_operation($1,$2,$3,$4::jsonb)', [user, key, generation, JSON.stringify(data)]);
  const count = (table) => scalar(`select count(*)::int from public.${table}`);
  const op = async (key) => (await db.query('select * from public.order_operations where operation_key=$1', [key])).rows[0];
  const expire = (key) => db.query("update public.order_operations set lease_expires_at = now() - interval '1 second' where operation_key=$1", [key]);
  const order = { state: 'OPEN_INQUIRY', total: 45, print_color_mode: 'BLACK_AND_WHITE', paper_size: 'A4', page_count: 3, order_name: 'Thesis', orientation: 'PORTRAIT', copies: 1 };
  const asset = { path: 'u/o/k.pdf', dpi: 300, fileType: 'PDF', originalFilename: 'thesis.pdf' };
  const createData = { message: 'Order created successfully', order, asset };

  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create type public.order_state as enum ('DRAFT','OPEN_INQUIRY','CANCELLED');
      create table public.users(id uuid primary key, role text);
      create table public.orders(id uuid primary key default gen_random_uuid(), client_id uuid, shop_id uuid,
        state public.order_state default 'DRAFT', total numeric(12,2), print_color_mode text, paper_size text,
        page_count integer, payment_method text default 'GCASH', order_name text, orientation text, copies integer,
        created_at timestamptz default now(), draft_version bigint not null default 0);
      create function public.bump_version() returns trigger language plpgsql as $$
        begin new.draft_version := old.draft_version + 1; return new; end $$;
      create trigger bump before update on public.orders for each row execute function public.bump_version();
      create table public.assets(id uuid primary key default gen_random_uuid(), order_id uuid references public.orders(id),
        file_url text, dpi integer, file_type text, original_filename text);
      create table public.receipts_called(order_id uuid, path text, reference text);
      create function public.apply_order_decision(p_order uuid, p_actor uuid, p_actor_type text, p_action text, p_data jsonb)
      returns jsonb language plpgsql as $$
      begin
        if p_data->>'reference' = 'bad' then raise exception 'Payment deadline has passed' using errcode = '40001'; end if;
        insert into public.receipts_called values (p_order, p_data->>'receiptPath', p_data->>'reference');
        return jsonb_build_object('id', p_order, 'state', 'OPEN_INQUIRY');
      end $$;
    `);
    await db.query("insert into public.users values ($1,'STUDENT'),($2,'STUDENT')", [student, other]);
    await db.exec(readFileSync('supabase/migrations/20261109010000_order_operations.sql', 'utf8'));

    assert.equal(await scalar("select has_function_privilege('authenticated','public.commit_order_operation(uuid,uuid,integer,jsonb)','EXECUTE')"), false);
    assert.equal(await scalar("select has_table_privilege('authenticated','public.order_operations','SELECT')"), false);
    assert.equal(await scalar("select relrowsecurity from pg_class where oid = 'public.order_operations'::regclass"), true);

    // Concurrent attempts with one key: one claim, one order.
    const key = randomUUID();
    const claims = await Promise.all([claim(key), claim(key), claim(key)]);
    assert.deepEqual(claims.map((c) => c.outcome).sort(), ['claimed', 'processing', 'processing']);
    const winner = claims.find((c) => c.outcome === 'claimed');
    const committed = await commit(key, winner.generation, createData);
    assert.equal(committed.result.orderId, winner.plannedOrderId);
    assert.equal(committed.result.message, 'Order created successfully');
    assert.equal(await count('orders'), 1);
    assert.equal(await count('assets'), 1);
    assert.equal((await op(key)).staged_path, null);

    // A lost response followed by a retry returns the original result.
    const replay = await claim(key);
    assert.equal(replay.outcome, 'succeeded');
    assert.deepEqual(replay.result, committed.result);
    assert.deepEqual((await commit(key, winner.generation, createData)).result, committed.result);
    assert.equal(await count('orders'), 1);

    // The replay still returns the result after the order has moved on.
    await db.query("update public.orders set state='CANCELLED' where id=$1", [winner.plannedOrderId]);
    assert.equal((await claim(key)).outcome, 'succeeded');

    // Different inputs with one key conflict; a new key is a new action.
    assert.equal((await claim(key, 'CREATE_ORDER', shop, 'changed')).outcome, 'conflict');
    assert.equal((await claim(key, 'CREATE_DRAFT')).outcome, 'conflict');
    assert.equal((await claim(key, 'CREATE_ORDER', randomUUID())).outcome, 'conflict');
    assert.equal((await claim(randomUUID())).outcome, 'claimed');

    // Keys belong to one student.
    assert.equal((await claim(key, 'CREATE_ORDER', shop, 'f1', other)).outcome, 'claimed');

    // An interrupted worker is reclaimed, and can no longer commit.
    const crash = randomUUID();
    const first = await claim(crash);
    await expire(crash);
    const second = await claim(crash);
    assert.equal(second.outcome, 'claimed');
    assert.equal(second.generation, first.generation + 1);
    assert.equal(second.plannedOrderId, first.plannedOrderId);
    await assert.rejects(() => commit(crash, first.generation, createData), (e) => e.code === 'PF001');
    await commit(crash, second.generation, createData);

    // An expired lease cannot commit even when no one has reclaimed it yet.
    const lapsed = randomUUID();
    const held = await claim(lapsed);
    await expire(lapsed);
    await assert.rejects(() => commit(lapsed, held.generation, createData), (e) => e.code === 'PF001');

    // A failed commit leaves no partial order and stays claimable.
    const partial = randomUUID();
    const partialClaim = await claim(partial);
    const before = await count('orders');
    await assert.rejects(() => commit(partial, partialClaim.generation, { ...createData, asset: {} }), (e) => e.code === '23514');
    assert.equal(await count('orders'), before);
    assert.equal((await op(partial)).status, 'PROCESSING');

    // Stored failures: final ones replay; retryable ones reclaim.
    const final = randomUUID();
    await claim(final);
    await db.query("update public.order_operations set status='FAILED', retryable=false, error_status=400, error_body='{\"message\":\"Bad\"}' where operation_key=$1", [final]);
    const replayed = await claim(final);
    assert.equal(replayed.outcome, 'failed');
    assert.equal(replayed.errorStatus, 400);
    assert.equal(replayed.errorBody.message, 'Bad');
    const retry = randomUUID();
    await claim(retry);
    await db.query("update public.order_operations set status='FAILED', retryable=true, error_status=503 where operation_key=$1", [retry]);
    const reclaimed = await claim(retry);
    assert.equal(reclaimed.outcome, 'claimed');
    assert.equal(reclaimed.generation, 2);
    assert.equal((await op(retry)).error_status, null);

    // Drafts change in place.
    const draftKey = randomUUID();
    const draftClaim = await claim(draftKey, 'CREATE_DRAFT', shop);
    const draftId = draftClaim.plannedOrderId;
    await commit(draftKey, draftClaim.generation, { message: 'Saved', order: { ...order, state: 'DRAFT' }, asset: { ...asset, path: 'old.pdf' } });
    const orderTotal = await count('orders');
    const save = randomUUID();
    const saveClaim = await claim(save, 'UPDATE_DRAFT', draftId);
    const saved = await commit(save, saveClaim.generation, {
      message: 'Draft updated successfully', expectedVersion: 0,
      order: { order_name: 'Renamed', copies: 4, total: 180 }, asset: { ...asset, path: 'new.pdf' },
    });
    assert.equal(saved.result.orderId, draftId);
    assert.equal(saved.result.order.order_name, 'Renamed');
    assert.equal(saved.result.order.paper_size, 'A4', 'Omitted settings are preserved');
    assert.deepEqual(saved.replacedPaths, ['old.pdf']);
    assert.equal(await count('orders'), orderTotal, 'Editing must not create another order');
    assert.equal(await scalar('select count(*)::int from public.assets where order_id=$1', [draftId]), 1);
    assert.equal(await scalar('select file_url from public.assets where order_id=$1', [draftId]), 'new.pdf');

    // A stale version is rejected and the draft and file are preserved.
    const stale = randomUUID();
    const staleClaim = await claim(stale, 'UPDATE_DRAFT', draftId);
    await assert.rejects(() => commit(stale, staleClaim.generation, { message: 'x', expectedVersion: 0, order: { order_name: 'Lost' }, asset: { ...asset, path: 'lost.pdf' } }), (e) => e.code === 'PF003');
    assert.equal(await scalar('select order_name from public.orders where id=$1', [draftId]), 'Renamed');
    assert.equal(await scalar('select file_url from public.assets where order_id=$1', [draftId]), 'new.pdf');

    // Submission is atomic with its settings, and only a draft can be submitted.
    const version = await scalar('select draft_version from public.orders where id=$1', [draftId]);
    const submit = randomUUID();
    const submitClaim = await claim(submit, 'SUBMIT_DRAFT', draftId);
    const submitted = await commit(submit, submitClaim.generation, { message: 'Draft submitted successfully', expectedVersion: Number(version), order: { order_name: 'Final' } });
    assert.equal(submitted.result.state, 'OPEN_INQUIRY');
    assert.equal(submitted.result.order.order_name, 'Final');
    assert.equal((await claim(submit, 'SUBMIT_DRAFT', draftId)).outcome, 'succeeded');
    const again = randomUUID();
    const againClaim = await claim(again, 'SUBMIT_DRAFT', draftId);
    await assert.rejects(() => commit(again, againClaim.generation, { message: 'x' }), (e) => e.code === 'PF002');

    // A draft owned by someone else is invisible.
    const foreign = randomUUID();
    const foreignClaim = await claim(foreign, 'UPDATE_DRAFT', draftId, 'f1', other);
    await assert.rejects(() => commit(foreign, foreignClaim.generation, { message: 'x' }, other), (e) => e.code === 'P0002');

    // Receipts run through the decision function exactly once.
    const receipt = randomUUID();
    const receiptClaim = await claim(receipt, 'UPLOAD_RECEIPT', draftId);
    const receiptResult = await commit(receipt, receiptClaim.generation, { message: 'Receipt saved. Awaiting payment verification.', receiptPath: 'r.png', reference: 'REF' });
    assert.equal(receiptResult.result.message, 'Receipt saved. Awaiting payment verification.');
    await commit(receipt, receiptClaim.generation, { receiptPath: 'r.png', reference: 'REF' });
    assert.equal(await count('receipts_called'), 1);
    const rejected = randomUUID();
    const rejectedClaim = await claim(rejected, 'UPLOAD_RECEIPT', draftId);
    await assert.rejects(() => commit(rejected, rejectedClaim.generation, { receiptPath: 'r.png', reference: 'bad' }), (e) => e.code === '40001');
    assert.equal((await op(rejected)).status, 'PROCESSING');

    console.log('order operation migration tests passed');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
