# PrintFlow security review — September 25, 2026

## Result and scope

**Update — October 5, 2026:** F01–F04 have been fixed locally, and C01 now has explicit proxy configuration with a safe direct-access default. The reproduction tests below have been converted into security regressions. The descriptions and September 25 results are retained as historical assessment evidence. See [the remediation and deployment notes](SECURITY_REMEDIATION_2026-10-05.md) for current validation and the required database migration. Production remediation has not been verified.

Four application flaws were reproduced locally: one high and three medium severity findings. A fifth, deployment-dependent rate-limit weakness was also reproduced under a directly reachable backend configuration.

This was a source-assisted local assessment, not a penetration test of the production deployment. Reviewed the backend authentication/authorization, order workflow, upload/conversion code, Supabase migrations, printer-agent code, customer/admin frontend authentication, and deployment configuration. No production accounts, database contents, storage objects, or printers were used. No production requests, credential attacks, destructive tests, or load tests were performed.

The executable evidence calls the real application services with synthetic database adapters. The socket test uses a real local Nest/Socket.IO server and a real signed JWT, with synthetic device records. The rate-limit test uses an isolated local Nest application with the project's actual throttler and proxy setting. These establish code behavior, not the configuration or reachability of the deployed environment.

Application code and `.env` were not changed. New files are this report, an isolated reproduction suite, and its Jest configuration. The earlier `SECURITY_AUDIT_REPORT.md` was preserved.

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| F01 | High | Shops can download students' unsubmitted draft documents | Service reproduction |
| F02 | Medium | Editing during submission can charge old pricing for new shop/options | Deterministic service race reproduction |
| F03 | Medium | Admin TOTP codes can be successfully reused | Real TOTP, two session records |
| F04 | Medium | Printer sockets remain authorized after JWT expiration | Real local socket and expired JWT |
| C01 | Medium if exposed | Direct API access allows spoofing the IP used for throttling | Local HTTP reproduction; deployment exposure unverified |

Severity reflects the demonstrated preconditions and impact; these are not unauthenticated remote-code-execution findings.

## F01 — Unsubmitted draft disclosure to shops

**Location:** `src/orders/orders.service.ts:233`, exposed by `GET /orders/shop` in `src/orders/orders.controller.ts:59`.

`getShopOrders` selects every order belonging to the authenticated shop, including `DRAFT`, and joins its assets. It then signs those assets for download. The customer workflow distinguishes saving a draft from submitting it. The shop frontend hides drafts from its visible queues, but the backend has already returned the private document links.

**Precondition:** A verified shop account, and a student draft currently assigned to that shop. This does not allow arbitrary access to another shop's orders.

**Reproduction:** A synthetic student draft was stored alongside another shop's order. Calling the real `getShopOrders` returned the assigned draft and invoked `createSignedStorageUrl('assets', draftPath, 300)`. The unrelated shop's row stayed excluded. See F01 in `test/security-review-20260925.spec.ts:64`.

**Impact:** A shop can retrieve document contents and filenames before a student submits the order, including drafts the student later cancels or moves to another shop. Hiding rows in React does not enforce confidentiality.

**Fix:** Exclude drafts in the backend query before loading or signing assets, preferably using an explicit allowlist of shop-visible states. Add a regression check that no draft data or download link is returned to shops. Keep draft access limited to the owning student.

## F02 — Draft submission races with editing and uses stale pricing

**Location:** `src/orders/orders.service.ts:381` and `src/orders/orders.service.ts:437`.

`submitDraft` reads the shop/options, fetches pricing, and awaits document processing. Its eventual update checks only order ID, owner, and `state = DRAFT`. While it waits, `updateDraft` can change the shop/options/price without changing the state. Submission then overwrites the price using its earlier snapshot, while preserving the newly edited shop and print options.

**Precondition:** A student controlling their own draft and sending overlapping `PATCH /orders/:id/submit` and `PATCH /orders/:id/update-draft` requests.

**Reproduction:** Pause submission after it reads a cheap shop's A4 black-and-white options. Edit the draft to an expensive shop with color printing, then resume submission. Both operations succeed. The result is `OPEN_INQUIRY`, the expensive shop, `COLOR`, and a total of **2** instead of **30**. The in-memory query adapter evaluates the actual service predicates and updates at execution time. See F02 at `test/security-review-20260925.spec.ts:81`.

**Impact:** Incorrect payable totals and potential underpayment. Payment remains subject to shop verification; this does not itself bypass payment approval. The reverse interleaving can also produce overcharging or other inconsistent order metadata.

**Fix:** Make submission and edits transactional against the same order row, or use a monotonically increasing order version that both operations compare and increment. Reject/retry if options changed after pricing was read. The committed price, shop, and options must come from the same snapshot. Checking only `state = DRAFT` is insufficient.

## F03 — Admin TOTP replay

**Location:** `src/admin/admin.service.ts:97` and `src/admin/admin.service.ts:134`; temporary-token handling in `src/iam/guards/admin-auth.guard.ts`.

Both 2FA paths verify a TOTP with `window: 1` and issue a new admin access session. Neither stores or atomically consumes the accepted time step. Temporary admin JWTs also have no server-side consumed challenge record. Clearing the browser's temporary cookie does not invalidate a retained copy of its token.

**Precondition:** A valid temporary admin token and an already accepted code that is still within the allowed TOTP time window. This does not remove the need for the password/temporary token and a valid second factor.

