import express from 'express';
import Stripe from 'stripe';

export const DEMO_WEBHOOK_SECRET = 'whsec_demo_only';

export interface Delivery {
  label: string;
  status: number;
  outcome: string | null;
  note: string;
}

// Sends a raw payload + signature header to the real /webhook route.
export type Deliver = (payload: string, signatureHeader: string) => Promise<{ status: number; outcome: string | null }>;

interface SimSession {
  amount: number;
  currency: string;
}

/**
 * A stand-in for Stripe, used only by the demo. It replaces the single call that
 * creates a Checkout Session. Everything else is real: the webhook route is the
 * production one, and events are signed and verified with Stripe's own code.
 */
export function createSimulator(deliver: Deliver) {
  const stripe = new Stripe('sk_test_demo');
  const sessions = new Map<string, SimSession>();
  let counter = 0;

  (stripe.checkout.sessions as unknown as { create: (p: Stripe.Checkout.SessionCreateParams) => Promise<unknown> }).create =
    async (params) => {
      const orderId = String(params.client_reference_id);
      const item = params.line_items![0];
      sessions.set(orderId, {
        amount: item.price_data!.unit_amount! * (item.quantity ?? 1),
        currency: item.price_data!.currency,
      });
      counter += 1;
      return { id: `cs_demo_${counter}`, url: `/?pay=${orderId}` };
    };

  let eventCounter = 0;
  const makeEvent = (
    type: string,
    orderId: string,
    over: { amount_total?: number; payment_status?: string; id?: string } = {}
  ) => {
    const s = sessions.get(orderId);
    eventCounter += 1;
    return {
      id: over.id ?? `evt_demo_${eventCounter}`,
      object: 'event',
      type,
      data: {
        object: {
          id: 'cs_demo',
          object: 'checkout.session',
          client_reference_id: orderId,
          amount_total: over.amount_total ?? s?.amount ?? 0,
          currency: s?.currency ?? 'usd',
          payment_status: over.payment_status ?? 'paid',
        },
      },
    };
  };

  const send = async (event: object, label: string, note: string, secret = DEMO_WEBHOOK_SECRET, mutate?: (p: string) => string): Promise<Delivery> => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const result = await deliver(mutate ? mutate(payload) : payload, header);
    return { label, status: result.status, outcome: result.outcome, note };
  };

  // express.json() is attached to this one route only. If it ran for every request,
  // it would also consume the body of POST /webhook before the webhook route
  // could read the raw bytes, and every signature check would fail.
  const router = express.Router();

  router.post('/demo/scenario', express.json(), async (req, res) => {
    const { orderId, scenario } = req.body as { orderId?: string; scenario?: string };
    if (!orderId || !sessions.has(orderId)) {
      res.status(400).json({ error: 'Create an order first' });
      return;
    }
    const deliveries: Delivery[] = [];
    switch (scenario) {
      case 'pay':
        deliveries.push(await send(makeEvent('checkout.session.completed', orderId), 'Valid payment', 'Signature verified, amount matches: the order becomes paid.'));
        break;
      case 'duplicate': {
        const event = makeEvent('checkout.session.completed', orderId);
        deliveries.push(await send(event, 'Delivery 1', 'First delivery of this event.'));
        deliveries.push(await send(event, 'Delivery 2 (same event)', 'Same event id again: acknowledged but not processed twice.'));
        break;
      }
      case 'tampered':
        deliveries.push(
          await send(makeEvent('checkout.session.completed', orderId), 'Tampered payload', 'Body changed after signing: rejected, nothing happens.', DEMO_WEBHOOK_SECRET, (p) => p.replace('"paid"', '"pad"'))
        );
        break;
      case 'wrong_secret':
        deliveries.push(await send(makeEvent('checkout.session.completed', orderId), 'Forged signature', 'Signed with the wrong secret: rejected.', 'whsec_attacker'));
        break;
      case 'wrong_amount':
        deliveries.push(await send(makeEvent('checkout.session.completed', orderId, { amount_total: 1 }), 'Wrong amount', 'Validly signed, but Stripe says 1 cent was paid: flagged, not paid.'));
        break;
      case 'delayed':
        deliveries.push(await send(makeEvent('checkout.session.completed', orderId, { payment_status: 'unpaid' }), 'Completed, money not yet arrived', 'Delayed method (e.g. bank transfer): the order stays pending.'));
        deliveries.push(await send(makeEvent('checkout.session.async_payment_succeeded', orderId), 'Async payment succeeded', 'The money arrived: now the order becomes paid.'));
        break;
      case 'expire':
        deliveries.push(await send(makeEvent('checkout.session.expired', orderId), 'Session expired', 'The customer never paid: the order becomes expired.'));
        break;
      default:
        res.status(400).json({ error: 'Unknown scenario' });
        return;
    }
    res.json({ deliveries });
  });

  return { stripe, router };
}
