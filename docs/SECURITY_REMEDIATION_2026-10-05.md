# Security remediation — October 5, 2026

The four locally reproduced application findings from the September 25 review are fixed in the source changes. Proxy trust is configurable, with direct deployments defaulting to no trust. These notes describe local validation; applying the live database migration and verifying production remediation remain required.

| Finding | Implemented protection |
| --- | --- |
| F01: draft disclosure | The database excludes `DRAFT`, and the application allows only submitted order states before signing or returning assets. The allowlist stays outside the enum predicate so older deployed schemas can load the queue. Student draft access still checks ownership. |
| F02: stale draft pricing | Both draft editing and submission compare `draft_version`. A database trigger increments it on every order update, including edits that restore earlier values. A conflict returns HTTP 409 instead of submitting a stale price. |
| F03: administrator OTP replay | Password login creates a hashed, expiring challenge. Database RPCs cap challenge attempts at five and atomically consume the challenge and a monotonically increasing OTP step while creating the access session. Enrollment cannot overwrite enabled 2FA. Public database roles cannot invoke the RPCs. |
| F04: expired printer connections | Verified token expiry is carried into the socket identity. A timer disconnects the socket at expiry, and event/dispatch checks also reject expired identities. Device credentials and shop verification are rechecked every 30 seconds without overlapping database checks. Disconnect/shutdown clears the timers. |
| C01: deployment-dependent IP spoofing | `TRUST_PROXY=false` is the default. Explicit hop counts or proxy IP/CIDR lists are validated. The Render blueprint preserves the existing one-hop setting explicitly. Its ingress boundary must be verified for the actual deployment. |

## Deployment order

1. Confirm the existing `20260919_admin_sessions.sql` and `20260919_encrypt_admin_totp.sql` migrations are applied to the target database.
2. Apply `supabase/migrations/20261005000000_security_remediation.sql` through the project's usual Supabase migration process. The migration is transactional and rerunnable. It adds `orders.draft_version`, its increment trigger, `admins.last_totp_step`, private login challenge records, and service-role-only authentication RPCs. It does not delete existing orders or administrator accounts.
3. Set the backend's `TRUST_PROXY` to match the actual network boundary. Keep `false` for direct connections. The blueprint uses `1` for the existing Render configuration; verify the service cannot be reached by bypassing the intended ingress and that forwarded headers yield the real client IP. Use explicit proxy ranges where practical. Do not set unrestricted `true`. See [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/).
4. Deploy the updated backend after the migration completes. Replace all old backend instances together: old instances do not enforce the new challenge/OTP protections. Administrator logins already at the temporary-token stage need to start again; older temporary tokens lack the new challenge ID. Existing access sessions remain subject to their normal database and JWT expiry checks.
5. Verify in staging with dedicated accounts: no draft appears in the shop response; overlapping draft edit/submission produces a conflict; an OTP/challenge cannot issue another session; a printer reconnects after token expiry; device revocation disconnects within the next successful check. The native agent already refreshes its token and reconnects after a server disconnect.

Missing migration columns/functions cause affected operations to fail closed. They must be applied before deployment to avoid interrupting draft updates and administrator sign-in. The database migration alone does not protect an older backend release.

## Local validation

- `npm test -- --runInBand`: 210 tests passed across 32 suites, including filtering unknown/private states before signing assets.
- `npm run test:security`: five security regressions passed, including real local sockets and a real short-lived JWT. The previous reproduction assertions now check rejection/privacy/integrity.
- `npm run test:security-sql`: passed on a local PostgreSQL engine (PGlite). Covers an older order-state enum, migration idempotency, version conflicts, OTP/challenge replay, enrollment, attempt limits, expiry, competing completion statements, transaction rollback, and database permissions. This is not a multi-instance production load test.
- `npm run build`: passed.
- Live registry audit: the backend has zero reported dependency vulnerabilities. A user-provided frontend audit exposed that the earlier sandbox-only audits returned empty cached results. Live audits confirmed seven frontend and five admin findings from unpatched `braces` dependencies. Both browser apps now use Tailwind 4.3.3 with its PostCSS plugin, removing Tailwind 3 and the unused frontend CLI and their vulnerable dependency chains. Installation audits now report zero vulnerabilities in both apps as well. Their production builds pass, and all 63 frontend tests pass.
- The Tailwind migration retains the existing JavaScript Carbon theme and adds compatibility defaults for borders, placeholders, focus outlines, shadows, blur, and button cursors. CSS modules reference the theme for `@apply`. Tailwind 4 targets modern browsers; see its [upgrade guide](https://tailwindcss.com/docs/upgrade-guide). The reported `braces` advisory has [no patched release](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), so upgrading the dependency consumers removes the affected packages rather than hiding the advisory.

The existing API root greeting was corrected to `PrintFlow API`, resolving the pre-existing root-controller test failure. No real accounts, production database, printer jobs, or secrets were used in the regression checks.

## Remaining deployment verification

Confirm live migration state, Supabase RLS/grants, storage privacy, effective security headers/cookies, and the proxy boundary. Package audits do not assess container OS/LibreOffice vulnerabilities or custom application logic. Document conversion process isolation remains a hardening opportunity from the original review; no converter exploit was established or claimed fixed here. This local remediation does not certify the currently deployed site.
