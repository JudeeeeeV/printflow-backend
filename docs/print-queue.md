# Shop queue and reviewed batches

The frontend uses three live sections: New Orders, Print Ready, and Pickup.
The existing `/shop-dashboard/archived` route is Order History. Financial
follow-up stays in New Orders even if the order lifecycle is closed. Printer
submission and manual downloads never establish physical output or handover.

## Installation and compatibility

Apply the existing payment, document, fulfillment, and operation migrations in
filename order, followed by:

`20261109020000_shop_queue_and_batch_review.sql`

This is an additive migration. It introduces internal service-role-only queue
functions, an RLS-protected review table, and an atomic batch-claim function.
It does not apply itself through deployment. Local SQL tests use disposable
PGlite databases and do not prove installation on a target Supabase project.

Deploy backend support and this migration before the new frontend. The legacy
`GET /orders/shop` contract is unchanged. Initial print and manual-production
requests now require a review token and client request ID; older clients receive
an explicit review-required error. Existing per-attempt retry/reprint,
uncertainty, output-confirmation, and handover endpoints are unchanged.

## Contracts

- `GET /orders/shop/queue`: section (`new`, `ready`, `pickup`, `history`), search,
  paperSize, colorMode, paymentMethod, status, dateFrom/dateTo, sort, page,
  pageSize (1–25), selectableOnly, excludeIds, and onlyIds (at most 25 UUIDs).
  Returns `data`, `meta`, and unfiltered `counts`. History requests use 20 rows.
- `GET /orders/shop/selection?onlyIds=…`: fresh, bounded selection metadata.
- `GET /orders/shop/:orderId`: shop-owned details with fresh signed URLs,
  receipts, decisions, current attempt, and current eligibility from one database snapshot.
- `POST /edge/batch-preview`: `{ orders: [{ orderId, fingerprint }], mode,
  printerName? }`. Returns every row in selected order, blockers, totals, and
  an opaque review token valid for ten minutes when all rows are eligible.
  Preview can prepare private content-addressed files but creates no attempts
  and sends no print commands.
- `POST /edge/batch-execute` and `/edge/manual-production`: `{ orderIds,
  reviewToken, requestId, printerName? }`. Mode, printer/device, sequence,
  fingerprints, and file checksums must match the review.
- `GET /edge/batches/:requestId`: `PROCESSING`, `FAILED`, or `ACCEPTED`, with
  recorded attempts and fresh manual download links where applicable.

Queue summaries omit source paths, pinned files and signed preview URLs.
Fingerprints identify reviewed data; they are not document revision IDs.
Submitted file replacement remains excluded. Dates and filters use Asia/Manila.
`created_at` is labeled Created. History uses closure evidence, with a labeled
Created fallback when legacy evidence is absent.

## Failure and concurrency behavior

Selection allows up to 25 orders and exactly one paper size. Preview validates
hidden selections. Execution checks actual bytes, locks orders in ID order, and
uses one transaction to create every attempt or none. Delivery follows selected
order, independent of lock order. Per-order database payment guards still run.

An accepted batch can subsequently fail at the agent. Those failures use the
existing Priority #4 recovery dialogs. Accepted attempts are never recreated to
recover a lost response. The browser stores the pending request in session
storage scoped to the shop; reload restores recovery. An absent outcome allows
an explicit retry with the original token and request ID. It never silently
creates a new request. Conflicts require refreshed review.

Recovery releases requests left pending for 15 minutes only when no attempts were
claimed. It locks the request so an old worker cannot claim after the release.
Accepted requests are preserved. Manual file-link failures retain the accepted
outcome and return `downloadErrors`; Retry manual downloads recovers links using
the same request ID without creating attempts.

## Validation commands

```text
npm run test:queue-sql
npm run test:payment-sql
npm run test:print-sql
npm run test:merged-sql
npm run test:security
npm run test:security-sql
npm test -- --runInBand --silent
npm run build
node scripts/smoke-shop-queue.cjs
```

Run the frontend test suite and build in its own repository. Check changed files
with ESLint without automatic fixes, then run `git diff --check`. The existing
frontend merge remains uncommitted. Its three conflict resolutions were staged
at the repository owner's request; other changes and new files still need to
be included when preparing the eventual commit.

## Local HTTP smoke test — 2026-11-09

`node scripts/smoke-shop-queue.cjs` passed nine scenarios using the compiled
controllers, services, guards, DTO validation and actual SQL migrations. It
opens a temporary loopback HTTP server and uses a disposable PGlite database.
Auth responses, storage transport and the agent connection are simulated;
PDF preparation, database transitions and request handling run through the
application code. The script reads no `.env` and contacts no external service.

Covered authentication/roles, shop ownership, search/counts/pagination, Manila
dates, cash acceptance, GCash verification, batch review and pinned downloads,
request replay/recovery, inspection/pickup/History, competing claims, batch
limits, late payment/refund follow-up, explicit printer selection, simulated
agent submission, lost responses and abandoned request recovery.

Additional smoke checks passed: frontend HTML delivery on three routes and
eight source modules; 75 queue/payment/dialog component regressions; 20 agent
printer-option and durable-journal regressions. Temporary servers were closed.

Browser access still reports `The browser access host is unavailable`.
Visual layouts, real browser interaction, deployed Supabase auth/storage and
physical printer output were not exercised. The configured Supabase database
is remote, so the normal backend with scheduled jobs was not started and no
migrations or order changes were made there.
