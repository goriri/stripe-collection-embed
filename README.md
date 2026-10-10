# Stripe Sandbox Embedded Checkout Sample

A minimal Node.js + Express application demonstrating **Stripe Embedded Checkout** (`ui_mode: 'embedded_page'`) in subscription mode using Stripe Sandbox (test mode) keys.

## Prerequisites

- Node.js 18+ and npm
- Stripe Sandbox keys (`rk_test_...` or `sk_test_...`, and `pk_test_...`)
- A Stripe Sandbox Product ID with a recurring `default_price` (or a fallback `STRIPE_PRICE_ID`)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from `.env.example` and fill in your Stripe Sandbox credentials:

   ```bash
   cp .env.example .env
   ```

   Required environment variables in `.env`:

   ```env
   STRIPE_SECRET_KEY=rk_test_replace_me
   STRIPE_PUBLISHABLE_KEY=pk_test_replace_me
   STRIPE_PRODUCT_ID=prod_replace_me
   PORT=4242
   BASE_URL=http://localhost:4242
   ```

   > **Sandbox Guard:** The server refuses to start unless `STRIPE_SECRET_KEY` starts with `rk_test_` or `sk_test_` and `STRIPE_PUBLISHABLE_KEY` starts with `pk_test_`.

## Running the App

Start the server:

```bash
npm start
```

Open [http://localhost:4242](http://localhost:4242) in your browser.

## Running Automated Tests & Secret Checks

Run the integration test suite (spawns the server on a free port, creates a real sandbox Checkout Session, verifies status, and expires the created session):

```bash
npm test
```

Scan all non-ignored repository files to ensure no Stripe API keys or real resource IDs are tracked before committing:

```bash
npm run check-secrets
```

## Documentation

See the full **[Developer & Production Readiness Guide (`docs/GUIDE.md`)](docs/GUIDE.md)** for:
- End-to-end architecture and sequence diagram
- Step-by-step Embedded Checkout implementation (`ui_mode: 'embedded_page'`, minimum-privilege restricted key permissions, dynamic plan config, and return page email verification) with sanitized screenshots
- Complete Sandbox-to-Production checklist (webhooks, idempotency, PII/GDPR, CSP, Stripe Tax, Customer Portal)
- Secret hygiene and key rotation practices

## Test Cards (Stripe Sandbox)

Use the following Stripe test card numbers in Embedded Checkout with **any future expiration date** (e.g., `12/34`), **any 3-digit CVC** (e.g., `123`), and any valid billing postal code:

| Scenario | Card Number | Notes |
| --- | --- | --- |
| Standard successful payment | `4242 4242 4242 4242` | Succeeds immediately |
| 3D Secure (3DS) authentication required | `4000 0025 0000 3155` | Prompts a 3DS modal before completing |

## Where the Payer Email Appears

1. **Pre-checkout form (`/`):** The user enters their email address on `public/index.html`.
2. **Checkout Session creation (`POST /create-checkout-session`):** The server validates the email and passes it as `customer_email` when creating the Embedded Checkout Session (`ui_mode: 'embedded_page'`, `mode: 'subscription'`).
3. **Return page (`/return.html?session_id=cs_test_...`):** After completing payment, Stripe redirects to `return.html`, which calls `GET /session-status?session_id=...`.
   - **In the browser:** When `status === 'complete'`, the payer's email (`session.customer_details.email ?? session.customer_email`) is displayed in `#customer-email` on the confirmation screen. If `status === 'open'`, the browser redirects back to `/`.
   - **In the server logs:** When a completed session is retrieved via `GET /session-status`, the server logs:
     ```text
     [Checkout Complete] session_id=cs_test_... customer_email=you@example.com subscription_id=sub_...
     ```
