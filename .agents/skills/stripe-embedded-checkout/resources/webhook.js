/**
 * Production Webhook Handler Reference (UNTESTED in the minimal sandbox sample app).
 *
 * Mount this route BEFORE `app.use(express.json())` so `req.body` remains a raw Buffer
 * required by `stripe.webhooks.constructEvent`.
 */
const express = require('express');

function createWebhookRouter(stripe, webhookSecret, onCheckoutCompleted) {
  const router = express.Router();

  router.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const signature = req.headers['stripe-signature'];
      if (!signature || !webhookSecret) {
        return res.status(400).send('Missing stripe-signature header or webhook secret.');
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
      } catch (err) {
        console.error('[Webhook Signature Verification Failed]:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      try {
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const customerEmail =
            session.customer_details?.email ?? session.customer_email ?? null;
          const subscriptionId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id ?? null;

          // Fulfill the order/subscription and store customerEmail idempotently (keyed by event.id or session.id)
          if (typeof onCheckoutCompleted === 'function') {
            await onCheckoutCompleted({
              eventId: event.id,
              sessionId: session.id,
              customerEmail,
              subscriptionId,
              paymentStatus: session.payment_status,
            });
          }
        }

        return res.status(200).json({ received: true });
      } catch (err) {
        console.error('[Webhook Handler Error]:', err.message);
        return res.status(500).json({ error: 'Webhook handler failed.' });
      }
    }
  );

  return router;
}

module.exports = { createWebhookRouter };
