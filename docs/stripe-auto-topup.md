# Stripe Auto Top-Up — Research Note (Moderaty)

**Purpose:** Decide how to implement AUTO TOP-UP for Moderaty's prepaid comment-credit model: when the local credit balance drops below a threshold, automatically charge the customer's saved card for another credit bundle.

**Method:** All claims below were verified against PRIMARY sources (fetched from docs.stripe.com, including the machine-readable `.md` variants and the API reference, and the stripe-node SDK repository github.com/stripe/stripe-node). Every claim carries the docs.stripe.com page that owns it.

**Sources read (primary):** `payments/save-during-payment`, `payments/checkout/save-during-payment`, `payments/checkout/save-and-reuse`, `payments/save-and-reuse`, `payments/payment-intents`, `api/checkout/sessions/create`, `api/checkout/sessions/object`, `api/payment_intents/create`, `api/payment_intents/object`, `api/payment_methods/attach`, `api/customers/update`, `api/mandates`, `api/idempotent_requests`, `declines/codes`, `webhooks`, `api/events/types`, `checkout/fulfillment`, `billing/subscriptions/usage-based`, `billing/subscriptions/usage-based/how-it-works`, `billing/subscriptions/usage-based/billing-credits`, `billing/subscriptions/usage-based/thresholds`, `billing/subscriptions/usage-based-legacy`, `billing/subscriptions/usage-based-legacy/recording-usage`, `billing/subscriptions/overview`, `billing/revenue-recovery`, `disputes`, and `github.com/stripe/stripe-node` (`src/resources.ts`, `src/Webhooks.ts`).

