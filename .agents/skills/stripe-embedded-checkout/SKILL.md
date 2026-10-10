---
name: stripe-embedded-checkout
description: >-
  Use this skill when building or debugging a Stripe Embedded Checkout payment or
  subscription page in a web application (Node.js/Express reference), collecting and
  verifying payer email addresses across pre-checkout forms and return pages, probing
  Stripe Restricted Key permissions, running automated or Playwright E2E tests against
  Stripe Sandbox (including 3DS challenges), or preparing a sandbox integration for
  production with webhooks.
---

# Stripe Embedded Checkout Workflow

Follow these steps in order when implementing or extending a Stripe Embedded Checkout flow.

## 1. Grill the User for Unknowns Before Coding

Before writing code, clarify any missing requirements with the user:

1. **Application Stack**: Confirm the backend runtime/framework (e.g., Node.js + Express) and frontend setup (vanilla HTML/JS vs. React/Next.js/Vue).
2. **Checkout UI Surface**:
   - **Embedded Checkout** (`ui_mode: 'embedded_page'` / `'embedded'`): Stripe-hosted payment form mounted inside an iframe on your page via `stripe.initEmbeddedCheckout()`.
   - **Hosted Checkout** (`ui_mode: 'hosted_page'`): Full-page redirect to `checkout.stripe.com`.
   - **Elements / Payment Element** (`ui_mode: 'elements'`): Custom UI components requiring granular payment state management.
3. **Billing Mode**:
   - `'subscription'` (recurring price required) vs. `'payment'` (one-time price) vs. `'setup'`.
4. **Payer Email Capture Strategy**:
   - **Pre-checkout capture**: Collect the email in your own form before mounting Checkout and pass `customer_email` to `stripe.checkout.sessions.create()` (pre-fills and locks the email field inside Embedded Checkout).
   - **In-checkout capture**: Omit `customer_email` and let the buyer enter their email inside the Stripe iframe; read `session.customer_details.email` after completion.
5. **Required Credentials & Identifiers**:
   - `STRIPE_SECRET_KEY`: Sandbox secret (`sk_test_...`) or restricted key (`rk_test_...`).
   - `STRIPE_PUBLISHABLE_KEY`: Sandbox publishable key (`pk_test_...`). **Required** — Embedded Checkout cannot mount in the browser without a publishable key (`window.Stripe(publishableKey)`).
   - `STRIPE_PRODUCT_ID` (`prod_...`) with a configured `default_price`, or an explicit `STRIPE_PRICE_ID` (`price_...`).

---

## 2. Probe Key Permissions with `curl` Before Coding

Restricted keys (`rk_test_...` / `rk_live_...`) frequently lack one or more permissions needed by Embedded Checkout. **Always probe the key against the Stripe API before writing application code** and escalate missing permissions to the human immediately.

Run the bundled probe script against `.env`:

```bash
set -a && source .env && set +a
bash .agents/skills/stripe-embedded-checkout/scripts/probe_permissions.sh
```

Script location: [probe_permissions.sh](scripts/probe_permissions.sh)

What the probe verifies (without ever echoing `STRIPE_SECRET_KEY`):

| Check | Endpoint | Restricted Key Permission | Notes |
| :--- | :--- | :--- | :--- |
| **Product Read** | `GET /v1/products/$PRODUCT_ID` | `rak_product_read` (Products: Read) | Inspects `default_price` so the server can resolve the price dynamically. |
| **Price List** | `GET /v1/prices?product=$PRODUCT_ID&limit=1` | `rak_plan_read` (Prices/Plans: Read) | Optional if `default_price` is already set on the Product; fails if Prices Read is `None`. |
| **Checkout Session Create + Expire** | `POST /v1/checkout/sessions` then `POST /v1/checkout/sessions/$ID/expire` | `rak_checkout_session_write` (Checkout Sessions: Write) | Confirms the key can create an `embedded_page` session for the resolved price and immediately expires the test session. |

> [!IMPORTANT]
> If **Product Read** or **Checkout Session Create** returns HTTP 403 (`StripePermissionError` / `"This key does not have the required permissions"`), stop and ask the user to update their Restricted Key in the Stripe Dashboard (**Developers → API keys**) or supply `STRIPE_PRICE_ID` if only `Products: Read` is missing.

---

## 3. Verify `ui_mode` Against Installed `stripe` SDK Typings

Stripe renamed the Embedded Checkout `ui_mode` enum value in recent API versions (verified: `stripe-node` v23, which pins `2026-09-30.endive`). Before hardcoding `ui_mode`, check the installed SDK's pinned API version and TypeScript definitions:

