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

    // Reproduce the reported installation: payment columns, RPC and audit
    // trigger exist, but the orders payment-workflow guard is missing.
    const acceptedBeforeRepair = await create('CASH_ON_PICKUP');
    await decide(acceptedBeforeRepair,'ACCEPT');
    const acceptedSnapshot = await row(acceptedBeforeRepair);
    const decisionsBeforeRepair = await scalar('select count(*)::int from public.order_decisions');
    // Reproduce body drift only inside this disposable in-memory database.
    // Keep signatures/dependencies, then prove the additive repair restores
    // the exact tested bodies without rewriting any order or audit records.
    const functionIdentities = async () => (await db.query("select oid, proowner from pg_proc where oid in ('public.apply_order_decision(uuid,uuid,text,text,jsonb)'::regprocedure,'public.order_has_valid_asset(uuid)'::regprocedure) order by oid")).rows;
    const identitiesBeforeRepair = await functionIdentities();
    await db.exec(`
      create or replace function public.order_has_valid_asset(p_order uuid) returns boolean
      language sql stable set search_path = public, pg_temp as $$ select false; $$;
      create or replace function public.apply_order_decision(p_order uuid, p_actor uuid, p_actor_type text,
        p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
      language plpgsql security definer set search_path = public, pg_temp as $$
      begin raise exception 'Isolated drift fixture' using errcode = '23514'; end $$;
    `);
    const verifyInstallation = async () => {
      const result = await db.exec(readFileSync('scripts/verify-payment-installation.sql','utf8'));
      return new Map(result[0].rows.map(check => [check.check_name,check.result]));
    };
    const drifted = await verifyInstallation();
    assert.equal(drifted.get('function.apply_order_decision.matches_repository'),'false');
    assert.equal(drifted.get('function.order_has_valid_asset.matches_repository'),'false');
    await assert.rejects(() => decide(acceptedBeforeRepair,'ACCEPT'),/Isolated drift fixture/);
    const functionRepair = readFileSync('supabase/migrations/20261108020000_restore_payment_functions.sql','utf8');
    await db.exec(functionRepair);
    await db.exec(functionRepair);
    const optionalUnclaimedReason = readFileSync('supabase/migrations/20261108040000_optional_unclaimed_reason.sql','utf8');
    await db.exec(optionalUnclaimedReason);
    await db.exec(optionalUnclaimedReason);
    const completeCashOnCollection = readFileSync('supabase/migrations/20261108050000_complete_cash_on_collection.sql','utf8');
    await db.exec(completeCashOnCollection);
    await db.exec(completeCashOnCollection);
    const restored = await verifyInstallation();
    assert.equal(restored.get('function.apply_order_decision.matches_repository'),'false','The earlier cash repair predates the combined GCash verification workflow');
    assert.equal(restored.get('function.order_has_valid_asset.matches_repository'),'true');
    assert.equal(restored.get('decision.lock_timeout'),'3s');
    assert.deepEqual(await functionIdentities(),identitiesBeforeRepair,'Repair preserves function identities and owners');
    assert.deepEqual(await row(acceptedBeforeRepair),acceptedSnapshot,'Replacing function bodies must not rewrite orders');
    assert.equal(await scalar('select count(*)::int from public.order_decisions'),decisionsBeforeRepair);
    for (const role of ['anon','authenticated']) {
      assert.equal(await scalar("select has_function_privilege($1,'public.apply_order_decision(uuid,uuid,text,text,jsonb)','EXECUTE')",[role]),false);
      assert.equal(await scalar("select has_function_privilege($1,'public.order_has_valid_asset(uuid)','EXECUTE')",[role]),false);
    }
    assert.equal(restored.get('decision.backend_can_execute'),'true');

    await db.exec('drop trigger guard_order_payment_workflow on public.orders');
    const missingGuardCash = await create('CASH_ON_PICKUP');
    assert.equal((await row(missingGuardCash)).payment_status,'UNPAID','Missing guard leaves cash at the column default');
    const missingGuardDraft = randomUUID();
    await db.query("insert into public.orders(id,client_id,shop_id,state,payment_method) values($1,$2,$3,'DRAFT','CASH_ON_PICKUP')",[missingGuardDraft,student,shop]);
    const guardRepair = readFileSync('supabase/migrations/20261108012000_restore_payment_guard.sql','utf8');
    await db.exec(guardRepair);
    await db.exec(guardRepair);
    assert.equal((await row(missingGuardCash)).payment_status,'DUE_AT_PICKUP');
    assert.equal((await row(missingGuardCash)).acceptance_status,'PENDING');
    assert.equal((await row(missingGuardDraft)).payment_status,'DUE_AT_PICKUP');
    assert.deepEqual(await row(acceptedBeforeRepair),acceptedSnapshot,'Repair preserves already accepted orders');
    assert.equal(await scalar('select count(*)::int from public.order_decisions'),decisionsBeforeRepair,'Repair must not fabricate decisions');
    assert.equal(await scalar("select count(*)::int from pg_trigger where tgrelid='public.orders'::regclass and tgname='guard_order_payment_workflow' and tgenabled='O'"),1);
    assert.equal(await scalar("select proconfig @> array['lock_timeout=3s'] from pg_proc where oid='public.apply_order_decision(uuid,uuid,text,text,jsonb)'::regprocedure"),true);
    assert.equal(await scalar("select proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid='public.apply_order_decision(uuid,uuid,text,text,jsonb)'::regprocedure"),true);
    assert.equal(await scalar("select has_function_privilege('authenticated','public.apply_order_decision(uuid,uuid,text,text,jsonb)','EXECUTE')"),false);
    await decide(missingGuardCash,'ACCEPT');
    await decide(missingGuardCash,'ACCEPT');
    assert.equal((await row(missingGuardCash)).state,'IN_PRODUCTION');
    assert.equal((await row(missingGuardCash)).production_authorized,true);
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='ACCEPT'",[missingGuardCash]),1);
    const cashAfterRepair = await create('CASH_ON_PICKUP');
    assert.equal((await row(cashAfterRepair)).payment_status,'DUE_AT_PICKUP');
    assert.equal((await row(cashAfterRepair)).expires_at,null);
    await assert.rejects(() => db.query("update public.orders set state='IN_PRODUCTION' where id=$1",[cashAfterRepair]),/Acceptance/);

    // Reproduce both old expiry paths before applying the database safeguard.
    // All rows and destructive queries here belong to this isolated PGlite DB.
    const oldDeletedCash = await create('CASH_ON_PICKUP', false);
    await db.query("update public.orders set created_at=now()-interval '16 minutes' where id=$1",[oldDeletedCash]);
    await db.exec("delete from public.orders where state='OPEN_INQUIRY' and created_at < now()-interval '15 minutes'");
    assert.equal(await row(oldDeletedCash),undefined,'The old cleanup can delete a cash inquiry');
    const oldExpiredCash = await create('CASH_ON_PICKUP', false);
    await db.query("update public.orders set state='EXPIRED' where id=$1",[oldExpiredCash]);
    assert.equal((await row(oldExpiredCash)).state,'EXPIRED','Direct expiry bypasses the payment RPC');

    const protectedCash = await create('CASH_ON_PICKUP');
    await db.query("update public.orders set created_at=now()-interval '16 minutes', expires_at=now()-interval '1 minute' where id=$1",[protectedCash]);
    const expiryRepair = readFileSync('supabase/migrations/20261108011000_protect_cash_orders_from_expiry.sql','utf8');
    await db.exec(expiryRepair);
    await db.exec(expiryRepair); // Safe to reapply without replaying payment migrations.
    assert.equal((await row(protectedCash)).expires_at,null);
    assert.equal((await row(protectedCash)).state,'OPEN_INQUIRY');
    assert.equal((await row(oldExpiredCash)).state,'EXPIRED','Historical records must not be reopened automatically');
    const cleanup = await db.query("delete from public.orders where state='OPEN_INQUIRY' and created_at < now()-interval '15 minutes' returning id");
    assert.equal(cleanup.rows.length,0);
    assert.equal((await row(protectedCash)).state,'OPEN_INQUIRY');
    assert.equal(await scalar('select count(*)::int from public.assets where order_id=$1',[protectedCash]),1);
    const directExpiry = await db.query("update public.orders set state='EXPIRED' where id=$1 returning id",[protectedCash]);
    assert.equal(directExpiry.rows.length,0);
    assert.equal((await row(protectedCash)).state,'OPEN_INQUIRY');
    await db.query("update public.orders set expires_at=now()-interval '1 minute' where id=$1",[protectedCash]);
    assert.equal((await row(protectedCash)).expires_at,null,'Later writes cannot restore a cash deadline');
    await decide(protectedCash,'EXPIRE',{},null,'SYSTEM');
    assert.equal((await row(protectedCash)).state,'OPEN_INQUIRY');
    await decide(protectedCash,'REJECT_ORDER',{reason:'Unable to fulfill'});
    assert.equal((await row(protectedCash)).state,'REJECTED','Explicit shop rejection still works');
    const cancelledCash = await create('CASH_ON_PICKUP');
    await decide(cancelledCash,'CANCEL',{},student,'STUDENT');
    assert.equal((await row(cancelledCash)).state,'CANCELLED','Student cancellation still works');
    const cashDraft = randomUUID();
    await db.query("insert into public.orders(id,client_id,shop_id,state,payment_method) values($1,$2,$3,'DRAFT','CASH_ON_PICKUP')",[cashDraft,student,shop]);
    await db.query("delete from public.orders where id=$1 and state='DRAFT'",[cashDraft]);
    assert.equal(await row(cashDraft),undefined,'Unused drafts remain deletable');
    const submittedCashDraft = randomUUID();
    await db.query("insert into public.orders(id,client_id,shop_id,state,payment_method) values($1,$2,$3,'DRAFT','GCASH')",[submittedCashDraft,student,shop]);
    await db.query("update public.orders set payment_method='CASH_ON_PICKUP', state='OPEN_INQUIRY', created_at=now()-interval '16 minutes' where id=$1",[submittedCashDraft]);
    await db.exec("delete from public.orders where state='OPEN_INQUIRY' and created_at < now()-interval '15 minutes'");
    assert.equal((await row(submittedCashDraft)).state,'OPEN_INQUIRY');
    assert.equal((await row(submittedCashDraft)).expires_at,null);
    await assert.rejects(() => db.query("insert into public.orders(client_id,shop_id,state,payment_method) values($1,$2,'EXPIRED','CASH_ON_PICKUP')",[student,shop]), /cannot expire/);

    // A recorded acceptance can be stranded in OPEN_INQUIRY by an older RPC.
    // The canonical ACCEPT retry is idempotent and returns before authorizing it.
    const strandedCash = await create('CASH_ON_PICKUP');
    const strand = async id => db.query("update public.orders set acceptance_status='ACCEPTED', acceptance_provenance='EXPLICIT', accepted_at=now()-interval '5 minutes' where id=$1",[id]);
    await strand(strandedCash);
    const beforeRecovery = await row(strandedCash);
    assert.equal((await decide(strandedCash,'ACCEPT')).state,'OPEN_INQUIRY','Reproduce the accepted-but-not-production gap');
    const pendingRecoveryCash = await create('CASH_ON_PICKUP');
    const invalidRecoveryCash = await create('CASH_ON_PICKUP',false);
    await strand(invalidRecoveryCash);
    const inferredRecoveryCash = await create('CASH_ON_PICKUP');
    await db.query("update public.orders set acceptance_status='ACCEPTED', acceptance_provenance='LEGACY_INFERRED' where id=$1",[inferredRecoveryCash]);
    const untimedRecoveryCash = await create('CASH_ON_PICKUP');
    await db.query("update public.orders set acceptance_status='ACCEPTED' where id=$1",[untimedRecoveryCash]);
    const legacyAwaitingCash = await create('CASH_ON_PICKUP');
    await strand(legacyAwaitingCash);
    await db.query("update public.orders set state='AWAITING_PAYMENT' where id=$1",[legacyAwaitingCash]);
    const gcashRecoveryOrder = await create();
    await strand(gcashRecoveryOrder);
    const closedRecoveryCash = await create('CASH_ON_PICKUP');
    await strand(closedRecoveryCash);
    await db.query("update public.orders set state='CANCELLED' where id=$1",[closedRecoveryCash]);
    const unverifiedRecoveryCash = await create('CASH_ON_PICKUP');
    await strand(unverifiedRecoveryCash);
    const unverifiedShop = randomUUID();
    await db.query("insert into public.shops values($1,'PENDING')",[unverifiedShop]);
    await db.query('update public.orders set shop_id=$1 where id=$2',[unverifiedShop,unverifiedRecoveryCash]);
    const excludedRecoveryIds = [pendingRecoveryCash,invalidRecoveryCash,inferredRecoveryCash,gcashRecoveryOrder,closedRecoveryCash,unverifiedRecoveryCash];
    const excludedBeforeRecovery = await Promise.all(excludedRecoveryIds.map(row));
    const recovery = readFileSync('supabase/migrations/20261108030000_recover_accepted_cash_production.sql','utf8');
    await db.exec(recovery);
    await db.exec(recovery);
    const recoveredCash = await row(strandedCash);
    assert.equal(recoveredCash.state,'IN_PRODUCTION');
    assert.equal(recoveredCash.production_authorized,true);
    assert.notEqual(recoveredCash.production_authorized_at,null);
    assert.equal(recoveredCash.payment_status,'DUE_AT_PICKUP','Recovery does not record cash collection');
    assert.equal(recoveredCash.expires_at,null);
    assert.deepEqual(recoveredCash.accepted_at,beforeRecovery.accepted_at,'Preserve the original acceptance time');
    assert.equal(recoveredCash.acceptance_provenance,beforeRecovery.acceptance_provenance);
    assert.deepEqual(await Promise.all(excludedRecoveryIds.map(row)),excludedBeforeRecovery,'Preserve pending, invalid, inferred, GCash, closed and unverified-shop orders');
    assert.equal((await row(untimedRecoveryCash)).state,'IN_PRODUCTION');
    assert.equal((await row(untimedRecoveryCash)).accepted_at,null,'Do not invent a historical acceptance timestamp');
    assert.equal((await row(legacyAwaitingCash)).state,'IN_PRODUCTION','Recover explicitly accepted legacy cash orders awaiting payment too');
    const recoveryDecisions = (await db.query("select * from public.order_decisions where order_id=$1 and action='RECOVER_PRODUCTION'",[strandedCash])).rows;
    assert.equal(recoveryDecisions.length,1,'Repeating recovery must not append duplicate decisions');
    assert.equal(recoveryDecisions[0].actor_role,'SYSTEM');
    assert.equal(recoveryDecisions[0].amount,null);
    assert.equal(recoveryDecisions[0].previous_status.state,'OPEN_INQUIRY');
    assert.equal(recoveryDecisions[0].new_status.state,'IN_PRODUCTION');
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action in ('ACCEPT','COLLECT_CASH')",[strandedCash]),0,'Recovery must not invent acceptance or collection decisions');
    assert.equal(await scalar('select public.claim_payment_eligible_print_job($1,$2)',[strandedCash,shop]),true,'Recovered cash order is eligible for printing');

    // Reproduce a deployed function with no backend EXECUTE grant, then repair
    // it using the additive migration rather than replaying the original DDL.
    const permissionRepairOrder = await create();
    await db.exec('revoke execute on function public.apply_order_decision(uuid,uuid,text,text,jsonb) from service_role');
    await db.exec('set role service_role');
    try {
      await assert.rejects(() => decide(permissionRepairOrder,'CANCEL',{},student,'STUDENT'), /permission denied for function/);
    } finally { await db.exec('reset role'); }
    const permissionRepair = readFileSync('supabase/migrations/20261107020000_payment_rpc_permissions.sql','utf8');
    await db.exec(permissionRepair);
    await db.exec(permissionRepair); // Safe if operators apply the repair twice.
    assert.equal(await scalar("select has_function_privilege('anon','public.apply_order_decision(uuid,uuid,text,text,jsonb)','EXECUTE')"),false);
    assert.equal(await scalar("select has_function_privilege('authenticated','public.apply_order_decision(uuid,uuid,text,text,jsonb)','EXECUTE')"),false);
    // Exercise the actual backend database role, not only the migration owner.
    // Browser roles must remain unable to execute this privileged transaction.
    assert.equal(await scalar("select has_function_privilege('service_role','public.apply_order_decision(uuid,uuid,text,text,jsonb)','EXECUTE')"),true);
    const studentActions = await create();
    await db.exec('set role service_role');
    try {
      await decide(studentActions,'UPLOAD_RECEIPT',{receiptPath:'private/student.png',reference:'student-role-reference'},student,'STUDENT');
      const cancelledStudentOrder = await decide(studentActions,'CANCEL',{},student,'STUDENT');
      assert.equal(cancelledStudentOrder.state,'CANCELLED');
    } finally { await db.exec('reset role'); }
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

    // Simulate the old deployed cash workflow in this isolated database, then
    // recover collected pickups without duplicating/relabeling their payment.
    await db.exec(optionalUnclaimedReason);
    const legacyCollectedCash = await create('CASH_ON_PICKUP');
    await decide(legacyCollectedCash,'ACCEPT');
    await decide(legacyCollectedCash,'READY_FOR_PICKUP',{confirmed:true});
    await decide(legacyCollectedCash,'FLAG_UNCLAIMED');
    await decide(legacyCollectedCash,'COLLECT_CASH',{confirmed:true});
    const legacyCollectedBefore = await row(legacyCollectedCash);
    assert.equal(legacyCollectedBefore.state,'READY_FOR_PICKUP');
    const legacyCollectionAudit = (await db.query("select * from public.order_decisions where order_id=$1 and action='COLLECT_CASH'",[legacyCollectedCash])).rows;
    await db.exec(completeCashOnCollection);
    await db.exec(completeCashOnCollection);
    const legacyCompletedCash = await row(legacyCollectedCash);
    assert.equal(legacyCompletedCash.state,'COMPLETED');
    assert.equal(legacyCompletedCash.payment_status,'COLLECTED');
    assert.equal(legacyCompletedCash.is_unclaimed,false);
    assert.equal(legacyCompletedCash.unclaimed_at,null);
    assert.equal(legacyCompletedCash.unclaimed_reason,null);
    assert.deepEqual(legacyCompletedCash.cash_collected_at,legacyCollectedBefore.cash_collected_at);
    assert.deepEqual(legacyCompletedCash.accepted_at,legacyCollectedBefore.accepted_at);
    assert.deepEqual((await db.query("select * from public.order_decisions where order_id=$1 and action='COLLECT_CASH'",[legacyCollectedCash])).rows,legacyCollectionAudit);
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='COMPLETE_CASH_PICKUP'",[legacyCollectedCash]),1);

    const cash = await create('CASH_ON_PICKUP');
    assert.equal((await row(cash)).expires_at,null);
    assert.equal((await row(cash)).payment_status,'DUE_AT_PICKUP');
    await db.query("update public.orders set expires_at=now()-interval '1 minute' where id=$1",[cash]);
    assert.equal((await row(cash)).expires_at,null);
    await decide(cash,'EXPIRE',{},null,'SYSTEM');
    assert.equal((await row(cash)).state,'OPEN_INQUIRY');
    await assert.rejects(() => receipt(cash), /not available/);
    await decide(cash,'ACCEPT');
    assert.equal((await row(cash)).state,'IN_PRODUCTION');
    await assert.rejects(() => decide(cash,'FLAG_UNCLAIMED'),/requires a ready order/);
    await decide(cash,'READY_FOR_PICKUP',{confirmed:true});
    await assert.rejects(() => decide(cash,'FLAG_UNCLAIMED',{},otherShop,'SHOP'),/owning shop/);
    await assert.rejects(() => decide(cash,'FLAG_UNCLAIMED',{},student,'STUDENT'),/not permitted/);
    await decide(cash,'FLAG_UNCLAIMED');
    const flaggedCash = await row(cash);
    assert.equal(flaggedCash.is_unclaimed,true);
    assert.equal(flaggedCash.unclaimed_reason,null);
    assert.notEqual(flaggedCash.unclaimed_at,null);
    await decide(cash,'FLAG_UNCLAIMED');
    assert.deepEqual((await row(cash)).unclaimed_at,flaggedCash.unclaimed_at,'Repeated flagging preserves the original flag timestamp');
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='FLAG_UNCLAIMED'",[cash]),1);
    const unclaimedAudit = (await db.query("select reason, amount, new_status from public.order_decisions where order_id=$1 and action='FLAG_UNCLAIMED'",[cash])).rows[0];
    assert.equal(unclaimedAudit.reason,null);
    assert.equal(unclaimedAudit.amount,null);
    assert.equal(unclaimedAudit.new_status.is_unclaimed,true);
    await decide(cash,'CLEAR_UNCLAIMED');
    assert.equal((await row(cash)).is_unclaimed,false);
    await decide(cash,'FLAG_UNCLAIMED',{reason:'Optional reason from an older client'});
    assert.equal((await row(cash)).unclaimed_reason,'Optional reason from an older client');
    assert.equal((await row(cash)).payment_status,'DUE_AT_PICKUP');
    await assert.rejects(() => decide(cash,'COMPLETED',{confirmed:true}), /cash collection/);
    await assert.rejects(() => decide(cash,'COLLECT_CASH'),/Confirm full cash collection/);
    await assert.rejects(() => decide(cash,'COLLECT_CASH',{confirmed:true},otherShop,'SHOP'),/owning shop/);
    await assert.rejects(() => decide(cash,'COLLECT_CASH',{confirmed:true},student,'STUDENT'),/not permitted/);
    await Promise.all([decide(cash,'COLLECT_CASH',{confirmed:true}),decide(cash,'COLLECT_CASH',{confirmed:true})]);
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='COLLECT_CASH'",[cash]),1);
    const collectedCash = await row(cash);
    assert.equal(collectedCash.state,'COMPLETED','Cash collection completes the order in the same transaction');
    assert.equal(collectedCash.payment_status,'COLLECTED');
    assert.equal(collectedCash.is_unclaimed,false);
    assert.equal(collectedCash.unclaimed_at,null);
    assert.equal(collectedCash.unclaimed_reason,null);
    const collectedAudit = (await db.query("select amount,new_status from public.order_decisions where order_id=$1 and action='COLLECT_CASH'",[cash])).rows[0];
    assert.equal(Number(collectedAudit.amount),Number(collectedCash.total));
    assert.equal(collectedAudit.new_status.state,'COMPLETED');
    assert.equal(collectedAudit.new_status.payment_status,'COLLECTED');
    await decide(cash,'COMPLETED',{confirmed:true});
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='COMPLETED'",[cash]),0,'An older client retry does not create a second completion decision');
    assert.equal((await row(cash)).state,'COMPLETED');
    assert.equal((await row(cash)).is_unclaimed,false);
    await assert.rejects(() => decide(cash,'FLAG_UNCLAIMED'),/requires a ready order/);
    await assert.rejects(() => db.query("update public.orders set payment_method='GCASH' where id=$1",[cash]), /locked/);
    await decide(gcash,'READY_FOR_PICKUP',{confirmed:true});
    await assert.rejects(() => decide(gcash,'COMPLETED'),/Confirm output or handover/);
    await decide(gcash,'COMPLETED',{confirmed:true});
    assert.equal((await row(gcash)).state,'COMPLETED');
    assert.equal((await row(gcash)).payment_status,'VERIFIED','GCash handover remains separate from payment verification');

    // A later audit failure must roll back both payment and completion.
    const failedCollection = await create('CASH_ON_PICKUP');
    await decide(failedCollection,'ACCEPT');
    await decide(failedCollection,'READY_FOR_PICKUP',{confirmed:true});
    await decide(failedCollection,'FLAG_UNCLAIMED');
    const beforeFailedCollection = await row(failedCollection);
    await db.query("insert into public.order_decisions(order_id,actor_role,action,previous_status,new_status) values($1,'SYSTEM','COLLECT_CASH','{}','{}')",[failedCollection]);
    await assert.rejects(() => decide(failedCollection,'COLLECT_CASH',{confirmed:true}),/duplicate key/);
    assert.deepEqual(await row(failedCollection),beforeFailedCollection,'Audit failure must not partially collect cash, complete the order, or clear its flag');

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
    // Upgrade the previous separate-decision workflow without reopening closed
    // orders, inventing payment evidence, or changing cash acceptance.
    const verifiedInquiry = await create();
    const verifiedInquiryReceipt = await receipt(verifiedInquiry);
    await decide(verifiedInquiry,'VERIFY',{receiptId:verifiedInquiryReceipt,confirmed:true});
    const beforeVerifiedRecovery = await row(verifiedInquiry);
    assert.equal(beforeVerifiedRecovery.acceptance_status,'PENDING');
    const pendingInquiry = await create();await receipt(pendingInquiry);
    const invalidVerifiedInquiry = await create('GCASH',false);
    await decide(invalidVerifiedInquiry,'VERIFY',{receiptId:await receipt(invalidVerifiedInquiry),confirmed:true});
    const pendingCash = await create('CASH_ON_PICKUP');
    const excludedGcashIds = [pendingInquiry,invalidVerifiedInquiry,pendingCash,cancelled];
    // Priority #4's fulfillment tables/fields must exist before the final payment RPC.
    await db.exec(`
      alter table public.orders add column output_confirmed_attempt_id uuid,
        add column output_confirmed_at timestamptz, add column output_confirmed_by uuid,
        add column handed_over_at timestamptz, add column handed_over_by uuid;
      alter table public.print_jobs add column resolved_at timestamptz;
      create table public.order_fulfillment_events (
        id bigint generated by default as identity primary key,
        order_id uuid not null references public.orders(id), shop_id uuid not null,
        event_type text not null, attempt_id uuid, actor_id uuid,
        created_at timestamptz default now()
      );
    `);
    const excludedGcashBefore = await Promise.all(excludedGcashIds.map(row));
    const gcashVerification = readFileSync('supabase/migrations/20261108060000_authorize_gcash_on_verification.sql','utf8');
    await db.exec(gcashVerification);await db.exec(gcashVerification);
    const recoveredVerifiedInquiry = await row(verifiedInquiry);
    assert.equal(recoveredVerifiedInquiry.state,'IN_PRODUCTION');
    assert.equal(recoveredVerifiedInquiry.acceptance_status,'ACCEPTED');
    assert.equal(recoveredVerifiedInquiry.acceptance_provenance,'PAYMENT_VERIFIED');
    assert.deepEqual(recoveredVerifiedInquiry.accepted_at,beforeVerifiedRecovery.payment_verified_at);
    assert.deepEqual(recoveredVerifiedInquiry.payment_verified_at,beforeVerifiedRecovery.payment_verified_at);
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='AUTHORIZE_VERIFIED_GCASH'",[verifiedInquiry]),1);
    assert.deepEqual(await Promise.all(excludedGcashIds.map(row)),excludedGcashBefore);
    const directGcash = await create();
    const directReceipt = await receipt(directGcash);
    const beforeReview = await row(directGcash);
    await assert.rejects(()=>decide(directGcash,'ACCEPT'),/receipt verification/);
    await assert.rejects(()=>decide(directGcash,'REJECT_ORDER',{reason:'Old UI'}),/receipt rejection/);
    await assert.rejects(()=>decide(directGcash,'VERIFY',{receiptId:directReceipt,confirmed:true},otherShop,'SHOP'),/owning shop/);
    await assert.rejects(()=>decide(directGcash,'VERIFY',{receiptId:directReceipt}),/Confirm receipt/);
    assert.deepEqual(await row(directGcash),beforeReview);
    await decide(directGcash,'REJECT_RECEIPT',{receiptId:directReceipt,reason:'Wrong reference'});
    assert.equal((await row(directGcash)).state,'OPEN_INQUIRY');
    assert.equal((await row(directGcash)).acceptance_status,'PENDING');
    const replacementReceipt=await receipt(directGcash);
    await assert.rejects(()=>decide(directGcash,'VERIFY',{receiptId:directReceipt,confirmed:true}),/Receipt changed/);
    await decide(directGcash,'VERIFY',{receiptId:replacementReceipt,confirmed:true});
    assert.equal((await row(directGcash)).state,'IN_PRODUCTION');
    assert.equal((await row(directGcash)).payment_status,'VERIFIED');
    assert.equal((await row(directGcash)).acceptance_provenance,'PAYMENT_VERIFIED');
    assert.equal(await scalar("select count(*)::int from public.order_decisions where order_id=$1 and action='ACCEPT'",[directGcash]),0);
    assert.equal(await scalar('select public.claim_payment_eligible_print_job($1,$2)',[directGcash,shop]),true);
    const adminGcash=await create();const adminGcashReceipt=await receipt(adminGcash);
    await decide(adminGcash,'REJECT_RECEIPT',{receiptId:adminGcashReceipt,reason:'Needs review'});
    await decide(adminGcash,'DISPUTE',{reason:'Transfer matches'},student,'STUDENT');
    await decide(adminGcash,'ADMIN_VERIFY',{receiptId:adminGcashReceipt,confirmed:true},admin,'ADMIN');
    assert.equal((await row(adminGcash)).state,'IN_PRODUCTION');
    const closedGcash=await create();const closedReceipt=await receipt(closedGcash);
    await decide(closedGcash,'CANCEL',{},student,'STUDENT');
    await decide(closedGcash,'VERIFY',{receiptId:closedReceipt,confirmed:true});
    assert.equal((await row(closedGcash)).state,'CANCELLED');
    assert.equal((await row(closedGcash)).payment_status,'REFUND_DUE');
    const cashAfterChange=await create('CASH_ON_PICKUP');
    assert.equal((await row(cashAfterChange)).state,'OPEN_INQUIRY');
    assert.equal((await row(cashAfterChange)).acceptance_status,'PENDING');
    await decide(cashAfterChange,'ACCEPT');
    // The Priority #4 operator output-check RPC owns READY_FOR_PICKUP.
    await db.query("update public.orders set state='READY_FOR_PICKUP', output_confirmed_at=now() where id=$1", [cashAfterChange]);
    await decide(cashAfterChange,'COLLECT_CASH',{confirmed:true});
    assert.equal((await row(cashAfterChange)).state,'COMPLETED');
    const rejectedCash=await create('CASH_ON_PICKUP');
    await decide(rejectedCash,'REJECT_ORDER',{reason:'Cannot fulfill'});
    assert.equal((await row(rejectedCash)).state,'REJECTED');
    await db.exec(readFileSync('supabase/migrations/20261108080000_repair_merged_payment_verification.sql','utf8'));
    const verification = await db.exec(readFileSync('scripts/verify-payment-installation.sql','utf8'));
    assert.equal(verification.length,1,'SQL Editor must receive a single result table');
    const installation = new Map(verification[0].rows.map(check => [check.check_name,check.result]));
    for (const name of ['apply_order_decision','order_has_valid_asset','guard_order_payment_workflow']) {
      assert.equal(installation.get(`function.${name}.matches_repository`),'true');
    }
    assert.equal(installation.get('decision.security_definer'),'true');
    assert.equal(installation.get('decision.lock_timeout'),'3s');
    assert.equal(installation.get('decision.backend_can_execute'),'true');
    assert.equal(installation.get('trigger.guard_order_payment_workflow.enabled'),'O');
    assert.equal(installation.get('trigger.zz_guard_cash_order_expiry.enabled'),'O');
    assert.equal(Number(installation.get('activity.active_decisions')) >= 0,true);
    console.log('Payment workflow migration, authorization, receipt, refund, dispatch and handover checks passed.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.message, error.position || '', error.where || ''); process.exitCode=1; });
