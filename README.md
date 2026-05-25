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

| State | Description |
| :--- | :--- |
| `OPEN_INQUIRY` | Order created, pricing auto-calculated, pending student payment submission. |
| `AWAITING_PAYMENT` | Payment receipt submitted by student; awaiting shop verification. |
| `PROOF_APPROVED` | Payment verified by the shop; document is cleared for printing. |
| `IN_PRODUCTION` | The Edge Daemon has spooled the document to the physical printer. |
| `READY_FOR_PICKUP` | Printing finished successfully. Student is notified. |
| `COMPLETED` | Student has picked up the document. Transaction closed. |
| `ESCALATED_DISPUTE` | Shop rejected the payment, and the student appealed to System Admins. |

---

## 🔐 Environment Variables

Create a `.env` file in the root of the repository with the following keys:

```env
# Database Configuration
DATABASE_URL=postgresql://user:password@localhost:5432/printflow

# JWT Auth Configuration
JWT_SECRET=your_super_secret_jwt_key_here

# OpenAI Configuration
OPENAI_API_KEY=sk-...
```

---

## 📡 Edge Daemon Setup

Physical print shops must run the local daemon script to connect their local Windows Spooler to the cloud WSS Gateway.

1. Locate the daemon script within the shop portal or backend utilities folder.
2. Run the script on the shop's dedicated printing PC:
```bash
node physical-daemon.js --shopId="SHOP_UUID_HERE" --secret="SHOP_SECRET_HERE"
```
3. The daemon will maintain a persistent WebSocket connection to the backend and listen for `IN_PRODUCTION` events to automatically spool documents.

---

## 👥 Contributors
Proudly developed by the PrintFlow team:
- **Jude Mikael Valencia**
- **Karol Vincent Bebedor**
- **Noeh Arbee Boiser**
- **Aldrin Suse**