**Reproduction:** Generate a synthetic seed and a real TOTP. Call the real `verify2FA` twice with the identical code. Two different access tokens and two distinct session records are created. See F03 at `test/security-review-20260925.spec.ts:113`.

**Impact:** A captured authentication attempt can be replayed to obtain an independent session; logging out one session does not revoke that independently created session.

**Fix:** Record the last accepted TOTP time step per admin and update it atomically only when the new step is greater. Consume the login challenge atomically with access-session creation. Apply the same replay protection to setup and verification, and reject setup attempts once enrollment is complete. Cover sequential and concurrent replays.

RFC 6238 requires preventing a second successful use of an accepted OTP within its validity window. [RFC 6238, section 5.2](https://datatracker.ietf.org/doc/html/rfc6238#section-5.2)

## F04 — Printer WebSocket authorization outlives token expiration

**Location:** `src/edge/edge-daemon.gateway.ts:68`, `:113`, `:253`, and `:332`; 15-minute token lifetime in `src/daemon-devices/daemon-devices.module.ts`.

The gateway validates the token at connection time and stores the identity on `client.data`. Subsequent events only inspect that cached identity. No token-expiry disconnect or periodic authorization check is scheduled. A connection can continue reporting printer lists and job statuses after the JWT expires.

**Precondition:** Establish a socket connection while a valid device JWT is still usable. Keeping an established connection alive does not require possession of the long-term device secret.

**Reproduction:** Start the real gateway on loopback, authenticate with a real JWT configured to expire after two seconds, wait until JWT verification reports `jwt expired`, then send `daemon_printers_update`. The gateway accepts it, persists the synthetic printer list, and emits `printers_list`; token validation was called only once. See F04 at `test/security-review-20260925.spec.ts:128`. The shortened lifetime makes the same expiry boundary test quick; production tokens are configured for 15 minutes.

**Impact:** A stolen short-lived token can establish longer-lived access to the shop's printer channel. The current gateway can dispatch signed print-file links to that connection. Continued job-status manipulation is supported by the cached-identity path, though the reproduction only sends a harmless printer-list update.

**Fix:** Carry verified expiry into the connection identity and disconnect at expiration, requiring fresh authenticated reconnection. Recheck device existence/revocation and shop eligibility periodically or on sensitive operations. Coordinate revocation across instances if deployed with multiple replicas. The current registry does disconnect a revoked device on its own process; cross-instance revocation was not tested.

## C01 — IP throttling depends on a correctly enforced reverse-proxy boundary

**Location:** `src/main.ts:90` and `src/app.module.ts`.

The application unconditionally sets `trust proxy` to one hop and listens on all interfaces. The default throttler keys requests using `req.ip`. If the Node port is directly reachable, clients control the trusted `X-Forwarded-For` value.

**Reproduction:** An isolated local route using the actual throttler and the same proxy setting returns 200 for the first request from a claimed IP, 429 for the second, and 200 after changing only `X-Forwarded-For`. See C01 at `test/security-review-20260925.spec.ts:178`.

**Impact if exposed:** Attackers can evade IP-based login and upload limits and falsify source-IP audit records. This is **not a confirmed Render deployment vulnerability**: a correctly enforced proxy that supplies the actual client address can prevent the demonstrated bypass.

**Fix/verification:** Verify that the backend is reachable only through the intended proxy and that proxy header behavior matches the configured hop count. Disable proxy trust when running directly, or trust explicit proxy ranges where practical. Add account/challenge-specific limits to sensitive authentication flows. [Express proxy configuration guidance](https://expressjs.com/en/guide/behind-proxies/)

## Validation results

From `printflow-backend`, run:

```powershell
npx --no-install jest --config test/security-review.jest.json --runInBand
```

Result: **5/5 reproductions passed**. These tests intentionally assert vulnerable behavior; passing means the issue was reproduced, not that the app is secure. They are isolated from the normal test suite. Convert their expectations into rejection/privacy/integrity assertions when fixing the flaws.

Existing backend suite, `npm test -- --runInBand`: **139 passed, 1 failed, across 26 suites**. The unrelated failure is `src/app.controller.spec.ts:19`: expected `PrintFlow API`, received `prentflows neh doh`. No application files were edited during this assessment.

`npm audit --omit=dev --json`: **0 reported vulnerabilities** in backend, customer frontend, and admin frontend. This checks current package advisories for production dependencies; it does not cover custom application logic, development dependencies, the container OS, LibreOffice, or a previously deployed build.

The backend `.env` is ignored and is not tracked in the current Git index. A value-redacted check confirmed the three application secret/key lengths meet the existing 32-character startup minimum and the Supabase service-role key is present. Local `NODE_ENV` is not `production`. Secret entropy, credential validity, historical exposure, and production settings were not established; no secret values were printed or changed.

## Remaining verification and hardening

- Verify the deployed Supabase grants, RLS policies, storage privacy, and migration state. The repository contains restrictive migrations; their presence does not prove deployment.
- Verify effective frontend/API security headers and cookie behavior on the deployed origins. The repository contains configurations, but this assessment did not fetch production responses.
- Document conversion still runs in the API process or its child process, with no separate OS-enforced conversion sandbox. PDF parsing occurs before the page limit is checked, and DOCX limits inspect ZIP metadata. Existing limits are useful, but resource isolation and outbound network restriction remain worthwhile. No resource-exhaustion, converter exploit, or SSRF payload was attempted or proven here.

Prioritize F01 and F02, then F03 and F04. Confirm the C01 deployment boundary alongside those fixes, and repeat the tests against a staging system with dedicated test accounts before declaring the deployed application remediated.
