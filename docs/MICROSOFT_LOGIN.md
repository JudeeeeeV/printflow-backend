# CIT Microsoft login setup

The login page includes **Continue with Microsoft**. New verified CIT identities
receive a `STUDENT` profile. Existing users keep their database role. Microsoft
login also creates first-time accounts; a separate password is not required.

The code is ready for configuration, but Microsoft and Supabase must be configured
before real sign-in works. No database migration or additional dependency is required.

## 1. Register an application in CIT's Microsoft tenant

For the current PrintFlow deployment, use:

| Setting | Value |
| --- | --- |
| Microsoft platform | Web |
| Microsoft redirect URI | `https://smelzqepvmqgwzlsdoes.supabase.co/auth/v1/callback` |
| Supabase Site URL | `https://printflow-frontend-aje0.onrender.com` |
| Supabase allowed redirect | `https://printflow-backend-wen3.onrender.com/auth/microsoft/callback?state=*` |
| Backend `FRONTEND_URL` | `https://printflow-frontend-aje0.onrender.com` |
| Backend `MICROSOFT_CALLBACK_URL` | `https://printflow-backend-wen3.onrender.com/auth/microsoft/callback` |

The Microsoft tenant GUID and client ID come from the app registration you create.

Open <https://entra.microsoft.com/> with your CIT account. Select **App registrations
> New registration**. Check that the current directory is CIT's directory. If you
cannot register applications there, ask CIT IT to do these steps.

