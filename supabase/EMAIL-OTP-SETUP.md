# Verify email before creating an account

Registration now uses the backend's SMTP sender, not `supabase.auth.signUp`. No record is created in Authentication > Users, public.users, or shops until the custom 8-digit code is accepted.

## Required setup

1. Run `migrations/20260914_verify_before_signup.sql` in the Supabase SQL Editor. It creates private verification storage and service-role-only RPC functions. The script is repeatable and does not delete existing accounts or change your current Auth triggers. It was tested against embedded PostgreSQL with the users/shops columns reported by your project; live trigger behavior still needs testing.
2. Add these variables to **printflow-backend/.env** locally and to your backend hosting environment in production:

   ```dotenv
   SMTP_HOST=your-provider-host
   SMTP_PORT=587
   SMTP_USER=your-smtp-username
   SMTP_PASS=your-smtp-password
   SMTP_FROM=PrintFlow <no-reply@your-verified-domain.com>
   SIGNUP_OTP_SECRET=your-random-secret
   ```

   Use the same provider credentials you configured in Supabase. Supabase's dashboard SMTP settings are not automatically available to NestJS. Port 465 uses implicit TLS; other ports require STARTTLS. Generate the signing secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Do not paste credentials into chat or commit .env.
3. Keep Email/password sign-in enabled. Disable public/new-user signups in Supabase Auth when switching exclusively to this flow so direct calls to the public signup endpoint cannot create unverified users. The backend creates users with the server-only Admin API after verifying the custom code.
4. Restart the backend after setting environment variables. Deploy the updated frontend and backend together: verification now submits the code and registration details.
5. Keep `supabase/templates/confirm-signup.html` in the backend deployment. The SMTP sender reads this branded template and replaces `{{ .Token }}`. Editing the dashboard email template or dashboard OTP length does not configure this custom flow.

## What happens

- Continue to verification: validate input, generate an 8-digit code, store its HMAC plus email/expiry in `printflow_private.signup_codes`, and send through SMTP.
- The password is retained only in the page's React state until verification, and cleared on success or leaving registration. Reloading the page requires entering the details again. It is never stored in the temporary database table or browser storage.
- Verify and finish registration: atomically consume the code, then call `auth.admin.createUser` with `email_confirm: true`. Existing Auth triggers can now insert public.users, because the email has already been verified. An idempotent database function ensures the profile and optional shop exist. Interrupted profile setup is retried at sign-in.
- Invalid/expired/reused codes or failed SMTP delivery never create a user.
- Codes expire after 10 minutes, allow at most 5 incorrect attempts, and can be requested once per 60 seconds and at most 5 times per email per hour. Old temporary records are pruned when new codes are reserved.
- Existing accounts are not overwritten. An account made by the earlier flow remains and may prevent re-registering that address. This change does not delete those accounts. An Auth user created after successful custom verification can also remain if later profile setup fails; sign-in retries that setup.

## Verify locally

Run `npm test -- --runInBand auth.service.spec.ts signup-verification.service.spec.ts signup-response.spec.ts` and `npm run test:signup-sql` from printflow-backend.

For a live test, use an email address you control that has never registered. Before entering the code, confirm the address is absent from Authentication > Users and public.users. Enter a wrong code and check it remains absent. Enter the correct code and confirm the verified account/profile appear. For a Print Shop, check that the shop appears only then. Check resend, expiry and replay too. Real SMTP delivery and the migration still need to be configured in your hosted project.

References:
- https://supabase.com/docs/reference/javascript/auth-admin-createuser
- https://supabase.com/docs/guides/auth/managing-user-data
- https://nodemailer.com/smtp
