require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const PRODUCT_ID = process.env.STRIPE_PRODUCT_ID || '';
const FALLBACK_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const CHECKOUT_MODE = process.env.STRIPE_CHECKOUT_MODE || 'subscription';
const PORT = Number(process.env.PORT) || 4242;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

function validateSandboxConfig() {
  if (!SECRET_KEY || (!SECRET_KEY.startsWith('rk_test_') && !SECRET_KEY.startsWith('sk_test_'))) {
    console.error(
      'Fatal: STRIPE_SECRET_KEY must be set and start with "rk_test_" or "sk_test_" (sandbox only).'
    );
    process.exit(1);
  }
  if (!PUBLISHABLE_KEY || !PUBLISHABLE_KEY.startsWith('pk_test_')) {
    console.error(
      'Fatal: STRIPE_PUBLISHABLE_KEY must be set and start with "pk_test_" (sandbox only).'
    );
    process.exit(1);
  }
  if (!PRODUCT_ID && !FALLBACK_PRICE_ID) {
    console.error('Fatal: Either STRIPE_PRODUCT_ID or STRIPE_PRICE_ID must be set.');
    process.exit(1);
  }
}

function isStripePermissionError(err) {
  if (!err) return false;
  if (err.type === 'StripePermissionError' || err.rawType === 'permission_error') return true;
  if (err.statusCode === 403 || err.status === 403) return true;
  const rawType = err.raw?.type || err.type || '';
  const msg = String(err.message || '').toLowerCase();
  if (
    (rawType === 'invalid_request_error' || rawType === 'StripeInvalidRequestError') &&
    msg.includes('permission')
  ) {
    return true;
  }
  return msg.includes('does not have the required permissions');
}

function handleStripeError(res, err, context) {
  if (isStripePermissionError(err)) {
    console.error(`[STRIPE PERMISSION ERROR] (${context}):`, err.message);
    return res.status(err.statusCode || 403).json({
      error: err.message,
      code: 'stripe_permission',
    });
  }
  const status =
    typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;
  console.error(`[Stripe Error] (${context}):`, err.message);
  return res.status(status).json({
    error: err.message || 'An unexpected error occurred.',
  });
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

validateSandboxConfig();

const stripe = new Stripe(SECRET_KEY);
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let resolvedPriceId = null;

async function resolveDefaultPriceId() {
  if (PRODUCT_ID) {
    const product = await stripe.products.retrieve(PRODUCT_ID);
    const defaultPrice = product.default_price;
    if (typeof defaultPrice === 'string' && defaultPrice.startsWith('price_')) {
      return defaultPrice;
    }
    if (defaultPrice && typeof defaultPrice === 'object' && typeof defaultPrice.id === 'string') {
      return defaultPrice.id;
    }
  }
  if (FALLBACK_PRICE_ID && FALLBACK_PRICE_ID.startsWith('price_')) {
    return FALLBACK_PRICE_ID;
  }
  throw new Error(
    `Could not resolve a default_price from product "${PRODUCT_ID}" and no valid STRIPE_PRICE_ID fallback was provided.`
  );
}

app.get('/config', (_req, res) => {
  res.json({ publishableKey: PUBLISHABLE_KEY });
});

app.post('/create-checkout-session', async (req, res) => {
  const rawEmail = req.body?.email;
  if (!isValidEmail(rawEmail)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  const email = rawEmail.trim();

  try {
    if (!resolvedPriceId) {
      resolvedPriceId = await resolveDefaultPriceId();
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded_page',
      mode: CHECKOUT_MODE,
      customer_email: email,
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      return_url: `${BASE_URL}/return.html?session_id={CHECKOUT_SESSION_ID}`,
    });

    return res.status(200).json({
      clientSecret: session.client_secret,
      sessionId: session.id,
    });
  } catch (err) {
    return handleStripeError(res, err, 'POST /create-checkout-session');
  }
});

app.get('/session-status', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'Missing required session_id query parameter.' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId.trim());
    const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;
    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id ?? null;

    if (session.status === 'complete') {
      console.log(
        `[Checkout Complete] session_id=${session.id} customer_email=${customerEmail} subscription_id=${subscriptionId}`
      );
    }

    return res.status(200).json({
      status: session.status,
      payment_status: session.payment_status,
      customer_email: customerEmail,
    });
  } catch (err) {
    return handleStripeError(res, err, 'GET /session-status');
  }
});

async function start() {
  try {
    resolvedPriceId = await resolveDefaultPriceId();
    console.log(`Resolved price ID: ${resolvedPriceId}`);
  } catch (err) {
    handleStripeError({ status: () => ({ json: () => {} }) }, err, 'startup');
    process.exit(1);
  }

  return app.listen(PORT, () => {
    console.log(`Stripe Embedded Checkout server listening on ${BASE_URL} (port ${PORT})`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start, validateSandboxConfig, isStripePermissionError, isValidEmail };
