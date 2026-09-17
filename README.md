<div align="center">

# ⚙️ PrintFlow - Backend API & Edge Daemon

<a href="https://readme-typing-svg.herokuapp.com">
  <img src="https://readme-typing-svg.herokuapp.com/?lines=Central+Nervous+System;REST+API+&+WSS+Gateway;Powered+by+Node.js+&+NestJS&font=Inter&center=true&width=550&height=50&color=10B981&vCenter=true&size=22" alt="Typing SVG" />
</a>

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Framework-NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" alt="NestJS" />
  <img src="https://img.shields.io/badge/Database-PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Sockets-Socket.io-010101?style=for-the-badge&logo=socketdotio&logoColor=white" alt="Socket.io" />
  <img src="https://img.shields.io/badge/AI-OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI" />
</p>

</div>

<br />

## 📖 Context

This Node.js/NestJS application is the central nervous system for CIT-U's PrintFlow. It houses the PostgreSQL database schema, the OpenAI Agentic AI verification routes, and the Socket.io WSS Gateway that communicates with the physical print daemons installed on the shop computers.

---

## 🏗 Architecture Diagram

```mermaid
graph TD
    S[Student/Shop<br/>React Frontend] -->|REST / WebSockets| B(Backend API<br/>Node.js/NestJS)
    B <-->|Read / Write| DB[(PostgreSQL Database)]
    B <-->|WSS Gateway| E[Edge Daemon<br/>Physical Shop PC]
    E -->|Print Commands| W[Windows Spooler]
```

---

## 🔄 Order State Machine

The lifecycle of an order follows a strict state machine to ensure data integrity and proper payment procurement:

| State               | Description                                                                 |
| :------------------ | :-------------------------------------------------------------------------- |
| `OPEN_INQUIRY`      | Order created, pricing auto-calculated, pending student payment submission. |
| `AWAITING_PAYMENT`  | Payment receipt submitted by student; awaiting shop verification.           |
| `PROOF_APPROVED`    | Payment verified by the shop; document is cleared for printing.             |
| `IN_PRODUCTION`     | The Edge Daemon has spooled the document to the physical printer.           |
| `READY_FOR_PICKUP`  | Printing finished successfully. Student is notified.                        |
| `COMPLETED`         | Student has picked up the document. Transaction closed.                     |
| `ESCALATED_DISPUTE` | Shop rejected the payment, and the student appealed to System Admins.       |

---

## 🔐 Environment Variables

Create a `.env` file in the root of the repository with the following keys:

```env
NODE_ENV=development
PORT=3000
FRONTEND_URL=http://localhost:5173
ADMIN_URL=http://localhost:3001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-with-your-rotated-service-role-key
JWT_SECRET=replace-with-at-least-32-random-characters
AGENT_JWT_SECRET=replace-with-a-different-32-character-secret
TOTP_ENCRYPTION_KEY=replace-with-another-32-character-secret
ENABLE_AI_PERMIT_REVIEW=false
# Optional. Keep blank while AI permit review is disabled.
OPENAI_API_KEY=

# Document-safety defaults. MAX_PDF_PAGES is intentionally generous.
MAX_PDF_PAGES=1000
MAX_IMAGE_PIXELS=75000000
MAX_DOCX_ENTRIES=10000
MAX_DOCX_EXPANDED_BYTES=268435456
MAX_DOCX_ENTRY_BYTES=134217728
MAX_NORMALIZED_PDF_BYTES=104857600
MAX_CONCURRENT_CONVERSIONS=2
MAX_QUEUED_CONVERSIONS=20
```

## 🖨️ Windows Printer Agent

The printer agent connects PrintFlow to the printers installed on a shop's
Windows computer. Shop staff use the installer from the dashboard. They do not
need to download the source code, install Node.js, or run terminal commands.

### Setting up a shop computer

Once the shop has been approved:

1. Connect the printer and make sure it works normally in Windows.
2. Open **Printer Agent** from the PrintFlow shop dashboard.
3. Download and run the Windows installer.
4. Sign in with the approved shop account when the setup page opens.
5. Go back to the **Printer Agent** page. The computer should show as
   **Connected**, and the installed printer should appear in the list.

If a printer is missing, use **Rescan printers**. The agent starts automatically
when the Windows user signs in and reconnects after temporary network problems.
For now, each shop can have one active printing computer.

### Printing orders

After a payment is approved, the order appears under **Print Ready**. Select the
orders you want to print, choose a printer, and click **Send to Daemon (Batch)**.
The agent sends each job to the printer one at a time and reports the result back
to the dashboard.

Simply connecting a printer does not print everything in the queue. The clerk
still chooses which orders to send.

PrintFlow accepts PDF, DOCX, JPG, PNG, and WEBP files. Images and DOCX files are
converted to PDF before printing. Each page is resized to fit the selected
Short, A4, or Long paper without stretching it, and landscape pages stay in
landscape.

### Server setup

Apply all of these migrations before deploying this backend revision:

```text
supabase/migrations/20260917_daemon_devices.sql
supabase/migrations/20260918_cleanup_revoked_daemon_devices.sql
supabase/migrations/20260919_encrypt_admin_totp.sql
supabase/migrations/20260919_admin_sessions.sql
supabase/migrations/20260919_admin_audit_events.sql
```

For an existing Render Web Service, add `TOTP_ENCRYPTION_KEY` manually under
**Environment** and give it a stable random value of at least 32 characters.
Also keep `AGENT_JWT_SECRET` stable and at least 32 characters,
`ALLOW_LEGACY_DAEMON_AUTH=false`, and `ENABLE_AI_PERMIT_REVIEW=false` unless the
privacy review for external permit processing has been completed. The limits
shown above are optional because the backend has those defaults built in.

Set `FRONTEND_URL` and `ADMIN_URL` to the exact HTTPS origins of the two Render
static sites, without a trailing slash. The new browser sessions use Secure,
HttpOnly cookies, so redeploy the backend, customer frontend, and admin frontend
together. The backend must run from the included Dockerfile because it installs
LibreOffice for DOCX conversion and runs both Node and LibreOffice as a non-root
user.

### Development and releases

To run the current agent from source while developing:

```bash
npm run agent
```

The older `npm run daemon` command is kept only for legacy local testing. It
starts the old terminal-based daemon and should not be used by shop staff.

Build the Windows installer from a Windows development computer:

```bash
npm run agent:build:windows
```

The finished installer and its checksum are placed in `agent/release/`. This
folder is ignored by Git. The installer already contains the runtime and
printing dependencies needed by the shop computer.

Publish the installer to the private Supabase `agent-releases` bucket:

```powershell
# Required only for the approved remote maintenance window.
$env:ALLOW_PRODUCTION_MAINTENANCE = 'true'
$env:CONFIRM_SUPABASE_PROJECT = 'your-project-reference'
npm run agent:publish:windows
```

Remove those two maintenance values from your shell after publishing with
`Remove-Item Env:ALLOW_PRODUCTION_MAINTENANCE, Env:CONFIRM_SUPABASE_PROJECT`.
You can append `-- --dry-run` to validate the target without uploading anything.

After publishing, copy the printed storage path, version, checksum, and
publication time into the matching `AGENT_WINDOWS_*` environment variables on
the deployed backend. Redeploy the backend so the **Printer Agent** page offers
the new installer. You can also use `AGENT_WINDOWS_DOWNLOAD_URL` when the
installer is hosted somewhere else.

---

## 👥 Contributors

Proudly developed by the PrintFlow team:

- **Jude Mikael Valencia**
- **Karol Vincent Bebedor**
- **Noeh Arbee Boiser**
- **Aldrin Suse**