```bash
node -e 'console.log(require("./node_modules/stripe/cjs/apiVersion.js"))'
grep -n "type UiMode" node_modules/stripe/esm/resources/Checkout/Sessions.d.ts
```

- **`stripe` v23+ (API `2026-09-30.endive`)**: Uses `ui_mode: 'embedded_page'` (`type UiMode = 'elements' | 'embedded_page' | 'form' | 'hosted_page' | OtherString`).
- **Older `stripe` SDKs / unversioned `curl` against older account default API versions**: Uses `ui_mode: 'embedded'`. Note that raw `curl` requests without `-H "Stripe-Version: 2026-09-30.endive"` use the Stripe account's default API version and will reject `embedded_page` if the account default API version predates the rename.

---

## 4. Implement Server Endpoints & Frontend Mount

Use the reference templates in `resources/` as a starting point:

- Server template: [server.js](resources/server.js)
- Frontend checkout script: [checkout.js](resources/checkout.js)
- Return page script: [return.js](resources/return.js)
- HTML templates: [index.html](resources/index.html), [return.html](resources/return.html)
- Environment template: [.env.example](resources/.env.example)

### Required Endpoints

1. **`GET /config`**:
   - Returns `{ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY }` so the browser can initialize `window.Stripe(publishableKey)`.
2. **`POST /create-checkout-session`**:
   - Validates `req.body.email` on the server (`isValidEmail`) and returns HTTP `400` on invalid input.
   - Resolves the Price ID server-side (`stripe.products.retrieve(PRODUCT_ID)` -> `product.default_price`, falling back to `STRIPE_PRICE_ID`). **Never accept price IDs or amounts from the client.**
   - Calls `stripe.checkout.sessions.create`:
     ```js
     const session = await stripe.checkout.sessions.create({
       ui_mode: 'embedded_page',
       mode: 'subscription', // or 'payment'
       customer_email: email,
       line_items: [{ price: resolvedPriceId, quantity: 1 }],
       return_url: `${BASE_URL}/return.html?session_id={CHECKOUT_SESSION_ID}`,
     });
     ```
   - Returns `{ clientSecret: session.client_secret, sessionId: session.id }`.
3. **`GET /session-status`**:
   - Requires `req.query.session_id` (HTTP `400` if missing).
   - Calls `stripe.checkout.sessions.retrieve(sessionId)`.
   - Reads payer email from `session.customer_details?.email ?? session.customer_email ?? null`.
   - Returns `{ status: session.status, payment_status: session.payment_status, customer_email }`.
   - On `return.html`: if `status === 'open'`, redirect back to `/`; if `status === 'complete'`, render `#customer-email`.

---

## 5. Enforce a Sandbox Key Prefix Guard

During sandbox development, fail fast at startup if non-test keys are supplied:

```js
if (!SECRET_KEY || (!SECRET_KEY.startsWith('rk_test_') && !SECRET_KEY.startsWith('sk_test_'))) {
  console.error('Fatal: STRIPE_SECRET_KEY must start with "rk_test_" or "sk_test_" (sandbox only).');
  process.exit(1);
}
if (!PUBLISHABLE_KEY || !PUBLISHABLE_KEY.startsWith('pk_test_')) {
  console.error('Fatal: STRIPE_PUBLISHABLE_KEY must start with "pk_test_" (sandbox only).');
  process.exit(1);
}
```

---

## 6. Write Automated Sandbox Integration Tests with Session Cleanup

When testing against the real Stripe Sandbox (`node --test`):

1. Spawn the server on an ephemeral port (`net.createServer().listen(0, '127.0.0.1')`).
2. Test:
   - Static HTML serving (`GET /`, `GET /return.html`).
   - `GET /config` returns a `pk_test_...` key.
   - `POST /create-checkout-session` returns `400` for empty/invalid emails and `200` with `clientSecret` (`^cs_test_[a-zA-Z0-9]+_secret_`) for valid emails.
   - `GET /session-status?session_id=...` returns `status: 'open'` and the expected `customer_email`.
   - `GET /session-status` returns `400` when `session_id` is omitted, and `4xx`/`5xx` JSON on a bogus `session_id` without crashing the server.
   - Sandbox guard exits with code `1` when spawned with `sk_live_...` or `pk_live_...`.
3. **Expire every created session** in `after()` cleanup:
   ```js
   for (const sessionId of createdSessionIds) {
     await stripe.checkout.sessions.expire(sessionId);
   }
   ```

---

## 7. Verify End-to-End in a Real Browser with Playwright

API tests alone do not verify that `Stripe.js` mounts the iframe or completes payment redirects. When running Playwright E2E tests against Embedded Checkout:

