import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CATALOG } from './catalog';
import type { OrderStore } from './store';

export interface AppDeps {
  stripe: Stripe;
  store: OrderStore;
  webhookSecret: string;
  baseUrl: string;
  log?: (message: string) => void;
}

const checkoutBody = z.object({
  sku: z.enum(Object.keys(CATALOG) as [string, ...string[]]),
  quantity: z.number().int().min(1).max(10).default(1),
});

export function createApp({ stripe, store, webhookSecret, baseUrl, log = () => {} }: AppDeps) {
  const app = express();

  const findOrder = (session: Stripe.Checkout.Session) =>
    session.client_reference_id ? store.getOrder(session.client_reference_id) : null;

  // Decides whether a finished checkout session means "paid".
  const settleSession = (session: Stripe.Checkout.Session): string => {
    const order = findOrder(session);
    if (!order) return 'unknown_order';
    if (order.status === 'paid') return 'already_paid';
    // Delayed payment methods can complete the session before money arrives.
    if (session.payment_status !== 'paid') return 'not_paid_yet';
    // Never trust the order blindly: confirm Stripe charged what we expected.
    const matches = session.amount_total === order.amount && session.currency === order.currency;
    store.setStatus(order.id, matches ? 'paid' : 'amount_mismatch');
    return matches ? 'paid' : 'amount_mismatch';
  };

  // IMPORTANT: the webhook route must receive the RAW request body, because the
  // signature is computed over the exact bytes Stripe sent. If express.json()
  // ran first, the body would be re-serialised and verification would fail.
  // That is why this route is registered before express.json().
  app.post('/webhook', express.raw({ type: 'application/json' }), (req: Request, res: Response) => {
    const signature = req.header('stripe-signature');
    if (!signature) {
      res.status(400).json({ error: 'Missing Stripe-Signature header' });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch {
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    // Handle the event and record its id in ONE transaction. If anything below
    // throws, the event id is rolled back too, so Stripe's retry is processed
    // properly instead of being mistaken for a duplicate.
    const outcome = store.runInTransaction(() => {
      if (!store.recordEvent(event.id, event.type)) return 'duplicate';

      switch (event.type) {
        // "completed" fires when the customer finishes checkout. For cards the
        // money is already there; for delayed methods (e.g. bank transfer) it is
        // not, and "async_payment_succeeded" follows later.
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          return settleSession(event.data.object as Stripe.Checkout.Session);

        case 'checkout.session.async_payment_failed': {
          const order = findOrder(event.data.object as Stripe.Checkout.Session);
          if (!order) return 'unknown_order';
          return store.setStatus(order.id, 'failed') ? 'failed' : 'already_paid';
        }

        case 'checkout.session.expired': {
          const order = findOrder(event.data.object as Stripe.Checkout.Session);
          if (order && order.status === 'pending') store.setStatus(order.id, 'expired');
          return 'expired';
        }

        default:
          return 'ignored';
      }
    });

    log(`webhook ${event.type} ${event.id} -> ${outcome}`);
    // 2xx tells Stripe "received"; non-2xx makes it retry. Unknown/ignored events are still 2xx.
    res.status(200).json({ received: true, outcome });
  });

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/checkout', async (req: Request, res: Response) => {
    const parsed = checkoutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const { sku, quantity } = parsed.data;
    const product = CATALOG[sku];
    const orderId = randomUUID();
    const amount = product.unitAmount * quantity;

    store.createOrder({ id: orderId, sku, quantity, amount, currency: product.currency });

    try {
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              quantity,
              price_data: {
                currency: product.currency,
                unit_amount: product.unitAmount,
                product_data: { name: product.name },
              },
            },
          ],
          client_reference_id: orderId,
          success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl}/cancel`,
        },
        // If the same request is retried (e.g. after a network error), Stripe
        // returns the original session instead of creating a second one.
        { idempotencyKey: orderId }
      );
      store.attachSession(orderId, session.id);
      res.status(201).json({ orderId, url: session.url });
    } catch {
      store.setStatus(orderId, 'failed');
      res.status(502).json({ error: 'Could not create a payment session' });
    }
  });

  app.get('/orders/:id', (req: Request, res: Response) => {
    const order = store.getOrder(String(req.params.id));
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(order);
  });

  // The success page is only a friendly landing page. It does NOT mark anything
  // as paid: the browser redirect can be skipped, replayed or faked.
  // Only the verified webhook changes an order to "paid".
  app.get('/success', (_req, res) => {
    res.send('Thanks! Your payment is being confirmed. Check GET /orders/:id for the status.');
  });
  app.get('/cancel', (_req, res) => {
    res.send('Payment cancelled. You have not been charged.');
  });

  // Last-resort error handler so an unexpected error never leaks internals.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log(`unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
