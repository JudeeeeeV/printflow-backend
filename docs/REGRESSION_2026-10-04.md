# Regression results — October 4, 2026

No regression from the client-name, account-settings, or operator-loading changes was found in the checks below. The overall backend suite is not fully green: one unrelated greeting test already disagrees with the committed implementation.

| Check | Result |
| --- | --- |
| Entire backend Jest suite, `npm test -- --runInBand` | 164 passed, 1 failed across 28 suites |
| Entire frontend suite, `npm test` | 27 passed, including 13 new email/auth regression tests |
| Client-name migration, including upgrade from the existing confirmation trigger | Passed |
| Legacy signup/OTP SQL checks | Passed after correcting a stale test limit |
| Shop-photo migration checks | Passed |
| Shop-location migration checks | Passed |
| Print-job migration checks | Passed |

## Email and SMTP coverage

The application currently sends signup, resend, and recovery requests through Supabase Auth. The frontend regression tests exercise the installed Supabase SDK with HTTP intercepted locally. They check:

- Student and shop registration still issue signup requests with the original email/password plus correctly normalized name and shop metadata.
- Signup does not establish a session while confirmation is pending.
- Missing or oversized names fail before signup or email is requested.
- Confirmation delivery failures and resend rate-limit feedback reach the caller.
- Signup verification preserves eight-digit codes, including leading zeroes, and rejects expired codes.
- Password-reset email requests still use the recovery endpoint. Provider failures preserve the existing generic response to avoid revealing account existence.
- Password reset verifies the recovery OTP before changing the password, then signs out. An invalid OTP never reaches the password update.
- Editing a name calls only the protected profile endpoint, without sending an email or changing Auth credentials.

The expanded SQL test checks that unverified student/shop registrations do not create public profiles, confirmation creates the expected profile and shop, and password updates/reconfirmation do not overwrite edited names or create duplicate profiles. The new migration does not alter SMTP settings.

**Not verified:** real inbox delivery, hosted SMTP credentials/provider availability, hosted confirmation/OTP settings, or a full authenticated browser flow. No real emails were sent, accounts created remotely, or live migrations applied. The default full-app e2e bootstrap was not run because it initializes configured external services; these results cover local automated regressions, not a deployed smoke test.

## Existing discrepancies

1. `src/app.controller.spec.ts` expects `PrintFlow API`, while `src/app.service.ts` returns `prentflows neh doh`. Both values are present in Git HEAD and neither file was changed today. The test remains failing; no application behavior was changed to hide it.
2. The legacy signup SQL test used a five-email hourly limit, while its committed migration uses 50. The test now checks that request 50 is accepted and the next request is rate-limited. The migration itself was not changed. This is historical custom-OTP coverage; the current frontend uses Supabase Auth.
3. `supabase/config.toml` has `auth.email.enable_confirmations = false` and `otp_length = 6`; the current UI requires confirmation with eight-digit codes. These local defaults predate today's changes. Check that the hosted Supabase Auth settings have confirmation enabled, OTP length 8, and the intended SMTP provider configured. This file does not establish the hosted settings.
4. `supabase/EMAIL-OTP-SETUP.md` describes the historical backend SMTP sender. The current application source uses Supabase Auth directly, so that document is not the current delivery setup guide.

The existing security-reproduction suite is a separate audit artifact whose passing tests demonstrate vulnerabilities; it is not included in the regression pass count.

## Repeat the checks

Frontend: `npm test`.

Backend:

```text
npm test -- --runInBand
node scripts/test-client-names-migration.cjs
node scripts/test-signup-migration.cjs
node scripts/test-shop-photos.cjs
node scripts/test-shop-locations.cjs
node scripts/test-print-jobs.cjs
```
