# marvintlc — Online Banking Platform

A full-featured online banking platform built with **vanilla HTML, CSS, and JavaScript** on the frontend and **Supabase** (PostgreSQL + Auth + Row Level Security) on the backend. No frontend frameworks, no build step.

## Features

- **Public website** — marketing pages: home, about, services, cards, loans, transfers, security, contact.
- **Customer portal**
  - Dashboard with balances, spend chart, cards, loans, notifications, and pending-transfer resume
  - Transactions, cards (freeze / limits / activity)
  - Local & international transfers with a verified 3-step admin approval flow
  - Crypto withdrawals, deposits, currency swaps, loans
  - Profile (avatar upload/remove, KYC status, personal details), settings, notification center
  - Security PIN required for money movement
- **Admin portal** — separate token-based auth; full CRUD for users, accounts, transactions, transfers, deposits, cards, currencies & exchange rates, loan products & applications, notifications, admin users, audit logs, and system settings. Includes the transfer **verification workflow** (issue code, verify, approve, reject).
- **Financial integrity** — all money movement (transfers, swaps, loan repayments, deposit approval, transaction creation/reversal) runs atomically inside PL/pgSQL functions; the frontend never updates balances directly.
- **Audit trail** — every admin action is recorded in `audit_logs`.

## Structure

```
├── *.html                     Customer portal + public pages
├── admin/                     Admin portal (login, users, customer, accounts,
│                              transactions, transfers, verifications, deposits,
│                              cards, currencies, loans, notifications, audit-logs, settings)
├── js/                        Shared config, Supabase client, auth, UI helpers,
│                              per-page modules (dashboard, transfers, profile, ...)
├── js/admin/                  Admin portal modules
├── css/                       Design system + all component styles
├── assets/logos/              Logo + favicon
└── supabase/
    ├── migrations/            001–016 (schema, RLS, functions, triggers, verification)
    └── seed.sql               Demo data (development only)
```

## Setup

1. Create a Supabase project at https://supabase.com.
2. Set your connection values in `js/config.js`:

```js
const APP_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY'
};
```

> Never expose the service-role key client-side. Only the anon key is used; RLS and SECURITY DEFINER functions enforce permissions.

3. Run the migrations in `supabase/migrations/` in order (SQL editor or `supabase db push`). They create the schema, RLS policies, triggers, and stored functions.

   **Note:** `010_bootstrap.sql` is non-idempotent — run it once on a fresh database only.

4. Run `supabase/seed.sql` to load demo data (currencies, accounts, transactions, demo users).

## Demo credentials

| Role | Email | Password |
|------|-------|----------|
| Customer | `demo@marvintlc.com` | `Demo@1234` |
| Admin | `admin@marvintlc.com` | `Admin@123` |

The seed creates a demo customer with checking/savings/EUR accounts, transactions, cards, deposits, swaps, loans, and notifications.

## Architecture notes

- **Auth** — customers use Supabase Auth (`js/auth.js`). Admin staff use a separate `admin_users` table with a server-issued session token; all admin data access happens through `SECURITY DEFINER` RPCs (`admin_*`) that validate the token, and RLS denies direct access to admin tables.
- **Transfers** — international and crypto transfers are created as `awaiting_admin_verification`, then move through an admin-issued verification code flow (`customer_transfer_verification_status`, `customer_verify_transfer`) before execution. Pending transfers can be resumed from the dashboard.
- **Currencies** — supported currencies live in `currencies`; conversion rates and swap fees in `exchange_rates`, managed from the admin portal.
- **Avatars** — profile pictures are stored in the `avatars` bucket; a centralized `UI.avatar()` helper renders the image (with cache-busting) or falls back to initials everywhere.

## Running locally

Serve the folder over HTTP and open the site:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. App shell pages require an authenticated Supabase session; the admin portal is at `/admin/login.html`.
