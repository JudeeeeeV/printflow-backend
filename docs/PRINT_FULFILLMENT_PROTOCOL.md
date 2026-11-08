# Print attempts, agent protocol, and confirmed fulfillment

Implements Refactoring Priority #4. Printing is reported as **submission status
only**: a successful return from the print utility means the job was handed to
Windows, not that paper came out. An operator confirms output before an order is
ready, and records handover before it is completed.

## Records

| Table | Purpose |
|---|---|
| `print_jobs` | One row per **attempt** (`attempt_id`). Initial dispatch, retry, reprint and manual production each create a new attempt. At most one unresolved attempt per order (`resolved_at is null`). |
| `print_job_events` | Append-only history of agent, operator, server and migration events per attempt. Agent events are unique per `(attempt_id, agent_sequence)`. |
| `print_batch_requests` | Idempotency for batch dispatch and manual production, bound to a SHA-256 of the reviewed contents. |
| `order_fulfillment_events` | Output confirmations, readiness invalidations, handovers, reconciliation notes. |
| `orders.output_confirmed_*`, `orders.handed_over_*` | Current fulfillment milestones. |

RLS is enabled on every table; only the backend's service role has access. All
transitions run in `security definer` functions with row locks:
`print_create_attempt`, `print_record_agent_event`, `print_authorize_attempt`,
`print_mark_undelivered`, `print_confirm_output`, `print_record_handover`,
`print_record_reconciliation_note`, `print_begin/complete_batch_request`.
`order_payment_settled` is the single handover payment rule (verified receipt
today; Priority #1's cash collection extends it).

## Attempt status

| Status | Meaning |
|---|---|
| `QUEUED` | Recorded by the server for delivery |
| `RECEIVED` | The assigned agent durably journaled the command |
| `DOWNLOADING` | Agent is downloading and validating the pinned PDF |
| `SUBMITTING` | Agent persisted invocation intent and entered the print utility |
| `SUBMITTED` | Print utility returned; physical output unconfirmed |
| `FAILED_PRE_SUBMISSION` | Known failure before the print utility was invoked |
| `OUTCOME_UNKNOWN` | Invocation may have printed (error, timeout, crash) |
| `MANUAL_STARTED` | Operator started the reviewed manual fallback |

Resolution (`resolution`): `SUPERSEDED` (by a retry/reprint), `OUTPUT_CONFIRMED`,
`LEGACY_CLOSED`. Agent events never change `orders`; a late event for a resolved
attempt is recorded as `IGNORED_RESOLVED` and changes nothing.

Order state stays `IN_PRODUCTION` until output confirmation sets
`READY_FOR_PICKUP`; handover sets `COMPLETED`. Legacy `PRINTED` orders read as
"awaiting output confirmation"; nothing produces `PRINTED` any more.

## Socket protocol (namespace `/daemon`, version 2)

Handshake `auth`: `{ token, agentVersion, protocolVersion: 2, capabilities: ['attempt-reporting-v1'] }`.
Agents without it (or without a registered device identity) are shown as
**Agent update required**, receive no automated dispatches, and their legacy
`job_status_update` callbacks are acknowledged with `{ ack: false, code: 'AGENT_UPDATE_REQUIRED' }`
and otherwise ignored.

Server → agent `print_attempts`:

```json
{
  "protocolVersion": 2,
  "redelivery": true,
  "commands": [{
    "attemptId": "uuid", "orderId": "uuid", "revisionId": "assets path",
    "deviceId": "uuid", "printerName": "Desk",
    "settings": { "colorMode": "COLOR", "paperSize": "A4", "orientation": "PORTRAIT", "copies": 2 },
    "file": { "url": "signed, 1 hour", "sha256": "hex", "size": 12345 }
  }]
}
```

Commands go only to the assigned device. On every authenticated reconnect the
server redelivers that device's open attempts in `QUEUED`/`RECEIVED`/`DOWNLOADING`
with fresh signed URLs; the agent's journal makes redelivery safe.

Agent → server (all with acknowledgement callbacks):

| Event | Payload | Ack |
|---|---|---|
| `attempt_event` | `{ attemptId, orderId, sequence, status, failurePhase?, errorCode?, errorMessage?, occurredAt }` | `{ ack: true, result }` only after persistence (`APPLIED`, `DUPLICATE`, `IGNORED_*`); `{ ack: false, retry: true }` if not persisted; `{ ack: false, retry: false, code }` if rejected (wrong device or shop, unknown attempt) |
| `attempt_authorize` | `{ attemptId }` | `{ authorized: true }` or `{ authorized: false, reason }`: `SUPERSEDED`, `INVALID_STATE`, `ORDER_NOT_PRINTABLE`, `WRONG_DEVICE`, `DEVICE_PAUSED`, `UNAVAILABLE` |
| `attempt_reconcile` | `{ attemptIds }` | `{ attempts: [{ attemptId, status, open, resolution }] }` |
| `daemon_heartbeat` | `{ agentVersion, waitingAttemptIds }` | refreshes `agent_seen_at`, so queued work is not mistaken for stalled work |

Sequences increase per attempt. Events with a sequence at or below the last
applied one are recorded but not applied. A `FAILED_PRE_SUBMISSION` arriving after
`SUBMITTING` is applied as `OUTCOME_UNKNOWN`.

Server → dashboards `job_progress`: the persisted attempt (`attemptId`, `orderId`,
`attemptNumber`, `status`, `printerName`, `deviceId`, `errorCode`, `errorMessage`,
`updatedAt`, `isStale`, …). Dashboards also load attempts from `GET /orders/shop`
(`current_attempt`), so progress survives reloads.

## Agent journal

`%APPDATA%\PrintFlow Agent\journal\attempts\<attemptId>.json`, next to (not inside)
`credentials.dat` and outside the installation directory that upgrades replace.
Uninstalling removes it with the rest of the application data. Writes are atomic
(temp file, fsync, rename). Records hold the attempt phase and unacknowledged
events only: never credentials, signed URLs or document bytes.

1. Persist receipt (`RECEIVED`) before reporting it; if that fails, the command is
   not acknowledged and the server redelivers it.
2. Download, check size and SHA-256 against the pinned file, check printer.
3. `attempt_authorize` immediately before printing.
4. Persist intent (`INVOKING` + `SUBMITTING` event) in one write. If that fails,
   stop with `FAILED_PRE_SUBMISSION` / `JOURNAL_WRITE_FAILED`.
5. Invoke. Return → `SUBMITTED`. Error → `OUTCOME_UNKNOWN`. No return within 5 minutes →
   `OUTCOME_UNKNOWN` / `INVOCATION_TIMEOUT`, and the agent's queue stays paused
   until the call settles.
6. On restart, `INVOKING` becomes `OUTCOME_UNKNOWN` / `AGENT_RESTARTED` and is
   never printed again; unacknowledged events are replayed.

Retries are automatic for **delivery** only. Records belonging to another device
identity (after re-registration) are never executed or reported.

## HTTP API (shop roles)

| Method | Path | Body |
|---|---|---|
| POST | `/edge/batch-execute` | `{ orderIds, printerName?, requestId }` |
| POST | `/edge/manual-production` | `{ orderIds, requestId }` → attempts + fresh `downloads` |
| GET | `/edge/orders/:orderId/attempts` | attempts, events, fulfillment history |
| POST | `/edge/attempts/:attemptId/retry` | `{ mode: 'AGENT'\|'MANUAL', printerName?, reason?, queueCleared? }` |
| POST | `/edge/attempts/:attemptId/still-uncertain` | `{ reason }` |
| POST | `/edge/orders/:orderId/reprint` | `{ expectedAttemptId, mode, printerName?, reason, confirmFullJob: true }` |
| PATCH | `/orders/:id/state` | `{ state: 'READY_FOR_PICKUP', expectedAttemptId, confirmed: true, checks: {document, revision, paper, color, orientation, pages, copies}, reconciliationReason? }` or `{ state: 'COMPLETED', expectedAttemptId, confirmed: true }` |

Repeating a `requestId` with the same contents returns the recorded outcome
(including a recorded failure); the same ID with different contents is a 409.

### Recovery rules

- **Known pre-submission failure:** Retry, with the same pinned file, revision and
  settings. Printer can be changed.
- **Outcome unknown, or stalled for 10 minutes** (no progress and no heartbeat):
  inspect the output and the Windows print queue, then either
  - confirm output (with a reconciliation reason), or
  - retry with `queueCleared: true` and a reason, or
  - record "still uncertain" and leave the order blocked.
- A timeout never fails an attempt or authorizes reprinting by itself.
- An uncertain attempt pauses its agent (`DEVICE_PAUSED`) until resolved.
- **Reprint:** full job only, before handover, with a reason. Readiness is
  invalidated, earlier confirmations stay in history, and the order, price and
  payments are unchanged.

## Migration and rollout

`supabase/migrations/20261108000000_print_attempts_and_fulfillment.sql` is
additive and repeatable. Legacy `COMPLETED` → `SUBMITTED` (submission evidence
only); legacy `QUEUED`/`DOWNLOADING`/`SENT_TO_SPOOLER`/`FAILED` → `OUTCOME_UNKNOWN`.
Each original value is kept in `legacy_status`. The latest attempt of an active
order stays open for operator reconciliation; historical completed orders are untouched.

Order: database → backend → frontend → agent. The migration keeps inserts from an
older backend working (defaults and an attempt-number trigger). Do not re-run the
older `20260924020000_print_jobs.sql` after this migration: it recreates the
retired `status <> 'FAILED'` index. Never delete attempt records on rollback.

Tests: `npm run test:print-sql`, `npm run test:agent`, `npx jest src/edge src/orders`.
Real submission behaviour must be validated separately on a designated Windows
computer and printer; automated tests use mocks only.
