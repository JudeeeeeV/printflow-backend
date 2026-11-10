# PrintFlow - Backend API and Windows Printer Agent

## 1. Project Description

PrintFlow supports campus document printing for students, print-shop operators, and platform administrators. This repository contains the NestJS API, Supabase integration, incremental database migrations, and Windows printing agent. The API serves the [student/shop frontend](https://github.com/JudeeeeeV/printflow-frontend), [administrator portal](https://github.com/JudeeeeeV/printflow-admin), and registered agents.

## 2. Features and Responsibilities

- Supabase-backed user sessions, profiles, and optional CIT Microsoft sign-in.
- Shop verification, pricing, availability, locations, and GCash details.
- Drafts, actionable document validation, normalization to PDF, operation recovery, queue filtering, and batch review.
- Separate GCash and cash-on-pickup workflows, receipt history, disputes, refunds, and audit records.
- Print attempts, operator output confirmation, collection, device registration, and printer discovery.
- Administrator authorization, TOTP two-factor authentication, protected sessions, and audit events.
- Analytics, CSV data, server-sent data events, and Socket.IO communication.

| Important path                                    | Responsibility                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/main.ts`, `src/app.module.ts`                | Startup, environment checks, CORS, validation, security headers, and modules. |
| `src/auth/`, `src/iam/`, `src/admin/`             | User authentication, authorization guards, and administrator/TOTP workflows.  |
| `src/orders/`, `src/shops/`, `src/analytics/`     | Business rules, payments, fulfillment, shops, and reporting.                  |
| `src/edge/`, `src/daemon-devices/`, `src/events/` | Printer protocol, registered devices, installer metadata, and live updates.   |
| `src/supabase/`, `supabase/migrations/`           | Server-side Supabase client, private storage, and incremental SQL.            |
| `agent/`, `scripts/`, `docs/`                     | Windows agent, maintenance/release utilities, and technical guides.           |

The web applications call NestJS over HTTP; NestJS uses Supabase Auth, PostgreSQL, and Storage. The Windows agent connects through the Socket.IO `/daemon` namespace and submits reviewed jobs to Windows printers. The backend uses Supabase JS/PostgREST and database functions, not Prisma.

## 3. Technology Stack

| Area                       | Technologies                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Runtime/API                | Node.js 24, TypeScript, NestJS 11, Express.                                             |
| Persistence/authentication | Supabase PostgreSQL, Auth, Storage, and Supabase JS.                                    |
| Live services              | Socket.IO, server-sent events, scheduling.                                              |
| Document processing        | `pdf-lib`, Sharp, JSZip, LibreOffice Writer.                                            |
| Security                   | Role/ownership checks, RLS/restricted RPCs, Helmet, throttling, bcrypt, encrypted TOTP. |
| Validation                 | Jest, Supertest, ESLint, Prettier, isolated PGlite SQL regressions.                     |
| Windows agent              | Packaged Node.js runtime, Socket.IO client, `pdf-to-printer`.                           |

OpenAI is an optional shop-permit review integration. Standard student file checks do not certify AI print quality or minimum DPI; administrators retain the final shop-verification decision.

## 4. Prerequisites

- Git, npm, and **Node.js `>=24.14.1 <25`**. Docker/Render target 24.14.1.
- Access to an **existing, initialized development Supabase project**, its server-only key, and approved migration history. The tracked incremental migrations do not provide a complete initial schema for an empty project.
- Independent secrets of at least 32 characters for JWT/TOTP configuration.
- LibreOffice Writer on the API host for DOCX conversion, or Docker using the included image. Windows printing hardware is only needed to exercise the agent.

## 5. Installation and Local Setup

```bash
git clone https://github.com/JudeeeeeV/printflow-backend.git
cd printflow-backend
npm install
```

Copy the example **only if `.env` does not already exist**, then replace placeholders privately:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# macOS / Linux alternative
cp .env.example .env
```

Configure the core variables below, including `TOTP_ENCRYPTION_KEY`, which the admin service requires even in development. Use the initialized development project and have its maintainer review outstanding migrations before starting the API.

```bash
npm run start:dev
```

The API listens at [http://localhost:3000](http://localhost:3000). [GET /health](http://localhost:3000/health) reports process status/uptime, not database, email, storage, or printer readiness. Startup checks/creates required private buckets, so use an authorized development project.

### Database migrations

Application startup, builds, Git pushes, and Render deployments do **not** apply [`supabase/migrations/`](supabase/migrations/).

1. Have the maintainer inspect the installed schema/history and identify outstanding files. Do not blindly replay migrations or reset a shared database.
2. Apply reviewed, outstanding SQL in that project's Supabase SQL Editor with the authorized owner role. Historical filenames have mixed timestamp lengths; review dependency order rather than relying on a naive filename sort.
3. Commit `20261106000000_payment_order_states.sql` before applying `20261106010000_separate_payment_workflows.sql`; newly added PostgreSQL enum values must be committed before use.
4. Follow [payment-workflows.md](docs/payment-workflows.md) for print-attempt/payment integration and repairs through `20261108080000_repair_merged_payment_verification.sql`.
5. Ensure the current migrations `20261109010000_order_operations.sql` and then `20261109020000_shop_queue_and_batch_review.sql` are installed.

Historical device/admin setup includes `20260917_daemon_devices.sql`, `20260918_cleanup_revoked_daemon_devices.sql`, `20260919_encrypt_admin_totp.sql`, `20260919_admin_sessions.sql`, `20260919_admin_audit_events.sql`, and `20260924020000_print_jobs.sql`. Check their installation instead of replaying them automatically.

For `PGRST205` concerning `public.print_jobs`, confirm the project and migration history first. The print-jobs migration is a database setup requirement, not a source-code repair. See [merged-workflow-repair.md](docs/merged-workflow-repair.md) for diagnostics.

### Authentication and initial administrator

The current frontend uses **Supabase Auth directly** for sign-up, email verification, and password recovery. Configure email/password authentication, delivery/SMTP, templates, and redirects in the development Supabase project. `supabase/EMAIL-OTP-SETUP.md` describes an older custom SMTP flow and is not the current runtime setup.

Optional CIT Microsoft sign-in additionally requires the Azure provider, institutional tenant, and backend callback described in [MICROSOFT_LOGIN.md](docs/MICROSOFT_LOGIN.md).

A maintainer provisions the first administrator before portal login. `seed-admin.js` consumes `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (at least 12 characters); it is a database-writing maintenance utility, not an automatic installation step. Subsequent administrators use the protected administrator-management workflow. Login requires TOTP enrollment or verification. Do not publish credentials or TOTP enrollment material.

## 6. Environment Variables

Use [`.env.example`](.env.example) as the backend reference. Never commit `.env` or put backend secrets in either browser application's `VITE_` configuration.

### Core API configuration

| Variable                    | Requirement and purpose                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Required. Initialized development/production project URL.                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Required. Server-only privileged key for trusted Auth/database/private Storage operations.                                   |
| `JWT_SECRET`                | Required; at least 32 random characters for application/admin token signing.                                                 |
| `TOTP_ENCRYPTION_KEY`       | Required by the admin service in all environments; independent, stable secret of at least 32 characters.                     |
| `AGENT_JWT_SECRET`          | Required in production; use a separate 32-character-or-longer secret locally too. Development can fall back to `JWT_SECRET`. |
| `FRONTEND_URL`              | Production requires HTTPS. Local default: `http://localhost:5173`. Supply an origin, not an `/index.html` URL.               |
| `ADMIN_URL`                 | Production requires HTTPS. Local default: `http://localhost:3001`. Supply the exact portal origin.                           |
| `NODE_ENV`                  | `development` locally, `production` for production checks and secure cookies.                                                |
| `PORT`                      | Optional listening port; default `3000`. Render can supply it.                                                               |
| `TRUST_PROXY`               | Optional trusted hop count or explicit proxy ranges. Defaults to no proxy trust; the Render blueprint uses one trusted hop.  |

Keep secrets stable across redeployments. Replacing the TOTP encryption key without a migration can make existing administrator enrollment data unreadable.

### Optional integrations and compatibility

| Variable                                        | When used                                                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ANON_KEY`                             | Browser-safe project key used by the backend Microsoft OAuth client; required for that integration.                                                                                                                    |
| `MICROSOFT_TENANT_ID`, `MICROSOFT_CALLBACK_URL` | CIT tenant GUID and backend `/auth/microsoft/callback` URL for Microsoft login.                                                                                                                                        |
| `TURNSTILE_SECRET_KEY`                          | Cloudflare verification for backend login; pair with the frontend site key and Supabase Auth CAPTCHA settings. Add it to local configuration when enabling CAPTCHA; it is referenced by `render.yaml` and the service. |
| `ENABLE_AI_PERMIT_REVIEW`, `OPENAI_API_KEY`     | AI review is disabled by default. Enable only with approved privacy/provider configuration and a server-only API key.                                                                                                  |
| `ALLOW_LEGACY_DAEMON_AUTH`                      | Keep `false` for registered-device production use. The old daemon is only for controlled legacy testing.                                                                                                               |
| `REQUIRE_IDEMPOTENCY_KEY`                       | Optional strict enforcement of order-operation request keys; coordinate with compatible clients.                                                                                                                       |

The sample retains `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `SIGNUP_OTP_SECRET` for the older custom email flow. The current runtime registration/recovery path does not consume them; configure email delivery in Supabase Auth instead.

### Document limits

| Variable                     | Built-in default                                                            |
| ---------------------------- | --------------------------------------------------------------------------- |
| `MAX_PDF_PAGES`              | `1000` pages.                                                               |
| `MAX_IMAGE_PIXELS`           | `75000000` pixels.                                                          |
| `MAX_DOCX_ENTRIES`           | `10000` archive entries.                                                    |
| `MAX_DOCX_EXPANDED_BYTES`    | `268435456` bytes.                                                          |
| `MAX_DOCX_ENTRY_BYTES`       | `134217728` bytes.                                                          |
| `MAX_NORMALIZED_PDF_BYTES`   | `104857600` bytes.                                                          |
| `MAX_CONCURRENT_CONVERSIONS` | `2`.                                                                        |
| `MAX_QUEUED_CONVERSIONS`     | `20`.                                                                       |
| `LIBREOFFICE_PATH`           | Optional executable path when standard discovery does not find LibreOffice. |

Numeric overrides must be positive integers. The upload limit remains 20 MB. See [document-validation.md](docs/document-validation.md) for checks, error categories, and recovery boundaries.

### Agent releases and maintenance

| Variable                                                   | Purpose                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_WINDOWS_VERSION`                                    | Matching installer version label.                                                                                                       |
| `AGENT_WINDOWS_DOWNLOAD_URL`                               | Optional HTTPS installer URL; preferred over Storage fallback when supplied.                                                            |
| `AGENT_WINDOWS_STORAGE_PATH`                               | Object path in private `agent-releases`, signed for downloads.                                                                          |
| `AGENT_WINDOWS_SHA256`, `AGENT_WINDOWS_PUBLISHED_AT`       | Matching checksum and publication timestamp.                                                                                            |
| `PRINTFLOW_BACKEND_URL`                                    | Source/legacy agent API target; packaged agents also use release/local configuration.                                                   |
| `ALLOW_PRODUCTION_MAINTENANCE`, `CONFIRM_SUPABASE_PROJECT` | Explicit approved-maintenance opt-in and exact project reference for remote maintenance utilities; not normal API startup requirements. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`                  | First-admin provisioning inputs for an authorized maintainer.                                                                           |
| `PRINTFLOW_AGENT_CONSOLE`                                  | Optional agent console logging in development.                                                                                          |
| `PRINTFLOW_DAEMON_ACCESS_TOKEN`                            | Mock/legacy daemon input; never commit the token.                                                                                       |

Windows supplies `APPDATA` and installation paths such as `PROGRAMFILES`; these are not required application `.env` entries. Internal setup-process URLs/errors are not hosting configuration.

## 7. Running and Building the Application

| Command                                                 | Purpose                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run start:dev`                                     | Local API with file watching.                                          |
| `npm run build`                                         | Compile into `dist/`.                                                  |
| `npm run start:prod`                                    | Run `node dist/src/main` after building; does not install LibreOffice. |
| `npm test -- --runInBand`                               | Jest unit/integration regressions.                                     |
| `npm run test:security`                                 | Security regression suite.                                             |
| `npm run test:payment-sql`, `npm run test:merged-sql`   | Isolated payment/merged-workflow SQL regressions.                      |
| `npm run test:operations-sql`, `npm run test:queue-sql` | Operation recovery and queue/batch SQL regressions.                    |
| `npm run test:print-sql`, `npm run test:agent`          | Print/agent regressions.                                               |
| `npm run lint`                                          | ESLint **with automatic fixes**; can modify source.                    |
| `npm run format`                                        | Prettier with automatic writes.                                        |

For read-only lint validation: `npx --no-install eslint "{src,apps,libs,test}/**/*.ts"`. To test the production image with an approved development configuration:

```bash
docker build -t printflow-backend .
docker run --rm --env-file .env -p 3000:3000 printflow-backend
```

The image installs LibreOffice/font dependencies, runs as the non-root `node` user, and excludes `.env` via `.dockerignore`.

## 8. Deployment

| Service               | Address / configuration                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend API           | [Configured API](https://printflow-backend-wen3.onrender.com) - referenced by both clients; official production designation awaiting team confirmation. |
| Health                | [GET /health](https://printflow-backend-wen3.onrender.com/health) - returned HTTP 200 with process status on November 10, 2026.                         |
| Student/shop frontend | [Open PrintFlow](https://printflow-frontend-aje0.onrender.com/index.html).                                                                              |
| Administrator portal  | Production URL awaiting team confirmation.                                                                                                              |

[`render.yaml`](render.yaml) defines a Render **Docker web service**, the included Dockerfile, and `/health` monitoring. Blueprint `sync: false` entries require operator-supplied values; existing services need newly required settings added manually. Use the exact HTTPS frontend/admin origins without trailing paths for CORS, cookies, and origin validation.

Deploy compatible API, frontend, and admin revisions together after the reviewed migration process. Validate email delivery, TOTP, payment flows, and physical output separately; a healthy process does not prove those integrations work.

## 9. Related Repositories

- [Project overview](https://github.com/JudeeeeeV/printflow)
- [Student and shop frontend](https://github.com/JudeeeeeV/printflow-frontend)
- [Backend API and agent](https://github.com/JudeeeeeV/printflow-backend)
- [Administrator portal](https://github.com/JudeeeeeV/printflow-admin)

## 10. Windows Printer Agent

### Shop-computer installation

Shop staff use the installer; no Node.js/source checkout/terminal is required.

1. Connect the printer and confirm it works in Windows.
2. Sign in with an approved shop account and open **Printer Agent** in the dashboard.
3. Download/run the Windows installer on the printer-connected computer.
4. Sign in when setup opens and enable startup when requested.
5. Confirm the computer is **Connected** and detected printers are listed. Use **Rescan printers** when needed.

The agent starts at Windows user sign-in and reconnects after temporary problems. The current registration service allows up to ten non-revoked computers per shop. Registration alone does not dispatch the queue.

### Printing and fulfillment

GCash verification authorizes production without separate acceptance. Cash-on-pickup retains explicit acceptance while payment remains due. Eligible orders appear in **Print Ready**. Review/select orders, choose a printer, and use the reviewed batch-dispatch flow.

PDF, DOCX, PNG, JPG/JPEG, and WEBP uploads normalize to PDF on the API host. Pages fit the chosen Short/A4/Long size and orientation without stretching. A successful agent submission means Windows received the command, not that paper was produced. Operators confirm output to mark ready for pickup. GCash retains confirmed handover; recording eligible cash collection completes a cash order without another cash handover step.

See [PRINT_FULFILLMENT_PROTOCOL.md](docs/PRINT_FULFILLMENT_PROTOCOL.md) and [payment-workflows.md](docs/payment-workflows.md) for attempt history, uncertain outcomes, output confirmation, reprints, and collection eligibility.

### Development and releases

```bash
npm run agent
```

Use Windows and set `PRINTFLOW_BACKEND_URL` for the intended API. `npm run daemon` is the old terminal-based daemon, not the shop installation workflow.

Build the packaged Windows installer on a Windows development computer:

```bash
npm run agent:build:windows
```

The installer/checksum appear in ignored `agent/release/`. The package includes its runtime and printing dependencies. `npm run agent:finalize:windows` supports the repository release-finalization workflow.

An authorized maintainer publishes to private Storage with `npm run agent:publish:windows`. Remote publishing requires the maintenance guard's approved window and exact project confirmation:

```powershell
$env:ALLOW_PRODUCTION_MAINTENANCE = 'true'
$env:CONFIRM_SUPABASE_PROJECT = 'your-project-reference'
npm run agent:publish:windows -- --dry-run
# After reviewing the target and receiving release authorization:
npm run agent:publish:windows
Remove-Item Env:ALLOW_PRODUCTION_MAINTENANCE, Env:CONFIRM_SUPABASE_PROJECT
```

Set the matching `AGENT_WINDOWS_STORAGE_PATH`, `AGENT_WINDOWS_VERSION`, `AGENT_WINDOWS_SHA256`, and `AGENT_WINDOWS_PUBLISHED_AT` on the deployed API and redeploy. Alternatively use `AGENT_WINDOWS_DOWNLOAD_URL` for an externally hosted installer. Never commit installer binaries, release directories, or privileged keys.

## Contributors

- Jude Mikael Valencia
- Karol Vincent Bebedor
- Noeh Arbee Boiser
- Aldrin Suse
