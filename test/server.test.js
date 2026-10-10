require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const Stripe = require('stripe');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function spawnServer(envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Server timed out starting. stdout=${stdout} stderr=${stderr}`));
    }, 15000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('Stripe Embedded Checkout server listening')) {
        clearTimeout(timeout);
        resolve({ child, stdout, stderr });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(
        Object.assign(new Error(`Server exited early with code ${code}: ${stderr}`), {
          code,
          stdout,
          stderr,
        })
      );
    });
  });
}

let serverProcess = null;
let baseUrl = '';
const createdSessionIds = [];

before(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const started = await spawnServer({
    PORT: String(port),
    BASE_URL: baseUrl,
  });
  serverProcess = started.child;
});

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => serverProcess.once('exit', resolve));
  }

  for (const sessionId of createdSessionIds) {
    try {
      await stripe.checkout.sessions.expire(sessionId);
    } catch (err) {
      console.warn(`Warning: failed to expire session ${sessionId}:`, err.message);
    }
  }
});

test('GET / and /return.html serve static HTML pages', async () => {
  const indexRes = await fetch(`${baseUrl}/`);
  assert.equal(indexRes.status, 200);
  const indexHtml = await indexRes.text();
  assert.match(indexHtml, /email-form/);
  assert.match(indexHtml, /https:\/\/js\.stripe\.com\/v3\//);

  const returnRes = await fetch(`${baseUrl}/return.html`);
  assert.equal(returnRes.status, 200);
  const returnHtml = await returnRes.text();
  assert.match(returnHtml, /customer-email/);
});

test('GET /config returns publishable pk_test_ key and resolved plan metadata', async () => {
  const res = await fetch(`${baseUrl}/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.publishableKey, 'string');
  assert.match(body.publishableKey, /^pk_test_/);
  assert.equal(typeof body.productName, 'string');
  assert.ok(body.productName.length > 0);
  assert.equal(typeof body.displayPrice, 'string');
  assert.ok(body.displayPrice.length > 0);
  assert.equal(typeof body.unitAmount, 'number');
  assert.equal(typeof body.currency, 'string');
  assert.equal(typeof body.interval, 'string');
});

test('POST /create-checkout-session rejects missing or invalid email with 400', async () => {
  for (const badBody of [{}, { email: '' }, { email: 'not-an-email' }, { email: 'missing@domain' }]) {
    const res = await fetch(`${baseUrl}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(badBody),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(typeof data.error, 'string');
  }
});

test('POST /create-checkout-session with valid email creates sandbox embedded session and GET /session-status returns open session with customer_email', async () => {
  const testEmail = 'buyer+sandbox@example.com';

  const createRes = await fetch(`${baseUrl}/create-checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail }),
  });
  assert.equal(createRes.status, 200);
  const createBody = await createRes.json();
  assert.equal(typeof createBody.clientSecret, 'string');
  assert.match(createBody.clientSecret, /^cs_test_[a-zA-Z0-9]+_secret_/);

  const sessionId = createBody.sessionId || createBody.clientSecret.split('_secret_')[0];
  assert.match(sessionId, /^cs_test_/);
  createdSessionIds.push(sessionId);

  const statusRes = await fetch(
    `${baseUrl}/session-status?session_id=${encodeURIComponent(sessionId)}`
  );
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.status, 'open');
  assert.equal(statusBody.customer_email, testEmail);
});

test('GET /session-status with missing session_id returns 400', async () => {
  const res = await fetch(`${baseUrl}/session-status`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('GET /session-status with bogus session_id returns 4xx/5xx JSON error and server stays alive', async () => {
  const res = await fetch(`${baseUrl}/session-status?session_id=cs_test_bogus_does_not_exist_12345`);
  assert.ok(res.status >= 400 && res.status < 600, `Expected 4xx/5xx, got ${res.status}`);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');

  const healthRes = await fetch(`${baseUrl}/config`);
  assert.equal(healthRes.status, 200);
});

const { isStripePermissionError } = require('../server');

test('Sandbox guard refuses to start when non-test keys are configured', async () => {
  const port = await getFreePort();
  await assert.rejects(
    () =>
      spawnServer({
        PORT: String(port),
        STRIPE_SECRET_KEY: 'sk_live_forbidden_key',
      }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /sandbox only/i);
      return true;
    }
  );

  await assert.rejects(
    () =>
      spawnServer({
        PORT: String(port),
        STRIPE_PUBLISHABLE_KEY: 'pk_live_forbidden_key',
      }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /sandbox only/i);
      return true;
    }
  );
});

test('isStripePermissionError detects Stripe permission error variants', () => {
  assert.equal(
    isStripePermissionError({ type: 'StripePermissionError', message: 'Forbidden' }),
    true
  );
  assert.equal(isStripePermissionError({ statusCode: 403, message: 'Forbidden' }), true);
  assert.equal(
    isStripePermissionError({
      type: 'invalid_request_error',
      message: 'This key does not have the required permissions for this endpoint.',
    }),
    true
  );
  assert.equal(
    isStripePermissionError({
      type: 'StripeInvalidRequestError',
      message: 'No such checkout.session: cs_test_bogus',
    }),
    false
  );
});

