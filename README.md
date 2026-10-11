# payment-webhook-demo

A small **Stripe Checkout (test mode)** backend that does the part most tutorials skip: a **webhook handler you can actually trust**.

Node.js · TypeScript · Express 5 · SQLite · Zod · Vitest

## What it demonstrates

| Concern | How it is handled |
|---|---|
| Fake webhook calls | Every request is verified with Stripe's signature (`Stripe-Signature` + signing secret) before anything is read |
| Duplicate deliveries | Stripe may send an event more than once. Each event id is stored; a repeat is acknowledged (2xx) but not processed again |
| Half-finished handling | The event id and the order update are written in **one SQLite transaction**, so a failure rolls both back and Stripe's retry is handled properly |
| Client-chosen prices | Prices live on the server (`src/catalog.ts`). The request only sends a product key and a quantity |
| Wrong amount charged | On `checkout.session.completed` the paid amount and currency are compared with the order. A mismatch becomes `amount_mismatch`, not `paid` |
| Delayed payment methods | An order is only `paid` when `payment_status === "paid"`. If a session completes before the money arrives (e.g. bank transfer), the order stays `pending` until `checkout.session.async_payment_succeeded` arrives; `async_payment_failed` marks it `failed` |
| Paid is final | Once an order is `paid`, no later event can change its status or overwrite its payment time |
| Retried checkout requests | The order id is sent to Stripe as an idempotency key, so a retried request cannot create a second session |
| Fake "success" redirects | `/success` marks nothing as paid. Only the verified webhook can |
| Raw body requirement | The webhook route reads the raw bytes (registered before `express.json()`), because the signature is computed over the exact payload |
| Live keys by accident | The server refuses to start unless the secret key begins with `sk_test_` |

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/checkout` | Body `{ "sku": "sticker" \| "mug", "quantity": 1-10 }`. Creates a pending order and a Checkout Session, returns `{ orderId, url }` |
| `POST` | `/webhook` | Stripe events (signature required) |
| `GET` | `/orders/:id` | Order status: `pending`, `paid`, `expired`, `failed`, `amount_mismatch` |
| `GET` | `/health` | Liveness check |

## Try it in 30 seconds (no Stripe account needed)

```bash
npm install
npm run demo        # open http://localhost:3000
```

The demo page lets you create an order and then fire webhook scenarios at the real handler: a valid payment, the same event twice, a delayed bank-transfer payment, a tampered payload, a forged signature, a wrong amount, and an expired session. Each response shows the HTTP status and what the handler decided.

Demo mode is honest about what it is: a small simulator stands in for Stripe's hosted Checkout page. **Everything else is the production code**: the same `/webhook` route, Stripe's real signature verification, the same database and order logic.

## Run it with Stripe test mode

You need a free Stripe account (test mode only, no real money) and the [Stripe CLI](https://docs.stripe.com/stripe-cli).

```bash
npm install
cp .env.example .env          # add your sk_test_... key
stripe listen --forward-to localhost:3000/webhook   # prints a whsec_... secret, put it in .env
npm run dev
```

Then create an order and open the returned `url`; pay with Stripe's test card `4242 4242 4242 4242`:

```bash
curl -X POST localhost:3000/checkout -H "content-type: application/json" -d '{"sku":"sticker","quantity":2}'
curl localhost:3000/orders/<orderId>      # becomes "paid" once the webhook arrives
```

## Tests

```bash
npm test         # 32 tests
npm run typecheck
```

The tests sign payloads with Stripe's own signature routine (`generateTestHeaderString`) and replace only the call that creates a Checkout Session with a fake. They cover: wrong secret, tampered payload, missing signature, duplicate delivery, amount mismatch, unpaid and delayed-payment sessions, expired and failed sessions, paid orders staying paid, idempotency keys, unknown events/orders, and server-side pricing. A second suite drives the demo server end to end, including a regression test for the raw-body pitfall described above.

## What is and is not verified

Being upfront about this:

- **Verified automatically:** the logic above, including real Stripe signature verification, run in CI on every push. The tests were also checked by deliberately breaking the code (removing the amount check, the duplicate-event check, the signature check, the paid-is-final guard and the idempotency key): the relevant tests fail each time.
- **Not run in CI:** a real end-to-end payment against Stripe's test servers. That needs a Stripe account and the CLI, so follow the steps above to try it yourself.

## Possible next steps

- Refund and dispute events (`charge.refunded`, `charge.dispute.created`)
- Replace SQLite with Postgres and add migrations
- Send a confirmation email after an order becomes `paid`

## License

MIT