1. **Target the Embedded Checkout iframe with `frameLocator`**:
   - Stripe mounts a cross-origin iframe inside `#checkout` (match with `page.frameLocator('#checkout iframe').first()` or `page.frameLocator('iframe[name^="embedded-checkout"]')`).
2. **Use `pressSequentially` + `slowMo` to prevent layout-shift input drops**:
   - Stripe Checkout reformats card number (`4242 4242...`), expiry (`MM / YY`), and CVC dynamically as digits are entered. Instant `.fill()` calls can race with internal re-renders or field auto-advances.
   - Launch the browser with `slowMo: 100` (or similar) and type card fields using `.pressSequentially(digits, { delay: 50 })`.
3. **Handle Geo-Defaulted Billing Country & Postal Code Fields**:
   - Stripe defaults the billing country dropdown using IP geolocation. Many countries outside the US/UK/Canada do **not** display a ZIP/postal code input.
   - Either explicitly select `'US'` before filling ZIP, or check visibility (`await zipInput.isVisible()`) before interacting with a postal code field.
4. **Handle 3D Secure (3DS) Challenge Nested Iframes**:
   - Testing 3DS card `4000 0025 0000 3155` opens a challenge modal backed by a deeply nested iframe hosted on `testmode-acs.stripe.com`.
   - Instead of brittle chained `frameLocator` depths, locate the frame via `page.frames().find(f => f.url().includes('testmode-acs.stripe.com'))` (polling until attached) and click the `"Complete authentication"` button inside that frame.

---

## 8. Maintain Strict Secret & Identifier Hygiene

- **Gitignore `.env` first**: Verify `.env` is listed in `.gitignore` before writing any keys to disk.
- **Zero real keys or IDs in tracked files**: Never commit real keys (`rk_test_...`, `sk_test_...`, `pk_test_...`, `sk_live_...`, `whsec_...`) or real Stripe object IDs (`acct_...`, `prod_...`, `price_...`, `sub_...`, `cs_test_...`) into code, tests, docs, or skills. Use explicit placeholders (`rk_test_replace_me`, `pk_test_replace_me`, `prod_replace_me`, `price_replace_me`).
- **Pre-commit secret scan**:
  ```bash
  grep -rnE '(rk_test_|pk_test_|sk_test_|sk_live_|rk_live_|pk_live_|whsec_)[A-Za-z0-9]{20,}|(acct_|prod_|price_|sub_|cs_test_)[A-Za-z0-9]{10,}' .
  ```
- **Screenshots**: Do not commit screenshots containing real account names, customer emails, or session IDs into the repository.

---

## 9. Production Readiness Checklist

When transitioning from Sandbox to Production:

1. **Live Restricted Key (`rk_live_...`) & Publishable Key (`pk_live_...`)**:
   - Create a Live Restricted Key with minimum required scopes (`Products: Read`, `Checkout Sessions: Write`) and store it in your secret manager.
2. **Recreate Product & Price in Live Mode**:
   - Copy or recreate your Product and recurring/one-time Price in Live mode and update `STRIPE_PRODUCT_ID` / `STRIPE_PRICE_ID`.
3. **Webhooks as the Source of Truth for Email & Fulfillment**:
   - Browser redirects to `return_url` can fail if the customer closes their tab or loses connectivity right after payment.
   - Add a `POST /webhook` route **before** `express.json()` using `express.raw({ type: 'application/json' })` and verify signatures with `stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)`.
   - Fulfill subscriptions/orders and persist `session.customer_details.email` on `checkout.session.completed` (plus `invoice.paid` and `customer.subscription.deleted` for subscription lifecycle).
   - Reference template (untested in the minimal sample app): [webhook.js](resources/webhook.js)
4. **HTTPS `BASE_URL` & `return_url`**:
   - Live mode requires `https://` URLs for `return_url` and webhook endpoints.
5. **Explicit `STRIPE_ENV` Key-Mode Guard**:
   - Replace the sandbox-only guard with an explicit `STRIPE_ENV` check (`test` requires `rk_test_`/`sk_test_` + `pk_test_`; `live` requires `rk_live_`/`sk_live_` + `pk_live_`) so test and live keys can never be mixed.
6. **PII & Idempotency**:
   - Avoid logging raw customer email addresses to unredacted stdout in production logs if subject to GDPR/CCPA; deduplicate webhook processing by `event.id`.
7. **Customer Portal**:
   - Configure the Stripe Billing Customer Portal so subscribers can update payment methods, view invoices, or cancel subscriptions.

For a complete architecture walkthrough and production runbook, see the repository guide at [docs/GUIDE.md](../../../docs/GUIDE.md).
