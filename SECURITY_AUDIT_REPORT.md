# PrintFlow Security Remediation Report

**Original review date:** September 17, 2026  
**Remediation update:** September 17, 2026  
**Scope:** Backend API, customer frontend, admin frontend, Supabase migrations,
Windows printer agent, upload and conversion pipeline, and Render configuration.

## Scope note

The deleted test administrator is excluded from this remediation report. The
repository is private and the test account no longer exists, as confirmed by the
project owner. No credential or account detail is reproduced here.

## Current status

| Finding | Status | Implemented control |
| --- | --- | --- |
| Vulnerable production dependencies | Resolved | Production packages and lockfiles were updated; the NestJS Multer dependency is pinned to the patched release. |
| Browser tokens in `localStorage` | Resolved | User and admin sessions now use Secure, HttpOnly cookies, credentialed requests, origin checks for unsafe requests, refresh rotation for user sessions, and logout endpoints. |
| Long-lived, non-revocable admin sessions | Resolved | Admin access tokens expire after 15 minutes and require an active hashed session record that can be revoked on logout. |
| Plaintext admin TOTP seeds | Resolved | TOTP seeds use AES-256-GCM with `TOTP_ENCRYPTION_KEY`. On the first backend startup after migration, existing plaintext seeds are encrypted and the plaintext values are cleared. |
| Upload and conversion resource exhaustion | Mitigated | Page, pixel, ZIP entry, expanded-size, output-size, timeout, queue, and concurrency limits are enforced. Encrypted, ZIP64, path-traversing, and suspiciously compressed DOCX packages are rejected. |
| LibreOffice running as root | Resolved | The production Docker image runs Node.js and LibreOffice as the unprivileged `node` user and terminates the full conversion process tree on timeout. |
| Missing response security headers | Resolved | Helmet protects API responses; both static applications define CSP, referrer, permissions, framing, and content-type policies. |
| High-privilege maintenance scripts | Mitigated | Maintenance utilities verify the target project, require explicit production authorization, and support safe dry runs for write-capable commands. |
| External AI processing of permits | Safe default implemented | AI review is disabled unless `ENABLE_AI_PERMIT_REVIEW=true`; manual review is the default and raw vendor failures are not stored. |
| Infrastructure errors returned to clients | Resolved | A global exception filter returns generic server errors with request IDs while retaining diagnostics in server logs. |
| Missing administrator audit trail | Resolved | Sensitive authenticated admin operations write actor, route/action, target, request ID, source IP, timestamp, and outcome to an append-only table. |

## Upload limits

The default PDF ceiling is intentionally lenient: **1,000 pages**. It can be
changed with `MAX_PDF_PAGES` without changing source code.

Other defaults are 75 million image pixels, 10,000 DOCX entries, 256 MiB total
expanded DOCX data, 128 MiB for one DOCX entry, 100 MiB normalized PDF output,
two active conversions, and 20 waiting conversions per backend instance.

These controls prevent common decompression-bomb and accidental overload cases.
The remaining defense-in-depth improvement is to move conversions to a separate
worker/container with platform-level CPU, memory, disk, and outbound-network
restrictions. That change requires a shared queue and an asynchronous order
workflow, so it is tracked as deployment architecture rather than silently
changing the current API contract.

## Required deployment steps

Apply these migrations before deploying the matching backend code:

```text
supabase/migrations/20260919_encrypt_admin_totp.sql
supabase/migrations/20260919_admin_sessions.sql
supabase/migrations/20260919_admin_audit_events.sql
```

Set a stable, random `TOTP_ENCRYPTION_KEY` of at least 32 characters on the
existing Render backend service. Do not rotate it without first re-encrypting
stored TOTP values. Keep `ENABLE_AI_PERMIT_REVIEW=false` unless the project's
privacy, consent, retention, and vendor requirements have been approved.

Redeploy the backend, customer frontend, and admin frontend together because the
authentication transport changed from JavaScript-readable bearer tokens to
cross-origin Secure cookies. `FRONTEND_URL` and `ADMIN_URL` must exactly match
the deployed HTTPS origins and must not include trailing slashes.

## Verification checklist

Local verification completed for this revision:

- Backend build passed.
- Backend test suite passed: 15 suites and 29 tests.
- Customer and admin production builds passed.
- Windows printer-agent 0.1.5 installer build passed.
- Full `npm audit` (including development dependencies) reported zero known
  vulnerabilities in all three applications.
- Admin lint and targeted lint for the newly added backend security modules
  passed.

The full customer-frontend and legacy-backend lint sets still contain existing
typing and React-hook cleanup work outside this security change. Those errors do
not prevent the production builds. Docker is not installed in the local
verification environment, so Render must perform the final container build.

Deployment verification still required:

- Apply all three new migrations before accepting admin logins.
- Confirm the Render backend uses the repository Dockerfile and starts as the
  `node` user.
- Confirm login responses set HttpOnly cookies and no access token appears in
  browser local storage.
- Confirm an admin logout immediately invalidates the previous access token.
- Confirm the first backend startup encrypts existing TOTP values, clears the
  plaintext column, and logs only the migrated record count.
- Confirm a 1,000-page PDF is accepted and a 1,001-page PDF is rejected.
- Confirm malformed, encrypted, oversized, or highly compressed DOCX packages
  are rejected before LibreOffice starts.
- Confirm production responses include the intended API and static-site headers.
- Confirm sensitive admin actions appear in `admin_audit_events`.
- Run builds, automated tests, and `npm audit --omit=dev` for all three apps.

## Remaining operational work

- Plan a dedicated conversion worker if upload volume or threat exposure grows.
- Use a shared rate-limit and conversion queue store before horizontally scaling
  the backend; the current concurrency queue is per instance.
- Define retention/deletion periods for permits and audit events.
- Document and rehearse rotation for `TOTP_ENCRYPTION_KEY`, `JWT_SECRET`, and
  `AGENT_JWT_SECRET`.
- Keep the base image, LibreOffice, Node.js, and npm dependencies patched.
