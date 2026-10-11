import express from 'express';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { OrderStore } from './store';
import { createSimulator, DEMO_WEBHOOK_SECRET } from './demo/simulator';

/**
 * Demo server: the real app (checkout + verified webhook) wired to a Stripe
 * simulator, with a page that lets you trigger webhook scenarios by hand.
 * No Stripe account or keys are needed.
 */
export function createDemoServer() {
  let port = 0;
  const { stripe, router } = createSimulator(async (payload, header) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: payload,
    });
    const body = (await res.json().catch(() => ({}))) as { outcome?: string };
    return { status: res.status, outcome: body.outcome ?? null };
  });

  const app = createApp({
    stripe,
    store: new OrderStore(':memory:'),
    webhookSecret: DEMO_WEBHOOK_SECRET,
    baseUrl: '',
  });

  const server = express();
  server.use(router);
  server.use(express.static(path.join(__dirname, '..', 'public')));
  server.use(app);

  return {
    server,
    listen(p: number) {
      return new Promise<ReturnType<typeof server.listen>>((resolve) => {
        const s = server.listen(p, () => {
          port = (s.address() as AddressInfo).port;
          resolve(s);
        });
      });
    },
  };
}

if (require.main === module) {
  const wanted = Number(process.env.PORT ?? 3000);
  createDemoServer()
    .listen(wanted)
    .then((s) => console.log(`Demo running on http://localhost:${(s.address() as AddressInfo).port}`));
}
