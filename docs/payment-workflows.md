# GCash and cash-on-pickup workflows

Payment method, shop acceptance, and payment status are independent of the order lifecycle. `IN_PRODUCTION` remains the existing production-authorized queue; agent reporting has not been redesigned.

## Deployment

1. Back up and review the target database through the normal deployment process.
2. Apply `20261106000000_payment_order_states.sql` and commit it before applying `20261106010000_separate_payment_workflows.sql`. New PostgreSQL enum values cannot be used before their transaction commits.
3. Deploy the backend, then the updated frontend and admin app. Older clients default to GCash when creating orders. Receipt-review and fulfillment clients must send the new evidence/confirmation fields; outdated review requests fail safely.
4. Check legacy orders marked `REVIEW_REQUIRED`. Active orders can submit replacement payment evidence without resetting production history. Inferred historical acceptance is labeled `LEGACY_INFERRED`, without inventing an actor or acceptance timestamp.

The implementation does not run these migrations automatically. No target database or production deployment is part of local validation.

If receipt submission and cancellation report an account-permission error, check `has_function_privilege('service_role', 'public.apply_order_decision(uuid,uuid,text,text,jsonb)', 'EXECUTE')`. A `false` result means the backend cannot call the transaction. Apply `20261107020000_payment_rpc_permissions.sql` through the normal migration process using the function owner (normally the Supabase SQL Editor's `postgres` role). This repeatable repair grants only the backend service role and keeps `PUBLIC`, `anon`, and `authenticated` excluded. Existing ownership and role checks remain enforced inside the function. Already-installed databases need only the repair migration; do not replay the original table-creation migration. Recheck for `service_role = true` and `authenticated = false`, then retry the actions.

## API

- Creation and draft editing accept `paymentMethod: GCASH | CASH_ON_PICKUP`. Draft submission optionally accepts the same field. Submitted orders lock the method.
- Student receipt upload requires an image and nonblank `referenceNumber` (maximum 120 characters).
- Shop `POST /orders/:id/verify-payment` requires `action`, `receiptId`, and `confirmed: true` for approval. Rejection requires `reason`. Only the current receipt is reviewed.
- Shop `POST /orders/:id/decision` accepts `action` from `ACCEPT`, `REJECT_ORDER`, `COLLECT_CASH`, `RECORD_REFUND`, `FLAG_UNCLAIMED`, or `CLEAR_UNCLAIMED`. Rejection/unclaimed require `reason`; collection requires `confirmed: true`; refund requires `confirmed: true` and `reference`.
- Shop `PATCH /orders/:id/state` accepts `READY_FOR_PICKUP` or `COMPLETED` and `confirmed: true`. Cash must be collected before handover. Downloading a document does not mark it ready.
- Admin dispute endpoints retain their existing URLs. Both require `receiptId`; approval requires `confirmed: true`, and upholding rejection requires `reason`. Admin payment verification never accepts an order for the shop.
- Decision responses include `message`, `state`, and authoritative `order` data. Actor identity comes from the authenticated request, never from the body.

GCash needs current proof before acceptance and verified funds before production. Cash can enter production after acceptance with payment due at pickup. Initial unpaid GCash orders retain the 15-minute deadline; rejected receipts receive 24 hours to retry. Review, disputes, accepted cash, and pickup orders do not expire on that timer.

Cancellation/rejection is limited to before production authorization. Submitted orders remain in history. Verified funds on a cancelled/rejected order become `REFUND_DUE`; recording a refund confirms a full transfer performed outside PrintFlow. Pending receipt review remains resolvable on a closed order and may create that refund obligation.

Unclaimed is a recoverable pickup flag, not cancellation or payment settlement. Collection and refund amounts come from the locked server-calculated total. Financial decisions are append-only and repeated collection/refund requests do not add another financial record.

## Validation

- `npm run test:payment-sql`: isolated PGlite migration and transition checks; no existing database.
- Targeted Jest order, payment, analytics, admin, and spooler tests.
- Existing security regressions and isolated security-migration checks.
- Frontend Node component tests, affected-repository builds, targeted ESLint/Prettier checks, and `git diff --check`.

Revenue includes `VERIFIED` GCash and `COLLECTED` cash. Refund obligations/refunds and uncertain historical payments are excluded. Outstanding balances include unsettled active orders, including unclaimed cash orders.
