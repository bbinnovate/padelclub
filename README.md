# Jain Gymkhana Booking Platform

A mobile-first booking experience and venue operations dashboard for Jain Gymkhana.

## What is implemented

- Sport-first booking flow for padel, pickleball, and turf cricket
- Vertical 7-day availability schedule showing every 30-minute slot across all courts or grounds
- Contiguous slot selection with a one-hour minimum, sport-specific maximums, and automatic pricing
- Guest details and player-count capture
- Booking reference and verification code generation
- UPI QR payment instruction and pre-filled WhatsApp confirmation
- Responsive staff dashboard with occupancy, revenue, schedules, pending payments, and check-in actions
- Multi-venue Supabase/PostgreSQL schema with database-level overlap protection and RLS foundations
- Versioned OpenAPI contract designed for both web and future Flutter clients
- Facility gallery and PWA app shell

## Run locally

This prototype reads browser-safe runtime config from `.env` through a small Node server:

```bash
npm start
```

Then open `http://127.0.0.1:8080`.

Admin route:

```bash
http://127.0.0.1:8080/admin
```

The `/admin` route serves `admin.html` and requires an admin login before the dashboard is shown.

## Firebase setup

The app now supports Firebase Authentication and Firestore through the browser SDK.

1. Create a Firebase project and enable Email/Password Authentication.
2. Create Firestore collections named `Users` and `Bookings`.
3. Copy your Firebase web app config into `.env`.
4. Deploy `firestore.rules` from this repo to protect user and admin access.
5. Promote an admin by setting `Users/{uid}.role` to `admin` in Firestore.

Required deployment variables are listed in `.env.example`. SMS and WhatsApp provider credentials should be read only by backend endpoints; the browser app only receives endpoint URLs from `server.js`.

## Architecture

The demo UI currently keeps mock inventory in `app.js` so it is immediately reviewable. For production, replace those calls with the documented endpoints in `docs/openapi.yaml`. Keep booking creation, cancellation windows, pricing, availability, and conflict checks in the backend.

`supabase/migrations/0001_initial_schema.sql` includes the core normalized schema. Its PostgreSQL `EXCLUDE` constraint is the final protection against simultaneous overlapping bookings, regardless of whether the request comes from the web app, staff dashboard, or future Flutter app.

Money is stored as integer minor units. Authentication should use Supabase mobile OTP and JWTs. Public/guest booking creation should be exposed through a rate-limited Edge Function, not direct anonymous table inserts.

## Production rollout

1. Create a Supabase project and apply the migration.
2. Implement `/v1` endpoints as Supabase Edge Functions from the OpenAPI contract.
3. Move venue settings, prices, availability, and booking creation from mock state to the API.
4. Add OTP login, transactional email, PDF generation, QR storage, and WhatsApp delivery logs.
5. Deploy the web client behind HTTPS and configure the PWA icons.

The API and schema intentionally avoid frontend-specific logic, so a Flutter client can consume the same contract without redesigning the backend.
