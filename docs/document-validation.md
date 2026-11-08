# Order preparation: file validation and recovery

Priority #2 covers Create New Order and draft editing/submission. It does not introduce submitted-order corrections, source versions, payment adjustments, or printer workflow changes.

## Local checks and definitive validation

Both student forms use `src/services/documentPreparation.ts` in the frontend. Selection checks the supported extension/MIME pair, non-empty content, the existing 20 MB limit (20 * 1024 * 1024 bytes), PDF page readability, and image decoding. Supported formats remain PDF, DOCX, PNG, JPG/JPEG, and WEBP. Empty or generic browser MIME values are resolved from a supported extension without changing the source name or modification time.

These checks do not certify print quality, DPI, or complete document validity. DOCX conversion and definitive page counting happen on the server when the student submits or saves the upload. There is no preflight upload or simulated validation delay. A preview and a local pass do not bypass server validation.

`POST /orders` retains its existing multipart fields and success response. Its document interceptor enforces MIME and size limits. `OrdersService.createOrder` checks signatures, normalizes the document, and calculates its price before inserting an order or asset. The existing PDF page, image pixel, DOCX archive, normalized-output, conversion timeout, and concurrency limits remain in force. Temporary converter unavailability and queue overload are service failures, not evidence of a damaged file.

Updating or submitting a saved draft reads and checks its stored normalized PDF before changing it. Missing, inaccessible, or legacy non-PDF assets require a replacement. Ownership, draft-version filters, submitted-order locks, private storage, and payment/fulfillment checks remain in place.

## Additive error contract

Document failures add `code`, `field: "file"`, `message`, and `nextStep` to the existing HTTP error response. `statusCode` and `requestId` remain present. Authentication, shop availability, pricing, conflicts, and unrelated upload consumers retain their own error handling.

| Code | HTTP status | Student recovery |
| --- | --- | --- |
| `UNSUPPORTED_FILE` | 400 | Export/select a supported format. |
| `EMPTY_FILE` | 400 | Select a file containing actual data. |
| `FILE_TOO_LARGE` | 413 | Reduce the upload below the 20 MB limit. |
| `UNREADABLE_FILE` | 400 | Re-export or replace the document; unlock only when protection was detected. |
| `FILE_LIMIT_EXCEEDED` | 413 | Reduce the applicable page, dimension, archive, or output size limit. |
| `CONVERSION_UNAVAILABLE` | 503 | Retain the file/settings and explicitly retry, or export a PDF. |
| `UPLOAD_FAILED` | 503 | Check My Orders/Drafts before retrying; creation may be incomplete. |
| `DRAFT_FILE_UNAVAILABLE` | 400 | Remove the unavailable draft file and upload a replacement. |

Responses use fixed public messages and strictly recognized numeric processing limits. The exception filter permits only the dedicated safe document exception through for service failures. It continues hiding arbitrary server errors. No raw storage paths, commands, parser output, or upstream response text is copied into document feedback. PDF protection detection supports the installed library's Error-subclass behavior without enabling `ignoreEncryption`.

## Interface and retry boundaries

- Persistent file feedback appears next to the upload/preview controls and receives focus. Local checks expose a status message while running. Replacement and removal invalidate readiness; late results from earlier selections or an unmounted form are ignored. Temporary image/preview URLs are released.
- A file validation failure blocks submission and offers another selection. A temporary conversion failure keeps the selected file, preview, name, shop, and print settings; **Try again** explicitly repeats the last submit/save action.
- Network/unknown server failures show an unconfirmed-outcome warning with a route to check existing records. That recovery action clears the existing API response cache before navigation so the check fetches current records. Creation is not automatically replayed after those failures.
- Replacement draft uploads retain the existing create-new-record-then-delete-old-draft workflow. If creation succeeds and old-draft cleanup fails, the editor directs the student to the created order or saved drafts and blocks another replacement creation in that editor session.
- Removing or rejecting a replacement in the editor does not delete the original saved draft. The unused client `validateAsset` method and response type were removed; `/validation/asset` is not an endpoint.

## Known reliability limits

Order creation, object upload, and asset linkage are still separate operations. Storage failure after the order insert can leave an incomplete record; there is no rollback, new transaction, or exactly-once guarantee in this increment. A lost response may also hide a successful creation. Students must check existing orders/drafts before manually retrying. The editor's pending/created guards prevent duplicate callbacks locally, not duplicates across browsers, reloads, or separate sessions.

## Validation record - 2026-11-09

- Backend: 207 tests in the focused `common`/`orders` Jest suites; five existing security regression tests; backend build passed.
- Frontend: all 204 tests passed through `npm test`; production build passed with the existing large-chunk advisory.
- Existing payment and merged-workflow SQL regression scripts passed using disposable in-memory PGlite databases and synthetic records. No existing database was accessed or migrated.
- New validation/error modules and new tests pass targeted ESLint. Comparing affected existing files with `HEAD` found existing lint debt in `orders.controller.ts`, `orders.service.ts`, `NewOrderPage.tsx`, and `orderService.ts`; lint is not globally clean. No new lint findings were added.
- Isolated headless Edge checks at 1440 px and 375 px exercised local rejection, server rejection, temporary conversion failure, interrupted submission, stored-draft rejection, and replacement recovery. Alert focus, keyboard access to retry, retained draft copy settings, retained previews, no automatic network replay, and no document horizontal overflow were checked. Phone and desktop screenshots were inspected. All external page requests were intercepted; these were mocked browser checks, not live-service acceptance tests or screen-reader tests.
- Follow-up testing with students, real deployed storage/conversion, assistive technology, and real interrupted network connections remains outstanding. No deployment or measured usability improvement is claimed.