- Name: `PrintFlow`
- Supported account types: **Accounts in this organizational directory only**
- Platform: **Web** (Supabase receives Microsoft's response, not the React SPA)
- Redirect URI: copy the callback URL shown by Supabase under **Authentication >
  Sign In / Providers > Azure (Microsoft)**. Normally it is
  `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.

Record the **Application (client) ID** and **Directory (tenant) ID** from Overview.
Under **Certificates & secrets**, create a client secret. Copy its **Value**, not
its Secret ID, directly into Supabase's Azure provider settings. Record its expiry
date and rotate it before expiration. Do not put this secret in frontend code,
Git, chat, or a `VITE_` variable.

Under **Token configuration**, add the `email` optional claim for ID tokens.
In **Manifest**, merge these entries into `optionalClaims`, preserving any existing
entries. The `xms_edov` claim is required by PrintFlow to check that Microsoft
verified the email domain.

```json
"optionalClaims": {
  "idToken": [
    { "name": "email", "source": null, "essential": false, "additionalProperties": [] },
    { "name": "xms_edov", "source": null, "essential": false, "additionalProperties": [] }
  ],
  "accessToken": [
    { "name": "xms_edov", "source": null, "essential": false, "additionalProperties": [] }
  ],
  "saml2Token": []
}
```

The app requests basic sign-in and email information. No Outlook mailbox access
is needed. If Microsoft reports that administrator approval is required, CIT IT
must approve the requested sign-in permissions under the school's consent policy.

## 2. Configure Supabase

In **Authentication > Sign In / Providers > Azure (Microsoft)**:

- Enable Azure.
- Set Client ID to Microsoft's Application (client) ID.
- Set Client Secret to the secret **Value**.
- Set Azure Tenant URL to `https://login.microsoftonline.com/YOUR_CIT_TENANT_ID`.
  Use the tenant GUID, not `common`, `organizations`, or a personal tenant.

In **Authentication > URL Configuration**, set Site URL to the frontend origin.
Add the backend callback to Redirect URLs. The flow appends a random state query;
the narrowly scoped wildcard permits that query:

```text
http://localhost:3000/auth/microsoft/callback?state=*
https://printflow-backend-wen3.onrender.com/auth/microsoft/callback?state=*
```

Use the actual deployed backend origin if it differs. Do not allow all paths on
the domain. The frontend callback is not the Supabase OAuth redirect destination.

## 3. Configure and restart the backend

Set these in the backend `.env` for local development, or the hosting provider's
environment settings for production:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_LEGACY_ANON_KEY
MICROSOFT_TENANT_ID=YOUR_CIT_TENANT_GUID
MICROSOFT_CALLBACK_URL=http://localhost:3000/auth/microsoft/callback
FRONTEND_URL=http://localhost:5173
```

Keep the existing `SUPABASE_SERVICE_ROLE_KEY` and strong `JWT_SECRET` configured.
The Microsoft client secret belongs in Supabase, not in these environment variables.
Production needs `NODE_ENV=production`, an HTTPS `MICROSOFT_CALLBACK_URL`, and the
actual HTTPS frontend origin in `FRONTEND_URL`.

For the deployed Render backend, open the service's **Environment** tab and set:

```dotenv
MICROSOFT_TENANT_ID=823cde44-4433-456d-b801-bdf0ab3d41fc
MICROSOFT_CALLBACK_URL=https://printflow-backend-wen3.onrender.com/auth/microsoft/callback
FRONTEND_URL=https://printflow-frontend-aje0.onrender.com
SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_LEGACY_ANON_KEY
```

Use the Supabase project's publishable key or legacy `anon` key for
`SUPABASE_ANON_KEY`, not the Microsoft client secret or Supabase service-role key.
The frontend's `VITE_SUPABASE_ANON_KEY` uses the corresponding project key, but
Render does not automatically share environment variables between services.
Keep the existing `SUPABASE_URL` and `JWT_SECRET` values. Save and redeploy the
backend after changing its environment. Local `.env` edits are not uploaded to
Render, and a localhost callback is rejected when `NODE_ENV=production`.

For a fully local test, set frontend `VITE_API_URL=http://localhost:3000` and restart
Vite. Otherwise the frontend defaults to the deployed backend. Use `localhost`
consistently rather than mixing it with `127.0.0.1`. Rebuild/redeploy both apps for
production. Serve the frontend callback route with the SPA's `index.html` fallback.

## 4. Test

1. Open `/auth`, click **Continue with Microsoft**, and sign in with a CIT account.
2. Confirm that a first-time user reaches `/new-order` and has one `public.users`
   row with role `STUDENT`.
3. Sign out and sign in again; the profile must not be duplicated.
4. An existing CIT shop account must keep its role and reach `/shop-dashboard`.
5. A personal Microsoft account or another organization's account must be rejected.
6. Cancel Microsoft consent and confirm the retry screen appears.
7. Open a callback without the originating browser cookie or replay a used code;
   it must not create a login session.

The flow checks the Supabase-verified Azure identity, CIT tenant and issuer, exact
`@cit.edu` email domain, and verified-email claims. It ignores editable user metadata
for these decisions. School email establishes school affiliation, not enrollment.
Supabase may link an existing account with the same verified email; database roles
are preserved. Never manually merge accounts based on an unverified email.

Authentication uses PKCE, an expiring signed HttpOnly transaction cookie, and the
existing HttpOnly session cookies. Tokens never appear in frontend URLs or browser
storage. If cross-site cookies are blocked in production, use same-site frontend
and API domains or a same-origin API proxy; this also affects existing password login.

## Troubleshooting

- **Not configured:** the backend rejected its configuration before contacting
  Microsoft. Check the tenant GUID, `SUPABASE_ANON_KEY`, HTTPS callback URL and
  existing JWT secret in the environment of the backend actually serving the
  request (Render for the deployed site), then save and redeploy. Do not change
  the Microsoft client secret to fix this error.
- **Provider is not enabled:** enable Azure in Supabase and save its settings.
- **AADSTS50011:** Microsoft's Web redirect URI must be Supabase's callback URL.
- **Admin approval required / cannot register:** ask CIT IT to register/approve the app.
- **Verified CIT account rejected:** check `xms_edov`, `email`, tenant URL and tenant ID.
- **Redirected to the wrong page:** check Supabase's allowed redirect pattern,
  backend callback URL, and frontend origin.
- **Expired:** retry from the sign-in button in the same browser. Starting a second
  Microsoft login in another tab replaces the first attempt; use the newest one.

## References

- [Supabase Microsoft provider setup](https://supabase.com/docs/guides/auth/social-login/auth-azure)
- [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Supabase redirect URL allow lists](https://supabase.com/docs/guides/auth/redirect-urls)
