# Fiscal eligibility, competence, and BRL conversion — decision matrix (MOD-179)

Date: 2026-10-01 · Status: **PROPOSED — pending accountant sign-off** (relayed by the
maintainer, same channel as MOD-178). Rules already ruled on under MOD-178 are marked
APPROVED; the rest is the concrete proposal the accountant confirms or corrects. The
open questions are collected in §8 — they are the MOD-179 sign-off checklist.

Scope: the four Stripe purchase paths (hosted subscription, lifetime, prepaid credit
bundles, automatic top-up) plus Mercado Pago prepaid credits where enabled
(`MERCADOPAGO_PRICE_*_BRL_CENTS` — DEPLOY.md §3; Mercado Pago covers manual credits
only, not plans or top-ups). Consumed by MOD-182 (canonical fiscal sale ledger),
MOD-183 (versioned fiscal configuration), MOD-184 (historical reconciliation), and
MOD-191 (refund/cancellation workflow).

## Decision summary

- **A fiscal sale exists iff money actually moved to ADM LTDA.** Payment success is a
  necessary input, never a sufficient condition — exclusions and review outcomes in §3
  are decided before a sale is eligible, per the issue guardrail ("do not infer
  eligibility solely from `invoice.paid` or a payment-success event").
- **One sale = one payment, one canonical identity** (§2): linked Stripe objects
  (Checkout Session ↔ PaymentIntent ↔ Invoice) map onto the same transaction and can
  never produce two sales.
- **Prepaid credit is recognized exactly once — at purchase.** Consumption of
  credits is never a fiscal event (the no-double-recognition rule; §4, Q4).
- **Competence = the receipt date** (America/São_Paulo) of the confirmed payment,
  recorded on the DPS as `data_competencia` (Q1).
- **One NFS-e per eligible payment** — not a monthly consolidated note (§5, Q5).
- **`valor_servico` = the amount the customer paid**, after discounts, before
  processor fees (§6, Q3).
- **USD → BRL at the PTAX sell closing bulletin of the receipt date**, falling back
  to the most recent prior bulletin; the full conversion inputs are stored for audit
  (§7, Q2).

## 1. Purchase paths and their source events

| Path | Provider objects | Payment evidence | Amount/currency |
|---|---|---|---|
| Hosted subscription (USD 5/mo, `STRIPE_PRICE_HOSTED_MONTHLY`) | Checkout `mode: 'subscription'` → Subscription → monthly Invoice | `invoice.paid` on the org's *tracked* subscription (`handleInvoicePaid`) | `invoice.amount_paid`, USD |
| Lifetime (USD 49 one-time, `STRIPE_PRICE_LIFETIME`) | Checkout `mode: 'payment'` | `checkout.session.completed` (or `async_payment_succeeded`) with `payment_status = 'paid'` | `session.amount_total`, USD |
| Credit bundle (`credits_500` USD 20.40, `credits_2000` USD 64.65; `credits_100` USD 5.00 is hidden from purchase) | Checkout `mode: 'payment'` | same as lifetime | `session.amount_total`, USD |
| Auto top-up (credits_500/credits_2000) | off-session `paymentIntents.create` | `payment_intent.succeeded` with `metadata.type = 'auto_topup'` | `payment_intent.amount`, USD |
| Mercado Pago credit bundle (BRL prices from env) | Checkout Pro preference → Payment | webhook-fetched `status = 'approved'` (`fulfillMercadoPagoPayment`) | `payment.transaction_amount`, BRL |

**Receipt timestamp** = the processor's authoritative payment-confirmation timestamp:
the paid Charge's `created` (or `invoice.status_transitions.paid_at`) for Stripe
invoices, the PaymentIntent/Charge `created` behind a Checkout Session, the
PaymentIntent `created` for top-ups, `date_approved` for Mercado Pago. All timestamps
are stored in UTC; the competence date derives from the America/São_Paulo calendar
date (§4).

## 2. Canonical sale identity (one payment = one sale)

The sale key is the **processor payment object**, not the billing document:

- Stripe: the **PaymentIntent id** behind the payment; a Charge id is the fallback
  only when no PaymentIntent exists.
- Mercado Pago: the **payment id**.

Linked-object collapse (MOD-182's "map linked objects to the same transaction"):

- A subscription-mode Checkout Session carries no PaymentIntent — the first payment
  arrives as `invoice.paid`, so `checkout.session.completed` for `product='hosted'`
  is **not** a sale event. Each month's `invoice.paid` maps its resolved
  PaymentIntent/Charge to one sale; the Invoice id is stored as the billing document
  for that period.
- `payment_intent.succeeded` fires for invoice payments too — it is not a separate
  sale; it resolves to the same PaymentIntent key.
- A `checkout.session.completed` for credits/lifetime and the matching
  `payment_intent.succeeded` share one PaymentIntent → one sale.
- Out-of-order delivery is handled by keying on the payment object, never on event
  order or event id.

## 3. Non-eligible and manual-review events

`eligible` requires: payment confirmed + amount > 0 + not excluded + not under a
pending refund obligation. Outcomes are named for the MOD-182 eligibility contract:

| Event pattern | Outcome |
|---|---|
| `checkout.session.completed`/`async_payment_succeeded` with `payment_status = 'no_payment_required'` ($0 session) | `ineligible:zero_amount` |
| `invoice.paid` with `amount_paid = 0` (trial, 100% coupon, fully credit-covered) | `ineligible:zero_amount`. Adapter note: a $0 invoice has no PaymentIntent/Charge — missing payment refs at zero amount is *expected*, not a defect. |
| `invoice.paid` partially credit-covered (`amount_paid` > 0, remainder from customer balance) | `eligible`, service value = `amount_paid` (cash actually received) |
| `checkout.session.expired`, `async_payment_failed`, `payment_intent.payment_failed`, `invoice.payment_failed` | `ineligible:no_payment` — no money moved |
| `checkout.session.completed` for `metadata.product = 'test'` (operator smoke test, `TEST_CHECKOUT_PRODUCT`) | `ineligible:test_purchase` — not a customer sale (Q6) |
| `invoice.paid`/`payment_intent.succeeded` for a payment already queued for `refundUngrantablePayment` (duplicate subscription, unmetered-org grant) | `review:refund_pending` — not eligible while the refund obligation stands; becomes `ineligible:refunded` when it completes |
| Invoice marked paid out-of-band at Stripe (`invoice.paid`, `amount_paid` > 0, no PaymentIntent/Charge — the current `INVOICE_PAYMENT_REQUIRED_ERROR` case) | `review:out_of_band` — money may have arrived outside Stripe (bank transfer/Pix); requires receipt evidence before issuance (Q7) |
| Any payment in a currency other than USD (Stripe) or BRL (Mercado Pago) | `ineligible:unsupported_currency` — loud, per I2; the catalog is validated USD-only (`validatePlanPrice`, auto-top-up price check) and BRL-only (`fulfillMercadoPagoPayment`), so this is a breach-of-contract guard |
| `charge.refunded`, `refund.*`, `charge.dispute.*` | **Not sale events** — adjustments on the existing sale's note per the MOD-178 refund rules (review → cancellation-requested → canceled only on confirmed fiscal event). A full refund on a never-rendered service requests cancellation; a used-service refund is accountant review; partial refunds never auto-cancel or substitute. |
| `customer.subscription.*`, `payment_method.detached`, `customer.updated` | **Not sale events** — entitlement state sync only |

A payment that is real but whose fiscal profile is incomplete (missing CPF/CNPJ or
foreign recipient data — MOD-181) is an **eligible sale in `pending:fiscal_profile`**:
the sale is recorded with its evidence and waits for the correction flow; it is never
dropped.

## 4. Competence (`data_competencia`)

The national DPS carries `data_competencia` (dCompet, required, AAAA-MM-DD — a full
date, not a month) and `data_emissao` (dhEmi, UTC datetime of emission).
campos.focusnfe.com.br/nfse_nacional/EmissaoDPSXml.html.

**Proposed rule (Q1):** `data_competencia` = the **receipt date** — the
America/São_Paulo calendar date of the confirmed payment — for every path. The
competence month is the receipt month. Consequences:

- Subscription: each paid invoice's competence is its payment month. A renewal
  collected late lands in the month it was *received*, not the period's month.
- Delayed-notification methods (`checkout.session.async_payment_succeeded`, Mercado
  Pago pix/boleto clearing): competence is the async success date, not the checkout
  date.
- Prepaid credits and lifetime: competence is the purchase month. Consumption never
  creates a competence — a credit drawn six months later produces no fiscal event.

This rule assumes ADM LTDA apura Simples under **regime de caixa** in PGDAS-D (the
caixa/competência option of Resolução CGSN 140/2018), so note competence and tax
competence never diverge. If the accountant reports regime de competência instead,
subscription competence moves to the service-period month and prepaid-credit
recognition must be re-ruled — that is exactly the accountant question Q1, and it is
the single decision everything else in this section hangs on.

## 5. Issuance timing

**Proposed (Q5):** one NFS-e per eligible payment, emitted promptly after the payment
is confirmed and the recipient fiscal profile is complete — event-driven, never a
month-end batch and never consolidated per customer.

- Per-payment notes are what the MOD-178 adjustment rules operate on (a refund
  reviews *that payment's* note; a cancellation backs out the original competence).
- Volume fits the Focus Solo plan at current scale (100 notes/mo): hosted renewals
  are 1/org/mo, top-ups are capped at 1/day and 30/month per org, manual bundles are
  human-paced.
- Rejected alternative for the record: monthly consolidated notes per customer would
  halve note volume but break the payment↔note↔refund linkage and would still need
  per-payment evidence — rejected.

Late issuance (outage, `pending:fiscal_profile` resolved weeks later, homologation
catch-up) does not move the competence: the note is emitted when it is emitted
(`data_emissao`), with `data_competencia` still the original receipt date.

## 6. Service value, discounts, processor fees

- `valor_servico` (vServ, required, Decimal[15.2], **in R$**) = the gross amount the
  customer paid for the service — after any discount, **before processor fees**.
  Stripe/Mercado Pago fees are the issuer's cost, not a price reduction (Q3 confirms
  the reading, though it is the standard one).
- Discounts (coupon/promo — not enabled in Checkout today, but definable at Stripe):
  the note carries the net amount actually charged. Recording `desconto_incondicionado`
  (vDescIncond) against a list price is the alternative presentation; proposed is
  net-value only, with the discount kept as ledger evidence (Q3).
- A $0 net amount is never a note (§3 `zero_amount`).
- Export-treated notes (foreign recipient, MOD-178 APPROVED): `tributacao_iss = 3`
  + `codigo_pais_exportacao`, with `valor_servico` **still in BRL** (the schema has no
  foreign-currency vServ) plus `codigo_moeda` = `USD` and `valor_servico_ext`
  (vServMoeda) = the USD amount — the foreign-currency fields exist precisely for
  this, and their presence is what makes the FX inputs in §7 mandatory even for
  exempt notes.
- Domestic-treated notes (BRL via Mercado Pago, or a domestic profile paying USD via
  Stripe): `tributacao_iss = 1`, national code `01.05.01` / SP `02800`, ISS 2,9%
  (MOD-178 APPROVED).

## 7. BRL conversion (USD sales)

Every USD receipt needs a recorded, reproducible BRL figure — for the note's
`valor_servico` and for Simples revenue apuração (Q2).

**Proposed convention:**

- **Source**: Banco Central **PTAX** (`olinda.bcb.gov.br` — `CotacaoDolarDia`,
  verified 2026-10-01: e.g. 2026-09-30 closing `cotacaoVenda` 5.18090).
- **Rate**: `cotacaoVenda` (sell) of the **closing bulletin of the receipt date**
  (America/São_Paulo). If the receipt date has no bulletin — weekend, holiday, or
  before the ~13:11 BRT close — use the most recent prior business day's closing
  bulletin. Deterministic: same receipt date → same rate, forever.
- **Computation**: `valor_brl = ROUND_HALF_UP(amount_usd × rate, 2)` — decimal
  arithmetic on integer cents, never binary float (same rule as
  `paymentAmountCents` in the Mercado Pago webhook).
- **Stored per sale (the auditable calculation)**: `original_currency`,
  `gross_amount_cents`, `fx_source = 'ptax_venda'`, `fx_bulletin_date` (the bulletin
  actually used — may precede the receipt date), `fx_rate` (4 dp as published),
  `fx_rounding = 'half_up_2dp'`, `amount_brl_cents`. BRL sales record
  `fx_source = 'none'`.
- **Supplementary evidence, not the rule**: when the Stripe account settles in a
  currency different from the charge, `balance_transaction.exchange_rate`
  (docs.stripe.com/api/balance_transactions/object — "amount in currency A ×
  exchange_rate = amount in currency B", null when no conversion happens) and the
  resulting `net` are stored as settlement evidence. Whether the Stripe account is
  BRL- or USD-settled is a maintainer question folded into Q2 — PTAX is uniform
  either way, which is why it is the proposal; if the accountant prefers the
  realized rate, `exchange_rate` becomes the source where present.
- A fetch failure or a missing PTAX bulletin inside its own window is a loud
  issuance blocker (I2 — never substitute another source silently): the sale stays
  `pending` and the issuance job retries/alerts per MOD-192.

## 8. Open questions for the accountant (the sign-off checklist)

- **Q1 — Regime**: does ADM LTDA apura Simples under regime de caixa in PGDAS-D?
  Under caixa, all rules above stand as written. Under competência, subscription
  competence moves to the service-period month and prepaid credit recognition needs
  a new ruling.
- **Q2 — FX convention**: PTAX `cotacaoVenda` closing of the receipt date (prior
  business day when none) as proposed, or the Stripe realized `exchange_rate`?
  Requires knowing the Stripe account's settlement currency — maintainer to supply.
- **Q3 — Value**: net amount paid as `valor_servico` (proposed) vs. list price +
  `desconto_incondicionado`. And confirmation that processor fees never reduce the
  service value.
- **Q4 — Prepaid recognition**: credits/top-ups/lifetime recognized once at
  purchase; consumption is never a fiscal event. (This is the double-recognition
  guard the issue requires.)
- **Q5 — Granularity**: one note per payment (proposed) vs. monthly consolidated
  note per customer.
- **Q6 — Operator test purchases** (`STRIPE_TEST_PRODUCT`): real charges on the
  deployment's own card, refunded when exercised — confirmed excluded from fiscal
  sales (not a customer sale)?
- **Q7 — Out-of-band marked-paid invoices**: manual-review lane with receipt
  evidence required before issuance, and competence from the evidence's receipt
  date (default: the marking date) — acceptable?

## 9. Representative fixtures (synthetic; expected outcomes)

PTAX examples use the verified 2026-09-30 closing sell rate **5.18090**.

| # | Event | Outcome | Recipient | Competence | `valor_servico` / totals |
|---|---|---|---|---|---|
| F1 | `invoice.paid` hosted renewal, `amount_paid` 500¢, PI present | eligible | foreign PJ | receipt date | USD 5.00 × 5.18090 → R$ 25,90; `tributacao_iss=3`, `codigo_moeda=USD`, `valor_servico_ext=5.00` |
| F2 | same, domestic CNPJ profile | eligible | domestic PJ | receipt date | R$ 25,90; `tributacao_iss=1`, `01.05.01`/`02800`, ISS 2,9% |
| F3 | `checkout.session.completed` lifetime, paid, USD 4900¢ | eligible | per profile | receipt date | USD 49.00 → R$ 253,86 |
| F4 | `checkout.session.completed` `credits_500`, paid, USD 2040¢ | eligible — consumed credits never re-recognize | per profile | receipt date | USD 20.40 → R$ 105,69 |
| F5 | `payment_intent.succeeded` `metadata.type=auto_topup`, `credits_2000`, USD 6465¢ | eligible | per profile | receipt date | USD 64.65 → R$ 334,95 |
| F6 | Mercado Pago webhook `approved`, `transaction_amount` R$ 99,00 | eligible | per profile | `date_approved` date | R$ 99,00; no FX (`fx_source='none'`) |
| F7 | `checkout.session.completed`, `payment_status=no_payment_required` | `ineligible:zero_amount` | — | — | — |
| F8 | `invoice.paid`, `amount_paid=0` (credit-covered) | `ineligible:zero_amount` | — | — | — |
| F9 | `checkout.session.async_payment_failed` / `expired` | `ineligible:no_payment` | — | — | — |
| F10 | `invoice.paid`, `amount_paid>0`, no PI/charge (marked paid out-of-band) | `review:out_of_band` | — | evidence date | — |
| F11 | delayed method: `checkout.session.async_payment_succeeded` 3 days after checkout | eligible | per profile | **async success date**, not checkout date | per §7 |
| F12 | paid payment then `refundUngrantablePayment` queued (duplicate subscription) | `review:refund_pending` → `ineligible:refunded` on completion | — | — | — |
| F13 | `charge.refunded` (full) on an F3 sale, service never rendered | not a sale event — MOD-178 track: review → cancellation request on F3's note | — | — | — |
| F14 | `checkout.session.completed` `product='test'` | `ineligible:test_purchase` | — | — | — |
| F15 | `payment_intent.succeeded` for an invoice payment (no `auto_topup` metadata) | not a new sale — resolves to F1's PaymentIntent key | — | — | — |

## Sources

- Focus national DPS field schema — campos.focusnfe.com.br/nfse_nacional/EmissaoDPSXml.html
  (`data_competencia`, `data_emissao`, `valor_servico` in R$, `desconto_incondicionado`,
  `codigo_moeda`, `valor_servico_ext`, `tributacao_iss`, `codigo_pais_exportacao`),
  fetched 2026-10-01.
- Stripe Balance Transaction object — docs.stripe.com/api/balance_transactions/object
  (`exchange_rate`, `amount`, `fee`, `net`), fetched 2026-10-01.
- Stripe Invoice object — docs.stripe.com/api/invoices/object (`amount_paid`,
  `amount_due` → 0 when credit-covered, amount paid outside Stripe), fetched
  2026-10-01.
- BCB PTAX — olinda.bcb.gov.br `CotacaoDolarDia`, live-verified 2026-10-01.
- MOD-178 accountant rulings — `docs/focus-nfe-validation.md` §5 (service codes,
  export treatment, refund/cancellation decoupling, original-competence correction).
- Code anchors: `src/lib/server/billing/checkout.ts`, `billing/autotopup.ts`,
  `billing/entitlements.ts`, `stripe/webhooks.ts`, `mercadopago/webhooks.ts`,
  `stripe/bundles.ts`, `src/lib/credit-pricing.ts`.
