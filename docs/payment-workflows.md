# GCash and cash-on-pickup workflows

Payment method, shop acceptance, and payment status are independent of the order lifecycle. `IN_PRODUCTION` remains the existing production-authorized queue; agent reporting has not been redesigned.

## Deployment

1. Back up and review the target database through the normal deployment process.
2. Apply `20261106000000_payment_order_states.sql` and commit it before applying `20261106010000_separate_payment_workflows.sql`. New PostgreSQL enum values cannot be used before their transaction commits.
3. Deploy the backend, then the updated frontend and admin app. Older clients default to GCash when creating orders. Receipt-review and fulfillment clients must send the new evidence/confirmation fields; outdated review requests fail safely.
4. Check legacy orders marked `REVIEW_REQUIRED`. Active orders can submit replacement payment evidence without resetting production history. Inferred historical acceptance is labeled `LEGACY_INFERRED`, without inventing an actor or acceptance timestamp.

The implementation does not run these migrations automatically. No target database or production deployment is part of local validation.

If receipt submission and cancellation report an account-permission error, check `has_function_privilege('service_role', 'public.apply_order_decision(uuid,uuid,text,text,jsonb)', 'EXECUTE')`. A `false` result means the backend cannot call the transaction. Apply `20261107020000_payment_rpc_permissions.sql` through the normal migration process using the function owner (normally the Supabase SQL Editor's `postgres` role). This repeatable repair grants only the backend service role and keeps `PUBLIC`, `anon`, and `authenticated` excluded. Existing ownership and role checks remain enforced inside the function. Already-installed databases need only the repair migration; do not replay the original table-creation migration. Recheck for `service_role = true` and `authenticated = false`, then retry the actions.

## Cash orders disappearing after 15 minutes

The backend before the separate-payment-workflows change ran a cleanup every
minute that deleted **all** `OPEN_INQUIRY` orders older than 15 minutes using
`created_at`, regardless of payment method or `expires_at`. Hiding a UI timer or
clearing `expires_at` does not stop that older worker. The current backend only
expires eligible GCash orders through `apply_order_decision`.

Apply `20261108000000_protect_cash_orders_from_expiry.sql` after the payment
workflow migrations through the normal database deployment process. It clears
cash deadlines, prevents new cash expiry transitions, and skips deletion of
submitted cash orders, including the old timed cleanup query. Draft deletion,
explicit cancellation/rejection, cash collection, and GCash deadlines remain
available. The migration can be reapplied safely.

Deploy/restart the current backend and stop any older backend replicas or
scheduled jobs using the old cleanup query. The repository alone cannot confirm
which version or database jobs are running in a deployment.

Already expired orders are not reopened, and deleted orders cannot be recovered
by this migration. Review affected records and backups before deciding on any
recovery. To distinguish expiry from queue filtering, inspect the order's
`state`, `payment_method`, `payment_status`, `expires_at`, and decision history in
the target database; do not infer expiry solely from a missing dashboard card.

## Order decision timeouts

### Accepted cash order still shows Awaiting payment

`ACCEPTED` alone does not prove the production transition completed. Print Ready
requires `IN_PRODUCTION`, eligible payment status, and an available document URL.
An `OPEN_INQUIRY` cash order with `ACCEPTED` and `DUE_AT_PICKUP` can be stranded
after an older/custom function saved acceptance without advancing the state.
Retrying `ACCEPT` returns immediately for an already accepted order, so replacing
the function bodies does not recover this existing row.

After the preceding repairs, review and apply
`20261108030000_recover_accepted_cash_production.sql`. It advances only explicitly
accepted cash inquiries with `DUE_AT_PICKUP`, a verified shop, and a valid PDF
reference to `IN_PRODUCTION`, including the legacy `AWAITING_PAYMENT` state.
The existing guard validates the transition. It
preserves acceptance fields (including a missing historical timestamp), payment
status, and decision history, and appends a `SYSTEM / RECOVER_PRODUCTION` event
with previous/new statuses. Reapplying it does not duplicate the event. Pending,
closed, inferred-acceptance, invalid-document, and GCash orders are excluded.

Refresh the dashboard after applying it. No cash collection is recorded: the
order remains due at pickup. If the state already is `IN_PRODUCTION`, check
document URL availability and queue filters instead of applying a state recovery.

### Verify deployed functions and active requests

If both repair migrations succeeded but decisions still time out, first run
`scripts/verify-payment-installation.sql` in the same target database **while
Accept is loading**. It returns all checks in one `check_name`/`result` table,
including active decisions and blocker metadata. This avoids SQL Editor hiding
earlier results when a script has multiple statements. It reports
function-body matches against the tested repository version, presence of both
guards, and the decision RPC's lock limit and backend execution privilege. Only
the decision RPC is expected to have the lock limit and direct backend execute
grant. A body mismatch can also reflect comment changes and requires review;
it is not proof of a defect or permission to overwrite deployed functions. This
check does not return function bodies or order data. The separate
`diagnose-order-decision.sql` is available for a more detailed activity snapshot.
Do not assume the
earlier migration was missing or increase timeouts without these results.

If `apply_order_decision` and/or `order_has_valid_asset` report a body mismatch,
review that drift against the checked-in definitions. The additive
`20261108020000_restore_payment_functions.sql` restores only these two tested
function bodies using `CREATE OR REPLACE`, keeps function identities/ownership
and dependent guards, reasserts service-role-only RPC access, and retains the
three-second lock limit. Apply it as the function owner after reviewing any
intentional deployed customizations. It does not update orders, reconcile
historical payments, or append decision records. Do not replay table creation.

After applying the function repair and subsequent payment migrations, rerun the
single-table verification: all
three `function.*.matches_repository` checks should read `true`, with
`decision.lock_timeout = 3s`. Refresh the order's authoritative status before
retrying acceptance, since earlier lost responses do not prove a rollback. A
source mismatch establishes a different body or comments; it does not by itself
prove the cause of a timeout. Continuing failures still need the live activity
and backend diagnostics investigated.

If the trigger inventory is missing `guard_order_payment_workflow`, apply
`20261108010000_restore_payment_guard.sql` using the function/table owner after
the preceding payment migrations. It restores the guard, initializes cash
drafts/inquiries still marked `UNPAID` and `PENDING` to `DUE_AT_PICKUP`, and limits
decision RPC lock waits to three seconds. It preserves accepted/closed orders
and existing decision history. Reapplying it is safe. A missing
`zz_guard_cash_order_expiry` also requires the preceding
`20261108000000_protect_cash_orders_from_expiry.sql`. Do not replay the original
table-creation migration against an existing installation.

The backend maps PostgreSQL `55P03` to HTTP 409 with refresh/retry guidance.
The function-scoped [lock timeout](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-LOCK-TIMEOUT)
aborts and rolls back a blocked decision rather than leaving it waiting until
the HTTP deadline. It does not terminate the blocking transaction or guarantee
that an unblocked request finishes within three seconds. Existing accepted cash
inquiries with inconsistent payment/production fields need individual review;
the repair does not invent missing acceptance or collection events.

`REQUEST_TIMEOUT`, `httpStatus=0`, and a duration near 15000 ms mean the backend
aborted the decision RPC before receiving a response. This does not prove the
transaction failed or identify a database lock. Refresh the order before
retrying; the backend does not automatically retry the write.

While a decision is still loading, run `scripts/diagnose-order-decision.sql` in
the target database's SQL Editor. It only reads activity and trigger metadata,
without printing SQL text or trigger arguments. A nonempty `blocking_pids`
identifies lock contention; inspect the blocker through the normal database
support process before taking action. An active decision with no blockers needs
its wait event and installed triggers investigated. No matching row can mean the
request did not reach PostgreSQL, completed before the snapshot, or the SQL
Editor's role cannot see it. It is not conclusive by itself. Do not bypass the
transaction or remove eligibility checks to work around a timeout.

The activity query excludes other SQL Editor diagnostics and parallel workers.
It uses wall-clock time instead of the transaction start timestamp to avoid
negative durations. A `transactionid` wait with an empty blocker list can be a
transient snapshot; it alone does not identify a persistent blocker.

## API

- Creation and draft editing accept `paymentMethod: GCASH | CASH_ON_PICKUP`. Draft submission optionally accepts the same field. Submitted orders lock the method.
- Student receipt upload requires an image and nonblank `referenceNumber` (maximum 120 characters).
- Shop `POST /orders/:id/verify-payment` requires `action`, `receiptId`, and `confirmed: true` for approval. Rejection requires `reason`. Only the current receipt is reviewed.
- Shop `POST /orders/:id/decision` accepts `action` from `ACCEPT`, `REJECT_ORDER`, `COLLECT_CASH`, `RECORD_REFUND`, `FLAG_UNCLAIMED`, or `CLEAR_UNCLAIMED`. Rejection requires `reason`; flagging unclaimed requires only the action and a `READY_FOR_PICKUP` order. Collection requires `confirmed: true` and atomically records `COLLECTED` payment and `COMPLETED` order status, clearing any unclaimed flag. Refund requires `confirmed: true` and `reference`.
- Shop `PATCH /orders/:id/state` accepts `READY_FOR_PICKUP` or `COMPLETED` and `confirmed: true`. GCash retains a separate handover confirmation. Cash collection completes the cash order without another handover step. Downloading a document does not mark it ready.
- Admin dispute endpoints retain their existing URLs. Both require `receiptId`; approval requires `confirmed: true`, and upholding rejection requires `reason`. GCash payment verification also authorizes production for an eligible order with a valid document, including administrator approval of a disputed receipt. Closed orders remain closed and create a refund obligation.
- Decision responses include `message`, `state`, and authoritative `order` data. Actor identity comes from the authenticated request, never from the body.

GCash uses one shop decision: verify the current receipt to authorize production, or reject it with a reason and request a replacement. There are no separate GCash Accept/Reject order controls; those API decisions are limited to cash orders. Cash can enter production after explicit acceptance with payment due at pickup. Initial unpaid GCash orders retain the 15-minute deadline; rejected receipts receive 24 hours to retry. Review, disputes, all cash orders (including those awaiting shop acceptance), and pickup orders do not expire on that timer.

Apply `20261108060000_authorize_gcash_on_verification.sql` after the preceding payment migrations before deploying the updated GCash controls. It replaces the decision function while preserving service-only execution, lock limits, cash completion on collection, reasonless unclaimed flags, and ownership/payment/document guards. Verification records `PAYMENT_VERIFIED` acceptance provenance in the same transaction. Active, already-verified GCash inquiries with a verified current receipt, verified shop, and valid document are advanced to production with an append-only `SYSTEM / AUTHORIZE_VERIFIED_GCASH` event. The recovery preserves existing payment evidence/timestamps, does not reopen closed orders or authorize pending receipts, and is safe to reapply. `scripts/verify-payment-installation.sql` checks this latest function body; older repair definitions will report a mismatch until this migration is applied.

Apply `20261108050000_complete_cash_on_collection.sql` after the preceding payment
migrations before using the combined cash collection/completion flow. It updates
only the cash-collection branch of the decision function and completes existing
eligible `READY_FOR_PICKUP / COLLECTED` cash orders. Existing collection
timestamps and financial audit records remain intact; a separate
`SYSTEM / COMPLETE_CASH_PICKUP` event records that recovery without another
collection amount. Reapplying the migration does not duplicate the event. The
cash-collection confirmation explains that recording full payment also completes
the order; there is no separate cash Confirm handover button. Ownership,
confirmation, acceptance, document and full-payment checks still apply.

Cancellation/rejection is limited to before production authorization. Submitted orders remain in history. Verified funds on a cancelled/rejected order become `REFUND_DUE`; recording a refund confirms a full transfer performed outside PrintFlow. Pending receipt review remains resolvable on a closed order and may create that refund obligation.

Unclaimed is a recoverable pickup flag, not cancellation or payment settlement. The shop's Flag unclaimed button submits immediately without a reason or extra confirmation. Apply `20261108040000_optional_unclaimed_reason.sql` after the preceding payment repairs before using the updated frontend; earlier database functions reject reasonless flags. The migration replaces only the decision function and retains ownership/role checks, service-only permissions, lock timeout, and all other transition rules. It does not rewrite existing flags or audit history. An optional reason from an older client remains supported. Repeated flagging preserves the timestamp and does not add another audit record; clearing and flagging again creates a new flag event.

Collection and refund amounts come from the locked server-calculated total. Financial decisions are append-only and repeated collection/refund requests do not add another financial record.

## Validation

- `npm run test:payment-sql`: isolated PGlite migration and transition checks; no existing database.
- Targeted Jest order, payment, analytics, admin, and spooler tests.
- Existing security regressions and isolated security-migration checks.
- Frontend Node component tests, affected-repository builds, targeted ESLint/Prettier checks, and `git diff --check`.

Revenue includes `VERIFIED` GCash and `COLLECTED` cash. Refund obligations/refunds and uncertain historical payments are excluded. Outstanding balances include unsettled active orders, including unclaimed cash orders.
