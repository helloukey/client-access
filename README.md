# Paid Client Access: Stripe → Supabase → Zoho CRM

A client signs in to a small portal and buys a sample document through Stripe Checkout (test mode).
A verified Stripe webhook grants access in Supabase and marks the client's Zoho CRM Deal as paid. If Zoho
is down, access still works and the CRM update is kept as **pending** with a retry command.

```
Browser (anon key + client JWT)                 Next.js server (secret keys)                 External
──────────────────────────────                  ────────────────────────────                 ────────
/portal ── reads own rows via RLS ─────────────▶ Supabase Postgres
        ── signed URL via Storage RLS ─────────▶ Supabase Storage (private bucket)
        ── POST /api/checkout (Bearer JWT) ───▶ create purchase row ─────────────────────▶ Stripe Checkout
                                                                                           │ payment
        ◀── redirect /portal?checkout=success ─────────────────────────────────────────────┘
                                                 POST /api/webhook ◀── signed event ─────── Stripe
                                                   1. verify signature (raw body)
                                                   2. fulfill_checkout() — ONE transaction:
                                                      dedupe event · mark paid · grant entitlement
                                                      · queue crm_sync row
                                                   3. 200 to Stripe, then after():
                                                      claim_crm_sync() → PUT Deal ─────────▶ Zoho CRM
                                                 npm run crm:retry / POST /api/crm/retry ──▶ Zoho CRM
```

## What's implemented

| Requirement | How |
|---|---|
| Verify the webhook and match it with stable IDs | `stripe.webhooks.constructEvent` on the raw body. The purchase is matched by the **Checkout Session id we stored** when checkout was created, and cross-checked against `client_reference_id`, amount and currency. The Zoho Deal id comes from the server-side `offers` table (seeded), never from the browser or from Stripe metadata. |
| Access only after payment, no duplicates | Access is granted only on `checkout.session.completed` with `payment_status = paid`, or on `async_payment_succeeded`. `fulfill_checkout()` runs in a single transaction: the `stripe_events` primary key dedupes repeated deliveries, `entitlements unique(client_id, document_id)` blocks a second grant, and the `crm_sync` primary key blocks a second CRM update. |
| Zoho update, plus pending/retry when Zoho is down | Access is committed before Zoho is called. The Zoho call runs after the 200 response. Failures are recorded as `failed` (will retry) or `failed_permanent` (needs a person), with `last_error`. Retry with `npm run crm:retry`, `POST /api/crm/retry`, or the portal's **Retry CRM** button. |
| Portal shows access and CRM status; clients are isolated | `/portal` reads directly from Supabase with the client's JWT. RLS allows only the client's own rows, and there are no write policies. The document is in a private bucket whose read policy requires a matching entitlement. Covered by `npm run test:db` and `npm run check:isolation`. |

## Prerequisites

