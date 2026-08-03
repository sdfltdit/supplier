# SDF Supplier Portal — Backend

Backend for the SDF Clothing supplier registration system. Receives
submissions from the public form, stores them in Turso (SQLite), sends a
notification email via Resend, and provides an internal search/filter
endpoint for SDF staff.

Built per `supplier-portal-spec.md`.

## Stack

- Node.js + Express
- Turso (libSQL) — database
- Resend — email notifications
- Intended host: Render (free tier)

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in real values (never commit `.env`)
3. `npm start`

## Environment variables

See `.env.example` for the full list. All of these must be set as real
environment variables in Render's dashboard for production — not
committed to this repo.

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` | Turso database connection URL |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `RESEND_API_KEY` | Resend API key |
| `RESEND_FROM_ADDRESS` | Verified sender address (see note below) |
| `SUPPLIER_NOTIFY_EMAIL` | Where new-submission alerts are sent |
| `ALLOWED_ORIGIN` | CORS — the frontend domain allowed to call this API |
| `ADMIN_API_KEY` | Shared secret for the internal search endpoint |

## Endpoints

- `POST /api/suppliers` — public submission endpoint (used by the form)
- `GET /api/admin/suppliers` — internal search/filter, requires
  `x-admin-key` header matching `ADMIN_API_KEY`. Supports `?category=`,
  `?country=`, `?paymentMode=`, `?q=` (searches company name + address)
- `GET /health` — basic health check

## Known gaps — NOT yet done

These are flagged deliberately rather than silently left out:

1. **Resend domain verification**: to send from an `@sdfltd.com` address,
   the domain must be verified in the Resend Dashboard first (Domains →
   Add Domain → add the DNS records in Cloudflare). Until then, sending
   with a custom `from` address will fail — `onboarding@resend.dev` works
   without verification, for testing only.

2. **Admin endpoint auth is a placeholder.** `ADMIN_API_KEY` is a single
   shared secret sent as a header — functional, but not a real login
   system. Fine for a small internal team short-term; consider a proper
   auth system before this becomes a heavily-used internal tool.

3. **File upload (company profile PDF) is not wired up.** The database
   schema has a `profile_file_url` column ready, but there's no file
   storage (e.g. S3, Cloudflare R2) configured yet, so the submission
   endpoint does not currently accept file uploads. This needs a storage
   decision before it's added — deliberately left out rather than losing
   uploaded files silently.

4. **No admin frontend UI yet.** The `/api/admin/suppliers` endpoint
   works and is tested, but there's no actual web page for SDF staff to
   use it from yet — right now it would need to be queried directly
   (e.g. via curl or a simple fetch call) until a proper internal search
   UI is built.
