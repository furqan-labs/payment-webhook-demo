import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../src/app';
import { OrderStore } from '../src/store';

const WEBHOOK_SECRET = 'whsec_test_secret';

// A real Stripe client object, never used for network calls in these tests.
// Only `checkout.sessions.create` is replaced with a fake; signature
// verification below uses Stripe's real, offline implementation.
const stripe = new Stripe('sk_test_dummy');

function signedPayload(event: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function sessionEvent(
  type:
    | 'checkout.session.completed'
    | 'checkout.session.expired'
    | 'checkout.session.async_payment_succeeded'
    | 'checkout.session.async_payment_failed',
  orderId: string,
  overrides: { id?: string; amount_total?: number; currency?: string; payment_status?: string } = {}
) {
  return {
    id: overrides.id ?? 'evt_1',
    object: 'event',
    type,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        client_reference_id: orderId,
        amount_total: overrides.amount_total ?? 1000,
        currency: overrides.currency ?? 'usd',
        payment_status: overrides.payment_status ?? 'paid',
      },
    },
  };
}

describe('payment webhook demo', () => {
  let store: OrderStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new OrderStore(':memory:');
    app = createApp({ stripe, store, webhookSecret: WEBHOOK_SECRET, baseUrl: 'http://localhost:3000' });
    vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    } as Stripe.Response<Stripe.Checkout.Session>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
  });

  async function createOrder(sku = 'sticker', quantity = 2) {
    const res = await request(app).post('/checkout').send({ sku, quantity });
    return res.body.orderId as string;
  }

  describe('POST /checkout', () => {
    it('rejects an unknown product', async () => {
      const res = await request(app).post('/checkout').send({ sku: 'yacht' });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid quantity', async () => {
      const res = await request(app).post('/checkout').send({ sku: 'mug', quantity: 0 });
      expect(res.status).toBe(400);
    });

    it('creates a pending order and a Stripe session with the server-side price', async () => {
      const res = await request(app).post('/checkout').send({ sku: 'sticker', quantity: 2 });
      expect(res.status).toBe(201);
      expect(res.body.url).toContain('checkout.stripe.com');

      const order = store.getOrder(res.body.orderId)!;
      expect(order.status).toBe('pending');
      expect(order.amount).toBe(1000); // 2 x 500, calculated on the server
      expect(order.sessionId).toBe('cs_test_1');

      const args = vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0]!;
      expect(args.client_reference_id).toBe(order.id);
      expect(args.line_items![0].price_data!.unit_amount).toBe(500);
    });

    it('ignores any price sent by the client', async () => {
      const res = await request(app).post('/checkout').send({ sku: 'sticker', quantity: 1, amount: 1 });
      expect(store.getOrder(res.body.orderId)!.amount).toBe(500);
    });

    it('returns 502 when Stripe cannot create the session', async () => {
      vi.mocked(stripe.checkout.sessions.create).mockRejectedValueOnce(new Error('network down'));
      const res = await request(app).post('/checkout').send({ sku: 'mug' });
      expect(res.status).toBe(502);
    });

    it('marks the order as failed when Stripe cannot create the session', async () => {
      const createOrder = vi.spyOn(store, 'createOrder');
      vi.mocked(stripe.checkout.sessions.create).mockRejectedValueOnce(new Error('network down'));
      await request(app).post('/checkout').send({ sku: 'mug' });
      const orderId = createOrder.mock.calls[0][0].id;
      expect(store.getOrder(orderId)!.status).toBe('failed');
    });

    it('passes the order id to Stripe as an idempotency key', async () => {
      const res = await request(app).post('/checkout').send({ sku: 'mug' });
      const options = vi.mocked(stripe.checkout.sessions.create).mock.calls[0][1];
      expect(options).toEqual({ idempotencyKey: res.body.orderId });
    });
  });

  describe('POST /webhook', () => {
    it('rejects a request without a signature', async () => {
      const res = await request(app).post('/webhook').set('content-type', 'application/json').send('{}');
      expect(res.status).toBe(400);
    });

    it('rejects a payload signed with the wrong secret', async () => {
      const orderId = await createOrder();
      const { payload, header } = signedPayload(sessionEvent('checkout.session.completed', orderId), 'whsec_attacker');
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', header)
        .send(payload);
      expect(res.status).toBe(400);
      expect(store.getOrder(orderId)!.status).toBe('pending');
    });

    it('rejects a payload that was modified after signing', async () => {
      const orderId = await createOrder();
      const { payload, header } = signedPayload(sessionEvent('checkout.session.completed', orderId));
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', header)
        .send(payload.replace('"usd"', '"eur"'));
      expect(res.status).toBe(400);
      expect(store.getOrder(orderId)!.status).toBe('pending');
    });

    it('marks the order as paid on a valid completed event', async () => {
      const orderId = await createOrder(); // 1000
      const { payload, header } = signedPayload(sessionEvent('checkout.session.completed', orderId));
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', header)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('paid');
      const order = store.getOrder(orderId)!;
      expect(order.status).toBe('paid');
      expect(order.paidAt).not.toBeNull();
    });

    it('handles a duplicate delivery of the same event only once', async () => {
      const orderId = await createOrder();
      const { payload, header } = signedPayload(sessionEvent('checkout.session.completed', orderId));
      const send = () =>
        request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', header).send(payload);

      const first = await send();
      const second = await send();
      expect(first.body.outcome).toBe('paid');
      expect(second.status).toBe(200); // still 2xx so Stripe stops retrying
      expect(second.body.outcome).toBe('duplicate');
    });

    it('flags an order when the paid amount does not match', async () => {
      const orderId = await createOrder(); // expects 1000
      const { payload, header } = signedPayload(sessionEvent('checkout.session.completed', orderId, { amount_total: 100 }));
      await request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', header).send(payload);
      expect(store.getOrder(orderId)!.status).toBe('amount_mismatch');
    });

    it('does not mark the order as paid while the payment is still unpaid', async () => {
      const orderId = await createOrder();
      const { payload, header } = signedPayload(
        sessionEvent('checkout.session.completed', orderId, { payment_status: 'unpaid' })
      );
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', header)
        .send(payload);
      expect(res.body.outcome).toBe('not_paid_yet');
      expect(store.getOrder(orderId)!.status).toBe('pending');
    });

    it('marks a pending order as expired', async () => {
      const orderId = await createOrder();
      const { payload, header } = signedPayload(sessionEvent('checkout.session.expired', orderId));
      await request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', header).send(payload);
      expect(store.getOrder(orderId)!.status).toBe('expired');
    });

    it('does not turn a paid order into expired', async () => {
      const orderId = await createOrder();
      const paid = signedPayload(sessionEvent('checkout.session.completed', orderId, { id: 'evt_paid' }));
      await request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', paid.header).send(paid.payload);
      const expired = signedPayload(sessionEvent('checkout.session.expired', orderId, { id: 'evt_expired' }));
      await request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', expired.header).send(expired.payload);
      expect(store.getOrder(orderId)!.status).toBe('paid');
    });

    it('marks a delayed-payment order as paid when the async payment succeeds', async () => {
      const orderId = await createOrder();
      const send = (e: object) => {
        const { payload, header } = signedPayload(e);
        return request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', header).send(payload);
      };

      const first = await send(sessionEvent('checkout.session.completed', orderId, { id: 'evt_a', payment_status: 'unpaid' }));
      expect(first.body.outcome).toBe('not_paid_yet');
      expect(store.getOrder(orderId)!.status).toBe('pending');

      const second = await send(sessionEvent('checkout.session.async_payment_succeeded', orderId, { id: 'evt_b' }));
      expect(second.body.outcome).toBe('paid');
      expect(store.getOrder(orderId)!.status).toBe('paid');
    });

    it('marks an order as failed when the async payment fails', async () => {
      const orderId = await createOrder();
      const { payload, header } = signedPayload(sessionEvent('checkout.session.async_payment_failed', orderId));
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', header)
        .send(payload);
      expect(res.body.outcome).toBe('failed');
      expect(store.getOrder(orderId)!.status).toBe('failed');
    });

    it('never downgrades a paid order, even if a later event looks wrong', async () => {
      const orderId = await createOrder(); // expects 1000
      const send = (e: object) => {
        const { payload, header } = signedPayload(e);
        return request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', header).send(payload);
      };

      await send(sessionEvent('checkout.session.completed', orderId, { id: 'evt_ok' }));
      const bad = await send(sessionEvent('checkout.session.completed', orderId, { id: 'evt_bad', amount_total: 1 }));
      const failed = await send(sessionEvent('checkout.session.async_payment_failed', orderId, { id: 'evt_fail' }));

      expect(bad.body.outcome).toBe('already_paid');
      expect(failed.body.outcome).toBe('already_paid');
      expect(store.getOrder(orderId)!.status).toBe('paid');
    });

    it('keeps the original payment time when a second paid event arrives', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const orderId = await createOrder();
        const send = (e: object) => {
          const { payload, header } = signedPayload(e);
          return request(app).post('/webhook').set('content-type', 'application/json').set('stripe-signature', header).send(payload);
        };

        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        await send(sessionEvent('checkout.session.completed', orderId, { id: 'evt_1' }));
        vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
        await send(sessionEvent('checkout.session.async_payment_succeeded', orderId, { id: 'evt_2' }));

        expect(store.getOrder(orderId)!.paidAt).toBe('2026-01-01T00:00:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns 200 for an event type it does not handle', async () => {
      const { payload, header } = signedPayload({ id: 'evt_x', object: 'event', type: 'customer.created', data: { object: {} } });
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', header)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('ignored');
    });

    it('returns 200 for a completed event about an unknown order', async () => {
      const { payload, header } = signedPayload(sessionEvent('checkout.session.completed', 'does-not-exist'));
      const res = await request(app)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', header)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('unknown_order');
    });
  });

  describe('GET /orders/:id', () => {
    it('returns the order, or 404', async () => {
      const orderId = await createOrder();
      expect((await request(app).get(`/orders/${orderId}`)).body.status).toBe('pending');
      expect((await request(app).get('/orders/nope')).status).toBe(404);
    });
  });

  it('the success redirect page does not mark anything as paid', async () => {
    const orderId = await createOrder();
    await request(app).get('/success?session_id=cs_test_1');
    expect(store.getOrder(orderId)!.status).toBe('pending');
  });
});
