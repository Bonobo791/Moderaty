# Stripe Checkout + Webhooks for Prepaid Comment Credits — Research Note

> Implementation-ready reference for Moderaty (SvelteKit 2 + Netlify Functions, one-time credit purchases). Verified against primary sources (docs.stripe.com API reference + guides, stripe-node SDK README, SvelteKit docs, Netlify docs); each claim cites its source URL.

## 1. Checkout Sessions (`mode=payment`) — server-side creation

- REST: `POST /v1/checkout/sessions` (https://docs.stripe.com/api/checkout/sessions/create). SDK: `await stripe.checkout.sessions.create(params, options?)` returns a Promise; client is `new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion, maxNetworkRetries })` — server-side JS only (https://github.com/stripe/stripe-node#readme).

```ts
const session = await stripe.checkout.sessions.create({
  mode: 'payment',                    // required: one-time payment
  line_items: [{ price: 'price_1...', quantity: 1 }], // required in payment mode (price_id or price_data; max 100 items)
  success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
  customer: 'cus_...',                // optional: prefill; Customer created when customer_creation=always
  customer_email: 'buyer@example.com',// optional prefill
  client_reference_id: 'org_123:bundle_500', // ≤200 chars, reconcile with your DB
  metadata: { org_id: 'org_123', bundle_id: 'bundle_500', credits: '500' },
  // automatic_tax: { enabled: true },   // §5
});
// redirect buyer to session.url
```

- Key params (https://docs.stripe.com/api/checkout/sessions/create): `mode` (`payment` = one-time; cards, iDEAL, more); `line_items` (required in payment mode, max 100); `success_url` (hosted page; supports `{CHECKOUT_SESSION_ID}` placeholder — https://docs.stripe.com/payments/checkout/fulfillment); `return_url` (required **only** for `ui_mode=embedded_page|elements`, not for default hosted page); `client_reference_id` (≤200 chars, "used to reconcile the session with your internal systems"); `customer` / `customer_email` / `customer_creation` (`if_required` default | `always` — `always` needed for Stripe Tax on new customers); `metadata`; `ui_mode` (default `hosted_page`).
- Metadata limits: ≤50 keys, key names ≤40 chars, values ≤500 chars, no `[`/`]` in keys, no sensitive data (https://docs.stripe.com/api/metadata).
- Response fields you rely on: `url` (redirect target), `id` (`cs_...`), `payment_status` (`unpaid|paid|no_payment_required`), `customer`, `customer_details`, `amount_total`, `total_details.amount_tax` (https://docs.stripe.com/api/checkout/sessions/create, https://docs.stripe.com/tax/checkout/page).

## 2. `checkout.session.completed` webhook flow — crediting reliably

Stripe's official fulfillment/"payment success" guide: https://docs.stripe.com/payments/checkout/fulfillment.

- **Webhooks are required for fulfillment**: "webhooks provide the most reliable way to confirm when you receive a payment. If the delivery of a webhook event fails, Stripe retries several times." The success-page redirect is insufficient (buyer can lose connectivity). Recommended = automatic fulfillment via webhook handler + a `fulfill_checkout(session_id)` function.
- **`fulfill_checkout` must be idempotent** — "might be called multiple times, possibly concurrently, for the same Checkout Session." It must: accept a session ID; retrieve the session with `line_items` expanded; check `payment_status` ≠ `unpaid`; fulfill line items; **record fulfillment status for the session** (your DB is the dedupe anchor).
- **Events**: handle `checkout.session.completed` **and** `checkout.session.async_payment_succeeded` → both call `fulfill_checkout(event.data.object.id)`; optionally `checkout.session.async_payment_failed` to notify the customer.
- **Delayed-notification methods** (ACH, SEPA, Bacs, bank transfers, vouchers): "the funds will not be immediately available when Checkout is completed... generate a `checkout.session.async_payment_succeeded` event when the payment succeeds later. The status of the object remains `processing` until... succeeded or failed." Official definitions (https://docs.stripe.com/api/events/types): `checkout.session.completed` = "Occurs when a Checkout Session has been successfully completed"; `async_payment_succeeded` = "...using a delayed payment method finally succeeds"; `async_payment_failed` = "...fails"; `checkout.session.expired` = "Occurs when a Checkout Session is expired." Cards-only → `checkout.session.completed` alone suffices; subscribing to async events is cheap insurance.
- **Duplicates**: "webhook endpoints can receive the same event more than once... record the event IDs you've processed and don't process already recorded events." In some cases **two Event objects** are generated — dedupe on `data.object.id` + `event.type` (https://docs.stripe.com/webhooks).
- **Retries**: production up to 3 days exponential backoff; sandbox 3 retries within a few hours; manual resend via Dashboard (≤15 days) or `stripe events resend <event_id> --webhook-endpoint=<id>` (≤30 days). Event ordering is **not guaranteed**. Retries arrive with fresh timestamps/signatures → dedupe on event `id`, never on request fingerprints (https://docs.stripe.com/webhooks).
- **Timing**: with `success_url` + webhook endpoint, "Checkout waits up to 10 seconds for your server to respond to the webhook event delivery before redirecting your customer" — respond fast; also trigger fulfillment from the success page (extract `session_id`) for instant UX (https://docs.stripe.com/payments/checkout/fulfillment).
- Digital-goods note: you *may* grant access speculatively on `processing`, but must revoke if `payment_intent.payment_failed` arrives later (https://docs.stripe.com/testing).

## 3. Webhook security

- **`stripe.webhooks.constructEvent(rawBody, sigHeader, endpointSecret)` — pass the RAW body**: "you must pass the raw request body, exactly as received from Stripe... this will not work with a parsed (i.e. JSON) request body" (https://github.com/stripe/stripe-node#readme). SvelteKit: `const rawBody = await request.text()` **before any JSON parsing** (SvelteKit handlers are standard Web-API Request/Response handlers).
- `Stripe-Signature` header carries timestamp + `v1` signature over `timestamp + '.' + rawBody`; libraries enforce a **default 5-minute tolerance** (use NTP); "don't use a tolerance value of 0" (https://docs.stripe.com/webhooks).
- Signing secrets (`whsec_...`) are **not** API keys; one per endpoint, found in Dashboard → Webhooks. **Test and live endpoints have different secrets**; going live = update endpoint URL + copy the new signing secret (https://docs.stripe.com/keys, https://docs.stripe.com/webhooks). Rotate periodically (immediate or ≤24 h delayed expiry, both secrets valid during transition).
- **API version pinning**: Event structure = API version in effect when the event occurred; events immutable after creation. Set the endpoint's API version (Workbench asks for "the Stripe API version and the specific events" — https://docs.stripe.com/webhooks/handling-payment-events) and pass the same `apiVersion` in the SDK (https://github.com/stripe/stripe-node#readme).
- **Endpoint registration**: production endpoints must be public **HTTPS** (TLS 1.2/1.3), up to 16 endpoints (https://docs.stripe.com/webhooks). For SvelteKit-on-Netlify this is a route, e.g. `https://<site>/api/stripe/webhook` (endpoints are hosted as Netlify Functions — https://kit.svelte.dev/docs/adapter-netlify).
- **Local dev** (https://docs.stripe.com/webhooks): `stripe listen --forward-to localhost:5173/api/stripe/webhook` → prints `whsec_...` for `.env`; flags `--events a,b,c` and `--load-from-webhooks-api`; `stripe trigger <event>` fires simulated events.
- **Hardening** (https://docs.stripe.com/webhooks): return 2xx fast (before complex logic; avoid 3-day retry loops); IP allowlist (https://docs.stripe.com/ips) **and** signature verification; exempt the webhook route from CSRF-style protection; listen only to required event types; process asynchronously (queue) for scale; 400 on `StripeSignatureVerificationError`/parse errors.

## 4. Test vs live mode

- Keys: `sk_test_`/`sk_live_` (secret), `pk_test_`/`pk_live_` (publishable — only key safe to expose client-side), `rk_*` (restricted). Modes are fully separate: "each mode has its own set of API keys, and objects from one mode are not accessible in the other" (https://docs.stripe.com/keys).
- Test cards (https://docs.stripe.com/testing): success `4242 4242 4242 4242` (Visa); declined `4000 0000 0000 0002` (generic), `4000 0000 0000 9995` (insufficient funds), `4000 0000 0000 9987` (lost), `4000 0000 0000 9979` (stolen), `4000 0000 0000 0069` (expired), `4000 0000 0000 0127` (incorrect CVC), `4000 0000 0000 0119` (processing error), `4242 4242 4242 4241` (incorrect number). Interactive: any future expiry, any 3-digit CVC (4 AmEx), zip `90210`. Never test with real card data in live mode (prohibited by the SSA).
- Test price IDs: create Products/Prices in Dashboard while in test mode → `price_1...` test IDs usable only with test keys (mode separation, https://docs.stripe.com/keys).
- Trigger events: `stripe trigger checkout.session.completed`, `charge.refunded`, `charge.dispute.created`, `payment_intent.succeeded` — sends simulated events through `stripe listen` to your local endpoint (https://docs.stripe.com/webhooks, https://docs.stripe.com/cli/trigger). E2E: pay in Checkout with 4242... and watch the event forward (https://docs.stripe.com/payments/checkout/fulfillment).
- Optional location simulation: `test+location_US@example.com` as `customer_email` (https://docs.stripe.com/testing).

## 5. Stripe Tax for digital goods/credits

- **Not mandated by the API**: Stripe Tax only calculates/collects "in jurisdictions where you have an active registration... Without a registration in the customer's location, the calculation returns zero tax" (https://docs.stripe.com/tax/tax-codes, https://docs.stripe.com/tax/checkout/page). Legal obligation is the seller's (you register where you have nexus); Stripe Tax automates calculation/collection/reporting. Managed Payments can take over tax liability entirely for digital products (https://docs.stripe.com/tax/checkout).
- **Automatic tax via Checkout**: `automatic_tax: { enabled: true }` + `customer_creation: 'always'`; tax from billing address (or shipping if collected); register once per jurisdiction (Dashboard Tax → Registrations or `POST /v1/tax/registrations`); read `total_details.amount_tax` (https://docs.stripe.com/tax/checkout/page).
- **Digital-goods tax code**: `txcd_10000000` "General – Electronically Supplied Services" ("A digital service provided mainly through the internet with minimal human involvement"); `txcd_00000000` Nontaxable exists. Set on Product (`tax_code`) or inline `product_data.tax_code` (https://docs.stripe.com/tax/tax-codes).
- **`tax_behavior`**: `exclusive` = tax added on top (US/Canada & B2B convention); `inclusive` = tax in price (B2C outside US). **Cannot be changed after set on a Price.** "Automatic" default: USD/CAD → exclusive, others → inclusive. Set per Price (`tax_behavior=exclusive`) or account default in Tax settings (https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior). For USD credit bundles: `exclusive` matches convention and Stripe's automatic default.

## 6. Official SDK vs raw REST; serverless & SvelteKit gotchas

- **Use the SDK** (recommended by Stripe): types for latest API version, Promise methods, auto-pagination, request IDs, typed errors; auto network retries **since v13** with "idempotency keys added where appropriate to prevent duplication"; `maxNetworkRetries` default 1, set 2 via config or per-request, 0 disables; `rawRequest` (v17+) for undocumented endpoints (https://github.com/stripe/stripe-node#readme).
- Node **18+ LTS** required per the Language Version Support Policy (https://github.com/stripe/stripe-node#readme).
- **Netlify**: `@sveltejs/adapter-netlify` default `edge: false` → app runs as **Node-based Netlify Functions** (stripe-node works as-is); `edge: true` = Deno edge functions (https://kit.svelte.dev/docs/adapter-netlify, https://docs.netlify.com/functions/overview/). v17+ warning: lazily instantiate the client if env vars are absent during build (https://github.com/stripe/stripe-node#readme).
- **SvelteKit env**: `import { env } from '$env/dynamic/private'` — runtime server-only vars, **cannot be imported into client-side code** (build-enforced); `$env/static/private` for build-time (https://kit.svelte.dev/docs/$env-dynamic-private). Never put `sk_` in client code or source control; vault or env vars (https://docs.stripe.com/keys).
- **Env naming**: `STRIPE_SECRET_KEY` appears in Stripe's own SDK examples (https://github.com/stripe/stripe-node#readme); `STRIPE_WEBHOOK_SECRET`/`STRIPE_PRICE_<BUNDLE>` are conventions — hard rules are only: test vs live values must differ per environment, and never reach the client.

## 7. Refunds & disputes

- Events (https://docs.stripe.com/api/events/types): `charge.refunded` — "Occurs whenever a charge is refunded, including partial refunds. Listen to `refund.created` for information about the refund." (data.object = Charge); `refund.created` / `refund.updated` / `refund.failed`; `charge.dispute.created` — "Occurs whenever a customer disputes a charge with their bank."; `charge.dispute.updated`; `charge.dispute.closed` (lost|warning_closed|won); `charge.dispute.funds_withdrawn`; `charge.dispute.funds_reinstated`.
- Refunds: multiple refunds per charge, never exceeding the original total; draw from available balance; only to the original payment method; Stripe recommends at minimum monitoring `refund.created` (https://docs.stripe.com/refunds).
- Disputes: issuer reverses payment; Stripe debits amount + dispute fee from your balance; respond via Dashboard or API (evidence: text + uploaded files, 150k-char combined limit; one payment can have multiple disputes — address the specific Dispute ID) (https://docs.stripe.com/disputes, https://docs.stripe.com/disputes/api).
- **Credit-reversal pattern**: store `stripe_charge_id`/`payment_intent_id` on the grant at purchase time; on `charge.refunded` → reverse/debit credits (amounts via `refund.created`); on `charge.dispute.created` → freeze credits; `charge.dispute.closed`/`funds_reinstated` → unfreeze if won, reverse if lost; apply the same event-ID dedupe.
- **v1 scope (this codebase)**: credits are reversed only on a **full** refund — the webhook subscribes to `charge.refunded` and reverses the entire grant. Partial refunds (`refund.created`/`refund.updated`) are intentionally **not** handled, and reversing after the org has already spent the credits can leave a negative balance. Both are deliberate v1 limitations; revisit before supporting partial refunds.

## 8. Recommended design

**Events to subscribe**: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` (optional), `charge.refunded`, `charge.dispute.created` (+ optionally `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`). Route: `src/routes/api/stripe/webhook/+server.ts` — verify raw body (`await request.text()` + `constructEvent`), return 2xx fast, run `fulfill_checkout(session.id)` idempotently.

**Dedupe tables**:

```sql
CREATE TABLE stripe_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,          -- evt_... (primary dedupe)
  event_type TEXT NOT NULL,
  object_id TEXT NOT NULL,                -- cs_... | ch_... | du_... | re_...
  object_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (event_type, object_id)          -- catches the two-Event-objects duplicate case
);
CREATE TABLE credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,                   -- consume | purchase | auto_topup | refund | dispute | adjust
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  balance_after INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, ref_type, ref_id)       -- idempotency anchor
);
```

Insert `stripe_events` in the same transaction as the grant; the UNIQUE constraints make concurrent/duplicate deliveries safe (https://docs.stripe.com/webhooks — "record the event IDs you've processed", "use the object ID in data.object along with the event.type").

**Env vars** (Netlify, per branch/context): `STRIPE_SECRET_KEY` (`sk_test_`/`sk_live_`), `STRIPE_WEBHOOK_SECRET` (`whsec_...` per mode endpoint), `STRIPE_PRICE_<BUNDLE>` (per bundle, mode-scoped `price_1...`), optional `PUBLIC_STRIPE_PUBLISHABLE_KEY` (`pk_*`, client-safe). Read via `$env/dynamic/private` server-side only.

**Local loop**: `stripe login` → `stripe listen --forward-to localhost:5173/api/stripe/webhook` (copy `whsec_...` to `.env`) → `npm run dev` → `stripe trigger checkout.session.completed` / `charge.refunded`.

**Stripe Tax decision**: enable only if you'll register where you have nexus; then use `txcd_10000000`, `tax_behavior: 'exclusive'`, `automatic_tax.enabled=true` + `customer_creation=always`. Deferred for now.
