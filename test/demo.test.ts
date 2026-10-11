import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../src/demo';

describe('demo server', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await createDemoServer().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function post(path: string, body: object) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function newOrder(sku = 'mug') {
    return (await post('/checkout', { sku, quantity: 1 })).body.orderId as string;
  }

  async function orderStatus(id: string) {
    return ((await (await fetch(`${base}/orders/${id}`)).json()) as any).status as string;
  }

  async function scenario(orderId: string, name: string) {
    return (await post('/demo/scenario', { orderId, scenario: name })).body.deliveries as Array<{ status: number; outcome: string | null }>;
  }

  it('serves the demo page', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('payment-webhook-demo');
  });

  it('accepts a validly signed payment through the real webhook route', async () => {
    // Regression test: a JSON body parser in front of /webhook would consume the
    // raw bytes and make every signature check fail, even for valid events.
    const id = await newOrder();
    const [delivery] = await scenario(id, 'pay');
    expect(delivery.status).toBe(200);
    expect(delivery.outcome).toBe('paid');
    expect(await orderStatus(id)).toBe('paid');
  });

  it('rejects a tampered payload and a forged signature', async () => {
    const id = await newOrder();
    expect((await scenario(id, 'tampered'))[0].status).toBe(400);
    expect((await scenario(id, 'wrong_secret'))[0].status).toBe(400);
    expect(await orderStatus(id)).toBe('pending');
  });

  it('flags a wrong amount instead of marking it paid', async () => {
    const id = await newOrder();
    const [delivery] = await scenario(id, 'wrong_amount');
    expect(delivery.outcome).toBe('amount_mismatch');
    expect(await orderStatus(id)).toBe('amount_mismatch');
  });

  it('processes a duplicate event only once', async () => {
    const id = await newOrder();
    const [first, second] = await scenario(id, 'duplicate');
    expect(first.outcome).toBe('paid');
    expect(second.outcome).toBe('duplicate');
  });

  it('completes a delayed payment in two steps', async () => {
    const id = await newOrder();
    const [first, second] = await scenario(id, 'delayed');
    expect(first.outcome).toBe('not_paid_yet');
    expect(second.outcome).toBe('paid');
    expect(await orderStatus(id)).toBe('paid');
  });

  it('keeps a paid order paid when an expiry event arrives', async () => {
    const id = await newOrder();
    await scenario(id, 'pay');
    await scenario(id, 'expire');
    expect(await orderStatus(id)).toBe('paid');
  });

  it('rejects a scenario for an order that does not exist', async () => {
    const res = await post('/demo/scenario', { orderId: 'nope', scenario: 'pay' });
    expect(res.status).toBe(400);
  });
});
