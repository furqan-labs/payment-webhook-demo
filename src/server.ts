import 'dotenv/config';
import Stripe from 'stripe';
import { createApp } from './app';
import { OrderStore } from './store';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in (test-mode keys only).`);
    process.exit(1);
  }
  return value;
}

const secretKey = required('STRIPE_SECRET_KEY');
if (!secretKey.startsWith('sk_test_')) {
  console.error('Refusing to start: this demo only runs with Stripe TEST keys (sk_test_...).');
  process.exit(1);
}

const app = createApp({
  stripe: new Stripe(secretKey),
  store: new OrderStore(process.env.DATABASE_PATH ?? 'orders.sqlite'),
  webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  baseUrl: process.env.BASE_URL ?? 'http://localhost:3000',
  log: (message) => console.log(message),
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