**TL;DR recommendation:** Keep the existing Checkout "buy a bundle" flow, save the card with `payment_intent_data.setup_future_usage = 'off_session'`, make it the customer's default payment method, and run **app-side auto top-up** with off-session PaymentIntents guarded by an idempotency key, an atomic in-flight claim, a cooldown, and a daily cap. Do **not** adopt metered billing (usage records) for this product — it is postpaid by design, the usage-records API is legacy, and Stripe's own prepaid construct (credit grants) is prohibited for stored-value-style balances and only applies to Meter-based prices. Full comparison and failure-handling design in [Recommendation](#7-recommendation).

---

## 1. Saving a card during Checkout for later off-session use

### 1.1 The mechanism Stripe documents for "save the card used in this payment"

Stripe's official guide "Save payment details during payment" (Checkout) documents saving the payment method used in a one-time payment for future charges:

- **`payment_intent_data.setup_future_usage = 'off_session'`** on a `payment`-mode Checkout Session. Quote: "You can set Checkout to save payment methods used to make a one-time payment by passing the `payment_intent_data.setup_future_usage` argument. This is useful if you need to capture a payment method on-file to use for future fees." — https://docs.stripe.com/payments/checkout/save-during-payment
- The same page: "If you use Checkout in `subscription` mode, Stripe automatically saves the payment method to charge it for subsequent payments." (Not our mode, but confirms auto-save semantics.)
- The Checkout Session API reference: the `customer` parameter docs state "You can set `payment_intent_data.setup_future_usage` to have Checkout **automatically attach the payment method to the Customer you pass in** for future reuse." — https://docs.stripe.com/api/checkout/sessions/create
- When no Customer exists yet, set `customer_creation = 'always'` so a Customer is created during Session confirmation ("The Checkout Session will always create a Customer when a Session confirmation is attempted") — https://docs.stripe.com/api/checkout/sessions/create

Concrete request (curl, from the official guide, adapted):

```bash
curl https://api.stripe.com/v1/checkout/sessions \
  -u "sk_test_xxx:" \
  -d customer_creation=always \
  -d "line_items[0][price_data][currency]=usd" \
  -d "line_items[0][price_data][product_data][name]=250 credits" \
  -d "line_items[0][price_data][unit_amount]=2000" \
  -d "line_items[0][quantity]=1" \
  -d mode=payment \
  --data-urlencode "success_url=https://example.com/success.html" \
  -d "payment_intent_data[setup_future_usage]=off_session"
```

Source: https://docs.stripe.com/payments/checkout/save-during-payment (curl example uses exactly these params, including `customer_creation=always`).

**What `setup_future_usage` means for cards:** "The `setup_future_usage` parameter saves payment methods to use again in the future. For cards, it also optimizes authorization rates in compliance with regional legislation and network rules, such as SCA." The enum table says: on-session-only payments → `on_session`; off-session payments → `off_session`. "You can still accept off-session payments with a card set up for on-session payments, but the bank is more likely to reject the off-session payment and require authentication from the cardholder." — https://docs.stripe.com/payments/payment-intents

### 1.2 Alternative: `saved_payment_method_options.payment_method_save`

The newer `saved_payment_method_options.payment_method_save = 'enabled'` shows the customer an explicit "save for future purchases" checkbox; saved methods get `allow_redisplay: always` and are prefilled on **future Checkout flows** (on-session reuse). Per the guide: "When using `saved_payment_method_options.payment_method_save`, you don't need to pass in `setup_future_usage` to save the payment method." — https://docs.stripe.com/payments/checkout/save-during-payment; param docs at https://docs.stripe.com/api/checkout/sessions/create

Important distinction for auto top-up: payment methods saved via `setup_future_usage` (or subscription mode) get `allow_redisplay: limited` — they're usable for off-session charging but **not** shown for prefill in future checkouts ("These payment methods have an `allow_redisplay` value of `limited`, which prevents them from being prefilled for returning purchases"). — https://docs.stripe.com/payments/checkout/save-during-payment. For an auto-top-up flow you want `setup_future_usage=off_session` (off-session charging is the point); the checkbox variant is complementary if you also want repeat on-session purchases.

Also note the capability constraint: "When using Elements with the Checkout Sessions API, only cards and ACH Direct Debit are supported for saved payment methods." — https://docs.stripe.com/payments/save-during-payment

### 1.3 Where the saved PaymentMethod ID is available

The `checkout.session.completed` webhook carries the Session object; the saved card is not a top-level Session field, so retrieve it:

- The Checkout Session object has `payment_intent` — "The ID of the PaymentIntent for Checkout Sessions in `payment` mode" (expandable) — https://docs.stripe.com/api/checkout/sessions/object
- The PaymentIntent object has `payment_method` — the ID of the PaymentMethod used (expandable) — https://docs.stripe.com/api/payment_intents/object

So: in the `checkout.session.completed` handler, retrieve the Session with `expand: ['payment_intent']` (the official fulfillment guide shows the expand pattern and mandates webhook-based fulfillment: "You must use webhooks to make sure fulfillment happens for every payment") — https://docs.stripe.com/checkout/fulfillment; then read `payment_intent.payment_method`.

(If you ever use Checkout in `setup` mode instead — save without charging — the Session has a `setup_intent` field; you retrieve the SetupIntent and read its `payment_method`. — https://docs.stripe.com/payments/checkout/save-and-reuse)

### 1.4 Attaching the card and making it the default

- Checkout with a passed-in Customer (or `customer_creation=always`) **auto-attaches** the payment method to that Customer when `setup_future_usage` is set (see 1.1 quote). — https://docs.stripe.com/api/checkout/sessions/create
- If you need to attach a PaymentMethod explicitly (e.g. a card saved via a raw Setup Intent): `POST /v1/payment_methods/:id/attach` with `customer`. The attach docs warn: "To attach a new PaymentMethod to a customer for future payments, we recommend you use a SetupIntent or a PaymentIntent with `setup_future_usage`... Using the `/v1/payment_methods/:id/attach` endpoint without first using a SetupIntent or PaymentIntent with `setup_future_usage` does not optimize the PaymentMethod for future use, which makes later declines and payment friction more likely." — https://docs.stripe.com/api/payment_methods/attach
- **Make it the default for future invoices/subscriptions:** "To use this PaymentMethod as the default for invoice or subscription payments, set `invoice_settings.default_payment_method` on the Customer to the PaymentMethod's ID." — https://docs.stripe.com/api/payment_methods/attach; parameter documented at https://docs.stripe.com/api/customers/update ("ID of a payment method that's attached to the customer, to be used as the customer's default payment method for subscriptions and invoices").

```js
// stripe-node
await stripe.paymentMethods.attach(pmId, { customer: cusId });
await stripe.customers.update(cusId, {
  invoice_settings: { default_payment_method: pmId },
});
```

(`customer.default_source` is the legacy Card/Source-API concept; the modern path for PaymentMethods is `invoice_settings.default_payment_method`. — https://docs.stripe.com/api/customers/update, response sample shows both fields.)

### 1.5 Compliance obligations (off-session charging)

Saving a card for later off-session charging requires, per Stripe's compliance guidance: terms stating how you'll save/use the details; explicit consent (e.g. a "Save my payment method for future use" checkbox); and terms covering "the customer's agreement to your initiating a payment or a series of payments on their behalf for specified transactions", "the anticipated timing and frequency of payments (for example, if the charges are for scheduled installments, subscription payments, or **unscheduled top-ups**)", "how you determine the payment amount", and your cancellation policy — keep a record of the written agreement. — https://docs.stripe.com/payments/save-and-reuse (Setup Intents guide) and https://docs.stripe.com/payments/save-during-payment (same obligations). Auto top-up is exactly the "unscheduled top-up" case — the user-facing terms and the checkout checkbox must cover it.

---

## 2. Off-session PaymentIntents and SCA/mandate behavior

### 2.1 The off-session charge call

From the official "Set up future payments" guide (Checkout variant), the charge-later call is:

```bash
curl https://api.stripe.com/v1/payment_intents \
  -u "sk_test_xxx:" \
  -d amount=2000 \
  -d currency=usd \
  -d "customer={{CUSTOMER_ID}}" \
  -d "payment_method={{PAYMENTMETHOD_ID}}" \
  -d off_session=true \
  -d confirm=true
```

— https://docs.stripe.com/payments/checkout/save-and-reuse

Parameter semantics (API reference):

- `off_session`: "Set to `true` to indicate that the customer isn't in your checkout flow during this payment attempt and can't authenticate. Use this parameter in scenarios where you collect payment method details and charge them later. **This parameter can only be used with `confirm=true`.**" — https://docs.stripe.com/api/payment_intents/create
- `confirm`: "causes confirmation to occur immediately when you create the PaymentIntent" — https://docs.stripe.com/payments/checkout/save-and-reuse
- `mandate_data`: exists on create ("This hash contains details about the Mandate to create. This parameter can only be used with `confirm=true`") — mostly relevant to bank-debit methods; for cards, authorization is established by the off-session setup step (see 2.2), and card-specific mandate options (`payment_method_options.card.mandate_options`) appear on the PaymentIntent object — https://docs.stripe.com/api/payment_intents/create, https://docs.stripe.com/api/payment_intents/object

### 2.2 Mandates and SCA for card off-session charges

- **What a Mandate is:** "A Mandate is a record of the permission that your customer gives you to debit their payment method." — https://docs.stripe.com/api/mandates
- **Cards + SCA:** off-session card charges rely on the setup recorded during the on-session flow. From the official guide: "If, during your checkout flow, a partner requests authentication, Stripe requests exemptions using customer information from a previous **on-session** transaction. If the conditions for exemption aren't met, the PaymentIntent might throw an error." — https://docs.stripe.com/payments/checkout/save-and-reuse. In other words: saving with `setup_future_usage=off_session` (Checkout/PaymentIntent or SetupIntent) is what records the reusable authorization; there is no separate "attach a mandate to a card" step in the Checkout path.
- The mandate for cards is recorded as part of that off-session setup; the PaymentIntent object exposes `payment_method_options.card.mandate_options` — https://docs.stripe.com/api/payment_intents/object.

### 2.3 What happens when an off-session charge needs authentication

- If the issuer demands authentication for the off-session attempt, the charge fails with decline code **`authentication_required`**: "The card was declined because the transaction requires authentication such as 3D Secure... **In some cases, such as off-session payments, you might need to request the customer to retry.**" — https://docs.stripe.com/declines/codes
- Related code `authentication_not_handled`: "Related to `authentication_required`. You tried to proceed without performing the required authentication, so the issuer declined again... **For off-session payments, collect and prepare authentication on-session first, then fall back to on-session if needed.**" — https://docs.stripe.com/declines/codes
- The PaymentIntent records the failure in `last_payment_error` (`.code`, `.decline_code`, `.type` — e.g. `card_error`); the object is retrievable — https://docs.stripe.com/api/payment_intents/object
- A failed confirm returns HTTP 402 and the PaymentIntent's status: "When a payment attempt fails, the request also fails with a 402 HTTP status code and the status of the PaymentIntent is `requires_payment_method`." — https://docs.stripe.com/payments/checkout/save-and-reuse. When authentication is required the status is `requires_action` (see subscriptions status table: "Fails because of authentication | `requires_action` | ... | `incomplete`") — https://docs.stripe.com/billing/subscriptions/overview

### 2.4 Recommended failure handling (per Stripe docs)

- **`authentication_required` / `requires_action`:** there is no server-side way to "force" the off-session charge through; the customer must authenticate. Stripe's documented handling:
  1. "Notify your customer to return to your application (for example, by sending an email or in-app notification) and direct your customer to a new Checkout Session to select another payment method." — https://docs.stripe.com/payments/checkout/save-and-reuse
  2. Or use the declined PaymentIntent's client secret with `stripe.confirmPayment` on a page the customer opens (on-session authentication): "If the payment failed due to an `authentication_required` decline code, use the declined PaymentIntent's client secret with confirmPayment to allow the customer to authenticate the payment." — https://docs.stripe.com/payments/save-and-reuse (Setup Intents/Payment Intents guide)
- **Other declines (insufficient funds, etc.):** "send your customer to a payment page to enter a new payment method. You can reuse the existing PaymentIntent to attempt the payment again with the new payment details." — https://docs.stripe.com/payments/save-and-reuse
- **Do not blind-retry off-session:** Stripe's own table for `authentication_not_handled` says prepare authentication on-session first; a retry of an unauthenticated off-session attempt is expected to fail again (the code literally means "you tried to proceed without performing the required authentication"). — https://docs.stripe.com/declines/codes
- **Webhook:** `payment_intent.payment_failed` — "Occurs when a PaymentIntent has failed the attempt to create a payment method or a payment." — https://docs.stripe.com/api/events/types

For our auto-top-up loop: treat `authentication_required` as "pause auto top-up, email the customer a re-authentication Checkout session, resume only after a successful payment" (see §7).

---

## 3. Alternative: Stripe metered billing (Subscriptions + usage records)

### 3.1 How it works

Usage-based billing = a subscription with a `recurring.usage_type = 'metered'` price; you report usage; Stripe invoices at period end and auto-charges the customer's default payment method:

- "Subscriptions charge customers on a recurring schedule... and generate invoices at the end of each billing cycle." — https://docs.stripe.com/billing/subscriptions/usage-based/how-it-works
- "At the end of the billing period, Stripe automatically calculates the total price and invoices for all usage during the billing period." — https://docs.stripe.com/billing/subscriptions/usage-based-legacy/recording-usage
- The classic usage-record call (`stripe.subscriptionItems.createUsageRecord` in stripe-node, `POST /v1/subscription_items/{id}/usage_records`):

```bash
curl https://api.stripe.com/v1/subscription_items/{{SUBSCRIPTION_ITEM_ID}}/usage_records \
  -u sk_test_xxx: -X POST \
  -d quantity=100 -d timestamp=1786558820 -d action=increment
```

  — https://docs.stripe.com/billing/subscriptions/usage-based-legacy/recording-usage. Best practices there: use idempotency keys so usage isn't double-reported; `timestamp` must be in the current billing period; `action` is `increment` (default) or `set`; the endpoint is rate-limited (100 calls/sec/account default).
- **Auto-charge & dunning are subscription features:** subscriptions "attempt payment collection" automatically; failed invoice payments trigger Smart Retries, automatic customer emails, automations and automatic card updates — all no-code — and the subscription moves through `past_due`/`unpaid` states with defined retry behavior. — https://docs.stripe.com/billing/subscriptions/overview, https://docs.stripe.com/billing/revenue-recovery
- **Important status reality-check:** the subscription/invoice lifecycle (23h incomplete window, `incomplete_expired`, `past_due`, `unpaid`) is tuned for periodic billing; an "unpaid" subscription "remains in place... payments aren't attempted" and Stripe says to revoke access — https://docs.stripe.com/billing/subscriptions/overview. That is a *postpaid* collection loop.

### 3.2 It's strictly postpaid — and the usage-records API is legacy

- Metered billing is retrospective: "Because Stripe bills usage retrospectively, you can set a temporary threshold of 100 USD for new customers." — https://docs.stripe.com/billing/subscriptions/usage-based/thresholds
- The usage-records path is explicitly legacy: "We've updated the way usage records billing works. Use Metronome instead." New integrations are directed to Billing Meters/Metronome ("Stripe's primary usage-based billing platform, which handles real-time metering, flexible pricing models, prepaid credits, enterprise contracts, and automated invoice generation"). — https://docs.stripe.com/billing/subscriptions/usage-based-legacy, https://docs.stripe.com/billing/subscriptions/usage-based
- SDK note: "If you're on a Stripe SDK version that deprecated UsageRecords... you can continue using the legacy UsageRecords and metered Price APIs by pinning to a pre-Basil API version via RawRequest." — i.e. `subscriptionItems.createUsageRecord` is being deprecated in current stripe-node. — https://docs.stripe.com/billing/subscriptions/usage-based-legacy

### 3.3 Can metered billing represent prepaid "credits left"? No (not natively)

- Stripe's own prepaid construct is **billing credits / credit grants** ("Use credit grants to offer billing credits to your customers in your business workflows, such as: Prepayment..."). But:
  - Credit grants **only apply to metered prices that report usage through Meters** — "You can only apply credit grants to subscription items that use metered prices and report usage through Meters. You can't apply credit grants to... line items... that use metered prices but report usage through **legacy Usage Records**." — https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits
  - **"You can't offer billing credits as stored value to your customers."** — a "pay for credits, spend them down over time" wallet is exactly the stored-value shape Stripe prohibits for credit grants. — https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits
  - Credits apply at invoice finalization ("Credits apply to invoices only at the time of finalization") — i.e. they offset *postpaid* invoices; they are not a real-time, spendable "credits left" balance you can gate product access on. — https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits
- **Conclusion for Moderaty:** a metered subscription bills *after* consumption; it cannot represent "credits used / credits left" without a parallel app-side ledger, and Stripe's billing credits cannot serve as the prepaid wallet. "Credits left" for a prepaid product is inherently app-side state. — https://docs.stripe.com/billing/subscriptions/usage-based/how-it-works, https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits

### 3.4 Pros/cons vs. the prepaid-ledger model

| | Metered subscription (usage records/Meters) | Prepaid bundle + app-side ledger (current + auto top-up) |
|---|---|---|
| Billing timing | Postpaid, invoiced at period end (retrospective) | Prepaid at purchase |
| "Credits left" UX | Not representable natively; needs app ledger anyway | Native (app ledger is the source of truth) |
| Collection automation | Built-in (invoices, default PM, Smart Retries, dunning emails, card updater) | App-side (off-session PIs + webhooks + guards) |
| Failure handling | Stripe handles retries/dunning for invoices | App handles; SCA re-auth needs customer |
| API status | Usage Records legacy; Meters/Metronome is the current path; Metronome's prepaid credits ≠ stored value | Stable, simple, well-documented Checkout + PIs |
| Compliance framing | Recurring billing terms | Unscheduled top-up terms + consent checkbox |

Sources: https://docs.stripe.com/billing/subscriptions/usage-based-legacy, https://docs.stripe.com/billing/subscriptions/usage-based, https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits, https://docs.stripe.com/billing/subscriptions/usage-based/thresholds

---

## 4. Is there a Stripe-native auto-recharge feature?

**No.** Stripe has no API or Dashboard feature that watches a balance/ledger and automatically charges a saved card when it drops below a threshold. The closest native mechanisms are:

- **Billing thresholds** (`billing_thresholds.amount_gte` on a subscription, `usage_gte` on a subscription item): "Set up billing thresholds to limit the amount owed or the products consumed between invoices or charges" — they trigger an **invoice** when accrued *metered usage* reaches a monetary/usage amount. This is a postpaid invoicing trigger, not a prepaid recharge; "Invoiced amounts or usage might be slightly higher than the specified thresholds" (real-time reporting, not exact). — https://docs.stripe.com/billing/subscriptions/usage-based/thresholds
- **Credit grants** (prepaid billing credits): issued explicitly via the API (`effective_at`, `expires_at`, amounts); nothing auto-issues or auto-funds them when a balance runs low, and stored-value use is prohibited (see §3.3). — https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits
- **Customer balance / auto-advance invoices** exist for invoicing workflows but are not an auto-recharge feature for a product balance.

**Therefore auto top-up is always app-side logic:** (a) a transactional check inside the credit-consumption path ("after deducting credits, if balance < threshold and no top-up in flight, trigger one"), and/or (b) a periodic sweep (cron) for customers who fell below threshold without a trigger (e.g. refunds, manual adjustments, missed events). Both must share the same guard rails (§5) and the same idempotency discipline.

---

## 5. Concurrency / race safety for app-side check-then-charge

The risk: two parallel moderation runs (or a sweep + a trigger) both read `balance < threshold`, both create off-session PaymentIntents, and the customer is charged twice. Layer the guards:

### 5.1 What Stripe gives you

- **Idempotency keys:** "The API supports idempotency for safely retrying requests without accidentally performing the same operation twice... provide an additional `Idempotency-Key`... Stripe's idempotency works by saving the resulting status code and body of the first request... Subsequent requests with the same key return the same result, including 500 errors." Keys up to 255 chars (V4 UUID or similar entropy); keys are pruned after ≥24h; a reused key with different parameters errors. — https://docs.stripe.com/api/idempotent_requests
- **PaymentIntents double-charge protection:** the Payment Intents guide lists among its advantages "No double charges" and "No idempotency key issues" (PI confirmation itself is protected against double-confirm). — https://docs.stripe.com/payments/payment-intents
- **Webhook realities:** "Webhook endpoints might occasionally receive the same event more than once. You can guard against duplicated event receipts by logging the event IDs you've processed"; and "Stripe doesn't guarantee the delivery of events in the order that they're generated." — https://docs.stripe.com/webhooks
- **Fulfillment idempotency requirement:** the official fulfillment guide requires the handler to "Correctly handle being called multiple times with the same Checkout Session ID" and be "safe to run multiple times, even concurrently" — the same discipline applies to credit-granting on `payment_intent.succeeded`. — https://docs.stripe.com/checkout/fulfillment

### 5.2 Recommended app-side guard rails (design, informed by the above)

1. **Idempotency key per top-up attempt:** `autotopup:{customerId}:{yyyymmdd}:{attemptN}` on `paymentIntents.create`. Because keys persist ≥24h, two concurrent triggers for the same customer/day collapse into one charge. — https://docs.stripe.com/api/idempotent_requests
2. **Atomic in-flight claim in the DB:** an `auto_topup` row per customer with `status` (`idle` | `in_flight` | `succeeded` | `failed` | `disabled`) and a `claimed_at`; claim via a single atomic statement (`UPDATE ... SET status='in_flight' WHERE customer_id=? AND status='idle'`) or a unique constraint on `(customer_id, charge_key)` so only one writer wins. (App-design recommendation; Stripe's idempotency protects the charge itself, your ledger needs the claim so credits aren't double-granted.)
3. **Cooldown + caps:** minimum interval between auto top-ups (e.g. 24h) and a max per day/month (e.g. 1/day, 3/month) — enforced in the trigger and the sweep.
4. **Credit credits only from webhooks:** grant credits in the `payment_intent.succeeded` handler keyed by `payment_intent.id`/`charge` id, never at creation time; webhook delivery is retried by Stripe for up to 3 days with backoff, and duplicates are handled by event-id de-dupe. — https://docs.stripe.com/webhooks, https://docs.stripe.com/checkout/fulfillment
5. **Failures release the claim:** `payment_intent.payment_failed` / `requires_action` → mark the attempt failed, release the in-flight flag, start the cooldown; do not auto-retry off-session (see §2.4).
6. **Reconcile:** keep a charge record (`payment_intent_id`, `charge_id`, bundle, credits) so a dispute/refund (§6) can reverse credits and the sweep can detect "charged but not credited".

---

## 6. Webhooks to handle for the auto top-up loop

Event definitions from https://docs.stripe.com/api/events/types:

| Event | When | What to do |
|---|---|---|
| `checkout.session.completed` | Customer finishes a Checkout Session (manual bundle purchase; also the PM-save moment) | Grant purchased credits (idempotent per session id); persist the new/default `payment_method` id (retrieve session with `expand: ['payment_intent']`); see https://docs.stripe.com/checkout/fulfillment |
| `payment_intent.succeeded` | Auto-top-up charge succeeds (or any PI) | Credit the ledger for auto-top-up PIs keyed by PI/charge id (idempotent); reset failure counter/cooldown state |
| `payment_intent.payment_failed` | "Occurs when a PaymentIntent has failed the attempt to create a payment method or a payment" | If auto-top-up PI: record `last_payment_error.code` (`authentication_required` vs `card_error`); release in-flight claim; start cooldown; if `authentication_required` → disable auto top-up + email customer a re-auth Checkout link (https://docs.stripe.com/declines/codes, https://docs.stripe.com/payments/checkout/save-and-reuse) |
| `payment_intent.requires_action` | "Occurs when a PaymentIntent transitions to requires_action state" | Early signal to notify the customer to authenticate (also `invoice.payment_action_required` in the subscription world — https://docs.stripe.com/billing/subscriptions/overview) |
| `charge.dispute.created` | "Occurs whenever a customer disputes a charge with their bank" | Reverse any credits granted for that charge; decide respond/accept (evidence via Dashboard or Disputes API); consider disabling auto top-up for that customer — https://docs.stripe.com/api/events/types, https://docs.stripe.com/disputes |
| (optional) `charge.dispute.funds_withdrawn` / `charge.dispute.closed` | Dispute lifecycle | Update ledger/status — https://docs.stripe.com/api/events/types |
| (only if metered route) `invoice.paid` / `invoice.payment_failed` | Subscription invoice paid/failed | Grant/revoke access — https://docs.stripe.com/billing/subscriptions/overview, https://docs.stripe.com/billing/revenue-recovery/smart-retries |

Webhook hygiene (all from https://docs.stripe.com/webhooks): verify the `Stripe-Signature` signature (HMAC-SHA256; official libraries do this — `stripe.webhooks.constructEvent` in stripe-node, https://github.com/stripe/stripe-node/blob/master/src/Webhooks.ts); return `2xx` quickly before heavy logic (Stripe retries failed deliveries for up to 3 days with exponential backoff in live mode); process events asynchronously; subscribe only to the event types above; de-dupe by event id; don't assume event ordering.

---

## 7. Recommendation

**Chosen approach: (a) Checkout manual top-ups + app-side auto top-up via off-session PaymentIntents.** Do not adopt (b) metered subscriptions for this product.

### Why (a) over (b) for a prepaid "credits left" product

1. **Metered billing is postpaid and cannot express "credits left".** Stripe bills usage retrospectively at period end ("Because Stripe bills usage retrospectively..." — https://docs.stripe.com/billing/subscriptions/usage-based/thresholds); a prepaid balance you spend down is not representable, and Stripe's own prepaid construct (credit grants) is (i) only for Meter-based metered prices, (ii) an invoice-level credit that applies at finalization, not a spendable balance, and (iii) explicitly **not** allowed as stored value — which is what a "buy credits, spend credits" product is. — https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits
2. **The usage-records API is legacy.** `subscriptionItems.createUsageRecord` is deprecated in current stripe-node (requires a pinned pre-Basil API version via RawRequest); the replacement (Meters/Metronome) is a heavier platform geared to enterprise SaaS metering, and its prepaid-credits story still doesn't produce a real-time credits-left balance. — https://docs.stripe.com/billing/subscriptions/usage-based-legacy, https://docs.stripe.com/billing/subscriptions/usage-based
3. **The local ledger must exist either way** ("You need to write some of your own business logic before creating the usage record" — https://docs.stripe.com/billing/subscriptions/usage-based-legacy/recording-usage), so subscriptions add Stripe lifecycle machinery (incomplete/past_due/unpaid windows, invoice dunning) *on top of* a ledger we'd still have to build and keep authoritative. Prepaid bundles keep one source of truth (the app ledger) and one simple money movement (pay now, get credits).
4. **The manual flow already exists** (buy bundles via Checkout). Adding `payment_intent_data.setup_future_usage=off_session` (https://docs.stripe.com/payments/checkout/save-during-payment) + default payment method (https://docs.stripe.com/api/payment_methods/attach) + the guarded off-session charge (https://docs.stripe.com/payments/checkout/save-and-reuse) is a thin, well-documented layer, with compliance covered by an explicit consent checkbox and "unscheduled top-ups" terms (https://docs.stripe.com/payments/save-and-reuse).
5. **Downside to accept:** no Stripe-managed dunning/retries for standalone PaymentIntents (https://docs.stripe.com/billing/revenue-recovery covers subscriptions), and SCA can force a customer re-auth — which is why the failure design below matters. If a subscription-style offering is ever wanted, Stripe supports it as a separate product line later.

### Failure-handling design (auto top-up loop)

1. **Trigger:** transactional check on credit consumption (and a daily cron sweep) → if `credits < threshold` and customer has `auto_topup` enabled and a default payment method: claim in-flight atomically (§5.2), then `paymentIntents.create({amount, currency, customer, payment_method: defaultPmId, off_session: true, confirm: true, metadata: {type:'auto_topup'}}, {idempotencyKey: 'autotopup:{cus}:{date}:{attempt}'})`. — https://docs.stripe.com/api/payment_intents/create, https://docs.stripe.com/api/idempotent_requests
2. **Success:** credit the ledger only in the `payment_intent.succeeded` webhook, keyed by PI id (idempotent); clear the claim. — https://docs.stripe.com/api/events/types, https://docs.stripe.com/webhooks
3. **`authentication_required` / `requires_action`:** do **not** retry off-session (Stripe: "request the customer to retry"; "collect and prepare authentication on-session first" — https://docs.stripe.com/declines/codes). Disable auto top-up for the customer, email them a re-auth Checkout Session ("Notify your customer... direct your customer to a new Checkout Session" — https://docs.stripe.com/payments/checkout/save-and-reuse), and re-enable after a successful payment.
4. **Other declines** (`card_declined`, `insufficient_funds`, `expired_card`): record, release claim, start cooldown; after N consecutive failures (e.g. 2) disable auto top-up and email the customer to update their card via Checkout. — https://docs.stripe.com/declines/codes, https://docs.stripe.com/payments/save-and-reuse
5. **Disputes:** on `charge.dispute.created`, reverse the credits granted for that charge, mark the customer's auto top-up disabled pending review, and respond/accept via the Disputes API or Dashboard. — https://docs.stripe.com/api/events/types, https://docs.stripe.com/disputes
6. **Guards:** cooldown ≥24h between auto top-ups, max 1/day and 3/month, in-flight atomic claim, idempotency keyed per attempt — §5.