- Node 20+ and npm
- [Stripe CLI](https://docs.stripe.com/stripe-cli) (`brew install stripe/stripe-cli/stripe`)
- A Supabase project (the free tier is fine). The Supabase CLI is optional.
- A Zoho CRM Developer Edition org: <https://www.zoho.com/crm/developer/>

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Supabase

1. Create a project. From **Project Settings → API**, copy the URL, the anon (publishable) key and the
   service_role (secret) key into `.env.local`.
2. Apply the migration, which creates the tables, RLS, the private `documents` bucket and its policy, and the functions:
   - **Option A (CLI, recommended):** the repo is already a Supabase CLI project (`supabase/config.toml`).
     ```bash
     supabase login
     supabase link --project-ref <your-project-ref>   # asks for the database password
     supabase db push                                 # applies supabase/migrations/*
     ```
   - **Option B (dashboard):** paste `supabase/migrations/20261028000000_init.sql` into the SQL Editor and run it.
   - **Option C (fully local, needs Docker):** `supabase start` prints a local URL, anon key and service_role key
     for `.env.local`, then `supabase db reset` applies the migration.

### 3. Stripe (test mode)

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhook
```
Copy the `whsec_...` secret it prints into `STRIPE_WEBHOOK_SECRET`, and your test secret key (`sk_test_...`) into
`STRIPE_SECRET_KEY`. Keep `stripe listen` running. The app refuses to start Stripe calls with a non-test key.

### 4. Zoho CRM

1. Go to <https://api-console.zoho.com> → **Self Client** → copy the Client ID and Secret into `.env.local`.
2. **Generate Code** with scope `ZohoCRM.modules.ALL` and a duration of 10 minutes, then exchange it for a refresh token:
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token?grant_type=authorization_code&client_id=$ZOHO_CLIENT_ID&client_secret=$ZOHO_CLIENT_SECRET&code=<code>"
   ```
   Put `refresh_token` into `ZOHO_REFRESH_TOKEN`.
3. **Data centre:** if your org is on `zoho.in` / `zoho.eu` / etc., set `ZOHO_ACCOUNTS_URL` and `ZOHO_API_DOMAIN`
   (and use the same accounts domain in the curl above). A mismatch here is the most common reason the integration fails.
4. *(Optional)* Add a single-line custom field to Deals (e.g. `Stripe_Payment_ID`) and set its API name in
   `ZOHO_PAYMENT_ID_FIELD`.

### 5. Seed and run

```bash
# set ADMIN_TOKEN (openssl rand -hex 32) and SEED_CLIENT_PASSWORD in .env.local first
npm run db:seed     # Stripe price, sample PDF, alice@/bob@/carol@example.com, a Zoho Contact + Deal for each
npm run dev         # http://localhost:3000
```

You can re-run the seed safely: every step looks things up before creating them.

## Demo script (tracing a purchase)

1. Sign in at <http://localhost:3000/login> as `alice@example.com` (password = `SEED_CLIENT_PASSWORD`).
   The document shows **No access**.
2. Click **Buy with Stripe (test)** and pay with `4242 4242 4242 4242`, any future expiry and any CVC.
3. Watch the trail:
   - **Stripe:** the `stripe listen` terminal shows `checkout.session.completed → 200`.
   - **App log:** `[webhook] evt_… -> fulfilled (purchase …)`, then `[crm] purchase … -> Zoho deal … synced`.
   - **Supabase:** rows appear in `purchases` (paid), `entitlements`, `stripe_events` and `crm_sync` (synced).
   - **Portal:** the badge changes to **Access granted**, CRM shows **synced**, and **Download** opens the PDF via a 60-second signed URL.
   - **Zoho:** the Deal `Sample Report - alice@example.com` moves to **Closed Won**, with Amount and Closing Date set.

### Idempotency

```bash
stripe events resend evt_...   # the checkout.session.completed id from the stripe listen output
```
That command just prints the event JSON. The result shows up elsewhere:
- **`stripe listen`:** `<-- [200] POST …/api/webhook`
- **`npm run dev` log:** `[webhook] evt_… -> duplicate_event`, with no `[crm]` line after it, because Zoho isn't called
- **Supabase:** row counts in `entitlements` and `crm_sync` are unchanged, and `crm_sync.attempts` doesn't increase

Note: with Adaptive Pricing on, the customer may pay in local currency (`presentment_details`), but `amount_total`/`currency`
stay in the price's currency (USD). Those are the fields the webhook checks, so local-currency payments still match.
(`stripe trigger checkout.session.completed` creates a session the app didn't create, so it logs `unknown_session`
and grants nothing.)

### Zoho outage

1. Set `ZOHO_SIMULATE_DOWN=true` in `.env.local` and restart `npm run dev`. (Or use a wrong `ZOHO_API_DOMAIN`.)
2. Sign in as `bob@example.com` and buy. Bob gets **Access granted** straight away; CRM shows **failed** with the error.
3. Set it back to `false` and restart, then retry using any one of:
   ```bash
   npm run crm:retry
   curl -X POST localhost:3000/api/crm/retry -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}'
   # or click "Retry CRM" in Bob's portal
   ```
   CRM moves to **synced** and the Deal updates. Running the retry again prints *Nothing to retry*.

### Isolation

```bash
npm run test:db           # runs the real migration in an in-memory Postgres (PGlite): 31 checks for
                          # fulfilment, idempotency, mismatches, the CRM claim, and RLS/storage isolation
npm run check:isolation   # against your live Supabase: signs in as bob with the anon key and tries to read
                          # alice's purchases, CRM row and document, grant itself access, and call the server functions
npm run check:isolation -- carol@example.com alice@example.com
                          # carol never buys, so this also proves Storage refuses to sign a URL for the PDF
```

## Design decisions and tradeoffs

- **The database owns idempotency.** Unique constraints and a single transaction are correct even with
  concurrent deliveries and server restarts. In-memory or "check then insert" logic is not.
- **Matching by our own IDs.** The checkout route stores `purchase_id ↔ session_id` before payment, and the Deal id
  comes from `offers`. Metadata is used only as a fallback, and only for a purchase that has no session yet. Even then
  the client, amount and currency must match, otherwise the outcome is `mismatch` and nothing is granted.
- **The CRM update is an outbox, not part of the webhook transaction.** Stripe gets a 200 as soon as access is
  correct. A Zoho failure never makes Stripe redeliver, and never blocks or rolls back access.
- **Exactly one Zoho update is the goal; delivery is at-least-once.** `claim_crm_sync` makes sure only one worker sends
  the update, and never for a row that is already `synced`. If a worker crashes after Zoho accepted the update but
  before we recorded it, the stale claim is retried after 5 minutes. The payload uses absolute values
  (Stage/Amount/Date), so a re-send is harmless.
- **Zoho returns 200/202 with per-record errors**, so the code checks the record `code === "SUCCESS"`.
  5xx, 429, network and auth errors can be retried. Record errors (deleted Deal, bad picklist value) become
  `failed_permanent` so they aren't retried forever. `crm:retry -- --include-permanent` re-queues them after a fix.
- **Auth:** the portal uses supabase-js in the browser, and the API routes take the access token as a Bearer header,
  checked by Supabase Auth. This avoids cookie/SSR session plumbing. The cost is that the portal page renders on the
  client.
- **Polling, not Realtime:** the portal polls every 3 seconds while a payment or CRM update is in progress. Supabase
  Realtime would also work with RLS, but polling is simpler to reason about for a demo.
- **Zoho runs in `after()` in the same Node process.** That's fine locally and on a long-running server. On serverless
  you'd raise `maxDuration` or move the work to a queue or a Supabase cron job; the retry path already covers lost work.

## Edge cases handled

- Repeated delivery of the same event, or a different event for the same session → one entitlement, one CRM update
- Delayed payment methods (`completed` + `unpaid`) → access waits for `async_payment_succeeded`; `async_payment_failed` / `expired` close the purchase
- A late failure or expiry event never downgrades a paid purchase
- Double-click or two tabs → an open Checkout Session is reused. If two payments still both succeed, the second one is marked `needs_refund` and gets no second entitlement or CRM update.
- Events that aren't ours (`stripe listen` forwards the whole account) → `unknown_session`, nothing granted
- Live-mode events are ignored, and the server refuses non-test Stripe keys
- Zoho access token is cached and refreshed early; a 401 forces one refresh and a retry
- `/api/crm/retry` for a client: only their own purchase, with the same 404 for "not found" and "not yours"

## What could stop this working

- **Webhook secret mismatch:** the `stripe listen` secret changes per CLI session and differs from a Dashboard endpoint secret.
- **Zoho refresh token revoked or expired**, wrong data centre, a renamed Stage picklist value, a deleted Deal, or the API rate limit.
- **Supabase free projects pause** after about a week of inactivity, so wake the project before the demo.
- **Price changes in Stripe** without updating `documents.amount` → payments end as `mismatch`, which is safe but needs attention. The seed checks this.
- **Service role key exposure** if someone adds a `NEXT_PUBLIC_` prefix to it.

## Not done / next steps

- **Refunds and disputes** (`charge.refunded`, `charge.dispute.created`): should access be revoked and Zoho updated? This is a business decision, so it's documented rather than automated.
- **Automatic retry schedule** (e.g. Supabase `pg_cron` or Vercel Cron calling `/api/crm/retry` with backoff) and alerting on `failed_permanent` / `needs_refund`. Right now retry is manual.
- Creating the Zoho Deal on demand when a new client signs up. Right now Deals come from the seed.
- Integration tests for the route handlers against a local Supabase (`supabase start`) with signed Stripe test payloads.
- Self-service sign-up and magic-link login. Right now clients are seeded users with passwords.

## Project layout

```
app/
  api/checkout/route.ts      create/reuse Checkout Session (auth: Bearer JWT)
  api/webhook/route.ts       verify → fulfill_checkout() → after(syncPurchase)
  api/crm/retry/route.ts     operator (x-admin-token) or client (own purchase) retry
  login/page.tsx  portal/page.tsx
lib/
  env.ts  auth.ts  stripe.ts  zoho.ts  crm-sync.ts  supabase/{admin,browser}.ts
supabase/migrations/20261028000000_init.sql   schema, RLS, storage policy, functions
scripts/seed.ts  scripts/crm-retry.ts  scripts/check-isolation.ts
tests/db.test.mjs                               migration tests in PGlite
```
