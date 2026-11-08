// PGlite checks for the Priority #4 print-attempt and fulfillment migration.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const LEGACY = 'supabase/migrations/20260924020000_print_jobs.sql';
const MIGRATION =
  'supabase/migrations/20261108000000_print_attempts_and_fulfillment.sql';
const CHECKS = {
  document: true,
  revision: true,
  paper: true,
  color: true,
  orientation: true,
  pages: true,
  copies: true,
};

async function main() {
  const db = new PGlite();
  const shopId = randomUUID();
  const otherShop = randomUUID();
  const deviceId = randomUUID();
  const otherDevice = randomUUID();
  const actor = randomUUID();
  const rpc = async (name, args) => {
    const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
    const { rows } = await db.query(
      `select public.${name}(${placeholders}) as result`,
      args,
    );
    return rows[0].result;
  };
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const order = async (state = 'IN_PRODUCTION', paid = true) => {
    const id = randomUUID();
    await db.query(
      'insert into public.orders(id, shop_id, state) values ($1, $2, $3)',
      [id, shopId, state],
    );
    if (paid)
      await db.query(
        'insert into public.payment_receipts(order_id, verified) values ($1, true)',
        [id],
      );
    return id;
  };
  const create = (orderId, overrides = {}) => {
    const o = {
      kind: 'INITIAL',
      mode: 'AGENT',
      previous: null,
      revision: 'user/order/source.pdf',
      device: deviceId,
      reason: null,
      queueCleared: null,
      shop: shopId,
      ...overrides,
    };
    return rpc('print_create_attempt', [
      orderId,
      o.shop,
      o.kind,
      o.mode,
      o.previous,
      o.revision,
      'print-ready/x.pdf',
      'a'.repeat(64),
      1234,
      o.mode === 'AGENT' ? o.device : null,
      'Desk',
      JSON.stringify({ copies: 2, paperSize: 'A4' }),
      null,
      actor,
      o.reason,
      o.queueCleared,
    ]);
  };
  const event = (attemptId, sequence, status, overrides = {}) =>
    rpc('print_record_agent_event', [
      attemptId,
      overrides.shop || shopId,
      overrides.device || deviceId,
      sequence,
      status,
      overrides.phase || null,
      overrides.code || null,
      overrides.message || null,
      new Date().toISOString(),
    ]);
  const attemptRow = (attemptId) =>
    one('select * from public.print_jobs where attempt_id = $1', [attemptId]);
  const orderRow = (orderId) =>
    one('select state::text as state, * from public.orders where id = $1', [
      orderId,
    ]);

  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create type public.order_state as enum ('DRAFT', 'OPEN_INQUIRY', 'IN_PRODUCTION',
        'PRINTED', 'READY_FOR_PICKUP', 'COMPLETED', 'EXPIRED');
      create table public.shops (id uuid primary key);
      create table public.orders (id uuid primary key, shop_id uuid references public.shops(id),
        state public.order_state not null);
      create table public.payment_receipts (id bigint generated always as identity primary key,
        order_id uuid references public.orders(id), verified boolean not null default false);
      insert into public.shops values ('${shopId}'), ('${otherShop}');
    `);
    await db.exec(readFileSync(LEGACY, 'utf8'));

    // Legacy fixtures recorded by the old backend.
    const legacyPrinted = await order('PRINTED');
    const legacyActive = await order('IN_PRODUCTION');
    const legacyDone = await order('COMPLETED');
    await db.query(
      `insert into public.print_jobs(order_id, shop_id, status, updated_at) values
        ($1, $4, 'COMPLETED', now() - interval '1 hour'),
        ($2, $4, 'FAILED', now() - interval '2 hour'),
        ($2, $4, 'SENT_TO_SPOOLER', now() - interval '1 hour'),
        ($3, $4, 'COMPLETED', now() - interval '3 hour')`,
      [legacyPrinted, legacyActive, legacyDone, shopId],
    );

    const migration = readFileSync(MIGRATION, 'utf8');
    await db.exec(migration);
    await db.exec(migration);

    const legacy = (
      await db.query(
        'select order_id, status, legacy_status, attempt_number, resolution, is_legacy from public.print_jobs order by order_id, attempt_number',
      )
    ).rows;
    const byOrder = (id) => legacy.filter((row) => row.order_id === id);
    assert.deepEqual(
      byOrder(legacyPrinted).map((row) => [row.status, row.legacy_status, row.resolution]),
      [['SUBMITTED', 'COMPLETED', null]],
      'Legacy COMPLETED is submission evidence only and awaits output confirmation',
    );
    assert.deepEqual(
      byOrder(legacyActive).map((row) => [row.attempt_number, row.status, row.resolution]),
      [
        [1, 'OUTCOME_UNKNOWN', 'LEGACY_CLOSED'],
        [2, 'OUTCOME_UNKNOWN', null],
      ],
      'Legacy spooler reports are uncertain; only the latest stays open',
    );
    assert.equal(byOrder(legacyDone)[0].resolution, 'LEGACY_CLOSED');
    assert.equal(
      (await one('select count(*)::int as n from public.print_job_events where event_type = $1', ['LEGACY_BACKFILL'])).n,
      4,
      'Backfill history is recorded once across repeated application',
    );
    assert.equal(
      (await orderRow(legacyDone)).state,
      'COMPLETED',
      'Historical completed orders are preserved',
    );

    // The not-yet-updated backend's insert keeps working during rollout.
    const rollout = await order();
    await db.query(
      "insert into public.print_jobs(order_id, shop_id, status) values ($1, $2, 'QUEUED')",
      [rollout, shopId],
    );
    const rolloutRow = await one(
      'select attempt_number, attempt_kind, execution_mode from public.print_jobs where order_id = $1',
      [rollout],
    );
    assert.deepEqual(
      [rolloutRow.attempt_number, rolloutRow.attempt_kind, rolloutRow.execution_mode],
      [1, 'INITIAL', 'AGENT'],
    );
    await assert.rejects(
      () =>
        db.query(
          "insert into public.print_jobs(order_id, shop_id, status) values ($1, $2, 'QUEUED')",
          [rollout, shopId],
        ),
      /duplicate key/,
      'The old claim still gets its duplicate protection',
    );

    // A legacy active order cannot be dispatched again without reconciliation.
    assert.equal((await create(legacyActive)).code, 'ATTEMPT_OPEN');
    const legacyOpen = (
      await one(
        'select attempt_id from public.print_jobs where order_id = $1 and resolved_at is null',
        [legacyActive],
      )
    ).attempt_id;
    assert.equal(
      (await create(legacyActive, { kind: 'RETRY', previous: legacyOpen }))
        .code,
      'RECONCILIATION_REQUIRED',
    );
    const reconciled = await create(legacyActive, {
      kind: 'RETRY',
      previous: legacyOpen,
      reason: 'Queue cleared after legacy agent upgrade',
      queueCleared: true,
    });
    assert.equal(reconciled.ok, true);
    assert.equal((await attemptRow(legacyOpen)).resolution, 'SUPERSEDED');

    // --- Initial attempt and agent events ---------------------------------
    const orderId = await order();
    const created = await create(orderId);
    assert.equal(created.ok, true);
    const attemptId = created.attempt.attempt_id;
    assert.equal(created.attempt.status, 'QUEUED');
    assert.equal(created.attempt.attempt_number, 1);
    assert.equal(
      (await create(orderId)).code,
      'ATTEMPT_OPEN',
      'One unresolved attempt per order',
    );
    assert.equal(
      (await event(attemptId, 1, 'RECEIVED', { device: otherDevice })).code,
      'WRONG_DEVICE',
    );
    assert.equal(
      (await event(attemptId, 1, 'RECEIVED', { shop: otherShop })).code,
      'ATTEMPT_NOT_FOUND',
      'Cross-shop callbacks are rejected',
    );
    assert.equal((await event(attemptId, 1, 'RECEIVED')).result, 'APPLIED');
    assert.equal(
      (await event(attemptId, 1, 'RECEIVED')).result,
      'DUPLICATE',
      'A replayed event is acknowledged without reapplying',
    );
    assert.equal((await event(attemptId, 3, 'SUBMITTING')).result, 'APPLIED');
    assert.equal(
      (await event(attemptId, 2, 'DOWNLOADING')).result,
      'IGNORED_OUT_OF_ORDER',
    );
    assert.equal((await attemptRow(attemptId)).status, 'SUBMITTING');
    const authorizeBlocked = await rpc('print_authorize_attempt', [
      attemptId,
      shopId,
      deviceId,
    ]);
    assert.equal(authorizeBlocked.authorized, false);
    assert.equal((await event(attemptId, 4, 'SUBMITTED')).result, 'APPLIED');
    assert.equal(
      (await event(attemptId, 5, 'FAILED_PRE_SUBMISSION')).result,
      'IGNORED_TERMINAL',
    );
    const submitted = await attemptRow(attemptId);
    assert.equal(submitted.status, 'SUBMITTED');
    assert.ok(submitted.submitted_at);
    assert.equal(
      (await orderRow(orderId)).state,
      'IN_PRODUCTION',
      'A successful print-utility return never marks the order printed or ready',
    );
    assert.equal(
      (await one('select count(*)::int as n from public.print_job_events where attempt_id = $1 and source = $2', [attemptId, 'AGENT'])).n,
      5,
      'Late and out-of-order events stay in history; duplicates are not re-recorded',
    );
    await assert.rejects(
      () => db.query("update public.print_job_events set outcome = 'x'"),
      /append-only/,
    );

    // --- Output confirmation and handover -----------------------------------
    assert.equal(
      (await rpc('print_record_handover', [orderId, shopId, attemptId, actor])).code,
      'OUTPUT_NOT_CONFIRMED',
    );
    assert.equal(
      (await rpc('print_confirm_output', [orderId, shopId, attemptId, actor, null, JSON.stringify({ ...CHECKS, copies: false })])).code,
      'CHECKS_INCOMPLETE',
    );
    assert.equal(
      (await rpc('print_confirm_output', [orderId, shopId, randomUUID(), actor, null, JSON.stringify(CHECKS)])).code,
      'ATTEMPT_NOT_CURRENT',
    );
    assert.equal(
      (await rpc('print_confirm_output', [orderId, shopId, attemptId, actor, null, JSON.stringify(CHECKS)])).result,
      'CONFIRMED',
    );
    assert.equal(
      (await rpc('print_confirm_output', [orderId, shopId, attemptId, actor, null, JSON.stringify(CHECKS)])).result,
      'DUPLICATE',
    );
    assert.equal((await orderRow(orderId)).state, 'READY_FOR_PICKUP');
    assert.equal((await attemptRow(attemptId)).resolution, 'OUTPUT_CONFIRMED');
    assert.equal(
      (await event(attemptId, 6, 'OUTCOME_UNKNOWN')).result,
      'IGNORED_RESOLVED',
      'A late callback cannot change a confirmed attempt',
    );

    // Reprint invalidates readiness and requires fresh confirmation.
    assert.equal(
      (await create(orderId, { kind: 'REPRINT', previous: attemptId })).code,
      'REASON_REQUIRED',
    );
    const reprint = await create(orderId, {
      kind: 'REPRINT',
      previous: attemptId,
      reason: 'Paper jam smudged page 3',
    });
    assert.equal(reprint.ok, true);
    assert.equal(reprint.attempt.attempt_kind, 'REPRINT');
    assert.equal(reprint.attempt.attempt_number, 2);
    assert.equal(reprint.attempt.previous_attempt_id, attemptId);
    const afterReprint = await orderRow(orderId);
    assert.equal(afterReprint.state, 'IN_PRODUCTION');
    assert.equal(afterReprint.output_confirmed_at, null);
    assert.equal(
      (await one('select count(*)::int as n from public.order_fulfillment_events where order_id = $1', [orderId])).n,
      2,
      'Earlier confirmations stay in history',
    );
    const reprintId = reprint.attempt.attempt_id;
    assert.equal(
      (await create(orderId, { kind: 'REPRINT', previous: reprintId, reason: 'again' })).code,
      'ATTEMPT_NOT_REPRINTABLE',
      'An in-flight attempt cannot be reprinted',
    );
    await event(reprintId, 1, 'SUBMITTED');
    await rpc('print_confirm_output', [orderId, shopId, reprintId, actor, null, JSON.stringify(CHECKS)]);
    assert.equal(
      (await rpc('print_record_handover', [orderId, shopId, attemptId, actor])).code,
      'ATTEMPT_NOT_CURRENT',
      'Handover requires the current confirmed attempt',
    );
    assert.equal(
      (await rpc('print_record_handover', [orderId, shopId, reprintId, actor])).result,
      'HANDED_OVER',
    );
    assert.equal(
      (await rpc('print_record_handover', [orderId, shopId, reprintId, actor])).result,
      'DUPLICATE',
    );
    assert.equal(
      (await one("select count(*)::int as n from public.order_fulfillment_events where order_id = $1 and event_type = 'HANDED_OVER'", [orderId])).n,
      1,
      'Duplicate confirmations do not duplicate audit records',
    );
    assert.equal((await orderRow(orderId)).state, 'COMPLETED');
    assert.equal(
      (await create(orderId, { kind: 'REPRINT', previous: reprintId, reason: 'late' })).code,
      'ORDER_NOT_PRINTABLE',
      'Reprints are blocked after handover',
    );

    // Handover requires recorded payment.
    const unpaid = await order('IN_PRODUCTION', false);
    const unpaidAttempt = (await create(unpaid, { mode: 'MANUAL' })).attempt;
    assert.equal(unpaidAttempt.status, 'MANUAL_STARTED');
    await rpc('print_confirm_output', [unpaid, shopId, unpaidAttempt.attempt_id, actor, null, JSON.stringify(CHECKS)]);
    assert.equal(
      (await rpc('print_record_handover', [unpaid, shopId, unpaidAttempt.attempt_id, actor])).code,
      'PAYMENT_NOT_SETTLED',
    );
    assert.equal((await orderRow(unpaid)).state, 'READY_FOR_PICKUP');

    // --- Failures, uncertainty, and retries ----------------------------------
    const failing = await order();
    const first = (await create(failing)).attempt.attempt_id;
    assert.equal(
      (await create(failing, { kind: 'RETRY', previous: first })).code,
      'ATTEMPT_NOT_RETRYABLE',
      'A queued attempt is not retryable before it is stale',
    );
    await db.query(
      "update public.print_jobs set updated_at = now() - interval '11 minutes' where attempt_id = $1",
      [first],
    );
    assert.equal(
      (await create(failing, { kind: 'RETRY', previous: first })).code,
      'RECONCILIATION_REQUIRED',
      'Stale jobs are not silently made retryable',
    );
    assert.equal((await attemptRow(first)).status, 'QUEUED');
    await db.query(
      'update public.print_jobs set updated_at = now() where attempt_id = $1',
      [first],
    );
    await event(first, 1, 'RECEIVED');
    await event(first, 2, 'FAILED_PRE_SUBMISSION', {
      phase: 'DOWNLOADING',
      code: 'CHECKSUM_MISMATCH',
      message: 'Downloaded file did not match',
    });
    const failed = await attemptRow(first);
    assert.equal(failed.status, 'FAILED_PRE_SUBMISSION');
    assert.equal(failed.error_code, 'CHECKSUM_MISMATCH');
    assert.equal(
      (await create(failing, { kind: 'RETRY', previous: first, revision: 'other.pdf' })).code,
      'REVISION_CHANGED',
    );
    const retry = await create(failing, { kind: 'RETRY', previous: first });
    assert.equal(retry.ok, true);
    assert.equal(retry.attempt.attempt_kind, 'RETRY');
    assert.equal((await attemptRow(first)).superseded_by_attempt_id, retry.attempt.attempt_id);
    assert.equal(
      (await event(first, 3, 'SUBMITTED')).result,
      'IGNORED_RESOLVED',
      'A superseded attempt cannot be reactivated',
    );
    const retryId = retry.attempt.attempt_id;
    await event(retryId, 1, 'SUBMITTING');
    assert.equal(
      (await event(retryId, 2, 'FAILED_PRE_SUBMISSION')).result,
      'APPLIED_AS_UNKNOWN',
      'Failure after invocation started is uncertain',
    );
    assert.equal((await attemptRow(retryId)).status, 'OUTCOME_UNKNOWN');

    // An uncertain attempt pauses the device.
    const waiting = await order();
    const waitingAttempt = (await create(waiting)).attempt.attempt_id;
    const paused = await rpc('print_authorize_attempt', [waitingAttempt, shopId, deviceId]);
    assert.deepEqual(
      [paused.authorized, paused.reason, paused.blockingAttemptId],
      [false, 'DEVICE_PAUSED', retryId],
    );
    assert.equal(
      (await rpc('print_confirm_output', [failing, shopId, retryId, actor, null, JSON.stringify(CHECKS)])).code,
      'RECONCILIATION_REASON_REQUIRED',
    );
    assert.equal(
      (await rpc('print_record_reconciliation_note', [retryId, shopId, actor, 'Printer queue shows job held'])).result,
      'RECORDED',
    );
    assert.equal(
      (await rpc('print_confirm_output', [failing, shopId, retryId, actor, 'Inspected: complete output found in tray', JSON.stringify(CHECKS)])).result,
      'CONFIRMED',
    );
    const unpaused = await rpc('print_authorize_attempt', [waitingAttempt, shopId, deviceId]);
    assert.equal(unpaused.authorized, true);
    assert.equal(
      (await rpc('print_authorize_attempt', [waitingAttempt, shopId, otherDevice])).reason,
      'WRONG_DEVICE',
    );
    assert.equal(
      await rpc('print_mark_undelivered', [[waitingAttempt], shopId, 'AGENT_DISCONNECTED', 'x']),
      0,
      'An authorized attempt is never failed by the server',
    );
    const undelivered = await order();
    const undeliveredAttempt = (await create(undelivered)).attempt.attempt_id;
    assert.equal(
      await rpc('print_mark_undelivered', [[undeliveredAttempt], shopId, 'AGENT_DISCONNECTED', 'Agent offline']),
      1,
    );
    assert.equal((await attemptRow(undeliveredAttempt)).status, 'FAILED_PRE_SUBMISSION');
    assert.equal(
      (await rpc('print_authorize_attempt', [undeliveredAttempt, shopId, deviceId])).reason,
      'INVALID_STATE',
      'Revoked attempts cannot start later after reconnecting',
    );

    // Legacy PRINTED requires reconciliation before handover.
    assert.equal(
      (await rpc('print_record_handover', [legacyPrinted, shopId, null, actor])).code,
      'OUTPUT_NOT_CONFIRMED',
    );
    const legacyPrintedAttempt = (
      await one('select attempt_id from public.print_jobs where order_id = $1', [legacyPrinted])
    ).attempt_id;
    assert.equal(
      (await rpc('print_confirm_output', [legacyPrinted, shopId, legacyPrintedAttempt, actor, null, JSON.stringify(CHECKS)])).result,
      'CONFIRMED',
    );

    // --- Batch request idempotency -------------------------------------------
    const requestId = randomUUID();
    const hash = 'b'.repeat(64);
    assert.equal((await rpc('print_begin_batch_request', [requestId, shopId, hash, actor])).state, 'NEW');
    assert.equal((await rpc('print_begin_batch_request', [requestId, shopId, hash, actor])).state, 'IN_PROGRESS');
    assert.equal((await rpc('print_begin_batch_request', [requestId, shopId, 'c'.repeat(64), actor])).state, 'CONFLICT');
    assert.equal((await rpc('print_begin_batch_request', [requestId, otherShop, hash, actor])).state, 'CONFLICT');
    assert.equal(await rpc('print_complete_batch_request', [requestId, shopId, 'COMPLETED', JSON.stringify({ spooledCount: 1 })]), true);
    assert.equal(await rpc('print_complete_batch_request', [requestId, shopId, 'FAILED', '{}']), false);
    const replay = await rpc('print_begin_batch_request', [requestId, shopId, hash, actor]);
    assert.deepEqual([replay.state, replay.status, replay.response], ['DONE', 'COMPLETED', { spooledCount: 1 }]);

    // --- Concurrency: competing initial claims have one winner ---------------
    const contested = await order();
    const results = await Promise.all([create(contested), create(contested)]);
    assert.equal(results.filter((result) => result.ok).length, 1);

    // --- Row level security is enabled on every table touched ---------------
    const rls = (
      await db.query(
        `select relname, relrowsecurity from pg_class
         where relnamespace = 'public'::regnamespace and relname = any($1)`,
        [['print_jobs', 'orders', 'print_job_events', 'print_batch_requests', 'order_fulfillment_events']],
      )
    ).rows;
    assert.equal(rls.length, 5);
    for (const table of rls)
      assert.equal(table.relrowsecurity, true, `RLS must be enabled on ${table.relname}`);

    // --- Privileges -----------------------------------------------------------
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => create(randomUUID()), /permission denied/);
      await assert.rejects(() => db.query('select * from public.print_job_events'), /permission denied/);
      await assert.rejects(() => db.query('select * from public.print_batch_requests'), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal((await create(await (async () => { await db.exec('reset role'); const id = await order(); await db.exec('set role service_role'); return id; })())).ok, true);
    await db.exec('reset role');

    console.log(
      'Print attempt migration passed: legacy backfill, repeat application, one open attempt, device/shop binding, duplicate/out-of-order/late events, output confirmation, reprints, handover payment rule, retries, uncertainty pauses, undelivered failures, batch idempotency, concurrency and permissions.',
    );
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
