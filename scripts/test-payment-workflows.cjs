const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const db = new PGlite();
  const student = randomUUID(), shop = randomUUID(), otherShop = randomUUID(), admin = randomUUID();
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const row = async id => (await db.query('select * from public.orders where id=$1', [id])).rows[0];
  const decide = async (id, action, data = {}, actor = shop, type = 'SHOP') =>
    scalar('select public.apply_order_decision($1,$2,$3,$4,$5::jsonb)', [id, actor, type, action, JSON.stringify(data)]);
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
    await db.query("insert into public.users values ($1,'STUDENT'),($2,'CLERK'),($3,'MANAGER')", [student, shop, otherShop]);
    await db.query("insert into public.shops values ($1,'VERIFIED'),($2,'VERIFIED')", [shop, otherShop]);
    await db.query('insert into public.admins values ($1)', [admin]);
    const legacyPaid = randomUUID(), legacyUnknown = randomUUID(), legacyActive = randomUUID(), legacyConflicting = randomUUID();
    await db.query("insert into public.orders(id,client_id,shop_id,state) values($1,$3,$4,'PRINTED'),($2,$3,$4,'PRINTED')", [legacyPaid,legacyUnknown,student,shop]);
    await db.query("insert into public.payment_receipts(order_id,receipt_url,reference_number,verified) values($1,'old-receipt','old-reference',true)", [legacyPaid]);
    await db.query("insert into public.orders(id,client_id,shop_id,state) values($1,$3,$4,'IN_PRODUCTION'),($2,$3,$4,'AWAITING_PAYMENT')",[legacyActive,legacyConflicting,student,shop]);
    await db.query("insert into public.payment_receipts(order_id,receipt_url,reference_number,verified) values($1,'first','first-ref',true),($1,'second','second-ref',true)",[legacyConflicting]);
    await db.query("insert into public.assets(order_id,file_url,file_type,dpi) values($1,'legacy.pdf','PDF',300)",[legacyActive]);
    await db.exec(readFileSync('supabase/migrations/20261106000000_payment_order_states.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261106010000_separate_payment_workflows.sql','utf8'));
    assert.equal((await row(legacyPaid)).payment_status, 'VERIFIED');
    assert.equal((await row(legacyPaid)).acceptance_status, 'ACCEPTED');
    assert.equal((await row(legacyPaid)).accepted_at, null, 'Migration must not invent an operator decision timestamp');
    assert.equal((await row(legacyUnknown)).payment_status, 'REVIEW_REQUIRED');
    assert.equal((await row(legacyUnknown)).state, 'PRINTED');
    assert.equal((await row(legacyConflicting)).payment_status,'REVIEW_REQUIRED');
    assert.equal((await row(legacyActive)).state,'IN_PRODUCTION');
    await assert.rejects(() => scalar('select public.claim_payment_eligible_print_job($1,$2)',[legacyActive,shop]), /eligible/);
    assert.equal(await scalar("select has_function_privilege('authenticated','public.apply_order_decision(uuid,uuid,text,text,jsonb)','EXECUTE')"), false);

    const create = async (method = 'GCASH', asset = true) => {
      const id = randomUUID();
      await db.query("insert into public.orders(id,client_id,shop_id,state,payment_method) values($1,$2,$3,'OPEN_INQUIRY',$4)", [id,student,shop,method]);
      if (asset) await db.query("insert into public.assets(order_id,file_url,file_type,dpi) values($1,'private/document.pdf','PDF',300)", [id]);
      return id;
    };
    const receipt = async (id, reference = randomUUID()) => {
      await decide(id,'UPLOAD_RECEIPT',{receiptPath:'private/receipt.png',reference},student,'STUDENT');
      return (await row(id)).current_receipt_id;
    };
    const gcash = await create();
    await assert.rejects(() => db.query("update public.orders set state='IN_PRODUCTION' where id=$1",[gcash]), /Acceptance/);
    await assert.rejects(() => decide(gcash,'ACCEPT'), /proof is required/);
    const first = await receipt(gcash);
    await decide(gcash,'ACCEPT');
    assert.equal((await row(gcash)).state,'OPEN_INQUIRY');
    await assert.rejects(() => decide(gcash,'VERIFY',{receiptId:first}), /Confirm receipt/);
    await assert.rejects(() => decide(gcash,'REJECT_RECEIPT',{receiptId:first}), /reason is required/);
    await decide(gcash,'REJECT_RECEIPT',{receiptId:first,reason:'Wrong reference'});
    assert.equal((await row(gcash)).payment_status,'REJECTED');
    const second = await receipt(gcash);
    await assert.rejects(() => decide(gcash,'VERIFY',{receiptId:first,confirmed:true}), /Receipt changed/);
    await decide(gcash,'VERIFY',{receiptId:second,confirmed:true});
    assert.equal((await row(gcash)).state,'IN_PRODUCTION');
    await assert.rejects(() => decide(gcash,'VERIFY',{receiptId:second,confirmed:true}), /changed/);
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='VERIFY'",[gcash]),1);
    assert.equal(await scalar('select verified from public.payment_receipts where id=$1',[first]),false);
    assert.equal(await scalar('select verified from public.payment_receipts where id=$1',[second]),true);
    assert.equal(await scalar('select public.claim_payment_eligible_print_job($1,$2)',[gcash,shop]),true);
    assert.equal(await scalar('select public.claim_payment_eligible_print_job($1,$2)',[gcash,shop]),false);
    await assert.rejects(() => decide(gcash,'CANCEL',{},student,'STUDENT'), /no longer/);

    const cash = await create('CASH_ON_PICKUP');
    assert.equal((await row(cash)).expires_at,null);
    assert.equal((await row(cash)).payment_status,'DUE_AT_PICKUP');
    await db.query("update public.orders set expires_at=now()-interval '1 minute' where id=$1",[cash]);
    await decide(cash,'EXPIRE',{},null,'SYSTEM');
    assert.equal((await row(cash)).state,'OPEN_INQUIRY');
    await assert.rejects(() => receipt(cash), /not available/);
    await decide(cash,'ACCEPT');
    assert.equal((await row(cash)).state,'IN_PRODUCTION');
    await decide(cash,'READY_FOR_PICKUP',{confirmed:true});
    await decide(cash,'FLAG_UNCLAIMED',{reason:'Customer has not collected'});
    assert.equal((await row(cash)).payment_status,'DUE_AT_PICKUP');
    await assert.rejects(() => decide(cash,'COMPLETED',{confirmed:true}), /cash collection/);
    await Promise.all([decide(cash,'COLLECT_CASH',{confirmed:true}),decide(cash,'COLLECT_CASH',{confirmed:true})]);
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='COLLECT_CASH'",[cash]),1);
    await decide(cash,'COMPLETED',{confirmed:true});
    assert.equal((await row(cash)).state,'COMPLETED');
    assert.equal((await row(cash)).is_unclaimed,false);
    await assert.rejects(() => db.query("update public.orders set payment_method='GCASH' where id=$1",[cash]), /locked/);

    const refund = await create();
    const refundReceipt = await receipt(refund);
    await decide(refund,'VERIFY',{receiptId:refundReceipt,confirmed:true});
    assert.equal((await row(refund)).acceptance_status,'PENDING', 'Payment approval never implies shop acceptance');
    await decide(refund,'REJECT_ORDER',{reason:'Cannot fulfill specifications'});
    assert.equal((await row(refund)).payment_status,'REFUND_DUE');
    await assert.rejects(() => decide(refund,'RECORD_REFUND',{confirmed:true}), /reference/);
    await decide(refund,'RECORD_REFUND',{confirmed:true,reference:'manual-refund-123'});
    await decide(refund,'RECORD_REFUND',{confirmed:true,reference:'manual-refund-123'});
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='RECORD_REFUND'",[refund]),1);

    const cancelled = await create();
    const cancelledReceipt = await receipt(cancelled);
    await decide(cancelled,'CANCEL',{},student,'STUDENT');
    await decide(cancelled,'VERIFY',{receiptId:cancelledReceipt,confirmed:true});
    assert.equal((await row(cancelled)).state,'CANCELLED');
    assert.equal((await row(cancelled)).payment_status,'REFUND_DUE');

    const dispute = await create();
    const disputedReceipt = await receipt(dispute);
    await decide(dispute,'REJECT_RECEIPT',{receiptId:disputedReceipt,reason:'Review reference'});
    await decide(dispute,'DISPUTE',{reason:'Reference matches my transfer'},student,'STUDENT');
    assert.equal((await row(dispute)).expires_at,null);
    await assert.rejects(() => decide(dispute,'VERIFY',{receiptId:disputedReceipt,confirmed:true}), /administrator/);
    await decide(dispute,'ADMIN_VERIFY',{receiptId:disputedReceipt,confirmed:true},admin,'ADMIN');
    assert.equal((await row(dispute)).state,'OPEN_INQUIRY');
    assert.equal((await row(dispute)).acceptance_status,'PENDING');

    const legacyReceipt = await receipt(legacyActive);
    await decide(legacyActive,'VERIFY',{receiptId:legacyReceipt,confirmed:true});
    assert.equal((await row(legacyActive)).state,'IN_PRODUCTION', 'Reconciliation must not reset production history');
    assert.equal(await scalar('select public.claim_payment_eligible_print_job($1,$2)',[legacyActive,shop]),true);

    const expired = await create();
    await db.query("update public.orders set expires_at=now()-interval '1 minute' where id=$1",[expired]);
    await assert.rejects(() => receipt(expired), /deadline/);
    await decide(expired,'EXPIRE',{},null,'SYSTEM');
    assert.equal((await row(expired)).state,'EXPIRED');
    const invalid = await create('CASH_ON_PICKUP',false);
    await assert.rejects(() => decide(invalid,'ACCEPT'), /file/);
    await assert.rejects(() => decide(invalid,'ACCEPT',{},otherShop,'SHOP'), /owning shop/);
    await assert.rejects(() => decide(invalid,'CANCEL',{},randomUUID(),'STUDENT'), /not found/);
    await assert.rejects(() => db.query('delete from public.order_decisions where order_id=$1',[cash]), /append-only/);
    console.log('Payment workflow migration, authorization, receipt, refund, dispatch and handover checks passed.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.message, error.position || '', error.where || ''); process.exitCode=1; });
