// Actual merged migrations, synthetic records, disposable in-memory PostgreSQL.
// Never reads environment settings or connects to an existing database.
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const REPAIR = '20261108080000_repair_merged_payment_verification.sql';
const CHECKS = Object.fromEntries(['document', 'revision', 'paper', 'color', 'orientation', 'pages', 'copies'].map(name => [name, true]));

async function main() {
  const db = new PGlite();
  const student = randomUUID(), shop = randomUUID(), admin = randomUUID(), device = randomUUID();
  const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
  const rpc = (name, args) => scalar(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')})`, args);
  const order = async id => (await db.query('select * from public.orders where id=$1', [id])).rows[0];
  const receipts = async id => (await db.query('select * from public.payment_receipts where order_id=$1 order by id', [id])).rows;
  const decisions = async id => (await db.query('select * from public.order_decisions where order_id=$1 order by id', [id])).rows;
  const snapshot = async id => ({ order: await order(id), receipts: await receipts(id), decisions: await decisions(id) });
  const decide = (id, action, data = {}, actor = shop, actorType = 'SHOP') =>
    rpc('apply_order_decision', [id, actor, actorType, action, JSON.stringify(data)]);
  const asset = id => db.query("insert into public.assets(order_id,file_url,file_type,dpi) values($1,'private/document.pdf','PDF',300)", [id]);
  const create = async (method = 'GCASH', hasAsset = true) => {
    const id = randomUUID();
    await db.query("insert into public.orders(id,client_id,shop_id,state,payment_method) values($1,$2,$3,'OPEN_INQUIRY',$4)", [id, student, shop, method]);
    if (hasAsset) await asset(id);
    return id;
  };
  const upload = async id => {
    await decide(id, 'UPLOAD_RECEIPT', { receiptPath: 'private/receipt.png', reference: randomUUID() }, student, 'STUDENT');
    return (await order(id)).current_receipt_id;
  };
  const dispute = async id => {
    const receiptId = await upload(id);
    await decide(id, 'REJECT_RECEIPT', { receiptId, reason: 'Transfer requires review' });
    await decide(id, 'DISPUTE', { reason: 'Transfer was sent' }, student, 'STUDENT');
    return receiptId;
  };
  const verify = async (id, asAdmin = false) => decide(id, asAdmin ? 'ADMIN_VERIFY' : 'VERIFY', {
    receiptId: (await order(id)).current_receipt_id, confirmed: true,
  }, asAdmin ? admin : shop, asAdmin ? 'ADMIN' : 'SHOP');
  const attempt = (id, mode, kind = 'INITIAL', previous = null) => rpc('print_create_attempt', [
    id, shop, kind, mode, previous, 'private/document.pdf', 'print-ready/document.pdf',
    'a'.repeat(64), 1234, mode === 'AGENT' ? device : null, mode === 'AGENT' ? 'Test printer' : null,
    JSON.stringify({ copies: 1, paperSize: 'A4' }), null, shop,
    kind === 'REPRINT' ? 'Output damaged before collection' : null, null,
  ]);
  const confirm = (id, attemptId, checks = CHECKS) => rpc('print_confirm_output', [id, shop, attemptId, shop, null, JSON.stringify(checks)]);
  const handover = (id, attemptId) => rpc('print_record_handover', [id, shop, attemptId, shop]);
  const rejectWithoutChanges = async (id, operation, code) => {
    const before = await snapshot(id);
    await assert.rejects(operation, error => error.code === code);
    assert.deepEqual(await snapshot(id), before, 'Rejected decision must roll back order, receipt and audit changes');
  };
  const submitAgent = async attemptId => {
    for (const [index, status] of ['RECEIVED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED'].entries()) {
      if (status === 'SUBMITTING') {
        assert.equal((await rpc('print_authorize_attempt', [attemptId, shop, device])).authorized, true);
      }
      const result = await rpc('print_record_agent_event', [attemptId, shop, device, index + 1, status, null, null, null, new Date().toISOString()]);
      assert.equal(result.ok, true, JSON.stringify(result));
    }
  };

  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create type public.order_state as enum ('DRAFT','OPEN_INQUIRY','PROOF_APPROVED','AWAITING_PAYMENT',
        'AWAITING_PAYMENT_VERIFICATION','ESCALATED_DISPUTE','IN_PRODUCTION','PRINTED','EXPIRED');
      create table public.users(id uuid primary key, role text);
      create table public.shops(id uuid primary key, verification_status text);
      create table public.admins(id uuid primary key);
      create table public.orders(id uuid primary key default gen_random_uuid(), client_id uuid, shop_id uuid,
        state public.order_state default 'DRAFT', total numeric(12,2) default 15, created_at timestamptz default now(),
        expires_at timestamptz, shop_rejection_reason text, dispute_reason text, page_count integer default 2,
        copies integer default 1);
      create table public.assets(id uuid primary key default gen_random_uuid(), order_id uuid references public.orders(id),
        file_url text, file_type text, dpi integer);
      create table public.payment_receipts(id uuid primary key default gen_random_uuid(), order_id uuid references public.orders(id),
        uploaded_by uuid, receipt_url text, reference_number text, verified boolean default false, created_at timestamptz default now());
      create table public.notifications(id uuid primary key default gen_random_uuid(), order_id uuid, clerk_id uuid, is_read boolean default false);
      create table public.print_jobs(id bigint generated always as identity primary key, order_id uuid, shop_id uuid,
        status text, created_at timestamptz default now(), updated_at timestamptz default now());
      create unique index print_jobs_one_active_per_order_idx on public.print_jobs(order_id) where status <> 'FAILED';
    `);
    await db.query("insert into public.users values($1,'STUDENT'),($2,'CLERK')", [student, shop]);
    await db.query("insert into public.shops values($1,'VERIFIED')", [shop]);
    await db.query('insert into public.admins values($1)', [admin]);

    let stranded, strandedBefore;
    const migrations = readdirSync('supabase/migrations').filter(name => /^202611.*\.sql$/.test(name)).sort();
    assert.ok(migrations.includes(REPAIR), 'The final repair must be included');
    for (const name of migrations) {
      if (name === REPAIR) {
        // Reproduce an actual old-function outcome before applying the repair.
        stranded = await create('GCASH', false);
        await dispute(stranded);
        await verify(stranded, true);
        strandedBefore = await snapshot(stranded);
        assert.equal(strandedBefore.order.payment_status, 'VERIFIED');
        assert.equal(strandedBefore.order.acceptance_status, 'PENDING');
      }
      await db.exec(readFileSync(`supabase/migrations/${name}`, 'utf8'));
    }
    assert.deepEqual(await snapshot(stranded), strandedBefore, 'Repair installation preserves existing records and audit history');
    await db.exec(readFileSync(`supabase/migrations/${REPAIR}`, 'utf8'));
    assert.deepEqual(await snapshot(stranded), strandedBefore, 'Repair is repeatable without rewriting records');

    await rejectWithoutChanges(stranded, () => verify(stranded), '23514');
    await asset(stranded);
    await rejectWithoutChanges(stranded, () => decide(stranded, 'VERIFY', { receiptId: randomUUID(), confirmed: true }), '40001');
    await rejectWithoutChanges(stranded, () => decide(stranded, 'VERIFY', { receiptId: strandedBefore.order.current_receipt_id }), '23514');
    await verify(stranded);
    const recovered = await snapshot(stranded);
    assert.equal(recovered.order.state, 'IN_PRODUCTION');
    assert.equal(recovered.order.acceptance_status, 'ACCEPTED');
    assert.deepEqual(recovered.order.payment_verified_at, strandedBefore.order.payment_verified_at);
    assert.deepEqual(recovered.receipts, strandedBefore.receipts, 'Recovery must not rewrite receipt verification evidence');
    assert.deepEqual(recovered.decisions.slice(0, -1), strandedBefore.decisions);
    assert.equal(recovered.decisions.at(-1).action, 'AUTHORIZE_VERIFIED_GCASH');
    assert.equal(recovered.decisions.at(-1).amount, null, 'Authorization is not another payment');
    await verify(stranded);
    assert.deepEqual(await snapshot(stranded), recovered, 'Recovery retry is idempotent');

    // Active verification cannot record payment until production is eligible.
    for (const asAdmin of [false, true]) {
      const missingAsset = await create('GCASH', false);
      if (asAdmin) await dispute(missingAsset); else await upload(missingAsset);
      await rejectWithoutChanges(missingAsset, () => verify(missingAsset, asAdmin), '23514');
      await asset(missingAsset);
      await verify(missingAsset, asAdmin);
      assert.equal((await order(missingAsset)).state, 'IN_PRODUCTION');

      const unverifiedShop = await create();
      if (asAdmin) await dispute(unverifiedShop); else await upload(unverifiedShop);
      await db.query("update public.shops set verification_status='PENDING' where id=$1", [shop]);
      await rejectWithoutChanges(unverifiedShop, () => verify(unverifiedShop, asAdmin), asAdmin ? '23514' : '42501');
      await db.query("update public.shops set verification_status='VERIFIED' where id=$1", [shop]);
      await verify(unverifiedShop, asAdmin);
      assert.equal((await order(unverifiedShop)).state, 'IN_PRODUCTION');
    }

    // Closed disputes can acknowledge real funds without authorizing production.
    const closed = await create('GCASH', false);
    await dispute(closed);
    await decide(closed, 'CANCEL', {}, student, 'STUDENT');
    await db.query("update public.shops set verification_status='PENDING' where id=$1", [shop]);
    await verify(closed, true);
    assert.equal((await order(closed)).state, 'CANCELLED');
    assert.equal((await order(closed)).payment_status, 'REFUND_DUE');
    assert.equal((await order(closed)).production_authorized, false);
    await db.query("update public.shops set verification_status='VERIFIED' where id=$1", [shop]);

    for (const method of ['CASH_ON_PICKUP', 'GCASH']) {
      for (const mode of ['MANUAL', 'AGENT']) {
        const id = await create(method);
        assert.equal((await attempt(id, mode)).code, 'ORDER_NOT_PRINTABLE');
        if (method === 'CASH_ON_PICKUP') {
          assert.equal((await order(id)).expires_at, null);
          await decide(id, 'ACCEPT');
          await rejectWithoutChanges(id, () => decide(id, 'COLLECT_CASH', { confirmed: true }), '23514');
        } else {
          await upload(id);
          assert.equal((await attempt(id, mode)).code, 'ORDER_NOT_PRINTABLE');
          await verify(id);
        }
        const started = await attempt(id, mode);
        assert.equal(started.ok, true, JSON.stringify(started));
        assert.equal((await attempt(id, mode)).code, 'ATTEMPT_OPEN');
        if (mode === 'AGENT') {
          // The invocation-time check must retain payment eligibility too.
          const paymentStatus = (await order(id)).payment_status;
          await db.query("update public.orders set payment_status='REVIEW_REQUIRED' where id=$1", [id]);
          const denied = await rpc('print_authorize_attempt', [started.attempt.attempt_id, shop, device]);
          assert.equal(denied.authorized, false);
          assert.equal(denied.reason, 'PAYMENT_NOT_ELIGIBLE');
          await db.query('update public.orders set payment_status=$2 where id=$1', [id, paymentStatus]);
          await submitAgent(started.attempt.attempt_id);
        }
        assert.equal((await confirm(id, randomUUID())).code, 'ATTEMPT_NOT_CURRENT');
        assert.equal((await confirm(id, started.attempt.attempt_id, { ...CHECKS, copies: false })).code, 'CHECKS_INCOMPLETE');
        if (method === 'CASH_ON_PICKUP') await rejectWithoutChanges(id, () => decide(id, 'COLLECT_CASH', { confirmed: true }), '23514');
        assert.equal((await confirm(id, started.attempt.attempt_id)).ok, true);
        assert.equal((await order(id)).state, 'READY_FOR_PICKUP');
        assert.ok((await order(id)).output_confirmed_at);
        await decide(id, 'FLAG_UNCLAIMED');
        assert.equal((await order(id)).is_unclaimed, true);
        const reprinted = await attempt(id, mode, 'REPRINT', started.attempt.attempt_id);
        assert.equal(reprinted.ok, true, JSON.stringify(reprinted));
        const producing = await order(id);
        assert.equal(producing.state, 'IN_PRODUCTION');
        assert.equal(producing.output_confirmed_at, null);
        assert.equal(producing.output_confirmed_attempt_id, null);
        assert.equal(producing.output_confirmed_by, null);
        assert.equal(producing.is_unclaimed, false);
        assert.equal(producing.unclaimed_at, null);
        assert.equal(producing.unclaimed_reason, null);
        if (mode === 'AGENT') await submitAgent(reprinted.attempt.attempt_id);
        assert.equal((await confirm(id, started.attempt.attempt_id)).code, 'ATTEMPT_NOT_CURRENT');
        assert.equal((await confirm(id, reprinted.attempt.attempt_id)).ok, true);
        await decide(id, 'FLAG_UNCLAIMED');
        if (method === 'CASH_ON_PICKUP') {
          assert.equal((await handover(id, reprinted.attempt.attempt_id)).code, 'PAYMENT_NOT_SETTLED');
          await rejectWithoutChanges(id, () => decide(id, 'COLLECT_CASH'), '23514');
          await Promise.all([decide(id, 'COLLECT_CASH', { confirmed: true }), decide(id, 'COLLECT_CASH', { confirmed: true })]);
          assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='COLLECT_CASH'", [id]), 1);
          const collected = await snapshot(id);
          await decide(id, 'COLLECT_CASH', { confirmed: true });
          assert.deepEqual(await snapshot(id), collected);
        } else {
          assert.equal((await handover(id, started.attempt.attempt_id)).code, 'ATTEMPT_NOT_CURRENT');
          assert.equal((await handover(id, reprinted.attempt.attempt_id)).ok, true);
          assert.equal((await handover(id, reprinted.attempt.attempt_id)).result, 'DUPLICATE');
        }
        const done = await order(id);
        assert.equal(done.state, 'COMPLETED');
        assert.equal(done.payment_status, method === 'CASH_ON_PICKUP' ? 'COLLECTED' : 'VERIFIED');
        assert.ok(done.handed_over_at);
        assert.equal(done.handed_over_by, shop);
        assert.equal(done.is_unclaimed, false);
        assert.equal(done.unclaimed_at, null);
        assert.equal(done.unclaimed_reason, null);
        assert.equal(await scalar("select count(*)::int from public.order_fulfillment_events where order_id=$1 and event_type='HANDED_OVER'", [id]), 1);
        assert.equal(await scalar('select count(*)::int from public.print_jobs where order_id=$1 and resolved_at is null', [id]), 0);
      }
    }

    // Legacy production records under payment review cannot create attempts.
    const legacy = await create(); await upload(legacy); await verify(legacy);
    await db.query("update public.orders set payment_status='REVIEW_REQUIRED' where id=$1", [legacy]);
    assert.equal((await attempt(legacy, 'MANUAL')).code, 'PAYMENT_NOT_ELIGIBLE');
    assert.equal(await scalar('select count(*)::int from public.print_jobs where order_id=$1', [legacy]), 0);
    assert.equal(await scalar("select to_regprocedure('public.claim_payment_eligible_print_job(uuid,uuid)')"), null);

    const signatures = [
      'public.apply_order_decision(uuid,uuid,text,text,jsonb)',
      'public.print_create_attempt(uuid,uuid,text,text,uuid,text,text,text,bigint,uuid,text,jsonb,uuid,uuid,text,boolean)',
      'public.print_authorize_attempt(uuid,uuid,uuid)',
      'public.print_confirm_output(uuid,uuid,uuid,uuid,text,jsonb)',
      'public.print_record_handover(uuid,uuid,uuid,uuid)',
    ];
    for (const signature of signatures) {
      assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')", [signature]), true, signature);
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')", [role, signature]), false, `${role}: ${signature}`);
      }
    }
    const installation = await db.exec(readFileSync('scripts/verify-payment-installation.sql', 'utf8'));
    const checks = new Map(installation[0].rows.map(check => [check.check_name, check.result]));
    for (const name of ['apply_order_decision', 'order_has_valid_asset', 'guard_order_payment_workflow']) {
      assert.equal(checks.get(`function.${name}.matches_repository`), 'true', name);
    }
    console.log(`Merged workflows passed (${migrations.length} actual migrations): cash/GCash agent and manual fulfillment, eligibility rollback, stranded payment recovery, reprints, unclaimed clearing, atomic/idempotent handovers, backend-only RPC grants and installation fingerprints.`);
  } finally {
    await db.close();
  }
}

main().catch(error => { console.error(error.code || '', error.message); process.exitCode = 1; });
