# Client names and operator loading

Deployment order:

1. Apply `supabase/migrations/20261004010000_client_names.sql` to the target Supabase project before deploying the backend. If already applied, this release needs no additional schema migration. The migration has been tested locally; it is not automatically applied by the app.
2. Build and deploy the backend (`npm run build`) using the existing production configuration.
3. Build and deploy the frontend (`npm run build`) with its production API URL.

Account Settings on both customer and operator screens now loads and saves first and last names through `GET /auth/profile` and `PATCH /auth/profile`. Existing cookie authentication and origin checks apply. The backend obtains the user ID from the authenticated session and accepts only first and last names, each 1–100 characters after whitespace normalization. The public profile is the source of truth for edited names. Microsoft login fills missing names without replacing saved edits.

The operator dashboard batches storage URL signing in groups of at most 100 unique paths per bucket, shares concurrent shop-info requests, and avoids overlapping order reads. Mutation notifications request a fresh read after any in-progress read, and older snapshots are discarded. Polling pauses in hidden tabs and resumes immediately when visible. Signed URLs remain short-lived; results are not persistently cached in the browser.

Local checks:

- Backend: `npm test -- --runInBand profile.spec.ts microsoft-auth.service.spec.ts orders.service.spec.ts supabase.service.spec.ts`
- Migration: `node scripts/test-client-names-migration.cjs`
- Frontend: `node --test tests/operator-loading.test.cjs tests/daemonSocketService.test.cjs`
- Run `npm run build` in both projects.

After deployment, verify a customer and an operator can open Account Settings, change their name, and reopen settings to see it persisted. Verify the customer name appears on the operator's order card after refresh. Check a Microsoft user's edited name survives sign-out/sign-in. Also check document previews, payment receipts, and printer progress against production storage. Automated checks do not replace this authenticated deployment smoke test.
