# Merged payment and fulfillment repair

## Inspect the target before deployment

Run `scripts/verify-merged-workflows.sql` in Supabase SQL Editor. It contains
read-only queries and returns migration versions/names, columns, function
fingerprints and permissions, triggers, RLS flags, and aggregate repair counts.
No target database was accessed or changed during this repair.

Check **both names and versions**. Versions `20261108000000` and
`20261108010000` must represent `print_attempts_and_fulfillment` and
`print_attempt_revision_ref`. Earlier cash repairs used those same versions;
their current filenames use `20261108011000` and `20261108012000`.
If the target recorded the earlier cash names under the print versions, stop
the migration rollout and reconcile its actual objects and migration ledger
through the normal reviewed database process. Do not blindly mark migrations
applied, rename history, or replay the initial payment migration.

## Apply only the missing forward migrations

After history and prerequisite objects agree, deploy missing migrations in
order through `20261108070000_integrate_payment_print_fulfillment.sql`, then
`20261108080000_repair_merged_payment_verification.sql`. The new repair replaces
the payment function only; it does not rewrite historical orders, receipts,
financial audit entries, or earlier migration files.

Run `scripts/verify-payment-installation.sql` afterward. Function source matches
should be true, the backend must have execute permission, browser roles must
remain excluded, and the two order guards must be enabled. A fingerprint
mismatch requires inspection, not automatic replacement of deployed code.

Deploy the backend before the frontend/admin applications. Active GCash payment
verification now waits for a verified shop and a valid stored PDF. Missing or
corrupt PDF bytes are rejected by both shop and admin services before calling
the transactional function. The database rechecks shop and document metadata.
Closed-order verification still creates a refund obligation without reopening
production or requiring a printable document.

For previously stranded `VERIFIED`/`PENDING` GCash inquiries, restore document
and shop eligibility, open Review Order, and select **Retry production
authorization**. The same current verified receipt is required. Recovery keeps
the original payment timestamp/evidence and adds one authorization audit entry;
repeating that recovery does not collect or verify money again.

All Orders provides review access for closed receipts and manual refunds.
Cash collection remains one combined collection-and-handover transaction after
output confirmation, with no unresolved print attempt and no cash expiry timer.

## Local validation

- Backend: `npm run build`, targeted Jest payment/analytics/fulfillment tests,
  `npm run test:payment-sql`, `npm run test:print-sql`, `npm run test:merged-sql`.
- Frontend: `npm run build` and `npm test`.
- Admin: `npm run build` and `npm test`.

SQL suites create disposable in-memory PGlite databases; they never connect
to Supabase. The combined suite applies all actual November migrations and
covers cash/GCash agent and manual flows, output checks, reprints, unclaimed
clearing, duplicate decisions, audits, recovery, refunds, and RPC permissions.
It complements service tests for actual PDF validation and receipt cleanup.

Before release, smoke-test one cash and one GCash order on a test printer,
including physical output inspection and handover. Automated tests cannot
confirm printer output; no physical-printer validation was performed here.
